'use strict';

const crypto = require('crypto');
const {
  REFUND_CLAIM_LEASE_MS,
  ACTIVE_REFUND_STATUSES,
  buildPartnerRefundBody,
  buildSplitReturnBody,
  exactRefundCommand,
  platformSplitFen,
  provisionalSplitReturnFen,
  refundAttemptId,
  refundCounters,
  splitReturnNoForRefund,
  validateQueryRefund,
  validateSplitReturn,
  validRefundOrder
} = require('./lib/table-refund/table-refund');
const {
  applyVerifiedRefundQuery,
  markRefundManualReview
} = require('./lib/table-refund/refund-transition');
const { refundNoForOrder } = require('./lib/table-finance/state');

const RECOVERY_BATCH_LIMIT = 20;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function result(code, retryable) {
  return { ok: false, code, retryable };
}

function success(refundNo, status) {
  return { ok: true, refundNo, status };
}

function bindingId(openid) {
  return crypto.createHash('sha256').update(`wechat:${openid}`).digest('hex');
}

async function authorizeShopOwner(tx, openid) {
  const userId = bindingId(openid);
  const binding = await tx.getWechatBinding(userId);
  if (
    !binding
    || binding._id !== userId
    || binding._openid !== openid
    || typeof binding.accountId !== 'string'
    || !binding.accountId
    || typeof binding.account !== 'string'
    || !binding.account
  ) return result('ACCOUNT_NOT_BOUND', false);
  const account = await tx.getAccount(binding.accountId);
  const user = await tx.getUser(userId);
  if (
    !account
    || account._id !== binding.accountId
    || account._openid !== openid
    || account.account !== binding.account
    || account.status !== 'active'
    || !user
    || user._id !== userId
    || user._openid !== openid
  ) return result('ACCOUNT_NOT_BOUND', false);
  if (!Array.isArray(user.roles) || !user.roles.includes('shop')) {
    return result('SHOP_ROLE_REQUIRED', false);
  }
  return null;
}

function validContext(context) {
  return isPlainObject(context)
    && typeof context.OPENID === 'string'
    && context.OPENID.length > 0
    && Buffer.byteLength(context.OPENID, 'utf8') <= 128
    && !/[\x00-\x1f\x7f]/.test(context.OPENID);
}

function exactRefundTimer(event) {
  return isPlainObject(event)
    && Object.keys(event).length === 2
    && event.Type === 'Timer'
    && event.TriggerName === 'reconcileTableRefundsTimer';
}

function validTimerContext(context) {
  return isPlainObject(context)
    && (
      !Object.prototype.hasOwnProperty.call(context, 'OPENID')
      || context.OPENID === ''
    );
}

function isTrustedRefundTimer(event, context) {
  return exactRefundTimer(event) && validTimerContext(context);
}

function isVerifiedRefundNotFound(error) {
  return error
    && error.name === 'WechatPayApiError'
    && error.statusCode === 404
    && error.code === 'RESOURCE_NOT_EXISTS';
}

function isVerifiedDefinitiveError(error) {
  return error
    && error.name === 'WechatPayApiError'
    && Number.isSafeInteger(error.statusCode)
    && error.statusCode >= 400
    && error.statusCode < 500
    && error.statusCode !== 429;
}

function validExistingRefund(
  refund,
  event,
  refundNo,
  ownerOpenid,
  expectedSubMchid
) {
  return isPlainObject(refund)
    && refund._id === refundNo
    && refund.refundNo === refundNo
    && refund.orderId === event.orderId
    && refund.shopId === ownerOpenid
    && refund.subMchid === expectedSubMchid
    && refund.refundFen === event.refundFen
    && refund.reason === event.reason
    && refund.idempotencyKey === event.idempotencyKey
    && isPlainObject(refund.refundClaim)
    && refund.refundClaim.refundNo === refundNo
    && refund.refundClaim.attemptId === refundAttemptId(refundNo)
    && ['returning', 'processing', 'succeeded', 'manual_review'].includes(refund.status);
}

function validateDependencies(dependencies) {
  const names = [
    'getContext',
    'loadConfig',
    'createWechatPayClient',
    'nowMs'
  ];
  if (
    !isPlainObject(dependencies)
    || !dependencies.store
    || typeof dependencies.store.listDueRefunds !== 'function'
    || names.some((name) => typeof dependencies[name] !== 'function')
  ) {
    throw new TypeError('requestTableRefund dependencies are invalid');
  }
}

function createHandler(dependencies) {
  validateDependencies(dependencies);
  const {
    store,
    getContext,
    loadConfig,
    createWechatPayClient,
    nowMs
  } = dependencies;

  async function claim(event, ownerOpenid, config, now) {
    const refundNo = refundNoForOrder(event.orderId, event.idempotencyKey);
    return store.runTransaction(async (tx) => {
      const authorizationFailure = await authorizeShopOwner(tx, ownerOpenid);
      if (authorizationFailure) return { failure: authorizationFailure };
      const order = await tx.getOrder(event.orderId);
      if (
        !order
        || order._id !== event.orderId
        || order._openid !== ownerOpenid
        || order.shopId !== ownerOpenid
      ) {
        return { failure: result('ORDER_NOT_FOUND', false) };
      }
      const existing = await tx.getRefund(refundNo);
      if (existing) {
        if (!validExistingRefund(
          existing,
          event,
          refundNo,
          ownerOpenid,
          order.paymentProfileSnapshot
            && order.paymentProfileSnapshot.subMchid
        )) {
          return { failure: result('IDEMPOTENCY_CONFLICT', false) };
        }
        if (!refundCounters(order)) {
          return { failure: result('ORDER_STATE_INVALID', false) };
        }
        if (existing.status === 'succeeded') {
          return { kind: 'succeeded', order, refund: existing };
        }
        if (existing.status === 'manual_review') {
          return { failure: result('REFUND_MANUAL_REVIEW', false) };
        }
        if (!validRefundOrder(order, ownerOpenid)) {
          return { failure: result('ORDER_STATE_INVALID', false) };
        }
        return {
          kind: existing.status === 'returning' ? 'query_return' : 'query_refund',
          order,
          refund: existing
        };
      }
      if (!validRefundOrder(order, ownerOpenid)) {
        return { failure: result('ORDER_STATE_INVALID', false) };
      }
      if (order.paymentProfileSnapshot.spMchid !== config.spMchid) {
        return { failure: result('REFUND_NOT_AVAILABLE', true) };
      }
      if (
        isPlainObject(order.refundClaim)
        && ACTIVE_REFUND_STATUSES.includes(order.refundClaim.status)
      ) {
        return { failure: result('REFUND_IN_PROGRESS', true) };
      }
      const counters = refundCounters(order);
      const nextRequestedRefundFen = counters.requestedRefundFen + event.refundFen;
      if (
        !Number.isSafeInteger(nextRequestedRefundFen)
        || nextRequestedRefundFen > order.wechatOrderTotalFen
      ) {
        return { failure: result('REFUND_AMOUNT_EXCEEDED', false) };
      }

      let splitReturnFen = 0;
      let splitReturnNo = null;
      let splitReturnStatus = 'not_required';
      if (order.splitStatus === 'succeeded') {
        if (
          typeof order.splitNo !== 'string'
          || !order.splitNo
          || (platformSplitFen(order) > 0
            && (
              typeof order.wechatSplitOrderId !== 'string'
              || !order.wechatSplitOrderId
              || typeof order.wechatSplitDetailId !== 'string'
              || !order.wechatSplitDetailId
            ))
        ) {
          return { failure: result('ORDER_STATE_INVALID', false) };
        }
        try {
          splitReturnFen = provisionalSplitReturnFen(order, nextRequestedRefundFen);
        } catch (_error) {
          return { failure: result('ORDER_STATE_INVALID', false) };
        }
        if (splitReturnFen > 0) {
          splitReturnNo = splitReturnNoForRefund(refundNo);
          splitReturnStatus = 'processing';
        }
      } else if (order.splitStatus === 'reversed') {
        const splitFen = platformSplitFen(order);
        if (splitFen === null || counters.splitReturnedFen !== splitFen) {
          return { failure: result('ORDER_STATE_INVALID', false) };
        }
      }

      const tracksSplitReturnAdjustment = order.splitStatus === 'succeeded'
        && platformSplitFen(order) > 0;
      const initialStatus = splitReturnFen > 0 ? 'returning' : 'processing';
      const refundClaim = {
        refundNo,
        attemptId: refundAttemptId(refundNo),
        status: initialStatus,
        claimedAt: now,
        requestedAt: now,
        leaseExpiresAt: now + REFUND_CLAIM_LEASE_MS,
        completedAt: null
      };
      const refund = {
        schemaVersion: 1,
        orderId: order.orderId,
        shopId: ownerOpenid,
        subMchid: order.paymentProfileSnapshot.subMchid,
        refundNo,
        idempotencyKey: event.idempotencyKey,
        reason: event.reason,
        refundFen: event.refundFen,
        status: initialStatus,
        refundClaim,
        splitReturnNo,
        splitReturnFen,
        splitReturnStatus,
        splitReturnBasis: tracksSplitReturnAdjustment
          ? 'provisional_cumulative_requested_gross'
          : 'not_required',
        splitReturnAdjustmentStatus: tracksSplitReturnAdjustment
          ? 'pending'
          : 'not_required',
        wechatSplitReturnId: '',
        wechatRefundId: '',
        payerRefundFen: null,
        couponRefundFen: null,
        settlementRefundFen: null,
        settlementTotalFen: null,
        discountRefundFen: null,
        reportedRefundFeeFen: null,
        requestedAt: now,
        refundNextAttemptAt: now + REFUND_CLAIM_LEASE_MS,
        refundCreateTime: null,
        refundCreatedAt: null,
        cumulativeRequestedBeforeFen: counters.requestedRefundFen,
        cumulativeGrossBeforeFen: counters.grossRefundedFen,
        cumulativePayerBeforeFen: counters.payerRefundedFen,
        cumulativeCouponBeforeFen: counters.couponRefundedFen,
        cumulativeSplitReturnedBeforeFen: counters.splitReturnedFen,
        createdAt: store.serverDate(),
        updatedAt: store.serverDate()
      };
      await tx.setRefund(refundNo, refund);
      const orderUpdate = {
        requestedRefundFen: nextRequestedRefundFen,
        refundClaim,
        updatedAt: store.serverDate()
      };
      if (order.splitStatus === 'succeeded' && order.splitPlatformNetFen === undefined) {
        orderUpdate.splitPlatformNetFen = order.platformNetFen;
      }
      await tx.updateOrder(order.orderId, orderUpdate);
      return {
        kind: splitReturnFen > 0 ? 'submit_return' : 'submit_refund',
        order: { ...order, ...orderUpdate },
        refund: { _id: refundNo, ...refund }
      };
    });
  }

  async function markReturnSucceeded(order, refund, remote, now) {
    return store.runTransaction(async (tx) => {
      const currentRefund = await tx.getRefund(refund.refundNo);
      const currentOrder = await tx.getOrder(order.orderId);
      if (
        !currentRefund
        || !currentOrder
        || currentRefund.status !== 'returning'
        || currentRefund.splitReturnStatus !== 'processing'
        || currentRefund.refundClaim.attemptId !== refund.refundClaim.attemptId
        || !isPlainObject(currentOrder.refundClaim)
        || currentOrder.refundClaim.refundNo !== refund.refundNo
        || currentOrder.refundClaim.status !== 'returning'
      ) {
        return null;
      }
      const nextSplitReturnedFen = currentRefund.cumulativeSplitReturnedBeforeFen
        + currentRefund.splitReturnFen;
      const splitFen = platformSplitFen(currentOrder);
      if (splitFen === null || nextSplitReturnedFen > splitFen) return null;
      const refundClaim = {
        ...currentRefund.refundClaim,
        status: 'processing'
      };
      const refundUpdate = {
        status: 'processing',
        refundClaim,
        splitReturnStatus: 'succeeded',
        wechatSplitReturnId: remote.return_id,
        splitReturnCompletedAt: now,
        updatedAt: store.serverDate()
      };
      const orderUpdate = {
        refundClaim,
        splitReturnedFen: nextSplitReturnedFen,
        splitStatus: splitFen > 0 && nextSplitReturnedFen === splitFen
          ? 'reversed'
          : currentOrder.splitStatus,
        updatedAt: store.serverDate()
      };
      await tx.updateRefund(refund.refundNo, refundUpdate);
      await tx.updateOrder(order.orderId, orderUpdate);
      return {
        order: { ...currentOrder, ...orderUpdate },
        refund: { ...currentRefund, ...refundUpdate }
      };
    });
  }

  async function markAccepted(order, refund, remote, validation) {
    return store.runTransaction(async (tx) => {
      const currentRefund = await tx.getRefund(refund.refundNo);
      const currentOrder = await tx.getOrder(order.orderId);
      if (
        currentRefund
        && currentOrder
        && currentRefund.status === 'succeeded'
      ) {
        if (currentRefund.wechatRefundId !== remote.refund_id) return 'mismatch';
        await tx.updateRefund(refund.refundNo, {
          acceptedRefundStatus: remote.status,
          refundCreateTime: validation.refundCreateTime,
          refundCreatedAt: validation.refundCreatedAt,
          acceptedAt: nowMs(),
          updatedAt: store.serverDate()
        });
        return 'succeeded';
      }
      if (
        !currentRefund
        || !currentOrder
        || currentRefund.status !== 'processing'
        || currentRefund.refundClaim.attemptId !== refund.refundClaim.attemptId
        || !isPlainObject(currentOrder.refundClaim)
        || currentOrder.refundClaim.refundNo !== refund.refundNo
        || currentOrder.refundClaim.status !== 'processing'
      ) {
        return 'changed';
      }
      await tx.updateRefund(refund.refundNo, {
        wechatRefundId: remote.refund_id,
        acceptedRefundStatus: remote.status,
        refundCreateTime: validation.refundCreateTime,
        refundCreatedAt: validation.refundCreatedAt,
        acceptedAt: nowMs(),
        updatedAt: store.serverDate()
      });
      return 'processing';
    });
  }

  async function manual(refundNo, reasons) {
    await markRefundManualReview({ store, refundNo, reasons });
    return result('REFUND_MANUAL_REVIEW', false);
  }

  async function claimRecovery(refundNo, now) {
    return store.runTransaction(async (tx) => {
      const refund = await tx.getRefund(refundNo);
      if (
        !refund
        || refund._id !== refundNo
        || refund.refundNo !== refundNo
        || !ACTIVE_REFUND_STATUSES.includes(refund.status)
        || !isPlainObject(refund.refundClaim)
        || refund.refundClaim.refundNo !== refundNo
        || refund.refundClaim.status !== refund.status
      ) return null;
      const order = await tx.getOrder(refund.orderId);
      if (
        !order
        || order._id !== refund.orderId
        || !isPlainObject(order.paymentProfileSnapshot)
        || refund.subMchid !== order.paymentProfileSnapshot.subMchid
        || !validRefundOrder(order, refund.shopId)
        || !isPlainObject(order.refundClaim)
        || order.refundClaim.refundNo !== refundNo
        || order.refundClaim.attemptId !== refund.refundClaim.attemptId
        || order.refundClaim.status !== refund.status
      ) return null;
      const hasNextAttempt = Object.prototype.hasOwnProperty.call(
        refund,
        'refundNextAttemptAt'
      );
      const dueAt = hasNextAttempt
        ? refund.refundNextAttemptAt
        : refund.refundClaim.leaseExpiresAt;
      if (!Number.isSafeInteger(dueAt) || dueAt < 0 || dueAt > now) return null;

      const refundClaim = {
        ...refund.refundClaim,
        claimedAt: now,
        leaseExpiresAt: now + REFUND_CLAIM_LEASE_MS
      };
      const update = {
        refundClaim,
        refundNextAttemptAt: now + REFUND_CLAIM_LEASE_MS,
        updatedAt: store.serverDate()
      };
      await tx.updateRefund(refundNo, update);
      await tx.updateOrder(order.orderId, {
        refundClaim,
        updatedAt: store.serverDate()
      });
      return {
        kind: refund.status === 'returning' ? 'query_return' : 'query_refund',
        order: { ...order, refundClaim },
        refund: { ...refund, ...update }
      };
    });
  }

  async function queryRefund(client, config, order, refund) {
    let remote;
    try {
      remote = await client.queryRefund(refund.refundNo, {
        sub_mchid: order.paymentProfileSnapshot.subMchid
      });
    } catch (error) {
      if (isVerifiedRefundNotFound(error) && !refund.wechatRefundId) {
        return submitRefund(client, config, order, refund);
      }
      if (isVerifiedDefinitiveError(error)) {
        return manual(refund.refundNo, ['REFUND_QUERY_DEFINITIVE_ERROR']);
      }
      return result('REFUND_RECONCILIATION_REQUIRED', true);
    }
    const validation = validateQueryRefund(remote, order, refund, false);
    if (validation.reasons.length > 0) {
      return manual(refund.refundNo, validation.reasons);
    }
    if (validation.status === 'PROCESSING') {
      return success(refund.refundNo, 'processing');
    }
    if (validation.status !== 'SUCCESS') {
      return manual(refund.refundNo, [`REFUND_${validation.status || 'UNKNOWN'}`]);
    }
    const outcome = await applyVerifiedRefundQuery({ store, refund: remote });
    if (outcome.status === 'success' || outcome.status === 'duplicate') {
      return success(refund.refundNo, 'succeeded');
    }
    if (outcome.status === 'mismatch') {
      return result('REFUND_MANUAL_REVIEW', false);
    }
    return result('REFUND_RECONCILIATION_REQUIRED', true);
  }

  async function submitRefund(client, config, order, refund) {
    let body;
    try {
      body = buildPartnerRefundBody({ order, refund, config });
    } catch (_error) {
      return manual(refund.refundNo, ['REFUND_REQUEST_SNAPSHOT']);
    }
    let remote;
    try {
      remote = await client.refund(body);
    } catch (error) {
      if (isVerifiedDefinitiveError(error)) {
        return manual(refund.refundNo, ['REFUND_SUBMIT_DEFINITIVE_ERROR']);
      }
      return result('REFUND_RECONCILIATION_REQUIRED', true);
    }
    const validation = validateQueryRefund(remote, order, refund, false);
    if (validation.reasons.length > 0) {
      return manual(refund.refundNo, validation.reasons);
    }
    if (!['PROCESSING', 'SUCCESS'].includes(validation.status)) {
      return manual(refund.refundNo, [`REFUND_${validation.status || 'UNKNOWN'}`]);
    }
    const accepted = await markAccepted(order, refund, remote, validation);
    if (accepted === 'mismatch') return manual(refund.refundNo, ['REFUND_ID']);
    if (accepted === 'succeeded') return success(refund.refundNo, 'succeeded');
    return accepted === 'processing'
      ? success(refund.refundNo, 'processing')
      : result('REFUND_STATE_CHANGED', true);
  }

  async function queryReturnThenRefund(client, config, order, refund, submitFirst) {
    let body;
    try {
      body = buildSplitReturnBody({ order, refund });
    } catch (_error) {
      return manual(refund.refundNo, ['SPLIT_RETURN_REQUEST_SNAPSHOT']);
    }
    if (submitFirst) {
      try {
        await client.splitReturn(body);
      } catch (error) {
        if (isVerifiedDefinitiveError(error)) {
          return manual(refund.refundNo, ['SPLIT_RETURN_SUBMIT_DEFINITIVE_ERROR']);
        }
        // The request may have reached WeChat Pay. The deterministic query is authoritative.
      }
    }
    let remote;
    try {
      remote = await client.querySplitReturn(refund.splitReturnNo, {
        sub_mchid: order.paymentProfileSnapshot.subMchid,
        out_order_no: order.splitNo
      });
    } catch (error) {
      if (!submitFirst && isVerifiedRefundNotFound(error)) {
        try {
          await client.splitReturn(body);
        } catch (submitError) {
          if (isVerifiedDefinitiveError(submitError)) {
            return manual(
              refund.refundNo,
              ['SPLIT_RETURN_SUBMIT_DEFINITIVE_ERROR']
            );
          }
        }
        try {
          remote = await client.querySplitReturn(refund.splitReturnNo, {
            sub_mchid: order.paymentProfileSnapshot.subMchid,
            out_order_no: order.splitNo
          });
        } catch (retryError) {
          if (
            isVerifiedDefinitiveError(retryError)
            && !isVerifiedRefundNotFound(retryError)
          ) {
            return manual(
              refund.refundNo,
              ['SPLIT_RETURN_QUERY_DEFINITIVE_ERROR']
            );
          }
          return result('SPLIT_RETURN_RECONCILIATION_REQUIRED', true);
        }
      } else {
        if (isVerifiedRefundNotFound(error)) {
          return result('SPLIT_RETURN_RECONCILIATION_REQUIRED', true);
        }
        if (isVerifiedDefinitiveError(error)) {
          return manual(refund.refundNo, ['SPLIT_RETURN_QUERY_DEFINITIVE_ERROR']);
        }
        return result('SPLIT_RETURN_RECONCILIATION_REQUIRED', true);
      }
    }
    const validation = validateSplitReturn(remote, order, refund);
    if (validation.reasons.length > 0) {
      return manual(refund.refundNo, validation.reasons);
    }
    if (validation.result === 'PROCESSING') {
      return result('SPLIT_RETURN_PROCESSING', true);
    }
    if (validation.result !== 'SUCCESS') {
      return manual(refund.refundNo, [`SPLIT_RETURN_${validation.result || 'UNKNOWN'}`]);
    }
    const finalized = await markReturnSucceeded(order, refund, remote, nowMs());
    if (!finalized) return result('REFUND_STATE_CHANGED', true);
    return submitRefund(client, config, finalized.order, finalized.refund);
  }

  async function recoverDueRefunds(client, config, now) {
    const summary = {
      ok: true,
      scanned: 0,
      claimed: 0,
      succeeded: 0,
      pending: 0,
      manualReview: 0,
      conflicts: 0
    };
    const due = await store.listDueRefunds(now, RECOVERY_BATCH_LIMIT);
    summary.scanned = due.length;
    for (const candidate of due) {
      let action;
      try {
        action = await claimRecovery(candidate._id, now);
      } catch (_error) {
        summary.conflicts += 1;
        continue;
      }
      if (!action) {
        summary.conflicts += 1;
        continue;
      }
      summary.claimed += 1;
      let outcome;
      try {
        outcome = action.kind === 'query_return'
          ? await queryReturnThenRefund(client, config, action.order, action.refund, false)
          : await queryRefund(client, config, action.order, action.refund);
      } catch (_error) {
        summary.pending += 1;
        continue;
      }
      if (outcome.ok && outcome.status === 'succeeded') {
        summary.succeeded += 1;
      } else if (!outcome.ok && outcome.code === 'REFUND_MANUAL_REVIEW') {
        summary.manualReview += 1;
      } else if (!outcome.ok && outcome.code === 'REFUND_STATE_CHANGED') {
        summary.conflicts += 1;
      } else {
        summary.pending += 1;
      }
    }
    return summary;
  }

  return async function requestTableRefund(event = {}) {
    const timer = exactRefundTimer(event);
    if (!timer && !exactRefundCommand(event)) {
      return result('INVALID_ARGUMENT', false);
    }
    let context;
    let config;
    let client;
    try {
      context = getContext();
      if (timer && !validTimerContext(context)) {
        return result('ACCESS_DENIED', false);
      }
      if (!timer && !validContext(context)) {
        throw new Error('invalid owner context');
      }
      config = loadConfig();
      client = createWechatPayClient(config);
    } catch (_error) {
      return result('REFUND_NOT_AVAILABLE', true);
    }
    const now = nowMs();
    if (!Number.isSafeInteger(now) || now < 0) {
      return result('REFUND_NOT_AVAILABLE', true);
    }
    if (timer) {
      try {
        return await recoverDueRefunds(client, config, now);
      } catch (_error) {
        return result('REFUND_NOT_AVAILABLE', true);
      }
    }

    let action;
    try {
      action = await claim(event, context.OPENID, config, now);
    } catch (_error) {
      return result('REFUND_NOT_AVAILABLE', true);
    }
    if (action.failure) return action.failure;
    if (action.kind === 'succeeded') {
      return success(action.refund.refundNo, 'succeeded');
    }
    if (action.kind === 'query_refund') {
      return queryRefund(client, config, action.order, action.refund);
    }
    if (action.kind === 'query_return') {
      return queryReturnThenRefund(client, config, action.order, action.refund, false);
    }
    if (action.kind === 'submit_return') {
      return queryReturnThenRefund(client, config, action.order, action.refund, true);
    }
    return submitRefund(client, config, action.order, action.refund);
  };
}

let productionHandler = null;
let productionCloud = null;

function getProductionCloud() {
  if (productionCloud) return productionCloud;
  const cloud = require('wx-server-sdk');
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
  productionCloud = cloud;
  return productionCloud;
}

function getProductionHandler() {
  if (productionHandler) return productionHandler;
  const cloud = getProductionCloud();
  const {
    createCloudbaseRefundStore
  } = require('./lib/table-refund/cloudbase-refund-store');
  const { loadWechatPayConfig } = require('./lib/wechatpay-v3/config');
  const { createWechatPayClient } = require('./lib/wechatpay-v3/client');
  productionHandler = createHandler({
    store: createCloudbaseRefundStore(
      cloud.database({ throwOnNotFound: false })
    ),
    getContext: () => cloud.getWXContext(),
    loadConfig: () => loadWechatPayConfig(),
    createWechatPayClient,
    nowMs: () => Date.now()
  });
  return productionHandler;
}

exports.createHandler = createHandler;
exports.isTrustedRefundTimer = isTrustedRefundTimer;

const { guardClientRequest } = require('./lib/auth/protocol-guard');

exports.main = async (event = {}) => {
  const cloud = getProductionCloud();
  const context = cloud.getWXContext() || {};
  let businessEvent = event;
  if (!isTrustedRefundTimer(event, context)) {
    const db = cloud.database({ throwOnNotFound: false });
    const gate = await guardClientRequest({
      db,
      event,
      supportedSchemaVersions: [1]
    });
    if (!gate.ok) return gate;
    if (Object.prototype.hasOwnProperty.call(event, 'authProtocol')) {
      const candidate = { ...event };
      delete candidate.authProtocol;
      if (exactRefundTimer(candidate)) return result('INVALID_ARGUMENT', false);
      businessEvent = candidate;
    }
  }
  return getProductionHandler()(businessEvent);
};
