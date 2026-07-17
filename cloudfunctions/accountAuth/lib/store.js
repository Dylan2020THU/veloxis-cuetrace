'use strict';

const crypto = require('crypto');
const { issueSession } = require('./auth/session');
const { normalizeAccountName } = require('./auth/identifiers');

const ALLOWED_ROLES = Object.freeze(['member', 'coach', 'shop']);
const ERROR_MESSAGES = Object.freeze({
  INVALID_INPUT: '请求参数不正确',
  INVALID_PHONE: '手机号格式不正确',
  INVALID_CREDENTIALS: '账号或密码不正确',
  PASSWORD_RATE_LIMITED: '密码尝试过于频繁，请稍后再试',
  ACCOUNT_NAME_EXISTS: '账号名已被占用',
  PHONE_ALREADY_BOUND: '手机号已绑定其他账号',
  ACCOUNT_PHONE_ALREADY_BOUND: '当前账号已绑定手机号',
  WECHAT_NOT_BOUND: '当前微信尚未绑定账号',
  WECHAT_ALREADY_BOUND: '当前微信已绑定其他账号',
  ACCOUNT_WECHAT_ALREADY_BOUND: '当前账号已绑定微信',
  WECHAT_IDENTITY_CONFLICT: '微信身份校验失败',
  SESSION_REQUIRED: '请先登录',
  SESSION_EXPIRED: '登录状态已失效，请重新登录',
  RECENT_AUTH_REQUIRED: '请先完成近期身份验证',
  AUTH_MAINTENANCE: '认证服务维护中，请稍后重试',
  ACCOUNT_DISABLED: '账号已停用',
  ACCOUNT_DELETION_LOCKED: '账号注销已进入删除流程',
  ROLE_NOT_ALLOWED: '当前账号未获得该角色',
  AUTH_CONFLICT: '认证状态已变化，请重试',
  AUTH_INTERNAL_ERROR: '认证服务异常，请稍后重试',
  SMS_CODE_INVALID: '验证码无效，请重新获取',
  SMS_CODE_EXPIRED: '验证码已过期，请重新获取',
  SMS_CODE_LOCKED: '验证码已锁定，请重新获取验证码'
});

function failure(code, extra) {
  const result = {
    ok: false,
    code: Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code)
      ? code
      : 'AUTH_INTERNAL_ERROR',
    msg: ERROR_MESSAGES[code] || ERROR_MESSAGES.AUTH_INTERNAL_ERROR
  };
  return extra ? { ...result, ...extra } : result;
}

function authError(code) {
  const result = failure(code);
  const error = new Error(result.msg);
  error.name = 'AccountAuthAbort';
  error.code = result.code;
  return error;
}

function isPlainObject(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
  );
}

function validDate(value) {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function copyDate(value) {
  return new Date(value.getTime());
}

function withoutDocumentId(document) {
  const { _id, ...data } = document;
  return data;
}

function exactMissing(error, expectedId) {
  const expected = 'document.get:fail document with _id '
    + expectedId
    + ' does not exist';
  if (typeof error === 'string') return error === expected;
  return Boolean(
    error
    && typeof error === 'object'
    && (
      error.message === expected
      || error.errMsg === expected
    )
  );
}

async function optionalDocument(ref, expectedId) {
  try {
    const result = await ref.get();
    if (
      !result
      || !Object.prototype.hasOwnProperty.call(result, 'data')
      || !isPlainObject(result.data)
    ) {
      throw authError('AUTH_INTERNAL_ERROR');
    }
    return result.data;
  } catch (error) {
    if (exactMissing(error, expectedId)) return null;
    if (error && error.name === 'AccountAuthAbort') throw error;
    throw authError('AUTH_INTERNAL_ERROR');
  }
}

function accountNameDocumentId(normalizedAccountName) {
  if (
    typeof normalizedAccountName !== 'string'
    || !/^[a-z][a-z0-9_]{3,19}$/.test(normalizedAccountName)
  ) {
    throw authError('INVALID_INPUT');
  }
  return crypto
    .createHash('sha256')
    .update('account-name:v1:' + normalizedAccountName, 'utf8')
    .digest('hex');
}

function validPasswordState(account) {
  const empty = account.passwordAlgorithm === ''
    && account.passwordSalt === ''
    && account.passwordHash === '';
  const configured = account.passwordAlgorithm === 'scrypt-v1'
    && /^[0-9a-f]{32}$/.test(account.passwordSalt)
    && /^[0-9a-f]{128}$/.test(account.passwordHash);
  return empty || configured;
}

function validAccountCore(account, expectedId) {
  return Boolean(
    isPlainObject(account)
    && account._id === expectedId
    && /^acct_[A-Za-z0-9_-]{22,}$/.test(account._id)
    && ['active', 'disabled'].includes(account.status)
    && typeof account.accountNameBindingId === 'string'
    && typeof account.phoneBindingId === 'string'
    && typeof account.wechatBindingId === 'string'
    && typeof account.emailBindingId === 'string'
    && Number.isSafeInteger(account.authVersion)
    && account.authVersion >= 1
    && typeof account.termsVersion === 'string'
    && typeof account.privacyVersion === 'string'
    && validDate(account.termsAcceptedAt)
    && validDate(account.privacyAcceptedAt)
    && validDate(account.createdAt)
    && validDate(account.updatedAt)
  );
}

function validAccount(account, expectedId) {
  return Boolean(
    validAccountCore(account, expectedId)
    && account.status === 'active'
    && validPasswordState(account)
  );
}

function validPhoneBinding(binding, candidate) {
  return Boolean(
    isPlainObject(binding)
    && candidate
    && binding._id === candidate.id
    && /^phone\.[A-Z0-9_]+\.[A-Za-z0-9_-]{43}$/.test(binding._id)
    && binding.keyVersion === candidate.keyVersion
    && binding._id.split('.')[1] === binding.keyVersion
    && /^acct_[A-Za-z0-9_-]{22,}$/.test(binding.accountId)
    && /^1\d{2}\*{4}\d{4}$/.test(binding.phoneMasked)
    && ['active', 'revoked'].includes(binding.status)
    && validDate(binding.verifiedAt)
    && validDate(binding.createdAt)
    && validDate(binding.updatedAt)
    && (
      (
        binding.status === 'active'
        && !Object.prototype.hasOwnProperty.call(binding, 'revokeReason')
        && !Object.prototype.hasOwnProperty.call(binding, 'revokedAt')
      )
      || (
        binding.revokeReason === 'key_rotated'
        && validDate(binding.revokedAt)
      )
    )
  );
}

function validUser(user, expectedAccountId) {
  return Boolean(
    isPlainObject(user)
    && user._id === expectedAccountId
    && Array.isArray(user.roles)
    && user.roles.length > 0
    && user.roles.length <= ALLOWED_ROLES.length
    && new Set(user.roles).size === user.roles.length
    && user.roles.every((role) => ALLOWED_ROLES.includes(role))
    && ALLOWED_ROLES.includes(user.currentRole)
    && user.role === user.currentRole
    && user.roles.includes(user.currentRole)
    && typeof user.nickname === 'string'
    && typeof user.avatar === 'string'
    && validDate(user.createdAt)
    && validDate(user.updatedAt)
  );
}

function validAccountNameRelation(
  relation,
  expectedId,
  account,
  normalizedAccountName
) {
  let displayNormalized = '';
  try {
    displayNormalized = normalizeAccountName(relation && relation.account);
  } catch (_) {
    return false;
  }
  return Boolean(
    isPlainObject(relation)
    && relation._id === expectedId
    && relation.accountId === account._id
    && relation.status === 'active'
    && typeof relation.account === 'string'
    && relation.account.trim() === relation.account
    && relation.accountNormalized === normalizedAccountName
    && displayNormalized === relation.accountNormalized
    && accountNameDocumentId(relation.accountNormalized) === expectedId
    && validDate(relation.createdAt)
    && validDate(relation.updatedAt)
  );
}

function newAccountRecord({
  accountId,
  passwordRecord,
  accountNameBindingId,
  consent,
  now
}) {
  return {
    _id: accountId,
    status: 'active',
    accountNameBindingId: accountNameBindingId || '',
    phoneBindingId: '',
    wechatBindingId: '',
    emailBindingId: '',
    passwordAlgorithm: passwordRecord
      ? passwordRecord.passwordAlgorithm
      : '',
    passwordSalt: passwordRecord ? passwordRecord.passwordSalt : '',
    passwordHash: passwordRecord ? passwordRecord.passwordHash : '',
    authVersion: 1,
    termsAcceptedAt: copyDate(now),
    termsVersion: consent.termsVersion,
    privacyAcceptedAt: copyDate(now),
    privacyVersion: consent.privacyVersion,
    createdAt: copyDate(now),
    updatedAt: copyDate(now)
  };
}

function newUserRecord(accountId, now) {
  return {
    _id: accountId,
    roles: ['member'],
    currentRole: 'member',
    role: 'member',
    nickname: '',
    avatar: '',
    createdAt: copyDate(now),
    updatedAt: copyDate(now)
  };
}

function deletionTimesMatch(user, request) {
  return Number.isFinite(user.deletionRequestedAt)
    && Number.isFinite(user.deletionScheduledAt)
    && Number.isFinite(request.deletionRequestedAt)
    && Number.isFinite(request.deletionScheduledAt)
    && request.deletionRequestedAt === user.deletionRequestedAt
    && request.deletionScheduledAt === user.deletionScheduledAt;
}

async function cancelPendingDeletion({
  transaction,
  db,
  account,
  user,
  now
}) {
  const requestRef = transaction
    .collection('account_deletion_requests')
    .doc(account._id);
  const request = await optionalDocument(requestRef, account._id);
  const userStatus = Object.prototype.hasOwnProperty.call(
    user,
    'deletionStatus'
  ) ? user.deletionStatus : '';

  if (!userStatus) {
    if (!request || request.deletionStatus === 'canceled') return user;
    if (request.deletionStatus === 'purging') {
      throw authError('ACCOUNT_DELETION_LOCKED');
    }
    throw authError('AUTH_CONFLICT');
  }
  if (
    userStatus === 'purging'
    || (request && request.deletionStatus === 'purging')
  ) {
    throw authError('ACCOUNT_DELETION_LOCKED');
  }
  if (
    userStatus !== 'pending'
    || !request
    || request._id !== account._id
    || request.accountId !== account._id
    || request.deletionStatus !== 'pending'
    || !deletionTimesMatch(user, request)
  ) {
    throw authError('AUTH_CONFLICT');
  }
  if (now.getTime() >= user.deletionScheduledAt) {
    throw authError('ACCOUNT_DELETION_LOCKED');
  }
  if (
    !db.command
    || typeof db.command.remove !== 'function'
  ) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
  const remove = db.command.remove();
  const canceledAt = copyDate(now);
  const userRef = transaction.collection('users').doc(account._id);
  await requestRef.update({
    data: {
      deletionStatus: 'canceled',
      deletionCanceledAt: canceledAt,
      updatedAt: canceledAt
    }
  });
  await userRef.update({
    data: {
      deletionStatus: remove,
      deletionReason: remove,
      deletionRequestedAt: remove,
      deletionScheduledAt: remove,
      deletionCanceledAt: canceledAt,
      updatedAt: canceledAt
    }
  });
  const nextUser = { ...user };
  delete nextUser.deletionStatus;
  delete nextUser.deletionReason;
  delete nextUser.deletionRequestedAt;
  delete nextUser.deletionScheduledAt;
  nextUser.deletionCanceledAt = canceledAt;
  nextUser.updatedAt = canceledAt;
  return nextUser;
}

async function issueAccountSession({
  transaction,
  db,
  account,
  user,
  clientInstanceId,
  method,
  now,
  keyring,
  preparedSessionToken
}) {
  const liveUser = await cancelPendingDeletion({
    transaction,
    db,
    account,
    user,
    now
  });
  const issued = await issueSession({
    transaction,
    account,
    clientInstanceId,
    method,
    now,
    keyring,
    preparedSessionToken
  });
  return { ...issued, user: liveUser };
}

function accountDisplay(accountNameRelation, phoneBinding) {
  if (
    accountNameRelation
    && typeof accountNameRelation.account === 'string'
    && accountNameRelation.account
  ) {
    return accountNameRelation.account;
  }
  if (
    phoneBinding
    && typeof phoneBinding.phoneMasked === 'string'
    && phoneBinding.phoneMasked
  ) {
    return phoneBinding.phoneMasked;
  }
  return '手机号用户';
}

function sessionIssuedResponse({
  issued,
  user,
  accountNameRelation,
  phoneBinding,
  method,
  now
}) {
  const account = accountNameRelation
    ? accountNameRelation.account
    : '';
  return {
    ok: true,
    kind: 'session_issued',
    sessionToken: issued.sessionToken,
    account,
    accountDisplay: accountDisplay(accountNameRelation, phoneBinding),
    roles: [...user.roles],
    currentRole: user.currentRole,
    authenticatedAt: now.getTime(),
    authenticationMethod: method
  };
}

module.exports = {
  ALLOWED_ROLES,
  accountDisplay,
  accountNameDocumentId,
  authError,
  cancelPendingDeletion,
  failure,
  isPlainObject,
  issueAccountSession,
  newAccountRecord,
  newUserRecord,
  optionalDocument,
  sessionIssuedResponse,
  validAccount,
  validAccountCore,
  validAccountNameRelation,
  validDate,
  validPhoneBinding,
  validPasswordState,
  validUser,
  withoutDocumentId
};
