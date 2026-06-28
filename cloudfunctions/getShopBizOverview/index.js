const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// UTC+8 日期序列（旧→新），共 days 天，含今天
function cnBase() { const n = new Date(Date.now() + 8 * 3600 * 1000); return { y: n.getUTCFullYear(), m: n.getUTCMonth(), d: n.getUTCDate() }; }
function key(y, m0, d) { const mm = m0 + 1; return y + '-' + (mm < 10 ? '0' + mm : mm) + '-' + (d < 10 ? '0' + d : d); }
function buildDates(days) { const b = cnBase(); const out = []; for (let i = days - 1; i >= 0; i--) { const dt = new Date(Date.UTC(b.y, b.m, b.d - i)); out.push(key(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate())); } return out; }

async function fetchAll(coll, where) {
  let all = [], skip = 0; const PS = 100;
  while (true) { const r = await db.collection(coll).where(where).skip(skip).limit(PS).get(); all = all.concat(r.data); if (r.data.length < PS) break; skip += PS; }
  return all;
}

// 店主端经营数据看板：今日快照 + 近 rangeDays 天关键数 + 营收按天趋势
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const days = (event && event.rangeDays) === 30 ? 30 : 7;
  const dates = buildDates(days);
  const fromKey = dates[0], todayKey = dates[dates.length - 1];
  const inR = (dk) => dk >= fromKey && dk <= todayKey;
  const dateRange = _.gte(fromKey).and(_.lte(todayKey));

  const storesRes = await db.collection('stores').where({ _openid: OPENID }).get();
  const storeIds = storesRes.data.map((s) => s._id);
  const links = await db.collection('shop_coach_links').where({ shopOpenid: OPENID, status: 'active' }).get();
  const coachOpenids = links.data.map((l) => l.coachOpenid);

  // 营收 / 开台
  const orders = await fetchAll('shop_orders', { _openid: OPENID, date: dateRange });
  const byDay = {}; let revenue = 0, opens = 0, todayRevenue = 0, todayOpens = 0;
  orders.forEach((o) => {
    if (!inR(o.date)) return;
    const a = Number(o.amount) || 0;
    revenue += a; opens += 1; byDay[o.date] = (byDay[o.date] || 0) + a;
    if (o.date === todayKey) { todayRevenue += a; todayOpens += 1; }
  });
  const trend = dates.map((d) => ({ date: d, revenue: Math.round(byDay[d] || 0) }));

  // 活跃会员（本店门店训练记录的去重 _openid）
  const memSet = {}, memTodaySet = {};
  if (storeIds.length) {
    const sess = await fetchAll('training_sessions', { hallId: _.in(storeIds), date: dateRange });
    sess.forEach((s) => { if (!inR(s.date)) return; memSet[s._openid] = 1; if (s.date === todayKey) memTodaySet[s._openid] = 1; });
  }

  // 教练课时（本店教练 ∩ 本店门店）
  let lessons = 0, todayLessons = 0;
  if (coachOpenids.length && storeIds.length) {
    const ls = await fetchAll('coach_lessons', { coachOpenid: _.in(coachOpenids), hallId: _.in(storeIds), date: dateRange });
    ls.forEach((l) => { if (!inR(l.date)) return; lessons += 1; if (l.date === todayKey) todayLessons += 1; });
  }

  return {
    today: { revenue: Math.round(todayRevenue), opens: todayOpens, activeMembers: Object.keys(memTodaySet).length, lessons: todayLessons },
    range: { revenue: Math.round(revenue), opens, activeMembers: Object.keys(memSet).length, lessons },
    trend
  };
};
