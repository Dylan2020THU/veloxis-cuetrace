const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const { ses } = require('tencentcloud-sdk-nodejs-ses');
const { loadKeyring } = require('./lib/auth/keyring');
const { requireSession } = require('./lib/auth/session');

const SesClient = ses.v20201002.Client;

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database({ throwOnNotFound: false });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PUBLIC_RESET_RESULT = {
  ok: true,
  accepted: true,
  msg: '若信息匹配，验证码将发送至绑定邮箱'
};
const SES_TIMEOUT_MS = 8000;
const RESET_RESPONSE_MIN_MS = SES_TIMEOUT_MS + 1500;
const COOLDOWN_MS = 60 * 1000;
const EXPIRES_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_IDLE_TTL_MS = 30 * DAY_MS;
const SESSION_ABSOLUTE_TTL_MS = 90 * DAY_MS;
const ALLOWED_ROLES = Object.freeze(['member', 'coach', 'shop']);
const ACCOUNT_ID_RE = /^acct_[A-Za-z0-9_-]{22,}$/;
const EMAIL_ID_RE = /^[0-9a-f]{64}$/;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function emailBindingId(email) {
  return sha256(`email:${normalizeEmail(email)}`);
}

function emailCodeId(purpose, email) {
  return sha256(`email-code:${purpose}:${normalizeEmail(email)}`);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function validClientInstanceId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256;
}

function validateRequest(input) {
  if (!isPlainObject(input) || !validClientInstanceId(input.clientInstanceId)) {
    return { error: 'INVALID_INPUT' };
  }
  if (input.purpose === 'reset') {
    return hasExactKeys(input, ['clientInstanceId', 'purpose', 'email'])
      ? { ok: true }
      : { error: 'INVALID_INPUT' };
  }
  if (input.purpose === 'bind') {
    if (hasExactKeys(input, ['clientInstanceId', 'purpose', 'email'])) {
      return { error: 'SESSION_REQUIRED' };
    }
    return hasExactKeys(
      input,
      ['clientInstanceId', 'purpose', 'email', 'sessionToken']
    ) ? { ok: true } : { error: 'INVALID_INPUT' };
  }
  if (input.purpose === 'reauth') {
    if (hasExactKeys(input, ['clientInstanceId', 'purpose'])) {
      return { error: 'SESSION_REQUIRED' };
    }
    return hasExactKeys(
      input,
      ['clientInstanceId', 'purpose', 'sessionToken']
    ) ? { ok: true } : { error: 'INVALID_INPUT' };
  }
  return { error: 'INVALID_INPUT' };
}

function dateValue(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return new Date(value.getTime());
  }
  if (Number.isSafeInteger(value)) {
    const result = new Date(value);
    if (Number.isFinite(result.getTime())) return result;
  }
  return null;
}

function validDate(value) {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function validAuthVersion(value) {
  return Number.isSafeInteger(value) && value >= 1;
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

function validAccount(account, id) {
  return isPlainObject(account)
    && account._id === id
    && ACCOUNT_ID_RE.test(account._id)
    && validAuthVersion(account.authVersion)
    && ['active', 'disabled'].includes(account.status)
    && typeof account.accountNameBindingId === 'string'
    && typeof account.phoneBindingId === 'string'
    && typeof account.wechatBindingId === 'string'
    && typeof account.emailBindingId === 'string'
    && validPasswordState(account)
    && typeof account.termsVersion === 'string'
    && typeof account.privacyVersion === 'string'
    && validDate(account.termsAcceptedAt)
    && validDate(account.privacyAcceptedAt)
    && validDate(account.createdAt)
    && validDate(account.updatedAt);
}

function validUser(user, accountIdValue) {
  return isPlainObject(user)
    && user._id === accountIdValue
    && Array.isArray(user.roles)
    && user.roles.length > 0
    && user.roles.length <= ALLOWED_ROLES.length
    && user.roles.every((role) => ALLOWED_ROLES.includes(role))
    && new Set(user.roles).size === user.roles.length
    && ALLOWED_ROLES.includes(user.currentRole)
    && user.role === user.currentRole
    && user.roles.includes(user.currentRole)
    && typeof user.nickname === 'string'
    && typeof user.avatar === 'string'
    && validDate(user.createdAt)
    && validDate(user.updatedAt);
}

function validLiveSession(live, supplied, now, keyring) {
  if (
    !isPlainObject(live)
    || !isPlainObject(supplied)
    || live._id !== supplied._id
    || live.accountId !== supplied.accountId
    || live.keyVersion !== supplied.keyVersion
    || live.authVersion !== supplied.authVersion
    || live.clientInstanceId !== supplied.clientInstanceId
    || live.authenticationMethod !== supplied.authenticationMethod
    || live.revokedAt !== ''
    || live.revokeReason !== ''
    || hasOwn(live, 'sessionToken')
    || hasOwn(live, 'token')
    || !validAuthVersion(live.authVersion)
    || !keyring
    || !(keyring.keys instanceof Map)
    || !keyring.keys.has(live.keyVersion)
  ) {
    return false;
  }
  const authenticatedAt = dateValue(live.authenticatedAt);
  const createdAt = dateValue(live.createdAt);
  const lastSeenAt = dateValue(live.lastSeenAt);
  const idleExpiresAt = dateValue(live.idleExpiresAt);
  const absoluteExpiresAt = dateValue(live.absoluteExpiresAt);
  const nowDate = dateValue(now);
  if (
    !authenticatedAt
    || !createdAt
    || !lastSeenAt
    || !idleExpiresAt
    || !absoluteExpiresAt
    || !nowDate
  ) {
    return false;
  }
  const authenticatedMs = authenticatedAt.getTime();
  const createdMs = createdAt.getTime();
  const lastSeenMs = lastSeenAt.getTime();
  const idleExpiresMs = idleExpiresAt.getTime();
  const absoluteExpiresMs = absoluteExpiresAt.getTime();
  const nowMs = nowDate.getTime();
  return authenticatedMs >= createdMs
    && authenticatedMs <= nowMs
    && lastSeenMs >= createdMs
    && lastSeenMs <= nowMs
    && idleExpiresMs === lastSeenMs + SESSION_IDLE_TTL_MS
    && absoluteExpiresMs === createdMs + SESSION_ABSOLUTE_TTL_MS
    && nowMs < idleExpiresMs
    && nowMs < absoluteExpiresMs;
}

function deletionState(user, now) {
  if (!isPlainObject(user)) return 'invalid';
  if (!hasOwn(user, 'deletionStatus')) return 'active';
  if (user.deletionStatus === 'purging') return 'locked';
  if (user.deletionStatus !== 'pending') return 'invalid';
  if (
    !Number.isFinite(user.deletionRequestedAt)
    || !Number.isFinite(user.deletionScheduledAt)
    || user.deletionRequestedAt > user.deletionScheduledAt
  ) {
    return 'invalid';
  }
  const scheduledAt = Number(user.deletionScheduledAt);
  return now.getTime() >= scheduledAt ? 'locked' : 'active';
}

function validEmailBinding(binding, id, account) {
  if (
    !isPlainObject(binding)
    || !validAccount(account, binding.accountId)
    || binding._id !== id
    || binding.status !== 'active'
    || account.emailBindingId !== id
    || typeof binding.email !== 'string'
    || typeof binding.emailNormalized !== 'string'
    || binding.email !== binding.emailNormalized
    || normalizeEmail(binding.email) !== binding.email
    || !EMAIL_RE.test(binding.email)
    || binding.email.length > 254
    || emailBindingId(binding.email) !== id
    || !validDate(binding.boundAt)
    || !validDate(binding.updatedAt)
    || hasOwn(binding, '_openid')
    || hasOwn(binding, 'account')
    || hasOwn(binding, 'accountNormalized')
    || hasOwn(binding, 'emailMasked')
    || hasOwn(binding, 'verifiedAt')
    || hasOwn(binding, 'createdAt')
    || hasOwn(binding, 'revokedAt')
  ) {
    return false;
  }
  return true;
}

function validRevokedEmailBinding(binding, id) {
  if (
    !isPlainObject(binding)
    || binding._id !== id
    || !EMAIL_ID_RE.test(binding._id)
    || !ACCOUNT_ID_RE.test(binding.accountId)
    || binding.status !== 'revoked'
    || typeof binding.email !== 'string'
    || binding.email !== binding.emailNormalized
    || normalizeEmail(binding.email) !== binding.email
    || !EMAIL_RE.test(binding.email)
    || binding.email.length > 254
    || emailBindingId(binding.email) !== id
    || !validDate(binding.boundAt)
    || !validDate(binding.updatedAt)
    || !validDate(binding.revokedAt)
    || [
      '_openid',
      'account',
      'accountNormalized',
      'emailMasked',
      'verifiedAt',
      'createdAt'
    ].some((field) => hasOwn(binding, field))
  ) {
    return false;
  }
  return true;
}

function lengthPrefixed(value) {
  if (typeof value !== 'string') throw new TypeError('invalid HMAC field');
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function hmacFields(secret, domain, fields) {
  if (
    typeof secret !== 'string'
    || secret.length === 0
    || typeof domain !== 'string'
    || domain.length === 0
    || !Array.isArray(fields)
    || fields.some((field) => typeof field !== 'string')
  ) {
    throw new TypeError('invalid HMAC input');
  }
  return crypto.createHmac('sha256', secret)
    .update(Buffer.concat([
      lengthPrefixed(domain),
      ...fields.map(lengthPrefixed)
    ]))
    .digest('hex');
}

function challengeScopeHash(config, scope) {
  return hmacFields(config.codeSecret, 'email-scope-v2', [
    scope.purpose,
    scope.clientInstanceId,
    scope.accountId,
    scope.sessionId,
    scope.emailBindingId
  ]);
}

function rateScopeHash(config, scope) {
  return hmacFields(config.codeSecret, 'email-rate-scope-v2', [
    scope.purpose,
    scope.clientInstanceId,
    scope.accountId,
    scope.sessionId
  ]);
}

function emailRateId(actorScopeHash) {
  return sha256(`email-rate:${actorScopeHash}`);
}

function getConfig() {
  return {
    secretId: process.env.CUETRACE_SES_SECRET_ID || '',
    secretKey: process.env.CUETRACE_SES_SECRET_KEY || '',
    region: process.env.CUETRACE_SES_REGION || 'ap-guangzhou',
    fromEmail: process.env.CUETRACE_SES_FROM_EMAIL || '',
    templateId: Number(process.env.CUETRACE_SES_TEMPLATE_ID || 0),
    subject: process.env.CUETRACE_SES_SUBJECT || '强化杆迹验证码',
    replyTo: process.env.CUETRACE_SES_REPLY_TO || '',
    codeSecret: process.env.CUETRACE_EMAIL_CODE_SECRET || ''
  };
}

function isConfigured(config) {
  return !!(
    config.secretId &&
    config.secretKey &&
    config.region &&
    config.fromEmail &&
    Number.isInteger(config.templateId) &&
    config.templateId > 0 &&
    config.codeSecret
  );
}

function messageFor(code) {
  const messages = {
    INVALID_INPUT: '请求参数不正确',
    SESSION_REQUIRED: '请先登录',
    SESSION_EXPIRED: '登录状态已失效，请重新登录',
    ACCOUNT_DISABLED: '账号已停用',
    ACCOUNT_DELETION_LOCKED: '账号注销已进入删除流程',
    AUTH_INTERNAL_ERROR: '认证服务异常，请稍后重试',
    EMAIL_INVALID: '邮箱格式不正确',
    EMAIL_NOT_BOUND: '当前账号尚未绑定邮箱',
    EMAIL_ALREADY_BOUND: '该邮箱已绑定其他账号',
    EMAIL_CODE_COOLDOWN: '请稍后重新发送',
    EMAIL_NOT_CONFIGURED: '邮件服务尚未配置',
    EMAIL_SEND_FAILED: '邮件发送失败，请稍后重试'
  };
  return messages[code] || '请求失败';
}

function fail(code) {
  return { ok: false, code, msg: messageFor(code) };
}

async function publicResetResult(startedAt) {
  const elapsed = Math.max(0, Date.now() - startedAt);
  const remaining = Math.max(0, RESET_RESPONSE_MIN_MS - elapsed);
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
  return PUBLIC_RESET_RESULT;
}

function serviceError(code) {
  const error = new Error(code);
  error.serviceCode = code;
  return error;
}

function isVerifiedDocumentNotFound(error, expectedId) {
  const codes = new Set([
    'DATABASE_DOCUMENT_NOT_FOUND',
    'DATABASE_DOCUMENT_NOT_EXIST',
    'DOCUMENT_NOT_FOUND',
    'DOCUMENT_NOT_EXIST'
  ]);
  if (
    error
    && typeof error === 'object'
    && (codes.has(error.code) || codes.has(error.errCode))
  ) {
    return true;
  }
  if (typeof expectedId !== 'string' || !expectedId) return false;
  const value = typeof error === 'string'
    ? error
    : error && (error.message || error.errMsg);
  return value === (
    'document.get:fail document with _id '
    + expectedId
    + ' does not exist'
  );
}

async function getOptional(ref, expectedId) {
  try {
    const result = await ref.get();
    if (
      !result
      || !Object.prototype.hasOwnProperty.call(result, 'data')
    ) {
      throw new TypeError('invalid database response');
    }
    if (result.data === null) return null;
    if (!isPlainObject(result.data)) {
      throw new TypeError('invalid database document');
    }
    return result.data;
  } catch (error) {
    if (isVerifiedDocumentNotFound(error, expectedId)) return null;
    throw error;
  }
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
    throw serviceError('AUTH_INTERNAL_ERROR');
  }
  if (
    !result
    || !Array.isArray(result.data)
    || result.data.length > 1
    || result.data.some((account) => (
      !validAccount(account, account && account._id)
    ))
  ) {
    throw serviceError('AUTH_INTERNAL_ERROR');
  }
  return result.data;
}

function isCooling(document, now) {
  const nextSendAt = dateValue(document && document.nextSendAt);
  return !!nextSendAt && nextSendAt.getTime() > now;
}

function makeRequestId() {
  return crypto.randomBytes(16).toString('hex');
}

function makeCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function hashCode(config, challengeId, code) {
  return hmacFields(
    config.codeSecret,
    'email-code-v2',
    [challengeId, code]
  );
}

function makeSesClient(config) {
  return new SesClient({
    credential: {
      secretId: config.secretId,
      secretKey: config.secretKey
    },
    region: config.region,
    profile: {
      httpProfile: {
        endpoint: 'ses.tencentcloudapi.com',
        reqTimeout: SES_TIMEOUT_MS / 1000
      }
    }
  });
}

function makeSesParams(config, email, code) {
  const params = {
    FromEmailAddress: config.fromEmail,
    Destination: [email],
    Subject: config.subject,
    Template: {
      TemplateID: config.templateId,
      TemplateData: JSON.stringify({ code, minutes: '10' })
    },
    TriggerType: 1
  };
  if (config.replyTo) params.ReplyToAddresses = config.replyTo;
  return params;
}

function sanitizeToken(value, fallback) {
  const token = String(value || '');
  return /^[A-Za-z0-9_.-]{1,64}$/.test(token) ? token : fallback;
}

function logFailure(error, fallback) {
  console.error('sendEmailCode failure', {
    stage: sanitizeToken(fallback, 'UNKNOWN_ERROR'),
    detail: sanitizeToken(error && error.safeStage, 'unavailable'),
    type: sanitizeToken(error && (error.code || error.name), fallback),
    requestId: sanitizeToken(
      error && (error.requestId || error.RequestId),
      'unavailable'
    )
  });
}

async function loadLiveSessionGraph(
  transaction,
  authority,
  now,
  keyring
) {
  const sessionId = authority.session && authority.session._id;
  const liveSession = await getOptional(
    transaction.collection('auth_sessions').doc(sessionId),
    sessionId
  );
  if (!validLiveSession(liveSession, authority.session, now, keyring)) {
    throw serviceError('SESSION_EXPIRED');
  }
  const account = await getOptional(
    transaction.collection('accounts').doc(liveSession.accountId),
    liveSession.accountId
  );
  if (!validAccount(account, liveSession.accountId)) {
    throw serviceError('SESSION_EXPIRED');
  }
  if (account.status !== 'active') {
    throw serviceError('ACCOUNT_DISABLED');
  }
  if (
    account.authVersion !== liveSession.authVersion
    || !authority.account
    || authority.account._id !== account._id
    || authority.account.authVersion !== account.authVersion
  ) {
    throw serviceError('SESSION_EXPIRED');
  }
  const user = await getOptional(
    transaction.collection('users').doc(account._id),
    account._id
  );
  if (!validUser(user, account._id)) {
    throw serviceError('SESSION_EXPIRED');
  }
  const liveDeletionState = deletionState(user, now);
  if (liveDeletionState === 'invalid') {
    throw serviceError('AUTH_INTERNAL_ERROR');
  }
  if (liveDeletionState === 'locked') {
    throw serviceError('ACCOUNT_DELETION_LOCKED');
  }
  return { session: liveSession, account, user };
}

async function currentEmailBinding(transaction, account) {
  if (
    typeof account.emailBindingId !== 'string'
    || (
      account.emailBindingId
      && !EMAIL_ID_RE.test(account.emailBindingId)
    )
  ) {
    throw serviceError('AUTH_INTERNAL_ERROR');
  }
  if (!account.emailBindingId) {
    throw serviceError('EMAIL_NOT_BOUND');
  }
  const binding = await getOptional(
    transaction
      .collection('email_bindings')
      .doc(account.emailBindingId),
    account.emailBindingId
  );
  if (!validEmailBinding(binding, account.emailBindingId, account)) {
    throw serviceError('AUTH_INTERNAL_ERROR');
  }
  const reverseAccounts = await readEmailReverseAccounts(
    transaction,
    account.emailBindingId
  );
  if (
    reverseAccounts.length !== 1
    || reverseAccounts[0]._id !== account._id
  ) {
    throw serviceError('AUTH_INTERNAL_ERROR');
  }
  return binding;
}

async function validateBindTarget(transaction, account, targetId) {
  if (typeof account.emailBindingId !== 'string') {
    throw serviceError('AUTH_INTERNAL_ERROR');
  }
  if (account.emailBindingId) {
    await currentEmailBinding(transaction, account);
  }
  const target = await getOptional(
    transaction.collection('email_bindings').doc(targetId),
    targetId
  );
  const reverseAccounts = await readEmailReverseAccounts(
    transaction,
    targetId
  );
  if (!target) {
    if (reverseAccounts.length) {
      throw serviceError('AUTH_INTERNAL_ERROR');
    }
    return;
  }
  if (target.status === 'revoked') {
    if (
      !validRevokedEmailBinding(target, targetId)
      || reverseAccounts.length
    ) {
      throw serviceError('AUTH_INTERNAL_ERROR');
    }
    return;
  }
  if (target.status !== 'active') {
    throw serviceError('AUTH_INTERNAL_ERROR');
  }
  if (!ACCOUNT_ID_RE.test(target.accountId)) {
    throw serviceError('AUTH_INTERNAL_ERROR');
  }
  const ownerAccount = reverseAccounts.length === 1
    ? reverseAccounts[0]
    : null;
  const ownerUser = ownerAccount
    ? await getOptional(
      transaction.collection('users').doc(ownerAccount._id),
      ownerAccount._id
    )
    : null;
  if (
    !validAccount(ownerAccount, target.accountId)
    || !validUser(ownerUser, target.accountId)
    || !validEmailBinding(target, targetId, ownerAccount)
  ) {
    throw serviceError('AUTH_INTERNAL_ERROR');
  }
  if (target.accountId !== account._id) {
    throw serviceError('EMAIL_ALREADY_BOUND');
  }
}

async function resolveResetTarget(transaction, email, targetId, now) {
  const binding = await getOptional(
    transaction.collection('email_bindings').doc(targetId),
    targetId
  );
  const reverseAccounts = await readEmailReverseAccounts(
    transaction,
    targetId
  );
  if (
    !binding
    || binding.status !== 'active'
    || !ACCOUNT_ID_RE.test(binding.accountId)
    || reverseAccounts.length !== 1
    || reverseAccounts[0]._id !== binding.accountId
  ) {
    return null;
  }
  const account = reverseAccounts[0];
  if (
    !validAccount(account, binding.accountId)
    || account.status !== 'active'
    || !validEmailBinding(binding, targetId, account)
  ) {
    return null;
  }
  const user = await getOptional(
    transaction.collection('users').doc(account._id),
    account._id
  );
  if (
    !validUser(user, account._id)
    || deletionState(user, now) !== 'active'
  ) {
    return null;
  }
  if (binding.email !== email) return null;
  return { account, user, binding };
}

async function writeRateReservation(
  rateRef,
  previous,
  purpose,
  actorScopeHash,
  requestId,
  now
) {
  const previousCreatedAt = dateValue(previous && previous.createdAt);
  await rateRef.set({ data: {
    purpose,
    scopeHash: actorScopeHash,
    requestId,
    status: 'rate_limit',
    nextSendAt: new Date(now.getTime() + COOLDOWN_MS),
    createdAt: previousCreatedAt || new Date(now.getTime()),
    updatedAt: new Date(now.getTime())
  } });
}

async function reserve({
  event,
  email,
  requestId,
  config,
  authority,
  keyring
}) {
  let safeStage = 'transaction_start';
  try {
    return await db.runTransaction(async (transaction) => {
    const now = new Date(Date.now());
    let accountIdValue = '';
    let sessionId = '';
    let targetEmail = email;
    let targetId = email ? emailBindingId(email) : '';

    if (event.purpose === 'bind' || event.purpose === 'reauth') {
      safeStage = 'live_session_graph';
      const live = await loadLiveSessionGraph(
        transaction,
        authority,
        now,
        keyring
      );
      accountIdValue = live.account._id;
      if (event.purpose === 'bind') {
        safeStage = 'bind_target';
        await validateBindTarget(transaction, live.account, targetId);
      } else {
        safeStage = 'reauth_binding';
        const binding = await currentEmailBinding(
          transaction,
          live.account
        );
        targetEmail = binding.email;
        targetId = binding._id;
        sessionId = live.session._id;
      }
    }

    const actorScope = {
      purpose: event.purpose,
      clientInstanceId: event.clientInstanceId,
      accountId: accountIdValue,
      sessionId
    };
    safeStage = 'rate_hash';
    const actorScopeHash = rateScopeHash(config, actorScope);
    const rateId = emailRateId(actorScopeHash);
    const rateRef = transaction
      .collection('email_codes')
      .doc(rateId);
    safeStage = 'rate_read';
    const rate = await getOptional(rateRef, rateId);
    if (isCooling(rate, now.getTime())) {
      if (event.purpose === 'reset') return { shouldSend: false };
      throw serviceError('EMAIL_CODE_COOLDOWN');
    }

    if (event.purpose === 'reset') {
      safeStage = 'reset_target';
      const target = await resolveResetTarget(
        transaction,
        targetEmail,
        targetId,
        now
      );
      if (!target) {
        safeStage = 'unknown_rate_write';
        await writeRateReservation(
          rateRef,
          rate,
          event.purpose,
          actorScopeHash,
          requestId,
          now
        );
        return { shouldSend: false };
      }
      accountIdValue = target.account._id;
    }

    const challengeId = emailCodeId(event.purpose, targetEmail);
    const challengeRef = transaction
      .collection('email_codes')
      .doc(challengeId);
    safeStage = 'challenge_read';
    const challenge = await getOptional(challengeRef, challengeId);
    if (isCooling(challenge, now.getTime())) {
      if (event.purpose === 'reset') {
        safeStage = 'cooldown_rate_write';
        await writeRateReservation(
          rateRef,
          rate,
          event.purpose,
          actorScopeHash,
          requestId,
          now
        );
        return { shouldSend: false };
      }
      throw serviceError('EMAIL_CODE_COOLDOWN');
    }

    const scopeHash = challengeScopeHash(config, {
      purpose: event.purpose,
      clientInstanceId: event.clientInstanceId,
      accountId: accountIdValue,
      sessionId,
      emailBindingId: targetId
    });
    safeStage = 'challenge_write';
    const nextSendAt = new Date(now.getTime() + COOLDOWN_MS);
    await challengeRef.set({ data: {
      purpose: event.purpose,
      accountId: accountIdValue,
      emailBindingId: targetId,
      targetHash: targetId,
      scopeHash,
      requestId,
      status: 'sending',
      codeHash: '',
      attemptsLeft: 0,
      expiresAt: null,
      nextSendAt,
      sentAt: null,
      createdAt: new Date(now.getTime()),
      updatedAt: new Date(now.getTime()),
      usedAt: null
    } });
    safeStage = 'rate_write';
    await writeRateReservation(
      rateRef,
      rate,
      event.purpose,
      actorScopeHash,
      requestId,
      now
    );
    return {
      shouldSend: true,
      challengeId,
      requestId,
      email: targetEmail
    };
    });
  } catch (error) {
    if (error && typeof error === 'object') error.safeStage = safeStage;
    throw error;
  }
}

async function updateChallenge(reservation, data) {
  return db.runTransaction(async (transaction) => {
    const ref = transaction.collection('email_codes').doc(reservation.challengeId);
    const challenge = await getOptional(ref, reservation.challengeId);
    if (
      !challenge
      || challenge.requestId !== reservation.requestId
      || challenge.status !== 'sending'
    ) {
      return false;
    }
    await ref.update({ data });
    return true;
  });
}

async function markFailed(reservation) {
  await updateChallenge(reservation, {
    status: 'failed',
    codeHash: '',
    attemptsLeft: 0,
    expiresAt: null,
    sentAt: null,
    usedAt: null,
    updatedAt: new Date(Date.now())
  });
}

async function sendReserved(client, config, reservation, email, code, codeHash) {
  try {
    await client.SendEmail(makeSesParams(config, email, code));
  } catch (error) {
    logFailure(error, 'SES_ERROR');
    try {
      await markFailed(reservation);
    } catch (markError) {
      logFailure(markError, 'DATABASE_ERROR');
    }
    return false;
  }

  const now = Date.now();
  return updateChallenge(reservation, {
    codeHash,
    status: 'active',
    attemptsLeft: 5,
    expiresAt: new Date(now + EXPIRES_MS),
    sentAt: new Date(now),
    usedAt: null,
    updatedAt: new Date(now)
  });
}

async function main(event) {
  const startedAt = Date.now();
  const input = event || {};
  const validation = validateRequest(input);
  if (!validation.ok) return fail(validation.error);

  let email = '';
  if (input.purpose !== 'reauth') {
    if (typeof input.email !== 'string') return fail('EMAIL_INVALID');
    email = normalizeEmail(input.email);
    if (!EMAIL_RE.test(email) || email.length > 254) {
      return fail('EMAIL_INVALID');
    }
  }

  const config = getConfig();
  if (!isConfigured(config)) return fail('EMAIL_NOT_CONFIGURED');

  let keyring;
  let authority = null;
  if (input.purpose === 'bind' || input.purpose === 'reauth') {
    try {
      keyring = loadKeyring(process.env);
    } catch (error) {
      logFailure(error, 'AUTH_CONFIG_ERROR');
      return fail('AUTH_INTERNAL_ERROR');
    }
    authority = await requireSession({
      db,
      event: input,
      now: new Date(Date.now()),
      keyring
    });
    if (authority && authority.ok === false) return authority;
  }

  let requestId;
  let reservation;
  try {
    requestId = makeRequestId();
    reservation = await reserve({
      event: input,
      email,
      requestId,
      config,
      authority,
      keyring
    });
  } catch (error) {
    if (input.purpose === 'reset') {
      if (!error.serviceCode) logFailure(error, 'RESERVATION_ERROR');
      return publicResetResult(startedAt);
    }
    if (error.serviceCode) return fail(error.serviceCode);
    logFailure(error, 'RESERVATION_ERROR');
    return fail('EMAIL_SEND_FAILED');
  }

  if (!reservation.shouldSend) {
    return publicResetResult(startedAt);
  }

  let client;
  let code;
  let codeHash;
  try {
    client = makeSesClient(config);
    code = makeCode();
    codeHash = hashCode(config, reservation.challengeId, code);
  } catch (error) {
    logFailure(error, 'EMAIL_SERVICE_ERROR');
    try {
      await markFailed(reservation);
    } catch (markError) {
      logFailure(markError, 'FAILURE_FINALIZE_ERROR');
    }
    return input.purpose === 'reset'
      ? publicResetResult(startedAt)
      : fail('EMAIL_SEND_FAILED');
  }

  let sent;
  try {
    sent = await sendReserved(
      client,
      config,
      reservation,
      reservation.email,
      code,
      codeHash
    );
  } catch (error) {
    logFailure(error, 'SUCCESS_FINALIZE_ERROR');
    return input.purpose === 'reset'
      ? publicResetResult(startedAt)
      : fail('EMAIL_SEND_FAILED');
  }
  if (input.purpose === 'reset') return publicResetResult(startedAt);
  if (!sent) return fail('EMAIL_SEND_FAILED');
  return {
    ok: true,
    accepted: true,
    msg: '\u9a8c\u8bc1\u7801\u5df2\u53d1\u9001'
  };
}

exports.main = main;

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
  if (Object.prototype.hasOwnProperty.call(event, 'authProtocol')) {
    businessEvent = { ...event };
    delete businessEvent.authProtocol;
  }
  return protocolGuardedMain(businessEvent, ...args);
};
