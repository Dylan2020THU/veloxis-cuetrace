const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 返回当前用户关注的作者 openid 列表
exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  const res = await db.collection('user_follows').where({ _openid: OPENID }).get();
  return { follows: res.data.map((f) => f.authorOpenid) };
};
