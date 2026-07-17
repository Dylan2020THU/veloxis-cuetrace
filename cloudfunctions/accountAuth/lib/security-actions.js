'use strict';

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
  optionalDocument,
  validAccount,
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

function copyDate(value) {
  return new Date(value.getTime());
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
  const wechatBinding = await readWechatProjection(source, account);
  return {
    accountNameRelation,
    phoneBinding,
    wechatBinding,
    account: accountNameRelation ? accountNameRelation.account : '',
    accountDisplay: accountDisplay(accountNameRelation, phoneBinding),
    accountNameSet: Boolean(accountNameRelation),
    passwordSet: configuredPassword(account),
    phoneBound: Boolean(phoneBinding),
    phoneMasked: phoneBinding ? phoneBinding.phoneMasked : '',
    emailBound: false,
    emailMasked: '',
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
    emailBound: false,
    emailMasked: '',
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
    emailBound: false,
    emailMasked: '',
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
  return failure('AUTH_MAINTENANCE');
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
  bindPhone,
  bindWechat,
  logoutCurrent,
  logoutOthers,
  reauthenticate,
  setAccountName,
  setPassword,
  status
};
