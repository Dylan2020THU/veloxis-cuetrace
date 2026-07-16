const cloud = require('wx-server-sdk');
const { hashCheckoutToken } = require('./lib/checkout-token');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database({ throwOnNotFound: false });
const ORDER_STATUSES = new Set([
  'awaiting_payment',
  'complete',
  'external_paid',
  'canceled',
  'manual_review'
]);
const PAYMENT_STATUSES = new Set([
  'not_applicable',
  'unpaid',
  'paid',
  'partially_refunded',
  'refunded',
  'closed'
]);

function notFound() {
  return {
    ok: false,
    code: 'CHECKOUT_NOT_FOUND',
    msg: 'Checkout order was not found'
  };
}

function exactToken(event) {
  if (
    !event
    || typeof event !== 'object'
    || Array.isArray(event)
    || Object.keys(event).length !== 1
    || !Object.prototype.hasOwnProperty.call(event, 'token')
  ) {
    return null;
  }
  try {
    hashCheckoutToken(event.token);
    return event.token;
  } catch (_error) {
    return null;
  }
}

function isBusinessId(value) {
  return typeof value === 'string'
    && /^[0-9A-Za-z_-]{1,64}$/.test(value)
    && !value.includes('__');
}

function publicOrder(order, store) {
  const snapshot = order && order.pricingSnapshot;
  if (
    !order
    || order.schemaVersion !== 2
    || typeof order._id !== 'string'
    || order.orderId !== order._id
    || typeof order.checkoutTokenHash !== 'string'
    || !/^[0-9a-f]{64}$/.test(order.checkoutTokenHash)
    || !isBusinessId(order.storeId)
    || !store
    || store._id !== order.storeId
    || store._openid !== order.shopId
    || typeof store.name !== 'string'
    || !store.name.trim()
    || !snapshot
    || typeof snapshot !== 'object'
    || Array.isArray(snapshot)
    || typeof snapshot.name !== 'string'
    || !snapshot.name.trim()
    || !Number.isSafeInteger(snapshot.pricePerHourFen)
    || snapshot.pricePerHourFen <= 0
    || !Number.isSafeInteger(order.startedAt)
    || order.startedAt < 0
    || !Number.isSafeInteger(order.checkoutAt)
    || order.checkoutAt < order.startedAt
    || !Number.isSafeInteger(order.billedDurationMs)
    || order.billedDurationMs < 0
    || !Number.isSafeInteger(order.tableGrossFen)
    || order.tableGrossFen < 0
    || !Number.isSafeInteger(order.tableDiscountFen)
    || order.tableDiscountFen < 0
    || !Number.isSafeInteger(order.quotedTableFeeFen)
    || order.quotedTableFeeFen <= 0
    || order.quotedTableFeeFen !== order.tableGrossFen - order.tableDiscountFen
    || !ORDER_STATUSES.has(order.orderStatus)
    || !PAYMENT_STATUSES.has(order.paymentStatus)
  ) {
    return null;
  }

  return {
    storeName: store.name.trim(),
    tableName: snapshot.name.trim(),
    startedAt: order.startedAt,
    checkoutAt: order.checkoutAt,
    billedDurationMs: order.billedDurationMs,
    pricePerHourFen: snapshot.pricePerHourFen,
    tableGrossFen: order.tableGrossFen,
    tableDiscountFen: order.tableDiscountFen,
    quotedTableFeeFen: order.quotedTableFeeFen,
    orderStatus: order.orderStatus,
    paymentStatus: order.paymentStatus,
    canPay: order.orderStatus === 'awaiting_payment'
      && order.paymentStatus === 'unpaid'
  };
}

exports.main = async (event = {}) => {
  const token = exactToken(event);
  if (!token) return notFound();

  try {
    const checkoutTokenHash = hashCheckoutToken(token);
    const result = await db.collection('shop_orders')
      .where({ schemaVersion: 2, checkoutTokenHash })
      .limit(2)
      .get();
    const orders = result && Array.isArray(result.data) ? result.data : [];
    if (orders.length !== 1) return notFound();

    const order = orders[0];
    const storeResult = await db.collection('stores').doc(order.storeId).get();
    const orderView = publicOrder(order, storeResult && storeResult.data);
    return orderView ? { ok: true, order: orderView } : notFound();
  } catch (_error) {
    return notFound();
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
