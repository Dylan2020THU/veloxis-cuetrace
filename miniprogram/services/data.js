// 数据服务层：统一对外暴露 Promise 接口。
// 若已配置并初始化云开发环境，则走云函数；否则自动回退到本地 mock 数据。
// 这样在没有云环境时也能在开发者工具中端到端演示。

const mock = require('../utils/mock');
const { levelFromMinutes } = require('../utils/color');
const billing = require('../utils/billing');
const adminAuth = require('../utils/adminAuth');
const authSession = require('./auth-session');

const LOGIN_DEFAULT_NICKNAME_KEY = 'dc_login_default_nickname';
const ADMIN_LOGIN_NAME_KEY = 'dc_admin_login_name';
const USER_PROFILE_KEY = 'dc_user_profile';
const VALID_ROLES = ['member', 'coach', 'shop'];
const RESERVED_CLOUD_FIELDS = Object.freeze([
  'authProtocol',
  'clientInstanceId',
  'sessionToken',
  'action'
]);
const FIXED_ERROR_MESSAGES = Object.freeze({
  INVALID_INPUT: '\u8bf7\u6c42\u53c2\u6570\u65e0\u6548',
  CLOUD_NOT_READY: '\u4e91\u670d\u52a1\u672a\u8fde\u63a5',
  SESSION_REQUIRED: '\u8bf7\u5148\u767b\u5f55',
  SESSION_EXPIRED: '\u767b\u5f55\u72b6\u6001\u5df2\u5931\u6548\uff0c\u8bf7\u91cd\u65b0\u767b\u5f55',
  ACCOUNT_DISABLED: '\u8d26\u53f7\u5df2\u505c\u7528',
  ROLE_NOT_ALLOWED: '\u5f53\u524d\u8d26\u53f7\u672a\u5f00\u901a\u8be5\u8eab\u4efd',
  AUTH_CONFLICT: '\u8d26\u53f7\u72b6\u6001\u5df2\u53d8\u66f4\uff0c\u8bf7\u91cd\u8bd5',
  CLIENT_UPDATE_REQUIRED: '\u8bf7\u66f4\u65b0\u5c0f\u7a0b\u5e8f\u540e\u7ee7\u7eed',
  AUTH_MAINTENANCE: '\u8ba4\u8bc1\u670d\u52a1\u7ef4\u62a4\u4e2d\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5',
  AUTH_INTERNAL_ERROR: '\u8ba4\u8bc1\u670d\u52a1\u5f02\u5e38\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5',
  AUTH_ATTEMPT_STALE: '\u672c\u6b21\u767b\u5f55\u5df2\u5931\u6548'
});
let uploadIdentityPromise = null;

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fixedError(code) {
  const normalized = typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)
    ? code
    : 'AUTH_INTERNAL_ERROR';
  const error = new Error(
    FIXED_ERROR_MESSAGES[normalized]
      || '\u64cd\u4f5c\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5'
  );
  error.code = normalized;
  return error;
}

function sanitizedThrownError(error) {
  const allowed = [
    'INVALID_INPUT',
    'CLOUD_NOT_READY',
    'SESSION_REQUIRED',
    'AUTH_INTERNAL_ERROR'
  ];
  const code = error && allowed.indexOf(error.code) !== -1
    ? error.code
    : 'AUTH_INTERNAL_ERROR';
  return fixedError(code);
}

function resultCode(result) {
  return result && typeof result.code === 'string'
    ? result.code
    : 'AUTH_INTERNAL_ERROR';
}

function wechatNotBoundResult(result) {
  if (
    result
    && result.ok === false
    && result.code === 'WECHAT_NOT_BOUND'
    && result.next === 'wechat_phone'
  ) {
    return {
      ok: false,
      code: 'WECHAT_NOT_BOUND',
      next: 'wechat_phone'
    };
  }
  return null;
}

function validCallerPayload(payload) {
  if (!isPlainObject(payload)) return null;
  if (RESERVED_CLOUD_FIELDS.some((key) => hasOwn(payload, key))) return null;
  return Object.assign({}, payload);
}

function exactPayload(payload, fields) {
  if (!isPlainObject(payload)) return null;
  const keys = Object.keys(payload);
  if (
    keys.length !== fields.length
    || keys.some((key) => fields.indexOf(key) === -1)
    || fields.some((field) => !hasOwn(payload, field))
  ) {
    return null;
  }
  return Object.assign({}, payload);
}

function normalizeRoles(role, roles) {
  const list = Array.isArray(roles) ? roles.filter((r) => VALID_ROLES.indexOf(r) !== -1) : [];
  if (list.length) return Array.from(new Set(list));
  if (role === 'coach') return ['member', 'coach'];
  if (role === 'shop') return ['shop'];
  return ['member'];
}

function currentRoles() {
  const app = typeof getApp === 'function' ? getApp() : null;
  const gd = app && app.globalData ? app.globalData : {};
  const profile = gd.userProfile || {};
  return normalizeRoles(gd.currentRole || gd.role || mock.getRole(), gd.roles || profile.roles);
}

function cloudReady() {
  const app = typeof getApp === 'function' ? getApp() : null;
  return !!(
    app
    && app.globalData
    && app.globalData.cloudReady
    && typeof wx !== 'undefined'
    && wx.cloud
  );
}

function cloudNotReadyError() {
  return fixedError('CLOUD_NOT_READY');
}

function callCloudTransport(name, data) {
  if (
    typeof wx === 'undefined'
    || !wx.cloud
    || typeof wx.cloud.callFunction !== 'function'
  ) {
    return Promise.reject(cloudNotReadyError());
  }
  let pending;
  try {
    pending = wx.cloud.callFunction({ name, data });
  } catch (_) {
    return Promise.reject(fixedError('AUTH_INTERNAL_ERROR'));
  }
  return Promise.resolve(pending).then(
    (response) => response && response.result,
    () => {
      throw fixedError('AUTH_INTERNAL_ERROR');
    }
  );
}

function currentAppGlobalData() {
  try {
    const app = typeof getApp === 'function' ? getApp() : null;
    return app && app.globalData && typeof app.globalData === 'object'
      ? app.globalData
      : null;
  } catch (_) {
    return null;
  }
}

function sessionTokenIsCurrent(expectedToken) {
  const session = authSession.getSession();
  return !!(session && session.sessionToken === expectedToken);
}

function reLaunch(url) {
  try {
    if (typeof wx !== 'undefined' && typeof wx.reLaunch === 'function') {
      wx.reLaunch({ url });
    }
  } catch (_) {}
}

function showUpdateRequired() {
  let manager = null;
  try {
    manager = typeof wx !== 'undefined' && typeof wx.getUpdateManager === 'function'
      ? wx.getUpdateManager()
      : null;
  } catch (_) {}
  try {
    if (typeof wx !== 'undefined' && typeof wx.showModal === 'function') {
      wx.showModal({
        title: '\u9700\u8981\u66f4\u65b0',
        content: FIXED_ERROR_MESSAGES.CLIENT_UPDATE_REQUIRED,
        showCancel: false,
        success(result) {
          if (result && result.confirm && manager && typeof manager.applyUpdate === 'function') {
            manager.applyUpdate();
          }
        }
      });
    }
  } catch (_) {}
}

function showMaintenance() {
  const globalData = currentAppGlobalData();
  if (globalData) globalData.authWriteBlocked = true;
  try {
    if (typeof wx !== 'undefined' && typeof wx.showModal === 'function') {
      wx.showModal({
        title: '\u670d\u52a1\u7ef4\u62a4',
        content: FIXED_ERROR_MESSAGES.AUTH_MAINTENANCE,
        showCancel: false
      });
    }
  } catch (_) {}
}

function refreshSessionStatus(expectedToken) {
  if (!sessionTokenIsCurrent(expectedToken)) return Promise.resolve(false);
  let envelope;
  try {
    envelope = authSession.sessionEnvelope({});
    if (envelope.sessionToken !== expectedToken) return Promise.resolve(false);
    envelope.action = 'status';
  } catch (_) {
    return Promise.resolve(false);
  }
  return callCloudTransport('accountAuth', envelope).then(
    (result) => (
      validSecurityStatus(result)
        ? authSession.applySessionProjection(expectedToken, result)
        : false
    ),
    () => false
  );
}

function handleServerFailure(boundary, expectedToken, result, strictSession = false) {
  const code = resultCode(result);
  if (code === 'CLIENT_UPDATE_REQUIRED') {
    showUpdateRequired();
    return Promise.reject(fixedError(code));
  }
  if (code === 'AUTH_MAINTENANCE') {
    showMaintenance();
    return Promise.reject(fixedError(code));
  }
  if (boundary !== 'session') return Promise.reject(fixedError(code));
  if (['SESSION_REQUIRED', 'SESSION_EXPIRED', 'ACCOUNT_DISABLED'].indexOf(code) !== -1) {
    const cleared = authSession.clearSessionIfCurrent(expectedToken);
    if (cleared) {
      reLaunch('/pages/login/index');
      const error = fixedError(code);
      if (strictSession) error._task9SessionCleared = true;
      return Promise.reject(error);
    }
    if (strictSession) {
      return Promise.reject(fixedError(
        sessionTokenIsCurrent(expectedToken) ? 'AUTH_INTERNAL_ERROR' : 'AUTH_ATTEMPT_STALE'
      ));
    }
    return Promise.reject(fixedError(code));
  }
  if (code === 'ROLE_NOT_ALLOWED') {
    return refreshSessionStatus(expectedToken).then((applied) => {
      if (applied && sessionTokenIsCurrent(expectedToken)) {
        const globalData = currentAppGlobalData();
        if (globalData) globalData.authRolePickerRequired = true;
        reLaunch('/pages/login/index?rolePicker=1');
      }
      throw fixedError(code);
    });
  }
  if (code === 'AUTH_CONFLICT') {
    return refreshSessionStatus(expectedToken).then(() => {
      throw fixedError(code);
    });
  }
  return Promise.reject(fixedError(code));
}

function applySessionResult(expectedToken, result) {
  if (!isPlainObject(result)) return false;
  if (result.kind === 'session_rotated') {
    return authSession.commitSessionRotation(expectedToken, result);
  } else if (result.kind === 'session_revoked') {
    return authSession.clearSessionIfCurrent(expectedToken);
  }
  return authSession.applySessionProjection(expectedToken, result);
}

function callBoundary(
  boundary,
  name,
  payload,
  controlledAction,
  allowBeforeProbe = false,
  resultValidator,
  strictSession = false
) {
  const clean = validCallerPayload(payload);
  if (!clean || typeof name !== 'string' || name.length === 0) {
    return Promise.reject(fixedError('INVALID_INPUT'));
  }
  let expectedToken = '';
  let envelope;
  if (boundary === 'session') {
    const snapshot = authSession.getSession();
    if (!snapshot) return Promise.reject(fixedError('SESSION_REQUIRED'));
    expectedToken = snapshot.sessionToken;
  }
  if (!allowBeforeProbe && !cloudReady()) {
    return Promise.reject(cloudNotReadyError());
  }
  try {
    if (boundary === 'session') {
      envelope = authSession.sessionEnvelope(clean);
      if (envelope.sessionToken !== expectedToken) throw fixedError('AUTH_INTERNAL_ERROR');
    } else {
      envelope = authSession.anonymousEnvelope(clean);
    }
    if (controlledAction !== undefined) envelope.action = controlledAction;
  } catch (error) {
    return Promise.reject(sanitizedThrownError(error));
  }
  return callCloudTransport(name, envelope).then((result) => {
    if (
      boundary === 'session'
      && strictSession
      && !sessionTokenIsCurrent(expectedToken)
    ) {
      throw fixedError('AUTH_ATTEMPT_STALE');
    }
    if (!isPlainObject(result)) {
      throw fixedError('AUTH_INTERNAL_ERROR');
    }
    if (result && result.ok === false) {
      const unbound = (
        boundary === 'anonymous'
        && controlledAction === 'loginWechat'
      ) ? wechatNotBoundResult(result) : null;
      if (unbound) return unbound;
      return handleServerFailure(boundary, expectedToken, result, strictSession);
    }
    if (typeof resultValidator === 'function' && resultValidator(result) !== true) {
      throw fixedError('AUTH_INTERNAL_ERROR');
    }
    if (boundary === 'session') {
      if (result.ok !== true) throw fixedError('AUTH_INTERNAL_ERROR');
      const applied = applySessionResult(expectedToken, result);
      if (strictSession && applied !== true) {
        throw fixedError(
          sessionTokenIsCurrent(expectedToken) ? 'AUTH_INTERNAL_ERROR' : 'AUTH_ATTEMPT_STALE'
        );
      }
    }
    return result;
  });
}

function callAnonymousAuth(name, payload) {
  return callBoundary('anonymous', name, payload);
}

function callSessionCloud(name, payload) {
  return callBoundary('session', name, payload);
}

function callPublicCloud(name, payload) {
  return callBoundary('public', name, payload);
}

function callAdminCloud(name, payload) {
  return callBoundary('admin', name, payload);
}

// Legacy business helpers remain protocol-only until their ownership migration.
function callCloud(name, data) {
  return callPublicCloud(name, data);
}

function resultError(result) {
  return fixedError(resultCode(result));
}

function callCheckedCloud(name, input) {
  if (!cloudReady()) return Promise.reject(cloudNotReadyError());
  return callCloud(name, input || {});
}

function accountAction(boundary, action, input, fields, resultValidator, strictSession = false) {
  const payload = exactPayload(input, fields);
  if (!payload) return Promise.reject(fixedError('INVALID_INPUT'));
  return callBoundary(
    boundary, 'accountAuth', payload, action, false, resultValidator, strictSession
  );
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = keys.slice().sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function validSmsCodeSend(result) {
  return hasExactKeys(result, ['ok', 'challengeId', 'expiresIn', 'resendAfter'])
    && result.ok === true
    && typeof result.challengeId === 'string'
    && result.challengeId.length > 0
    && Number.isSafeInteger(result.expiresIn)
    && result.expiresIn > 0
    && Number.isSafeInteger(result.resendAfter)
    && result.resendAfter >= 0;
}

function validEmailCodeSend(result) {
  return hasExactKeys(result, ['ok', 'accepted', 'msg'])
    && result.ok === true
    && result.accepted === true
    && typeof result.msg === 'string';
}

function validEpoch(value) {
  return Number.isSafeInteger(value)
    && value > 0
    && Number.isFinite(new Date(value).getTime());
}

function validSecurityStatus(result) {
  const statusKeys = [
    'ok',
    'kind',
    'account',
    'accountNameSet',
    'passwordSet',
    'phoneBound',
    'phoneMasked',
    'emailBound',
    'emailMasked',
    'wechatBound',
    'roles',
    'currentRole',
    'reauthMethods',
    'currentSession',
    'otherSessionCount'
  ];
  if (!hasExactKeys(result, statusKeys) || result.ok !== true || result.kind !== 'security_status') {
    return false;
  }
  const booleanFields = [
    'accountNameSet',
    'passwordSet',
    'phoneBound',
    'emailBound',
    'wechatBound'
  ];
  if (booleanFields.some((field) => typeof result[field] !== 'boolean')) return false;
  if (typeof result.account !== 'string') return false;
  if (result.accountNameSet) {
    if (!/^[A-Za-z][A-Za-z0-9_]{3,19}$/.test(result.account)) return false;
  } else if (result.account !== '') {
    return false;
  }
  if (typeof result.phoneMasked !== 'string' || typeof result.emailMasked !== 'string') return false;
  if (result.phoneBound) {
    if (!/^\d{3}\*+\d{4}$/.test(result.phoneMasked)) return false;
  } else if (result.phoneMasked !== '') {
    return false;
  }
  if (result.emailBound) {
    if (!result.emailMasked.includes('*') || !/^[^\s@]+@[^\s@]+$/.test(result.emailMasked)) return false;
  } else if (result.emailMasked !== '') {
    return false;
  }
  if (
    !Array.isArray(result.roles)
    || result.roles.length === 0
    || result.roles.length > VALID_ROLES.length
    || new Set(result.roles).size !== result.roles.length
    || result.roles.some((role) => VALID_ROLES.indexOf(role) === -1)
    || VALID_ROLES.indexOf(result.currentRole) === -1
    || result.roles.indexOf(result.currentRole) === -1
  ) return false;
  const expectedMethods = [];
  if (result.passwordSet) expectedMethods.push('password');
  if (result.phoneBound) expectedMethods.push('phone');
  if (result.emailBound) expectedMethods.push('email');
  if (result.wechatBound) expectedMethods.push('wechat');
  if (
    !Array.isArray(result.reauthMethods)
    || result.reauthMethods.length !== expectedMethods.length
    || result.reauthMethods.some((method, index) => method !== expectedMethods[index])
  ) return false;
  if (!Number.isSafeInteger(result.otherSessionCount) || result.otherSessionCount < 0) return false;
  const sessionKeys = [
    'authenticatedAt',
    'authenticationMethod',
    'createdAt',
    'lastSeenAt',
    'idleExpiresAt',
    'absoluteExpiresAt'
  ];
  const currentSession = result.currentSession;
  if (!hasExactKeys(currentSession, sessionKeys)) return false;
  if (
    ['authenticatedAt', 'createdAt', 'lastSeenAt', 'idleExpiresAt', 'absoluteExpiresAt']
      .some((field) => !validEpoch(currentSession[field]))
  ) return false;
  if (
    typeof currentSession.authenticationMethod !== 'string'
    || !/^[a-z][a-z_]{1,31}$/.test(currentSession.authenticationMethod)
  ) return false;
  if (
    currentSession.createdAt > currentSession.authenticatedAt
    || currentSession.createdAt > currentSession.lastSeenAt
    || currentSession.lastSeenAt >= currentSession.idleExpiresAt
    || currentSession.authenticatedAt >= currentSession.idleExpiresAt
    || currentSession.authenticatedAt >= currentSession.absoluteExpiresAt
    || currentSession.lastSeenAt >= currentSession.absoluteExpiresAt
    || currentSession.createdAt >= currentSession.absoluteExpiresAt
  ) return false;
  return true;
}

function resultHasKind(kind) {
  return (result) => !!(result && result.ok === true && result.kind === kind);
}

function currentSessionToken() {
  const current = authSession.getSession();
  return current && typeof current.sessionToken === 'string' ? current.sessionToken : '';
}

function ensureNonRotatingResult(expectedToken, result) {
  if (expectedToken && currentSessionToken() === expectedToken) return result;
  throw fixedError('AUTH_ATTEMPT_STALE');
}

function ensureRotatedResult(expectedToken, result) {
  const currentToken = currentSessionToken();
  if (
    result
    && typeof result.sessionToken === 'string'
    && result.sessionToken
    && result.sessionToken !== expectedToken
    && currentToken === result.sessionToken
  ) return result;
  if (currentToken === expectedToken) throw fixedError('AUTH_INTERNAL_ERROR');
  throw fixedError('AUTH_ATTEMPT_STALE');
}

function ensureRevokedResult(expectedToken, result) {
  const currentToken = currentSessionToken();
  if (!currentToken) return result;
  if (currentToken === expectedToken) throw fixedError('AUTH_INTERNAL_ERROR');
  throw fixedError('AUTH_ATTEMPT_STALE');
}

function guardTask9Failure(expectedToken, error) {
  if (error && error._task9SessionCleared === true) throw fixedError(error.code);
  if (expectedToken && !sessionTokenIsCurrent(expectedToken)) {
    throw fixedError('AUTH_ATTEMPT_STALE');
  }
  throw error;
}

function task9NonRotatingCloud(name, payload, validator) {
  const expectedToken = currentSessionToken();
  return callBoundary('session', name, payload, undefined, false, validator, true)
    .then((result) => ensureNonRotatingResult(expectedToken, result))
    .catch((error) => guardTask9Failure(expectedToken, error));
}

function task9NonRotatingAction(action, input, fields, kind, validator) {
  const expectedToken = currentSessionToken();
  return accountAction(
    'session', action, input, fields,
    validator || resultHasKind(kind), true
  )
    .then((result) => ensureNonRotatingResult(expectedToken, result))
    .catch((error) => guardTask9Failure(expectedToken, error));
}

function task9RotatingAction(action, input, fields) {
  const expectedToken = currentSessionToken();
  return accountAction(
    'session', action, input, fields,
    (result) => !!(
      result
      && result.ok === true
      && result.kind === 'session_rotated'
      && typeof result.sessionToken === 'string'
      && result.sessionToken
      && result.sessionToken !== expectedToken
    ),
    true
  )
    .then((result) => ensureRotatedResult(expectedToken, result))
    .catch((error) => guardTask9Failure(expectedToken, error));
}

function task9RevokingAction(action) {
  const expectedToken = currentSessionToken();
  return accountAction(
    'session', action, {}, [], resultHasKind('session_revoked'), true
  )
    .then((result) => ensureRevokedResult(expectedToken, result))
    .catch((error) => guardTask9Failure(expectedToken, error));
}

function sessionIssuingAction(action, input, fields, attempt) {
  return accountAction('anonymous', action, input, fields).then((result) => {
    if (!authSession.isAuthAttemptCurrent(attempt)) {
      throw fixedError('AUTH_ATTEMPT_STALE');
    }
    if (action === 'loginWechat') {
      const unbound = wechatNotBoundResult(result);
      if (unbound) return unbound;
    }
    if (!result || result.kind !== 'session_issued') throw fixedError('AUTH_INTERNAL_ERROR');
    if (!authSession.commitAuthResult(attempt, result)) {
      throw fixedError('AUTH_INTERNAL_ERROR');
    }
    return result;
  });
}

function beginAuthAttempt(kind) {
  return authSession.beginAuthAttempt(kind);
}

function cancelAuthAttempt(attempt) {
  return authSession.cancelAuthAttempt(attempt);
}

function registerAccountName(input, attempt) {
  return sessionIssuingAction(
    'registerAccountName', input,
    ['accountName', 'password', 'termsVersion', 'privacyVersion'], attempt
  );
}

function registerAccount(input, attempt) {
  return registerAccountName(input, attempt);
}

function loginWithSms(input, attempt) {
  return sessionIssuingAction(
    'loginSms', input,
    ['phone', 'challengeId', 'code', 'termsVersion', 'privacyVersion'], attempt
  );
}

function loginWithPassword(input, attempt) {
  return sessionIssuingAction(
    'loginPassword', input,
    ['identifier', 'password', 'termsVersion', 'privacyVersion'], attempt
  );
}

function loginWithWechat(input, attempt) {
  return sessionIssuingAction(
    'loginWechat', input,
    ['termsVersion', 'privacyVersion'], attempt
  );
}

function verifyWechatEntryPhone(input) {
  return accountAction(
    'anonymous', 'verifyWechatEntryPhone', input,
    ['phone', 'challengeId', 'code', 'termsVersion', 'privacyVersion']
  );
}

function completeWechatEntry(input, attempt) {
  return sessionIssuingAction(
    'completeWechatEntry', input,
    ['proofToken', 'bindWechat', 'termsVersion', 'privacyVersion'], attempt
  );
}

function getAccountSecurity() {
  return task9NonRotatingAction('status', {}, [], 'security_status', validSecurityStatus);
}

function reauthenticate(input) {
  if (!isPlainObject(input)) return Promise.reject(fixedError('INVALID_INPUT'));
  if (input.method === 'password') {
    return task9NonRotatingAction('reauthenticate', input, ['method', 'password'], 'reauthenticated');
  }
  if (input.method === 'phone') {
    return task9NonRotatingAction(
      'reauthenticate', input, ['method', 'phone', 'challengeId', 'code'], 'reauthenticated'
    );
  }
  if (input.method === 'email') {
    return task9NonRotatingAction('reauthenticate', input, ['method', 'code'], 'reauthenticated');
  }
  if (input.method === 'wechat') {
    return task9NonRotatingAction('reauthenticate', input, ['method'], 'reauthenticated');
  }
  return Promise.reject(fixedError('INVALID_INPUT'));
}

function setAccountName(input) {
  return task9NonRotatingAction('setAccountName', input, ['accountName'], 'security_mutation');
}

function setPassword(input) {
  return task9RotatingAction('setPassword', input, ['password']);
}

function bindPhone(input) {
  return task9NonRotatingAction(
    'bindPhone', input, ['phone', 'challengeId', 'code'], 'security_mutation'
  );
}

function bindWechat() {
  return task9NonRotatingAction('bindWechat', {}, [], 'security_mutation');
}

function logoutCurrentSession() {
  return task9RevokingAction('logoutCurrent');
}

function logoutOtherSessions() {
  return task9RotatingAction('logoutOthers', {}, []);
}

function localAuthSessionToken() {
  const current = authSession.getSession();
  return current ? current.sessionToken : '';
}

function clearLocalAuthSessionAfterReset(expectedToken, result) {
  if (!expectedToken) return result;
  const current = authSession.getSession();
  if (!current || current.sessionToken !== expectedToken) return result;
  if (!authSession.clearSessionIfCurrent(expectedToken)) {
    throw fixedError('AUTH_INTERNAL_ERROR');
  }
  return result;
}

function resetPasswordByWechat(input) {
  const expectedToken = localAuthSessionToken();
  return accountAction('anonymous', 'resetPasswordByWechat', input, ['password'])
    .then((result) => clearLocalAuthSessionAfterReset(expectedToken, result));
}

function resetPasswordByEmail(input) {
  const expectedToken = localAuthSessionToken();
  return accountAction(
    'anonymous', 'resetPasswordByEmail', input,
    ['email', 'code', 'password']
  ).then((result) => clearLocalAuthSessionAfterReset(expectedToken, result));
}

function bindEmail(input) {
  return task9NonRotatingAction('bindEmail', input, ['email', 'code'], 'security_mutation');
}

function sendEmailCode(input) {
  if (!isPlainObject(input)) return Promise.reject(fixedError('INVALID_INPUT'));
  if (input.purpose === 'reset') {
    const payload = exactPayload(input, ['purpose', 'email']);
    return payload ? callAnonymousAuth('sendEmailCode', payload) : Promise.reject(fixedError('INVALID_INPUT'));
  }
  if (input.purpose === 'bind') {
    const payload = exactPayload(input, ['purpose', 'email']);
    if (!payload) return Promise.reject(fixedError('INVALID_INPUT'));
    return task9NonRotatingCloud('sendEmailCode', payload, validEmailCodeSend);
  }
  if (input.purpose === 'reauth') {
    const payload = exactPayload(input, ['purpose']);
    if (!payload) return Promise.reject(fixedError('INVALID_INPUT'));
    return task9NonRotatingCloud('sendEmailCode', payload, validEmailCodeSend);
  }
  return Promise.reject(fixedError('INVALID_INPUT'));
}

function selectRole(role) {
  if (typeof role !== 'string' || VALID_ROLES.indexOf(role) === -1) {
    return Promise.reject(fixedError('INVALID_INPUT'));
  }
  return callSessionCloud('login', { role });
}

function probeAuthCloud() {
  return callBoundary('anonymous', 'accountAuth', {}, 'probe', true);
}

// 初始化（播种演示数据；cloudReady 时云端数据优先，本地数据作为兜底）
function initData() {
  mock.ensureSeeded();
}

function defaultNicknameKey(role) {
  return `${LOGIN_DEFAULT_NICKNAME_KEY}_${role || 'member'}`;
}

function rememberLoginNickname(nickname, role) {
  const name = (nickname || '').trim();
  if (!name) return;
  const app = typeof getApp === 'function' ? getApp() : null;
  const currentRole = role || (app && app.globalData && app.globalData.role) || mock.getRole() || 'member';
  try {
    wx.setStorageSync(defaultNicknameKey(currentRole), name);
  } catch (e) {}
  if (app && app.globalData) {
    const profile = app.globalData.userProfile || {};
    const oldName = profile.nickname || '';
    if (!oldName || oldName === '大川会员') {
      app.globalData.userProfile = Object.assign({}, profile, {
        role: currentRole,
        nickname: name
      });
    }
  }
}

function readLoginNickname(role) {
  try {
    return wx.getStorageSync(defaultNicknameKey(role)) || '';
  } catch (e) {
    return '';
  }
}

function currentLoginName() {
  const app = typeof getApp === 'function' ? getApp() : null;
  const role = (app && app.globalData && (app.globalData.currentRole || app.globalData.role)) || mock.getRole() || 'member';
  if (role === 'admin') return readAdminLoginName();
  return readLoginNickname(role);
}

function setAdminSession(loginName) {
  const app = typeof getApp === 'function' ? getApp() : null;
  const name = (loginName || '').trim();
  try {
    wx.setStorageSync(ADMIN_LOGIN_NAME_KEY, name);
  } catch (e) {}
  mock.setRole('admin');
  if (app && app.globalData) {
    app.globalData.role = 'admin';
    app.globalData.currentRole = 'admin';
    app.globalData.adminMode = true;
    app.globalData.adminLoginName = name;
  }
}

function readAdminLoginName() {
  try {
    return wx.getStorageSync(ADMIN_LOGIN_NAME_KEY) || '';
  } catch (e) {
    return '';
  }
}

function logoutAdmin() {
  try {
    wx.removeStorageSync(ADMIN_LOGIN_NAME_KEY);
  } catch (e) {}
  mock.setRole('member');
  const app = typeof getApp === 'function' ? getApp() : null;
  if (app && app.globalData) {
    app.globalData.role = 'member';
    app.globalData.currentRole = 'member';
    app.globalData.adminMode = false;
    app.globalData.adminLoginName = '';
  }
}

function getAdminProfile() {
  return {
    account: readAdminLoginName() || 'admin_zhx',
    roleLabel: '平台管理员',
    permissions: ['门店数据查看', '教练数据查看', '会员数据查看']
  };
}

function loginAdmin({ account, password }) {
  const loginName = (account || '').trim();
  if (!cloudReady()) return Promise.reject(cloudNotReadyError());
  return callAdminCloud('adminLogin', { account: loginName, password }).then((r) => {
    if (!r || r.ok !== true || r.isAdmin !== true) {
      const err = new Error((r && r.msg) || '管理员登录失败');
      err.code = (r && r.code) || 'ADMIN_LOGIN_FAILED';
      throw err;
    }
    setAdminSession(loginName);
    return r;
  });
}

function applyDefaultNickname(user) {
  if (!user) return user;
  const app = typeof getApp === 'function' ? getApp() : null;
  const role = user.currentRole || user.role || (app && app.globalData && (app.globalData.currentRole || app.globalData.role)) || mock.getRole() || 'member';
  const fallback = readLoginNickname(role);
  if (fallback && (!user.nickname || user.nickname === '大川会员')) {
    return Object.assign({}, user, { role, currentRole: role, nickname: fallback });
  }
  return user;
}

function applyUserResult(r) {
  const app = getApp();
  if (!app || !app.globalData || !r) return;
  const session = authSession.getSession();
  if (
    session
    && /^[0-9a-f]{64}$/.test(String(r.storageNamespace || ''))
  ) {
    app.globalData.storageNamespace = r.storageNamespace;
  }
  if (!session) {
    app.globalData.account = '';
    app.globalData.accountDisplay = '';
    app.globalData.roles = [];
    app.globalData.currentRole = '';
    app.globalData.role = '';
  }
  app.globalData.openid = '';
  if (r.firstLoginAt) app.globalData.firstLoginAt = r.firstLoginAt;
  if (r.plan) app.globalData.plan = r.plan;
  if (r.nickname !== undefined || r.avatar !== undefined) {
    app.globalData.userProfile = {
      role: session ? session.currentRole : '',
      roles: session ? session.roles.slice() : [],
      currentRole: session ? session.currentRole : '',
      nickname: r.nickname || '',
      avatar: r.avatar || ''
    };
  }
}

// 进入选定角色，服务端依据已绑定账号的角色权限决定是否放行；断云时拒绝登录。
function login(role) {
  return selectRole(role);
}

function sendSmsCode(input) {
  const payload = exactPayload(input, ['phone', 'purpose']);
  if (!payload) return Promise.reject(fixedError('INVALID_INPUT'));
  if (payload.purpose === 'login' || payload.purpose === 'wechat_entry') {
    return callAnonymousAuth('sendSmsCode', payload);
  }
  if (payload.purpose === 'bind_phone' || payload.purpose === 'reauth') {
    return task9NonRotatingCloud('sendSmsCode', payload, validSmsCodeSend);
  }
  return Promise.reject(fixedError('INVALID_INPUT'));
}

function verifySmsCode(phone, code) {
  if (cloudReady()) {
    return callCloud('verifySmsCode', { phone, code }).then((r) => {
      if (r && r.ok === false) {
        const err = new Error(r.msg || '验证码错误或已过期');
        err.code = r.code || '';
        err.result = r;
        throw err;
      }
      return r || { ok: true };
    });
  }
  return Promise.reject(Object.assign(new Error('短信登录需先连接云服务'), { code: 'CLOUD_NOT_READY' }));
}

// 读取当前用户在云数据库 users 集合中的资料
function getUserProfile() {
  if (cloudReady()) {
    return callCloud('getUserProfile', {}).then((r) => {
      const user = applyDefaultNickname((r && r.user) || null);
      if (user) applyUserResult(user);
      return user;
    });
  }
  const stored = mock.readObject(USER_PROFILE_KEY, null) || {};
  const currentRole = mock.getRole();
  const roles = normalizeRoles(stored.role || currentRole, stored.roles);
  const user = applyDefaultNickname(Object.assign({
    openid: mock.MOCK_OPENID,
    role: currentRole,
    roles,
    currentRole,
    nickname: '大川会员',
    avatar: ''
  }, stored, {
    openid: mock.MOCK_OPENID,
    role: currentRole,
    roles,
    currentRole
  }));
  applyUserResult(user);
  return Promise.resolve(user);
}

function saveUserProfile({
  role,
  nickname,
  avatar,
  gender,
  birthDate,
  locationCity,
  hometown,
  years,
  level,
  canSeeGender,
  canSeeBirthDate,
  canSeeHometown,
  canSeePhone
}) {
  if (cloudReady()) {
    return callCloud('saveUserProfile', {
      role,
      nickname,
      avatar,
      gender,
      birthDate,
      locationCity,
      hometown,
      years,
      level,
      canSeeGender,
      canSeeBirthDate,
      canSeeHometown,
      canSeePhone
    });
  }
  const existing = mock.readObject(USER_PROFILE_KEY, null) || {};
  const updated = Object.assign({}, existing);
  const nextRole = role || existing.currentRole || existing.role || mock.getRole();
  const patch = {
    roles: normalizeRoles(existing.role || nextRole, existing.roles),
    currentRole: nextRole,
    role: nextRole,
    nickname,
    avatar,
    gender,
    birthDate,
    locationCity,
    hometown,
    years,
    level,
    canSeeGender,
    canSeeBirthDate,
    canSeeHometown,
    canSeePhone
  };
  Object.keys(patch).forEach((key) => {
    if (patch[key] !== undefined) updated[key] = patch[key];
  });
  mock.writeObject(USER_PROFILE_KEY, updated);
  if (getApp().globalData) {
    getApp().globalData.userProfile = updated;
  }
  return Promise.resolve({ ok: true });
}

function getHalls() {
  if (cloudReady()) {
    return callCloud('getHalls', {}).then((r) => (r && r.halls) || []);
  }
  return Promise.resolve(mock.readArray(mock.KEY_HALLS));
}

// 聚合得到 [start, end] 区间内每一天的训练统计
// 返回数组：{ date, totalMinutes, sessionCount, level }
// targetOpenid 可选：教练查看已绑定会员数据时传入。
function getHeatmap({ startKey, endKey, targetOpenid }) {
  if (cloudReady()) {
    return callCloud('getHeatmap', { startKey, endKey, targetOpenid }).then(
      (r) => (r && r.stats) || []
    );
  }
  const ownerOpenid = targetOpenid || mock.MOCK_OPENID;
  const sessions = mock
    .readArray(mock.KEY_SESSIONS)
    .filter((s) => s._openid === ownerOpenid && s.date >= startKey && s.date <= endKey);
  const map = {};
  sessions.forEach((s) => {
    if (!map[s.date]) map[s.date] = { date: s.date, totalMinutes: 0, sessionCount: 0, personalMinutes: 0, coachMinutes: 0, verifiedCount: 0, unverifiedCount: 0 };
    map[s.date].totalMinutes += s.durationMinutes || 0;
    map[s.date].personalMinutes += s.durationMinutes || 0;
    map[s.date].sessionCount += 1;
    if (s.verified) map[s.date].verifiedCount += 1;
    else map[s.date].unverifiedCount += 1;
  });

  // 教练查看自己的杆迹时：叠加「以教练身份计时」的课时（金色），与自主练球/客场打球（蓝色）并存。
  // 同一天若两种身份都有计时，总时长统一以金色表示（金 > 蓝优先级）。
  const asCoachOwn = !targetOpenid && currentRoles().indexOf('coach') !== -1;
  if (asCoachOwn) {
    mock.readArray(KEY_COACH_LESSONS)
      .filter((l) => l.coachOpenid === ownerOpenid && l.date >= startKey && l.date <= endKey)
      .forEach((l) => {
        if (!map[l.date]) map[l.date] = { date: l.date, totalMinutes: 0, sessionCount: 0, personalMinutes: 0, coachMinutes: 0, verifiedCount: 0, unverifiedCount: 0 };
        map[l.date].totalMinutes += l.durationMinutes || 0;
        map[l.date].coachMinutes += l.durationMinutes || 0;
        map[l.date].sessionCount += 1;
        map[l.date].verifiedCount += 1;
      });
  }

  const stats = Object.keys(map).map((k) => {
    const item = map[k];
    item.level = levelFromMinutes(item.totalMinutes);
    item.hasVerified = item.verifiedCount > 0;
    if (asCoachOwn) item.kind = item.coachMinutes > 0 ? 'coach' : 'personal';
    return item;
  });
  return Promise.resolve(stats);
}

// 某一天的明细记录。targetOpenid 可选（教练查看会员）。
function getDayDetail(dateKey, targetOpenid) {
  if (cloudReady()) {
    return callCloud('getDayDetail', { dateKey, targetOpenid }).then(
      (r) => (r && r.sessions) || []
    );
  }
  const ownerOpenid = targetOpenid || mock.MOCK_OPENID;
  const sessions = mock
    .readArray(mock.KEY_SESSIONS)
    .filter((s) => s._openid === ownerOpenid && s.date === dateKey);

  // 教练查看自己当日明细：把「教练身份」的课时也列出来（标记 kind:'coach'），与杆迹热力图一致
  const asCoachOwn = !targetOpenid && currentRoles().indexOf('coach') !== -1;
  let rows = sessions.map((s) => Object.assign({ kind: 'personal' }, s));
  if (asCoachOwn) {
    const lessons = mock.readArray(KEY_COACH_LESSONS)
      .filter((l) => l.coachOpenid === ownerOpenid && l.date === dateKey)
      .map((l) => ({
        _id: l._id,
        hallName: l.hallName || '教学课时',
        startTime: l.startTime || '',
        durationMinutes: l.durationMinutes || 0,
        verified: true,
        kind: 'coach',
        memberNickname: l.memberNickname || ''
      }));
    rows = rows.concat(lessons);
  }
  rows.sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
  return Promise.resolve(rows);
}

// 新增一条训练记录
function addTraining({ hallId, hallName, date, startTime, durationMinutes }) {
  if (cloudReady()) {
    return callCloud('addTraining', { hallId, hallName, date, startTime, durationMinutes });
  }
  const sessions = mock.readArray(mock.KEY_SESSIONS);
  sessions.push({
    _id: `mock_s_${Date.now()}`,
    _openid: mock.MOCK_OPENID,
    hallId,
    hallName,
    date,
    startTime,
    durationMinutes,
    verified: false,
    createdAt: Date.now()
  });
  mock.writeArray(mock.KEY_SESSIONS, sessions);
  return Promise.resolve({ ok: true });
}

// ============ 角色 ============

function getRole() {
  const session = authSession.getSession();
  return Promise.resolve(session ? session.currentRole : '');
}

function setRole(role) {
  return selectRole(role).then((result) => result.currentRole);
}

// ============ 教练资料 ============

function getCoachProfile() {
  if (cloudReady()) {
    return callCloud('getCoachProfile', {}).then((r) => (r && r.profile) || null);
  }
  return Promise.resolve(mock.readObject(mock.KEY_COACH, null));
}

function getCoachProfileByOpenid(openid) {
  if (!openid) return Promise.resolve(null);
  if (cloudReady()) {
    return callCloud('getCoachProfile', { targetOpenid: openid }).then((r) => (r && r.profile) || null);
  }
  return Promise.resolve(mock.getCoachProfileByOpenid(openid));
}

function getMemberProfileByOpenid(openid) {
  if (!openid) return Promise.resolve(null);
  if (cloudReady()) {
    return callCloud('getMemberProfile', { targetOpenid: openid }).then((r) => (r && r.member) || null);
  }
  const members = mock.readArray(mock.KEY_MEMBERS);
  return Promise.resolve(members.find((m) => m.openid === openid) || null);
}

// 解析"账号编码 / 二维码内容 / 原始 openid"为账号对象 { openid, role, nickname, avatar, source }。
// 供「扫码添加」与「手动输入编码添加」统一落地。mock 下在本地集合（教练/会员/当前用户）中按
// openid 或编码反查；云端模式下若本地查不到，则把原始串当作 openid 透传给云函数处理。
function resolveAccount(input) {
  const account = require('../utils/account');
  const parsed = account.parse(input);
  if (!parsed) return Promise.resolve(null);

  const lookupLocal = (openid, code) => {
    const coaches = mock.readArray(mock.KEY_ALL_COACHES);
    const members = mock.readArray(mock.KEY_MEMBERS);
    let hit = null;
    let role = '';
    if (openid) {
      hit = coaches.find((c) => c.openid === openid);
      if (hit) role = 'coach';
      if (!hit) { hit = members.find((m) => m.openid === openid); if (hit) role = 'member'; }
    }
    if (!hit && code) {
      hit = coaches.find((c) => account.codeOf(c.openid) === code);
      if (hit) role = 'coach';
      if (!hit) { hit = members.find((m) => account.codeOf(m.openid) === code); if (hit) role = 'member'; }
    }
    if (hit) {
      return { openid: hit.openid, role, nickname: hit.nickname || '', avatar: hit.avatar || mock.avatarFor(hit.openid) };
    }
    // 兜底：当前演示用户自身（单账号演示下扫到自己的码）
    if ((openid && openid === mock.MOCK_OPENID) || (code && account.codeOf(mock.MOCK_OPENID) === code)) {
      const app = getApp();
      const prof = (app && app.globalData && app.globalData.userProfile) || {};
      return { openid: mock.MOCK_OPENID, role: mock.getRole(), nickname: prof.nickname || '大川会员', avatar: prof.avatar || '' };
    }
    return null;
  };

  if (parsed.source === 'qr') {
    const local = lookupLocal(parsed.openid, parsed.code);
    return Promise.resolve({
      openid: parsed.openid,
      role: parsed.role || (local && local.role) || '',
      nickname: parsed.name || (local && local.nickname) || '',
      avatar: (local && local.avatar) || mock.avatarFor(parsed.openid),
      source: 'qr'
    });
  }

  // 文本：编码反查 → 原始 openid 反查 → 云端透传
  const local = lookupLocal('', parsed.code) || lookupLocal(parsed.raw, '');
  if (local) return Promise.resolve(Object.assign({ source: 'text' }, local));
  if (cloudReady()) {
    return Promise.resolve({ openid: parsed.raw, role: '', nickname: '', avatar: '', source: 'text' });
  }
  return Promise.resolve(null);
}

function getMemberCheckinsByOpenid(openid) {
  if (!openid) return Promise.resolve([]);
  if (cloudReady()) {
    return callCloud('getMemberCheckins', { targetOpenid: openid }).then((r) => (r && r.checkins) || []);
  }
  return Promise.resolve(mock.getMemberCheckins(openid));
}

function getMemberCheckins() {
  if (cloudReady()) {
    return callCloud('getMemberCheckins', {}).then((r) => (r && r.checkins) || []);
  }
  return Promise.resolve([]);
}

function saveCoachProfile(profile) {
  if (cloudReady()) {
    return callCloud('saveCoachProfile', profile);
  }
  mock.writeObject(mock.KEY_COACH, Object.assign({ _openid: mock.MOCK_OPENID }, profile));
  return Promise.resolve({ ok: true });
}

// ============ 师生绑定 ============

// 教练已绑定的会员列表
function getMyMembers() {
  if (cloudReady()) {
    return callCloud('getMyMembers', {}).then((r) => (r && r.members) || []);
  }
  const links = mock.readArray(mock.KEY_LINKS);
  const members = mock.readArray(mock.KEY_MEMBERS);
  const linkedOpenids = links.map((l) => l.memberOpenid);
  return Promise.resolve(members.filter((m) => linkedOpenids.indexOf(m.openid) !== -1));
}

// 可绑定但尚未绑定的演示会员（mock 模式下用于"添加学员"选择）
function getLinkableMembers() {
  if (cloudReady()) {
    // 云端模式下通过会员编码绑定，无候选列表
    return Promise.resolve([]);
  }
  const links = mock.readArray(mock.KEY_LINKS);
  const members = mock.readArray(mock.KEY_MEMBERS);
  const linkedOpenids = links.map((l) => l.memberOpenid);
  return Promise.resolve(members.filter((m) => linkedOpenids.indexOf(m.openid) === -1));
}

function linkMember(memberOpenid) {
  if (cloudReady()) {
    return callCloud('linkMember', { memberOpenid });
  }
  const links = mock.readArray(mock.KEY_LINKS);
  if (links.some((l) => l.memberOpenid === memberOpenid)) {
    return Promise.resolve({ ok: true, msg: '已绑定' });
  }
  links.push({
    coachOpenid: mock.MOCK_OPENID,
    memberOpenid,
    status: 'active',
    createdAt: Date.now()
  });
  mock.writeArray(mock.KEY_LINKS, links);
  return Promise.resolve({ ok: true });
}

// ============ 店家 ============

// mock 模式下根据 openid 解析会员昵称
function mockNickname(openid) {
  if (openid === mock.MOCK_OPENID) return '大川会员';
  const m = mock.readArray(mock.KEY_MEMBERS).find((x) => x.openid === openid);
  return (m && m.nickname) || '会员';
}

function getShopProfile() {
  if (cloudReady()) {
    return callCloud('getShopProfile', {}).then((r) => (r && r.profile) || null);
  }
  return Promise.resolve(mock.readObject(mock.KEY_SHOP, null));
}

// 店主保存的资料（品牌+门店双层）
function saveShopProfile({ name, hallId, hallName, tableTypes, brandId, storeId }) {
  if (cloudReady()) {
    return callCloud('saveShopProfile', { name, hallId, hallName, tableTypes, brandId, storeId }).then((r) => {
      mock.setRole('shop');
      return r;
    });
  }
  const existing = mock.readObject(mock.KEY_SHOP, null) || {};
  const updated = Object.assign({}, existing, {
    _openid: mock.MOCK_OPENID,
    name: name !== undefined ? name : existing.name,
    hallId: hallId !== undefined ? hallId : existing.hallId,
    hallName: hallName !== undefined ? hallName : existing.hallName,
    tableTypes: Array.isArray(tableTypes) ? tableTypes : existing.tableTypes,
    brandId: brandId !== undefined ? brandId : existing.brandId,
    storeId: storeId !== undefined ? storeId : existing.storeId
  });
  mock.writeObject(mock.KEY_SHOP, updated);
  mock.setRole('shop');
  return Promise.resolve({ ok: true });
}

// ============ 店主资质审核（营业执照） ============

// 提交 / 重新提交店主资质申请（营业执照 + 关键字段）。状态置为 pending。
function submitShopApplication({ ownerPhone, ownerWechat, ownerQQ, ownerEmail, licenseFileID }) {
  if (cloudReady()) {
    return callCloud('submitShopApplication', { ownerPhone, ownerWechat, ownerQQ, ownerEmail, licenseFileID });
  }
  const owner = mock.MOCK_OPENID;
  const list = mock.readArray(mock.KEY_SHOP_APPLICATIONS);
  const now = Date.now();
  const idx = list.findIndex((a) => a._openid === owner);
  const record = {
    _id: idx !== -1 ? list[idx]._id : 'app_' + now,
    _openid: owner,
    ownerPhone: ownerPhone || '',
    ownerWechat: ownerWechat || '',
    ownerQQ: ownerQQ || '',
    ownerEmail: ownerEmail || '',
    licenseFileID: licenseFileID || '',
    status: 'pending',
    reason: '',
    createdAt: idx !== -1 ? list[idx].createdAt : now,
    updatedAt: now
  };
  if (idx !== -1) list[idx] = record;
  else list.push(record);
  mock.writeArray(mock.KEY_SHOP_APPLICATIONS, list);
  return Promise.resolve({ ok: true, status: 'pending', _id: record._id });
}

// 查询当前用户店主资质状态：'none' | 'pending' | 'approved' | 'rejected'
// 老店主豁免：已有店铺资料(KEY_SHOP) 但无申请记录 → 视为 approved。
function getShopApplicationStatus() {
  if (cloudReady()) {
    return callCloud('getShopApplicationStatus', {}).then((r) => r || { status: 'none', application: null });
  }
  const owner = mock.MOCK_OPENID;
  const list = mock.readArray(mock.KEY_SHOP_APPLICATIONS);
  const app = list.find((a) => a._openid === owner);
  if (app) return Promise.resolve({ status: app.status || 'pending', application: app });
  const shop = mock.readObject(mock.KEY_SHOP, null);
  if (shop && shop._openid === owner) return Promise.resolve({ status: 'approved', application: null, legacy: true });
  return Promise.resolve({ status: 'none', application: null });
}

function getAdminStatus() {
  const loginName = currentLoginName();
  const accountAdmin = adminAuth.isAdminAccount(loginName);
  if (cloudReady()) {
    return callAdminCloud('getAdminStatus', { loginName }).then((r) => r || { ok: true, isAdmin: false });
  }
  return Promise.resolve({
    ok: true,
    isAdmin: false,
    bootstrap: false,
    accountAdmin
  });
}

// 管理员：拉取资质申请列表。status: 'pending'(默认) | 'approved' | 'rejected' | 'all'
function getPendingShopApplications(status = 'pending') {
  if (cloudReady()) {
    const loginName = currentLoginName();
    return callAdminCloud('getPendingShopApplications', { status, loginName }).then((r) => {
      // 服务端白名单拒绝时抛出 FORBIDDEN，供页面区分「无权限」与「空队列」
      if (r && r.ok === false && r.code === 'FORBIDDEN') {
        const e = new Error('FORBIDDEN');
        e.code = 'FORBIDDEN';
        throw e;
      }
      return (r && r.applications) || [];
    });
  }
  return Promise.reject(cloudNotReadyError());
}

// 管理员：审核（approve=true 通过 / false 驳回；驳回写 reason）
function reviewShopApplication({ applicationId, approve, reason }) {
  if (cloudReady()) {
    const loginName = currentLoginName();
    return callAdminCloud('reviewShopApplication', { applicationId, approve, reason, loginName });
  }
  return Promise.reject(cloudNotReadyError());
}

function latestLocalApplication(applications, openid) {
  return (applications || [])
    .filter((item) => item._openid === openid)
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))[0] || null;
}

function buildLocalAdminStores(stores, applications) {
  const rows = (stores || []).map((store) => {
    const app = latestLocalApplication(applications, store._openid);
    return {
      storeId: store._id || '',
      storeName: store.name || store.hallName || '未命名门店',
      ownerOpenid: store._openid || '',
      ownerName: store.ownerName || '店主',
      region: store.region || '',
      address: store.address || '',
      applicationStatus: (app && app.status) || 'none',
      checkinEnabled: !!store.checkinEnabled,
      createdAt: store.createdAt || ''
    };
  });
  return {
    summary: {
      totalStores: rows.length,
      approvedStores: rows.filter((item) => item.applicationStatus === 'approved').length,
      pendingApplications: (applications || []).filter((item) => (item.status || 'pending') === 'pending').length,
      rejectedApplications: (applications || []).filter((item) => item.status === 'rejected').length,
      checkinEnabledStores: rows.filter((item) => item.checkinEnabled).length
    },
    stores: rows
  };
}

function buildLocalAdminCoaches(coaches, links, applications) {
  const activeLinks = (links || []).filter((item) => item.status === 'active' || !item.status);
  const pendingApps = (applications || []).filter((item) => (item.status || 'pending') === 'pending');
  const rows = (coaches || []).map((coach) => {
    const openid = coach._openid || coach.openid || '';
    const link = activeLinks.find((item) => item.coachOpenid === openid || item.openid === openid);
    const pending = pendingApps.find((item) => item.coachOpenid === openid);
    const bindingStatus = link ? 'approved' : pending ? 'pending' : 'none';
    return {
      coachOpenid: openid,
      coachName: coach.nickname || coach.name || '教练',
      avatar: coach.avatar || '',
      boundStoreName: (link && (link.storeName || link.hallName)) || coach.hallName || '',
      bindingStatus,
      studentCount: coach.studentCount || 0,
      createdAt: coach.createdAt || ''
    };
  });
  return {
    summary: {
      totalCoaches: rows.length,
      boundCoaches: rows.filter((item) => item.bindingStatus === 'approved').length,
      pendingApplications: pendingApps.length,
      unboundCoaches: rows.filter((item) => item.bindingStatus === 'none').length,
      activeCoaches: rows.filter((item) => item.bindingStatus === 'approved').length
    },
    coaches: rows
  };
}

function buildLocalAdminMembers(members, sessions) {
  const rows = (members || []).map((member) => {
    const openid = member._openid || member.openid || member.memberOpenid || '';
    const memberSessions = (sessions || []).filter((item) => item.memberOpenid === openid);
    const totalMinutes = member.totalMinutes || memberSessions.reduce((sum, item) => sum + (item.durationMinutes || 0), 0);
    const lastSession = memberSessions.sort((a, b) => (b.endedAt || b.startedAt || 0) - (a.endedAt || a.startedAt || 0))[0] || {};
    return {
      memberOpenid: openid,
      memberName: member.nickname || '会员',
      avatar: member.avatar || '',
      accountName: member.account || '',
      totalTrainingHours: Number((totalMinutes / 60).toFixed(1)),
      trainingDays: member.checkinDays || 0,
      lastTrainingAt: member.lastTrainingAt || lastSession.endedAt || lastSession.startedAt || '',
      lastStoreName: member.lastStoreName || '',
      createdAt: member.createdAt || ''
    };
  });
  return {
    summary: {
      totalMembers: rows.length,
      newToday: 0,
      newThisWeek: 0,
      trainedMembers: rows.filter((item) => item.trainingDays > 0 || item.totalTrainingHours > 0).length,
      activeMembers: rows.filter((item) => item.lastTrainingAt).length
    },
    members: rows
  };
}

function getAdminStores() {
  const loginName = readAdminLoginName();
  if (cloudReady()) {
    return callAdminCloud('getAdminStores', { loginName }).then((r) => {
      if (r && r.ok === false) throw Object.assign(new Error(r.msg || '无管理员权限'), { code: r.code || '' });
      return r || { summary: {}, stores: [] };
    });
  }
  return Promise.reject(cloudNotReadyError());
}

function getAdminCoaches() {
  const loginName = readAdminLoginName();
  if (cloudReady()) {
    return callAdminCloud('getAdminCoaches', { loginName }).then((r) => {
      if (r && r.ok === false) throw Object.assign(new Error(r.msg || '无管理员权限'), { code: r.code || '' });
      return r || { summary: {}, coaches: [] };
    });
  }
  return Promise.reject(cloudNotReadyError());
}

function getAdminMembers() {
  const loginName = readAdminLoginName();
  if (cloudReady()) {
    return callAdminCloud('getAdminMembers', { loginName }).then((r) => {
      if (r && r.ok === false) throw Object.assign(new Error(r.msg || '无管理员权限'), { code: r.code || '' });
      return r || { summary: {}, members: [] };
    });
  }
  return Promise.reject(cloudNotReadyError());
}

// ============ 品牌管理 ============

// 获取全系统品牌（系统级，所有人可见）
function getBrands() {
  if (cloudReady()) {
    return callCloud('getBrands', {}).then((r) => (r && r.brands) || []);
  }
  return Promise.resolve(mock.readArray(mock.KEY_BRANDS));
}

// 保存品牌（店主账号下）
function saveShopBrand(brand) {
  if (cloudReady()) {
    return callCloud('saveShopBrand', { brand });
  }
  const brands = mock.readArray(mock.KEY_BRANDS);
  const idx = brands.findIndex((b) => b._id === brand._id);
  if (idx !== -1) {
    brands[idx] = Object.assign({}, brands[idx], brand);
  } else {
    brands.push(Object.assign({ _openid: mock.MOCK_OPENID, createdAt: Date.now() }, brand));
  }
  mock.writeArray(mock.KEY_BRANDS, brands);
  return Promise.resolve({ ok: true });
}

// 获取本店品牌列表
function getShopBrands() {
  if (cloudReady()) {
    return callCloud('getShopBrands', {}).then((r) => (r && r.brands) || []);
  }
  return Promise.resolve(mock.readArray(mock.KEY_BRANDS));
}

// ============ 门店管理 ============

// 获取系统门店（可按 brandId 过滤）
function getStores(brandId) {
  if (cloudReady()) {
    return callCloud('getStores', { brandId }).then((r) => (r && r.stores) || []);
  }
  const stores = mock.readArray(mock.KEY_STORES);
  if (brandId) return Promise.resolve(stores.filter((s) => s.brandId === brandId));
  return Promise.resolve(stores);
}

// 保存本店门店配置（店主新增/修改自己添加的门店）
function saveShopStore(store) {
  if (cloudReady()) {
    return callCheckedCloud('saveShopStore', { store });
  }
  const stores = mock.readArray(mock.KEY_STORES);
  const hasStoreId = Object.prototype.hasOwnProperty.call(store, '_id');
  if (hasStoreId) {
    const idx = stores.findIndex((s) => s._id === store._id);
    if (idx === -1) {
      return Promise.reject(resultError(
        { ok: false, code: 'STORE_NOT_OWNED', msg: 'Store is not owned by the current shop' },
        'Store save failed'
      ));
    }
    stores[idx] = Object.assign({}, stores[idx], store, {
      _id: stores[idx]._id,
      _openid: stores[idx]._openid
    });
    mock.writeArray(mock.KEY_STORES, stores);
    return Promise.resolve({
      ok: true,
      storeId: stores[idx]._id,
      tableTypes: Array.isArray(stores[idx].tableTypes) ? stores[idx].tableTypes : []
    });
  }

  let sequence = stores.length + 1;
  let storeId;
  do {
    storeId = 'mock_store_' + Date.now().toString(36) + '_' + sequence;
    sequence += 1;
  } while (stores.some((item) => item._id === storeId));
  const created = Object.assign({}, store, {
    _id: storeId,
    _openid: mock.MOCK_OPENID,
    createdAt: Date.now()
  });
  stores.push(created);
  mock.writeArray(mock.KEY_STORES, stores);
  return Promise.resolve({
    ok: true,
    storeId,
    tableTypes: Array.isArray(created.tableTypes) ? created.tableTypes : []
  });
}

// 获取本店管理的门店（店主自定义添加的门店）
function getShopStores() {
  if (cloudReady()) {
    return callCloud('getShopStores', {}).then((r) => (r && r.stores) || []);
  }
  const stores = mock.readArray(mock.KEY_STORES);
  console.log('[getShopStores] KEY_STORES count:', stores.length);
  return Promise.resolve(stores);
}

// ============ 球台状态（开桌/结账） ============

function getSessions() {
  if (cloudReady()) {
    return callCloud('getSessions', {}).then((r) => (r && r.sessions) || []);
  }
  return Promise.resolve(mock.readArray(mock.KEY_SESSIONS));
}

// 开桌：支持绑定到店球员 memberOpenid、教学局教练 coachOpenid、门店 storeId、是否已核验 verified。
// hall-status.computeStatus 读取这些字段渲染占用卡（球员/教练头像、助教时长）。
function createSession(input) {
  const event = input || {};
  return callCheckedCloud('createSession', {
    tableId: event.tableId,
    storeId: event.storeId,
    memberOpenid: event.memberOpenid,
    memberCheckinId: event.memberCheckinId,
    coachOpenid: event.coachOpenid,
    coachCheckinId: event.coachCheckinId,
    coachLinkId: event.coachLinkId
  });
}

function closeSession(input) {
  const event = input || {};
  return callCheckedCloud('closeSession', { sessionId: event.sessionId });
}

// ============ 到店打卡核验（B：扫码/选店到店 → 前台确认 → 绑定开台） ============
// 演示阶段 mock 落本地 'dc_checkin_requests'；接真实云端改 callCloud（云函数待部署）。
const KEY_CHECKIN = 'dc_checkin_requests';
const KEY_COACH_LESSONS = 'dc_coach_lessons';
const KEY_COACH_SETTLEMENTS = 'dc_coach_settlements';

function _currentOpenid() {
  const app = getApp();
  return (app && app.globalData && app.globalData.openid) || mock.MOCK_OPENID;
}

// 球员到店：发起待前台确认的到店请求。lat/lng/dist 供"在店内"距离核验留痕。
function requestCheckin({ storeId, storeName, tableId, tableName, nickname, avatar, lat, lng, dist, role, ready, readyAt }) {
  const me = _currentOpenid();
  const now = Date.now();
  const record = {
    _id: `ci_${now}`,
    storeId: storeId || '',
    storeName: storeName || '',
    tableId: tableId || '',
    tableName: tableName || '',
    memberOpenid: me,
    nickname: nickname || '',
    avatar: avatar || '',
    role: role || 'member',
    ready: !!ready,
    joinedAt: now,
    readyAt: ready ? (readyAt || now) : null,
    lat: typeof lat === 'number' ? lat : null,
    lng: typeof lng === 'number' ? lng : null,
    dist: typeof dist === 'number' ? dist : null,
    status: 'pending',
    createdAt: now
  };
  if (cloudReady()) {
    return callCheckedCloud('requestCheckin', {
      storeId: record.storeId,
      tableId: record.tableId,
      nickname: record.nickname,
      avatar: record.avatar,
      role: record.role,
      ready: record.ready
    });
  }
  const arr = mock.readArray(KEY_CHECKIN);
  // 同一球员对同一门店仅保留一条 pending（重复发起覆盖）
  const kept = arr.filter((x) => !(x.memberOpenid === me && x.storeId === record.storeId && (x.tableId || '') === record.tableId && x.status === 'pending'));
  kept.push(record);
  mock.writeArray(KEY_CHECKIN, kept);
  return Promise.resolve({ ok: true, request: record });
}

// 前台：拉取本店待确认的到店请求队列
function getPendingCheckins(storeId) {
  if (cloudReady()) {
    return callCloud('getPendingCheckins', { storeId }).then((r) => (r && r.requests) || []);
  }
  const arr = mock.readArray(KEY_CHECKIN)
    .filter((x) => x.status === 'pending' && (!storeId || x.storeId === storeId))
    .sort((a, b) => a.createdAt - b.createdAt);
  return Promise.resolve(arr);
}

function getTableParticipants(storeId, tableId) {
  if (cloudReady()) {
    return callCloud('getTableParticipants', { storeId, tableId }).then((r) => {
      if (r && r.ok === false) throw resultError(r, '加载球桌参与者失败');
      return (r && r.participants) || [];
    });
  }
  const participants = mock.readArray(KEY_CHECKIN)
    .filter((item) => (
      item.status === 'pending'
      && item.storeId === storeId
      && item.tableId === tableId
    ))
    .map((item) => ({
      nickname: item.nickname || '',
      avatar: item.avatar || '',
      role: item.role === 'coach' ? 'coach' : 'member',
      ready: !!item.ready
    }));
  return Promise.resolve(participants);
}

// 前台：确认 / 拒绝某条到店请求（action: 'confirm' | 'reject'）
function resolveCheckin(requestId, action) {
  if (action !== 'confirm' && action !== 'reject') {
    return Promise.reject(fixedError('INVALID_INPUT'));
  }
  if (cloudReady()) {
    return callBoundary('public', 'resolveCheckin', { requestId }, action);
  }
  const arr = mock.readArray(KEY_CHECKIN);
  const idx = arr.findIndex((x) => x._id === requestId);
  if (idx !== -1) {
    arr[idx].status = action === 'reject' ? 'rejected' : 'confirmed';
    arr[idx].resolvedAt = Date.now();
    mock.writeArray(KEY_CHECKIN, arr);
  }
  return Promise.resolve({ ok: true });
}

// 球员：查询自己在某门店最近一条到店请求状态（pending/confirmed/rejected/none）
function getMyCheckinStatus(storeId) {
  const me = _currentOpenid();
  if (cloudReady()) {
    return callCloud('getMyCheckinStatus', { storeId }).then((r) => (r && r.status) || 'none');
  }
  const list = mock.readArray(KEY_CHECKIN)
    .filter((x) => x.memberOpenid === me && (!storeId || x.storeId === storeId))
    .sort((a, b) => b.createdAt - a.createdAt);
  return Promise.resolve(list.length ? list[0].status : 'none');
}

// 旧客户端裸写入口保留兼容签名，但核验训练只由可信平台支付事务兑现。
function recordVerifiedTraining() {
  return Promise.resolve({ ok: false, code: 'PRODUCT_RETIRED' });
}

// 生成门店"到店码"（小程序码，scene=s=<storeId>）。
// 云端走 genCheckinCode 云函数（wxacode.getUnlimited，需部署 + 真云环境）；
// mock/未部署返回空串，页面用 payload 文本 + 占位兜底。
function genStoreCheckinCode(storeId, tableId, tableName) {
  if (cloudReady()) {
    return callCloud('genCheckinCode', { storeId, tableId: tableId || '', tableName: tableName || '' }).then((r) => (r && (r.fileID || r.image)) || '');
  }
  return Promise.resolve('');
}

// 教练课时列表（默认当前用户；演示单账号下亦可传指定 coachOpenid）
function getCoachLessons(coachOpenid) {
  const who = coachOpenid || _currentOpenid();
  if (cloudReady()) {
    return callCloud('getCoachLessons', { coachOpenid }).then((r) => (r && r.lessons) || []);
  }
  const all = mock.readArray(KEY_COACH_LESSONS).sort((a, b) => b.createdAt - a.createdAt);
  const mine = all.filter((x) => x.coachOpenid === who);
  // 演示为单账号（openid 恒为 local-demo-user），教学局里选的教练是 coach_xx，
  // 与当前 openid 不一致会看不到课时；mock 下若本人无匹配则回退展示全部，便于验收 D 期。
  return Promise.resolve(mine.length ? mine : all);
}

// ============ 教练结算（店主结算本店教练课时费） ============

function _fmtKey(d) { const m = d.getMonth() + 1, day = d.getDate(); return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day); }
// 周期 → 日期区间（含端点）。week=本周一~今天；month=本月1号~今天；all=不限
function _periodRange(period) {
  const end = new Date(); end.setHours(0, 0, 0, 0);
  if (period === 'all') return { fromKey: '', toKey: '' };
  if (period === 'week') {
    const day = end.getDay(); const back = day === 0 ? 6 : day - 1;
    const from = new Date(end.getTime()); from.setDate(end.getDate() - back);
    return { fromKey: _fmtKey(from), toKey: _fmtKey(end) };
  }
  const from = new Date(end.getFullYear(), end.getMonth(), 1);
  return { fromKey: _fmtKey(from), toKey: _fmtKey(end) };
}
function _inPeriod(date, range) { if (!range.fromKey) return true; return date >= range.fromKey && date <= range.toKey; }
function _settlementInPeriod(settlement, range) {
  if (!range.fromKey) return true;
  const from = settlement.periodFrom || '';
  const to = settlement.periodTo || from;
  return (!from || from <= range.toKey) && (!to || to >= range.fromKey);
}
// 本店归属：本店教练 openid 集合 + 本店门店 _id 集合
function _shopScope() {
  const shop = mock.readObject(mock.KEY_SHOP, null) || {};
  const coachOpenids = mock.readArray(mock.KEY_SHOP_COACHES).map((l) => l.coachOpenid);
  const storeIds = mock.readArray(mock.KEY_STORES).map((s) => s._id);
  if (shop.storeId && storeIds.indexOf(shop.storeId) === -1) storeIds.push(shop.storeId);
  return { coachOpenids, storeIds };
}
const _r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// 店主端：本店各教练在指定周期的结算概览
function getShopCoachSettlement(period) {
  if (cloudReady()) return callCloud('getShopCoachSettlement', { period }).then((r) => r || { totalPendingNet: 0, pendingCoachCount: 0, coaches: [] });
  const range = _periodRange(period);
  const { coachOpenids, storeIds } = _shopScope();
  const lessons = mock.readArray(KEY_COACH_LESSONS).filter((l) =>
    coachOpenids.indexOf(l.coachOpenid) !== -1 && storeIds.indexOf(l.hallId) !== -1 && _inPeriod(l.date, range));
  const settlements = mock.readArray(KEY_COACH_SETTLEMENTS).filter((settlement) =>
    coachOpenids.indexOf(settlement.coachOpenid) !== -1 && _settlementInPeriod(settlement, range));
  const allCoaches = mock.readArray(mock.KEY_ALL_COACHES);
  const agg = {};
  lessons.forEach((l) => {
    if (!agg[l.coachOpenid]) agg[l.coachOpenid] = { pendingGross: 0, pendingCount: 0, settledNet: 0 };
    const a = Number(l.amount) || 0;
    if (!l.settled) { agg[l.coachOpenid].pendingGross += a; agg[l.coachOpenid].pendingCount += 1; }
  });
  settlements.forEach((settlement) => {
    if (!agg[settlement.coachOpenid]) agg[settlement.coachOpenid] = { pendingGross: 0, pendingCount: 0, settledNet: 0 };
    agg[settlement.coachOpenid].settledNet += Number(settlement.netAmount) || 0;
  });
  let totalPendingNet = 0, pendingCoachCount = 0;
  const coaches = coachOpenids.map((openid) => {
    const g = agg[openid] || { pendingGross: 0, pendingCount: 0, settledNet: 0 };
    const c = allCoaches.find((x) => x.openid === openid) || {};
    const pendingCommission = billing.calcCoachCommission(g.pendingGross);
    const pendingNet = _r2(g.pendingGross - pendingCommission);
    const settledNet = _r2(g.settledNet);
    if (g.pendingCount > 0) { totalPendingNet += pendingNet; pendingCoachCount += 1; }
    return { coachOpenid: openid, nickname: c.nickname || '教练', avatar: c.avatar || mock.avatarFor(openid),
      pendingCount: g.pendingCount, pendingGross: g.pendingGross, pendingCommission, pendingNet, settledNet };
  }).sort((a, b) => b.pendingNet - a.pendingNet || b.settledNet - a.settledNet);
  return Promise.resolve({ totalPendingNet: _r2(totalPendingNet), pendingCoachCount, coaches });
}

// 店主端：单个教练在指定周期的结算明细（待/已结算课时 + 待结算汇总）
function getCoachSettlementDetail(coachOpenid, period) {
  if (cloudReady()) return callCloud('getCoachSettlementDetail', { coachOpenid, period }).then((r) => r || { pending: [], settled: [], summary: { gross: 0, commission: 0, net: 0 } });
  const range = _periodRange(period);
  const { storeIds } = _shopScope();
  const lessons = mock.readArray(KEY_COACH_LESSONS)
    .filter((l) => l.coachOpenid === coachOpenid && storeIds.indexOf(l.hallId) !== -1 && _inPeriod(l.date, range))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const pending = lessons.filter((l) => !l.settled);
  const settled = lessons.filter((l) => l.settled);
  const gross = pending.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const commission = billing.calcCoachCommission(gross);
  const c = mock.readArray(mock.KEY_ALL_COACHES).find((x) => x.openid === coachOpenid) || {};
  return Promise.resolve({ coachOpenid, nickname: c.nickname || '教练', summary: { gross, commission, net: _r2(gross - commission) }, pending, settled });
}

// 店主端：结清某教练当前周期的待结算课时（标记 settled + 写一笔结算流水）。幂等。
function settleCoach(coachOpenid, period) {
  if (cloudReady()) return callCloud('settleCoach', { coachOpenid, period });
  const range = _periodRange(period);
  const { storeIds } = _shopScope();
  const all = mock.readArray(KEY_COACH_LESSONS);
  const targets = all.filter((l) => l.coachOpenid === coachOpenid && !l.settled && storeIds.indexOf(l.hallId) !== -1 && _inPeriod(l.date, range));
  if (!targets.length) return Promise.resolve({ ok: false, msg: '无待结算课时' });
  const gross = targets.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const commission = billing.calcCoachCommission(gross);
  const net = _r2(gross - commission);
  const c = mock.readArray(mock.KEY_ALL_COACHES).find((x) => x.openid === coachOpenid) || {};
  const settlementId = `stl_${Date.now()}`;
  const now = Date.now();
  const settlements = mock.readArray(mock.KEY_COACH_SETTLEMENTS);
  settlements.push({ _id: settlementId, shopOpenid: mock.MOCK_OPENID, coachOpenid, coachNickname: c.nickname || '教练',
    lessonCount: targets.length, grossAmount: gross, commission, netAmount: net, periodFrom: range.fromKey, periodTo: range.toKey, createdAt: now });
  mock.writeArray(mock.KEY_COACH_SETTLEMENTS, settlements);
  const ids = {}; targets.forEach((t) => { ids[t._id] = true; });
  all.forEach((l) => { if (ids[l._id]) { l.settled = true; l.settledAt = now; l.settlementId = settlementId; } });
  mock.writeArray(KEY_COACH_LESSONS, all);
  return Promise.resolve({ ok: true, netAmount: net, lessonCount: targets.length });
}

// ============ 经营数据看板（今日快照 + 近 rangeDays 天关键数 + 营收按天趋势） ============

function _emptyFinanceReport() {
  return {
    legacyRevenueYuan: 0,
    platformPaidFen: 0,
    externalPaidFen: 0,
    platformCoverageBps: 0,
    shopNetTargetFen: 0,
    totalCostFen: 0,
    channelFeeFen: 0,
    platformNetFen: 0,
    manualReviewFen: 0,
    legacyOrderCount: 0,
    platformOrderCount: 0,
    externalOrderCount: 0,
    manualReviewOrderCount: 0,
    externalReasonDistribution: [],
    total: 0
  };
}

function _emptyBiz(days) {
  const dates = []; const base = new Date(); base.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) { const d = new Date(base.getTime()); d.setDate(base.getDate() - i); dates.push(_fmtKey(d)); }
  return {
    today: Object.assign(_emptyFinanceReport(), { revenue: 0, opens: 0, activeMembers: 0, lessons: 0 }),
    range: Object.assign(_emptyFinanceReport(), { revenue: 0, opens: 0, activeMembers: 0, lessons: 0 }),
    trend: dates.map((d) => Object.assign({ date: d, revenue: 0 }, _emptyFinanceReport()))
  };
}

function getShopBizOverview(rangeDays) {
  const days = rangeDays === 30 ? 30 : 7;
  if (cloudReady()) return callCloud('getShopBizOverview', { rangeDays: days }).then((r) => r || _emptyBiz(days));
  const base = new Date(); base.setHours(0, 0, 0, 0);
  const todayKey = _fmtKey(base);
  const dates = [];
  for (let i = days - 1; i >= 0; i--) { const d = new Date(base.getTime()); d.setDate(base.getDate() - i); dates.push(_fmtKey(d)); }
  const fromKey = dates[0];
  const inR = (dk) => dk >= fromKey && dk <= todayKey;
  const { coachOpenids, storeIds } = _shopScope();
  const memberOpenids = mock.readArray(mock.KEY_MEMBERS).map((m) => m.openid);

  const byDay = {}, opensByDay = {};
  let revenue = 0, opens = 0, todayRevenue = 0, todayOpens = 0;
  mock.readArray('dc_shop_orders').forEach((o) => {
    if (!inR(o.date) || o.schemaVersion === 2) return;
    const a = Number(o.amount) || 0;
    revenue += a; opens += 1; byDay[o.date] = (byDay[o.date] || 0) + a;
    opensByDay[o.date] = (opensByDay[o.date] || 0) + 1;
    if (o.date === todayKey) { todayRevenue += a; todayOpens += 1; }
  });
  const trend = dates.map((d) => {
    const legacyRevenueYuan = _r2(byDay[d] || 0);
    return Object.assign({ date: d, revenue: legacyRevenueYuan }, _emptyFinanceReport(), {
      legacyRevenueYuan,
      legacyOrderCount: opensByDay[d] || 0,
      total: legacyRevenueYuan
    });
  });

  const memSet = {}, memTodaySet = {};
  mock.readArray(mock.KEY_SESSIONS).forEach((s) => {
    if (!inR(s.date) || storeIds.indexOf(s.hallId) === -1 || memberOpenids.indexOf(s._openid) === -1) return;
    memSet[s._openid] = 1; if (s.date === todayKey) memTodaySet[s._openid] = 1;
  });

  let lessons = 0, todayLessons = 0;
  mock.readArray(KEY_COACH_LESSONS).forEach((l) => {
    if (!inR(l.date) || coachOpenids.indexOf(l.coachOpenid) === -1 || storeIds.indexOf(l.hallId) === -1) return;
    lessons += 1; if (l.date === todayKey) todayLessons += 1;
  });

  const todayLegacyRevenueYuan = _r2(todayRevenue);
  const rangeLegacyRevenueYuan = _r2(revenue);
  return Promise.resolve({
    today: Object.assign(_emptyFinanceReport(), {
      legacyRevenueYuan: todayLegacyRevenueYuan,
      legacyOrderCount: todayOpens,
      total: todayLegacyRevenueYuan,
      revenue: todayLegacyRevenueYuan,
      opens: todayOpens,
      activeMembers: Object.keys(memTodaySet).length,
      lessons: todayLessons
    }),
    range: Object.assign(_emptyFinanceReport(), {
      legacyRevenueYuan: rangeLegacyRevenueYuan,
      legacyOrderCount: opens,
      total: rangeLegacyRevenueYuan,
      revenue: rangeLegacyRevenueYuan,
      opens,
      activeMembers: Object.keys(memSet).length,
      lessons
    }),
    trend
  });
}

// ============ 球员列表（按 openid 查昵称/头像，供 hall-status 渲染） ============

function getMembers() {
  if (cloudReady()) {
    return callCloud('getMembers', {}).then((r) => (r && r.members) || []);
  }
  return Promise.resolve(mock.readArray(mock.KEY_MEMBERS));
}

// 本店已管理的教练列表
function getShopCoaches() {
  if (cloudReady()) {
    return callCloud('getShopCoaches', {}).then((r) => (r && r.coaches) || []);
  }
  const links = mock.readArray(mock.KEY_SHOP_COACHES);
  const linkedOpenids = links.map((l) => l.coachOpenid);
  const allCoaches = mock.readArray(mock.KEY_ALL_COACHES);
  const filtered = allCoaches
    .filter((c) => linkedOpenids.indexOf(c.openid) !== -1)
    .map((c) => {
      const link = links.find((l) => l.coachOpenid === c.openid) || {};
      return Object.assign({}, c, {
        hallId: link.storeId || c.hallId || '',
        hallName: link.storeName || c.hallName || '',
        linkId: link._id || ''
      });
    });
  console.log('[getShopCoaches] links:', links.length, 'openids:', linkedOpenids, 'coaches:', filtered.length);
  return Promise.resolve(filtered);
}

// 可添加（尚未被本店管理）的教练列表
function getLinkableCoaches() {
  if (cloudReady()) {
    return callCloud('getLinkableCoaches', {}).then((r) => (r && r.coaches) || []);
  }
  const links = mock.readArray(mock.KEY_SHOP_COACHES);
  const linkedOpenids = links.map((l) => l.coachOpenid);
  return Promise.resolve(
    mock
      .readArray(mock.KEY_ALL_COACHES)
      .filter((c) => linkedOpenids.indexOf(c.openid) === -1)
  );
}

function addShopCoach(coachOpenid, store) {
  if (cloudReady()) {
    return callCloud('addShopCoach', { coachOpenid, storeId: store && store.storeId, storeName: store && store.storeName });
  }
  const links = mock.readArray(mock.KEY_SHOP_COACHES);
  if (links.some((l) => l.coachOpenid === coachOpenid)) {
    return Promise.resolve({ ok: true, msg: '已添加' });
  }
  links.push({
    _id: 'mock_scl_' + Date.now(),
    shopOpenid: mock.MOCK_OPENID,
    coachOpenid,
    storeId: (store && store.storeId) || '',
    storeName: (store && store.storeName) || '',
    status: 'active',
    source: 'shop_add',
    createdAt: Date.now()
  });
  mock.writeArray(mock.KEY_SHOP_COACHES, links);
  return Promise.resolve({ ok: true });
}

function applyCoachShopBinding({ storeId, coachNickname, coachAvatar, intro }) {
  if (cloudReady()) {
    return callCloud('applyCoachShopBinding', { storeId, coachNickname, coachAvatar, intro });
  }
  if (!storeId) return Promise.resolve({ ok: false, msg: '请选择球厅' });
  const store = mock.readArray(mock.KEY_STORES).find((s) => s._id === storeId);
  if (!store) return Promise.resolve({ ok: false, msg: '球厅不存在' });
  const apps = mock.readArray(mock.KEY_COACH_SHOP_APPLICATIONS);
  const now = Date.now();
  const idx = apps.findIndex((a) => a.coachOpenid === mock.MOCK_OPENID && a.storeId === storeId);
  const record = {
    _id: idx !== -1 ? apps[idx]._id : 'mock_csa_' + now,
    _openid: mock.MOCK_OPENID,
    coachOpenid: mock.MOCK_OPENID,
    coachNickname: coachNickname || '',
    coachAvatar: coachAvatar || '',
    intro: intro || '',
    shopOpenid: store._openid || mock.MOCK_OPENID,
    storeId,
    storeName: store.name || '',
    status: 'pending',
    reason: '',
    createdAt: idx !== -1 ? apps[idx].createdAt : now,
    updatedAt: now
  };
  if (idx !== -1) apps[idx] = record;
  else apps.push(record);
  mock.writeArray(mock.KEY_COACH_SHOP_APPLICATIONS, apps);
  return Promise.resolve({ ok: true, id: record._id, status: 'pending' });
}

function getMyCoachShopBindingStatus() {
  if (cloudReady()) {
    return callCloud('getMyCoachShopBindingStatus', {}).then((r) => r || { ok: true, status: 'none' });
  }
  const link = mock.readArray(mock.KEY_SHOP_COACHES).find((l) => l.coachOpenid === mock.MOCK_OPENID && l.status === 'active');
  if (link) return Promise.resolve({ ok: true, status: 'approved', link, application: null });
  const apps = mock.readArray(mock.KEY_COACH_SHOP_APPLICATIONS)
    .filter((a) => a.coachOpenid === mock.MOCK_OPENID)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const application = apps[0] || null;
  return Promise.resolve({ ok: true, status: application ? application.status : 'none', link: null, application });
}

function getCoachBindingApplications(status = 'pending') {
  if (cloudReady()) {
    return callCloud('getCoachBindingApplications', { status }).then((r) => (r && r.applications) || []);
  }
  const list = mock.readArray(mock.KEY_COACH_SHOP_APPLICATIONS)
    .filter((a) => a.shopOpenid === mock.MOCK_OPENID && (status === 'all' || a.status === status))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return Promise.resolve(list);
}

function reviewCoachBindingApplication({ applicationId, approve, reason }) {
  if (cloudReady()) {
    return callCloud('reviewCoachBindingApplication', { applicationId, approve, reason });
  }
  const apps = mock.readArray(mock.KEY_COACH_SHOP_APPLICATIONS);
  const idx = apps.findIndex((a) => a._id === applicationId);
  if (idx === -1) return Promise.resolve({ ok: false, msg: '申请不存在' });
  const app = apps[idx];
  if (app.shopOpenid !== mock.MOCK_OPENID) return Promise.resolve({ ok: false, msg: '无权审核该申请' });
  app.status = approve ? 'approved' : 'rejected';
  app.reason = approve ? '' : (reason || '店家未通过绑定申请');
  app.reviewedBy = mock.MOCK_OPENID;
  app.reviewedAt = Date.now();
  app.updatedAt = Date.now();
  apps[idx] = app;
  mock.writeArray(mock.KEY_COACH_SHOP_APPLICATIONS, apps);

  if (approve) {
    const links = mock.readArray(mock.KEY_SHOP_COACHES);
    const linkIdx = links.findIndex((l) => l.shopOpenid === mock.MOCK_OPENID && l.coachOpenid === app.coachOpenid && l.storeId === app.storeId);
    const link = {
      _id: linkIdx !== -1 ? links[linkIdx]._id : 'mock_scl_' + Date.now(),
      shopOpenid: mock.MOCK_OPENID,
      coachOpenid: app.coachOpenid,
      storeId: app.storeId,
      storeName: app.storeName || '',
      status: 'active',
      source: 'coach_apply',
      applicationId,
      createdAt: linkIdx !== -1 ? links[linkIdx].createdAt : Date.now(),
      updatedAt: Date.now()
    };
    if (linkIdx !== -1) links[linkIdx] = link;
    else links.push(link);
    mock.writeArray(mock.KEY_SHOP_COACHES, links);
    const profile = mock.readObject(USER_PROFILE_KEY, null) || {};
    const roles = Array.from(new Set([].concat(profile.roles || [], profile.role || 'member', ['member', 'coach'])))
      .filter((role) => VALID_ROLES.indexOf(role) !== -1);
    const currentRole = profile.currentRole || profile.role || mock.getRole() || 'member';
    const updatedProfile = Object.assign({}, profile, {
      roles,
      currentRole,
      role: profile.role || currentRole,
      updatedAt: Date.now()
    });
    mock.writeObject(USER_PROFILE_KEY, updatedProfile);
    const appInstance = typeof getApp === 'function' ? getApp() : null;
    if (appInstance && appInstance.globalData) {
      appInstance.globalData.roles = roles;
      appInstance.globalData.userProfile = Object.assign({}, appInstance.globalData.userProfile || {}, updatedProfile);
    }
  }
  return Promise.resolve({ ok: true, status: app.status });
}

function removeShopCoach(coachOpenid) {
  if (cloudReady()) {
    return callCloud('removeShopCoach', { coachOpenid });
  }
  const links = mock.readArray(mock.KEY_SHOP_COACHES).filter((l) => l.coachOpenid !== coachOpenid);
  mock.writeArray(mock.KEY_SHOP_COACHES, links);
  return Promise.resolve({ ok: true });
}

// 某位教练给哪些球员上过课：返回会员列表 [{ openid, nickname, avatar }]
function getCoachStudents(coachOpenid) {
  if (cloudReady()) {
    return callCloud('getCoachStudents', { coachOpenid }).then(
      (r) => (r && r.students) || []
    );
  }
  return Promise.resolve(mock.coachStudents(coachOpenid));
}

// 本店会员训练统计：{ openid, nickname, checkinDays, totalMinutes }
// storeId 可选：指定门店时按该门店过滤；否则用 shop.storeId
function getShopMembers(storeId) {
  if (cloudReady()) {
    return callCloud('getShopMembers', { storeId }).then((r) => (r && r.members) || []);
  }
  const shop = mock.readObject(mock.KEY_SHOP, null);
  const targetStoreId = storeId || (shop && shop.storeId);
  console.log('[getShopMembers] shop:', JSON.stringify(shop), 'targetStoreId:', targetStoreId);
  if (!targetStoreId) return Promise.resolve([]);

  const sessions = mock.readArray(mock.KEY_SESSIONS).filter((s) => s.hallId === targetStoreId);
  console.log('[getShopMembers] sessions for hallId', targetStoreId, ':', sessions.length);
  const agg = {};
  sessions.forEach((s) => {
    if (!agg[s._openid]) agg[s._openid] = { totalMinutes: 0, days: {} };
    agg[s._openid].totalMinutes += s.durationMinutes || 0;
    agg[s._openid].days[s.date] = true;
  });

  // 合并店主手动添加（扫码 / 输入编码）的会员：本店尚无训练记录时也应出现，统计计为 0
  mock.readArray(mock.KEY_SHOP_MEMBERS)
    .filter((l) => l.memberOpenid && (!l.storeId || l.storeId === targetStoreId))
    .forEach((l) => {
      if (!agg[l.memberOpenid]) agg[l.memberOpenid] = { totalMinutes: 0, days: {} };
    });

  const members = Object.keys(agg)
    .map((openid) => ({
      openid,
      nickname: mockNickname(openid),
      avatar: mock.avatarFor(openid),
      checkinDays: Object.keys(agg[openid].days).length,
      totalMinutes: agg[openid].totalMinutes
    }))
    .sort((a, b) => b.totalMinutes - a.totalMinutes);

  return Promise.resolve(members);
}

// 店主手动添加会员（扫码 / 输入编码后落地）。mock 写 KEY_SHOP_MEMBERS 关系表（按门店）。
function addShopMember(memberOpenid, storeId) {
  if (!memberOpenid) return Promise.resolve({ ok: false, msg: '无效会员' });
  if (cloudReady()) {
    return callCloud('addShopMember', { memberOpenid, storeId });
  }
  const shop = mock.readObject(mock.KEY_SHOP, null);
  const sid = storeId || (shop && shop.storeId) || '';
  const links = mock.readArray(mock.KEY_SHOP_MEMBERS);
  if (links.some((l) => l.memberOpenid === memberOpenid && (l.storeId || '') === sid)) {
    return Promise.resolve({ ok: true, msg: '已添加' });
  }
  links.push({ shopOpenid: mock.MOCK_OPENID, storeId: sid, memberOpenid, status: 'active', createdAt: Date.now() });
  mock.writeArray(mock.KEY_SHOP_MEMBERS, links);
  return Promise.resolve({ ok: true });
}

// ============ 文件上传 ============

// 上传一张本地图片，返回可用于展示/存储的地址。
// 云端模式上传到云存储返回 fileID；mock 模式直接返回本地临时路径。
function uploadImage(tempFilePath) {
  return uploadFile(tempFilePath, 'coach');
}

function uploadPathError() {
  return Object.assign(new Error('上传路径或账号身份无效'), { code: 'INVALID_UPLOAD_PATH' });
}

function isSafeUploadNamespace(value) {
  return /^[0-9a-f]{64}$/.test(String(value || ''));
}

function resolveUploadNamespace() {
  const app = typeof getApp === 'function' ? getApp() : null;
  const current = app && app.globalData && app.globalData.storageNamespace;
  if (isSafeUploadNamespace(current)) return Promise.resolve(current);
  if (uploadIdentityPromise) return uploadIdentityPromise;
  uploadIdentityPromise = getUserProfile().then((user) => {
    const namespace = user && user.storageNamespace;
    if (!isSafeUploadNamespace(namespace)) throw uploadPathError();
    return namespace;
  });
  uploadIdentityPromise.then(
    () => { uploadIdentityPromise = null; },
    () => { uploadIdentityPromise = null; }
  );
  return uploadIdentityPromise;
}

// 通用文件上传（图片 / 视频）。dir 为云存储目录前缀。
function uploadFile(tempFilePath, dir) {
  if (cloudReady()) {
    const ext = (tempFilePath.split('.').pop() || 'dat').toLowerCase().split('?')[0];
    const directory = String(dir || 'misc');
    if (!/^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(directory)) {
      return Promise.reject(uploadPathError());
    }
    const safeExt = /^[a-z0-9]{1,10}$/.test(ext) ? ext : 'dat';
    return resolveUploadNamespace().then((namespace) => {
      const filename = `${Date.now()}-${Math.floor(Math.random() * 1e6)}.${safeExt}`;
      const cloudPath = `user-content/${namespace}/${directory}/${filename}`;
      return wx.cloud.uploadFile({ cloudPath, filePath: tempFilePath }).then((res) => res.fileID);
    });
  }
  return Promise.resolve(tempFilePath);
}

// ============ 社区 ============

function getCurrentUserInfo() {
  const app = getApp();
  const profile = app && app.globalData && app.globalData.userProfile;
  if (profile && (profile.nickname || profile.avatar)) {
    return {
      authorName: profile.nickname || '大川会员',
      authorAvatar: profile.avatar || ''
    };
  }
  return { authorName: '大川会员', authorAvatar: '' };
}

// tab: 'discover' | 'follow' | 'region'；region 为 tab==='region' 时的城市名
function getFeed({ page = 0, pageSize = 20, tab = 'discover', region = '' } = {}) {
  if (cloudReady()) {
    return callCloud('getFeed', { page, pageSize, tab, region }).then(
      (r) => (r && r.posts) || []
    );
  }
  let posts = mock.readArray(mock.KEY_POSTS).slice();
  const currentOpenid = (getApp().globalData && getApp().globalData.openid) || mock.MOCK_OPENID;
  if (tab === 'follow') {
    const follows = mock.readArray(mock.KEY_FOLLOWS);
    posts = posts.filter((p) => isFollowing(follows, currentOpenid, p._openid));
  } else if (tab === 'region') {
    posts = posts.filter((p) => p.region === region);
  }
  posts = posts.filter((p) => canViewPost(p, currentOpenid, region));
  posts.sort((a, b) => b.createdAt - a.createdAt);
  return Promise.resolve(posts.slice(page * pageSize, (page + 1) * pageSize));
}

// ============ 关注 ============

function getFollows() {
  if (cloudReady()) {
    return callCloud('getFollows', {}).then((r) => (r && r.follows) || []);
  }
  const currentOpenid = (getApp().globalData && getApp().globalData.openid) || mock.MOCK_OPENID;
  return Promise.resolve(
    mock.readArray(mock.KEY_FOLLOWS)
      .filter((item) => isFollowFrom(item, currentOpenid))
      .map((item) => followTarget(item))
      .filter(Boolean)
  );
}

function toggleFollow(authorOpenid) {
  if (cloudReady()) {
    return callCloud('toggleFollow', { authorOpenid });
  }
  const follows = mock.readArray(mock.KEY_FOLLOWS);
  const currentOpenid = (getApp().globalData && getApp().globalData.openid) || mock.MOCK_OPENID;
  const idx = follows.findIndex((item) => isFollowRelation(item, currentOpenid, authorOpenid));
  let following;
  if (idx !== -1) {
    follows.splice(idx, 1);
    following = false;
  } else {
    follows.push({ _openid: currentOpenid, authorOpenid, createdAt: Date.now() });
    following = true;
  }
  mock.writeArray(mock.KEY_FOLLOWS, follows);
  return Promise.resolve({ ok: true, following });
}

// ============ 定位城市 ============

// 主要城市经纬度中心，用于免密钥的"就近城市"匹配
const CITY_CENTERS = [
  { city: '北京', lat: 39.9, lng: 116.4 },
  { city: '上海', lat: 31.23, lng: 121.47 },
  { city: '广州', lat: 23.13, lng: 113.26 },
  { city: '深圳', lat: 22.54, lng: 114.06 },
  { city: '成都', lat: 30.57, lng: 104.07 },
  { city: '杭州', lat: 30.27, lng: 120.16 },
  { city: '青岛', lat: 36.07, lng: 120.38 },
  { city: '昆明', lat: 25.04, lng: 102.71 },
  { city: '武汉', lat: 30.59, lng: 114.3 },
  { city: '西安', lat: 34.34, lng: 108.94 },
  { city: '重庆', lat: 29.56, lng: 106.55 },
  { city: '南京', lat: 32.06, lng: 118.8 },
  { city: '天津', lat: 39.13, lng: 117.2 },
  { city: '沈阳', lat: 41.8, lng: 123.43 }
];

function nearestCity(lat, lng) {
  let best = CITY_CENTERS[0];
  let min = Infinity;
  CITY_CENTERS.forEach((c) => {
    const d = (c.lat - lat) * (c.lat - lat) + (c.lng - lng) * (c.lng - lng);
    if (d < min) {
      min = d;
      best = c;
    }
  });
  return best.city;
}

// 解析当前城市：取经纬度后就近匹配。未授权/失败返回空串。
function resolveCity() {
  return new Promise((resolve) => {
    wx.getLocation({
      type: 'gcj02',
      success: (res) => resolve(nearestCity(res.latitude, res.longitude)),
      fail: () => resolve('')
    });
  });
}

// 取用户当前经纬度（gcj02）。未授权/失败返回 null（调用方自行降级）。
function getUserLatLng() {
  return new Promise((resolve) => {
    wx.getLocation({
      type: 'gcj02',
      success: (res) => resolve({ lat: res.latitude, lng: res.longitude }),
      fail: () => resolve(null)
    });
  });
}

// 两点球面距离（km），保留 1 位小数；任一坐标缺失返回 null。
function distanceKm(lat1, lng1, lat2, lng2) {
  const nums = [lat1, lng1, lat2, lng2];
  if (nums.some((v) => typeof v !== 'number' || isNaN(v))) return null;
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const a = sinLat * sinLat + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * sinLng * sinLng;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
}

function resolveCityFromLocation(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return '';
  return nearestCity(lat, lng);
}

function followSource(item) {
  if (typeof item === 'string') return mock.MOCK_OPENID;
  return item && item._openid;
}

function followTarget(item) {
  if (typeof item === 'string') return item;
  return item && item.authorOpenid;
}

function isFollowFrom(item, openid) {
  return followSource(item) === openid;
}

function isFollowRelation(item, fromOpenid, toOpenid) {
  return followSource(item) === fromOpenid && followTarget(item) === toOpenid;
}

function isFollowing(follows, fromOpenid, toOpenid) {
  return follows.some((item) => isFollowRelation(item, fromOpenid, toOpenid));
}

function isMutualFollow(follows, openidA, openidB) {
  return isFollowing(follows, openidA, openidB) && isFollowing(follows, openidB, openidA);
}

function normalizeVisibility(visibility) {
  return ['public', 'region', 'mutual', 'private'].indexOf(visibility) !== -1 ? visibility : 'public';
}

function canViewPost(post, currentOpenid, region) {
  const visibility = normalizeVisibility(post && post.visibility);
  if (!post) return false;
  if (post._openid === currentOpenid) return true;
  if (visibility === 'private') return false;
  if (visibility === 'region') {
    return !!(region && post.region === region);
  }
  if (visibility === 'mutual') {
    return isMutualFollow(mock.readArray(mock.KEY_FOLLOWS), currentOpenid, post._openid);
  }
  return true;
}

// 按门店 region 找城市中心坐标兜底
function _cityCenter(region) {
  const c = CITY_CENTERS.find((x) => region && region.indexOf(x.city) !== -1);
  return c || CITY_CENTERS[0];
}

// 确定性微抖动（±约 5km），让无坐标门店在地图上不重叠
function _hashJitter(seed) {
  let h = 0;
  const str = String(seed || '');
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  const dy = ((h % 1000) / 1000 - 0.5) * 0.1;
  const dx = (((h >>> 10) % 1000) / 1000 - 0.5) * 0.1;
  return { dx, dy };
}

// 补全门店坐标：已有 lat/lng 直接返回；否则按 region 城市中心 + 确定性抖动兜底。
// 用于兼容"老种子数据"（升级前已落库、无坐标字段）与未选点的门店。
function ensureStoreGeo(store) {
  if (store && typeof store.lat === 'number' && typeof store.lng === 'number') return store;
  const center = _cityCenter(store && store.region);
  const j = _hashJitter(store && store._id);
  return Object.assign({}, store, { lat: center.lat + j.dy, lng: center.lng + j.dx });
}

// 门店是否为"系统种子/官方店"（用于老数据默认开启到店打卡）
function _isSeedStore(s) {
  const id = (s && s._id) || '';
  return !!(s && (s.isSeed || /^hall_/.test(id) || /seed/.test(id)));
}

// ============ 约球 ============

// 约球友：邀约列表（附加发布者段位）
function getMatchPosts() {
  if (cloudReady()) {
    return callCloud('getMatchPosts', {}).then((r) => (r && r.matches) || []);
  }
  const matches = mock
    .readArray(mock.KEY_MATCHES)
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt);
  const members = mock.readArray(mock.KEY_MEMBERS);
  const memberMap = {};
  members.forEach((m) => { memberMap[m.openid] = m; });
    const enriched = matches.map((m) => {
      const author = memberMap[m._openid];
      const myLevel = m.myLevel || (author ? author.level : '') || '';
      const targetLevel = m.targetLevel || m.level || (author ? author.level : '') || '';
      return Object.assign({}, m, { myLevel, targetLevel });
    });
  return Promise.resolve(enriched);
}

function createMatchPost({ hallId, hallName, datetime, gameType, note, myLevel, targetLevel, gender, age }) {
  const info = getCurrentUserInfo();
  if (cloudReady()) {
    return callCloud('createMatchPost', {
      hallId,
      hallName,
      datetime,
      gameType,
      note,
      myLevel,
      targetLevel,
      gender,
      age,
      authorName: info.authorName
    });
  }
  const matches = mock.readArray(mock.KEY_MATCHES);
  const id = `mock_m_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  matches.push({
    _id: id,
    _openid: mock.MOCK_OPENID,
    authorName: info.authorName,
    hallId: hallId || '',
    hallName: hallName || '',
    datetime: datetime || '',
    gameType: gameType || '',
    myLevel: myLevel || '',
    targetLevel: targetLevel || '',
    gender: gender || '',
    age: age || '',
    note: note || '',
    joinCount: 0,
    status: 'open',
    createdAt: Date.now()
  });
  mock.writeArray(mock.KEY_MATCHES, matches);
  return Promise.resolve({ ok: true, id });
}

function joinMatch(matchId) {
  if (cloudReady()) {
    return callCloud('joinMatch', { matchId });
  }
  const joins = mock.readArray(mock.KEY_JOINS);
  if (joins.some((j) => j.matchId === matchId && j._openid === mock.MOCK_OPENID)) {
    const m0 = mock.readArray(mock.KEY_MATCHES).find((x) => x._id === matchId);
    return Promise.resolve({ ok: true, already: true, joinCount: m0 ? m0.joinCount : 0 });
  }
  const matches = mock.readArray(mock.KEY_MATCHES);
  const m = matches.find((x) => x._id === matchId);
  if (m) m.joinCount = (m.joinCount || 0) + 1;
  mock.writeArray(mock.KEY_MATCHES, matches);
  if (m) {
    joins.push({
      _id: `mock_j_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      _openid: mock.MOCK_OPENID,
      matchId,
      authorName: m.authorName,
      hallName: m.hallName,
      datetime: m.datetime,
      gameType: m.gameType,
      createdAt: Date.now()
    });
    mock.writeArray(mock.KEY_JOINS, joins);
  }
  return Promise.resolve({ ok: true, joinCount: m ? m.joinCount : 0 });
}

// 获取某场约球的已报名用户列表
function getMatchJoiners(matchId) {
  if (!matchId) return Promise.resolve([]);
  if (cloudReady()) {
    return callCloud('getMatchJoiners', { matchId }).then((r) => (r && r.joiners) || []);
  }
  const joins = mock.readArray(mock.KEY_JOINS).filter((j) => j.matchId === matchId);
  return Promise.resolve(joins);
}

// 我报名的球局
function getMyJoins() {
  if (cloudReady()) {
    return callCloud('getMyJoins', {}).then((r) => (r && r.joins) || []);
  }
  return Promise.resolve(
    mock
      .readArray(mock.KEY_JOINS)
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
  );
}

function cancelJoin(joinId, matchId) {
  if (cloudReady()) {
    return callCloud('cancelJoin', { joinId, matchId });
  }
  const joins = mock.readArray(mock.KEY_JOINS).filter((j) => j._id !== joinId);
  mock.writeArray(mock.KEY_JOINS, joins);
  const matches = mock.readArray(mock.KEY_MATCHES);
  const m = matches.find((x) => x._id === matchId);
  if (m && m.joinCount > 0) m.joinCount -= 1;
  mock.writeArray(mock.KEY_MATCHES, matches);
  return Promise.resolve({ ok: true });
}

// 教练端：谁约了我（约教练且 targetId 为当前用户）
function getCoachBookings() {
  if (cloudReady()) {
    return callCloud('getCoachBookings', {}).then((r) => (r && r.bookings) || []);
  }
  return Promise.resolve(
    mock
      .readArray(mock.KEY_BOOKINGS)
      .filter(
        (b) =>
          b.type === 'coach' &&
          b.targetId === mock.MOCK_OPENID &&
          b.status !== 'cancelled'
      )
      .sort((a, b) => b.createdAt - a.createdAt)
  );
}

// 约教练：可预约教练列表
function getBookableCoaches() {
  if (cloudReady()) {
    return callCloud('getCoaches', {}).then((r) => (r && r.coaches) || []);
  }
  return Promise.resolve(
    mock.readArray(mock.KEY_ALL_COACHES).map((c) => Object.assign({}, c))
  );
}

// 约球桌：可预约球桌（按门店）。合成桌位数量与每小时价格用于演示。
// 优先取该门店的 tableTypes（{name, pricePerHour} 对象数组），否则用 stores 默认值。
// 云端模式下 getStores 已固定返回"强化杆迹台球俱乐部"种子门店，stores.length ≥ 1 不会走 fallback；
// fallbackStores 仅在云端完全失败时作为最后兜底。
function getBookableTables() {
  const synth = {
    hall_01: { tableCount: 12 },
    hall_02: { tableCount: 8 },
    hall_03: { tableCount: 6 },
    seed_store_dachuan_flag: { tableCount: 12 }
  };
  const defaultTypes = [{ name: '乔氏金腿', pricePerHour: 78 }, { name: '乔氏银腿', pricePerHour: 68 }];
  const fallbackStores = [
    { _id: 'seed_store_dachuan_flag', brandId: 'seed_brand_dachuan', name: '强化杆迹台球俱乐部', address: '北京·朝阳区国贸 CBD 中心', cover: '', isSeed: true, tableTypes: [{ name: '乔氏金腿', pricePerHour: 78 }, { name: '乔氏银腿', pricePerHour: 68 }, { name: '美洲豹', pricePerHour: 58 }] }
  ];
  return getStores().then((stores) => {
    const raw = stores.length ? stores : fallbackStores;
    return raw
      .map((s) => ensureStoreGeo(s))
      .map((s) => {
        // 仅开启到店打卡的合作门店出现在约球桌/地图找店；该开关免费开放。
        const enabled = s.checkinEnabled === undefined ? _isSeedStore(s) : !!s.checkinEnabled;
        return Object.assign({}, s, { checkinEnabled: enabled });
      })
      .filter((s) => s.checkinEnabled)
      .map((s) => {
        const base = synth[s._id] || { tableCount: 8 };
        const hallShopTableTypes = (s.tableTypes && s.tableTypes.length) ? s.tableTypes : defaultTypes;
        return Object.assign({}, s, base, { tableTypes: hallShopTableTypes });
      });
  });
}

// 按 _id 取单个门店（约球桌/地图/扫码核验用）
function getStoreById(storeId) {
  if (!storeId) return Promise.resolve(null);
  return getStores().then((stores) => {
    const s = (stores || []).find((x) => x._id === storeId);
    return s ? ensureStoreGeo(s) : null;
  });
}

// 我的预约（约教练 / 约球桌），按时间倒序
function getMyBookings() {
  if (cloudReady()) {
    return callCloud('getMyBookings', {}).then((r) => (r && r.bookings) || []);
  }
  return Promise.resolve(
    mock
      .readArray(mock.KEY_BOOKINGS)
      .filter((b) => b.status !== 'cancelled')
      .sort((a, b) => b.createdAt - a.createdAt)
  );
}

function cancelBooking(id) {
  if (cloudReady()) {
    return callCloud('cancelBooking', { id });
  }
  const bookings = mock.readArray(mock.KEY_BOOKINGS).filter((b) => b._id !== id);
  mock.writeArray(mock.KEY_BOOKINGS, bookings);
  return Promise.resolve({ ok: true });
}

// 我发布的约球邀约
function getMyMatches() {
  if (cloudReady()) {
    return callCloud('getMyMatches', {}).then((r) => (r && r.matches) || []);
  }
  return Promise.resolve(
    mock
      .readArray(mock.KEY_MATCHES)
      .filter((m) => m._openid === mock.MOCK_OPENID)
      .sort((a, b) => b.createdAt - a.createdAt)
  );
}

function cancelMatch(id) {
  if (cloudReady()) {
    return callCloud('cancelMatch', { id });
  }
  const matches = mock.readArray(mock.KEY_MATCHES).filter((m) => m._id !== id);
  mock.writeArray(mock.KEY_MATCHES, matches);
  return Promise.resolve({ ok: true });
}

// 创建预约（约教练 / 约球桌）
function createBooking({ type, targetId, targetName, hallName, datetime, note, price, tableType }) {
  const info = getCurrentUserInfo();
  if (cloudReady()) {
    return callCloud('createBooking', {
      type,
      targetId,
      targetName,
      hallName,
      datetime,
      note,
      price,
      tableType: tableType || '',
      bookerName: info.authorName
    });
  }
  const bookings = mock.readArray(mock.KEY_BOOKINGS);
  const id = `mock_b_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const booking = {
    _id: id,
    _openid: mock.MOCK_OPENID,
    bookerName: info.authorName,
    type,
    targetId: targetId || '',
    targetName: targetName || '',
    hallName: hallName || '',
    datetime: datetime || '',
    note: note || '',
    price: price || 0,
    tableType: tableType || '',
    status: 'pending',
    createdAt: Date.now()
  };
  bookings.push(booking);
  mock.writeArray(mock.KEY_BOOKINGS, bookings);
  return Promise.resolve({ ok: true, id });
}

function getPostDetail(postId, opts = {}) {
  if (cloudReady()) {
    return callCloud('getPostDetail', { postId, region: opts.region || '' }).then((r) => r || { post: null });
  }
  const post = mock.readArray(mock.KEY_POSTS).find((p) => p._id === postId) || null;
  const currentOpenid = (getApp().globalData && getApp().globalData.openid) || mock.MOCK_OPENID;
  if (post && !canViewPost(post, currentOpenid, opts.region || '')) {
    return Promise.resolve({ post: null, liked: false, comments: [], following: false });
  }
  const liked = mock
    .readArray(mock.KEY_POST_LIKES)
    .some((l) => l.postId === postId && l._openid === mock.MOCK_OPENID);
  const comments = mock
    .readArray(mock.KEY_COMMENTS)
    .filter((c) => c.postId === postId)
    .sort((a, b) => a.createdAt - b.createdAt);
  const following = post
    ? isFollowing(mock.readArray(mock.KEY_FOLLOWS), currentOpenid, post._openid)
    : false;
  return Promise.resolve({ post, liked, comments, following });
}

function createPost({ type, title, content, images, video, cover, topics, location, region, visibility }) {
  const info = getCurrentUserInfo();
  if (cloudReady()) {
    return callCloud('createPost', {
      type,
      title,
      content,
      images,
      video,
      cover,
      topics,
      location,
      region,
      visibility,
      authorName: info.authorName,
      authorAvatar: info.authorAvatar
    });
  }
  const posts = mock.readArray(mock.KEY_POSTS);
  const id = `mock_p_${Date.now()}`;
  posts.push({
    _id: id,
    _openid: mock.MOCK_OPENID,
    authorName: info.authorName,
    authorAvatar: info.authorAvatar,
    type: type || (video ? 'video' : 'image'),
    title: title || '',
    content: content || '',
    images: images || [],
    video: video || '',
    cover: cover || (images && images[0]) || '',
    topics: Array.isArray(topics) ? topics : [],
    location: location || null,
    region: region || '',
    visibility: normalizeVisibility(visibility),
    likeCount: 0,
    commentCount: 0,
    createdAt: Date.now()
  });
  mock.writeArray(mock.KEY_POSTS, posts);
  return Promise.resolve({ ok: true, id });
}

function toggleLike(postId) {
  if (cloudReady()) {
    return callCloud('toggleLike', { postId });
  }
  const likes = mock.readArray(mock.KEY_POST_LIKES);
  const posts = mock.readArray(mock.KEY_POSTS);
  const post = posts.find((p) => p._id === postId);
  const idx = likes.findIndex((l) => l.postId === postId && l._openid === mock.MOCK_OPENID);
  let liked;
  if (idx !== -1) {
    likes.splice(idx, 1);
    if (post) post.likeCount = Math.max(0, (post.likeCount || 0) - 1);
    liked = false;
  } else {
    likes.push({ _openid: mock.MOCK_OPENID, postId, createdAt: Date.now() });
    if (post) post.likeCount = (post.likeCount || 0) + 1;
    liked = true;
  }
  mock.writeArray(mock.KEY_POST_LIKES, likes);
  mock.writeArray(mock.KEY_POSTS, posts);
  return Promise.resolve({ ok: true, liked, likeCount: post ? post.likeCount : 0 });
}

function addComment(postId, content) {
  const info = getCurrentUserInfo();
  if (cloudReady()) {
    return callCloud('addComment', {
      postId,
      content,
      authorName: info.authorName,
      authorAvatar: info.authorAvatar
    });
  }
  const comments = mock.readArray(mock.KEY_COMMENTS);
  const id = `mock_c_${Date.now()}`;
  comments.push({
    _id: id,
    _openid: mock.MOCK_OPENID,
    postId,
    content,
    authorName: info.authorName,
    authorAvatar: info.authorAvatar,
    createdAt: Date.now()
  });
  mock.writeArray(mock.KEY_COMMENTS, comments);
  const posts = mock.readArray(mock.KEY_POSTS);
  const post = posts.find((p) => p._id === postId);
  if (post) post.commentCount = (post.commentCount || 0) + 1;
  mock.writeArray(mock.KEY_POSTS, posts);
  return Promise.resolve({ ok: true, id });
}

// ============ 收费 / 试用 ============

// 读取当前用户的计费状态 { firstLoginAt, plan, role, isInTrial }
// 云端模式从 users 集合拿，mock 模式从本地 KEY_BILLING 拿
// 读取当前用户在指定角色（或当前角色）下的计费状态：firstLoginAt / plan / isInTrial
// role 可不传，默认从 mock.getRole() 取；为支持 per_role 存储，传 role 时以它为准
function getUserBilling(opts) {
  const app = getApp();
  const passed = opts && opts.role;
  const role = passed || (app && app.globalData && app.globalData.role) || mock.getRole();
  const owner = app && app.globalData && app.globalData.openid ? app.globalData.openid : mock.MOCK_OPENID;
  if (cloudReady()) {
    return callCloud('getUserBilling', { role }).then((r) => {
      const b = (r && r.billing) || { firstLoginAt: 0, plan: 'free' };
      if (app && app.globalData) {
        app.globalData.firstLoginAt = b.firstLoginAt;
        app.globalData.plan = b.plan;
        app.globalData.planExpiresAt = b.planExpiresAt || 0;
      }
      // 关键：云端返回后立即让内存里 planExpiresAt 同步，hasPlan 才有依据
      return Object.assign({ role }, b, {
        isInTrial: billing.isInTrial(),
        trialRemainingMs: billing.trialRemainingMs()
      });
    });
  }
  const stateKey = mock.KEY_BILLING + '_' + owner + '_' + role;
  const stored = mock.readObject(stateKey, null);
  const now = Date.now();
  let firstLoginAt = (stored && stored.firstLoginAt) || 0;
  let plan = (stored && stored.plan) || 'free';
  if (!firstLoginAt) {
    firstLoginAt = now;
    mock.writeObject(stateKey, { firstLoginAt, plan, role });
  }
  if (app && app.globalData) {
    app.globalData.firstLoginAt = firstLoginAt;
    app.globalData.plan = plan;
    app.globalData.planExpiresAt = (stored && stored.planExpiresAt) || 0;
  }
  return Promise.resolve({
    firstLoginAt,
    plan,
    role,
    period: (stored && stored.period) || 'year',
    paymentMode: (stored && stored.paymentMode) || 'one_time',
    planExpiresAt: (stored && stored.planExpiresAt) || 0,
    subscription: (stored && stored.subscription) || null,
    isInTrial: billing.isInTrial(),
    trialRemainingMs: billing.trialRemainingMs()
  });
}

// 便捷方法：判断当前用户对某 plan 是否"在有效期"内（封装 billing.isPlanActive + 同步 globalData）
function isPlanActive(planKey) {
  // 确保 globalData 已读到位（不阻塞，缺失时 isPlanActive 自己会兜底）
  const app = getApp();
  if (app && app.globalData && !app.globalData.planExpiresAt) {
    // 尝试从 storage 同步一次（避免首次拉取时不同步）
    const role = app.globalData.role || mock.getRole();
    const owner = app.globalData.openid || mock.MOCK_OPENID;
    const stateKey = mock.KEY_BILLING + '_' + owner + '_' + role;
    const stored = mock.readObject(stateKey, null);
    if (stored && stored.planExpiresAt) {
      app.globalData.planExpiresAt = stored.planExpiresAt;
      if (stored.plan) app.globalData.plan = stored.plan;
    }
  }
  return billing.isPlanActive(planKey);
}

// 首次完成"角色选择"时调用，落地首次登录时间戳
// 首次登录时间戳标记（per_owner + per_role：同一人以不同身份登录时各自开始试期）
// 设计原则：firstLoginAt 只在用户在该角色下从未登录过时才写入；后续调用不会覆盖。
function markFirstLogin(role) {
  const app = getApp();
  const r = role || (app && app.globalData && app.globalData.role) || mock.getRole();
  const owner = app && app.globalData && app.globalData.openid ? app.globalData.openid : mock.MOCK_OPENID;
  const now = Date.now();
  const stateKey = mock.KEY_BILLING + '_' + owner + '_' + r;
  if (cloudReady()) {
    return callCloud('markFirstLogin', { role: r, firstLoginAt: now }).then((res) => {
      // 云端兜底：仅当云端未返回时本地兜底
      const stored = mock.readObject(stateKey, null);
      const firstLoginAt = (stored && stored.firstLoginAt) || now;
      if (app && app.globalData) app.globalData.firstLoginAt = firstLoginAt;
      mock.writeObject(stateKey, { firstLoginAt, plan: (stored && stored.plan) || 'free', role: r });
      return res || { ok: true, firstLoginAt, role: r };
    });
  }
  const stored = mock.readObject(stateKey, null);
  const firstLoginAt = (stored && stored.firstLoginAt) || now;
  const plan = (stored && stored.plan) || 'free';
  mock.writeObject(stateKey, { firstLoginAt, plan, role: r });
  if (app && app.globalData) {
    app.globalData.firstLoginAt = firstLoginAt;
    app.globalData.plan = plan;
  }
  return Promise.resolve({ ok: true, firstLoginAt, role: r, plan });
}

// 旧套餐升级兼容接口：商品退休后不调用云端、不写本地状态。
function upgradePlan(planKey, period) {
  return Promise.resolve({ ok: false, code: 'PRODUCT_RETIRED' });
}

// 旧虚拟支付兼容接口：商品退休后统一失败关闭。
function createVirtualPayOrder(planKey, period, code) {
  return Promise.resolve({ ok: false, code: 'PRODUCT_RETIRED' });
}

// 旧支付下单兼容接口：商品退休后统一失败关闭。
function createPayOrder(planKey, period) {
  return Promise.resolve({ ok: false, code: 'PRODUCT_RETIRED' });
}

// 旧连续签约兼容接口：商品退休后统一失败关闭。
function createRecurringContract(planKey, period) {
  return Promise.resolve({ ok: false, code: 'PRODUCT_RETIRED' });
}

function cancelRecurringContract() {
  if (cloudReady()) {
    return callCloud('cancelRecurringContract', {});
  }
  const sub = mock.readObject('dc_recurring_subscription', null);
  if (sub) mock.writeObject('dc_recurring_subscription', Object.assign({}, sub, { status: 'canceled', canceledAt: Date.now() }));
  return Promise.resolve({ ok: true, mock: true, status: 'canceled' });
}

function getRecurringSubscription() {
  if (cloudReady()) {
    const app = getApp();
    const role = (app && app.globalData && app.globalData.role) || mock.getRole();
    return callCloud('getUserBilling', { role }).then((r) => {
      const billingState = (r && r.billing) || {};
      return billingState.subscription || null;
    });
  }
  return Promise.resolve(mock.readObject('dc_recurring_subscription', null));
}

// ============ 球桌按时计费订单（可信云端变更；本地只保留历史展示数据） ============
function _todayKey() {
  const d = new Date();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
}

// 结账：只提交 sessionId，价格和时长由云端可信快照计算。
function addTableOrder(input) {
  const event = input || {};
  return callCheckedCloud('createTableOrder', { sessionId: event.sessionId });
}

function getTableCheckoutOrder(input) {
  const event = input || {};
  return callCheckedCloud('getTableCheckoutOrder', { token: event.token });
}

function genTableCheckoutCode(input) {
  const event = input || {};
  const payload = event.rotate === true
    ? { orderId: event.orderId, rotate: true }
    : { orderId: event.orderId, token: event.token };
  return callCheckedCloud('genTableCheckoutCode', payload);
}

function createTablePayOrder(input) {
  const event = input || {};
  return callCheckedCloud('createTablePayOrder', { token: event.token });
}

function markTableOrderExternalPaid(input) {
  const event = input || {};
  return callCheckedCloud('markTableOrderExternalPaid', {
    orderId: event.orderId,
    reason: event.reason
  });
}

function requestTableRefund(input) {
  const event = input || {};
  return callCheckedCloud('requestTableRefund', {
    orderId: event.orderId,
    refundFen: event.refundFen,
    reason: event.reason,
    idempotencyKey: event.idempotencyKey
  });
}

// 今日营收：当前店家今日所有结账订单金额合计（元）
function getTodayShopRevenue() {
  if (cloudReady()) {
    return callCloud('getTodayRevenue', {}).then((r) => {
      if (r && r.ok === false) throw resultError(r, '今日营收暂不可用');
      return (r && r.total) || 0;
    });
  }
  const KEY = 'dc_shop_orders';
  const today = _todayKey();
  const total = mock.readArray(KEY)
    .filter((o) => o.date === today)
    .reduce((s, o) => s + (Number(o.amount) || 0), 0);
  return Promise.resolve(total);
}

// 账号注销：申请进入 7 天保留期；到期后由云端定时任务清理。
function deleteAccount(opts) {
  const reason = (opts && opts.reason) || '';
  if (cloudReady()) {
    return callCloud('deleteAccount', { reason }).then((result) => {
      if (result && result.ok === false) {
        const error = new Error(result.msg || '账号注销申请失败');
        error.code = result.code || 'ACCOUNT_DELETION_FAILED';
        error.result = result;
        throw error;
      }
      return result;
    });
  }
  return Promise.reject(cloudNotReadyError());
}

module.exports = {
  initData,
  callAnonymousAuth,
  callSessionCloud,
  callPublicCloud,
  callAdminCloud,
  beginAuthAttempt,
  cancelAuthAttempt,
  registerAccount,
  registerAccountName,
  loginWithSms,
  loginWithPassword,
  loginWithWechat,
  verifyWechatEntryPhone,
  completeWechatEntry,
  getAccountSecurity,
  reauthenticate,
  setAccountName,
  setPassword,
  bindPhone,
  bindWechat,
  logoutCurrentSession,
  logoutOtherSessions,
  resetPasswordByWechat,
  resetPasswordByEmail,
  bindEmail,
  sendEmailCode,
  selectRole,
  probeAuthCloud,
  login,
  loginAdmin,
  logoutAdmin,
  getAdminProfile,
  getCurrentLoginName: currentLoginName,
  rememberLoginNickname,
  sendSmsCode,
  verifySmsCode,
  getUserProfile,
  getUserProfile,
  saveUserProfile,
  getHalls,
  getHeatmap,
  getDayDetail,
  addTraining,
  getRole,
  setRole,
  getCoachProfile,
  getCoachProfileByOpenid,
  getMemberProfileByOpenid,
  resolveAccount,
  getMemberCheckins,
  getMemberCheckinsByOpenid,
  saveCoachProfile,
  getMyMembers,
  getLinkableMembers,
  linkMember,
  getShopProfile,
  saveShopProfile,
  submitShopApplication,
  getShopApplicationStatus,
  getAdminStatus,
  getPendingShopApplications,
  reviewShopApplication,
  getAdminStores,
  getAdminCoaches,
  getAdminMembers,
  getBrands,
  saveShopBrand,
  getShopBrands,
  getStores,
  saveShopStore,
  getShopStores,
  getSessions,
  createSession,
  closeSession,
  getMembers,
  getShopCoaches,
  getLinkableCoaches,
  addShopCoach,
  applyCoachShopBinding,
  getMyCoachShopBindingStatus,
  getCoachBindingApplications,
  reviewCoachBindingApplication,
  removeShopCoach,
  getCoachStudents,
  getShopMembers,
  addShopMember,
  uploadImage,
  uploadFile,
  getFeed,
  getPostDetail,
  createPost,
  toggleLike,
  addComment,
  getFollows,
  toggleFollow,
  resolveCity,
  resolveCityFromLocation,
  getUserLatLng,
  distanceKm,
  getStoreById,
  requestCheckin,
  getTableParticipants,
  getPendingCheckins,
  resolveCheckin,
  getMyCheckinStatus,
  recordVerifiedTraining,
  getCoachLessons,
  getShopCoachSettlement,
  getCoachSettlementDetail,
  settleCoach,
  getShopBizOverview,
  genStoreCheckinCode,
  getMatchPosts,
  createMatchPost,
  getMatchJoiners,
  joinMatch,
  getBookableCoaches,
  getBookableTables,
  createBooking,
  getMyBookings,
  cancelBooking,
  getMyMatches,
  cancelMatch,
  getMyJoins,
  cancelJoin,
  getCoachBookings,
  getUserBilling,
  markFirstLogin,
  upgradePlan,
  createVirtualPayOrder,
  createPayOrder,
  createRecurringContract,
  cancelRecurringContract,
  getRecurringSubscription,
  deleteAccount,
  addTableOrder,
  getTableCheckoutOrder,
  genTableCheckoutCode,
  createTablePayOrder,
  markTableOrderExternalPaid,
  requestTableRefund,
  getTodayShopRevenue,
  isPlanActive
};
