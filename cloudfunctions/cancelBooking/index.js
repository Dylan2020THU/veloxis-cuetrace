const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 取消预约（仅本人可取消）
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { id } = event;
  if (!id) return { ok: false, msg: '缺少预约 ID' };

  await db
    .collection('bookings')
    .where({ _id: id, _openid: OPENID })
    .update({ data: { status: 'cancelled' } });

  return { ok: true };
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
