'use strict';

const {
  AUTH_PROTOCOL,
  SESSION_STORAGE_KEY,
  CLIENT_INSTANCE_STORAGE_KEY,
  MIGRATION_STORAGE_KEY
} = require('../config/auth');

const VALID_ROLES = Object.freeze(['member', 'coach', 'shop']);
const SESSION_KEYS = Object.freeze([
  'schemaVersion',
  'sessionToken',
  'account',
  'accountDisplay',
  'roles',
  'currentRole'
]);
const RESERVED_ENVELOPE_KEYS = Object.freeze([
  'authProtocol',
  'clientInstanceId',
  'sessionToken',
  'action'
]);
const LEGACY_AUTH_KEYS = Object.freeze([
  'openid',
  'role',
  'dc_role',
  'dc_account_name',
  'dc_accounts',
  'dc_wechat_bindings'
]);
const CLIENT_INSTANCE_PATTERN = /^[0-9a-f]{64}$/;
const SESSION_TOKEN_PATTERN = /^v2\.[A-Z0-9_]+\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

let generation = 0;
let currentAttempt = null;

function fixedError(code) {
  const messages = {
    AUTH_INTERNAL_ERROR: '认证服务暂时不可用',
    INVALID_INPUT: '请求参数无效',
    SESSION_REQUIRED: '请先登录'
  };
  const error = new Error(messages[code] || '认证请求失败');
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isArrayBuffer(value) {
  return (
    typeof ArrayBuffer !== 'undefined'
    && value instanceof ArrayBuffer
  );
}

function bytesToHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let output = '';
  for (let index = 0; index < bytes.length; index += 1) {
    output += bytes[index].toString(16).padStart(2, '0');
  }
  return output;
}

function matchesEntire(pattern, value) {
  if (typeof value !== 'string') return false;
  const match = pattern.exec(value);
  return !!(
    match
    && match.index === 0
    && match[0].length === value.length
  );
}

function getClientInstanceId() {
  let existing;
  try {
    existing = wx.getStorageSync(CLIENT_INSTANCE_STORAGE_KEY);
  } catch (_) {
    throw fixedError('AUTH_INTERNAL_ERROR');
  }
  if (matchesEntire(CLIENT_INSTANCE_PATTERN, existing)) {
    return existing;
  }

  let randomResult;
  try {
    randomResult = wx.getRandomValues({ length: 32 });
  } catch (_) {
    throw fixedError('AUTH_INTERNAL_ERROR');
  }
  let clientInstanceId;
  try {
    const randomBuffer = isArrayBuffer(randomResult)
      ? randomResult
      : randomResult && randomResult.randomValues;
    if (!isArrayBuffer(randomBuffer) || randomBuffer.byteLength !== 32) {
      throw fixedError('AUTH_INTERNAL_ERROR');
    }
    clientInstanceId = bytesToHex(randomBuffer);
  } catch (_) {
    throw fixedError('AUTH_INTERNAL_ERROR');
  }
  try {
    wx.setStorageSync(CLIENT_INSTANCE_STORAGE_KEY, clientInstanceId);
    if (wx.getStorageSync(CLIENT_INSTANCE_STORAGE_KEY) !== clientInstanceId) {
      throw fixedError('AUTH_INTERNAL_ERROR');
    }
  } catch (_) {
    throw fixedError('AUTH_INTERNAL_ERROR');
  }
  return clientInstanceId;
}

function validSessionToken(value) {
  return matchesEntire(SESSION_TOKEN_PATTERN, value);
}

function normalizeRoles(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const roles = [];
  for (const role of value) {
    if (typeof role !== 'string' || VALID_ROLES.indexOf(role) === -1) return null;
    if (roles.indexOf(role) !== -1) return null;
    roles.push(role);
  }
  return roles;
}

function cloneSession(session) {
  return {
    schemaVersion: AUTH_PROTOCOL,
    sessionToken: session.sessionToken,
    account: session.account,
    accountDisplay: session.accountDisplay,
    roles: session.roles.slice(),
    currentRole: session.currentRole
  };
}

function sameSession(left, right) {
  return !!(
    left
    && right
    && left.schemaVersion === right.schemaVersion
    && left.sessionToken === right.sessionToken
    && left.account === right.account
    && left.accountDisplay === right.accountDisplay
    && left.currentRole === right.currentRole
    && left.roles.length === right.roles.length
    && left.roles.every((role, index) => role === right.roles[index])
  );
}

function missingStorageValue(value) {
  return value === undefined || value === null || value === '';
}

function sessionStorageSnapshot() {
  try {
    const stored = wx.getStorageSync(SESSION_STORAGE_KEY);
    if (missingStorageValue(stored)) {
      return { ok: true, session: null };
    }
    const session = validStoredSession(stored);
    return session
      ? { ok: true, session }
      : { ok: false, session: null };
  } catch (_) {
    return { ok: false, session: null };
  }
}

function restoreSessionStorage(previous) {
  try {
    if (previous) {
      wx.setStorageSync(SESSION_STORAGE_KEY, cloneSession(previous));
    } else {
      wx.removeStorageSync(SESSION_STORAGE_KEY);
    }
    const restored = sessionStorageSnapshot();
    return !!(
      restored.ok
      && (
        (previous === null && restored.session === null)
        || (previous && sameSession(previous, restored.session))
      )
    );
  } catch (_) {
    return false;
  }
}

function validStoredSession(value) {
  if (!isPlainObject(value)) return null;
  const keys = Object.getOwnPropertyNames(value);
  if (
    keys.length !== SESSION_KEYS.length
    || keys.some((key) => SESSION_KEYS.indexOf(key) === -1)
    || (
      typeof Object.getOwnPropertySymbols === 'function'
      && Object.getOwnPropertySymbols(value).length !== 0
    )
  ) {
    return null;
  }
  const roles = normalizeRoles(value.roles);
  if (
    value.schemaVersion !== AUTH_PROTOCOL
    || !validSessionToken(value.sessionToken)
    || typeof value.account !== 'string'
    || typeof value.accountDisplay !== 'string'
    || !roles
    || typeof value.currentRole !== 'string'
    || roles.indexOf(value.currentRole) === -1
  ) {
    return null;
  }
  return {
    schemaVersion: AUTH_PROTOCOL,
    sessionToken: value.sessionToken,
    account: value.account,
    accountDisplay: value.accountDisplay,
    roles,
    currentRole: value.currentRole
  };
}

function removeMalformedSession() {
  try {
    wx.removeStorageSync(SESSION_STORAGE_KEY);
  } catch (_) {}
}

function getSession() {
  let stored;
  try {
    stored = wx.getStorageSync(SESSION_STORAGE_KEY);
  } catch (_) {
    return null;
  }
  if (stored === undefined || stored === null || stored === '') return null;
  let session;
  try {
    session = validStoredSession(stored);
  } catch (_) {
    session = null;
  }
  if (!session) {
    removeMalformedSession();
    return null;
  }
  return cloneSession(session);
}

function globalData() {
  try {
    const app = typeof getApp === 'function' ? getApp() : null;
    return app && app.globalData && typeof app.globalData === 'object'
      ? app.globalData
      : null;
  } catch (_) {
    return null;
  }
}

function applyAppProjection(session) {
  const target = globalData();
  if (!target) return;
  target.account = session.account;
  target.accountDisplay = session.accountDisplay;
  target.roles = session.roles.slice();
  target.currentRole = session.currentRole;
  target.role = session.currentRole;
  target.openid = '';
}

function clearAppProjection() {
  const target = globalData();
  if (!target) return;
  target.account = '';
  target.accountDisplay = '';
  target.roles = [];
  target.currentRole = '';
  target.role = '';
  target.openid = '';
}

function persistSession(session) {
  let record;
  try {
    record = validStoredSession(session);
  } catch (_) {
    return false;
  }
  if (!record) return false;
  const before = sessionStorageSnapshot();
  if (!before.ok) return false;
  let persisted = null;
  let verified = false;
  try {
    wx.setStorageSync(SESSION_STORAGE_KEY, cloneSession(record));
    const after = sessionStorageSnapshot();
    persisted = after.session;
    verified = after.ok && sameSession(record, persisted);
  } catch (_) {}
  if (!verified) {
    restoreSessionStorage(before.session);
    return false;
  }
  applyAppProjection(record);
  return true;
}

function initialSessionFromResult(result) {
  if (
    !isPlainObject(result)
    || result.ok !== true
    || !Object.prototype.hasOwnProperty.call(result, 'kind')
    || result.kind !== 'session_issued'
  ) {
    return null;
  }
  return validStoredSession({
    schemaVersion: AUTH_PROTOCOL,
    sessionToken: result.sessionToken,
    account: result.account,
    accountDisplay: result.accountDisplay,
    roles: normalizeRoles(result.roles),
    currentRole: result.currentRole
  });
}

function projectedSession(current, result, sessionToken) {
  if (!isPlainObject(result)) return null;
  const next = cloneSession(current);
  next.sessionToken = sessionToken;

  if (Object.prototype.hasOwnProperty.call(result, 'account')) {
    if (typeof result.account !== 'string') return null;
    next.account = result.account;
  }
  if (Object.prototype.hasOwnProperty.call(result, 'accountDisplay')) {
    if (typeof result.accountDisplay !== 'string') return null;
    next.accountDisplay = result.accountDisplay;
  }
  if (Object.prototype.hasOwnProperty.call(result, 'roles')) {
    const roles = normalizeRoles(result.roles);
    if (!roles) return null;
    next.roles = roles;
  }
  if (Object.prototype.hasOwnProperty.call(result, 'currentRole')) {
    if (typeof result.currentRole !== 'string') return null;
    next.currentRole = result.currentRole;
  }
  return validStoredSession(next);
}

function beginAuthAttempt(kind) {
  if (typeof kind !== 'string' || kind.length === 0) {
    throw fixedError('INVALID_INPUT');
  }
  if (generation >= Number.MAX_SAFE_INTEGER) {
    throw fixedError('AUTH_INTERNAL_ERROR');
  }
  generation += 1;
  currentAttempt = Object.freeze({ generation, kind });
  return currentAttempt;
}

function matchingAttempt(attempt) {
  return !!(
    attempt
    && attempt === currentAttempt
    && attempt.generation === generation
    && attempt.kind === currentAttempt.kind
  );
}

function isAuthAttemptCurrent(attempt) {
  return matchingAttempt(attempt);
}

function cancelAuthAttempt(attempt) {
  if (!matchingAttempt(attempt)) return false;
  currentAttempt = null;
  return true;
}

function commitAuthResult(attempt, result) {
  if (!matchingAttempt(attempt)) return false;
  let session;
  try {
    session = initialSessionFromResult(result);
  } catch (_) {
    return false;
  }
  if (!session || !persistSession(session)) return false;
  currentAttempt = null;
  return true;
}

function commitSessionRotation(expectedToken, result) {
  const current = getSession();
  if (!current || current.sessionToken !== expectedToken) {
    return false;
  }
  let next;
  try {
    if (
      !isPlainObject(result)
      || result.ok !== true
      || !Object.prototype.hasOwnProperty.call(result, 'kind')
      || result.kind !== 'session_rotated'
      || !validSessionToken(result.sessionToken)
    ) {
      return false;
    }
    next = projectedSession(current, result, result.sessionToken);
  } catch (_) {
    return false;
  }
  return !!next && persistSession(next);
}

function applySessionProjection(expectedToken, result) {
  const current = getSession();
  if (!current || current.sessionToken !== expectedToken) return false;
  let next;
  try {
    next = projectedSession(current, result, current.sessionToken);
  } catch (_) {
    return false;
  }
  return !!next && persistSession(next);
}

function clearSessionIfCurrent(expectedToken) {
  const current = getSession();
  if (!current || current.sessionToken !== expectedToken) return false;
  let removed = false;
  try {
    wx.removeStorageSync(SESSION_STORAGE_KEY);
    const after = sessionStorageSnapshot();
    removed = after.ok && after.session === null;
  } catch (_) {}
  if (!removed) {
    restoreSessionStorage(current);
    return false;
  }
  clearAppProjection();
  return true;
}

function migrateLegacyAuthOnce() {
  let marker;
  try {
    marker = wx.getStorageSync(MIGRATION_STORAGE_KEY);
  } catch (_) {
    throw fixedError('AUTH_INTERNAL_ERROR');
  }
  if (marker === AUTH_PROTOCOL) return false;
  try {
    LEGACY_AUTH_KEYS.forEach((key) => {
      wx.removeStorageSync(key);
      const remaining = wx.getStorageSync(key);
      if (remaining !== undefined && remaining !== null && remaining !== '') {
        throw fixedError('AUTH_INTERNAL_ERROR');
      }
    });
    wx.setStorageSync(MIGRATION_STORAGE_KEY, AUTH_PROTOCOL);
    if (wx.getStorageSync(MIGRATION_STORAGE_KEY) !== AUTH_PROTOCOL) {
      throw fixedError('AUTH_INTERNAL_ERROR');
    }
  } catch (_) {
    throw fixedError('AUTH_INTERNAL_ERROR');
  }
  return true;
}

function validatedPayload(payload) {
  try {
    if (!isPlainObject(payload)) throw fixedError('INVALID_INPUT');
    for (const key of RESERVED_ENVELOPE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(payload, key)) {
        throw fixedError('INVALID_INPUT');
      }
    }
    return Object.assign({}, payload);
  } catch (_) {
    throw fixedError('INVALID_INPUT');
  }
}

function anonymousEnvelope(payload) {
  const envelope = validatedPayload(payload);
  envelope.authProtocol = AUTH_PROTOCOL;
  envelope.clientInstanceId = getClientInstanceId();
  return envelope;
}

function sessionEnvelope(payload) {
  const envelope = anonymousEnvelope(payload);
  const session = getSession();
  if (!session) throw fixedError('SESSION_REQUIRED');
  envelope.sessionToken = session.sessionToken;
  return envelope;
}

module.exports = {
  getClientInstanceId,
  getSession,
  beginAuthAttempt,
  cancelAuthAttempt,
  isAuthAttemptCurrent,
  commitAuthResult,
  commitSessionRotation,
  applySessionProjection,
  clearSessionIfCurrent,
  migrateLegacyAuthOnce,
  sessionEnvelope,
  anonymousEnvelope
};
