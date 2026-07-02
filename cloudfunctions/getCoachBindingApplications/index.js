const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const status = event.status || 'pending';
  const query = { shopOpenid: OPENID };
  if (status !== 'all') query.status = status;

  const res = await db
    .collection('coach_shop_applications')
    .where(query)
    .orderBy('updatedAt', 'desc')
    .limit(100)
    .get()
    .catch(() => ({ data: [] }));

  return { ok: true, applications: res.data || [] };
};
