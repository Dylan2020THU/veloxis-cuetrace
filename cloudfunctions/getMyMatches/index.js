const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 我发布的约球邀约
exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  const res = await db
    .collection('matches')
    .where({ _openid: OPENID })
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();
  return { ok: true, matches: res.data || [] };
};
