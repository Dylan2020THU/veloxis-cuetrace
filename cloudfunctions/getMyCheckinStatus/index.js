const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 球员：查询自己在某门店最近一条到店请求状态
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { storeId } = event || {};
  const where = { memberOpenid: OPENID };
  if (storeId) where.storeId = storeId;
  const res = await db.collection('checkin_requests')
    .where(where)
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();
  const status = (res.data && res.data[0] && res.data[0].status) || 'none';
  return { ok: true, status };
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
