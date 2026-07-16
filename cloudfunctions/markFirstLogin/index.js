const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const VALID_ROLES = ['member', 'coach', 'shop'];

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function bindingId(openid) {
  return sha256(`wechat:${openid}`);
}

function fail(code, msg) {
  return { ok: false, code, msg };
}

async function getDocument(collection, id) {
  const result = await db.collection(collection).doc(id).get();
  return result && result.data ? result.data : null;
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const { role } = event;
  const r = VALID_ROLES.indexOf(role) !== -1 ? role : 'member';
  const userId = bindingId(OPENID);

  const binding = await getDocument('wechat_bindings', userId);
  if (!binding || binding._id !== userId || binding._openid !== OPENID || !binding.accountId) {
    return fail('ACCOUNT_NOT_BOUND', '请先登录或注册账号');
  }

  const account = await getDocument('accounts', binding.accountId);
  if (
    !account ||
    account._id !== binding.accountId ||
    account._openid !== OPENID ||
    account.account !== binding.account ||
    account.status !== 'active'
  ) {
    return fail('ACCOUNT_NOT_BOUND', '账号绑定信息不完整');
  }

  const user = await getDocument('users', userId);
  if (!user || user._id !== userId || user._openid !== OPENID) {
    return fail('ACCOUNT_NOT_BOUND', '账号资料不存在');
  }

  const roles = Array.isArray(user.roles)
    ? user.roles.filter((item) => VALID_ROLES.indexOf(item) !== -1)
    : [];
  if (roles.indexOf(r) === -1) {
    return fail('ROLE_NOT_ALLOWED', '该账号未开通此身份');
  }

  const firstLoginAt = db.serverDate();
  const patch = {};
  if (!user.firstLoginAt) patch.firstLoginAt = firstLoginAt;
  const existingRole = user.per_role && user.per_role[r];
  if (!existingRole || !existingRole.firstLoginAt) {
    patch[`per_role.${r}.firstLoginAt`] = firstLoginAt;
  }
  if (Object.keys(patch).length) {
    await db.collection('users').doc(userId).update({ data: patch });
  }
  return { ok: true, firstLoginAt: user.firstLoginAt || firstLoginAt };
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
