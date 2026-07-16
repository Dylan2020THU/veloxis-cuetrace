'use strict';

const crypto = require('crypto');
const {
  buildPartnerJsapiBody,
  hashCheckoutToken,
  isPaymentProfileSnapshot,
  signClientPayment,
  snapshotReadyPaymentProfile
} = require('./lib/table-payment');
const { outTradeNoForOrderAttempt } = require('./lib/table-finance/state');

const CREATE_LEASE_MS = 120_000;
const PREPAY_VALID_MS = 2 * 60 * 60 * 1000;

function result(code, retryable) {
  return { ok: false, code, retryable };
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isSafeText(value, maximumBytes) {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= maximumBytes
    && !/[\x00-\x1f\x7f]/.test(value);
}

function validPaymentContext(context) {
  return isPlainObject(context)
    && isSafeText(context.OPENID, 128)
    && typeof context.APPID === 'string';
}

function expectedPayerAppId(snapshot) {
  return snapshot.openidMode === 'sp_openid'
    ? snapshot.spAppid
    : snapshot.subAppid;
}

function validAwaitingRelationship(order, session, digest) {
  return isPlainObject(order)
    && isPlainObject(session)
    && order._id === order.orderId
    && order.schemaVersion === 2
    && typeof order.shopId === 'string'
    && order._openid === order.shopId
    && order.checkoutTokenHash === digest
    && /^[0-9a-f]{64}$/.test(order.checkoutTokenHash)
    && order.orderStatus === 'awaiting_payment'
    && order.paymentStatus === 'unpaid'
    && order.splitStatus === 'pending'
    && order.policyVersion === 'table_commission_v1'
    && order.billingMode === 'table_commission'
    && order.commissionRateBps === 500
    && order.includesChannelFee === true
    && order.splitCycle === 'T_PLUS_1'
    && Number.isSafeInteger(order.tableGrossFen)
    && Number.isSafeInteger(order.tableDiscountFen)
    && Number.isSafeInteger(order.quotedTableFeeFen)
    && order.tableDiscountFen >= 0
    && order.quotedTableFeeFen > 0
    && order.tableGrossFen - order.tableDiscountFen === order.quotedTableFeeFen
    && order.paidTableFeeFen === order.quotedTableFeeFen
    && typeof order.outTradeNo === 'string'
    && /^[0-9A-Za-z_|*\-]{6,32}$/.test(order.outTradeNo)
    && session._id === order.sessionId
    && session.schemaVersion === 2
    && session._openid === order.shopId
    && session.shopId === order.shopId
    && session.storeId === order.storeId
    && session.tableId === order.tableId
    && session.orderId === order.orderId
    && session.status === 'awaiting_payment'
    && session.closedAt === null;
}

function validClaim(claim) {
  return isPlainObject(claim)
    && Object.keys(claim).length === 5
    && isSafeText(claim.attemptId, 64)
    && ['creating', 'prepay_ready', 'uncertain'].includes(claim.status)
    && Number.isSafeInteger(claim.claimedAt)
    && claim.claimedAt >= 0
    && Number.isSafeInteger(claim.leaseExpiresAt)
    && claim.leaseExpiresAt >= claim.claimedAt
    && Number.isSafeInteger(claim.nextReconcileAt)
    && claim.nextReconcileAt >= claim.claimedAt;
}

function validPrepayId(value) {
  return isSafeText(value, 64) && value === value.trim();
}

function validOutTradeNo(value) {
  return typeof value === 'string'
    && /^[0-9A-Za-z_|*\-]{6,32}$/.test(value);
}

function sameClaim(left, right) {
  return validClaim(left)
    && validClaim(right)
    && left.attemptId === right.attemptId
    && left.status === right.status
    && left.claimedAt === right.claimedAt
    && left.leaseExpiresAt === right.leaseExpiresAt
    && left.nextReconcileAt === right.nextReconcileAt;
}

function paymentAttemptMetadata(order, snapshot, payerOpenid, config) {
  let expectedBody;
  try {
    expectedBody = buildPartnerJsapiBody({
      order,
      paymentProfileSnapshot: snapshot,
      payerOpenid,
      config
    });
  } catch (_error) {
    return null;
  }
  const attemptNo = order.paymentAttemptNo === undefined
    ? 0
    : order.paymentAttemptNo;
  const previousOutTradeNos = order.previousOutTradeNos === undefined
    ? []
    : order.previousOutTradeNos;
  const requestBody = order.paymentRequestBody === undefined
    ? expectedBody
    : order.paymentRequestBody;
  if (
    !Number.isSafeInteger(attemptNo)
    || attemptNo < 0
    || !Array.isArray(previousOutTradeNos)
    || previousOutTradeNos.length !== attemptNo
    || previousOutTradeNos.some((value) => !validOutTradeNo(value))
    || new Set(previousOutTradeNos).size !== previousOutTradeNos.length
    || previousOutTradeNos.includes(order.outTradeNo)
    || !isPlainObject(requestBody)
    || JSON.stringify(requestBody) !== JSON.stringify(expectedBody)
  ) {
    return null;
  }
  return {
    attemptNo,
    previousOutTradeNos: previousOutTradeNos.slice(),
    requestBody: JSON.parse(JSON.stringify(requestBody))
  };
}

function randomHex(randomBytes, length) {
  const value = randomBytes(length);
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TypeError('secure random source returned invalid bytes');
  }
  const bytes = Buffer.from(value);
  if (bytes.length !== length) {
    throw new TypeError('secure random source returned the wrong byte count');
  }
  return bytes.toString('hex');
}

function validateDependencies(dependencies) {
  const names = [
    'getContext',
    'loadConfig',
    'createWechatPayClient',
    'signMiniProgramPayment',
    'randomBytes',
    'nowMs',
    'applyVerifiedTransaction'
  ];
  if (
    !isPlainObject(dependencies)
    || !dependencies.store
    || names.some((name) => typeof dependencies[name] !== 'function')
  ) {
    throw new TypeError('createTablePayOrder dependencies are invalid');
  }
}

function createHandler(dependencies) {
  validateDependencies(dependencies);
  const {
    store,
    getContext,
    loadConfig,
    createWechatPayClient,
    signMiniProgramPayment,
    randomBytes,
    nowMs,
    applyVerifiedTransaction
  } = dependencies;

  async function markUncertain(orderId, attemptId, uncertainAt) {
    return store.runTransaction(async (tx) => {
      const order = await tx.getOrder(orderId);
      if (
        !order
        || !validClaim(order.paymentClaim)
        || order.paymentClaim.attemptId !== attemptId
        || order.paymentClaim.status !== 'creating'
      ) {
        return false;
      }
      await tx.updateOrder(orderId, {
        paymentClaim: {
          ...order.paymentClaim,
          status: 'uncertain',
          nextReconcileAt: uncertainAt
        },
        updatedAt: store.serverDate()
      });
      return true;
    });
  }

  async function finalizePrepay(orderId, payerOpenid, attemptId, prepayId, finishedAt) {
    return store.runTransaction(async (tx) => {
      const order = await tx.getOrder(orderId);
      if (
        !order
        || order.orderStatus !== 'awaiting_payment'
        || order.paymentStatus !== 'unpaid'
        || order.payerOpenid !== payerOpenid
        || !validClaim(order.paymentClaim)
        || order.paymentClaim.attemptId !== attemptId
        || order.paymentClaim.status !== 'creating'
      ) {
        return false;
      }
      const prepayExpiresAt = finishedAt + PREPAY_VALID_MS;
      await tx.updateOrder(orderId, {
        paymentClaim: {
          ...order.paymentClaim,
          status: 'prepay_ready',
          nextReconcileAt: prepayExpiresAt
        },
        prepayId,
        prepayExpiresAt,
        updatedAt: store.serverDate()
      });
      return true;
    });
  }

  async function claimRecoveryCreate({
    queriedOrder,
    snapshot,
    expectedClaim,
    tradeState,
    attemptId,
    claimedAt,
    config
  }) {
    if (
      !Number.isSafeInteger(claimedAt)
      || claimedAt < 0
      || !Number.isSafeInteger(claimedAt + CREATE_LEASE_MS)
    ) {
      return { failure: result('PAYMENT_NOT_AVAILABLE', true) };
    }
    return store.runTransaction(async (tx) => {
      const current = await tx.getOrder(queriedOrder.orderId);
      if (
        !current
        || current._id !== queriedOrder.orderId
        || current.orderStatus !== 'awaiting_payment'
        || current.paymentStatus !== 'unpaid'
        || current.payerOpenid !== queriedOrder.payerOpenid
        || current.outTradeNo !== queriedOrder.outTradeNo
        || !sameClaim(current.paymentClaim, expectedClaim)
        || JSON.stringify(current.paymentProfileSnapshot) !== JSON.stringify(snapshot)
      ) {
        if (
          current
          && current.paymentStatus === 'paid'
          && ['complete', 'manual_review'].includes(current.orderStatus)
        ) {
          return { failure: result('PAYMENT_ALREADY_CONFIRMED', false) };
        }
        if (
          current
          && current.orderStatus === 'manual_review'
        ) {
          return { failure: result('PAYMENT_MANUAL_REVIEW', false) };
        }
        if (
          current
          && current.orderStatus === 'awaiting_payment'
          && current.paymentStatus === 'unpaid'
          && current.payerOpenid === queriedOrder.payerOpenid
          && isPaymentProfileSnapshot(current.paymentProfileSnapshot)
          && JSON.stringify(current.paymentProfileSnapshot) === JSON.stringify(snapshot)
          && validClaim(current.paymentClaim)
          && current.paymentClaim.status === 'prepay_ready'
          && validPrepayId(current.prepayId)
          && Number.isSafeInteger(current.prepayExpiresAt)
          && current.prepayExpiresAt > claimedAt
        ) {
          return {
            kind: 'sign',
            snapshot: current.paymentProfileSnapshot,
            prepayId: current.prepayId,
            timestampMs: claimedAt
          };
        }
        if (
          current
          && validClaim(current.paymentClaim)
          && current.paymentClaim.status === 'creating'
          && current.paymentClaim.leaseExpiresAt > claimedAt
        ) {
          return { failure: result('PAYMENT_CREATING', true) };
        }
        return { failure: result('PAYMENT_STATE_CHANGED', true) };
      }

      const metadata = paymentAttemptMetadata(
        current,
        snapshot,
        current.payerOpenid,
        config
      );
      if (!metadata) {
        return { failure: result('ORDER_STATE_INVALID', false) };
      }
      let paymentAttemptNo = metadata.attemptNo;
      let previousOutTradeNos = metadata.previousOutTradeNos;
      let outTradeNo = current.outTradeNo;
      let requestBody = metadata.requestBody;
      if (tradeState === 'CLOSED') {
        paymentAttemptNo += 1;
        let rotatedOutTradeNo;
        try {
          rotatedOutTradeNo = outTradeNoForOrderAttempt(
            current.orderId,
            paymentAttemptNo
          );
        } catch (_error) {
          rotatedOutTradeNo = null;
        }
        if (
          !validOutTradeNo(rotatedOutTradeNo)
          || rotatedOutTradeNo === current.outTradeNo
          || previousOutTradeNos.includes(rotatedOutTradeNo)
        ) {
          await tx.updateOrder(current.orderId, {
            orderStatus: 'manual_review',
            manualReviewReason: 'payment_attempt_collision',
            manualReviewReasonCodes: ['OUT_TRADE_NO_COLLISION'],
            updatedAt: store.serverDate()
          });
          return { failure: result('PAYMENT_MANUAL_REVIEW', false) };
        }
        previousOutTradeNos = previousOutTradeNos.concat(current.outTradeNo);
        outTradeNo = rotatedOutTradeNo;
        requestBody = {
          ...requestBody,
          out_trade_no: rotatedOutTradeNo
        };
      }

      const leaseExpiresAt = claimedAt + CREATE_LEASE_MS;
      const paymentClaim = {
        attemptId,
        status: 'creating',
        claimedAt,
        leaseExpiresAt,
        nextReconcileAt: leaseExpiresAt
      };
      await tx.updateOrder(current.orderId, {
        outTradeNo,
        paymentAttemptNo,
        previousOutTradeNos,
        paymentRequestBody: requestBody,
        paymentClaim,
        prepayId: '',
        prepayExpiresAt: null,
        updatedAt: store.serverDate()
      });
      return {
        kind: 'create',
        orderId: current.orderId,
        snapshot,
        attemptId,
        requestBody,
        claimedAt
      };
    });
  }

  function sign(snapshot, prepayId, config, timestampMs) {
    return signClientPayment({
      paymentProfileSnapshot: snapshot,
      prepayId,
      timeStamp: String(Math.floor(timestampMs / 1000)),
      nonceStr: randomHex(randomBytes, 16),
      merchantPrivateKey: config.merchantPrivateKey,
      signMiniProgramPayment
    });
  }

  return async function createTablePayOrder(event = {}) {
    if (
      !isPlainObject(event)
      || Object.keys(event).length !== 1
      || !Object.prototype.hasOwnProperty.call(event, 'token')
    ) {
      return result('ORDER_NOT_FOUND', false);
    }
    const digest = hashCheckoutToken(event.token);
    if (digest === null) return result('ORDER_NOT_FOUND', false);

    let context;
    let config;
    try {
      context = getContext();
      config = loadConfig();
    } catch (_error) {
      return result('PAYMENT_NOT_AVAILABLE', true);
    }
    if (!validPaymentContext(context)) return result('PAYMENT_NOT_AVAILABLE', false);

    let matches;
    try {
      matches = await store.findOrdersByTokenHash(digest, 2);
    } catch (_error) {
      return result('ORDER_NOT_FOUND', false);
    }
    if (!Array.isArray(matches) || matches.length !== 1) {
      return result('ORDER_NOT_FOUND', false);
    }

    const now = nowMs();
    if (!Number.isSafeInteger(now) || now < 0) {
      return result('PAYMENT_NOT_AVAILABLE', true);
    }
    const attemptId = `attempt_${randomHex(randomBytes, 12)}`;
    let action;
    try {
      action = await store.runTransaction(async (tx) => {
        const order = await tx.getOrder(matches[0]._id);
        if (!order || order._id !== matches[0]._id) {
          return { failure: result('ORDER_NOT_FOUND', false) };
        }
        const session = await tx.getSession(order.sessionId);
        if (!validAwaitingRelationship(order, session, digest)) {
          return { failure: result('ORDER_STATE_INVALID', false) };
        }
        if (order.payerOpenid && order.payerOpenid !== context.OPENID) {
          return { failure: result('PAYER_MISMATCH', false) };
        }

        if (order.payerOpenid) {
          if (!isPaymentProfileSnapshot(order.paymentProfileSnapshot)) {
            return { failure: result('ORDER_STATE_INVALID', false) };
          }
          if (expectedPayerAppId(order.paymentProfileSnapshot) !== context.APPID) {
            return { failure: result('APPID_MISMATCH', false) };
          }
          if (!validClaim(order.paymentClaim)) {
            return { failure: result('ORDER_STATE_INVALID', false) };
          }
          if (
            order.paymentClaim.status === 'prepay_ready'
            && validPrepayId(order.prepayId)
            && Number.isSafeInteger(order.prepayExpiresAt)
            && order.prepayExpiresAt > now
          ) {
            return {
              kind: 'sign',
              snapshot: order.paymentProfileSnapshot,
              prepayId: order.prepayId
            };
          }
          if (
            order.paymentClaim.status === 'creating'
            && order.paymentClaim.leaseExpiresAt > now
          ) {
            return { failure: result('PAYMENT_CREATING', true) };
          }
          if (
            order.paymentClaim.status === 'uncertain'
            || order.paymentClaim.status === 'prepay_ready'
            || (
              order.paymentClaim.status === 'creating'
              && order.paymentClaim.leaseExpiresAt <= now
            )
          ) {
            if (!paymentAttemptMetadata(
              order,
              order.paymentProfileSnapshot,
              order.payerOpenid,
              config
            )) {
              return { failure: result('ORDER_STATE_INVALID', false) };
            }
            let expectedClaim = order.paymentClaim;
            if (order.paymentClaim.status === 'creating') {
              expectedClaim = {
                ...order.paymentClaim,
                status: 'uncertain',
                nextReconcileAt: now
              };
              await tx.updateOrder(order.orderId, {
                paymentClaim: expectedClaim,
                updatedAt: store.serverDate()
              });
            }
            return {
              kind: 'query',
              order,
              snapshot: order.paymentProfileSnapshot,
              expectedClaim
            };
          }
          return { failure: result('ORDER_STATE_INVALID', false) };
        }

        if (
          order.paymentProfileSnapshot !== null
          || order.paymentClaim !== null
          || order.prepayId !== ''
          || order.prepayExpiresAt !== null
          || order.paymentAttemptNo !== undefined
          || order.previousOutTradeNos !== undefined
          || order.paymentRequestBody !== undefined
        ) {
          return { failure: result('ORDER_STATE_INVALID', false) };
        }
        const profile = await tx.getPaymentProfile(order.shopId);
        let snapshot;
        try {
          snapshot = snapshotReadyPaymentProfile(profile, order, config);
        } catch (_error) {
          return { failure: result('PAYMENT_PROFILE_NOT_READY', false) };
        }
        if (expectedPayerAppId(snapshot) !== context.APPID) {
          return { failure: result('APPID_MISMATCH', false) };
        }
        const leaseExpiresAt = now + CREATE_LEASE_MS;
        const paymentClaim = {
          attemptId,
          status: 'creating',
          claimedAt: now,
          leaseExpiresAt,
          nextReconcileAt: leaseExpiresAt
        };
        let paymentRequestBody;
        try {
          paymentRequestBody = buildPartnerJsapiBody({
            order,
            paymentProfileSnapshot: snapshot,
            payerOpenid: context.OPENID,
            config
          });
        } catch (_error) {
          return { failure: result('ORDER_STATE_INVALID', false) };
        }
        await tx.updateOrder(order.orderId, {
          payerOpenid: context.OPENID,
          paymentProfileSnapshot: snapshot,
          paymentAttemptNo: 0,
          previousOutTradeNos: [],
          paymentRequestBody,
          paymentClaim,
          updatedAt: store.serverDate()
        });
        return {
          kind: 'create',
          orderId: order.orderId,
          snapshot,
          attemptId,
          requestBody: paymentRequestBody,
          claimedAt: now
        };
      });
    } catch (_error) {
      return result('PAYMENT_NOT_AVAILABLE', true);
    }

    if (action.failure) return action.failure;
    if (action.kind === 'sign') {
      try {
        return sign(action.snapshot, action.prepayId, config, now);
      } catch (_error) {
        return result('PAYMENT_NOT_AVAILABLE', true);
      }
    }

    let client;
    try {
      client = createWechatPayClient(config);
    } catch (_error) {
      return result('PAYMENT_NOT_AVAILABLE', true);
    }

    if (action.kind === 'query') {
      let remote;
      try {
        remote = await client.queryByOutTradeNo(action.order.outTradeNo, {
          sp_mchid: action.snapshot.spMchid,
          sub_mchid: action.snapshot.subMchid
        });
      } catch (_error) {
        return result('PAYMENT_RECONCILIATION_REQUIRED', true);
      }
      if (isPlainObject(remote) && remote.trade_state === 'SUCCESS') {
        let outcome;
        try {
          outcome = await applyVerifiedTransaction({ store, transaction: remote });
        } catch (_error) {
          return result('PAYMENT_RECONCILIATION_REQUIRED', true);
        }
        if (outcome && (outcome.status === 'success' || outcome.status === 'duplicate')) {
          return result('PAYMENT_ALREADY_CONFIRMED', false);
        }
        if (outcome && outcome.status === 'mismatch') {
          return result('PAYMENT_MANUAL_REVIEW', false);
        }
        return result('PAYMENT_RECONCILIATION_REQUIRED', true);
      }
      if (
        !isPlainObject(remote)
        || !['NOTPAY', 'CLOSED'].includes(remote.trade_state)
      ) {
        return result('PAYMENT_RECONCILIATION_REQUIRED', true);
      }
      try {
        const recoveryAt = nowMs();
        action = await claimRecoveryCreate({
          queriedOrder: action.order,
          snapshot: action.snapshot,
          expectedClaim: action.expectedClaim,
          tradeState: remote.trade_state,
          attemptId,
          claimedAt: recoveryAt,
          config
        });
      } catch (_error) {
        return result('PAYMENT_NOT_AVAILABLE', true);
      }
      if (action.failure) return action.failure;
      if (action.kind === 'sign') {
        try {
          return sign(
            action.snapshot,
            action.prepayId,
            config,
            action.timestampMs
          );
        } catch (_error) {
          return result('PAYMENT_NOT_AVAILABLE', true);
        }
      }
    }

    let response;
    try {
      response = await client.createJsapi(action.requestBody);
    } catch (_error) {
      await markUncertain(action.orderId, action.attemptId, action.claimedAt);
      return result('PAYMENT_RECONCILIATION_REQUIRED', true);
    }
    if (
      !isPlainObject(response)
      || Object.keys(response).length !== 1
      || !validPrepayId(response.prepay_id)
    ) {
      await markUncertain(action.orderId, action.attemptId, action.claimedAt);
      return result('PAYMENT_RECONCILIATION_REQUIRED', true);
    }
    const finishedAt = nowMs();
    if (!Number.isSafeInteger(finishedAt) || finishedAt < action.claimedAt) {
      await markUncertain(action.orderId, action.attemptId, action.claimedAt);
      return result('PAYMENT_RECONCILIATION_REQUIRED', true);
    }
    const finalized = await finalizePrepay(
      action.orderId,
      context.OPENID,
      action.attemptId,
      response.prepay_id,
      finishedAt
    );
    if (!finalized) return result('PAYMENT_STATE_CHANGED', true);
    try {
      return sign(action.snapshot, response.prepay_id, config, finishedAt);
    } catch (_error) {
      return result('PAYMENT_NOT_AVAILABLE', true);
    }
  };
}

let productionHandler = null;

function getProductionHandler() {
  if (productionHandler) return productionHandler;
  const cloud = require('wx-server-sdk');
  const { createCloudbasePaymentStore } = require('./lib/cloudbase-payment-store');
  const { loadWechatPayConfig } = require('./lib/wechatpay-v3/config');
  const {
    createWechatPayClient,
    signMiniProgramPayment
  } = require('./lib/wechatpay-v3/client');
  const { applyVerifiedTransaction } = require('./lib/payment-transition');
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
  const db = cloud.database({ throwOnNotFound: false });
  productionHandler = createHandler({
    store: createCloudbasePaymentStore(db),
    getContext: () => cloud.getWXContext(),
    loadConfig: () => loadWechatPayConfig(),
    createWechatPayClient,
    signMiniProgramPayment,
    randomBytes: (length) => crypto.randomBytes(length),
    nowMs: () => Date.now(),
    applyVerifiedTransaction
  });
  return productionHandler;
}

exports.createHandler = createHandler;
exports.main = (event) => getProductionHandler()(event);

let protocolDatabase = null;

function getProtocolDatabase() {
  if (protocolDatabase) return protocolDatabase;
  const cloud = require('wx-server-sdk');
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
  protocolDatabase = cloud.database({ throwOnNotFound: false });
  return protocolDatabase;
}

const db = {
  collection(name) {
    return getProtocolDatabase().collection(name);
  }
};
const { guardClientRequest } = require('./lib/auth/protocol-guard');
const protocolGuardedMain = exports.main;

exports.main = async (event = {}, ...args) => {
  const gate = await guardClientRequest({
    db,
    event,
    supportedSchemaVersions: [1]
  });
  if (!gate.ok) return gate;
  let businessEvent = event;
  if (Object.prototype.hasOwnProperty.call(event, 'authProtocol')) {
    businessEvent = { ...event };
    delete businessEvent.authProtocol;
  }
  return protocolGuardedMain(businessEvent, ...args);
};
