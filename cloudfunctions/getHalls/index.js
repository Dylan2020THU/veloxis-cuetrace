const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 返回台球厅列表（供新增训练记录时选择）
exports.main = async () => {
  const res = await db.collection('halls').limit(100).get();
  return { halls: res.data };
};
