const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 开启一张球桌的使用记录
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { tableId } = event;
  if (!tableId) return { ok: false, msg: '缺少 tableId' };

  const res = await db.collection('sessions').add({
    data: {
      _openid: OPENID,
      tableId,
      status: 'active',
      startedAt: Date.now(),
      createdAt: db.serverDate()
    }
  });
  return { ok: true, sessionId: res._id };
};
