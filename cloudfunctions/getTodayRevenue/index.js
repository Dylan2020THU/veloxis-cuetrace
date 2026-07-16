const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function bindingId(openid) {
  return crypto.createHash('sha256').update(`wechat:${openid}`).digest('hex');
}

async function getOptional(reference) {
  const result = await reference.get();
  return result && result.data ? result.data : null;
}

async function requireShopOwner(openid) {
  const userId = bindingId(openid);
  const binding = await getOptional(db.collection('wechat_bindings').doc(userId));
  if (
    !binding
    || binding._id !== userId
    || binding._openid !== openid
    || !binding.accountId
    || !binding.account
  ) return { ok: false, code: 'ACCOUNT_NOT_BOUND' };
  const [account, user] = await Promise.all([
    getOptional(db.collection('accounts').doc(binding.accountId)),
    getOptional(db.collection('users').doc(userId))
  ]);
  if (
    !account
    || account._id !== binding.accountId
    || account._openid !== openid
    || account.account !== binding.account
    || account.status !== 'active'
    || !user
    || user._id !== userId
    || user._openid !== openid
  ) return { ok: false, code: 'ACCOUNT_NOT_BOUND' };
  if (!Array.isArray(user.roles) || !user.roles.includes('shop')) {
    return { ok: false, code: 'SHOP_ROLE_REQUIRED' };
  }
  return null;
}

// 当前自然日（北京时间 UTC+8）的日期键与毫秒边界。
// schema-v2 订单按可信 checkoutAt 归日，避免云端默认 UTC 导致“今日”错位。
function todayWindowCN() {
  const cn = new Date(Date.now() + BEIJING_OFFSET_MS);
  const y = cn.getUTCFullYear();
  const m = cn.getUTCMonth() + 1;
  const d = cn.getUTCDate();
  const key = y + '-' + (m < 10 ? '0' + m : m) + '-' + (d < 10 ? '0' + d : d);
  const startMs = Date.UTC(y, m - 1, d) - BEIJING_OFFSET_MS;
  return { key, startMs, endMs: startMs + 24 * 60 * 60 * 1000 };
}

async function fetchAll(where) {
  const all = [];
  const pageSize = 100;
  let skip = 0;
  while (true) {
    const result = await db.collection('shop_orders')
      .where(where)
      .skip(skip)
      .limit(pageSize)
      .get();
    all.push(...result.data);
    if (result.data.length < pageSize) return all;
    skip += pageSize;
  }
}

function fen(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function retainedFen(order) {
  return fen(order.paidTableFeeFen);
}

function targetCostFen(retained) {
  return Number((BigInt(retained) * 500n + 5000n) / 10000n);
}

function roundYuan(value) {
  return Math.round(value * 100) / 100;
}

function orderDateKey(order) {
  if (order.schemaVersion !== 2) return order.date || '';
  if (!Number.isSafeInteger(order.checkoutAt) || order.checkoutAt < 0) return '';
  const cn = new Date(order.checkoutAt + BEIJING_OFFSET_MS);
  const y = cn.getUTCFullYear();
  const m = cn.getUTCMonth() + 1;
  const d = cn.getUTCDate();
  return y + '-' + (m < 10 ? '0' + m : m) + '-' + (d < 10 ? '0' + d : d);
}

function mergeOrders(first, second) {
  const result = [];
  const seen = new Set();
  first.concat(second).forEach((order) => {
    const identity = order._id || order.orderId || '';
    if (identity && seen.has(identity)) return;
    if (identity) seen.add(identity);
    result.push(order);
  });
  return result;
}

function summarizeOrders(orders) {
  let legacyRevenueYuan = 0;
  let platformPaidFen = 0;
  let externalPaidFen = 0;
  let shopNetTargetFen = 0;
  let totalCostFen = 0;
  let channelFeeFen = 0;
  let platformNetFen = 0;
  let manualReviewFen = 0;
  let platformOrderCount = 0;
  let externalOrderCount = 0;
  let manualReviewOrderCount = 0;
  const reasonMap = {};

  (orders || []).forEach((order) => {
    if (order.schemaVersion !== 2) {
      const amount = Number(order.amount);
      if (Number.isFinite(amount) && amount >= 0) legacyRevenueYuan += amount;
      return;
    }

    const retained = retainedFen(order);
    if (order.orderStatus === 'external_paid') {
      externalPaidFen += retained;
      externalOrderCount += 1;
      const reason = typeof order.externalPaidReason === 'string' && order.externalPaidReason.trim()
        ? order.externalPaidReason.trim()
        : '未填写';
      if (!reasonMap[reason]) reasonMap[reason] = { reason, orderCount: 0, paidFen: 0 };
      reasonMap[reason].orderCount += 1;
      reasonMap[reason].paidFen += retained;
      return;
    }

    if (order.orderStatus === 'manual_review') {
      manualReviewFen += retained;
      manualReviewOrderCount += 1;
    }

    if (
      !['complete', 'manual_review'].includes(order.orderStatus)
      || ['paid', 'partially_refunded', 'refunded'].indexOf(order.paymentStatus) === -1
    ) return;

    platformPaidFen += retained;
    shopNetTargetFen += retained - targetCostFen(retained);
    totalCostFen += fen(order.totalCostFen);
    channelFeeFen += fen(order.channelFeeFen);
    platformNetFen += fen(order.platformNetFen);
    platformOrderCount += 1;
  });

  legacyRevenueYuan = roundYuan(legacyRevenueYuan);
  const realizedFen = platformPaidFen + externalPaidFen;
  return {
    legacyRevenueYuan,
    platformPaidFen,
    externalPaidFen,
    platformCoverageBps: realizedFen
      ? Math.round(platformPaidFen * 10000 / realizedFen)
      : 0,
    shopNetTargetFen,
    totalCostFen,
    channelFeeFen,
    platformNetFen,
    manualReviewFen,
    platformOrderCount,
    externalOrderCount,
    manualReviewOrderCount,
    externalReasonDistribution: Object.keys(reasonMap).sort().map((reason) => reasonMap[reason]),
    total: roundYuan(legacyRevenueYuan + realizedFen / 100)
  };
}

// 历史记账元与新版可信订单分开返回，total 仅供旧页面按元展示。
exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  const today = todayWindowCN();
  try {
    const authorizationFailure = await requireShopOwner(OPENID);
    if (authorizationFailure) return authorizationFailure;
    const [legacyDateOrders, schema2Orders] = await Promise.all([
      fetchAll({ _openid: OPENID, date: today.key }),
      fetchAll({
        _openid: OPENID,
        schemaVersion: 2,
        checkoutAt: _.gte(today.startMs).and(_.lt(today.endMs))
      })
    ]);
    const orders = mergeOrders(legacyDateOrders, schema2Orders)
      .filter((order) => orderDateKey(order) === today.key);
    return Object.assign({ ok: true }, summarizeOrders(orders));
  } catch (_error) {
    return { ok: false, code: 'REVENUE_UNAVAILABLE' };
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
