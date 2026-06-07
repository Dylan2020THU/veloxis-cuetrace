const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 返回当前球厅的所有会员列表（members 集合）
exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  const res = await db.collection('members').where({ _openid: OPENID }).get();
  return { members: res.data };
};
