'use strict';

const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database({ throwOnNotFound: false });
const VALID_ROLES = ['member', 'coach', 'shop'];
const CHECKIN_ROLES = ['member', 'coach'];
const ALLOWED_KEYS = new Set(['storeId', 'tableId']);

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
  if (
    keys.length !== ALLOWED_KEYS.size
    || keys.some((key) => !ALLOWED_KEYS.has(key))
    || !isBusinessId(event.storeId)
    || !isBusinessId(event.tableId)
  ) {
    return fail('INVALID_INPUT', 'storeId and tableId are invalid');
  }
  return null;
}

async function getOptional(ref) {
  const result = await ref.get();
  return result && result.data ? result.data : null;
}

async function requireActiveIdentity(source, openid) {
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
    ? Array.from(new Set(user.roles.filter((role) => VALID_ROLES.indexOf(role) !== -1)))
    : [];
  if (!roles.length || roles.indexOf(user.currentRole) === -1) {
    return { error: fail('ACCOUNT_NOT_BOUND', 'Account role state is invalid') };
  }
  return { roles, currentRole: user.currentRole };
}

function findTable(store, tableId) {
  if (!store || !Array.isArray(store.tableTypes)) return null;
  return store.tableTypes.find((table) => (
    table
    && typeof table === 'object'
    && table.tableId === tableId
  )) || null;
}

function expectedFor(slot, storeId, tableId, role, slotId) {
  return {
    slotId,
    storeId,
    tableId,
    role,
    requestId: slot && slot.currentRequestId,
    memberOpenid: slot && slot.memberOpenid
  };
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

function isPendingPair(slot, request, expected) {
  return slot.status === 'pending'
    && slot.sessionId === ''
    && slot.boundAt === null
    && isCommonRequest(request, expected)
    && request.status === 'pending'
    && request.sessionId === ''
    && request.boundAt === null
    && (
      (request.ready === false && request.readyAt === null)
      || (request.ready === true && Number.isSafeInteger(request.readyAt) && request.readyAt >= request.joinedAt)
    );
}

function isActiveOccupancy(occupancy, storeId, tableId, sessionId) {
  return !!occupancy
    && occupancy._id === occupancyIdFor(storeId, tableId)
    && occupancy.storeId === storeId
    && occupancy.tableId === tableId
    && occupancy.sessionId === sessionId
    && occupancy.status === 'active';
}

function isActiveBoundPair(slot, request, expected, occupancy) {
  return slot.status === 'confirmed'
    && typeof slot.sessionId === 'string'
    && slot.sessionId !== ''
    && Number.isSafeInteger(slot.boundAt)
    && isCommonRequest(request, expected)
    && request.status === 'confirmed'
    && request.ready === true
    && request.sessionId === slot.sessionId
    && request.boundAt === slot.boundAt
    && isActiveOccupancy(
      occupancy,
      expected.storeId,
      expected.tableId,
      slot.sessionId
    );
}

function isRejectedPair(slot, request, expected) {
  return slot.status === 'rejected'
    && slot.sessionId === ''
    && slot.boundAt === null
    && isCommonRequest(request, expected)
    && request.status === 'rejected'
    && request.sessionId === ''
    && request.boundAt === null;
}

function projectParticipant(request) {
  return {
    nickname: request.nickname,
    avatar: request.avatar,
    role: request.role,
    ready: request.ready
  };
}

async function readCurrentParticipant(transaction, storeId, tableId, role, occupancy) {
  const slotId = checkinSlotId(storeId, tableId, role);
  const slot = await getOptional(transaction.collection('table_checkin_slots').doc(slotId));
  if (!slot) return { participant: null };

  const expected = expectedFor(slot, storeId, tableId, role, slotId);
  if (!isSlotShape(slot, expected)) {
    return { error: fail('PARTICIPANT_STATE_INVALID', 'Participant slot state is invalid') };
  }
  const request = await getOptional(
    transaction.collection('checkin_requests').doc(slot.currentRequestId)
  );
  if (isPendingPair(slot, request, expected) || isActiveBoundPair(slot, request, expected, occupancy)) {
    return {
      participant: projectParticipant(request),
      memberOpenid: request.memberOpenid,
      role: request.role
    };
  }
  if (isRejectedPair(slot, request, expected)) return { participant: null };
  if (slot.status === 'confirmed' && isCommonRequest(request, expected)) {
    const isMatchingEvidence = request.status === 'confirmed'
      && request.ready === true
      && request.sessionId === slot.sessionId
      && request.boundAt === slot.boundAt;
    if (isMatchingEvidence) return { participant: null };
  }
  return { error: fail('PARTICIPANT_STATE_INVALID', 'Participant request state is invalid') };
}

exports.main = async (event = {}) => {
  const inputError = validateInput(event);
  if (inputError) return inputError;

  const { OPENID } = cloud.getWXContext();
  if (!isOpenid(OPENID)) return fail('ACCOUNT_NOT_BOUND', 'Account binding is incomplete');

  try {
    return await db.runTransaction(async (transaction) => {
      const identity = await requireActiveIdentity(transaction, OPENID);
      if (identity.error) return identity.error;

      const store = await getOptional(transaction.collection('stores').doc(event.storeId));
      if (!store || store._id !== event.storeId) {
        return fail('STORE_NOT_FOUND', 'Store does not exist');
      }
      if (!findTable(store, event.tableId)) {
        return fail('TABLE_NOT_FOUND', 'Table does not exist in this store');
      }

      const occupancy = await getOptional(
        transaction.collection('table_occupancies').doc(
          occupancyIdFor(event.storeId, event.tableId)
        )
      );
      const entries = [];
      for (const role of CHECKIN_ROLES) {
        const entry = await readCurrentParticipant(
          transaction,
          event.storeId,
          event.tableId,
          role,
          occupancy
        );
        if (entry.error) return entry.error;
        if (entry.participant) entries.push(entry);
      }

      const ownsStore = store._openid === OPENID && identity.roles.indexOf('shop') !== -1;
      const isCurrentParticipant = entries.some((entry) => (
        entry.memberOpenid === OPENID && identity.roles.indexOf(entry.role) !== -1
      ));
      if (!ownsStore && !isCurrentParticipant) {
        return fail('ACCESS_DENIED', 'No current access to this table');
      }
      return {
        ok: true,
        participants: entries.map((entry) => entry.participant)
      };
    });
  } catch (error) {
    return fail('PARTICIPANTS_READ_FAILED', 'Unable to read table participants');
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
