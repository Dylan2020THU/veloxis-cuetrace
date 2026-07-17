'use strict';

const crypto = require('crypto');
const {
  normalizePhone,
  normalizeAccountName,
  newAccountId
} = require('./auth/identifiers');
const { candidateHmacIds } = require('./auth/keyring');
const {
  hashPassword,
  verifyPasswordOrDummy
} = require('./auth/password');
const { prepareSessionToken } = require('./auth/session');
const { consumeSmsChallenge } = require('./auth/sms');
const {
  accountNameDocumentId,
  authError,
  failure,
  issueAccountSession,
  newAccountRecord,
  newUserRecord,
  optionalDocument,
  sessionIssuedResponse,
  validAccountCore,
  validAccountNameRelation,
  validDate,
  validPhoneBinding,
  validPasswordState,
  validUser,
  withoutDocumentId
} = require('./store');

const PASSWORD_RATE_DIMENSIONS = Object.freeze({
  identifierWechat: Object.freeze({
    name: 'identifier_wechat',
    prefix: 'pwd-id-wx',
    limit: 5,
    windowMs: 15 * 60 * 1000,
    blockMs: 15 * 60 * 1000
  }),
  wechat: Object.freeze({
    name: 'wechat',
    prefix: 'pwd-wx',
    limit: 20,
    windowMs: 15 * 60 * 1000,
    blockMs: 15 * 60 * 1000
  }),
  identifier: Object.freeze({
    name: 'identifier',
    prefix: 'pwd-id',
    limit: 30,
    windowMs: 24 * 60 * 60 * 1000,
    blockMs: 60 * 60 * 1000
  })
});

function copyDate(value) {
  return new Date(value.getTime());
}

function passwordIdentifier(identifier) {
  if (typeof identifier !== 'string') {
    return {
      namespace: 'invalid',
      rateValue: 'invalid:' + typeof identifier,
      normalized: ''
    };
  }
  const display = identifier.trim();
  if (/^\d+$/.test(identifier)) {
    if (/^1\d{10}$/.test(identifier)) {
      const normalized = normalizePhone(identifier);
      return {
        namespace: 'phone',
        rateValue: 'phone:' + normalized,
        normalized
      };
    }
    return {
      namespace: 'invalid',
      rateValue: 'invalid:' + crypto
        .createHash('sha256')
        .update('numeric:' + identifier)
        .digest('hex'),
      normalized: ''
    };
  }
  if (/^[A-Za-z][A-Za-z0-9_]{3,19}$/.test(display)) {
    const normalized = normalizeAccountName(display);
    return {
      namespace: 'account_name',
      rateValue: 'account-name:' + normalized,
      normalized
    };
  }
  return {
    namespace: 'invalid',
    rateValue: 'invalid:' + crypto
      .createHash('sha256')
      .update('value:' + display)
      .digest('hex'),
    normalized: ''
  };
}

function phoneCandidates(keyring, normalizedPhone) {
  try {
    return candidateHmacIds(
      keyring,
      'phone-binding',
      normalizedPhone,
      'phone'
    );
  } catch (_) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
}

async function readPhoneCandidateItems(source, candidates) {
  const items = [];
  for (const candidate of candidates) {
    const ref = source.collection('phone_bindings').doc(candidate.id);
    const binding = await optionalDocument(ref, candidate.id);
    if (binding && !validPhoneBinding(binding, candidate)) {
      throw authError('AUTH_INTERNAL_ERROR');
    }
    items.push({ candidate, ref, binding });
  }
  return items;
}

function selectPhoneBinding(items) {
  const existing = items.filter((item) => item.binding);
  const active = existing.filter(
    (item) => item.binding.status === 'active'
  );
  if (!active.length) {
    if (existing.length) throw authError('AUTH_CONFLICT');
    return null;
  }
  if (active.length !== 1) throw authError('AUTH_CONFLICT');
  const selected = active[0];
  if (existing.some(
    (item) => item.binding.accountId !== selected.binding.accountId
  )) {
    throw authError('AUTH_CONFLICT');
  }
  return selected;
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

async function readAccountNameProjection(source, account) {
  if (!account.accountNameBindingId) return null;
  const relation = await optionalDocument(
    source
      .collection('account_names')
      .doc(account.accountNameBindingId),
    account.accountNameBindingId
  );
  if (
    !relation
    || !validAccountNameRelation(
      relation,
      account.accountNameBindingId,
      account,
      relation.accountNormalized
    )
  ) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
  return relation;
}

async function readAccountGraph(
  source,
  accountId,
  allowInvalidPassword
) {
  const account = await optionalDocument(
    source.collection('accounts').doc(accountId),
    accountId
  );
  const user = await optionalDocument(
    source.collection('users').doc(accountId),
    accountId
  );
  if (
    !account
    || !user
    || !validAccountCore(account, accountId)
    || !validUser(user, accountId)
    || (!allowInvalidPassword && !validPasswordState(account))
  ) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
  return { account, user };
}

function newPhoneBindingRecord({
  id,
  accountId,
  keyVersion,
  phoneMasked,
  now,
  createdAt,
  verifiedAt
}) {
  return {
    _id: id,
    accountId,
    keyVersion,
    phoneMasked,
    status: 'active',
    verifiedAt: verifiedAt ? copyDate(verifiedAt) : copyDate(now),
    createdAt: createdAt ? copyDate(createdAt) : copyDate(now),
    updatedAt: copyDate(now)
  };
}

async function migratePhoneBinding({
  items,
  selected,
  accountRef,
  account,
  phoneMasked,
  now
}) {
  if (account.phoneBindingId !== selected.binding._id) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
  const activeItem = items[0];
  let liveBinding = selected.binding;
  let liveAccount = account;
  if (!selected.candidate.isActive) {
    if (activeItem.binding) throw authError('AUTH_CONFLICT');
    liveBinding = newPhoneBindingRecord({
      id: activeItem.candidate.id,
      accountId: account._id,
      keyVersion: activeItem.candidate.keyVersion,
      phoneMasked,
      now,
      createdAt: selected.binding.createdAt,
      verifiedAt: selected.binding.verifiedAt
    });
    await activeItem.ref.set({
      data: withoutDocumentId(liveBinding)
    });
    await selected.ref.update({
      data: {
        status: 'revoked',
        revokeReason: 'key_rotated',
        revokedAt: copyDate(now),
        updatedAt: copyDate(now)
      }
    });
    await accountRef.update({
      data: {
        phoneBindingId: liveBinding._id,
        updatedAt: copyDate(now)
      }
    });
    liveAccount = {
      ...account,
      phoneBindingId: liveBinding._id,
      updatedAt: copyDate(now)
    };
  }
  return { binding: liveBinding, account: liveAccount };
}

function passwordRateDimensions(keyring, descriptor, wxIdentity) {
  if (
    !wxIdentity
    || typeof wxIdentity.bindingInput !== 'string'
    || !wxIdentity.bindingInput
  ) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
  const definitions = [
    {
      ...PASSWORD_RATE_DIMENSIONS.identifierWechat,
      value: descriptor.rateValue + '\u0000' + wxIdentity.bindingInput
    },
    {
      ...PASSWORD_RATE_DIMENSIONS.wechat,
      value: wxIdentity.bindingInput
    },
    {
      ...PASSWORD_RATE_DIMENSIONS.identifier,
      value: descriptor.rateValue
    }
  ];
  return definitions.map((definition) => {
    let candidates;
    try {
      candidates = candidateHmacIds(
        keyring,
        'rate-limit',
        definition.value,
        definition.prefix
      );
    } catch (_) {
      throw authError('AUTH_INTERNAL_ERROR');
    }
    return { ...definition, candidates };
  });
}

function normalizedRateRecord(record, candidate, dimension, now) {
  if (
    !record
    || record._id !== candidate.id
    || record.dimension !== dimension.name
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
    || record.updatedAt.getTime() > now.getTime()
  ) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
  const elapsed = now.getTime() - record.windowStartedAt.getTime();
  const expiredWindow = elapsed >= dimension.windowMs;
  return {
    failureCount: expiredWindow ? 0 : record.failureCount,
    windowStartedAt: expiredWindow
      ? copyDate(now)
      : copyDate(record.windowStartedAt),
    blockedUntil: record.blockedUntil
      ? copyDate(record.blockedUntil)
      : null
  };
}

async function readRateDimension(source, dimension, now) {
  const items = [];
  for (const candidate of dimension.candidates) {
    const ref = source
      .collection('password_rate_limits')
      .doc(candidate.id);
    const record = await optionalDocument(ref, candidate.id);
    items.push({
      candidate,
      ref,
      record,
      normalized: record
        ? normalizedRateRecord(record, candidate, dimension, now)
        : null
    });
  }
  const existing = items
    .filter((item) => item.normalized)
    .map((item) => item.normalized);
  const failureCount = existing.length
    ? Math.max(...existing.map((item) => item.failureCount))
    : 0;
  const starts = existing
    .filter((item) => item.failureCount > 0)
    .map((item) => item.windowStartedAt.getTime());
  const blockedValues = existing
    .filter((item) => item.blockedUntil)
    .map((item) => item.blockedUntil.getTime());
  return {
    dimension,
    items,
    state: {
      failureCount,
      windowStartedAt: new Date(
        starts.length ? Math.min(...starts) : now.getTime()
      ),
      blockedUntil: blockedValues.length
        ? new Date(Math.max(...blockedValues))
        : null
    }
  };
}

async function readPasswordRateState(source, dimensions, now) {
  const states = [];
  for (const dimension of dimensions) {
    states.push(await readRateDimension(source, dimension, now));
  }
  return states;
}

function rateStateBlocked(rateStates, now) {
  return rateStates.some((entry) => (
    entry.state.blockedUntil
    && now.getTime() < entry.state.blockedUntil.getTime()
  ));
}

async function synchronizeCanonicalRateStates(rateStates, now) {
  for (const entry of rateStates) {
    if (entry.items.some((item) => item.record)) {
      await writeRateState(entry, entry.state, now);
    }
  }
}

async function synchronizePasswordRates(source, dimensions, now) {
  const rateStates = await readPasswordRateState(
    source,
    dimensions,
    now
  );
  await synchronizeCanonicalRateStates(rateStates, now);
  return rateStateBlocked(rateStates, now);
}

async function writeRateState(entry, state, now) {
  for (const item of entry.items) {
    if (!item.record && !item.candidate.isActive) continue;
    const data = {
      dimension: entry.dimension.name,
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

async function recordPasswordFailure(source, dimensions, now) {
  const rateStates = await readPasswordRateState(
    source,
    dimensions,
    now
  );
  if (rateStateBlocked(rateStates, now)) {
    await synchronizeCanonicalRateStates(rateStates, now);
    return true;
  }
  let limited = false;
  for (const entry of rateStates) {
    const failureCount = entry.state.failureCount + 1;
    const reachedLimit = failureCount >= entry.dimension.limit;
    const state = {
      failureCount,
      windowStartedAt: entry.state.failureCount > 0
        ? entry.state.windowStartedAt
        : copyDate(now),
      blockedUntil: reachedLimit
        ? new Date(now.getTime() + entry.dimension.blockMs)
        : entry.state.blockedUntil
    };
    if (reachedLimit) limited = true;
    await writeRateState(entry, state, now);
  }
  return limited;
}

async function clearSuccessfulPairRate(source, dimension, now) {
  const entry = await readRateDimension(source, dimension, now);
  if (entry.items.every((item) => !item.record)) return;
  if (
    entry.state.blockedUntil
    && now.getTime() < entry.state.blockedUntil.getTime()
  ) {
    throw authError('PASSWORD_RATE_LIMITED');
  }
  await writeRateState(entry, {
    failureCount: 0,
    windowStartedAt: copyDate(now),
    blockedUntil: null
  }, now);
}

async function registerAccountName({
  db,
  event,
  now,
  keyring
}) {
  const normalizedAccountName = normalizeAccountName(
    event.accountName
  );
  const displayAccountName = event.accountName.trim();
  const accountNameId = accountNameDocumentId(
    normalizedAccountName
  );
  const accountId = newAccountId();
  const passwordRecord = hashPassword(event.password);
  const preparedSessionToken = prepareSessionToken(keyring);

  return db.runTransaction(async (transaction) => {
    const accountNameRef = transaction
      .collection('account_names')
      .doc(accountNameId);
    const accountRef = transaction
      .collection('accounts')
      .doc(accountId);
    const userRef = transaction.collection('users').doc(accountId);
    const existingAccountName = await optionalDocument(
      accountNameRef,
      accountNameId
    );
    if (existingAccountName) {
      throw authError('ACCOUNT_NAME_EXISTS');
    }
    const collision = await optionalDocument(accountRef, accountId);
    const userCollision = await optionalDocument(userRef, accountId);
    if (collision || userCollision) {
      throw authError('AUTH_INTERNAL_ERROR');
    }

    const account = newAccountRecord({
      accountId,
      passwordRecord,
      accountNameBindingId: accountNameId,
      consent: {
        termsVersion: event.termsVersion,
        privacyVersion: event.privacyVersion
      },
      now
    });
    const user = newUserRecord(accountId, now);
    const accountNameRelation = {
      _id: accountNameId,
      accountId,
      account: displayAccountName,
      accountNormalized: normalizedAccountName,
      status: 'active',
      createdAt: new Date(now.getTime()),
      updatedAt: new Date(now.getTime())
    };

    await accountRef.set({
      data: withoutDocumentId(account)
    });
    await accountNameRef.set({
      data: withoutDocumentId(accountNameRelation)
    });
    await userRef.set({
      data: withoutDocumentId(user)
    });
    const issued = await issueAccountSession({
      transaction,
      db,
      account,
      user,
      clientInstanceId: event.clientInstanceId,
      method: 'password',
      now,
      keyring,
      preparedSessionToken
    });
    return sessionIssuedResponse({
      issued,
      user: issued.user,
      accountNameRelation,
      phoneBinding: null,
      method: 'password',
      now
    });
  });
}

async function loginSms({
  db,
  event,
  now,
  keyring,
  wxIdentity
}) {
  const normalizedPhone = normalizePhone(event.phone);
  const candidates = phoneCandidates(keyring, normalizedPhone);
  const newId = newAccountId();
  const preparedSessionToken = prepareSessionToken(keyring);
  const expectedScope = {
    purpose: 'login',
    clientInstanceId: event.clientInstanceId,
    wechatBindingInput: wxIdentity.bindingInput,
    accountId: '',
    sessionId: ''
  };

  return db.runTransaction(async (transaction) => {
    const consumed = await consumeSmsChallenge({
      transaction,
      challengeId: event.challengeId,
      code: event.code,
      expectedPurpose: 'login',
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

    const items = await readPhoneCandidateItems(
      transaction,
      candidates
    );
    const selected = selectPhoneBinding(items);
    let account;
    let user;
    let phoneBinding;

    if (!selected) {
      const accountRef = transaction.collection('accounts').doc(newId);
      const userRef = transaction.collection('users').doc(newId);
      const accountCollision = await optionalDocument(accountRef, newId);
      const userCollision = await optionalDocument(userRef, newId);
      if (accountCollision || userCollision) {
        throw authError('AUTH_INTERNAL_ERROR');
      }
      phoneBinding = newPhoneBindingRecord({
        id: items[0].candidate.id,
        accountId: newId,
        keyVersion: items[0].candidate.keyVersion,
        phoneMasked: consumed.phoneMasked,
        now
      });
      account = newAccountRecord({
        accountId: newId,
        passwordRecord: null,
        accountNameBindingId: '',
        consent: {
          termsVersion: event.termsVersion,
          privacyVersion: event.privacyVersion
        },
        now
      });
      account.phoneBindingId = phoneBinding._id;
      user = newUserRecord(newId, now);
      await accountRef.set({ data: withoutDocumentId(account) });
      await items[0].ref.set({
        data: withoutDocumentId(phoneBinding)
      });
      await userRef.set({ data: withoutDocumentId(user) });
    } else {
      if (selected.binding.phoneMasked !== consumed.phoneMasked) {
        throw authError('AUTH_INTERNAL_ERROR');
      }
      const graph = await readAccountGraph(
        transaction,
        selected.binding.accountId
      );
      account = graph.account;
      user = graph.user;
      if (account.status !== 'active') {
        throw authError('ACCOUNT_DISABLED');
      }
      const migrated = await migratePhoneBinding({
        items,
        selected,
        accountRef: transaction
          .collection('accounts')
          .doc(account._id),
        account,
        phoneMasked: consumed.phoneMasked,
        now
      });
      account = migrated.account;
      phoneBinding = migrated.binding;
    }

    const accountNameRelation = await readAccountNameProjection(
      transaction,
      account
    );
    const issued = await issueAccountSession({
      transaction,
      db,
      account,
      user,
      clientInstanceId: event.clientInstanceId,
      method: 'sms',
      now,
      keyring,
      preparedSessionToken
    });
    return sessionIssuedResponse({
      issued,
      user: issued.user,
      accountNameRelation,
      phoneBinding,
      method: 'sms',
      now
    });
  });
}

async function resolvePasswordCredential(source, descriptor, keyring) {
  if (descriptor.namespace === 'invalid') {
    return { kind: 'missing', descriptor };
  }
  if (descriptor.namespace === 'account_name') {
    const relationId = accountNameDocumentId(descriptor.normalized);
    const relation = await optionalDocument(
      source.collection('account_names').doc(relationId),
      relationId
    );
    if (!relation) return { kind: 'missing', descriptor };
    if (
      typeof relation.accountId !== 'string'
      || !relation.accountId
    ) {
      throw authError('AUTH_INTERNAL_ERROR');
    }
    const graph = await readAccountGraph(
      source,
      relation.accountId,
      true
    );
    if (
      graph.account.accountNameBindingId !== relationId
      || !validAccountNameRelation(
        relation,
        relationId,
        graph.account,
        descriptor.normalized
      )
    ) {
      throw authError('AUTH_INTERNAL_ERROR');
    }
    return {
      kind: 'found',
      descriptor,
      relation,
      accountNameRelation: relation,
      phoneBinding: null,
      account: graph.account,
      user: graph.user
    };
  }

  const candidates = phoneCandidates(keyring, descriptor.normalized);
  const items = await readPhoneCandidateItems(source, candidates);
  const selected = selectPhoneBinding(items);
  if (!selected) return { kind: 'missing', descriptor, items };
  const expectedPhoneMasked = maskNormalizedPhone(descriptor.normalized);
  if (selected.binding.phoneMasked !== expectedPhoneMasked) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
  const graph = await readAccountGraph(
    source,
    selected.binding.accountId,
    true
  );
  if (graph.account.phoneBindingId !== selected.binding._id) {
    throw authError('AUTH_INTERNAL_ERROR');
  }
  return {
    kind: 'found',
    descriptor,
    items,
    selected,
    relation: selected.binding,
    accountNameRelation: await readAccountNameProjection(
      source,
      graph.account
    ),
    phoneBinding: selected.binding,
    account: graph.account,
    user: graph.user
  };
}

function samePasswordSnapshot(left, right) {
  return Boolean(
    left
    && right
    && left._id === right._id
    && left.status === right.status
    && left.authVersion === right.authVersion
    && left.passwordAlgorithm === right.passwordAlgorithm
    && left.passwordSalt === right.passwordSalt
    && left.passwordHash === right.passwordHash
  );
}

async function loginPassword({
  db,
  event,
  now,
  keyring,
  wxIdentity
}) {
  const descriptor = passwordIdentifier(event.identifier);
  const dimensions = passwordRateDimensions(
    keyring,
    descriptor,
    wxIdentity
  );
  const preflightRates = await readPasswordRateState(
    db,
    dimensions,
    now
  );
  let credential;
  let resolutionError = null;
  try {
    credential = await resolvePasswordCredential(
      db,
      descriptor,
      keyring
    );
  } catch (error) {
    resolutionError = error;
    credential = { kind: 'missing', descriptor };
  }
  const passwordValid = verifyPasswordOrDummy(
    event.password,
    credential.kind === 'found' ? credential.account : null
  );
  if (rateStateBlocked(preflightRates, now)) {
    await db.runTransaction((transaction) => (
      synchronizePasswordRates(transaction, dimensions, now)
    ));
    return failure('PASSWORD_RATE_LIMITED');
  }
  if (resolutionError) throw resolutionError;

  if (!passwordValid || credential.kind !== 'found') {
    const limited = await db.runTransaction((transaction) => (
      recordPasswordFailure(transaction, dimensions, now)
    ));
    return failure(
      limited ? 'PASSWORD_RATE_LIMITED' : 'INVALID_CREDENTIALS'
    );
  }
  if (credential.account.status !== 'active') {
    throw authError('ACCOUNT_DISABLED');
  }

  const preparedSessionToken = prepareSessionToken(keyring);
  return db.runTransaction(async (transaction) => {
    const transactionRates = await readPasswordRateState(
      transaction,
      dimensions,
      now
    );
    if (rateStateBlocked(transactionRates, now)) {
      await synchronizeCanonicalRateStates(transactionRates, now);
      return failure('PASSWORD_RATE_LIMITED');
    }
    await synchronizeCanonicalRateStates(transactionRates, now);
    const live = await resolvePasswordCredential(
      transaction,
      descriptor,
      keyring
    );
    if (
      live.kind !== 'found'
      || live.relation._id !== credential.relation._id
      || !samePasswordSnapshot(live.account, credential.account)
    ) {
      throw authError('AUTH_CONFLICT');
    }
    if (live.account.status !== 'active') {
      throw authError('ACCOUNT_DISABLED');
    }

    let account = live.account;
    let phoneBinding = live.phoneBinding;
    if (descriptor.namespace === 'phone') {
      const migrated = await migratePhoneBinding({
        items: live.items,
        selected: live.selected,
        accountRef: transaction
          .collection('accounts')
          .doc(account._id),
        account,
        phoneMasked: maskNormalizedPhone(descriptor.normalized),
        now
      });
      account = migrated.account;
      phoneBinding = migrated.binding;
    }
    await clearSuccessfulPairRate(
      transaction,
      dimensions[0],
      now
    );
    const issued = await issueAccountSession({
      transaction,
      db,
      account,
      user: live.user,
      clientInstanceId: event.clientInstanceId,
      method: 'password',
      now,
      keyring,
      preparedSessionToken
    });
    return sessionIssuedResponse({
      issued,
      user: issued.user,
      accountNameRelation: live.accountNameRelation,
      phoneBinding,
      method: 'password',
      now
    });
  });
}

module.exports = {
  loginPassword,
  loginSms,
  maskNormalizedPhone,
  migratePhoneBinding,
  newPhoneBindingRecord,
  phoneCandidates,
  readAccountGraph,
  readAccountNameProjection,
  readPhoneCandidateItems,
  registerAccountName,
  selectPhoneBinding
};
