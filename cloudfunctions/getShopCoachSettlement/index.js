const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const commissionOf = (g) => r2((Number(g) || 0) * 0.05);

// 周期 → 日期区间（北京时间 UTC+8，含端点；all=不限）
function cnToday() { const n = new Date(Date.now() + 8 * 3600 * 1000); return { y: n.getUTCFullYear(), m: n.getUTCMonth(), d: n.getUTCDate(), dow: n.getUTCDay() }; }
function key(y, m0, d) { const mm = m0 + 1; return y + '-' + (mm < 10 ? '0' + mm : mm) + '-' + (d < 10 ? '0' + d : d); }
function periodRange(period) {
  const t = cnToday();
  const toKey = key(t.y, t.m, t.d);
  if (period === 'all') return { fromKey: '', toKey: '' };
  if (period === 'week') { const back = t.dow === 0 ? 6 : t.dow - 1; const f = new Date(Date.UTC(t.y, t.m, t.d - back)); return { fromKey: key(f.getUTCFullYear(), f.getUTCMonth(), f.getUTCDate()), toKey }; }
  return { fromKey: key(t.y, t.m, 1), toKey };
}

async function fetchLessons(where) {
  let all = []; let skip = 0; const PS = 100;
  while (true) {
    const r = await db.collection('coach_lessons').where(where).skip(skip).limit(PS).get();
    all = all.concat(r.data);
    if (r.data.length < PS) break;
    skip += PS;
  }
  return all;
}

// 店主端：本店各教练在指定周期的结算概览
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const range = periodRange((event && event.period) || 'month');

  const links = await db.collection('shop_coach_links').where({ shopOpenid: OPENID, status: 'active' }).get();
  const coachOpenids = links.data.map((l) => l.coachOpenid);
  const storesRes = await db.collection('stores').where({ _openid: OPENID }).get();
  const storeIds = storesRes.data.map((s) => s._id);
  if (!coachOpenids.length || !storeIds.length) return { totalPendingNet: 0, pendingCoachCount: 0, coaches: [] };

  const where = { coachOpenid: _.in(coachOpenids), hallId: _.in(storeIds) };
  if (range.fromKey) where.date = _.gte(range.fromKey).and(_.lte(range.toKey));
  const lessons = await fetchLessons(where);

  const coachesRes = await db.collection('coaches').where({ _openid: _.in(coachOpenids) }).get();
  const cmap = {}; coachesRes.data.forEach((c) => { cmap[c._openid] = c; });

  const agg = {};
  lessons.forEach((l) => {
    if (!agg[l.coachOpenid]) agg[l.coachOpenid] = { pendingGross: 0, pendingCount: 0, settledGross: 0 };
    const a = Number(l.amount) || 0;
    if (l.settled) agg[l.coachOpenid].settledGross += a;
    else { agg[l.coachOpenid].pendingGross += a; agg[l.coachOpenid].pendingCount += 1; }
  });

  let totalPendingNet = 0, pendingCoachCount = 0;
  const coaches = coachOpenids.map((openid) => {
    const g = agg[openid] || { pendingGross: 0, pendingCount: 0, settledGross: 0 };
    const c = cmap[openid] || {};
    const pendingCommission = commissionOf(g.pendingGross);
    const pendingNet = r2(g.pendingGross - pendingCommission);
    const settledNet = r2(g.settledGross - commissionOf(g.settledGross));
    if (g.pendingCount > 0) { totalPendingNet += pendingNet; pendingCoachCount += 1; }
    return { coachOpenid: openid, nickname: c.nickname || '教练', avatar: c.avatar || '',
      pendingCount: g.pendingCount, pendingGross: g.pendingGross, pendingCommission, pendingNet, settledNet };
  }).sort((a, b) => b.pendingNet - a.pendingNet || b.settledNet - a.settledNet);

  return { totalPendingNet: r2(totalPendingNet), pendingCoachCount, coaches };
};
