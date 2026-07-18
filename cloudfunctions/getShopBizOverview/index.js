const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function bindingId(openid) { return crypto.createHash('sha256').update(`wechat:${openid}`).digest('hex'); }
async function getOptional(reference) { const result = await reference.get(); return result && result.data ? result.data : null; }
async function requireShopOwner(openid) {
  const userId = bindingId(openid);
  const binding = await getOptional(db.collection('wechat_bindings').doc(userId));
  if (!binding || binding._id !== userId || binding._openid !== openid || !binding.accountId || !binding.account) {
    return { ok: false, code: 'ACCOUNT_NOT_BOUND' };
  }
  const [account, user] = await Promise.all([
    getOptional(db.collection('accounts').doc(binding.accountId)),
    getOptional(db.collection('users').doc(userId))
  ]);
  if (!account || account._id !== binding.accountId || account._openid !== openid || account.account !== binding.account || account.status !== 'active' || !user || user._id !== userId || user._openid !== openid) {
    return { ok: false, code: 'ACCOUNT_NOT_BOUND' };
  }
  if (!Array.isArray(user.roles) || !user.roles.includes('shop')) return { ok: false, code: 'SHOP_ROLE_REQUIRED' };
  return null;
}

// UTC+8 日期序列（旧→新），共 days 天，含今天
function cnBase() { const n = new Date(Date.now() + 8 * 3600 * 1000); return { y: n.getUTCFullYear(), m: n.getUTCMonth(), d: n.getUTCDate() }; }
function key(y, m0, d) { const mm = m0 + 1; return y + '-' + (mm < 10 ? '0' + mm : mm) + '-' + (d < 10 ? '0' + d : d); }
function buildDates(days) { const b = cnBase(); const out = []; for (let i = days - 1; i >= 0; i--) { const dt = new Date(Date.UTC(b.y, b.m, b.d - i)); out.push(key(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate())); } return out; }
function cnKeyStartMs(dateKey) { const p = dateKey.split('-').map(Number); return Date.UTC(p[0], p[1] - 1, p[2]) - BEIJING_OFFSET_MS; }

async function fetchAll(coll, where) {
  let all = [], skip = 0; const PS = 100;
  while (true) { const r = await db.collection(coll).where(where).skip(skip).limit(PS).get(); all = all.concat(r.data); if (r.data.length < PS) break; skip += PS; }
  return all;
}

function fen(value) { return Number.isSafeInteger(value) && value >= 0 ? value : 0; }
function retainedFen(order) { return fen(order.paidTableFeeFen); }
function targetCostFen(retained) { return Number((BigInt(retained) * 500n + 5000n) / 10000n); }
function roundYuan(value) { return Math.round(value * 100) / 100; }

function orderDateKey(order) {
  if (order.schemaVersion !== 2) return order.date || '';
  if (!Number.isSafeInteger(order.checkoutAt) || order.checkoutAt < 0) return '';
  const cn = new Date(order.checkoutAt + BEIJING_OFFSET_MS);
  return key(cn.getUTCFullYear(), cn.getUTCMonth(), cn.getUTCDate());
}

function mergeOrders(first, second) {
  const result = [], seen = new Set();
  first.concat(second).forEach((order) => {
    const identity = order._id || order.orderId || '';
    if (identity && seen.has(identity)) return;
    if (identity) seen.add(identity);
    result.push(order);
  });
  return result;
}

function summarizeOrders(orders) {
  let legacyRevenueYuan = 0, platformPaidFen = 0, externalPaidFen = 0;
  let shopNetTargetFen = 0, totalCostFen = 0, channelFeeFen = 0, platformNetFen = 0;
  let manualReviewFen = 0, legacyOrderCount = 0, platformOrderCount = 0, externalOrderCount = 0, manualReviewOrderCount = 0;
  const reasonMap = {};

  (orders || []).forEach((order) => {
    if (order.schemaVersion !== 2) {
      const amount = Number(order.amount);
      if (Number.isFinite(amount) && amount >= 0) {
        legacyRevenueYuan += amount;
        legacyOrderCount += 1;
      }
      return;
    }
    const retained = retainedFen(order);
    if (order.orderStatus === 'external_paid') {
      externalPaidFen += retained; externalOrderCount += 1;
      const reason = typeof order.externalPaidReason === 'string' && order.externalPaidReason.trim()
        ? order.externalPaidReason.trim() : '未填写';
      if (!reasonMap[reason]) reasonMap[reason] = { reason, orderCount: 0, paidFen: 0 };
      reasonMap[reason].orderCount += 1; reasonMap[reason].paidFen += retained;
      return;
    }
    if (order.orderStatus === 'manual_review') {
      manualReviewFen += retained; manualReviewOrderCount += 1;
    }
    if (['complete', 'manual_review'].indexOf(order.orderStatus) === -1 || ['paid', 'partially_refunded', 'refunded'].indexOf(order.paymentStatus) === -1) return;
    platformPaidFen += retained;
    shopNetTargetFen += retained - targetCostFen(retained)
      + fen(order.retainedCouponSubsidyFen);
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
    platformCoverageBps: realizedFen ? Math.round(platformPaidFen * 10000 / realizedFen) : 0,
    shopNetTargetFen,
    totalCostFen,
    channelFeeFen,
    platformNetFen,
    manualReviewFen,
    legacyOrderCount,
    platformOrderCount,
    externalOrderCount,
    manualReviewOrderCount,
    externalReasonDistribution: Object.keys(reasonMap).sort().map((reason) => reasonMap[reason]),
    total: roundYuan(legacyRevenueYuan + realizedFen / 100)
  };
}

// 店主端经营数据看板：今日快照 + 近 rangeDays 天关键数 + 营收按天趋势
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const authorizationFailure = await requireShopOwner(OPENID);
  if (authorizationFailure) return authorizationFailure;
  const days = (event && event.rangeDays) === 30 ? 30 : 7;
  const dates = buildDates(days);
  const fromKey = dates[0], todayKey = dates[dates.length - 1];
  const inR = (dk) => dk >= fromKey && dk <= todayKey;
  const dateRange = _.gte(fromKey).and(_.lte(todayKey));
  const checkoutFromMs = cnKeyStartMs(fromKey);
  const checkoutEndMs = cnKeyStartMs(todayKey) + 24 * 60 * 60 * 1000;

  const storesRes = await db.collection('stores').where({ _openid: OPENID }).get();
  const storeIds = storesRes.data.map((s) => s._id);
  const links = await db.collection('shop_coach_links').where({ shopOpenid: OPENID, status: 'active' }).get();
  const coachOpenids = links.data.map((l) => l.coachOpenid);

  // 历史记账（元）与新版可信订单（分）严格分开；awaiting_payment 不计入实收。
  const [legacyDateOrders, schema2Orders] = await Promise.all([
    fetchAll('shop_orders', { _openid: OPENID, date: dateRange }),
    fetchAll('shop_orders', {
      _openid: OPENID,
      schemaVersion: 2,
      checkoutAt: _.gte(checkoutFromMs).and(_.lt(checkoutEndMs))
    })
  ]);
  const rangeOrders = [], ordersByDate = {};
  mergeOrders(legacyDateOrders, schema2Orders).forEach((order) => {
    const date = orderDateKey(order);
    if (!inR(date)) return;
    rangeOrders.push(order);
    if (!ordersByDate[date]) ordersByDate[date] = [];
    ordersByDate[date].push(order);
  });
  const todayOrders = ordersByDate[todayKey] || [];
  const rangeReport = summarizeOrders(rangeOrders);
  const todayReport = summarizeOrders(todayOrders);
  const opensFor = (report) => report.legacyOrderCount + report.platformOrderCount + report.externalOrderCount;
  const trend = dates.map((date) => {
    const report = summarizeOrders(ordersByDate[date] || []);
    return Object.assign({ date, revenue: report.total }, report);
  });

  // 活跃会员（本店门店训练记录的去重 _openid）
  const memSet = {}, memTodaySet = {};
  if (storeIds.length) {
    const sess = await fetchAll('training_sessions', { hallId: _.in(storeIds), date: dateRange });
    sess.forEach((s) => {
      if (!inR(s.date)) return;
      // 只数会员：排除店主自己与本店教练在店内的训练记录
      if (s._openid === OPENID || coachOpenids.indexOf(s._openid) !== -1) return;
      memSet[s._openid] = 1; if (s.date === todayKey) memTodaySet[s._openid] = 1;
    });
  }

  // 教练课时（本店教练 ∩ 本店门店）
  let lessons = 0, todayLessons = 0;
  if (coachOpenids.length && storeIds.length) {
    const ls = await fetchAll('coach_lessons', { coachOpenid: _.in(coachOpenids), hallId: _.in(storeIds), date: dateRange });
    ls.forEach((l) => { if (!inR(l.date)) return; lessons += 1; if (l.date === todayKey) todayLessons += 1; });
  }

  return {
    today: Object.assign({}, todayReport, {
      revenue: todayReport.total,
      opens: opensFor(todayReport),
      activeMembers: Object.keys(memTodaySet).length,
      lessons: todayLessons
    }),
    range: Object.assign({}, rangeReport, {
      revenue: rangeReport.total,
      opens: opensFor(rangeReport),
      activeMembers: Object.keys(memSet).length,
      lessons
    }),
    trend
  };
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
