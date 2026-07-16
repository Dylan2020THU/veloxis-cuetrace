const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async (event) => {
  const { targetOpenid } = event;
  if (!targetOpenid) return { ok: false, msg: '缺少 targetOpenid' };

  try {
    const res = await db.collection('members').where({ _openid: targetOpenid }).get();
    return { ok: true, member: res.data.length ? res.data[0] : null };
  } catch (err) {
    console.error('getMemberProfile failed', err);
    return { ok: true, member: null };
  }
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
