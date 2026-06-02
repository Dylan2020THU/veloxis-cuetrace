const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 我报名的球局
exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  const res = await db
    .collection('match_joins')
    .where({ _openid: OPENID })
    .orderBy('createdAt', 'desc')
    .limit(100)
    .get();
  return { ok: true, joins: res.data || [] };
};
