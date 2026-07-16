const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async (event) => {
  const { targetOpenid } = event;
  const { OPENID } = cloud.getWXContext();
  const query = targetOpenid
    ? db.collection('training_sessions').where({ _openid: targetOpenid })
    : db.collection('training_sessions').where({ _openid: OPENID });

  try {
    const res = await query.orderBy('date', 'desc').limit(500).get();
    return { ok: true, checkins: res.data || [] };
  } catch (err) {
    console.error('getMemberCheckins failed', err);
    return { ok: true, checkins: [] };
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
