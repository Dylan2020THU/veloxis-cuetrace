const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const {
  orderIdForSession,
  outTradeNoForOrder,
  splitNoForOrder
} = require('./lib/state');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database({ throwOnNotFound: false });
const VALID_ROLES = ['member', 'coach', 'shop'];

function bindingId(openid) {
  return crypto.createHash('sha256').update('wechat:' + openid).digest('hex');
}

function fail(code, msg) {
  return { ok: false, code, msg };
}

function hasValue(value) {
  if (value === undefined || value === null || value === '') return false;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value).length > 0;
  }
  return true;
}

function hasPlatformPaymentAttempt(order) {
  return hasValue(order.payerOpenid)
    || hasValue(order.paymentClaim)
    || hasValue(order.paymentAttemptId)
    || hasValue(order.paymentAttemptStatus)
    || hasValue(order.paymentProfileSnapshot)
    || hasValue(order.prepayId)
    || hasValue(order.prepayExpiresAt)
    || hasValue(order.paymentAttemptedAt)
    || hasValue(order.paymentUncertainAt);
}

function isBusinessId(value) {
  return typeof value === 'string'
    && /^[0-9A-Za-z_-]{1,64}$/.test(value)
    && value.indexOf('__') === -1;
}

function occupancyIdFor(storeId, tableId) {
  return String(storeId.length) + '_' + storeId + '__' + tableId;
}

async function getOptional(ref) {
  const result = await ref.get();
  return result && result.data ? result.data : null;
}

async function requireShopOwner(source, openid) {
  const userId = bindingId(openid);
  const binding = await getOptional(source.collection('wechat_bindings').doc(userId));
  if (
    !binding ||
    binding._id !== userId ||
    binding._openid !== openid ||
    !binding.accountId ||
    !binding.account
  ) {
    return fail('ACCOUNT_NOT_BOUND', 'Account binding is incomplete');
  }
  const account = await getOptional(source.collection('accounts').doc(binding.accountId));
  const user = await getOptional(source.collection('users').doc(userId));
  if (
    !account ||
    account._id !== binding.accountId ||
    account._openid !== openid ||
    account.account !== binding.account ||
    account.status !== 'active' ||
    !user ||
    user._id !== userId ||
    user._openid !== openid
  ) {
    return fail('ACCOUNT_NOT_BOUND', 'Account binding is incomplete');
  }
  const roles = Array.isArray(user.roles)
    ? user.roles.filter((role) => VALID_ROLES.indexOf(role) !== -1)
    : [];
  if (roles.indexOf('shop') === -1) {
    return fail('SHOP_ROLE_REQUIRED', 'An approved shop role is required');
  }
  return null;
}

function validateInput(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return fail('INVALID_INPUT', 'orderId and reason are required');
  }
  if (Object.keys(event).some((key) => key !== 'orderId' && key !== 'reason')) {
    return fail('INVALID_INPUT', 'Unsupported external-paid input');
  }
  if (typeof event.orderId !== 'string' || !event.orderId.trim()) {
    return fail('INVALID_INPUT', 'orderId is required');
  }
  if (typeof event.reason !== 'string') {
    return fail('INVALID_INPUT', 'reason is required');
  }
  const reason = event.reason.trim();
  if (!reason || reason.length > 200) {
    return fail('INVALID_INPUT', 'reason must contain 1 to 200 characters');
  }
  return null;
}

function externalPaidResult(order) {
  return {
    ok: true,
    orderId: order.orderId,
    orderStatus: order.orderStatus,
    paymentStatus: order.paymentStatus,
    splitStatus: order.splitStatus,
    paidTableFeeFen: order.paidTableFeeFen,
    externalPaidAt: order.externalPaidAt
  };
}

function validSessionRelationship(session, order, openid, expectedStatus) {
  return !!session
    && session._id === order.sessionId
    && session.schemaVersion === 2
    && session._openid === openid
    && session.shopId === openid
    && session.orderId === order.orderId
    && session.storeId === order.storeId
    && session.tableId === order.tableId
    && session.status === expectedStatus;
}

function validPricingSnapshot(order, session) {
  const orderSnapshot = order && order.pricingSnapshot;
  const sessionSnapshot = session && session.pricingSnapshot;
  const keys = [
    'tableId',
    'name',
    'pricePerHourFen',
    'pricePerHour',
    'pricingRuleVersion',
    'minimumDurationMs',
    'billingStepMs',
    'roundingMode'
  ];
  if (
    !orderSnapshot ||
    !sessionSnapshot ||
    Object.keys(orderSnapshot).length !== keys.length ||
    Object.keys(sessionSnapshot).length !== keys.length ||
    !keys.every((key) => orderSnapshot[key] === sessionSnapshot[key])
  ) {
    return false;
  }
  return sessionSnapshot.tableId === session.tableId
    && typeof sessionSnapshot.name === 'string'
    && !!sessionSnapshot.name.trim()
    && Number.isSafeInteger(sessionSnapshot.pricePerHourFen)
    && sessionSnapshot.pricePerHourFen > 0
    && sessionSnapshot.pricePerHour === sessionSnapshot.pricePerHourFen / 100
    && sessionSnapshot.pricingRuleVersion === 'hourly_exact_v1'
    && sessionSnapshot.minimumDurationMs === 0
    && sessionSnapshot.billingStepMs === 1
    && sessionSnapshot.roundingMode === 'nearest_fen';
}

function exactHourlyFen(elapsedMs, pricePerHourFen) {
  if (
    !Number.isSafeInteger(elapsedMs) ||
    elapsedMs < 0 ||
    !Number.isSafeInteger(pricePerHourFen) ||
    pricePerHourFen <= 0
  ) {
    return null;
  }
  const denominator = 3600000n;
  const rounded = (
    BigInt(elapsedMs) * BigInt(pricePerHourFen) + denominator / 2n
  ) / denominator;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(rounded);
}

function expectedCommissionFen(paidTableFeeFen) {
  const commission = (
    BigInt(paidTableFeeFen) * 500n + 5000n
  ) / 10000n;
  if (commission > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(commission);
}

function validTrustedOrderState(order, session, openid) {
  if (
    !validPricingSnapshot(order, session) ||
    order.tableName !== session.pricingSnapshot.name ||
    order.startedAt !== session.startedAt ||
    order.checkoutAt !== session.checkoutAt ||
    session.checkoutBy !== openid ||
    !Number.isSafeInteger(order.startedAt) ||
    order.startedAt < 0 ||
    !Number.isSafeInteger(order.checkoutAt) ||
    order.checkoutAt < order.startedAt
  ) {
    return false;
  }
  const elapsedMs = order.checkoutAt - order.startedAt;
  const tableGrossFen = exactHourlyFen(
    elapsedMs,
    order.pricingSnapshot.pricePerHourFen
  );
  return tableGrossFen !== null
    && order.actualDurationMs === elapsedMs
    && order.billedDurationMs === elapsedMs
    && order.tableGrossFen === tableGrossFen
    && order.tableDiscountFen === 0
    && order.paidTableFeeFen === tableGrossFen
    && order.payerOpenid === ''
    && order.billingMode === 'table_commission'
    && order.commissionRateBps === 500
    && order.includesChannelFee === true
    && order.policyVersion === 'table_commission_v1'
    && order.splitCycle === 'T_PLUS_1'
    && order.wechatTransactionId === ''
    && order.paidAt === null
    && order.splitCompletedAt === null
    && order.refundedTableFeeFen === 0
    && order.reversedTotalCostFen === 0;
}

function validAwaitingPaymentState(order, session, openid) {
  if (!validTrustedOrderState(order, session, openid) || session.closedAt !== null) {
    return false;
  }
  const totalCostFen = expectedCommissionFen(order.paidTableFeeFen);
  return totalCostFen !== null
    && order.totalCostFen === totalCostFen
    && order.channelFeeFen === null
    && order.platformNetFen === null
    && order.shopNetFen === order.paidTableFeeFen - totalCostFen;
}

function validExternalPaidState(order, session, openid) {
  return validTrustedOrderState(order, session, openid)
    && order.orderStatus === 'external_paid'
    && order.paymentStatus === 'not_applicable'
    && order.splitStatus === 'not_applicable'
    && Number.isSafeInteger(order.paidTableFeeFen)
    && order.paidTableFeeFen >= 0
    && order.totalCostFen === 0
    && order.channelFeeFen === 0
    && order.platformNetFen === 0
    && order.shopNetFen === order.paidTableFeeFen
    && typeof order.externalPaidReason === 'string'
    && !!order.externalPaidReason.trim()
    && order.externalPaidReason.length <= 200
    && order.externalPaidBy === openid
    && Number.isSafeInteger(order.externalPaidAt)
    && order.externalPaidAt >= 0
    && Number.isSafeInteger(session.checkoutAt)
    && order.externalPaidAt >= session.checkoutAt
    && session.closedAt === order.externalPaidAt;
}

exports.main = async (event = {}) => {
  const invalid = validateInput(event);
  if (invalid) return invalid;

  const { OPENID } = cloud.getWXContext();
  const orderId = event.orderId.trim();
  const reason = event.reason.trim();

  try {
    return await db.runTransaction(async (transaction) => {
      const authorizationError = await requireShopOwner(transaction, OPENID);
      if (authorizationError) return authorizationError;

      const orderRef = transaction.collection('shop_orders').doc(orderId);
      const order = await getOptional(orderRef);
      if (
        !order ||
        order._id !== orderId ||
        order.orderId !== orderId ||
        order.schemaVersion !== 2 ||
        order._openid !== OPENID ||
        order.shopId !== OPENID
      ) {
        return fail('ORDER_NOT_OWNED', 'Order is not owned by the current shop');
      }
      const isExternalPaid = order.orderStatus === 'external_paid'
        && order.paymentStatus === 'not_applicable'
        && order.splitStatus === 'not_applicable';
      const isAwaitingPayment = order.orderStatus === 'awaiting_payment'
        && order.paymentStatus === 'unpaid'
        && order.splitStatus === 'pending';
      if (!isExternalPaid && !isAwaitingPayment) {
        return fail('ORDER_STATE_INVALID', 'Order is not awaiting payment');
      }
      if (isAwaitingPayment && hasPlatformPaymentAttempt(order)) {
        return fail(
          'PLATFORM_PAYMENT_STARTED',
          'External payment is unavailable after platform payment claiming begins'
        );
      }
      if (
        typeof order.sessionId !== 'string' ||
        !order.sessionId ||
        !isBusinessId(order.storeId) ||
        !isBusinessId(order.tableId)
      ) {
        return fail('ORDER_STATE_INVALID', 'Order relationships are invalid');
      }
      if (
        order.orderId !== orderIdForSession(order.sessionId) ||
        order.outTradeNo !== outTradeNoForOrder(order.orderId) ||
        order.splitNo !== splitNoForOrder(order.orderId)
      ) {
        return fail('ORDER_STATE_INVALID', 'Order identifiers are inconsistent');
      }

      const sessionRef = transaction.collection('sessions').doc(order.sessionId);
      const session = await getOptional(sessionRef);
      const expectedSessionStatus = isExternalPaid ? 'closed' : 'awaiting_payment';
      if (!validSessionRelationship(session, order, OPENID, expectedSessionStatus)) {
        if (isExternalPaid) {
          return fail('ORDER_STATE_INVALID', 'External-paid state is inconsistent');
        }
        return fail('SESSION_STATE_INVALID', 'Session state is inconsistent');
      }

      const store = await getOptional(transaction.collection('stores').doc(order.storeId));
      if (!store || store._id !== order.storeId || store._openid !== OPENID) {
        if (isExternalPaid) {
          return fail('ORDER_STATE_INVALID', 'External-paid store relationship is inconsistent');
        }
        return fail('STORE_NOT_OWNED', 'Store is not owned by the current shop');
      }
      if (isExternalPaid) {
        if (!validExternalPaidState(order, session, OPENID)) {
          return fail('ORDER_STATE_INVALID', 'External-paid state is inconsistent');
        }
        return externalPaidResult(order);
      }
      if (!validAwaitingPaymentState(order, session, OPENID)) {
        return fail('ORDER_STATE_INVALID', 'Awaiting-payment order state is inconsistent');
      }

      const externalPaidAt = Date.now();
      if (!Number.isSafeInteger(externalPaidAt) || externalPaidAt < order.checkoutAt) {
        return fail('ORDER_STATE_INVALID', 'External payment timestamp is invalid');
      }

      const occupancyId = occupancyIdFor(order.storeId, order.tableId);
      const occupancyRef = transaction.collection('table_occupancies').doc(occupancyId);
      const occupancy = await getOptional(occupancyRef);
      const orderUpdate = {
        orderStatus: 'external_paid',
        paymentStatus: 'not_applicable',
        splitStatus: 'not_applicable',
        totalCostFen: 0,
        channelFeeFen: 0,
        platformNetFen: 0,
        shopNetFen: order.paidTableFeeFen,
        externalPaidReason: reason,
        externalPaidBy: OPENID,
        externalPaidAt,
        updatedAt: db.serverDate()
      };
      await orderRef.update({ data: orderUpdate });
      await sessionRef.update({
        data: {
          status: 'closed',
          closedAt: externalPaidAt,
          updatedAt: db.serverDate()
        }
      });
      if (
        occupancy &&
        occupancy._id === occupancyId &&
        occupancy.shopId === OPENID &&
        occupancy.storeId === order.storeId &&
        occupancy.tableId === order.tableId &&
        occupancy.sessionId === order.sessionId
      ) {
        await occupancyRef.remove();
      }

      return externalPaidResult(Object.assign({}, order, orderUpdate));
    });
  } catch (error) {
    return fail('EXTERNAL_PAID_FAILED', 'External payment could not be recorded');
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
