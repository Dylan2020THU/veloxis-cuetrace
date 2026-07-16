'use strict';

const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database({ throwOnNotFound: false });
const VALID_ROLES = ['member', 'coach', 'shop'];

function fail(code, msg) {
  return { ok: false, code, msg };
}

function bindingId(openid) {
  return crypto.createHash('sha256').update('wechat:' + openid).digest('hex');
}

function isBusinessId(value) {
  return typeof value === 'string'
    && /^[0-9A-Za-z_-]{1,64}$/.test(value)
    && value.indexOf('__') === -1;
}

async function getOptional(ref) {
  const result = await ref.get();
  return result && result.data ? result.data : null;
}

async function requireShopOwner(source, openid) {
  const userId = bindingId(openid);
  const binding = await getOptional(source.collection('wechat_bindings').doc(userId));
  if (
    !binding
    || binding._id !== userId
    || binding._openid !== openid
    || !binding.accountId
    || !binding.account
  ) {
    return fail('ACCOUNT_NOT_BOUND', 'Account binding is incomplete');
  }
  const account = await getOptional(source.collection('accounts').doc(binding.accountId));
  const user = await getOptional(source.collection('users').doc(userId));
  if (
    !account
    || account._id !== binding.accountId
    || account._openid !== openid
    || account.account !== binding.account
    || account.status !== 'active'
    || !user
    || user._id !== userId
    || user._openid !== openid
  ) {
    return fail('ACCOUNT_NOT_BOUND', 'Account binding is incomplete');
  }
  const roles = Array.isArray(user.roles)
    ? user.roles.filter((role) => VALID_ROLES.indexOf(role) !== -1)
    : [];
  return roles.indexOf('shop') === -1
    ? fail('SHOP_ROLE_REQUIRED', 'An approved shop role is required')
    : null;
}

exports.main = async (event = {}) => {
  if (
    !event
    || typeof event !== 'object'
    || Array.isArray(event)
    || Object.keys(event).some((key) => key !== 'storeId')
    || !isBusinessId(event.storeId)
  ) {
    return fail('INVALID_INPUT', 'A valid storeId is required');
  }
  const { OPENID } = cloud.getWXContext();
  const authorizationError = await requireShopOwner(db, OPENID);
  if (authorizationError) return authorizationError;
  const store = await getOptional(db.collection('stores').doc(event.storeId));
  if (!store || store._id !== event.storeId || store._openid !== OPENID) {
    return fail('STORE_NOT_OWNED', 'Store is not owned by the current shop');
  }
  try {
    const result = await db.collection('checkin_requests')
      .where({ storeId: event.storeId, status: 'pending' })
      .orderBy('createdAt', 'asc')
      .limit(100)
      .get();
    const requests = result && Array.isArray(result.data)
      ? result.data.filter((item) => (
          item
          && (item.sessionId === undefined || item.sessionId === null || item.sessionId === '')
          && (item.boundAt === undefined || item.boundAt === null)
        ))
      : [];
    return { ok: true, requests };
  } catch (error) {
    return { ok: true, requests: [] };
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
