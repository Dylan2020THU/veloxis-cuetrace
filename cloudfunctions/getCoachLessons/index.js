const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 教练课时列表（默认当前用户；可传 coachOpenid 由店家查看）
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const who = (event && event.coachOpenid) || OPENID;
  const res = await db.collection('coach_lessons')
    .where({ coachOpenid: who })
    .orderBy('createdAt', 'desc')
    .limit(200)
    .get();
  return { ok: true, lessons: res.data || [] };
};
