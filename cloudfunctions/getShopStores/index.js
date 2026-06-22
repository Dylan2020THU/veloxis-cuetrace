const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  const res = await db.collection('stores').where({ _openid: OPENID }).get();
  return { ok: true, stores: res.data || [] };
};
