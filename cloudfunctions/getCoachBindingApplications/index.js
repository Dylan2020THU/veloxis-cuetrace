const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const status = event.status || 'pending';
  const query = { shopOpenid: OPENID };
  if (status !== 'all') query.status = status;

  const res = await db
    .collection('coach_shop_applications')
    .where(query)
    .orderBy('updatedAt', 'desc')
    .limit(100)
    .get()
    .catch(() => ({ data: [] }));

  return { ok: true, applications: res.data || [] };
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
