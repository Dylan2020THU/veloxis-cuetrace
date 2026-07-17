'use strict';

const crypto = require('crypto');

const {
  candidateHmacIds
} = require('./auth/keyring');
const {
  normalizeAccountName,
  normalizePhone
} = require('./auth/identifiers');
const {
  hashPassword,
  verifyPasswordOrDummy
} = require('./auth/password');
const {
  prepareSessionToken,
  requireRecentAuthentication,
  revokeCurrentSession,
  revokeOtherSessions
} = require('./auth/session');
const { consumeSmsChallenge } = require('./auth/sms');
const {
  migratePhoneBinding,
  newPhoneBindingRecord,
  phoneCandidates,
  readAccountGraph,
  readAccountNameProjection,
  readPhoneCandidateItems,
  selectPhoneBinding
} = require('./account-actions');
const {
  migrateWechatBinding,
  newWechatBindingRecord,
  readPhoneProjection,
  readWechatCandidateItems,
  selectWechatBinding,
  validWechatBindingShape,
  wechatMaterial
} = require('./wechat-actions');
const {
  accountDisplay,
  accountNameDocumentId,
  authError,
  cancelPendingDeletion,
  failure,
  isPlainObject,
  optionalDocument,
  validAccount,
  validAccountCore,
  validAccountNameRelation,
  validDate,
  validUser,
  withoutDocumentId
} = require('./store');

const REAUTH_RATE_LIMIT = 5;
const REAUTH_RATE_WINDOW_MS = 15 * 60 * 1000;
const REAUTH_RATE_BLOCK_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_IDLE_TTL_MS = 30 * DAY_MS;
const SESSION_ABSOLUTE_TTL_MS = 90 * DAY_MS;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_ID_RE = /^[0-9a-f]{64}$/;
const EMAIL_CODE_RE = /^\d{6}$/;
const EMAIL_HMAC_RE = /^[0-9a-f]{64}$/;
const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
const EMAIL_CODE_COOLDOWN_MS = 60 * 1000;
const EMAIL_PURPOSES = new Set(['bind', 'reset', 'reauth']);
const EMAIL_CHALLENGE_STATES = new Set([
  'sending',
  'active',
  'failed',
  'locked',
  'used'
]);

function copyDate(value) {
  return new Date(value.getTime());
}

function normalizeEmail(value) {
  if (typeof value !== 'string') throw authError('EMAIL_INVALID');
  const normalized = value.trim().toLowerCase();
  if (
    !normalized
    || normalized.length > 254
    || !EMAIL_RE.test(normalized)
  ) {
    throw authError('EMAIL_INVALID');
  }
  return normalized;
}

function emailBindingId(normalizedEmail) {
  return crypto
    .createHash('sha256')
    .update('email:' + normalizedEmail, 'utf8')
    .digest('hex');
}

function emailCodeId(purpose, normalizedEmail) {
  return crypto
    .createHash('sha256')
    .update(
      'email-code:' + purpose + ':' + normalizedEmail,
      'utf8'
    )
    .digest('hex');
}

function lengthPrefixed(value) {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function emailCodeSecret() {
  const secret = process.env.CUETRACE_EMAIL_CODE_SECRET;
  if (typeof secret !== 'string' || !secret) {
    throw authError('EMAIL_NOT_CONFIGURED');
  }
  return secret;
}

function emailHmac(secret, domain, fields) {
  try {
    return crypto
      .createHmac('sha256', secret)
      .update(Buffer.concat([
        lengthPrefixed(domain),
        ...fields.map(lengthPrefixed)
      ]))
      .digest('hex');
  } catch (_) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
}

function emailScopeHash(secret, {
  purpose,
  clientInstanceId,
  accountId,
  sessionId,
  bindingId
}) {
  return emailHmac(secret, 'email-scope-v2', [
    purpose,
    clientInstanceId,
    accountId,
    sessionId,
    bindingId
  ]);
}

function emailCodeHash(secret, challengeId, code) {
  return emailHmac(secret, 'email-code-v2', [challengeId, code]);
}

function constantTimeHexEqual(left, right) {
  if (!EMAIL_HMAC_RE.test(left) || !EMAIL_HMAC_RE.test(right)) {
    return false;
  }
  try {
    return crypto.timingSafeEqual(
      Buffer.from(left, 'hex'),
      Buffer.from(right, 'hex')
    );
  } catch (_) {
    return false;
  }
}

function validEmailBinding(binding, expectedId) {
  if (
    !isPlainObject(binding)
    || binding._id !== expectedId
    || !EMAIL_ID_RE.test(binding._id)
    || typeof binding.accountId !== 'string'
    || !/^acct_[A-Za-z0-9_-]{22,}$/.test(binding.accountId)
    || typeof binding.email !== 'string'
    || typeof binding.emailNormalized !== 'string'
    || binding.email !== binding.emailNormalized
    || !['active', 'revoked'].includes(binding.status)
    || !validDate(binding.boundAt)
    || !validDate(binding.updatedAt)
  ) {
    return false;
  }
  let normalized;
  try {
    normalized = normalizeEmail(binding.emailNormalized);
  } catch (_) {
    return false;
  }
  if (
    normalized !== binding.emailNormalized
    || emailBindingId(normalized) !== binding._id
  ) {
    return false;
  }
  if (
    binding.status === 'active'
      ? Object.prototype.hasOwnProperty.call(binding, 'revokedAt')
      : !validDate(binding.revokedAt)
  ) {
    return false;
  }
  return [
    '_openid',
    'account',
    'accountNormalized',
    'emailMasked',
    'verifiedAt',
    'createdAt'
  ].every((field) => (
    !Object.prototype.hasOwnProperty.call(binding, field)
  ));
}

async function readEmailBinding(source, bindingId) {
  const binding = await optionalDocument(
    source.collection('email_bindings').doc(bindingId),
    bindingId
  );
  if (binding && !validEmailBinding(binding, bindingId)) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
  return binding;
}

async function readEmailReverseAccounts(source, bindingId) {
  let result;
  try {
    result = await source
      .collection('accounts')
      .where({ emailBindingId: bindingId })
      .limit(2)
      .get();
  } catch (_) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
  if (
    !result
    || !Array.isArray(result.data)
    || result.data.length > 1
    || result.data.some((account) => (
      !validAccountCore(account, account && account._id)
    ))
  ) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
  return result.data;
}

async function readEmailProjection(source, account) {
  if (!account.emailBindingId) return null;
  if (!EMAIL_ID_RE.test(account.emailBindingId)) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
  const binding = await readEmailBinding(
    source,
    account.emailBindingId
  );
  if (
    !binding
    || binding.status !== 'active'
    || binding.accountId !== account._id
  ) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
  return binding;
}

function maskEmail(normalizedEmail) {
  const separator = normalizedEmail.lastIndexOf('@');
  if (separator <= 0 || separator === normalizedEmail.length - 1) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
  const local = normalizedEmail.slice(0, separator);
  return local.slice(0, 2)
    + '*'.repeat(Math.max(2, local.length - 2))
    + normalizedEmail.slice(separator);
}

function validEmailChallenge(challenge, challengeId) {
  if (
    !isPlainObject(challenge)
    || challenge._id !== challengeId
    || !EMAIL_ID_RE.test(challenge._id)
    || !EMAIL_PURPOSES.has(challenge.purpose)
    || typeof challenge.accountId !== 'string'
    || !/^acct_[A-Za-z0-9_-]{22,}$/.test(challenge.accountId)
    || !EMAIL_ID_RE.test(challenge.emailBindingId)
    || challenge.targetHash !== challenge.emailBindingId
    || typeof challenge.scopeHash !== 'string'
    || !EMAIL_HMAC_RE.test(challenge.scopeHash)
    || typeof challenge.requestId !== 'string'
    || !challenge.requestId
    || challenge.requestId.length > 128
    || !EMAIL_CHALLENGE_STATES.has(challenge.status)
    || typeof challenge.codeHash !== 'string'
    || !Number.isSafeInteger(challenge.attemptsLeft)
    || challenge.attemptsLeft < 0
    || challenge.attemptsLeft > 5
    || !validDate(challenge.nextSendAt)
    || !validDate(challenge.createdAt)
    || !validDate(challenge.updatedAt)
    || !(
      challenge.expiresAt === null
      || validDate(challenge.expiresAt)
    )
    || !(
      challenge.sentAt === null
      || validDate(challenge.sentAt)
    )
    || !(
      challenge.usedAt === null
      || validDate(challenge.usedAt)
    )
    || [
      'email',
      'emailNormalized',
      'code',
      'sessionToken',
      'clientInstanceId'
    ].some((field) => (
      Object.prototype.hasOwnProperty.call(challenge, field)
    ))
  ) {
    return false;
  }
  const createdMs = challenge.createdAt.getTime();
  const updatedMs = challenge.updatedAt.getTime();
  const nextSendMs = challenge.nextSendAt.getTime();
  if (
    updatedMs < createdMs
    || nextSendMs !== createdMs + EMAIL_CODE_COOLDOWN_MS
  ) {
    return false;
  }
  if (challenge.status === 'sending') {
    return challenge.codeHash === ''
      && challenge.attemptsLeft === 0
      && challenge.expiresAt === null
      && challenge.sentAt === null
      && challenge.usedAt === null
      && updatedMs === createdMs;
  }
  if (challenge.status === 'failed') {
    return challenge.codeHash === ''
      && challenge.attemptsLeft === 0
      && challenge.expiresAt === null
      && challenge.sentAt === null
      && challenge.usedAt === null;
  }
  if (!EMAIL_HMAC_RE.test(challenge.codeHash)) return false;
  if (!validDate(challenge.expiresAt) || !validDate(challenge.sentAt)) {
    return false;
  }
  const sentMs = challenge.sentAt.getTime();
  if (
    sentMs < createdMs
    || challenge.expiresAt.getTime() !== sentMs + EMAIL_CODE_TTL_MS
    || updatedMs < sentMs
  ) {
    return false;
  }
  if (challenge.status === 'active') {
    return challenge.attemptsLeft > 0 && challenge.usedAt === null;
  }
  if (challenge.status === 'locked') {
    return challenge.attemptsLeft === 0 && challenge.usedAt === null;
  }
  return challenge.attemptsLeft > 0
    && validDate(challenge.usedAt)
    && challenge.usedAt.getTime() >= sentMs
    && challenge.usedAt.getTime() <= updatedMs;
}

async function consumeEmailChallenge({
  transaction,
  challengeId,
  purpose,
  clientInstanceId,
  accountId,
  sessionId,
  bindingId,
  code,
  secret,
  now
}) {
  const challengeRef = transaction
    .collection('email_codes')
    .doc(challengeId);
  const challenge = await optionalDocument(
    challengeRef,
    challengeId
  );
  if (!challenge) {
    return { result: failure('EMAIL_CODE_INVALID') };
  }
  if (!validEmailChallenge(challenge, challengeId)) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
  if (challenge.status === 'locked') {
    return { result: failure('EMAIL_CODE_LOCKED') };
  }
  if (challenge.status !== 'active') {
    return { result: failure('EMAIL_CODE_INVALID') };
  }
  if (now.getTime() < challenge.sentAt.getTime()) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
  if (now.getTime() >= challenge.expiresAt.getTime()) {
    return { result: failure('EMAIL_CODE_EXPIRED') };
  }
  const expectedScopeHash = emailScopeHash(secret, {
    purpose,
    clientInstanceId,
    accountId,
    sessionId,
    bindingId
  });
  if (
    challenge.purpose !== purpose
    || challenge.accountId !== accountId
    || challenge.emailBindingId !== bindingId
    || challenge.targetHash !== bindingId
    || !constantTimeHexEqual(
      challenge.scopeHash,
      expectedScopeHash
    )
  ) {
    return { result: failure('EMAIL_CODE_INVALID') };
  }
  const suppliedHash = emailCodeHash(
    secret,
    challengeId,
    code
  );
  if (!constantTimeHexEqual(challenge.codeHash, suppliedHash)) {
    const attemptsLeft = challenge.attemptsLeft - 1;
    await challengeRef.update({
      data: {
        attemptsLeft,
        status: attemptsLeft === 0 ? 'locked' : 'active',
        updatedAt: copyDate(now)
      }
    });
    return {
      result: failure(
        attemptsLeft === 0
          ? 'EMAIL_CODE_LOCKED'
          : 'EMAIL_CODE_INVALID'
      )
    };
  }
  return { challengeRef };
}

async function markEmailChallengeUsed(challengeRef, now) {
  await challengeRef.update({
    data: {
      status: 'used',
      usedAt: copyDate(now),
      updatedAt: copyDate(now)
    }
  });
}

function requireEmailCode(code) {
  if (typeof code !== 'string' || !EMAIL_CODE_RE.test(code)) {
    return failure('EMAIL_CODE_INVALID');
  }
  return null;
}

function requireNotPurging(user) {
  const status = Object.prototype.hasOwnProperty.call(
    user,
    'deletionStatus'
  ) ? user.deletionStatus : '';
  if (status === 'purging') {
    throw authError('ACCOUNT_DELETION_LOCKED');
  }
  if (status && status !== 'pending') {
    throw authError('AUTH_INTERNAL_ERROR');
  }
}

function validDeletionTimes(request) {
  return Number.isFinite(request.deletionRequestedAt)
    && Number.isFinite(request.deletionScheduledAt)
    && request.deletionRequestedAt <= request.deletionScheduledAt;
}

function deletionTimesMatch(user, request) {
  return Number.isFinite(user.deletionRequestedAt)
    && Number.isFinite(user.deletionScheduledAt)
    && validDeletionTimes(request)
    && user.deletionRequestedAt === request.deletionRequestedAt
    && user.deletionScheduledAt === request.deletionScheduledAt;
}

async function requirePasswordResetDeletionState({
  transaction,
  account,
  user,
  now
}) {
  const request = await optionalDocument(
    transaction
      .collection('account_deletion_requests')
      .doc(account._id),
    account._id
  );
  const status = Object.prototype.hasOwnProperty.call(
    user,
    'deletionStatus'
  ) ? user.deletionStatus : '';
  if (!status) {
    if (!request) return;
    if (
      request._id !== account._id
      || request.accountId !== account._id
      || request.deletionStatus !== 'canceled'
      || !validDeletionTimes(request)
      || !validDate(request.deletionCanceledAt)
      || !validDate(request.createdAt)
      || !validDate(request.updatedAt)
    ) {
      if (request.deletionStatus === 'purging') {
        throw authError('ACCOUNT_DELETION_LOCKED');
      }
      throw authError('AUTH_INTERNAL_ERROR');
    }
    return;
  }
  if (
    status === 'purging'
    || (request && request.deletionStatus === 'purging')
  ) {
    throw authError('ACCOUNT_DELETION_LOCKED');
  }
  if (
    status !== 'pending'
    || !request
    || request._id !== account._id
    || request.accountId !== account._id
    || request.deletionStatus !== 'pending'
    || !deletionTimesMatch(user, request)
    || !validDate(request.createdAt)
    || !validDate(request.updatedAt)
  ) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
  if (now.getTime() >= user.deletionScheduledAt) {
    throw authError('ACCOUNT_DELETION_LOCKED');
  }
}

function configuredPassword(account) {
  return Boolean(
    account.passwordAlgorithm === 'scrypt-v1'
    && /^[0-9a-f]{32}$/.test(account.passwordSalt)
    && /^[0-9a-f]{128}$/.test(account.passwordHash)
  );
}

function maskNormalizedPhone(normalizedPhone) {
  if (!/^\+861\d{10}$/.test(normalizedPhone)) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
  const national = normalizedPhone.slice(3);
  return national.slice(0, 3)
    + '****'
    + national.slice(-4);
}

function validSessionTimes(session, now) {
  if (
    !validDate(session.authenticatedAt)
    || !validDate(session.createdAt)
    || !validDate(session.lastSeenAt)
    || !validDate(session.idleExpiresAt)
    || !validDate(session.absoluteExpiresAt)
  ) {
    return false;
  }
  const authenticatedAt = session.authenticatedAt.getTime();
  const createdAt = session.createdAt.getTime();
  const lastSeenAt = session.lastSeenAt.getTime();
  const idleExpiresAt = session.idleExpiresAt.getTime();
  const absoluteExpiresAt = session.absoluteExpiresAt.getTime();
  return createdAt <= authenticatedAt
    && authenticatedAt <= now.getTime()
    && createdAt <= lastSeenAt
    && lastSeenAt <= now.getTime()
    && idleExpiresAt === lastSeenAt + SESSION_IDLE_TTL_MS
    && absoluteExpiresAt === createdAt + SESSION_ABSOLUTE_TTL_MS
    && now.getTime() < idleExpiresAt
    && now.getTime() < absoluteExpiresAt;
}

function validSessionDocumentId(id, keyVersion) {
  if (typeof id !== 'string' || typeof keyVersion !== 'string') {
    return false;
  }
  const parts = id.split('.');
  if (
    parts.length !== 3
    || parts[0] !== 'session'
    || !/^[A-Z0-9_]+$/.test(parts[1])
    || parts[1] !== keyVersion
    || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])
  ) {
    return false;
  }
  try {
    const bytes = Buffer.from(parts[2], 'base64url');
    return bytes.length === 32
      && bytes.toString('base64url') === parts[2];
  } catch (_) {
    return false;
  }
}

function validSessionShape(session, now) {
  return Boolean(
    session
    && typeof session === 'object'
    && !Array.isArray(session)
    && typeof session.accountId === 'string'
    && session.accountId.length > 0
    && session.accountId.length <= 128
    && Number.isSafeInteger(session.authVersion)
    && session.authVersion >= 1
    && typeof session.keyVersion === 'string'
    && validSessionDocumentId(session._id, session.keyVersion)
    && typeof session.clientInstanceId === 'string'
    && session.clientInstanceId.length > 0
    && session.clientInstanceId.length <= 256
    && typeof session.authenticationMethod === 'string'
    && session.authenticationMethod.length > 0
    && session.authenticationMethod.length <= 64
    && session.revokedAt === ''
    && session.revokeReason === ''
    && !Object.prototype.hasOwnProperty.call(session, 'sessionToken')
    && !Object.prototype.hasOwnProperty.call(session, 'token')
    && validSessionTimes(session, now)
  );
}

function validLiveSession(session, authenticated, now) {
  return Boolean(
    validSessionShape(session, now)
    && session._id === authenticated.session._id
    && session.accountId === authenticated.accountId
    && session.authVersion === authenticated.session.authVersion
    && session.keyVersion === authenticated.session.keyVersion
    && session.clientInstanceId
      === authenticated.session.clientInstanceId
  );
}

async function loadLiveSecurityGraph(transaction, authenticated, now) {
  const sessionRef = transaction
    .collection('auth_sessions')
    .doc(authenticated.session._id);
  const session = await optionalDocument(
    sessionRef,
    authenticated.session._id
  );
  if (!validLiveSession(session, authenticated, now)) {
    throw authError('SESSION_EXPIRED');
  }
  const graph = await readAccountGraph(
    transaction,
    authenticated.accountId
  );
  if (graph.account.status !== 'active') {
    throw authError('ACCOUNT_DISABLED');
  }
  if (!validAccount(graph.account, authenticated.accountId)) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
  if (graph.account.authVersion !== session.authVersion) {
    throw authError('SESSION_EXPIRED');
  }
  return {
    ...graph,
    session,
    sessionRef,
    accountRef: transaction
      .collection('accounts')
      .doc(graph.account._id)
  };
}

function ensureRecent(authenticated, now) {
  const recent = requireRecentAuthentication(
    authenticated.session,
    now
  );
  return recent === true ? null : failure(recent.code);
}

function requireRecentLiveSession(session, now) {
  const recent = requireRecentAuthentication(session, now);
  if (recent !== true) throw authError(recent.code);
}

async function readWechatProjection(source, account) {
  if (!account.wechatBindingId) return null;
  const parts = account.wechatBindingId.split('.');
  const candidate = {
    id: account.wechatBindingId,
    keyVersion: parts.length === 3 ? parts[1] : ''
  };
  const binding = await optionalDocument(
    source
      .collection('wechat_bindings')
      .doc(account.wechatBindingId),
    account.wechatBindingId
  );
  if (
    !binding
    || !validWechatBindingShape(binding, candidate)
    || binding.status !== 'active'
    || binding.accountId !== account._id
  ) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
  return binding;
}

async function securityProjection(source, account) {
  const accountNameRelation = await readAccountNameProjection(
    source,
    account
  );
  const phoneBinding = await readPhoneProjection(source, account);
  const emailBinding = await readEmailProjection(source, account);
  const wechatBinding = await readWechatProjection(source, account);
  return {
    accountNameRelation,
    phoneBinding,
    emailBinding,
    wechatBinding,
    account: accountNameRelation ? accountNameRelation.account : '',
    accountDisplay: accountDisplay(accountNameRelation, phoneBinding),
    accountNameSet: Boolean(accountNameRelation),
    passwordSet: configuredPassword(account),
    phoneBound: Boolean(phoneBinding),
    phoneMasked: phoneBinding ? phoneBinding.phoneMasked : '',
    emailBound: Boolean(emailBinding),
    emailMasked: emailBinding
      ? maskEmail(emailBinding.emailNormalized)
      : '',
    wechatBound: Boolean(wechatBinding)
  };
}

function mutationResponse(operation, projection) {
  return {
    ok: true,
    kind: 'security_mutation',
    operation,
    account: projection.account,
    accountDisplay: projection.accountDisplay,
    accountNameSet: projection.accountNameSet,
    passwordSet: projection.passwordSet,
    phoneBound: projection.phoneBound,
    phoneMasked: projection.phoneMasked,
    emailBound: projection.emailBound,
    emailMasked: projection.emailMasked,
    wechatBound: projection.wechatBound
  };
}

function rotatedResponse(rotated, projection, user) {
  return {
    ok: true,
    kind: 'session_rotated',
    sessionToken: rotated.sessionToken,
    account: projection.account,
    accountDisplay: projection.accountDisplay,
    roles: [...user.roles],
    currentRole: user.currentRole
  };
}

function validCountedSession(
  session,
  accountId,
  authVersion,
  now,
  keyring
) {
  return Boolean(
    validSessionShape(session, now)
    && session.accountId === accountId
    && session.authVersion === authVersion
    && keyring
    && keyring.keys instanceof Map
    && keyring.keys.has(session.keyVersion)
  );
}

async function countOtherSessions({
  db,
  accountId,
  authVersion,
  currentSessionId,
  now,
  keyring
}) {
  const pageSize = 100;
  let afterId = '';
  let count = 0;
  while (true) {
    const query = {
      accountId,
      authVersion,
      revokedAt: ''
    };
    if (afterId) {
      if (!db.command || typeof db.command.gt !== 'function') {
        throw authError('AUTH_INTERNAL_ERROR');
      }
      query._id = db.command.gt(afterId);
    }
    const page = await db
      .collection('auth_sessions')
      .where(query)
      .orderBy('_id', 'asc')
      .limit(pageSize)
      .get();
    if (
      !page
      || !Array.isArray(page.data)
      || page.data.length > pageSize
    ) {
      throw authError('AUTH_INTERNAL_ERROR');
    }
    let nextAfterId = afterId;
    for (const session of page.data) {
      if (
        !session
        || typeof session._id !== 'string'
        || !session._id
        || session._id <= nextAfterId
      ) {
        throw authError('AUTH_INTERNAL_ERROR');
      }
      nextAfterId = session._id;
    }
    count += page.data.filter((session) => (
      session._id !== currentSessionId
      && validCountedSession(
        session,
        accountId,
        authVersion,
        now,
        keyring
      )
    )).length;
    if (page.data.length < pageSize) return count;
    afterId = nextAfterId;
  }
}

async function status({
  db,
  authenticated,
  now,
  keyring
}) {
  if (
    !validAccount(authenticated.account, authenticated.accountId)
    || !validUser(authenticated.user, authenticated.accountId)
  ) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
  const projection = await securityProjection(
    db,
    authenticated.account
  );
  const otherSessionCount = await countOtherSessions({
    db,
    accountId: authenticated.accountId,
    authVersion: authenticated.account.authVersion,
    currentSessionId: authenticated.session._id,
    now,
    keyring
  });
  const reauthMethods = [];
  if (projection.passwordSet) reauthMethods.push('password');
  if (projection.phoneBound) reauthMethods.push('phone');
  if (projection.emailBound) reauthMethods.push('email');
  if (projection.wechatBound) reauthMethods.push('wechat');
  const session = authenticated.session;
  return {
    ok: true,
    kind: 'security_status',
    account: projection.account,
    accountNameSet: projection.accountNameSet,
    passwordSet: projection.passwordSet,
    phoneBound: projection.phoneBound,
    phoneMasked: projection.phoneMasked,
    emailBound: projection.emailBound,
    emailMasked: projection.emailMasked,
    wechatBound: projection.wechatBound,
    roles: [...authenticated.user.roles],
    currentRole: authenticated.user.currentRole,
    reauthMethods,
    currentSession: {
      authenticatedAt: session.authenticatedAt.getTime(),
      authenticationMethod: session.authenticationMethod,
      createdAt: session.createdAt.getTime(),
      lastSeenAt: session.lastSeenAt.getTime(),
      idleExpiresAt: session.idleExpiresAt.getTime(),
      absoluteExpiresAt: session.absoluteExpiresAt.getTime()
    },
    otherSessionCount
  };
}

function reauthRateCandidates(keyring, accountId) {
  try {
    return candidateHmacIds(
      keyring,
      'rate-limit',
      accountId,
      'pwd-reauth'
    );
  } catch (_) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
}

function normalizedReauthRate(record, candidate, now) {
  if (
    !record
    || record._id !== candidate.id
    || record.dimension !== 'reauth_account'
    || record.keyVersion !== candidate.keyVersion
    || !Number.isSafeInteger(record.failureCount)
    || record.failureCount < 0
    || !validDate(record.windowStartedAt)
    || !validDate(record.updatedAt)
    || !(
      record.blockedUntil === null
      || validDate(record.blockedUntil)
    )
    || record.windowStartedAt.getTime() > now.getTime()
  ) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
  if (
    now.getTime() - record.windowStartedAt.getTime()
      >= REAUTH_RATE_WINDOW_MS
  ) {
    return {
      failureCount: 0,
      windowStartedAt: copyDate(now),
      blockedUntil: record.blockedUntil
        ? copyDate(record.blockedUntil)
        : null
    };
  }
  return {
    failureCount: record.failureCount,
    windowStartedAt: copyDate(record.windowStartedAt),
    blockedUntil: record.blockedUntil
      ? copyDate(record.blockedUntil)
      : null
  };
}

async function readReauthRate(source, candidates, now) {
  const items = [];
  for (const candidate of candidates) {
    const ref = source
      .collection('password_rate_limits')
      .doc(candidate.id);
    const record = await optionalDocument(ref, candidate.id);
    items.push({
      candidate,
      ref,
      record,
      normalized: record
        ? normalizedReauthRate(record, candidate, now)
        : null
    });
  }
  const existing = items.filter((item) => item.normalized);
  const failureCount = existing.length
    ? Math.max(...existing.map((item) => item.normalized.failureCount))
    : 0;
  const starts = existing
    .filter((item) => item.normalized.failureCount > 0)
    .map((item) => item.normalized.windowStartedAt.getTime());
  const blocks = existing
    .filter((item) => item.normalized.blockedUntil)
    .map((item) => item.normalized.blockedUntil.getTime());
  return {
    items,
    state: {
      failureCount,
      windowStartedAt: new Date(
        starts.length ? Math.min(...starts) : now.getTime()
      ),
      blockedUntil: blocks.length
        ? new Date(Math.max(...blocks))
        : null
    }
  };
}

async function writeReauthRate(rate, state, now) {
  for (const item of rate.items) {
    if (!item.record && !item.candidate.isActive) continue;
    const data = {
      dimension: 'reauth_account',
      keyVersion: item.candidate.keyVersion,
      windowStartedAt: copyDate(state.windowStartedAt),
      failureCount: state.failureCount,
      blockedUntil: state.blockedUntil
        ? copyDate(state.blockedUntil)
        : null,
      updatedAt: copyDate(now)
    };
    if (item.record) await item.ref.update({ data });
    else await item.ref.set({ data });
  }
}

async function recordReauthFailure(source, candidates, now) {
  const rate = await readReauthRate(source, candidates, now);
  if (
    rate.state.blockedUntil
    && now.getTime() < rate.state.blockedUntil.getTime()
  ) {
    await writeReauthRate(rate, rate.state, now);
    return true;
  }
  const failureCount = rate.state.failureCount + 1;
  const limited = failureCount >= REAUTH_RATE_LIMIT;
  await writeReauthRate(rate, {
    failureCount,
    windowStartedAt: rate.state.failureCount
      ? rate.state.windowStartedAt
      : copyDate(now),
    blockedUntil: limited
      ? new Date(now.getTime() + REAUTH_RATE_BLOCK_MS)
      : null
  }, now);
  return limited;
}

async function clearReauthRate(source, candidates, now) {
  const rate = await readReauthRate(source, candidates, now);
  if (
    rate.state.blockedUntil
    && now.getTime() < rate.state.blockedUntil.getTime()
  ) {
    await writeReauthRate(rate, rate.state, now);
    return false;
  }
  if (rate.items.some((item) => item.record)) {
    await writeReauthRate(rate, {
      failureCount: 0,
      windowStartedAt: copyDate(now),
      blockedUntil: null
    }, now);
  }
  return true;
}

async function markReauthenticated(live, now, method) {
  await live.sessionRef.update({
    data: {
      authenticatedAt: copyDate(now),
      authenticationMethod: method
    }
  });
  return {
    ok: true,
    kind: 'reauthenticated',
    authenticatedAt: now.getTime(),
    authenticationMethod: method
  };
}

async function reauthenticatePassword({
  db,
  event,
  authenticated,
  now,
  keyring
}) {
  const candidates = reauthRateCandidates(
    keyring,
    authenticated.accountId
  );
  const preflightRate = await readReauthRate(db, candidates, now);
  const valid = verifyPasswordOrDummy(
    event.password,
    authenticated.account
  );
  if (
    preflightRate.state.blockedUntil
    && now.getTime() < preflightRate.state.blockedUntil.getTime()
  ) {
    await db.runTransaction((transaction) => (
      clearReauthRate(transaction, candidates, now)
    ));
    return failure('PASSWORD_RATE_LIMITED');
  }
  if (!valid) {
    const limited = await db.runTransaction((transaction) => (
      recordReauthFailure(transaction, candidates, now)
    ));
    return failure(
      limited ? 'PASSWORD_RATE_LIMITED' : 'INVALID_CREDENTIALS'
    );
  }
  return db.runTransaction(async (transaction) => {
    const live = await loadLiveSecurityGraph(
      transaction,
      authenticated,
      now
    );
    if (
      live.account.passwordAlgorithm
        !== authenticated.account.passwordAlgorithm
      || live.account.passwordSalt
        !== authenticated.account.passwordSalt
      || live.account.passwordHash
        !== authenticated.account.passwordHash
    ) {
      throw authError('AUTH_CONFLICT');
    }
    if (!await clearReauthRate(transaction, candidates, now)) {
      return failure('PASSWORD_RATE_LIMITED');
    }
    return markReauthenticated(live, now, 'password');
  });
}

async function reauthenticatePhone({
  db,
  event,
  authenticated,
  now,
  keyring,
  trustedWechat
}) {
  const normalizedPhone = normalizePhone(event.phone);
  const candidates = phoneCandidates(keyring, normalizedPhone);
  const expectedScope = {
    purpose: 'reauth',
    clientInstanceId: event.clientInstanceId,
    wechatBindingInput: trustedWechat.identity.bindingInput,
    accountId: authenticated.accountId,
    sessionId: authenticated.session._id
  };
  return db.runTransaction(async (transaction) => {
    const live = await loadLiveSecurityGraph(
      transaction,
      authenticated,
      now
    );
    const items = await readPhoneCandidateItems(transaction, candidates);
    const selected = selectPhoneBinding(items);
    if (
      !selected
      || selected.binding.accountId !== live.account._id
      || live.account.phoneBindingId !== selected.binding._id
    ) {
      throw authError('INVALID_CREDENTIALS');
    }
    const consumed = await consumeSmsChallenge({
      transaction,
      challengeId: event.challengeId,
      code: event.code,
      expectedPurpose: 'reauth',
      expectedScope,
      now,
      keyring
    });
    if (!consumed.ok) return failure(consumed.code);
    if (!candidates.some(
      (candidate) => candidate.id === consumed.phoneBindingId
    )) {
      throw authError('SMS_CODE_INVALID');
    }
    if (consumed.phoneMasked !== maskNormalizedPhone(normalizedPhone)) {
      throw authError('AUTH_INTERNAL_ERROR');
    }
    await migratePhoneBinding({
      items,
      selected,
      accountRef: live.accountRef,
      account: live.account,
      phoneMasked: consumed.phoneMasked,
      now
    });
    return markReauthenticated(live, now, 'sms');
  });
}

async function reauthenticateWechat({
  db,
  authenticated,
  now,
  keyring,
  trustedWechat
}) {
  const material = wechatMaterial(keyring, trustedWechat);
  return db.runTransaction(async (transaction) => {
    const live = await loadLiveSecurityGraph(
      transaction,
      authenticated,
      now
    );
    const items = await readWechatCandidateItems(transaction, material);
    const selected = selectWechatBinding(items);
    if (
      !selected
      || selected.binding.accountId !== live.account._id
      || live.account.wechatBindingId !== selected.binding._id
    ) {
      throw authError('INVALID_CREDENTIALS');
    }
    await migrateWechatBinding({
      items,
      selected,
      account: live.account,
      accountRef: live.accountRef,
      now
    });
    return markReauthenticated(live, now, 'wechat');
  });
}

async function reauthenticateEmail({
  db,
  event,
  authenticated,
  now
}) {
  const invalidCode = requireEmailCode(event.code);
  if (invalidCode) return invalidCode;
  const secret = emailCodeSecret();
  return db.runTransaction(async (transaction) => {
    const live = await loadLiveSecurityGraph(
      transaction,
      authenticated,
      now
    );
    requireNotPurging(live.user);
    const binding = await readEmailProjection(
      transaction,
      live.account
    );
    if (!binding) return failure('EMAIL_NOT_BOUND');
    const consumed = await consumeEmailChallenge({
      transaction,
      challengeId: emailCodeId(
        'reauth',
        binding.emailNormalized
      ),
      purpose: 'reauth',
      clientInstanceId: event.clientInstanceId,
      accountId: live.account._id,
      sessionId: live.session._id,
      bindingId: binding._id,
      code: event.code,
      secret,
      now
    });
    if (consumed.result) return consumed.result;
    await markEmailChallengeUsed(consumed.challengeRef, now);
    return markReauthenticated(live, now, 'email');
  });
}

async function reauthenticate(options) {
  if (options.event.method === 'password') {
    return reauthenticatePassword(options);
  }
  if (options.event.method === 'phone') {
    return reauthenticatePhone(options);
  }
  if (options.event.method === 'wechat') {
    return reauthenticateWechat(options);
  }
  if (options.event.method === 'email') {
    return reauthenticateEmail(options);
  }
  return failure('INVALID_INPUT');
}

async function bindEmail({
  db,
  event,
  authenticated,
  now
}) {
  const normalizedEmail = normalizeEmail(event.email);
  const invalidCode = requireEmailCode(event.code);
  if (invalidCode) return invalidCode;
  const secret = emailCodeSecret();
  const bindingId = emailBindingId(normalizedEmail);
  const challengeId = emailCodeId('bind', normalizedEmail);
  return db.runTransaction(async (transaction) => {
    const live = await loadLiveSecurityGraph(
      transaction,
      authenticated,
      now
    );
    requireNotPurging(live.user);
    const consumed = await consumeEmailChallenge({
      transaction,
      challengeId,
      purpose: 'bind',
      clientInstanceId: event.clientInstanceId,
      accountId: live.account._id,
      sessionId: '',
      bindingId,
      code: event.code,
      secret,
      now
    });
    if (consumed.result) return consumed.result;

    const currentBinding = await readEmailProjection(
      transaction,
      live.account
    );
    const targetRef = transaction
      .collection('email_bindings')
      .doc(bindingId);
    const targetBinding = await readEmailBinding(
      transaction,
      bindingId
    );
    const reverseAccounts = await readEmailReverseAccounts(
      transaction,
      bindingId
    );
    if (
      targetBinding
      && targetBinding.status === 'active'
    ) {
      if (
        reverseAccounts.length !== 1
        || reverseAccounts[0]._id !== targetBinding.accountId
      ) {
        throw authError('AUTH_INTERNAL_ERROR');
      }
    } else if (reverseAccounts.length !== 0) {
      throw authError('AUTH_INTERNAL_ERROR');
    }
    if (
      targetBinding
      && targetBinding.status === 'active'
      && targetBinding.accountId !== live.account._id
    ) {
      throw authError('EMAIL_ALREADY_BOUND');
    }
    if (
      targetBinding
      && targetBinding.status === 'active'
      && (
        !currentBinding
        || currentBinding._id !== targetBinding._id
      )
    ) {
      throw authError('AUTH_INTERNAL_ERROR');
    }
    if (currentBinding && currentBinding._id !== bindingId) {
      await transaction
        .collection('email_bindings')
        .doc(currentBinding._id)
        .update({
          data: {
            status: 'revoked',
            revokedAt: copyDate(now),
            updatedAt: copyDate(now)
          }
        });
    }
    const binding = {
      _id: bindingId,
      accountId: live.account._id,
      email: normalizedEmail,
      emailNormalized: normalizedEmail,
      status: 'active',
      boundAt: copyDate(now),
      updatedAt: copyDate(now)
    };
    await targetRef.set({ data: withoutDocumentId(binding) });
    const updatedAt = copyDate(now);
    await live.accountRef.update({
      data: {
        emailBindingId: bindingId,
        updatedAt
      }
    });
    await markEmailChallengeUsed(consumed.challengeRef, now);
    const account = {
      ...live.account,
      emailBindingId: bindingId,
      updatedAt
    };
    const projection = await securityProjection(transaction, account);
    return mutationResponse('bind_email', projection);
  });
}

async function bindPhone({
  db,
  event,
  authenticated,
  now,
  keyring,
  trustedWechat
}) {
  const recentFailure = ensureRecent(authenticated, now);
  if (recentFailure) return recentFailure;
  const normalizedPhone = normalizePhone(event.phone);
  const candidates = phoneCandidates(keyring, normalizedPhone);
  const expectedScope = {
    purpose: 'bind_phone',
    clientInstanceId: event.clientInstanceId,
    wechatBindingInput: trustedWechat.identity.bindingInput,
    accountId: authenticated.accountId,
    sessionId: ''
  };
  return db.runTransaction(async (transaction) => {
    const live = await loadLiveSecurityGraph(
      transaction,
      authenticated,
      now
    );
    requireRecentLiveSession(live.session, now);
    if (live.account.phoneBindingId) {
      throw authError('ACCOUNT_PHONE_ALREADY_BOUND');
    }
    const items = await readPhoneCandidateItems(transaction, candidates);
    if (selectPhoneBinding(items)) {
      throw authError('PHONE_ALREADY_BOUND');
    }
    const consumed = await consumeSmsChallenge({
      transaction,
      challengeId: event.challengeId,
      code: event.code,
      expectedPurpose: 'bind_phone',
      expectedScope,
      now,
      keyring
    });
    if (!consumed.ok) return failure(consumed.code);
    if (!candidates.some(
      (candidate) => candidate.id === consumed.phoneBindingId
    )) {
      throw authError('SMS_CODE_INVALID');
    }
    if (consumed.phoneMasked !== maskNormalizedPhone(normalizedPhone)) {
      throw authError('AUTH_INTERNAL_ERROR');
    }
    const phoneBinding = newPhoneBindingRecord({
      id: candidates[0].id,
      accountId: live.account._id,
      keyVersion: candidates[0].keyVersion,
      phoneMasked: consumed.phoneMasked,
      now
    });
    await items[0].ref.set({
      data: withoutDocumentId(phoneBinding)
    });
    const updatedAt = copyDate(now);
    await live.accountRef.update({
      data: {
        phoneBindingId: phoneBinding._id,
        updatedAt
      }
    });
    const account = {
      ...live.account,
      phoneBindingId: phoneBinding._id,
      updatedAt
    };
    const projection = await securityProjection(transaction, account);
    return mutationResponse('bind_phone', projection);
  });
}

async function setAccountName({
  db,
  event,
  authenticated,
  now
}) {
  const recentFailure = ensureRecent(authenticated, now);
  if (recentFailure) return recentFailure;
  const normalized = normalizeAccountName(event.accountName);
  const display = event.accountName.trim();
  const relationId = accountNameDocumentId(normalized);
  return db.runTransaction(async (transaction) => {
    const live = await loadLiveSecurityGraph(
      transaction,
      authenticated,
      now
    );
    requireRecentLiveSession(live.session, now);
    if (live.account.accountNameBindingId) {
      throw authError('ACCOUNT_NAME_EXISTS');
    }
    const relationRef = transaction
      .collection('account_names')
      .doc(relationId);
    if (await optionalDocument(relationRef, relationId)) {
      throw authError('ACCOUNT_NAME_EXISTS');
    }
    const relation = {
      _id: relationId,
      accountId: live.account._id,
      account: display,
      accountNormalized: normalized,
      status: 'active',
      createdAt: copyDate(now),
      updatedAt: copyDate(now)
    };
    await relationRef.set({ data: withoutDocumentId(relation) });
    await live.accountRef.update({
      data: {
        accountNameBindingId: relationId,
        updatedAt: copyDate(now)
      }
    });
    const account = {
      ...live.account,
      accountNameBindingId: relationId,
      updatedAt: copyDate(now)
    };
    if (!validAccountNameRelation(
      relation,
      relationId,
      account,
      normalized
    )) {
      throw authError('AUTH_INTERNAL_ERROR');
    }
    const projection = await securityProjection(transaction, account);
    return mutationResponse('set_account_name', projection);
  });
}

async function bindWechat({
  db,
  authenticated,
  now,
  keyring,
  trustedWechat
}) {
  const recentFailure = ensureRecent(authenticated, now);
  if (recentFailure) return recentFailure;
  const material = wechatMaterial(keyring, trustedWechat);
  return db.runTransaction(async (transaction) => {
    const live = await loadLiveSecurityGraph(
      transaction,
      authenticated,
      now
    );
    requireRecentLiveSession(live.session, now);
    if (live.account.wechatBindingId) {
      throw authError('ACCOUNT_WECHAT_ALREADY_BOUND');
    }
    const items = await readWechatCandidateItems(transaction, material);
    if (selectWechatBinding(items)) {
      throw authError('WECHAT_ALREADY_BOUND');
    }
    const binding = newWechatBindingRecord({
      candidate: material.candidates[0],
      accountId: live.account._id,
      now
    });
    await items[0].ref.set({ data: withoutDocumentId(binding) });
    const updatedAt = copyDate(now);
    await live.accountRef.update({
      data: {
        wechatBindingId: binding._id,
        updatedAt
      }
    });
    const account = {
      ...live.account,
      wechatBindingId: binding._id,
      updatedAt
    };
    const projection = await securityProjection(transaction, account);
    return mutationResponse('bind_wechat', projection);
  });
}

async function resetPasswordByEmail({
  db,
  event,
  now
}) {
  const normalizedEmail = normalizeEmail(event.email);
  const invalidCode = requireEmailCode(event.code);
  if (invalidCode) return invalidCode;
  const secret = emailCodeSecret();
  const passwordRecord = hashPassword(event.password);
  const bindingId = emailBindingId(normalizedEmail);
  const challengeId = emailCodeId('reset', normalizedEmail);
  return db.runTransaction(async (transaction) => {
    const binding = await readEmailBinding(transaction, bindingId);
    if (!binding || binding.status !== 'active') {
      return failure('EMAIL_CODE_INVALID');
    }
    const reverseAccounts = await readEmailReverseAccounts(
      transaction,
      bindingId
    );
    if (
      reverseAccounts.length !== 1
      || reverseAccounts[0]._id !== binding.accountId
    ) {
      throw authError('AUTH_INTERNAL_ERROR');
    }
    const graph = await readAccountGraph(
      transaction,
      binding.accountId,
      true
    );
    if (graph.account.status !== 'active') {
      return failure('EMAIL_CODE_INVALID');
    }
    if (graph.account.emailBindingId !== binding._id) {
      throw authError('AUTH_INTERNAL_ERROR');
    }
    await requirePasswordResetDeletionState({
      transaction,
      account: graph.account,
      user: graph.user,
      now
    });
    const consumed = await consumeEmailChallenge({
      transaction,
      challengeId,
      purpose: 'reset',
      clientInstanceId: event.clientInstanceId,
      accountId: graph.account._id,
      sessionId: '',
      bindingId,
      code: event.code,
      secret,
      now
    });
    if (consumed.result) return consumed.result;
    if (graph.account.authVersion >= Number.MAX_SAFE_INTEGER) {
      throw authError('AUTH_INTERNAL_ERROR');
    }
    await transaction
      .collection('accounts')
      .doc(graph.account._id)
      .update({
        data: {
          ...passwordRecord,
          authVersion: graph.account.authVersion + 1,
          updatedAt: copyDate(now)
        }
      });
    await markEmailChallengeUsed(consumed.challengeRef, now);
    return {
      ok: true,
      kind: 'password_reset',
      next: 'login'
    };
  });
}

async function readWechatReverseAccounts(source, material) {
  const accounts = [];
  for (const candidate of material.candidates) {
    let result;
    try {
      result = await source
        .collection('accounts')
        .where({ wechatBindingId: candidate.id })
        .limit(2)
        .get();
    } catch (_) {
      throw authError('AUTH_INTERNAL_ERROR');
    }
    if (
      !result
      || !Array.isArray(result.data)
      || result.data.length > 1
      || result.data.some((account) => (
        !validAccountCore(account, account && account._id)
      ))
    ) {
      throw authError('AUTH_INTERNAL_ERROR');
    }
    accounts.push(...result.data);
    if (accounts.length > 1) {
      throw authError('AUTH_INTERNAL_ERROR');
    }
  }
  return accounts;
}

function remapWechatRecoveryError(error) {
  if (
    error
    && error.name === 'AccountAuthAbort'
    && error.code === 'WECHAT_IDENTITY_CONFLICT'
  ) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
  throw error;
}

async function resetPasswordByWechat({
  db,
  event,
  now,
  keyring,
  trustedWechat
}) {
  const passwordRecord = hashPassword(event.password);
  const material = wechatMaterial(keyring, trustedWechat);
  return db.runTransaction(async (transaction) => {
    let items;
    let selected;
    try {
      items = await readWechatCandidateItems(transaction, material);
      selected = selectWechatBinding(items);
    } catch (error) {
      remapWechatRecoveryError(error);
    }
    const reverseAccounts = await readWechatReverseAccounts(
      transaction,
      material
    );
    if (!selected) {
      if (reverseAccounts.length) {
        throw authError('AUTH_INTERNAL_ERROR');
      }
      return failure('WECHAT_NOT_BOUND');
    }
    if (
      reverseAccounts.length !== 1
      || reverseAccounts[0]._id !== selected.binding.accountId
      || reverseAccounts[0].wechatBindingId !== selected.binding._id
    ) {
      throw authError('AUTH_INTERNAL_ERROR');
    }
    const graph = await readAccountGraph(
      transaction,
      selected.binding.accountId,
      true
    );
    if (graph.account.status !== 'active') {
      throw authError('ACCOUNT_DISABLED');
    }
    await requirePasswordResetDeletionState({
      transaction,
      account: graph.account,
      user: graph.user,
      now
    });
    const accountRef = transaction
      .collection('accounts')
      .doc(graph.account._id);
    let migrated;
    try {
      migrated = await migrateWechatBinding({
        items,
        selected,
        account: graph.account,
        accountRef,
        now
      });
    } catch (error) {
      remapWechatRecoveryError(error);
    }
    if (migrated.account.authVersion >= Number.MAX_SAFE_INTEGER) {
      throw authError('AUTH_INTERNAL_ERROR');
    }
    await accountRef.update({
      data: {
        ...passwordRecord,
        authVersion: migrated.account.authVersion + 1,
        updatedAt: copyDate(now)
      }
    });
    return {
      ok: true,
      kind: 'password_reset',
      next: 'login'
    };
  });
}

async function setPassword({
  db,
  event,
  authenticated,
  now,
  keyring
}) {
  const recentFailure = ensureRecent(authenticated, now);
  if (recentFailure) return recentFailure;
  const passwordRecord = hashPassword(event.password);
  const preparedSessionToken = prepareSessionToken(keyring);
  return db.runTransaction(async (transaction) => {
    const live = await loadLiveSecurityGraph(
      transaction,
      authenticated,
      now
    );
    requireRecentLiveSession(live.session, now);
    const liveUser = await cancelPendingDeletion({
      transaction,
      db,
      account: live.account,
      user: live.user,
      now
    });
    const updatedAt = copyDate(now);
    await live.accountRef.update({
      data: {
        ...passwordRecord,
        updatedAt
      }
    });
    const account = {
      ...live.account,
      ...passwordRecord,
      updatedAt
    };
    const projection = await securityProjection(transaction, account);
    const rotated = await revokeOtherSessions({
      transaction,
      account,
      currentSession: live.session,
      now,
      keyring,
      preparedSessionToken
    });
    return rotatedResponse(rotated, projection, liveUser);
  });
}

async function logoutOthers({
  db,
  authenticated,
  now,
  keyring
}) {
  const recentFailure = ensureRecent(authenticated, now);
  if (recentFailure) return recentFailure;
  const preparedSessionToken = prepareSessionToken(keyring);
  return db.runTransaction(async (transaction) => {
    const live = await loadLiveSecurityGraph(
      transaction,
      authenticated,
      now
    );
    requireRecentLiveSession(live.session, now);
    const liveUser = await cancelPendingDeletion({
      transaction,
      db,
      account: live.account,
      user: live.user,
      now
    });
    const updatedAt = copyDate(now);
    await live.accountRef.update({ data: { updatedAt } });
    const account = { ...live.account, updatedAt };
    const projection = await securityProjection(transaction, account);
    const rotated = await revokeOtherSessions({
      transaction,
      account,
      currentSession: live.session,
      now,
      keyring,
      preparedSessionToken
    });
    return rotatedResponse(rotated, projection, liveUser);
  });
}

async function logoutCurrent({
  db,
  authenticated,
  now
}) {
  return db.runTransaction(async (transaction) => {
    await revokeCurrentSession({
      transaction,
      session: authenticated.session,
      now,
      reason: 'session_revoked'
    });
    return { ok: true, kind: 'session_revoked' };
  });
}

module.exports = {
  bindEmail,
  bindPhone,
  bindWechat,
  logoutCurrent,
  logoutOthers,
  reauthenticate,
  resetPasswordByEmail,
  resetPasswordByWechat,
  setAccountName,
  setPassword,
  status
};
