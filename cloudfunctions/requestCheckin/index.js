'use strict';

const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database({ throwOnNotFound: false });
const VALID_ROLES = ['member', 'coach', 'shop'];
const CHECKIN_ROLES = ['member', 'coach'];
const ALLOWED_KEYS = new Set([
  'storeId',
  'tableId',
  'nickname',
  'avatar',
  'role',
  'ready'
]);

function fail(code, msg) {
  return { ok: false, code, msg };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function bindingId(openid) {
  return sha256('wechat:' + openid);
}

function checkinSlotId(storeId, tableId, role) {
  return sha256(`checkin-slot\0${storeId}\0${tableId}\0${role}`);
}

function occupancyIdFor(storeId, tableId) {
  return String(storeId.length) + '_' + storeId + '__' + tableId;
}

function isBusinessId(value) {
  return typeof value === 'string'
    && /^[0-9A-Za-z_-]{1,64}$/.test(value)
    && value.indexOf('__') === -1;
}

function isOpenid(value) {
  return typeof value === 'string' && /^[0-9A-Za-z_-]{1,128}$/.test(value);
}

function isDisplayString(value, maxLength) {
  return typeof value === 'string'
    && Array.from(value).length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validateInput(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return fail('INVALID_INPUT', 'Input must be an object');
  }
  const keys = Object.keys(event);
  if (keys.length !== ALLOWED_KEYS.size || keys.some((key) => !ALLOWED_KEYS.has(key))) {
    return fail('INVALID_INPUT', 'Check-in input is incomplete or unsupported');
  }
  if (!isBusinessId(event.storeId) || !isBusinessId(event.tableId)) {
    return fail('INVALID_INPUT', 'storeId and tableId are invalid');
  }
  if (CHECKIN_ROLES.indexOf(event.role) === -1 || typeof event.ready !== 'boolean') {
    return fail('INVALID_INPUT', 'role and ready are invalid');
  }
  if (!isDisplayString(event.nickname, 40) || !isDisplayString(event.avatar, 512)) {
    return fail('INVALID_INPUT', 'nickname or avatar is invalid');
  }
  return null;
}

async function getOptional(ref) {
  const result = await ref.get();
  return result && result.data ? result.data : null;
}

async function requireActiveRole(source, openid, requestedRole) {
  const userId = bindingId(openid);
  const binding = await getOptional(source.collection('wechat_bindings').doc(userId));
  if (
    !binding
    || binding._id !== userId
    || binding._openid !== openid
    || !isBusinessId(binding.accountId)
    || typeof binding.account !== 'string'
    || !binding.account
  ) {
    return { error: fail('ACCOUNT_NOT_BOUND', 'Account binding is incomplete') };
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
    return { error: fail('ACCOUNT_NOT_BOUND', 'Account binding is incomplete') };
  }

  const roles = Array.isArray(user.roles)
    ? user.roles.filter((role) => VALID_ROLES.indexOf(role) !== -1)
    : [];
  if (roles.indexOf(requestedRole) === -1 || user.currentRole !== requestedRole) {
    return { error: fail('ROLE_MISMATCH', 'The active role does not match the check-in role') };
  }
  return { userId, roles, currentRole: user.currentRole };
}

function findTable(store, tableId) {
  if (!store || !Array.isArray(store.tableTypes)) return null;
  return store.tableTypes.find((table) => (
    table
    && typeof table === 'object'
    && table.tableId === tableId
  )) || null;
}

function isCommonRequest(request, expected) {
  return !!request
    && request._id === expected.requestId
    && request.schemaVersion === 2
    && request.slotId === expected.slotId
    && request.memberOpenid === expected.memberOpenid
    && request.storeId === expected.storeId
    && request.tableId === expected.tableId
    && request.role === expected.role
    && typeof request.ready === 'boolean'
    && Number.isSafeInteger(request.joinedAt)
    && request.joinedAt >= 0
    && isDisplayString(request.nickname, 40)
    && isDisplayString(request.avatar, 512);
}

function isPendingRequest(request, expected) {
  return isCommonRequest(request, expected)
    && request.status === 'pending'
    && request.sessionId === ''
    && request.boundAt === null
    && (
      (request.ready === false && request.readyAt === null)
      || (request.ready === true && Number.isSafeInteger(request.readyAt) && request.readyAt >= request.joinedAt)
    );
}

function isTerminalRequest(request, expected, status, slot) {
  if (!isCommonRequest(request, expected) || request.status !== status) return false;
  if (status === 'confirmed') {
    return request.ready === true
      && typeof request.sessionId === 'string'
      && request.sessionId !== ''
      && request.sessionId === slot.sessionId
      && Number.isSafeInteger(request.boundAt)
      && request.boundAt === slot.boundAt;
  }
  return status === 'rejected'
    && request.sessionId === ''
    && request.boundAt === null;
}

function isSlotShape(slot, expected) {
  return !!slot
    && slot._id === expected.slotId
    && slot.schemaVersion === 1
    && slot.storeId === expected.storeId
    && slot.tableId === expected.tableId
    && slot.role === expected.role
    && /^ci_[0-9a-f]{32}$/.test(String(slot.currentRequestId || ''))
    && isOpenid(slot.memberOpenid)
    && ['pending', 'confirmed', 'rejected'].indexOf(slot.status) !== -1;
}

function freshRequest(event, openid, slotId, requestId, store, table, now) {
  return {
    schemaVersion: 2,
    slotId,
    memberOpenid: openid,
    storeId: event.storeId,
    storeName: typeof store.name === 'string' ? store.name : '',
    tableId: event.tableId,
    tableName: typeof table.name === 'string' ? table.name : '',
    nickname: event.nickname,
    avatar: event.avatar,
    role: event.role,
    ready: event.ready,
    joinedAt: now,
    readyAt: event.ready ? now : null,
    status: 'pending',
    sessionId: '',
    boundAt: null,
    resolvedAt: null,
    createdAt: now,
    updatedAt: db.serverDate()
  };
}

function freshSlot(event, openid, requestId) {
  return {
    schemaVersion: 1,
    storeId: event.storeId,
    tableId: event.tableId,
    role: event.role,
    currentRequestId: requestId,
    memberOpenid: openid,
    status: 'pending',
    sessionId: '',
    boundAt: null,
    updatedAt: db.serverDate()
  };
}

async function createPendingRequest(transaction, event, openid, slotRef, slotId, store, table, now) {
  const requestId = 'ci_' + crypto.randomBytes(16).toString('hex');
  const requestRef = transaction.collection('checkin_requests').doc(requestId);
  if (await getOptional(requestRef)) {
    return fail('REQUEST_ID_COLLISION', 'Unable to allocate a check-in request');
  }
  await requestRef.set({
    data: freshRequest(event, openid, slotId, requestId, store, table, now)
  });
  await slotRef.set({ data: freshSlot(event, openid, requestId) });
  return { ok: true, status: 'pending' };
}

exports.main = async (event = {}) => {
  const inputError = validateInput(event);
  if (inputError) return inputError;

  const { OPENID } = cloud.getWXContext();
  if (!isOpenid(OPENID)) return fail('ACCOUNT_NOT_BOUND', 'Account binding is incomplete');
  const now = Date.now();

  try {
    return await db.runTransaction(async (transaction) => {
      const identity = await requireActiveRole(transaction, OPENID, event.role);
      if (identity.error) return identity.error;

      const store = await getOptional(transaction.collection('stores').doc(event.storeId));
      if (!store || store._id !== event.storeId) {
        return fail('STORE_NOT_FOUND', 'Store does not exist');
      }
      const table = findTable(store, event.tableId);
      if (!table) return fail('TABLE_NOT_FOUND', 'Table does not exist in this store');

      const occupancy = await getOptional(
        transaction.collection('table_occupancies').doc(
          occupancyIdFor(event.storeId, event.tableId)
        )
      );
      if (occupancy) return fail('TABLE_OCCUPIED', 'The table already has an active session');

      const slotId = checkinSlotId(event.storeId, event.tableId, event.role);
      const slotRef = transaction.collection('table_checkin_slots').doc(slotId);
      const slot = await getOptional(slotRef);
      if (!slot) {
        return createPendingRequest(
          transaction,
          event,
          OPENID,
          slotRef,
          slotId,
          store,
          table,
          now
        );
      }

      const expected = {
        slotId,
        storeId: event.storeId,
        tableId: event.tableId,
        role: event.role,
        requestId: slot.currentRequestId,
        memberOpenid: slot.memberOpenid
      };
      if (!isSlotShape(slot, expected)) {
        return fail('CHECKIN_SLOT_STATE_INVALID', 'Check-in slot state is invalid');
      }

      const requestRef = transaction.collection('checkin_requests').doc(slot.currentRequestId);
      const request = await getOptional(requestRef);
      if (slot.status === 'pending') {
        if (slot.sessionId !== '' || slot.boundAt !== null || !isPendingRequest(request, expected)) {
          return fail('CHECKIN_SLOT_STATE_INVALID', 'Check-in slot state is invalid');
        }
        if (slot.memberOpenid !== OPENID) {
          return fail('TABLE_CHECKIN_SLOT_OCCUPIED', 'Another account is using this check-in slot');
        }
        const ready = request.ready || event.ready;
        const readyAt = request.ready
          ? request.readyAt
          : (event.ready ? now : null);
        await requestRef.update({
          data: {
            nickname: event.nickname,
            avatar: event.avatar,
            ready,
            readyAt,
            updatedAt: db.serverDate()
          }
        });
        await slotRef.update({ data: { updatedAt: db.serverDate() } });
        return { ok: true, status: 'pending' };
      }

      if (!isTerminalRequest(request, expected, slot.status, slot)) {
        return fail('CHECKIN_SLOT_STATE_INVALID', 'Check-in slot state is invalid');
      }
      return createPendingRequest(
        transaction,
        event,
        OPENID,
        slotRef,
        slotId,
        store,
        table,
        now
      );
    });
  } catch (error) {
    return fail('CHECKIN_REQUEST_FAILED', 'Unable to submit the check-in request');
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
