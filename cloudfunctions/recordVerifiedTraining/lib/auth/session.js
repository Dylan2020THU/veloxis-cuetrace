'use strict';

const crypto = require('crypto');
const { deriveKey } = require('./keyring');

const DAY_MS = 24 * 60 * 60 * 1000;
const IDLE_TTL_MS = 30 * DAY_MS;
const ABSOLUTE_TTL_MS = 90 * DAY_MS;
const ACTIVITY_THROTTLE_MS = 6 * 60 * 60 * 1000;
const RECENT_AUTH_TTL_MS = 10 * 60 * 1000;
const VERSION_PATTERN = /^[A-Z0-9_]+$/;
const TOKEN_RANDOM_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HMAC_NAMESPACE = Buffer.from('cuetrace-auth-v2-hmac\0');
const GENERIC_REASONS = new Set([
  'logout',
  'logout_current',
  'logout_others',
  'password_changed',
  'password_reset',
  'session_revoked',
  'session_rotated',
  'other_sessions_revoked',
  'account_security_change',
  'reauthenticated'
]);

const ERROR_RESULTS = Object.freeze({
  SESSION_REQUIRED: Object.freeze({
    ok: false,
    code: 'SESSION_REQUIRED',
    msg: '请先登录'
  }),
  SESSION_EXPIRED: Object.freeze({
    ok: false,
    code: 'SESSION_EXPIRED',
    msg: '登录状态已失效，请重新登录'
  }),
  ACCOUNT_DISABLED: Object.freeze({
    ok: false,
    code: 'ACCOUNT_DISABLED',
    msg: '账号已停用'
  }),
  AUTH_INTERNAL_ERROR: Object.freeze({
    ok: false,
    code: 'AUTH_INTERNAL_ERROR',
    msg: '认证服务异常，请稍后重试'
  }),
  RECENT_AUTH_REQUIRED: Object.freeze({
    ok: false,
    code: 'RECENT_AUTH_REQUIRED',
    msg: '请先完成近期身份验证'
  })
});

function failure(code) {
  return { ...ERROR_RESULTS[code] };
}

function transactionAbort(code) {
  const result = ERROR_RESULTS[code] || ERROR_RESULTS.AUTH_INTERNAL_ERROR;
  const error = new Error(result.msg);
  error.name = 'AuthTransactionAbort';
  error.code = result.code;
  error.msg = result.msg;
  return error;
}

function internalError() {
  return transactionAbort('AUTH_INTERNAL_ERROR');
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validIdentifier(value, maximumLength) {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= maximumLength
  );
}

function dateValue(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return new Date(value.getTime());
  }
  if (Number.isSafeInteger(value)) {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date;
  }
  return null;
}

function lengthPrefixed(value) {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function tokenDocumentId(keyring, keyVersion, sessionToken) {
  const digest = crypto
    .createHmac(
      'sha256',
      deriveKey(keyring, keyVersion, 'session-token')
    )
    .update(Buffer.concat([
      HMAC_NAMESPACE,
      lengthPrefixed('session-token'),
      lengthPrefixed('session'),
      lengthPrefixed(sessionToken)
    ]))
    .digest('base64url');
  return `session.${keyVersion}.${digest}`;
}

function keyringContainsVersion(keyring, version) {
  return (
    keyring
    && keyring.keys instanceof Map
    && keyring.keys.has(version)
  );
}

function parseSessionToken(sessionToken, keyring) {
  if (typeof sessionToken !== 'string' || sessionToken.length === 0) {
    return null;
  }
  const parts = sessionToken.split('.');
  if (
    parts.length !== 3
    || parts[0] !== 'v2'
    || !VERSION_PATTERN.test(parts[1])
    || !TOKEN_RANDOM_PATTERN.test(parts[2])
    || !keyringContainsVersion(keyring, parts[1])
  ) {
    return null;
  }
  let randomBytes;
  try {
    randomBytes = Buffer.from(parts[2], 'base64url');
  } catch (_) {
    return null;
  }
  if (
    randomBytes.length !== 32
    || randomBytes.toString('base64url') !== parts[2]
  ) {
    return null;
  }
  try {
    return {
      keyVersion: parts[1],
      sessionId: tokenDocumentId(keyring, parts[1], sessionToken)
    };
  } catch (_) {
    return null;
  }
}

function validAuthVersion(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function normalizedSession(record, expectedId, expectedVersion, now) {
  if (
    !isPlainObject(record)
    || record._id !== expectedId
    || record.keyVersion !== expectedVersion
    || !validIdentifier(record.accountId, 128)
    || !validAuthVersion(record.authVersion)
    || !validIdentifier(record.clientInstanceId, 256)
    || !validIdentifier(record.authenticationMethod, 64)
    || record.revokedAt !== ''
    || record.revokeReason !== ''
    || Object.prototype.hasOwnProperty.call(record, 'sessionToken')
    || Object.prototype.hasOwnProperty.call(record, 'token')
  ) {
    return null;
  }

  const authenticatedAt = dateValue(record.authenticatedAt);
  const createdAt = dateValue(record.createdAt);
  const lastSeenAt = dateValue(record.lastSeenAt);
  const idleExpiresAt = dateValue(record.idleExpiresAt);
  const absoluteExpiresAt = dateValue(record.absoluteExpiresAt);
  const nowDate = dateValue(now);
  if (
    !authenticatedAt
    || !createdAt
    || !lastSeenAt
    || !idleExpiresAt
    || !absoluteExpiresAt
    || !nowDate
  ) {
    return null;
  }

  const authenticatedMs = authenticatedAt.getTime();
  const createdMs = createdAt.getTime();
  const lastSeenMs = lastSeenAt.getTime();
  const idleExpiresMs = idleExpiresAt.getTime();
  const absoluteExpiresMs = absoluteExpiresAt.getTime();
  const nowMs = nowDate.getTime();
  if (
    authenticatedMs < createdMs
    || authenticatedMs > nowMs
    || lastSeenMs < createdMs
    || lastSeenMs > nowMs
    || idleExpiresMs !== lastSeenMs + IDLE_TTL_MS
    || absoluteExpiresMs !== createdMs + ABSOLUTE_TTL_MS
    || nowMs >= idleExpiresMs
    || nowMs >= absoluteExpiresMs
  ) {
    return null;
  }

  return {
    ...record,
    authenticatedAt,
    createdAt,
    lastSeenAt,
    idleExpiresAt,
    absoluteExpiresAt
  };
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
  if (!validIdentifier(expectedId, 256)) return false;
  const expectedMessage =
    `document.get:fail document with _id ${expectedId} does not exist`;
  if (typeof error === 'string') return error === expectedMessage;
  return Boolean(
    error
    && typeof error === 'object'
    && (
      error.message === expectedMessage
      || error.errMsg === expectedMessage
    )
  );
}

async function readDocument(ref, expectedId) {
  try {
    const result = await ref.get();
    if (!result || !Object.prototype.hasOwnProperty.call(result, 'data')) {
      return { kind: 'error' };
    }
    if (result.data === null) return { kind: 'missing' };
    if (result.data === undefined) return { kind: 'error' };
    return { kind: 'found', data: result.data };
  } catch (error) {
    if (isVerifiedDocumentNotFound(error, expectedId)) {
      return { kind: 'missing' };
    }
    return { kind: 'error' };
  }
}

function validAccount(account, accountId) {
  return (
    isPlainObject(account)
    && account._id === accountId
    && validAuthVersion(account.authVersion)
    && typeof account.status === 'string'
  );
}

function validUser(user, accountId) {
  if (
    !isPlainObject(user)
    || user._id !== accountId
    || !Array.isArray(user.roles)
    || user.roles.length === 0
    || user.roles.some(
      (role) => !validIdentifier(role, 64)
    )
    || new Set(user.roles).size !== user.roles.length
  ) {
    return false;
  }
  return true;
}

function randomTokenPart(randomBytes) {
  const makeRandomBytes = randomBytes || crypto.randomBytes;
  if (typeof makeRandomBytes !== 'function') throw internalError();
  let bytes;
  try {
    bytes = makeRandomBytes(32);
  } catch (_) {
    throw internalError();
  }
  if (
    (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array))
    || Buffer.from(bytes).length !== 32
  ) {
    throw internalError();
  }
  return Buffer.from(bytes).toString('base64url');
}

function prepareSessionToken(keyring, randomBytes) {
  if (
    !keyring
    || !VERSION_PATTERN.test(keyring.activeVersion)
    || !keyringContainsVersion(keyring, keyring.activeVersion)
  ) {
    throw internalError();
  }
  return `v2.${keyring.activeVersion}.${randomTokenPart(randomBytes)}`;
}

function validPreparedSessionToken(sessionToken, keyring) {
  if (
    typeof sessionToken !== 'string'
    || !keyring
    || !VERSION_PATTERN.test(keyring.activeVersion)
  ) {
    return false;
  }
  const parts = sessionToken.split('.');
  if (
    parts.length !== 3
    || parts[0] !== 'v2'
    || parts[1] !== keyring.activeVersion
    || !TOKEN_RANDOM_PATTERN.test(parts[2])
  ) {
    return false;
  }
  try {
    const bytes = Buffer.from(parts[2], 'base64url');
    return (
      bytes.length === 32
      && bytes.toString('base64url') === parts[2]
    );
  } catch (_) {
    return false;
  }
}

function validIssueArguments(transaction, account, clientInstanceId, method, now) {
  return (
    transaction
    && typeof transaction.collection === 'function'
    && isPlainObject(account)
    && validIdentifier(account._id, 128)
    && validAuthVersion(account.authVersion)
    && account.status === 'active'
    && validIdentifier(clientInstanceId, 256)
    && validIdentifier(method, 64)
    && !!dateValue(now)
  );
}

async function writeSession({
  transaction,
  account,
  clientInstanceId,
  method,
  now,
  keyring,
  preparedSessionToken,
  authenticatedAt,
  createdAt,
  absoluteExpiresAt
}) {
  if (
    !validIssueArguments(
      transaction,
      account,
      clientInstanceId,
      method,
      now
    )
    || !keyring
    || !VERSION_PATTERN.test(keyring.activeVersion)
    || !keyringContainsVersion(keyring, keyring.activeVersion)
  ) {
    throw internalError();
  }
  const nowDate = dateValue(now);
  const authenticatedDate = dateValue(authenticatedAt || nowDate);
  const createdDate = dateValue(createdAt || nowDate);
  const absoluteDate = dateValue(
    absoluteExpiresAt
      || new Date(createdDate.getTime() + ABSOLUTE_TTL_MS)
  );
  if (
    !authenticatedDate
    || !createdDate
    || !absoluteDate
    || authenticatedDate.getTime() < createdDate.getTime()
    || authenticatedDate.getTime() > nowDate.getTime()
    || absoluteDate.getTime() !== createdDate.getTime() + ABSOLUTE_TTL_MS
    || nowDate.getTime() >= absoluteDate.getTime()
  ) {
    throw internalError();
  }

  let sessionToken;
  if (preparedSessionToken === undefined) {
    sessionToken = prepareSessionToken(keyring);
  } else if (validPreparedSessionToken(preparedSessionToken, keyring)) {
    sessionToken = preparedSessionToken;
  } else {
    throw internalError();
  }
  const sessionRecord = {
    _id: tokenDocumentId(
      keyring,
      keyring.activeVersion,
      sessionToken
    ),
    accountId: account._id,
    keyVersion: keyring.activeVersion,
    authVersion: account.authVersion,
    clientInstanceId,
    authenticatedAt: authenticatedDate,
    authenticationMethod: method,
    createdAt: createdDate,
    lastSeenAt: nowDate,
    idleExpiresAt: new Date(nowDate.getTime() + IDLE_TTL_MS),
    absoluteExpiresAt: absoluteDate,
    revokedAt: '',
    revokeReason: ''
  };
  const { _id, ...sessionData } = sessionRecord;
  try {
    await transaction
      .collection('auth_sessions')
      .doc(_id)
      .set({ data: sessionData });
  } catch (_) {
    throw internalError();
  }
  return { sessionToken, sessionRecord };
}

async function issueSession({
  transaction,
  account,
  clientInstanceId,
  method,
  now,
  keyring,
  preparedSessionToken
}) {
  return writeSession({
    transaction,
    account,
    clientInstanceId,
    method,
    now,
    keyring,
    preparedSessionToken
  });
}

async function requireSession({ db, event, now, keyring }) {
  const hasSessionToken = Boolean(
    event
    && Object.prototype.hasOwnProperty.call(event, 'sessionToken')
  );
  const sessionToken = hasSessionToken ? event.sessionToken : undefined;
  if (!hasSessionToken || sessionToken === undefined || sessionToken === '') {
    return failure('SESSION_REQUIRED');
  }
  if (typeof sessionToken !== 'string') {
    return failure('SESSION_EXPIRED');
  }
  const parsed = parseSessionToken(sessionToken, keyring);
  if (!parsed) return failure('SESSION_EXPIRED');
  if (!db || typeof db.collection !== 'function' || !dateValue(now)) {
    return failure('AUTH_INTERNAL_ERROR');
  }

  try {
    const sessionRef = db
      .collection('auth_sessions')
      .doc(parsed.sessionId);
    const sessionRead = await readDocument(
      sessionRef,
      parsed.sessionId
    );
    if (sessionRead.kind === 'error') {
      return failure('AUTH_INTERNAL_ERROR');
    }
    if (sessionRead.kind === 'missing') {
      return failure('SESSION_EXPIRED');
    }
    let session = normalizedSession(
      sessionRead.data,
      parsed.sessionId,
      parsed.keyVersion,
      now
    );
    if (!session) return failure('SESSION_EXPIRED');

    const accountRef = db
      .collection('accounts')
      .doc(session.accountId);
    const accountRead = await readDocument(
      accountRef,
      session.accountId
    );
    if (accountRead.kind === 'error') {
      return failure('AUTH_INTERNAL_ERROR');
    }
    if (accountRead.kind === 'missing') {
      return failure('SESSION_EXPIRED');
    }
    const account = accountRead.data;
    if (!validAccount(account, session.accountId)) {
      return failure('SESSION_EXPIRED');
    }
    if (account.status !== 'active') {
      return failure('ACCOUNT_DISABLED');
    }
    if (account.authVersion !== session.authVersion) {
      return failure('SESSION_EXPIRED');
    }

    const userRef = db.collection('users').doc(session.accountId);
    const userRead = await readDocument(
      userRef,
      session.accountId
    );
    if (userRead.kind === 'error') {
      return failure('AUTH_INTERNAL_ERROR');
    }
    if (userRead.kind === 'missing') {
      return failure('SESSION_EXPIRED');
    }
    const user = userRead.data;
    if (!validUser(user, session.accountId)) {
      return failure('SESSION_EXPIRED');
    }

    const nowDate = dateValue(now);
    if (
      nowDate.getTime() - session.lastSeenAt.getTime()
      >= ACTIVITY_THROTTLE_MS
    ) {
      const activity = {
        lastSeenAt: nowDate,
        idleExpiresAt: new Date(nowDate.getTime() + IDLE_TTL_MS)
      };
      try {
        await sessionRef.update({ data: activity });
      } catch (_) {
        return failure('AUTH_INTERNAL_ERROR');
      }
      session = { ...session, ...activity };
    }

    return {
      accountId: session.accountId,
      account,
      user,
      roles: [...user.roles],
      session,
      sessionRef
    };
  } catch (_) {
    return failure('AUTH_INTERNAL_ERROR');
  }
}

function boundedReason(reason, fallback) {
  return GENERIC_REASONS.has(reason) ? reason : fallback;
}

function validMutationSession(live, supplied, now) {
  if (
    !isPlainObject(supplied)
    || !validIdentifier(supplied._id, 256)
    || !validIdentifier(supplied.accountId, 128)
    || !validAuthVersion(supplied.authVersion)
    || !isPlainObject(live)
    || live._id !== supplied._id
    || live.accountId !== supplied.accountId
    || live.authVersion !== supplied.authVersion
    || !VERSION_PATTERN.test(live.keyVersion)
  ) {
    return null;
  }
  return normalizedSession(live, live._id, live.keyVersion, now);
}

async function loadMutationSession(transaction, supplied, now) {
  if (
    !transaction
    || typeof transaction.collection !== 'function'
    || !dateValue(now)
    || !isPlainObject(supplied)
    || !validIdentifier(supplied._id, 256)
  ) {
    throw transactionAbort('SESSION_EXPIRED');
  }
  let ref;
  try {
    ref = transaction
      .collection('auth_sessions')
      .doc(supplied._id);
  } catch (_) {
    throw internalError();
  }
  const read = await readDocument(ref, supplied._id);
  if (read.kind === 'error') {
    throw internalError();
  }
  if (read.kind === 'missing') {
    throw transactionAbort('SESSION_EXPIRED');
  }
  const session = validMutationSession(read.data, supplied, now);
  if (!session) {
    throw transactionAbort('SESSION_EXPIRED');
  }
  return { ref, session };
}

async function loadMutationAccount(
  transaction,
  suppliedAccount,
  expectedAccountId
) {
  if (
    !isPlainObject(suppliedAccount)
    || suppliedAccount._id !== expectedAccountId
    || !validAuthVersion(suppliedAccount.authVersion)
  ) {
    throw transactionAbort('SESSION_EXPIRED');
  }
  if (suppliedAccount.status !== 'active') {
    throw transactionAbort('ACCOUNT_DISABLED');
  }
  let ref;
  try {
    ref = transaction
      .collection('accounts')
      .doc(expectedAccountId);
  } catch (_) {
    throw internalError();
  }
  const read = await readDocument(ref, expectedAccountId);
  if (read.kind === 'error') throw internalError();
  if (read.kind === 'missing') {
    throw transactionAbort('SESSION_EXPIRED');
  }
  const account = read.data;
  if (!validAccount(account, expectedAccountId)) {
    throw transactionAbort('SESSION_EXPIRED');
  }
  if (account.status !== 'active') {
    throw transactionAbort('ACCOUNT_DISABLED');
  }
  if (account.authVersion !== suppliedAccount.authVersion) {
    throw transactionAbort('SESSION_EXPIRED');
  }
  return { ref, account };
}

async function revokeCurrentSession({
  transaction,
  session,
  now,
  reason
}) {
  const loaded = await loadMutationSession(
    transaction,
    session,
    now
  );
  try {
    await loaded.ref.update({
      data: {
        revokedAt: dateValue(now),
        revokeReason: boundedReason(reason, 'session_revoked')
      }
    });
    return { kind: 'session_revoked' };
  } catch (_) {
    throw internalError();
  }
}

async function rotateCurrentSession({
  transaction,
  account,
  session,
  now,
  keyring,
  reason,
  preparedSessionToken
}) {
  const loaded = await loadMutationSession(
    transaction,
    session,
    now
  );
  await loadMutationAccount(
    transaction,
    account,
    loaded.session.accountId
  );

  try {
    await loaded.ref.update({
      data: {
        revokedAt: dateValue(now),
        revokeReason: boundedReason(reason, 'session_rotated')
      }
    });
    const issued = await writeSession({
      transaction,
      account,
      clientInstanceId: loaded.session.clientInstanceId,
      method: loaded.session.authenticationMethod,
      now,
      keyring,
      preparedSessionToken,
      authenticatedAt: loaded.session.authenticatedAt,
      createdAt: loaded.session.createdAt,
      absoluteExpiresAt: loaded.session.absoluteExpiresAt
    });
    return {
      kind: 'session_rotated',
      sessionToken: issued.sessionToken
    };
  } catch (_) {
    throw internalError();
  }
}

async function revokeOtherSessions({
  transaction,
  account,
  currentSession,
  now,
  keyring,
  preparedSessionToken
}) {
  if (
    !transaction
    || typeof transaction.collection !== 'function'
    || !isPlainObject(account)
    || !validIdentifier(account._id, 128)
    || !isPlainObject(currentSession)
    || currentSession.accountId !== account._id
    || !validAuthVersion(currentSession.authVersion)
    || !dateValue(now)
  ) {
    throw transactionAbort('SESSION_EXPIRED');
  }
  if (account.status !== 'active') {
    throw transactionAbort('ACCOUNT_DISABLED');
  }

  let accountRef;
  try {
    accountRef = transaction
      .collection('accounts')
      .doc(account._id);
  } catch (_) {
    throw internalError();
  }
  const accountRead = await readDocument(
    accountRef,
    account._id
  );
  if (accountRead.kind === 'error') {
    throw internalError();
  }
  if (accountRead.kind === 'missing') {
    throw transactionAbort('SESSION_EXPIRED');
  }
  const liveAccount = accountRead.data;
  if (!validAccount(liveAccount, account._id)) {
    throw transactionAbort('SESSION_EXPIRED');
  }
  if (liveAccount.status !== 'active') {
    throw transactionAbort('ACCOUNT_DISABLED');
  }
  if (liveAccount.authVersion !== currentSession.authVersion) {
    throw transactionAbort('SESSION_EXPIRED');
  }
  if (liveAccount.authVersion >= Number.MAX_SAFE_INTEGER) {
    throw internalError();
  }

  const loaded = await loadMutationSession(
    transaction,
    currentSession,
    now
  );
  if (
    loaded.session.accountId !== liveAccount._id
    || loaded.session.authVersion !== liveAccount.authVersion
  ) {
    throw transactionAbort('SESSION_EXPIRED');
  }

  const nextAuthVersion = liveAccount.authVersion + 1;
  try {
    await accountRef.update({
      data: { authVersion: nextAuthVersion }
    });
    await loaded.ref.update({
      data: {
        revokedAt: dateValue(now),
        revokeReason: 'other_sessions_revoked'
      }
    });
    const issued = await writeSession({
      transaction,
      account: {
        ...liveAccount,
        authVersion: nextAuthVersion
      },
      clientInstanceId: loaded.session.clientInstanceId,
      method: loaded.session.authenticationMethod,
      now,
      keyring,
      preparedSessionToken,
      authenticatedAt: loaded.session.authenticatedAt,
      createdAt: loaded.session.createdAt,
      absoluteExpiresAt: loaded.session.absoluteExpiresAt
    });
    return {
      kind: 'session_rotated',
      sessionToken: issued.sessionToken
    };
  } catch (_) {
    throw internalError();
  }
}

function requireRecentAuthentication(session, now) {
  const nowDate = dateValue(now);
  const authenticatedAt = session && dateValue(session.authenticatedAt);
  if (!nowDate || !authenticatedAt) {
    return failure('RECENT_AUTH_REQUIRED');
  }
  const age = nowDate.getTime() - authenticatedAt.getTime();
  if (age < 0 || age > RECENT_AUTH_TTL_MS) {
    return failure('RECENT_AUTH_REQUIRED');
  }
  return true;
}

module.exports = {
  prepareSessionToken,
  issueSession,
  requireSession,
  revokeCurrentSession,
  rotateCurrentSession,
  revokeOtherSessions,
  requireRecentAuthentication
};
