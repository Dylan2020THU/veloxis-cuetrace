'use strict';

const RECONCILE_RETRY_MS = 5 * 60 * 1000;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validSnapshot(snapshot, config) {
  const keys = [
    'spAppid',
    'spMchid',
    'subAppid',
    'subMchid',
    'openidMode',
    'profileSchemaVersion',
    'policyVersion'
  ];
  return isPlainObject(snapshot)
    && Object.keys(snapshot).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(snapshot, key))
    && snapshot.spAppid === config.spAppId
    && snapshot.spMchid === config.spMchid
    && /^[0-9]{8,32}$/.test(snapshot.subMchid)
    && snapshot.profileSchemaVersion === 1
    && snapshot.policyVersion === 'table_commission_v1'
    && (
      (snapshot.openidMode === 'sp_openid' && snapshot.subAppid === null)
      || (
        snapshot.openidMode === 'sub_openid'
        && /^wx[0-9A-Za-z]{16}$/.test(snapshot.subAppid)
      )
    );
}

function staleCandidate(order, config, now) {
  const claim = order && order.paymentClaim;
  if (
    !isPlainObject(order)
    || typeof order._id !== 'string'
    || !order._id
    || order.orderId !== order._id
    || order.schemaVersion !== 2
    || order.orderStatus !== 'awaiting_payment'
    || order.paymentStatus !== 'unpaid'
    || typeof order.outTradeNo !== 'string'
    || !/^[0-9A-Za-z_|*\-]{6,32}$/.test(order.outTradeNo)
    || typeof order.payerOpenid !== 'string'
    || !order.payerOpenid
    || !validSnapshot(order.paymentProfileSnapshot, config)
    || !isPlainObject(claim)
    || typeof claim.attemptId !== 'string'
    || !claim.attemptId
    || !Number.isSafeInteger(claim.leaseExpiresAt)
    || !Number.isSafeInteger(claim.nextReconcileAt)
    || claim.nextReconcileAt > now
  ) {
    return false;
  }
  if (claim.status === 'uncertain') return true;
  if (claim.status === 'creating') return claim.leaseExpiresAt <= now;
  return claim.status === 'prepay_ready'
    && Number.isSafeInteger(order.prepayExpiresAt)
    && order.prepayExpiresAt <= now;
}

function exactTimerEvent(event) {
  return isPlainObject(event)
    && Object.keys(event).length === 2
    && event.Type === 'Timer'
    && event.TriggerName === 'reconcileTablePaymentsTimer';
}

function hasOpenid(value) {
  return isPlainObject(value)
    && typeof value.OPENID === 'string'
    && value.OPENID.length > 0;
}

function createReconcileHandler(dependencies) {
  const names = [
    'getContext',
    'loadConfig',
    'createWechatPayClient',
    'nowMs',
    'applyVerifiedTransaction'
  ];
  if (
    !isPlainObject(dependencies)
    || !dependencies.store
    || names.some((name) => typeof dependencies[name] !== 'function')
  ) {
    throw new TypeError('reconcileTablePayments dependencies are invalid');
  }
  const {
    store,
    getContext,
    loadConfig,
    createWechatPayClient,
    nowMs,
    applyVerifiedTransaction
  } = dependencies;

  async function deferCandidate(order, nextReconcileAt) {
    const orderId = order && order._id;
    if (typeof orderId !== 'string' || !orderId) return false;
    return store.runTransaction(async (tx) => {
      const current = await tx.getOrder(orderId);
      const expectedClaim = order.paymentClaim;
      const currentClaim = current && current.paymentClaim;
      if (
        !current
        || current._id !== orderId
        || current.schemaVersion !== 2
        || current.orderStatus !== 'awaiting_payment'
        || current.paymentStatus !== 'unpaid'
        || !isPlainObject(expectedClaim)
        || !isPlainObject(currentClaim)
        || currentClaim.attemptId !== expectedClaim.attemptId
        || currentClaim.status !== expectedClaim.status
        || currentClaim.nextReconcileAt !== expectedClaim.nextReconcileAt
      ) {
        return false;
      }
      await tx.updateOrder(orderId, {
        paymentClaim: {
          ...currentClaim,
          nextReconcileAt
        },
        updatedAt: store.serverDate()
      });
      return true;
    });
  }

  return async function reconcileTablePayments(event, context = {}) {
    let runtimeContext;
    try {
      runtimeContext = getContext();
    } catch (_error) {
      return { ok: false, code: 'ACCESS_DENIED' };
    }
    if (
      !exactTimerEvent(event)
      || hasOpenid(context)
      || hasOpenid(runtimeContext)
    ) {
      return { ok: false, code: 'ACCESS_DENIED' };
    }

    let config;
    let client;
    let now;
    try {
      config = loadConfig();
      client = createWechatPayClient(config);
      now = nowMs();
      if (!Number.isSafeInteger(now) || now < 0) throw new Error('invalid clock');
      if (!Number.isSafeInteger(now + RECONCILE_RETRY_MS)) {
        throw new Error('invalid reconciliation clock');
      }
    } catch (_error) {
      return { ok: false, code: 'PAYMENT_NOT_AVAILABLE' };
    }

    let candidates;
    try {
      candidates = await store.listReconcileCandidates(now, 20);
    } catch (_error) {
      return { ok: false, code: 'RECONCILIATION_FAILED' };
    }
    if (!Array.isArray(candidates)) {
      return { ok: false, code: 'RECONCILIATION_FAILED' };
    }

    let scanned = 0;
    let settled = 0;
    for (const order of candidates) {
      if (!staleCandidate(order, config, now)) {
        try {
          await deferCandidate(order, now + RECONCILE_RETRY_MS);
        } catch (_error) {
          // Invalid candidates remain fail-closed and are retried later.
        }
        continue;
      }
      scanned += 1;
      try {
        let remote;
        try {
          remote = await client.queryByOutTradeNo(order.outTradeNo, {
            sp_mchid: order.paymentProfileSnapshot.spMchid,
            sub_mchid: order.paymentProfileSnapshot.subMchid
          });
        } catch (_error) {
          continue;
        }
        if (!isPlainObject(remote) || remote.trade_state !== 'SUCCESS') continue;
        try {
          const outcome = await applyVerifiedTransaction({
            store,
            transaction: remote,
            expectedOrderId: order._id
          });
          if (outcome && ['success', 'duplicate'].includes(outcome.status)) {
            settled += 1;
          }
        } catch (_error) {
          // A later timer/query remains authoritative; never infer local success.
        }
      } finally {
        try {
          await deferCandidate(order, now + RECONCILE_RETRY_MS);
        } catch (_error) {
          // A failed retry-schedule write is retried from the same signed state.
        }
      }
    }
    return { ok: true, scanned, settled };
  };
}

let productionHandler = null;

function getProductionHandler() {
  if (productionHandler) return productionHandler;
  const cloud = require('wx-server-sdk');
  const { createCloudbasePaymentStore } = require('./lib/cloudbase-payment-store');
  const { loadWechatPayConfig } = require('./lib/wechatpay-v3/config');
  const { createWechatPayClient } = require('./lib/wechatpay-v3/client');
  const { applyVerifiedTransaction } = require('./lib/payment-transition');
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
  productionHandler = createReconcileHandler({
    store: createCloudbasePaymentStore(
      cloud.database({ throwOnNotFound: false })
    ),
    getContext: () => cloud.getWXContext(),
    loadConfig: () => loadWechatPayConfig(),
    createWechatPayClient,
    nowMs: () => Date.now(),
    applyVerifiedTransaction
  });
  return productionHandler;
}

exports.createReconcileHandler = createReconcileHandler;
exports.main = (event, context) => getProductionHandler()(event, context);
