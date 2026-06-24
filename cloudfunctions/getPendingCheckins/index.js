const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 前台：拉取本店待确认的到店请求队列
exports.main = async (event) => {
  const { storeId } = event || {};
  const where = { status: 'pending' };
  if (storeId) where.storeId = storeId;
  const res = await db.collection('checkin_requests')
    .where(where)
    .orderBy('createdAt', 'asc')
    .limit(100)
    .get();
  return { ok: true, requests: res.data || [] };
};
