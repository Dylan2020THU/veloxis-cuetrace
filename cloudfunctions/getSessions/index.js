const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database({ throwOnNotFound: false });
const VALID_ROLES = ['member', 'coach', 'shop'];

function bindingId(openid) {
  return crypto.createHash('sha256').update('wechat:' + openid).digest('hex');
}

function fail(code, msg) {
  return { ok: false, code, msg };
}

async function getOptional(ref) {
  const result = await ref.get();
  return result && result.data ? result.data : null;
}

async function authorizeShop(openid) {
  const userId = bindingId(openid);
  const binding = await getOptional(db.collection('wechat_bindings').doc(userId));
  if (
    !binding ||
    binding._id !== userId ||
    binding._openid !== openid ||
    !binding.accountId ||
    !binding.account
  ) {
    return fail('ACCOUNT_NOT_BOUND', 'Account binding is incomplete');
  }
  const account = await getOptional(db.collection('accounts').doc(binding.accountId));
  const user = await getOptional(db.collection('users').doc(userId));
  if (
    !account ||
    account._id !== binding.accountId ||
    account._openid !== openid ||
    account.account !== binding.account ||
    account.status !== 'active' ||
    !user ||
    user._id !== userId ||
    user._openid !== openid
  ) {
    return fail('ACCOUNT_NOT_BOUND', 'Account binding is incomplete');
  }
  const roles = Array.isArray(user.roles)
    ? user.roles.filter((role) => VALID_ROLES.indexOf(role) !== -1)
    : [];
  if (roles.indexOf('shop') === -1) {
    return fail('SHOP_ROLE_REQUIRED', 'An approved shop role is required');
  }
  return null;
}

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  try {
    const authorizationError = await authorizeShop(OPENID);
    if (authorizationError) return authorizationError;
    const result = await db.collection('sessions').where({ _openid: OPENID }).get();
    const sessions = (result.data || []).filter((session) => (
      session.schemaVersion !== 2 || session.shopId === OPENID
    ));
    return { ok: true, sessions };
  } catch (error) {
    return fail('SESSION_READ_FAILED', 'Sessions could not be loaded');
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
