const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

function levelFromMinutes(totalMinutes) {
  if (!totalMinutes || totalMinutes <= 0) return 0;
  const hours = totalMinutes / 60;
  if (hours <= 3) return 1;
  if (hours <= 8) return 2;
  return 3;
}

// 店家是否可查看某会员：本店管理的教练中，有人给该会员上过课即可
async function shopCanViewMember(shopOpenid, memberOpenid) {
  const shopCoaches = await db
    .collection('shop_coach_links')
    .where({ shopOpenid, status: 'active' })
    .get();
  const coachOpenids = shopCoaches.data.map((l) => l.coachOpenid);
  if (!coachOpenids.length) return false;
  const taught = await db
    .collection('coach_member_links')
    .where({ coachOpenid: _.in(coachOpenids), memberOpenid, status: 'active' })
    .get();
  return taught.data.length > 0;
}

// 校验：当 targetOpenid 与本人不同时，需满足以下任一授权：
// 1) 教练查看自己绑定的会员；2) 店家查看本店教练上过课的会员
async function resolveTargetOpenid(myOpenid, targetOpenid) {
  if (!targetOpenid || targetOpenid === myOpenid) return myOpenid;
  const link = await db
    .collection('coach_member_links')
    .where({ coachOpenid: myOpenid, memberOpenid: targetOpenid, status: 'active' })
    .get();
  if (link.data.length) return targetOpenid;
  if (await shopCanViewMember(myOpenid, targetOpenid)) return targetOpenid;
  throw new Error('无权查看该会员数据');
}

// 聚合用户在 [startKey, endKey] 区间内每一天的训练统计。
// 默认查询本人；教练可传 targetOpenid 查看已绑定会员。
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { startKey, endKey, targetOpenid } = event;

  const isSelf = !targetOpenid || targetOpenid === OPENID;
  const queryOpenid = await resolveTargetOpenid(OPENID, targetOpenid);

  let all = [];
  const pageSize = 1000;
  let skip = 0;
  // 训练记录可能较多，分页拉全
  while (true) {
    const res = await db
      .collection('training_sessions')
      .where({ _openid: queryOpenid, date: _.gte(startKey).and(_.lte(endKey)) })
      .field({ date: true, durationMinutes: true, verified: true })
      .skip(skip)
      .limit(pageSize)
      .get();
    all = all.concat(res.data);
    if (res.data.length < pageSize) break;
    skip += pageSize;
  }

  const map = {};
  all.forEach((s) => {
    if (!map[s.date]) map[s.date] = { date: s.date, totalMinutes: 0, sessionCount: 0, personalMinutes: 0, coachMinutes: 0, verifiedCount: 0, unverifiedCount: 0 };
    map[s.date].totalMinutes += s.durationMinutes || 0;
    map[s.date].personalMinutes += s.durationMinutes || 0;
    map[s.date].sessionCount += 1;
    if (s.verified) map[s.date].verifiedCount += 1;
    else map[s.date].unverifiedCount += 1;
  });

  if (isSelf) {
    let lessons = [];
    skip = 0;
    while (true) {
      const res = await db
        .collection('coach_lessons')
        .where({ coachOpenid: OPENID, date: _.gte(startKey).and(_.lte(endKey)) })
        .field({ date: true, durationMinutes: true, verified: true })
        .skip(skip)
        .limit(pageSize)
        .get();
      lessons = lessons.concat(res.data);
      if (res.data.length < pageSize) break;
      skip += pageSize;
    }
    lessons.forEach((l) => {
      if (!map[l.date]) map[l.date] = { date: l.date, totalMinutes: 0, sessionCount: 0, personalMinutes: 0, coachMinutes: 0, verifiedCount: 0, unverifiedCount: 0 };
      map[l.date].totalMinutes += l.durationMinutes || 0;
      map[l.date].coachMinutes += l.durationMinutes || 0;
      map[l.date].sessionCount += 1;
      if (l.verified !== false) map[l.date].verifiedCount += 1;
      else map[l.date].unverifiedCount += 1;
    });
  }

  const stats = Object.keys(map).map((k) => {
    const item = map[k];
    item.level = levelFromMinutes(item.totalMinutes);
    item.hasVerified = item.verifiedCount > 0;
    item.kind = item.coachMinutes > 0 ? 'coach' : 'personal';
    return item;
  });

  return { stats };
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
