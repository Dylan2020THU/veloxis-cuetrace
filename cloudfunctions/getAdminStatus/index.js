const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

function adminId(openid) {
  return crypto.createHash('sha256').update(`admin-openid:${openid}`).digest('hex');
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const loginName = (event.loginName || '').trim();
  const id = adminId(OPENID);
  const res = await db.collection('admins').doc(id).get();
  const admin = res && res.data;
  const isAdmin = !!(
    admin &&
    admin._id === id &&
    admin._openid === OPENID &&
    admin.account === loginName &&
    admin.status === 'active'
  );
  return { ok: true, isAdmin, bootstrap: false, accountAdmin: isAdmin };
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
