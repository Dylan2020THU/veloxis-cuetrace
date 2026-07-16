const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

// 我的预约列表（排除已取消）
exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  const res = await db
    .collection('bookings')
    .where({ _openid: OPENID, status: _.neq('cancelled') })
    .orderBy('createdAt', 'desc')
    .limit(100)
    .get();
  return { ok: true, bookings: res.data || [] };
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
