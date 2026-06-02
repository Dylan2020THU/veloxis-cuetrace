const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

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

// 返回某一天的训练明细记录。默认本人；教练可传 targetOpenid 查看已绑定会员。
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { dateKey, targetOpenid } = event;

  const queryOpenid = await resolveTargetOpenid(OPENID, targetOpenid);

  const res = await db
    .collection('training_sessions')
    .where({ _openid: queryOpenid, date: dateKey })
    .orderBy('startTime', 'asc')
    .get();

  return { sessions: res.data };
};
