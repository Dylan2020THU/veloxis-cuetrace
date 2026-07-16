const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

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
  const res = await db.collection('bookings').add({ data });

  return { ok: true, id: res._id };
};

const { guardClientRequest } = require('./lib/auth/protocol-guard');
const protocolGuardedMain = exports.main;

exports.main = async (event = {}, ...args) => {
  const gate = await guardClientRequest({
    db,
    event,
    supportedSchemaVersions: [1]
  });
  if (!gate.ok) return gate;
  let businessEvent = event;
  if (Object.prototype.hasOwnProperty.call(event, 'authProtocol')) {
    businessEvent = { ...event };
    delete businessEvent.authProtocol;
  }
  return protocolGuardedMain(businessEvent, ...args);
};
