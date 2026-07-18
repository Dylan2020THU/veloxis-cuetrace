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

function checkinSlotId(storeId, tableId, role) {
  return crypto.createHash('sha256')
    .update(`checkin-slot\0${storeId}\0${tableId}\0${role}`)
    .digest('hex');
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
    || Object.keys(event).some((key) => key !== 'requestId' && key !== 'action')
    || !isBusinessId(event.requestId)
    || (event.action !== 'confirm' && event.action !== 'reject')
  ) {
    return fail('INVALID_INPUT', 'requestId and action are invalid');
  }
  if (event.action === 'confirm') {
    return fail('PRODUCT_RETIRED', 'Owner check-in confirmation is retired');
  }
  const { OPENID } = cloud.getWXContext();
  try {
    return await db.runTransaction(async (transaction) => {
      const authorizationError = await requireShopOwner(transaction, OPENID);
      if (authorizationError) return authorizationError;
      const requestRef = transaction.collection('checkin_requests').doc(event.requestId);
      const request = await getOptional(requestRef);
      if (!request || request._id !== event.requestId || !isBusinessId(request.storeId)) {
        return fail('CHECKIN_NOT_FOUND', 'Check-in request was not found');
      }
      const store = await getOptional(transaction.collection('stores').doc(request.storeId));
      if (!store || store._id !== request.storeId || store._openid !== OPENID) {
        return fail('STORE_NOT_OWNED', 'Store is not owned by the current shop');
      }
      if (request.status !== 'pending') {
        return fail('CHECKIN_NOT_PENDING', 'Only pending check-ins can be resolved');
      }
      if (
        (request.sessionId !== undefined && request.sessionId !== null && request.sessionId !== '')
        || (request.boundAt !== undefined && request.boundAt !== null)
      ) {
        return fail('CHECKIN_ALREADY_BOUND', 'A session-bound check-in is immutable');
      }
      if (
        (request.role !== 'member' && request.role !== 'coach')
        || typeof request.memberOpenid !== 'string'
        || !request.memberOpenid
        || !isBusinessId(request.tableId)
      ) {
        return fail('CHECKIN_STATE_INVALID', 'Check-in state is invalid');
      }
      const slotId = checkinSlotId(request.storeId, request.tableId, request.role);
      const slotRef = transaction.collection('table_checkin_slots').doc(slotId);
      const slot = await getOptional(slotRef);
      if (
        request.slotId !== slotId
        || !slot
        || slot._id !== slotId
        || slot.schemaVersion !== 1
        || slot.storeId !== request.storeId
        || slot.tableId !== request.tableId
        || slot.role !== request.role
        || slot.currentRequestId !== request._id
        || slot.memberOpenid !== request.memberOpenid
        || slot.status !== 'pending'
      ) {
        return fail('CHECKIN_SLOT_INVALID', 'Check-in slot is inconsistent');
      }
      const status = 'rejected';
      const resolvedAt = Date.now();
      await requestRef.update({
        data: {
          status,
          resolvedAt
        }
      });
      await slotRef.update({
        data: {
          status,
          sessionId: '',
          boundAt: null,
          updatedAt: db.serverDate()
        }
      });
      return { ok: true, status };
    });
  } catch (error) {
    return fail('CHECKIN_RESOLVE_FAILED', 'Check-in request could not be resolved');
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
