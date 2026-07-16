const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const commissionOf = () => 0;

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

// 店主端：单个教练在指定周期的结算明细（待/已结算 + 待结算汇总）
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const coachOpenid = event && event.coachOpenid;
  const range = periodRange((event && event.period) || 'month');
  if (!coachOpenid) return { coachOpenid: '', nickname: '教练', summary: { gross: 0, commission: 0, net: 0 }, pending: [], settled: [] };

  const storesRes = await db.collection('stores').where({ _openid: OPENID }).get();
  const storeIds = storesRes.data.map((s) => s._id);
  if (!storeIds.length) return { coachOpenid, nickname: '教练', summary: { gross: 0, commission: 0, net: 0 }, pending: [], settled: [] };

  const where = { coachOpenid, hallId: _.in(storeIds) };
  if (range.fromKey) where.date = _.gte(range.fromKey).and(_.lte(range.toKey));
  const lessons = (await fetchLessons(where)).sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const pending = lessons.filter((l) => !l.settled);
  const settled = lessons.filter((l) => l.settled);
  const gross = pending.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const commission = commissionOf(gross);

  const cRes = await db.collection('coaches').where({ _openid: coachOpenid }).get();
  const nickname = (cRes.data[0] && cRes.data[0].nickname) || '教练';

  return { coachOpenid, nickname, summary: { gross, commission, net: r2(gross - commission) }, pending, settled };
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
