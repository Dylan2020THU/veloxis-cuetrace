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

// 校验：当 targetOpenid 与本人不同（教练查看会员）时，必须存在有效的师生绑定
async function resolveTargetOpenid(myOpenid, targetOpenid) {
  if (!targetOpenid || targetOpenid === myOpenid) return myOpenid;
  const link = await db
    .collection('coach_member_links')
    .where({ coachOpenid: myOpenid, memberOpenid: targetOpenid, status: 'active' })
    .get();
  if (!link.data.length) {
    throw new Error('无权查看该会员数据');
  }
  return targetOpenid;
}

// 聚合用户在 [startKey, endKey] 区间内每一天的训练统计。
// 默认查询本人；教练可传 targetOpenid 查看已绑定会员。
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { startKey, endKey, targetOpenid } = event;

  const queryOpenid = await resolveTargetOpenid(OPENID, targetOpenid);

  let all = [];
  const pageSize = 1000;
  let skip = 0;
  // 训练记录可能较多，分页拉全
  while (true) {
    const res = await db
      .collection('training_sessions')
      .where({ _openid: queryOpenid, date: _.gte(startKey).and(_.lte(endKey)) })
      .field({ date: true, durationMinutes: true })
      .skip(skip)
      .limit(pageSize)
      .get();
    all = all.concat(res.data);
    if (res.data.length < pageSize) break;
    skip += pageSize;
  }

  const map = {};
  all.forEach((s) => {
    if (!map[s.date]) map[s.date] = { date: s.date, totalMinutes: 0, sessionCount: 0 };
    map[s.date].totalMinutes += s.durationMinutes || 0;
    map[s.date].sessionCount += 1;
  });

  const stats = Object.keys(map).map((k) => {
    const item = map[k];
    item.level = levelFromMinutes(item.totalMinutes);
    return item;
  });

  return { stats };
};
