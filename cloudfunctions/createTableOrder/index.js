const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const { calculateSettlement } = require('./lib/money');
const {
  generateCheckoutToken,
  hashCheckoutToken
} = require('./lib/checkout-token');
const {
  assertTransition,
  orderIdForSession,
  outTradeNoForOrder,
  splitNoForOrder
} = require('./lib/state');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database({ throwOnNotFound: false });
const VALID_ROLES = ['member', 'coach', 'shop'];
const RETIRED_KEYS = new Set([
  'amount',
  'durationMin',
  'storeId',
  'tableId',
  'tableName'
]);

function bindingId(openid) {
  return crypto.createHash('sha256').update('wechat:' + openid).digest('hex');
}

function fail(code, msg) {
  return { ok: false, code, msg };
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

function isRetiredKey(key) {
  return RETIRED_KEYS.has(key) || /(price|rate|cost|net)/i.test(key);
}

function validateInput(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return fail('VERSION_RETIRED', 'A trusted sessionId is required');
  }
  if (typeof event.sessionId !== 'string' || !event.sessionId.trim()) {
    return fail('VERSION_RETIRED', 'A trusted sessionId is required');
  }
  const unsupported = Object.keys(event).filter((key) => key !== 'sessionId');
  if (unsupported.some(isRetiredKey)) {
    return fail('VERSION_RETIRED', 'Client-side finance fields are retired');
  }
  if (unsupported.length) {
    return fail('INVALID_INPUT', 'Unsupported checkout input');
  }
  return null;
}

function quoteFromOrder(order) {
  return {
    orderId: order.orderId,
    sessionId: order.sessionId,
    paidTableFeeFen: order.paidTableFeeFen,
    quotedTableFeeFen: order.quotedTableFeeFen,
    tableGrossFen: order.tableGrossFen,
    tableDiscountFen: order.tableDiscountFen,
    actualDurationMs: order.actualDurationMs,
    pricePerHourFen: order.pricingSnapshot.pricePerHourFen,
    orderStatus: order.orderStatus,
    paymentStatus: order.paymentStatus,
    splitStatus: order.splitStatus
  };
}

function validPricingSnapshot(session) {
  const snapshot = session && session.pricingSnapshot;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
  const expectedKeys = [
    'tableId',
    'name',
    'pricePerHourFen',
    'pricePerHour',
    'pricingRuleVersion',
    'minimumDurationMs',
    'billingStepMs',
    'roundingMode'
  ];
  return Object.keys(snapshot).length === expectedKeys.length
    && expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(snapshot, key))
    && snapshot.tableId === session.tableId
    && typeof snapshot.name === 'string'
    && !!snapshot.name.trim()
    && Number.isSafeInteger(snapshot.pricePerHourFen)
    && snapshot.pricePerHourFen > 0
    && snapshot.pricePerHour === snapshot.pricePerHourFen / 100
    && snapshot.pricingRuleVersion === 'hourly_exact_v1'
    && snapshot.minimumDurationMs === 0
    && snapshot.billingStepMs === 1
    && snapshot.roundingMode === 'nearest_fen';
}

function pricingSnapshotsEqual(left, right) {
  if (!left || !right) return false;
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
  return Object.keys(left).length === keys.length
    && Object.keys(right).length === keys.length
    && keys.every((key) => left[key] === right[key]);
}

function calculateExactHourlyFen(elapsedMs, pricePerHourFen) {
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

function validExternalAudit(order, session, openid) {
  return typeof order.externalPaidReason === 'string'
    && !!order.externalPaidReason.trim()
    && order.externalPaidReason.length <= 200
    && order.externalPaidBy === openid
    && Number.isSafeInteger(order.externalPaidAt)
    && order.externalPaidAt >= order.checkoutAt
    && session.closedAt === order.externalPaidAt;
}

function validExistingOrder(order, session, orderId, openid) {
  if (
    order._id !== orderId ||
    order.orderId !== orderId ||
    order.sessionId !== session._id ||
    order.schemaVersion !== 2 ||
    order._openid !== openid ||
    order.shopId !== openid ||
    order.storeId !== session.storeId ||
    order.tableId !== session.tableId ||
    session.orderId !== orderId ||
    session.checkoutBy !== openid ||
    order.payerOpenid !== '' ||
    order.outTradeNo !== outTradeNoForOrder(orderId) ||
    order.splitNo !== splitNoForOrder(orderId) ||
    !validPricingSnapshot(session) ||
    !pricingSnapshotsEqual(order.pricingSnapshot, session.pricingSnapshot) ||
    order.tableName !== session.pricingSnapshot.name ||
    order.startedAt !== session.startedAt ||
    order.checkoutAt !== session.checkoutAt ||
    !Number.isSafeInteger(order.startedAt) ||
    order.startedAt < 0 ||
    !Number.isSafeInteger(order.checkoutAt) ||
    order.checkoutAt < order.startedAt
  ) {
    return false;
  }

  const elapsedMs = Math.max(0, order.checkoutAt - order.startedAt);
  const tableGrossFen = calculateExactHourlyFen(
    elapsedMs,
    order.pricingSnapshot.pricePerHourFen
  );
  if (
    tableGrossFen === null ||
    order.actualDurationMs !== elapsedMs ||
    order.billedDurationMs !== elapsedMs ||
    order.tableGrossFen !== tableGrossFen ||
    order.tableDiscountFen !== 0 ||
    order.quotedTableFeeFen !== tableGrossFen ||
    order.paidTableFeeFen !== tableGrossFen ||
    !/^[0-9a-f]{64}$/.test(order.checkoutTokenHash) ||
    order.billingMode !== 'table_commission' ||
    order.commissionRateBps !== 500 ||
    order.includesChannelFee !== true ||
    order.policyVersion !== 'table_commission_v1' ||
    order.splitCycle !== 'T_PLUS_1' ||
    order.wechatTransactionId !== '' ||
    order.paidAt !== null ||
    order.paymentBillFeeEvidence !== null ||
    order.paymentBillDiscoveryCompletedAt !== null ||
    order.splitCompletedAt !== null ||
    order.refundedTableFeeFen !== 0 ||
    order.reversedTotalCostFen !== 0
  ) {
    return false;
  }

  if (order.orderStatus === 'awaiting_payment') {
    const settlement = calculateSettlement(tableGrossFen, null);
    return session.status === 'awaiting_payment'
      && session.closedAt === null
      && order.paymentStatus === 'unpaid'
      && order.splitStatus === 'pending'
      && order.totalCostFen === settlement.totalCostFen
      && order.channelFeeFen === null
      && order.platformNetFen === null
      && order.shopNetFen === settlement.shopNetFen;
  }

  if (order.orderStatus === 'external_paid') {
    return session.status === 'closed'
      && order.paymentStatus === 'not_applicable'
      && order.splitStatus === 'not_applicable'
      && order.totalCostFen === 0
      && order.channelFeeFen === 0
      && order.platformNetFen === 0
      && order.shopNetFen === order.paidTableFeeFen
      && validExternalAudit(order, session, openid);
  }

  return false;
}

exports.main = async (event = {}) => {
  const invalid = validateInput(event);
  if (invalid) return invalid;

  const { OPENID } = cloud.getWXContext();
  const sessionId = event.sessionId.trim();
  const orderId = orderIdForSession(sessionId);
  let checkoutToken = null;

  try {
    return await db.runTransaction(async (transaction) => {
      const authorizationError = await requireShopOwner(transaction, OPENID);
      if (authorizationError) return authorizationError;

      const sessionRef = transaction.collection('sessions').doc(sessionId);
      const session = await getOptional(sessionRef);
      if (
        !session ||
        session._id !== sessionId ||
        session.schemaVersion !== 2 ||
        session._openid !== OPENID ||
        session.shopId !== OPENID
      ) {
        return fail('SESSION_NOT_OWNED', 'Session is not owned by the current shop');
      }
      if (!isBusinessId(session.storeId) || !isBusinessId(session.tableId)) {
        return fail('SESSION_SNAPSHOT_INVALID', 'Session identifiers are invalid');
      }

      const store = await getOptional(transaction.collection('stores').doc(session.storeId));
      if (!store || store._id !== session.storeId || store._openid !== OPENID) {
        return fail('STORE_NOT_OWNED', 'Store is not owned by the current shop');
      }

      const orderRef = transaction.collection('shop_orders').doc(orderId);
      const existingOrder = await getOptional(orderRef);
      if (existingOrder) {
        if (!validExistingOrder(existingOrder, session, orderId, OPENID)) {
          return fail('ORDER_STATE_INVALID', 'Existing order state is inconsistent');
        }
        return { ok: true, quote: quoteFromOrder(existingOrder) };
      }

      if (session.status !== 'active') {
        return fail('SESSION_NOT_ACTIVE', 'Session is not active');
      }
      if (
        session.checkoutAt !== null ||
        session.closedAt !== null ||
        session.orderId !== '' ||
        session.checkoutBy !== ''
      ) {
        return fail('SESSION_STATE_INVALID', 'Active session state is inconsistent');
      }
      if (
        !Number.isSafeInteger(session.startedAt) ||
        session.startedAt < 0 ||
        !validPricingSnapshot(session)
      ) {
        return fail('SESSION_SNAPSHOT_INVALID', 'Session pricing snapshot is invalid');
      }

      const occupancyId = occupancyIdFor(session.storeId, session.tableId);
      const occupancy = await getOptional(
        transaction.collection('table_occupancies').doc(occupancyId)
      );
      if (
        !occupancy ||
        occupancy._id !== occupancyId ||
        occupancy.shopId !== OPENID ||
        occupancy.storeId !== session.storeId ||
        occupancy.tableId !== session.tableId ||
        occupancy.sessionId !== sessionId ||
        occupancy.status !== 'active'
      ) {
        return fail('OCCUPANCY_MISMATCH', 'Session occupancy guard is missing or inconsistent');
      }

      const checkoutAt = Date.now();
      const elapsedMs = checkoutAt - session.startedAt;
      const tableGrossFen = calculateExactHourlyFen(
        elapsedMs,
        session.pricingSnapshot.pricePerHourFen
      );
      if (
        !Number.isSafeInteger(elapsedMs) ||
        elapsedMs < 0 ||
        tableGrossFen === null ||
        tableGrossFen <= 0
      ) {
        return fail('SESSION_SNAPSHOT_INVALID', 'Calculated amount is outside the supported range');
      }
      const settlement = calculateSettlement(tableGrossFen, null);
      assertTransition('session', session.status, 'awaiting_payment');
      if (checkoutToken === null) checkoutToken = generateCheckoutToken();

      const order = {
        schemaVersion: 2,
        _openid: OPENID,
        shopId: OPENID,
        storeId: session.storeId,
        tableId: session.tableId,
        sessionId,
        payerOpenid: '',
        paymentProfileSnapshot: null,
        paymentClaim: null,
        prepayId: '',
        prepayExpiresAt: null,
        paymentBillFeeEvidence: null,
        paymentBillDiscoveryCompletedAt: null,
        orderId,
        outTradeNo: outTradeNoForOrder(orderId),
        splitNo: splitNoForOrder(orderId),
        tableName: session.pricingSnapshot.name,
        pricingSnapshot: Object.assign({}, session.pricingSnapshot),
        startedAt: session.startedAt,
        checkoutAt,
        actualDurationMs: elapsedMs,
        billedDurationMs: elapsedMs,
        tableGrossFen,
        tableDiscountFen: 0,
        quotedTableFeeFen: tableGrossFen,
        paidTableFeeFen: tableGrossFen,
        checkoutTokenHash: hashCheckoutToken(checkoutToken),
        billingMode: 'table_commission',
        commissionRateBps: 500,
        includesChannelFee: true,
        policyVersion: 'table_commission_v1',
        splitCycle: 'T_PLUS_1',
        totalCostFen: settlement.totalCostFen,
        channelFeeFen: null,
        platformNetFen: null,
        shopNetFen: settlement.shopNetFen,
        wechatTransactionId: '',
        paidAt: null,
        splitStatus: 'pending',
        splitCompletedAt: null,
        refundedTableFeeFen: 0,
        reversedTotalCostFen: 0,
        orderStatus: 'awaiting_payment',
        paymentStatus: 'unpaid',
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      };

      await orderRef.set({ data: order });
      await sessionRef.update({
        data: {
          status: 'awaiting_payment',
          checkoutAt,
          orderId,
          checkoutBy: OPENID,
          updatedAt: db.serverDate()
        }
      });
      return { ok: true, checkoutToken, quote: quoteFromOrder(order) };
    });
  } catch (error) {
    return fail('ORDER_CREATE_FAILED', 'Checkout order could not be created');
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
