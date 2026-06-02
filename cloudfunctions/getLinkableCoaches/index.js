const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 返回尚未被本店管理的教练（供"添加教练"选择）
exports.main = async () => {
  const { OPENID } = cloud.getWXContext();

  const linkRes = await db
    .collection('shop_coach_links')
    .where({ shopOpenid: OPENID, status: 'active' })
    .get();
  const linkedSet = new Set(linkRes.data.map((l) => l.coachOpenid));

  const coachRes = await db.collection('coaches').limit(100).get();
  const coaches = coachRes.data
    .filter((c) => !linkedSet.has(c._openid))
    .map((c) => Object.assign({ openid: c._openid }, c));

  return { coaches };
};
