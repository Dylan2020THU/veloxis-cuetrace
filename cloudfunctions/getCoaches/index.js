const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 约教练：拉取全部可预约教练（含个人信息与收费）
exports.main = async () => {
  const res = await db
    .collection('coaches')
    .limit(100)
    .get();
  return { ok: true, coaches: res.data || [] };
};
