'use strict';

const crypto = require('crypto');
const {
  deriveKey,
  candidateHmacIds
} = require('./keyring');

const SMS_CODE_TTL_MS = 5 * 60 * 1000;
const SMS_RESEND_MS = 60 * 1000;
const SMS_WINDOW_MS = 24 * 60 * 60 * 1000;
const PHONE_WINDOW_LIMIT = 10;
const WECHAT_WINDOW_LIMIT = 30;
const CHALLENGE_RANDOM_BYTES = 16;
const VERSION_PATTERN = /^[A-Z0-9_]+$/;
const RANDOM_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PHONE_PATTERN = /^\+861\d{10}$/;
const CODE_PATTERN = /^\d{6}$/;
const PURPOSES = Object.freeze([
  'login',
  'bind_phone',
  'wechat_entry',
  'reauth'
]);
const PURPOSE_SET = new Set(PURPOSES);
const HMAC_NAMESPACE = Buffer.from('cuetrace-auth-v2-hmac\0');
const STATUS_SET = new Set([
  'pending',
  'sent',
  'failed',
  'superseded'
]);

const FAILURE_RESULTS = Object.freeze({
  SMS_CODE_INVALID: Object.freeze({
    ok: false,
    code: 'SMS_CODE_INVALID',
    msg: '验证码无效，请重新获取'
  }),
  SMS_CODE_EXPIRED: Object.freeze({
    ok: false,
    code: 'SMS_CODE_EXPIRED',
    msg: '验证码已过期，请重新获取'
  }),
  SMS_CODE_LOCKED: Object.freeze({
    ok: false,
    code: 'SMS_CODE_LOCKED',
    msg: '验证码已锁定，请重新获取'
  })
});

function failure(code) {
  return { ...FAILURE_RESULTS[code] };
}

function smsAbort(code) {
  const error = new Error(
    code === 'SMS_TOO_FREQUENT'
      ? 'SMS request is too frequent.'
      : 'SMS transaction failed.'
  );
  error.name = 'SmsTransactionAbort';
  error.code = code || 'AUTH_INTERNAL_ERROR';
  return error;
}

function internalError() {
  return smsAbort('AUTH_INTERNAL_ERROR');
}

function isPlainObject(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && !(value instanceof Date)
  );
}

function validString(value, maximumLength) {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= maximumLength
  );
}

function validPurpose(value) {
  return typeof value === 'string' && PURPOSE_SET.has(value);
}

function validDate(value) {
  return (
    value instanceof Date
    && Number.isFinite(value.getTime())
  );
}

function copyDate(value) {
  return new Date(value.getTime());
}

function keyringHasVersion(keyring, version) {
  return (
    keyring
    && keyring.keys instanceof Map
    && VERSION_PATTERN.test(version)
    && keyring.keys.has(version)
  );
}

function lengthPrefixed(value) {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function digestForFields(
  keyring,
  version,
  derivedPurpose,
  namespace,
  fields
) {
  if (
    !keyringHasVersion(keyring, version)
    || !validString(namespace, 64)
    || !Array.isArray(fields)
    || fields.some((field) => typeof field !== 'string')
  ) {
    throw internalError();
  }
  try {
    return crypto
      .createHmac(
        'sha256',
        deriveKey(keyring, version, derivedPurpose)
      )
      .update(Buffer.concat([
        HMAC_NAMESPACE,
        lengthPrefixed(derivedPurpose),
        lengthPrefixed(namespace),
        ...fields.map(lengthPrefixed)
      ]))
      .digest('base64url');
  } catch (_) {
    throw internalError();
  }
}

function identifierForVersion(
  keyring,
  version,
  derivedPurpose,
  prefix,
  value
) {
  if (
    !validString(prefix, 64)
    || !validString(value, 2048)
  ) {
    throw internalError();
  }
  const digest = digestForFields(
    keyring,
    version,
    derivedPurpose,
    prefix,
    [value]
  );
  return prefix + '.' + version + '.' + digest;
}

function parseChallengeId(challengeId, keyring) {
  if (typeof challengeId !== 'string') return null;
  const parts = challengeId.split('.');
  if (
    parts.length !== 3
    || parts[0] !== 'v2'
    || !VERSION_PATTERN.test(parts[1])
    || !RANDOM_PATTERN.test(parts[2])
    || !keyringHasVersion(keyring, parts[1])
  ) {
    return null;
  }
  try {
    const bytes = Buffer.from(parts[2], 'base64url');
    if (
      bytes.length !== CHALLENGE_RANDOM_BYTES
      || bytes.toString('base64url') !== parts[2]
    ) {
      return null;
    }
  } catch (_) {
    return null;
  }
  return {
    keyVersion: parts[1],
    randomPart: parts[2]
  };
}

function challengeDocumentId(keyring, challengeId) {
  const parsed = parseChallengeId(challengeId, keyring);
  if (!parsed) throw internalError();
  return identifierForVersion(
    keyring,
    parsed.keyVersion,
    'sms-challenge',
    'sms-challenge',
    challengeId
  );
}

function scopeFields(purpose, scope) {
  if (
    !validPurpose(purpose)
    || !isPlainObject(scope)
    || scope.purpose !== purpose
    || !validString(scope.clientInstanceId, 256)
    || !validString(scope.wechatBindingInput, 1024)
    || typeof scope.accountId !== 'string'
    || scope.accountId.length > 128
    || typeof scope.sessionId !== 'string'
    || scope.sessionId.length > 256
  ) {
    return null;
  }
  return [
    purpose,
    scope.clientInstanceId,
    scope.wechatBindingInput,
    scope.accountId,
    scope.sessionId
  ];
}

function validScopeForPurpose(purpose, scope) {
  const fields = scopeFields(purpose, scope);
  if (!fields) return false;
  if (purpose === 'login' || purpose === 'wechat_entry') {
    return scope.accountId === '' && scope.sessionId === '';
  }
  if (purpose === 'bind_phone') {
    return scope.accountId !== '' && scope.sessionId === '';
  }
  return scope.accountId !== '' && scope.sessionId !== '';
}

function scopeHashForVersion(
  keyring,
  version,
  purpose,
  scope
) {
  const fields = scopeFields(purpose, scope);
  if (!fields || !keyringHasVersion(keyring, version)) {
    throw internalError();
  }
  const digest = digestForFields(
    keyring,
    version,
    'sms-challenge',
    'scope',
    fields
  );
  return 'scope.' + version + '.' + digest;
}

function codeHashForVersion(
  keyring,
  version,
  challengeId,
  code
) {
  if (
    !parseChallengeId(challengeId, keyring)
    || !CODE_PATTERN.test(code)
  ) {
    throw internalError();
  }
  const digest = digestForFields(
    keyring,
    version,
    'sms-code',
    'code',
    [challengeId, code]
  );
  return 'sms-code.' + version + '.' + digest;
}

function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') {
    return false;
  }
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  if (leftBytes.length !== rightBytes.length) return false;
  return crypto.timingSafeEqual(leftBytes, rightBytes);
}

function newChallengeId(keyring) {
  if (
    !keyring
    || !keyringHasVersion(keyring, keyring.activeVersion)
  ) {
    throw internalError();
  }
  let bytes;
  try {
    bytes = crypto.randomBytes(CHALLENGE_RANDOM_BYTES);
  } catch (_) {
    throw internalError();
  }
  if (
    (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array))
    || Buffer.from(bytes).length !== CHALLENGE_RANDOM_BYTES
  ) {
    throw internalError();
  }
  return 'v2.'
    + keyring.activeVersion
    + '.'
    + Buffer.from(bytes).toString('base64url');
}

function maskPhone(phone) {
  if (!PHONE_PATTERN.test(phone)) throw internalError();
  const national = phone.slice(3);
  return national.slice(0, 3)
    + '****'
    + national.slice(-4);
}

function exactMissing(error, expectedId) {
  if (!validString(expectedId, 256)) return false;
  const expected =
    'document.get:fail document with _id '
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
      throw internalError();
    }
    return result.data;
  } catch (error) {
    if (exactMissing(error, expectedId)) return null;
    if (
      error
      && error.name === 'SmsTransactionAbort'
    ) {
      throw error;
    }
    throw internalError();
  }
}

function validChallengeDocumentId(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  return (
    parts.length === 3
    && parts[0] === 'sms-challenge'
    && VERSION_PATTERN.test(parts[1])
    && DIGEST_PATTERN.test(parts[2])
  );
}

function emptyPurposeStates() {
  const result = {};
  for (const purpose of PURPOSES) {
    result[purpose] = {
      generation: 0,
      activeChallengeId: null
    };
  }
  return result;
}

function validPurposeState(value) {
  return Boolean(
    isPlainObject(value)
    && Number.isSafeInteger(value.generation)
    && value.generation >= 0
    && (
      (
        value.generation === 0
        && value.activeChallengeId === null
      )
      || (
        value.generation > 0
        && validChallengeDocumentId(
          value.activeChallengeId
        )
      )
    )
  );
}

function normalizePurposeStates(value) {
  if (!isPlainObject(value)) throw internalError();
  const result = {};
  for (const purpose of PURPOSES) {
    if (!validPurposeState(value[purpose])) {
      throw internalError();
    }
    result[purpose] = {
      generation: value[purpose].generation,
      activeChallengeId:
        value[purpose].activeChallengeId
    };
  }
  return result;
}

function mergePurposeStates(target, source) {
  for (const purpose of PURPOSES) {
    const current = target[purpose];
    const candidate = source[purpose];
    if (candidate.generation > current.generation) {
      target[purpose] = { ...candidate };
      continue;
    }
    if (
      candidate.generation === current.generation
      && candidate.activeChallengeId
        !== current.activeChallengeId
    ) {
      throw internalError();
    }
  }
}

function normalizeEvents(events, nowMs, maximumEvents) {
  if (
    !Array.isArray(events)
    || events.length < 1
    || events.length > maximumEvents
  ) {
    throw internalError();
  }
  const result = [];
  const seen = new Set();
  for (const event of events) {
    if (
      !isPlainObject(event)
      || !validChallengeDocumentId(event.challengeId)
      || !validDate(event.acceptedAt)
      || event.acceptedAt.getTime() > nowMs
      || seen.has(event.challengeId)
    ) {
      throw internalError();
    }
    seen.add(event.challengeId);
    result.push({
      challengeId: event.challengeId,
      acceptedAt: copyDate(event.acceptedAt)
    });
  }
  return result;
}

function normalizeRateDocument(
  record,
  candidate,
  kind,
  nowMs
) {
  if (
    !isPlainObject(record)
    || record._id !== candidate.id
    || record.kind !== kind
    || record.keyVersion !== candidate.keyVersion
    || !validDate(record.lastAcceptedAt)
  ) {
    throw internalError();
  }
  const events = normalizeEvents(
    record.events,
    nowMs,
    kind === 'phone'
      ? PHONE_WINDOW_LIMIT
      : WECHAT_WINDOW_LIMIT
  );
  const latestAcceptedMs = Math.max(
    ...events.map((event) => event.acceptedAt.getTime())
  );
  if (record.lastAcceptedAt.getTime() !== latestAcceptedMs) {
    throw internalError();
  }
  const normalized = {
    events,
    lastAcceptedAt: copyDate(record.lastAcceptedAt)
  };
  if (kind === 'phone') {
    normalized.purposes = normalizePurposeStates(
      record.purposes
    );
  }
  return normalized;
}

function mergeEvents(records, cutoffMs, nowMs) {
  const merged = new Map();
  for (const record of records) {
    for (const event of record.events) {
      const acceptedMs = event.acceptedAt.getTime();
      if (acceptedMs <= cutoffMs || acceptedMs > nowMs) {
        continue;
      }
      if (merged.has(event.challengeId)) {
        if (
          merged.get(event.challengeId).acceptedAt.getTime()
          !== acceptedMs
        ) {
          throw internalError();
        }
        continue;
      }
      merged.set(event.challengeId, {
        challengeId: event.challengeId,
        acceptedAt: copyDate(event.acceptedAt)
      });
    }
  }
  return [...merged.values()].sort(
    (left, right) => (
      left.acceptedAt.getTime()
      - right.acceptedAt.getTime()
    )
  );
}

function candidateRateIds(
  keyring,
  phone,
  wxIdentityValue
) {
  let phoneRates;
  let wechatRates;
  let phoneBindings;
  try {
    phoneRates = candidateHmacIds(
      keyring,
      'rate-limit',
      phone,
      'sms-phone-rate'
    );
    wechatRates = candidateHmacIds(
      keyring,
      'rate-limit',
      wxIdentityValue.bindingInput,
      'sms-wechat-rate'
    );
    phoneBindings = candidateHmacIds(
      keyring,
      'phone-binding',
      phone,
      'phone'
    );
  } catch (_) {
    throw internalError();
  }
  return { phoneRates, wechatRates, phoneBindings };
}

function validTransaction(transaction) {
  return Boolean(
    transaction
    && typeof transaction.collection === 'function'
  );
}

async function readRateCandidates(
  transaction,
  candidates,
  kind,
  nowMs
) {
  const result = [];
  for (const candidate of candidates) {
    let ref;
    try {
      ref = transaction
        .collection('sms_rate_limits')
        .doc(candidate.id);
    } catch (_) {
      throw internalError();
    }
    const record = await optionalDocument(ref, candidate.id);
    if (!record) {
      result.push({
        candidate,
        ref,
        exists: false,
        normalized: null
      });
      continue;
    }
    result.push({
      candidate,
      ref,
      exists: true,
      normalized: normalizeRateDocument(
        record,
        candidate,
        kind,
        nowMs
      )
    });
  }
  return result;
}

async function writeRateState(
  item,
  kind,
  events,
  purposes,
  now
) {
  const data = {
    kind,
    keyVersion: item.candidate.keyVersion,
    events: events.map((event) => ({
      challengeId: event.challengeId,
      acceptedAt: copyDate(event.acceptedAt)
    })),
    lastAcceptedAt: copyDate(now),
    updatedAt: copyDate(now)
  };
  if (kind === 'phone') {
    data.purposes = {};
    for (const purpose of PURPOSES) {
      data.purposes[purpose] = {
        generation: purposes[purpose].generation,
        activeChallengeId:
          purposes[purpose].activeChallengeId
      };
    }
  }
  try {
    if (item.exists) {
      await item.ref.update({ data });
    } else if (item.candidate.isActive) {
      await item.ref.set({ data });
    }
  } catch (_) {
    throw internalError();
  }
}

function validPreviousChallenge(
  record,
  expectedId,
  purpose,
  generation,
  expectedPhoneMasked,
  phoneBindingCandidates,
  phoneRateCandidates,
  phoneEvents,
  cutoffMs,
  now
) {
  const normalized = normalizeChallengeRecord(
    record,
    expectedId
  );
  return Boolean(
    normalized
    && normalized.purpose === purpose
    && normalized.generation === generation
    && normalized.phoneMasked === expectedPhoneMasked
    && normalized.status !== 'superseded'
    && normalized.createdAt.getTime() <= now.getTime()
    && (
      normalized.createdAt.getTime() <= cutoffMs
      || phoneEvents.some((event) => (
        event.challengeId === expectedId
        && event.acceptedAt.getTime()
          === normalized.createdAt.getTime()
      ))
    )
    && (
      normalized.lastSentAt === null
      || normalized.lastSentAt.getTime() <= now.getTime()
    )
    && (
      normalized.usedAt === null
      || normalized.usedAt.getTime() <= now.getTime()
    )
    && phoneBindingCandidates.some(
      (candidate) => candidate.id === normalized.phoneBindingId
    )
    && phoneRateCandidates.some(
      (candidate) => candidate.id === normalized.phoneRateId
    )
  );
}

async function claimSmsChallenge({
  transaction,
  phone,
  purpose,
  scope,
  wxIdentity: wxIdentityValue,
  now,
  keyring
}) {
  if (
    !validTransaction(transaction)
    || !PHONE_PATTERN.test(phone)
    || !validPurpose(purpose)
    || !validScopeForPurpose(purpose, scope)
    || !wxIdentityValue
    || !validString(
      wxIdentityValue.bindingInput,
      1024
    )
    || scope.wechatBindingInput
      !== wxIdentityValue.bindingInput
    || !validDate(now)
    || !keyring
    || !keyringHasVersion(
      keyring,
      keyring.activeVersion
    )
  ) {
    throw internalError();
  }

  const nowMs = now.getTime();
  const cutoffMs = nowMs - SMS_WINDOW_MS;
  const ids = candidateRateIds(
    keyring,
    phone,
    wxIdentityValue
  );
  if (
    !ids.phoneRates.length
    || !ids.wechatRates.length
    || !ids.phoneBindings.length
    || ids.phoneRates[0].keyVersion
      !== keyring.activeVersion
    || ids.wechatRates[0].keyVersion
      !== keyring.activeVersion
    || ids.phoneBindings[0].keyVersion
      !== keyring.activeVersion
  ) {
    throw internalError();
  }

  const phoneItems = await readRateCandidates(
    transaction,
    ids.phoneRates,
    'phone',
    nowMs
  );
  const wechatItems = await readRateCandidates(
    transaction,
    ids.wechatRates,
    'wechat',
    nowMs
  );
  const phoneRecords = phoneItems
    .filter((item) => item.exists)
    .map((item) => item.normalized);
  const wechatRecords = wechatItems
    .filter((item) => item.exists)
    .map((item) => item.normalized);
  const phoneEvents = mergeEvents(
    phoneRecords,
    cutoffMs,
    nowMs
  );
  const wechatEvents = mergeEvents(
    wechatRecords,
    cutoffMs,
    nowMs
  );
  const latestPhoneEvent = phoneEvents.at(-1);
  if (
    latestPhoneEvent
    && nowMs - latestPhoneEvent.acceptedAt.getTime()
      < SMS_RESEND_MS
  ) {
    throw smsAbort('SMS_TOO_FREQUENT');
  }
  if (
    phoneEvents.length >= PHONE_WINDOW_LIMIT
    || wechatEvents.length >= WECHAT_WINDOW_LIMIT
  ) {
    throw smsAbort('SMS_TOO_FREQUENT');
  }

  const purposes = emptyPurposeStates();
  for (const record of phoneRecords) {
    mergePurposeStates(purposes, record.purposes);
  }
  const previousState = {
    ...purposes[purpose]
  };
  if (
    previousState.generation
    >= Number.MAX_SAFE_INTEGER
  ) {
    throw internalError();
  }

  const challengeId = newChallengeId(keyring);
  const challengeIdHmac = challengeDocumentId(
    keyring,
    challengeId
  );
  let challengeRef;
  try {
    challengeRef = transaction
      .collection('sms_codes')
      .doc(challengeIdHmac);
  } catch (_) {
    throw internalError();
  }
  const collision = await optionalDocument(
    challengeRef,
    challengeIdHmac
  );
  if (collision) throw internalError();

  const generation = previousState.generation + 1;
  purposes[purpose] = {
    generation,
    activeChallengeId: challengeIdHmac
  };
  const acceptedEvent = {
    challengeId: challengeIdHmac,
    acceptedAt: copyDate(now)
  };
  phoneEvents.push(acceptedEvent);
  wechatEvents.push({
    challengeId: challengeIdHmac,
    acceptedAt: copyDate(now)
  });

  if (
    previousState.activeChallengeId
    && previousState.activeChallengeId
      !== challengeIdHmac
  ) {
    let previousRef;
    try {
      previousRef = transaction
        .collection('sms_codes')
        .doc(previousState.activeChallengeId);
    } catch (_) {
      throw internalError();
    }
    const previous = await optionalDocument(
      previousRef,
      previousState.activeChallengeId
    );
    if (previous) {
      if (!validPreviousChallenge(
        previous,
        previousState.activeChallengeId,
        purpose,
        previousState.generation,
        maskPhone(phone),
        ids.phoneBindings,
        ids.phoneRates,
        phoneEvents,
        cutoffMs,
        now
      )) {
        throw internalError();
      }
      try {
        await previousRef.update({
          data: {
            status: 'superseded',
            codeHash: '',
            expiresAt: null,
            lastSentAt: null,
            providerMarker: 'superseded'
          }
        });
      } catch (_) {
        throw internalError();
      }
    }
  }

  for (const item of phoneItems) {
    await writeRateState(
      item,
      'phone',
      phoneEvents,
      purposes,
      now
    );
  }
  for (const item of wechatItems) {
    await writeRateState(
      item,
      'wechat',
      wechatEvents,
      null,
      now
    );
  }

  const scopeHash = scopeHashForVersion(
    keyring,
    keyring.activeVersion,
    purpose,
    scope
  );
  const challengeData = {
    purpose,
    keyVersion: keyring.activeVersion,
    phoneBindingId: ids.phoneBindings[0].id,
    phoneMasked: maskPhone(phone),
    phoneRateId: ids.phoneRates[0].id,
    scopeHash,
    generation,
    status: 'pending',
    codeHash: '',
    createdAt: copyDate(now),
    expiresAt: null,
    lastSentAt: null,
    failedAttempts: 0,
    locked: false,
    used: false,
    usedAt: null,
    providerMarker: 'pending'
  };
  try {
    await challengeRef.set({ data: challengeData });
  } catch (_) {
    throw internalError();
  }

  return Object.freeze({
    challengeId,
    challengeDocumentId: challengeIdHmac,
    purpose,
    keyVersion: keyring.activeVersion,
    phoneBindingId: ids.phoneBindings[0].id,
    phoneMasked: challengeData.phoneMasked,
    phoneRateId: ids.phoneRates[0].id,
    scopeHash,
    generation
  });
}

function validClaim(claim, keyring) {
  if (
    !isPlainObject(claim)
    || !validPurpose(claim.purpose)
    || !VERSION_PATTERN.test(claim.keyVersion)
    || !keyringHasVersion(keyring, claim.keyVersion)
    || !validChallengeDocumentId(
      claim.challengeDocumentId
    )
    || !versionedIdentifierMatches(
      claim.phoneBindingId,
      'phone',
      claim.keyVersion
    )
    || !/^1\d{2}\*{4}\d{4}$/.test(
      claim.phoneMasked
    )
    || !versionedIdentifierMatches(
      claim.phoneRateId,
      'sms-phone-rate',
      claim.keyVersion
    )
    || !versionedIdentifierMatches(
      claim.scopeHash,
      'scope',
      claim.keyVersion
    )
    || !Number.isSafeInteger(claim.generation)
    || claim.generation < 1
  ) {
    return false;
  }
  const parsed = parseChallengeId(
    claim.challengeId,
    keyring
  );
  if (
    !parsed
    || parsed.keyVersion !== claim.keyVersion
  ) {
    return false;
  }
  try {
    return challengeDocumentId(
      keyring,
      claim.challengeId
    ) === claim.challengeDocumentId;
  } catch (_) {
    return false;
  }
}

function validChallengeIdentity(record, claim) {
  return Boolean(
    isPlainObject(record)
    && record._id === claim.challengeDocumentId
    && record.purpose === claim.purpose
    && record.keyVersion === claim.keyVersion
    && record.phoneBindingId
      === claim.phoneBindingId
    && record.phoneMasked === claim.phoneMasked
    && record.phoneRateId === claim.phoneRateId
    && record.scopeHash === claim.scopeHash
    && record.generation === claim.generation
    && STATUS_SET.has(record.status)
  );
}

function classifyRatePointer(
  normalizedRate,
  purpose,
  generation,
  challengeIdHmac,
  challengeCreatedAtMs
) {
  const state = normalizedRate.purposes[purpose];
  const activeEvent = normalizedRate.events.find(
    (event) => event.challengeId === state.activeChallengeId
  );
  if (!activeEvent) {
    throw internalError();
  }
  if (
    state.generation === generation
    && state.activeChallengeId === challengeIdHmac
  ) {
    if (
      activeEvent.acceptedAt.getTime()
      !== challengeCreatedAtMs
    ) {
      throw internalError();
    }
    return 'current';
  }
  if (
    state.generation > generation
    && state.activeChallengeId !== challengeIdHmac
  ) {
    if (
      activeEvent.acceptedAt.getTime()
      <= challengeCreatedAtMs
    ) {
      throw internalError();
    }
    return 'stale';
  }
  throw internalError();
}

function versionedIdentifierMatches(
  value,
  prefix,
  version
) {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  return (
    parts.length === 3
    && parts[0] === prefix
    && parts[1] === version
    && DIGEST_PATTERN.test(parts[2])
  );
}

function normalizeChallengeRecord(record, expectedId) {
  if (
    !isPlainObject(record)
    || record._id !== expectedId
    || !versionedIdentifierMatches(
      expectedId,
      'sms-challenge',
      record.keyVersion
    )
    || !validPurpose(record.purpose)
    || !VERSION_PATTERN.test(record.keyVersion)
    || !versionedIdentifierMatches(
      record.phoneBindingId,
      'phone',
      record.keyVersion
    )
    || !/^1\d{2}\*{4}\d{4}$/.test(
      record.phoneMasked
    )
    || !versionedIdentifierMatches(
      record.phoneRateId,
      'sms-phone-rate',
      record.keyVersion
    )
    || !versionedIdentifierMatches(
      record.scopeHash,
      'scope',
      record.keyVersion
    )
    || !Number.isSafeInteger(record.generation)
    || record.generation < 1
    || !STATUS_SET.has(record.status)
    || typeof record.codeHash !== 'string'
    || !validDate(record.createdAt)
    || !Number.isSafeInteger(record.failedAttempts)
    || record.failedAttempts < 0
    || record.failedAttempts > 5
    || typeof record.locked !== 'boolean'
    || typeof record.used !== 'boolean'
    || (
      record.locked
      && record.failedAttempts !== 5
    )
    || (
      !record.locked
      && record.failedAttempts === 5
    )
    || (
      record.used
      && !validDate(record.usedAt)
    )
    || (
      !record.used
      && record.usedAt !== null
    )
    || record.providerMarker !== record.status
  ) {
    return null;
  }

  if (
    (record.status === 'pending' || record.status === 'failed')
    && (
      record.failedAttempts !== 0
      || record.locked
      || record.used
      || record.usedAt !== null
    )
  ) {
    return null;
  }

  if (record.status === 'sent') {
    if (
      !versionedIdentifierMatches(
        record.codeHash,
        'sms-code',
        record.keyVersion
      )
      || !validDate(record.lastSentAt)
      || !validDate(record.expiresAt)
      || record.lastSentAt.getTime()
        < record.createdAt.getTime()
      || record.expiresAt.getTime()
        !== record.lastSentAt.getTime()
          + SMS_CODE_TTL_MS
      || (
        record.used
        && record.usedAt.getTime()
          < record.lastSentAt.getTime()
      )
    ) {
      return null;
    }
  } else if (
    record.codeHash !== ''
    || record.lastSentAt !== null
    || record.expiresAt !== null
  ) {
    return null;
  }

  return {
    ...record,
    createdAt: copyDate(record.createdAt),
    lastSentAt: record.lastSentAt
      ? copyDate(record.lastSentAt)
      : null,
    expiresAt: record.expiresAt
      ? copyDate(record.expiresAt)
      : null,
    usedAt: record.usedAt
      ? copyDate(record.usedAt)
      : null
  };
}

async function finalizeSmsSend({
  transaction,
  claim,
  providerResult,
  now,
  keyring
}) {
  if (
    !validTransaction(transaction)
    || !validClaim(claim, keyring)
    || !validDate(now)
    || !isPlainObject(providerResult)
    || !['sent', 'failed'].includes(
      providerResult.status
    )
    || (
      providerResult.status === 'sent'
      && (
        typeof providerResult.code !== 'string'
        || !CODE_PATTERN.test(providerResult.code)
      )
    )
  ) {
    throw internalError();
  }

  let challengeRef;
  let rateRef;
  try {
    challengeRef = transaction
      .collection('sms_codes')
      .doc(claim.challengeDocumentId);
    rateRef = transaction
      .collection('sms_rate_limits')
      .doc(claim.phoneRateId);
  } catch (_) {
    throw internalError();
  }
  const challengeRecord = await optionalDocument(
    challengeRef,
    claim.challengeDocumentId
  );
  const rateRecord = await optionalDocument(
    rateRef,
    claim.phoneRateId
  );
  const normalizedChallenge = challengeRecord
    ? normalizeChallengeRecord(
      challengeRecord,
      claim.challengeDocumentId
    )
    : null;
  const normalizedRate = rateRecord
    ? normalizeRateDocument(
      rateRecord,
      {
        id: claim.phoneRateId,
        keyVersion: claim.keyVersion
      },
      'phone',
      now.getTime()
    )
    : null;
  if (
    !normalizedChallenge
    || !normalizedRate
    || !validChallengeIdentity(
      normalizedChallenge,
      claim
    )
  ) {
    throw internalError();
  }
  if (
    normalizedChallenge.status === 'pending'
    && (
      normalizedChallenge.failedAttempts !== 0
      || normalizedChallenge.locked
      || normalizedChallenge.used
      || normalizedChallenge.usedAt !== null
      || normalizedChallenge.codeHash !== ''
      || normalizedChallenge.lastSentAt !== null
      || normalizedChallenge.expiresAt !== null
      || normalizedChallenge.providerMarker !== 'pending'
      || now.getTime()
        < normalizedChallenge.createdAt.getTime()
    )
  ) {
    throw internalError();
  }

  const pointerState = classifyRatePointer(
    normalizedRate,
    claim.purpose,
    claim.generation,
    claim.challengeDocumentId,
    normalizedChallenge.createdAt.getTime()
  );
  if (pointerState === 'stale') {
    if (normalizedChallenge.status !== 'superseded') {
      try {
        await challengeRef.update({
          data: {
            status: 'superseded',
            codeHash: '',
            expiresAt: null,
            lastSentAt: null,
            providerMarker: 'superseded'
          }
        });
      } catch (_) {
        throw internalError();
      }
    }
    return {
      ok: false,
      state: 'superseded'
    };
  }
  if (normalizedChallenge.status === 'superseded') {
    throw internalError();
  }
  if (normalizedChallenge.status !== 'pending') {
    return {
      ok: false,
      state: normalizedChallenge.status
    };
  }

  if (providerResult.status === 'failed') {
    try {
      await challengeRef.update({
        data: {
          status: 'failed',
          codeHash: '',
          expiresAt: null,
          lastSentAt: null,
          providerMarker: 'failed'
        }
      });
    } catch (_) {
      throw internalError();
    }
    return {
      ok: false,
      state: 'failed'
    };
  }

  const codeHash = codeHashForVersion(
    keyring,
    claim.keyVersion,
    claim.challengeId,
    providerResult.code
  );
  const expiresAt = new Date(
    now.getTime() + SMS_CODE_TTL_MS
  );
  try {
    await challengeRef.update({
      data: {
        status: 'sent',
        codeHash,
        lastSentAt: copyDate(now),
        expiresAt,
        failedAttempts: 0,
        locked: false,
        used: false,
        usedAt: null,
        providerMarker: 'sent'
      }
    });
  } catch (_) {
    throw internalError();
  }
  return {
    ok: true,
    expiresAt
  };
}

async function consumeSmsChallenge({
  transaction,
  challengeId,
  code,
  expectedPurpose,
  expectedScope,
  now,
  keyring
}) {
  if (!validTransaction(transaction) || !validDate(now)) {
    throw internalError();
  }
  if (
    typeof code !== 'string'
    || !CODE_PATTERN.test(code)
    || !validPurpose(expectedPurpose)
    || !validScopeForPurpose(
      expectedPurpose,
      expectedScope
    )
  ) {
    return failure('SMS_CODE_INVALID');
  }
  const parsed = parseChallengeId(
    challengeId,
    keyring
  );
  if (!parsed) return failure('SMS_CODE_INVALID');

  let challengeIdHmac;
  let expectedScopeHash;
  try {
    challengeIdHmac = challengeDocumentId(
      keyring,
      challengeId
    );
    expectedScopeHash = scopeHashForVersion(
      keyring,
      parsed.keyVersion,
      expectedPurpose,
      expectedScope
    );
  } catch (_) {
    return failure('SMS_CODE_INVALID');
  }

  let challengeRef;
  try {
    challengeRef = transaction
      .collection('sms_codes')
      .doc(challengeIdHmac);
  } catch (_) {
    throw internalError();
  }
  const rawRecord = await optionalDocument(
    challengeRef,
    challengeIdHmac
  );
  if (!rawRecord) return failure('SMS_CODE_INVALID');
  const record = normalizeChallengeRecord(
    rawRecord,
    challengeIdHmac
  );
  if (
    !record
    || record.keyVersion !== parsed.keyVersion
    || record.purpose !== expectedPurpose
    || !constantTimeEqual(
      record.scopeHash,
      expectedScopeHash
    )
    || record.status !== 'sent'
    || now.getTime() < record.createdAt.getTime()
    || now.getTime() < record.lastSentAt.getTime()
  ) {
    return failure('SMS_CODE_INVALID');
  }
  if (now.getTime() >= record.expiresAt.getTime()) {
    return failure('SMS_CODE_EXPIRED');
  }
  if (record.locked) {
    return failure('SMS_CODE_LOCKED');
  }
  if (record.used) {
    return failure('SMS_CODE_INVALID');
  }

  let rateRef;
  try {
    rateRef = transaction
      .collection('sms_rate_limits')
      .doc(record.phoneRateId);
  } catch (_) {
    throw internalError();
  }
  const rateRecord = await optionalDocument(
    rateRef,
    record.phoneRateId
  );
  if (!rateRecord) {
    return failure('SMS_CODE_INVALID');
  }
  let pointerState;
  try {
    const normalizedRate = normalizeRateDocument(
      rateRecord,
      {
        id: record.phoneRateId,
        keyVersion: record.keyVersion
      },
      'phone',
      now.getTime()
    );
    pointerState = classifyRatePointer(
      normalizedRate,
      record.purpose,
      record.generation,
      challengeIdHmac,
      record.createdAt.getTime()
    );
  } catch (error) {
    if (
      error
      && error.name === 'SmsTransactionAbort'
      && error.code === 'AUTH_INTERNAL_ERROR'
    ) {
      return failure('SMS_CODE_INVALID');
    }
    throw error;
  }
  if (pointerState === 'stale') {
    return failure('SMS_CODE_INVALID');
  }

  let suppliedCodeHash;
  try {
    suppliedCodeHash = codeHashForVersion(
      keyring,
      parsed.keyVersion,
      challengeId,
      code
    );
  } catch (_) {
    return failure('SMS_CODE_INVALID');
  }
  if (!constantTimeEqual(
    record.codeHash,
    suppliedCodeHash
  )) {
    const failedAttempts = record.failedAttempts + 1;
    const locked = failedAttempts >= 5;
    try {
      await challengeRef.update({
        data: {
          failedAttempts,
          locked
        }
      });
    } catch (_) {
      throw internalError();
    }
    return failure(
      locked
        ? 'SMS_CODE_LOCKED'
        : 'SMS_CODE_INVALID'
    );
  }

  try {
    await challengeRef.update({
      data: {
        used: true,
        usedAt: copyDate(now)
      }
    });
  } catch (_) {
    throw internalError();
  }
  return {
    ok: true,
    phoneBindingId: record.phoneBindingId,
    phoneMasked: record.phoneMasked,
    purpose: record.purpose,
    keyVersion: record.keyVersion,
    generation: record.generation
  };
}

module.exports = {
  claimSmsChallenge,
  finalizeSmsSend,
  consumeSmsChallenge,
  challengeDocumentId,
  scopeHashForVersion,
  SMS_CODE_TTL_MS,
  SMS_RESEND_MS,
  SMS_WINDOW_MS
};
