const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 约球友：拉取邀约列表（按创建时间倒序）
exports.main = async () => {
  const res = await db
    .collection('matches')
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();
  return { ok: true, matches: res.data || [] };
};
