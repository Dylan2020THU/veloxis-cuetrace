'use strict';

const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const { loadKeyring } = require('./lib/auth/keyring');
const { requireSession } = require('./lib/auth/session');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const VALID_ROLES = Object.freeze(['member', 'coach', 'shop']);
const ROLE_SET = new Set(VALID_ROLES);
const ACCOUNT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{3,19}$/;
const PHONE_MASK_PATTERN = /^1\d{2}\*{4}\d{4}$/;
const VERSION_PATTERN = /^[A-Z0-9_]+$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const ERROR_RESULTS = Object.freeze({
  INVALID_INPUT: Object.freeze({
    ok: false,
    code: 'INVALID_INPUT',
    msg: '请求参数无效'
  }),
  ROLE_NOT_ALLOWED: Object.freeze({
    ok: false,
    code: 'ROLE_NOT_ALLOWED',
    msg: '该账号未开通此身份'
  }),
  SESSION_EXPIRED: Object.freeze({
    ok: false,
    code: 'SESSION_EXPIRED',
    msg: '登录状态已失效，请重新登录'
  }),
  AUTH_INTERNAL_ERROR: Object.freeze({
    ok: false,
    code: 'AUTH_INTERNAL_ERROR',
    msg: '认证服务异常，请稍后重试'
  })
});

function failure(code) {
  return { ...(ERROR_RESULTS[code] || ERROR_RESULTS.AUTH_INTERNAL_ERROR) };
}

function isPlainObject(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
  );
}

function validRequest(event) {
  if (!isPlainObject(event)) return false;
  const keys = Object.keys(event);
  return Boolean(
    keys.every((key) => (
      key === 'role'
      || key === 'sessionToken'
      || key === 'clientInstanceId'
    ))
    && Object.prototype.hasOwnProperty.call(event, 'role')
    && typeof event.role === 'string'
    && event.role.length > 0
    && (
      !Object.prototype.hasOwnProperty.call(event, 'clientInstanceId')
      || (
        typeof event.clientInstanceId === 'string'
        && event.clientInstanceId.length > 0
        && event.clientInstanceId.length <= 256
      )
    )
  );
}

function validLiveRoleState(user, accountId) {
  return Boolean(
    isPlainObject(user)
    && user._id === accountId
    && Array.isArray(user.roles)
    && user.roles.length > 0
    && user.roles.every((role) => ROLE_SET.has(role))
    && new Set(user.roles).size === user.roles.length
    && ROLE_SET.has(user.currentRole)
    && user.role === user.currentRole
    && user.roles.includes(user.currentRole)
  );
}

function accountNameDocumentId(accountNormalized) {
  return crypto
    .createHash('sha256')
    .update(`account-name:v1:${accountNormalized}`)
    .digest('hex');
}

async function readRequiredDocument(transaction, collection, id) {
  const result = await transaction
    .collection(collection)
    .doc(id)
    .get();
  if (
    !result
    || !Object.prototype.hasOwnProperty.call(result, 'data')
    || !isPlainObject(result.data)
  ) {
    return null;
  }
  return result.data;
}

function validAccountNameBinding(binding, expectedId, accountId) {
  if (
    !isPlainObject(binding)
    || binding._id !== expectedId
    || binding.accountId !== accountId
    || binding.status !== 'active'
    || typeof binding.account !== 'string'
    || !ACCOUNT_NAME_PATTERN.test(binding.account)
    || binding.account !== binding.account.trim()
    || binding.accountNormalized !== binding.account.toLowerCase()
  ) {
    return false;
  }
  return accountNameDocumentId(binding.accountNormalized) === expectedId;
}

function validPhoneBinding(binding, expectedId, accountId) {
  const parts = typeof expectedId === 'string'
    ? expectedId.split('.')
    : [];
  return Boolean(
    isPlainObject(binding)
    && binding._id === expectedId
    && binding.accountId === accountId
    && binding.status === 'active'
    && parts.length === 3
    && parts[0] === 'phone'
    && VERSION_PATTERN.test(parts[1])
    && DIGEST_PATTERN.test(parts[2])
    && binding.keyVersion === parts[1]
    && typeof binding.phoneMasked === 'string'
    && PHONE_MASK_PATTERN.test(binding.phoneMasked)
  );
}

async function loadAccountProjection(transaction, account, accountId) {
  if (
    !isPlainObject(account)
    || account._id !== accountId
    || typeof account.accountNameBindingId !== 'string'
    || typeof account.phoneBindingId !== 'string'
  ) {
    return null;
  }

  let accountName = '';
  let phoneMasked = '';
  if (account.accountNameBindingId) {
    const binding = await readRequiredDocument(
      transaction,
      'account_names',
      account.accountNameBindingId
    );
    if (!validAccountNameBinding(
      binding,
      account.accountNameBindingId,
      accountId
    )) {
      return null;
    }
    accountName = binding.account;
  }
  if (account.phoneBindingId) {
    const binding = await readRequiredDocument(
      transaction,
      'phone_bindings',
      account.phoneBindingId
    );
    if (!validPhoneBinding(
      binding,
      account.phoneBindingId,
      accountId
    )) {
      return null;
    }
    phoneMasked = binding.phoneMasked;
  }
  return {
    account: accountName,
    accountDisplay: accountName || phoneMasked || '手机号用户'
  };
}

exports.main = async (event = {}) => {
  if (!validRequest(event)) return failure('INVALID_INPUT');

  let keyring;
  try {
    keyring = loadKeyring(process.env);
  } catch (_) {
    return failure('AUTH_INTERNAL_ERROR');
  }

  const now = new Date(Date.now());
  const sessionEvent = { sessionToken: event.sessionToken };
  const authenticated = await requireSession({
    db,
    event: sessionEvent,
    now,
    keyring
  });
  if (authenticated && authenticated.ok === false) {
    return authenticated;
  }
  if (
    !authenticated
    || !authenticated.account
    || !authenticated.user
    || !authenticated.session
    || authenticated.accountId !== authenticated.account._id
    || authenticated.session.accountId !== authenticated.accountId
  ) {
    return failure('SESSION_EXPIRED');
  }
  if (!ROLE_SET.has(event.role)) {
    return failure('ROLE_NOT_ALLOWED');
  }

  try {
    return await db.runTransaction(async (transaction) => {
      const live = await requireSession({
        db: transaction,
        event: sessionEvent,
        now,
        keyring
      });
      if (live && live.ok === false) return live;
      if (
        !live
        || !live.account
        || !live.user
        || !live.session
        || live.accountId !== authenticated.accountId
        || live.accountId !== live.account._id
        || live.session._id !== authenticated.session._id
        || live.session.accountId !== live.accountId
      ) {
        return failure('SESSION_EXPIRED');
      }
      if (!validLiveRoleState(live.user, live.accountId)) {
        return failure('SESSION_EXPIRED');
      }
      if (!live.user.roles.includes(event.role)) {
        return failure('ROLE_NOT_ALLOWED');
      }

      const projection = await loadAccountProjection(
        transaction,
        live.account,
        live.accountId
      );
      if (!projection) return failure('AUTH_INTERNAL_ERROR');

      await transaction
        .collection('users')
        .doc(live.accountId)
        .update({
          data: {
            currentRole: event.role,
            role: event.role,
            updatedAt: db.serverDate()
          }
        });

      return {
        ok: true,
        kind: 'role_selected',
        account: projection.account,
        accountDisplay: projection.accountDisplay,
        roles: [...live.user.roles],
        currentRole: event.role
      };
    });
  } catch (_) {
    return failure('AUTH_INTERNAL_ERROR');
  }
};

const { guardClientRequest } = require('./lib/auth/protocol-guard');
const protocolGuardedMain = exports.main;

exports.main = async (event = {}, ...args) => {
  const gate = await guardClientRequest({
    db,
    event,
    supportedSchemaVersions: [2]
  });
  if (!gate.ok) return gate;
  let businessEvent = event;
  if (
    Object.prototype.hasOwnProperty.call(
      event,
      'authProtocol'
    )
  ) {
    businessEvent = { ...event };
    delete businessEvent.authProtocol;
  }
  return protocolGuardedMain(
    businessEvent,
    ...args
  );
};
