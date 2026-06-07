const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 结账离桌：关闭一张球桌的使用记录
exports.main = async (event) => {
  const { sessionId } = event;
  if (!sessionId) return { ok: false, msg: '缺少 sessionId' };

  await db.collection('sessions').doc(sessionId).update({
    data: {
      status: 'closed',
      closedAt: Date.now()
    }
  });
  return { ok: true };
};
