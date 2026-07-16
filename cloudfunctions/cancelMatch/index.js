const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 删除我发布的约球邀约（仅本人）
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { id } = event;
  if (!id) return { ok: false, msg: '缺少邀约 ID' };

  await db
    .collection('matches')
    .where({ _id: id, _openid: OPENID })
    .remove();

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
