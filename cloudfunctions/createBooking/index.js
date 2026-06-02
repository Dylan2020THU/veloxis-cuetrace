const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 创建预约（约教练 / 约球桌）
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { type, targetId, targetName, hallName, datetime, note, price, bookerName } = event;

  const res = await db.collection('bookings').add({
    data: {
      _openid: OPENID,
      bookerName: bookerName || '球友',
      type: type || 'table',
      targetId: targetId || '',
      targetName: targetName || '',
      hallName: hallName || '',
      datetime: datetime || '',
      note: note || '',
      price: price || 0,
      status: 'pending',
      createdAt: db.serverDate()
    }
  });

  return { ok: true, id: res._id };
};
