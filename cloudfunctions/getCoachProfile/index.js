const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 返回当前用户的教练资料（不存在则返回 null）
exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  const res = await db.collection('coaches').where({ _openid: OPENID }).get();
  return { profile: res.data.length ? res.data[0] : null };
};
