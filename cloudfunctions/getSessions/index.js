const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 返回当前球厅的所有使用记录（sessions 集合）
exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  const res = await db.collection('sessions').where({ _openid: OPENID }).get();
  return { sessions: res.data };
};
