const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  const res = await db.collection('brands').where({ _openid: OPENID }).get();
  return { ok: true, brands: res.data || [] };
};
