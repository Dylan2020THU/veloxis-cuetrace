const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 平台对教练课时成交的抽佣费率（低抽佣，5%），与 miniprogram/utils/billing.js 保持一致。
// 轻量实现：仅在约教练订单上标记费率，结算时按成交额收取，暂不接微信真实分账。
const COACH_COMMISSION_RATE = 0.05;

// 创建预约（约教练 / 约球桌）
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { type, targetId, targetName, hallName, datetime, note, price, bookerName } = event;

  const bookingType = type || 'table';
  const data = {
    _openid: OPENID,
    bookerName: bookerName || '球友',
    type: bookingType,
    targetId: targetId || '',
    targetName: targetName || '',
    hallName: hallName || '',
    datetime: datetime || '',
    note: note || '',
    price: price || 0,
    status: 'pending',
    createdAt: db.serverDate()
  };
  // 约教练订单：标记平台抽佣率（成交额结算时按此收取）
  if (bookingType === 'coach') {
    data.commissionRate = COACH_COMMISSION_RATE;
  }

  const res = await db.collection('bookings').add({ data });

  return { ok: true, id: res._id };
};
