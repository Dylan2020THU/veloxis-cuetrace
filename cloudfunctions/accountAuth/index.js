'use strict';

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const { loadKeyring } = require('./lib/auth/keyring');
const { wechatIdentity } = require('./lib/auth/identifiers');
const { requireSession } = require('./lib/auth/session');
const { guardClientRequest } = require('./lib/auth/protocol-guard');
const {
  loginPassword,
  loginSms,
  registerAccountName
} = require('./lib/account-actions');
const {
  completeWechatEntry,
  loginWechat,
  verifyWechatEntryPhone
} = require('./lib/wechat-actions');
const {
  bindPhone,
  bindWechat,
  logoutCurrent,
  logoutOthers,
  reauthenticate,
  setAccountName,
  setPassword,
  status
} = require('./lib/security-actions');
const { failure, isPlainObject } = require('./lib/store');

const CURRENT_TERMS_VERSION = '2026-07-15';
const CURRENT_PRIVACY_VERSION = '2026-07-15';

const ACTION_FIELDS = Object.freeze({
  probe: Object.freeze([]),
  registerAccountName: Object.freeze([
    'accountName',
    'password',
    'termsVersion',
    'privacyVersion'
  ]),
  loginPassword: Object.freeze([
    'identifier',
    'password',
    'termsVersion',
    'privacyVersion'
  ]),
  loginSms: Object.freeze([
    'phone',
    'challengeId',
    'code',
    'termsVersion',
    'privacyVersion'
  ]),
  loginWechat: Object.freeze([
    'termsVersion',
    'privacyVersion'
  ]),
  verifyWechatEntryPhone: Object.freeze([
    'phone',
    'challengeId',
    'code',
    'termsVersion',
    'privacyVersion'
  ]),
  completeWechatEntry: Object.freeze([
    'proofToken',
    'bindWechat',
    'termsVersion',
    'privacyVersion'
  ]),
  status: Object.freeze([]),
  bindPhone: Object.freeze(['phone', 'challengeId', 'code']),
  setAccountName: Object.freeze(['accountName']),
  setPassword: Object.freeze(['password']),
  bindWechat: Object.freeze([]),
  logoutCurrent: Object.freeze([]),
  logoutOthers: Object.freeze([]),
  resetPasswordByWechat: Object.freeze(['password']),
  resetPasswordByEmail: Object.freeze(['email', 'code', 'password']),
  bindEmail: Object.freeze(['email', 'code'])
});

const REAUTH_FIELDS = Object.freeze({
  password: Object.freeze(['method', 'password']),
  phone: Object.freeze(['method', 'phone', 'challengeId', 'code']),
  email: Object.freeze(['method', 'code']),
  wechat: Object.freeze(['method'])
});

const SESSION_ACTIONS = new Set([
  'status',
  'reauthenticate',
  'bindPhone',
  'setAccountName',
  'setPassword',
  'bindWechat',
  'logoutCurrent',
  'logoutOthers',
  'bindEmail'
]);

const CONSENT_ACTIONS = new Set([
  'registerAccountName',
  'loginPassword',
  'loginSms',
  'loginWechat',
  'verifyWechatEntryPhone',
  'completeWechatEntry'
]);

const MAINTENANCE_ACTIONS = new Set([
  'resetPasswordByWechat',
  'resetPasswordByEmail',
  'bindEmail'
]);

const WECHAT_CONTEXT_ACTIONS = new Set([
  'loginPassword',
  'loginSms',
  'loginWechat',
  'verifyWechatEntryPhone',
  'completeWechatEntry',
  'bindPhone',
  'bindWechat'
]);

function requiresWechatContext(event) {
  return WECHAT_CONTEXT_ACTIONS.has(event.action)
    || (
      event.action === 'reauthenticate'
      && ['phone', 'wechat'].includes(event.method)
    );
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function fieldsFor(event) {
  if (event.action === 'reauthenticate') {
    return own(REAUTH_FIELDS, event.method)
      ? REAUTH_FIELDS[event.method]
      : null;
  }
  return own(ACTION_FIELDS, event.action)
    ? ACTION_FIELDS[event.action]
    : null;
}

function validateRequest(event) {
  if (!isPlainObject(event) || typeof event.action !== 'string') {
    return failure('INVALID_INPUT');
  }
  const fields = fieldsFor(event);
  if (!fields) return failure('INVALID_INPUT');

  const sessionAction = SESSION_ACTIONS.has(event.action);
  const permitted = new Set([
    'action',
    'clientInstanceId',
    ...fields,
    ...(sessionAction ? ['sessionToken'] : [])
  ]);
  if (Object.keys(event).some((key) => !permitted.has(key))) {
    return failure('INVALID_INPUT');
  }
  if (
    typeof event.clientInstanceId !== 'string'
    || event.clientInstanceId.length === 0
    || event.clientInstanceId.length > 256
  ) {
    return failure('INVALID_INPUT');
  }
  if (sessionAction) {
    if (
      !own(event, 'sessionToken')
      || event.sessionToken === undefined
      || event.sessionToken === ''
    ) {
      return failure('SESSION_REQUIRED');
    }
    if (typeof event.sessionToken !== 'string') {
      return failure('SESSION_EXPIRED');
    }
  }
  if (fields.some((field) => !own(event, field))) {
    return failure('INVALID_INPUT');
  }
  if (
    CONSENT_ACTIONS.has(event.action)
    && (
      event.termsVersion !== CURRENT_TERMS_VERSION
      || event.privacyVersion !== CURRENT_PRIVACY_VERSION
    )
  ) {
    return failure('INVALID_INPUT');
  }
  if (
    event.action === 'completeWechatEntry'
    && typeof event.bindWechat !== 'boolean'
  ) {
    return failure('INVALID_INPUT');
  }
  return null;
}

function maintenanceAction(event) {
  return MAINTENANCE_ACTIONS.has(event.action)
    || (
      event.action === 'reauthenticate'
      && event.method === 'email'
    );
}

function normalizedErrorCode(error) {
  if (!error || typeof error !== 'object') return 'AUTH_INTERNAL_ERROR';
  if (error.name === 'AccountAuthAbort') return error.code;
  if (
    error.code === 'INVALID_ACCOUNT_NAME'
    || error.code === 'INVALID_PASSWORD'
  ) {
    return 'INVALID_INPUT';
  }
  if (
    error.code === 'INVALID_PHONE'
    || error.code === 'INVALID_CREDENTIALS'
    || error.code === 'PASSWORD_RATE_LIMITED'
    || error.code === 'SMS_CODE_INVALID'
    || error.code === 'SMS_CODE_EXPIRED'
    || error.code === 'SMS_CODE_LOCKED'
  ) {
    return error.code;
  }
  if (
    [
      'SESSION_REQUIRED',
      'SESSION_EXPIRED',
      'RECENT_AUTH_REQUIRED',
      'ACCOUNT_DISABLED',
      'ROLE_NOT_ALLOWED',
      'AUTH_CONFLICT',
      'AUTH_INTERNAL_ERROR'
    ].includes(error.code)
  ) {
    return error.code;
  }
  return 'AUTH_INTERNAL_ERROR';
}

async function accountAuthMain(event = {}) {
  const invalid = validateRequest(event);
  if (invalid) return invalid;
  if (maintenanceAction(event)) return failure('AUTH_MAINTENANCE');
  if (event.action === 'probe') {
    return { ok: true, kind: 'probe' };
  }

  try {
    const keyring = loadKeyring(process.env);
    const now = new Date(Date.now());
    let authenticated = null;
    if (SESSION_ACTIONS.has(event.action)) {
      authenticated = await requireSession({
        db,
        event,
        now,
        keyring
      });
      if (authenticated && authenticated.ok === false) {
        return failure(authenticated.code);
      }
    }
    const wxContext = requiresWechatContext(event)
      ? cloud.getWXContext()
      : null;
    const wxIdentity = wxContext ? wechatIdentity(wxContext) : null;
    const trustedWechat = wxContext ? {
      identity: wxIdentity,
      appid: wxContext.APPID,
      openid: wxContext.OPENID,
      unionid: wxContext.UNIONID || ''
    } : null;
    if (event.action === 'registerAccountName') {
      return await registerAccountName({
        db,
        event,
        now,
        keyring
      });
    }
    if (event.action === 'loginSms') {
      return await loginSms({
        db,
        event,
        now,
        keyring,
        wxIdentity
      });
    }
    if (event.action === 'loginPassword') {
      return await loginPassword({
        db,
        event,
        now,
        keyring,
        wxIdentity
      });
    }
    if (event.action === 'loginWechat') {
      return await loginWechat({
        db,
        event,
        now,
        keyring,
        trustedWechat
      });
    }
    if (event.action === 'verifyWechatEntryPhone') {
      return await verifyWechatEntryPhone({
        db,
        event,
        now,
        keyring,
        trustedWechat
      });
    }
    if (event.action === 'completeWechatEntry') {
      return await completeWechatEntry({
        db,
        event,
        now,
        keyring,
        trustedWechat
      });
    }
    if (event.action === 'status') {
      return await status({ db, authenticated, now, keyring });
    }
    if (event.action === 'reauthenticate') {
      return await reauthenticate({
        db,
        event,
        authenticated,
        now,
        keyring,
        trustedWechat
      });
    }
    if (event.action === 'bindPhone') {
      return await bindPhone({
        db,
        event,
        authenticated,
        now,
        keyring,
        trustedWechat
      });
    }
    if (event.action === 'setAccountName') {
      return await setAccountName({
        db,
        event,
        authenticated,
        now
      });
    }
    if (event.action === 'setPassword') {
      return await setPassword({
        db,
        event,
        authenticated,
        now,
        keyring
      });
    }
    if (event.action === 'bindWechat') {
      return await bindWechat({
        db,
        authenticated,
        now,
        keyring,
        trustedWechat
      });
    }
    if (event.action === 'logoutCurrent') {
      return await logoutCurrent({
        db,
        authenticated,
        now
      });
    }
    if (event.action === 'logoutOthers') {
      return await logoutOthers({
        db,
        authenticated,
        now,
        keyring
      });
    }
    return failure('AUTH_INTERNAL_ERROR');
  } catch (error) {
    const code = normalizedErrorCode(error);
    if (code === 'AUTH_INTERNAL_ERROR') {
      console.error('accountAuth failed', {
        name: error && error.name,
        code: error && error.code
      });
    }
    return failure(code);
  }
}

exports.main = accountAuthMain;

const protocolGuardedMain = exports.main;

exports.main = async (event = {}, ...args) => {
  const gate = await guardClientRequest({
    db,
    event,
    supportedSchemaVersions: [2]
  });
  if (!gate.ok) return gate;
  let businessEvent = event;
  if (Object.prototype.hasOwnProperty.call(event, 'authProtocol')) {
    businessEvent = { ...event };
    delete businessEvent.authProtocol;
  }
  return protocolGuardedMain(businessEvent, ...args);
};
