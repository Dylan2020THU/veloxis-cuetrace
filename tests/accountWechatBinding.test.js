const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const root = path.resolve(__dirname, '..');
const accountAuthPath = path.resolve(__dirname, '..', 'cloudfunctions', 'accountAuth', 'index.js');
const dataServicePath = path.resolve(__dirname, '..', 'miniprogram', 'services', 'data.js');
const appPath = path.resolve(__dirname, '..', 'miniprogram', 'app.js');
const BASE_MS = Date.parse('2026-07-16T12:00:00.000Z');
const TERMS_VERSION = '2026-07-15';
const PRIVACY_VERSION = '2026-07-15';

const {
  candidateHmacIds,
  loadKeyring
} = require('../cloudfunctions/accountAuth/lib/auth/keyring');
const {
  wechatIdentity
} = require('../cloudfunctions/accountAuth/lib/auth/identifiers');
const {
  claimSmsChallenge,
  finalizeSmsSend
} = require('../cloudfunctions/accountAuth/lib/auth/sms');
const {
  hashPassword
} = require('../cloudfunctions/accountAuth/lib/auth/password');

process.env.CUETRACE_AUTH_KEY_ACTIVE_VERSION = 'K2';
process.env.CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS = '';
process.env.CUETRACE_AUTH_KEY_K2 = Buffer.alloc(32, 0x42)
  .toString('base64');

function clone(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clone(item)])
    );
  }
  return value;
}

function makeState(seed) {
  const source = seed || {};
  source.accounts = Array.isArray(source.accounts) ? source.accounts : [];
  source.account_names = Array.isArray(source.account_names)
    ? source.account_names
    : [];
  source.phone_bindings = Array.isArray(source.phone_bindings)
    ? source.phone_bindings
    : [];
  source.wechat_bindings = Array.isArray(source.wechat_bindings) ? source.wechat_bindings : [];
  source.auth_sessions = Array.isArray(source.auth_sessions)
    ? source.auth_sessions
    : [];
  source.auth_proofs = Array.isArray(source.auth_proofs)
    ? source.auth_proofs
    : [];
  source.password_rate_limits = Array.isArray(source.password_rate_limits)
    ? source.password_rate_limits
    : [];
  source.sms_codes = Array.isArray(source.sms_codes) ? source.sms_codes : [];
  source.sms_rate_limits = Array.isArray(source.sms_rate_limits)
    ? source.sms_rate_limits
    : [];
  source.account_deletion_requests = Array.isArray(
    source.account_deletion_requests
  ) ? source.account_deletion_requests : [];
  source.email_bindings = Array.isArray(source.email_bindings) ? source.email_bindings : [];
  source.email_codes = Array.isArray(source.email_codes) ? source.email_codes : [];
  source.users = Array.isArray(source.users) ? source.users : [];
  source.auth_control = Array.isArray(source.auth_control)
    ? source.auth_control
    : [{
      _id: 'main',
      maintenance: false,
      schemaVersion: 2,
      minClientProtocol: 2
    }];
  return source;
}

function snapshot(state) {
  return clone({
    accounts: state.accounts,
    account_names: state.account_names,
    phone_bindings: state.phone_bindings,
    wechat_bindings: state.wechat_bindings,
    auth_sessions: state.auth_sessions,
    auth_proofs: state.auth_proofs,
    password_rate_limits: state.password_rate_limits,
    sms_codes: state.sms_codes,
    sms_rate_limits: state.sms_rate_limits,
    account_deletion_requests: state.account_deletion_requests,
    email_bindings: state.email_bindings,
    email_codes: state.email_codes,
    users: state.users
  });
}

function findById(collection, id) {
  return collection.find((item) => item._id === id);
}

function findAccount(state, account) {
  const normalized = String(account || '').trim().toLowerCase();
  return state.accounts.find((item) => item.accountNormalized === normalized);
}

function findBinding(state, openid) {
  return findById(state.wechat_bindings, sha256(`wechat:${openid}`));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

async function atTime(nowMs, callback) {
  const originalNow = Date.now;
  Date.now = () => nowMs;
  try {
    return await callback();
  } finally {
    Date.now = originalNow;
  }
}

async function createSentSmsChallenge({
  openid,
  phone,
  purpose,
  clientInstanceId,
  accountId,
  sessionId,
  code,
  nowMs
}) {
  const keyring = loadKeyring(process.env);
  const identity = wechatIdentity({
    APPID: 'wx-test-app',
    OPENID: openid
  });
  const scope = {
    purpose,
    clientInstanceId,
    wechatBindingInput: identity.bindingInput,
    accountId: accountId || '',
    sessionId: sessionId || ''
  };
  const now = new Date(nowMs);
  const claim = await fakeDb.runTransaction((transaction) => (
    claimSmsChallenge({
      transaction,
      phone,
      purpose,
      scope,
      wxIdentity: identity,
      now,
      keyring
    })
  ));
  const finalized = await fakeDb.runTransaction((transaction) => (
    finalizeSmsSend({
      transaction,
      claim,
      providerResult: { status: 'sent', code },
      now,
      keyring
    })
  ));
  assert.strictEqual(finalized.ok, true);
  return claim.challengeId;
}

async function testAccountCoreIntegrity() {
  const originalActive = process.env.CUETRACE_AUTH_KEY_ACTIVE_VERSION;
  const originalHistorical =
    process.env.CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS;
  const originalK1 = process.env.CUETRACE_AUTH_KEY_K1;
  process.env.CUETRACE_AUTH_KEY_K1 = Buffer.alloc(32, 0x31)
    .toString('base64');
  try {
    process.env.CUETRACE_AUTH_KEY_ACTIVE_VERSION = 'K1';
    process.env.CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS = '';
    const historicalKeyring = loadKeyring(process.env);
    const normalizedPhone = '+8613900139000';
    const historicalCandidate = candidateHmacIds(
      historicalKeyring,
      'phone-binding',
      normalizedPhone,
      'phone'
    )[0];
    const accountId = `acct_${'A'.repeat(22)}`;
    const createdAt = new Date(BASE_MS - 10 * 24 * 60 * 60 * 1000);
    const verifiedAt = new Date(BASE_MS - 5 * 24 * 60 * 60 * 1000);
    const passwordRecord = hashPassword('rotation-password');
    const baseSeed = {
      accounts: [{
        _id: accountId,
        status: 'active',
        accountNameBindingId: '',
        phoneBindingId: historicalCandidate.id,
        wechatBindingId: '',
        emailBindingId: '',
        ...passwordRecord,
        authVersion: 1,
        termsAcceptedAt: clone(createdAt),
        termsVersion: TERMS_VERSION,
        privacyAcceptedAt: clone(createdAt),
        privacyVersion: PRIVACY_VERSION,
        createdAt: clone(createdAt),
        updatedAt: clone(createdAt)
      }],
      phone_bindings: [{
        _id: historicalCandidate.id,
        accountId,
        keyVersion: 'K1',
        phoneMasked: '139****9000',
        status: 'active',
        verifiedAt: clone(verifiedAt),
        createdAt: clone(createdAt),
        updatedAt: clone(verifiedAt)
      }],
      users: [{
        _id: accountId,
        roles: ['member'],
        currentRole: 'member',
        role: 'member',
        nickname: '',
        avatar: '',
        createdAt: clone(createdAt),
        updatedAt: clone(createdAt)
      }]
    };

    process.env.CUETRACE_AUTH_KEY_ACTIVE_VERSION = 'K2';
    process.env.CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS = 'K1';
    const rotatedKeyring = loadKeyring(process.env);
    const activeCandidate = candidateHmacIds(
      rotatedKeyring,
      'phone-binding',
      normalizedPhone,
      'phone'
    )[0];

    const conflictState = makeState(clone(baseSeed));
    conflictState.phone_bindings.push({
      _id: activeCandidate.id,
      accountId,
      keyVersion: 'K2',
      phoneMasked: '139****9000',
      status: 'active',
      verifiedAt: clone(verifiedAt),
      createdAt: clone(createdAt),
      updatedAt: clone(verifiedAt)
    });
    const conflictBefore = snapshot(conflictState);
    const conflict = await atTime(BASE_MS, () => (
      loadAccountAuth('rotation-conflict-openid', conflictState).main({
        authProtocol: 2,
        action: 'loginPassword',
        clientInstanceId: 'rotation-conflict-client',
        identifier: '13900139000',
        password: 'rotation-password',
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION
      })
    ));
    assert.strictEqual(conflict.code, 'AUTH_CONFLICT');
    assert.deepStrictEqual(snapshot(conflictState), conflictBefore);

    const crossedState = makeState(clone(baseSeed));
    crossedState.phone_bindings.push({
      _id: activeCandidate.id,
      accountId: `acct_${'B'.repeat(22)}`,
      keyVersion: 'K2',
      phoneMasked: '139****9000',
      status: 'revoked',
      verifiedAt: clone(verifiedAt),
      createdAt: clone(createdAt),
      updatedAt: clone(verifiedAt),
      revokeReason: 'key_rotated',
      revokedAt: clone(verifiedAt)
    });
    const crossed = await atTime(BASE_MS, () => (
      loadAccountAuth('rotation-crossed-openid', crossedState).main({
        authProtocol: 2,
        action: 'loginPassword',
        clientInstanceId: 'rotation-crossed-client',
        identifier: '13900139000',
        password: 'rotation-password',
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION
      })
    ));
    assert.strictEqual(crossed.code, 'AUTH_CONFLICT');

    const maskState = makeState(clone(baseSeed));
    maskState.phone_bindings[0].phoneMasked = '139****0000';
    const maskFailure = await atTime(BASE_MS, () => (
      loadAccountAuth('rotation-mask-openid', maskState).main({
        authProtocol: 2,
        action: 'loginPassword',
        clientInstanceId: 'rotation-mask-client',
        identifier: '13900139000',
        password: 'rotation-password',
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION
      })
    ));
    assert.strictEqual(maskFailure.code, 'AUTH_INTERNAL_ERROR');

    const rotationState = makeState(clone(baseSeed));
    const rotated = await atTime(BASE_MS, () => (
      loadAccountAuth('rotation-openid', rotationState).main({
        authProtocol: 2,
        action: 'loginPassword',
        clientInstanceId: 'rotation-client',
        identifier: '13900139000',
        password: 'rotation-password',
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION
      })
    ));
    assert.strictEqual(rotated.ok, true);
    assert.strictEqual(rotationState.accounts[0].phoneBindingId, activeCandidate.id);
    const active = findById(rotationState.phone_bindings, activeCandidate.id);
    const historical = findById(
      rotationState.phone_bindings,
      historicalCandidate.id
    );
    assert.strictEqual(active.status, 'active');
    assert.strictEqual(active.verifiedAt.getTime(), verifiedAt.getTime());
    assert.strictEqual(active.createdAt.getTime(), createdAt.getTime());
    assert.strictEqual(historical.status, 'revoked');
    assert.strictEqual(historical.revokeReason, 'key_rotated');
  } finally {
    process.env.CUETRACE_AUTH_KEY_ACTIVE_VERSION = originalActive;
    process.env.CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS = originalHistorical;
    if (originalK1 === undefined) delete process.env.CUETRACE_AUTH_KEY_K1;
    else process.env.CUETRACE_AUTH_KEY_K1 = originalK1;
  }
}

async function testSmsChallengeIntegrity() {
  const loginState = makeState();
  const loginOpenid = 'sms-mask-integrity-openid';
  const loginClient = 'sms-mask-integrity-client';
  const loginAt = BASE_MS + 30 * 1000;
  const loginEntry = loadAccountAuth(loginOpenid, loginState);
  const loginChallenge = await createSentSmsChallenge({
    openid: loginOpenid,
    phone: '+8613000130000',
    purpose: 'login',
    clientInstanceId: loginClient,
    code: '123321',
    nowMs: loginAt
  });
  assert.strictEqual(loginState.sms_codes.length, 1);
  loginState.sms_codes[0].phoneMasked = '130****9999';
  const loginBefore = snapshot(loginState);
  const loginResult = await atTime(loginAt + 1, () => loginEntry.main({
    authProtocol: 2,
    action: 'loginSms',
    clientInstanceId: loginClient,
    phone: '13000130000',
    challengeId: loginChallenge,
    code: '123321',
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION
  }));
  assert.strictEqual(loginResult.code, 'AUTH_INTERNAL_ERROR');
  assert.deepStrictEqual(snapshot(loginState), loginBefore);

  const proofState = makeState();
  const proofOpenid = 'proof-mask-integrity-openid';
  const proofClient = 'proof-mask-integrity-client';
  const proofAt = loginAt + 60 * 1000;
  const proofEntry = loadAccountAuth(proofOpenid, proofState);
  const proofChallenge = await createSentSmsChallenge({
    openid: proofOpenid,
    phone: '+8613100131000',
    purpose: 'wechat_entry',
    clientInstanceId: proofClient,
    code: '456654',
    nowMs: proofAt
  });
  assert.strictEqual(proofState.sms_codes.length, 1);
  proofState.sms_codes[0].phoneMasked = '131****9999';
  const proofBefore = snapshot(proofState);
  const proofResult = await atTime(proofAt + 1, () => proofEntry.main({
    authProtocol: 2,
    action: 'verifyWechatEntryPhone',
    clientInstanceId: proofClient,
    phone: '13100131000',
    challengeId: proofChallenge,
    code: '456654',
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION
  }));
  assert.strictEqual(proofResult.code, 'AUTH_INTERNAL_ERROR');
  assert.deepStrictEqual(snapshot(proofState), proofBefore);

  const originalActive = process.env.CUETRACE_AUTH_KEY_ACTIVE_VERSION;
  const originalHistorical =
    process.env.CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS;
  const originalK1 = process.env.CUETRACE_AUTH_KEY_K1;
  process.env.CUETRACE_AUTH_KEY_K1 = Buffer.alloc(32, 0x61)
    .toString('base64');
  try {
    process.env.CUETRACE_AUTH_KEY_ACTIVE_VERSION = 'K1';
    process.env.CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS = '';
    const rotationState = makeState();
    const rotationOpenid = 'proof-challenge-rotation-openid';
    const rotationClient = 'proof-challenge-rotation-client';
    const rotationAt = proofAt + 60 * 1000;
    loadAccountAuth(rotationOpenid, rotationState);
    const rotationChallenge = await createSentSmsChallenge({
      openid: rotationOpenid,
      phone: '+8613200132000',
      purpose: 'wechat_entry',
      clientInstanceId: rotationClient,
      code: '789987',
      nowMs: rotationAt
    });

    process.env.CUETRACE_AUTH_KEY_ACTIVE_VERSION = 'K2';
    process.env.CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS = 'K1';
    const rotatedEntry = loadAccountAuth(rotationOpenid, rotationState);
    const rotatedProof = await atTime(rotationAt + 1, () => (
      rotatedEntry.main({
        authProtocol: 2,
        action: 'verifyWechatEntryPhone',
        clientInstanceId: rotationClient,
        phone: '13200132000',
        challengeId: rotationChallenge,
        code: '789987',
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION
      })
    ));
    assert.strictEqual(rotatedProof.ok, true);
    const rotatedRecord = rotationState.auth_proofs[0];
    const expectedCandidates = candidateHmacIds(
      loadKeyring(process.env),
      'phone-binding',
      '+8613200132000',
      'phone'
    );
    assert.deepStrictEqual(
      rotatedRecord.phoneBindingCandidateIds,
      expectedCandidates.map((candidate) => candidate.id)
    );
    assert.strictEqual(
      rotatedRecord.phoneBindingId,
      expectedCandidates[0].id,
      'proof phone binding ID must use the issue-time active candidate'
    );
    const completed = await atTime(rotationAt + 2, () => (
      rotatedEntry.main({
        authProtocol: 2,
        action: 'completeWechatEntry',
        clientInstanceId: rotationClient,
        proofToken: rotatedProof.proofToken,
        bindWechat: false,
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION
      })
    ));
    assert.strictEqual(completed.ok, true);
    assert.strictEqual(completed.authenticationMethod, 'sms');
  } finally {
    process.env.CUETRACE_AUTH_KEY_ACTIVE_VERSION = originalActive;
    process.env.CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS = originalHistorical;
    if (originalK1 === undefined) delete process.env.CUETRACE_AUTH_KEY_K1;
    else process.env.CUETRACE_AUTH_KEY_K1 = originalK1;
  }
}

async function passwordLoginAttempt({
  state,
  openid,
  clientInstanceId,
  identifier,
  password,
  nowMs
}) {
  const entry = loadAccountAuth(openid, state);
  return atTime(nowMs, () => entry.main({
    authProtocol: 2,
    action: 'loginPassword',
    clientInstanceId,
    identifier,
    password,
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION
  }));
}

async function testPasswordRateDimensions() {
  const pairState = makeState();
  const pairAt = BASE_MS + 40 * 60 * 1000;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await passwordLoginAttempt({
      state: pairState,
      openid: 'rate-pair-openid',
      clientInstanceId: 'rate-pair-client',
      identifier: 'PairRate',
      password: 'wrong-password',
      nowMs: pairAt + attempt
    });
    assert.strictEqual(
      result.code,
      attempt === 4 ? 'PASSWORD_RATE_LIMITED' : 'INVALID_CREDENTIALS'
    );
  }
  const pairBoundary = await passwordLoginAttempt({
    state: pairState,
    openid: 'rate-pair-openid',
    clientInstanceId: 'rate-pair-client',
    identifier: 'PairRate',
    password: 'wrong-password',
    nowMs: pairAt + 4 + 15 * 60 * 1000
  });
  assert.strictEqual(
    pairBoundary.code,
    'INVALID_CREDENTIALS',
    'pair block must expire at the exact 15-minute boundary'
  );

  const wechatState = makeState();
  const wechatAt = pairAt + 20 * 60 * 1000;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await passwordLoginAttempt({
      state: wechatState,
      openid: 'rate-wechat-openid',
      clientInstanceId: 'rate-wechat-client',
      identifier: `WxRate${String(attempt).padStart(2, '0')}`,
      password: 'wrong-password',
      nowMs: wechatAt + attempt
    });
    assert.strictEqual(
      result.code,
      attempt === 19 ? 'PASSWORD_RATE_LIMITED' : 'INVALID_CREDENTIALS'
    );
  }
  const wechatBlocked = await passwordLoginAttempt({
    state: wechatState,
    openid: 'rate-wechat-openid',
    clientInstanceId: 'rate-wechat-client',
    identifier: 'WxRateNext',
    password: 'wrong-password',
    nowMs: wechatAt + 20
  });
  assert.strictEqual(wechatBlocked.code, 'PASSWORD_RATE_LIMITED');
  const wechatBoundary = await passwordLoginAttempt({
    state: wechatState,
    openid: 'rate-wechat-openid',
    clientInstanceId: 'rate-wechat-client',
    identifier: 'WxRateAfter',
    password: 'wrong-password',
    nowMs: wechatAt + 19 + 15 * 60 * 1000
  });
  assert.strictEqual(
    wechatBoundary.code,
    'INVALID_CREDENTIALS',
    'WeChat-context block must expire at the exact 15-minute boundary'
  );

  const identifierState = makeState();
  const identifierAt = wechatAt + 20 * 60 * 1000;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await passwordLoginAttempt({
      state: identifierState,
      openid: `rate-identifier-openid-${attempt}`,
      clientInstanceId: `rate-identifier-client-${attempt}`,
      identifier: 'AcrossContexts',
      password: 'wrong-password',
      nowMs: identifierAt + attempt
    });
    assert.strictEqual(
      result.code,
      attempt === 29 ? 'PASSWORD_RATE_LIMITED' : 'INVALID_CREDENTIALS'
    );
  }
  const identifierBlocked = await passwordLoginAttempt({
    state: identifierState,
    openid: 'rate-identifier-openid-blocked',
    clientInstanceId: 'rate-identifier-client-blocked',
    identifier: 'AcrossContexts',
    password: 'wrong-password',
    nowMs: identifierAt + 30
  });
  assert.strictEqual(identifierBlocked.code, 'PASSWORD_RATE_LIMITED');
  const identifierBoundary = await passwordLoginAttempt({
    state: identifierState,
    openid: 'rate-identifier-openid-boundary',
    clientInstanceId: 'rate-identifier-client-boundary',
    identifier: 'AcrossContexts',
    password: 'wrong-password',
    nowMs: identifierAt + 24 * 60 * 60 * 1000
  });
  assert.strictEqual(
    identifierBoundary.code,
    'INVALID_CREDENTIALS',
    'identifier window must reset at the exact 24-hour boundary'
  );

  const successState = makeState();
  const successOpenid = 'rate-success-openid';
  const successClient = 'rate-success-client';
  const successAt = identifierAt + 25 * 60 * 60 * 1000;
  const successEntry = loadAccountAuth(successOpenid, successState);
  const registered = await atTime(successAt, () => successEntry.main({
    authProtocol: 2,
    action: 'registerAccountName',
    clientInstanceId: successClient,
    accountName: 'RateSuccess',
    password: 'rate-success-password',
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION
  }));
  assert.strictEqual(registered.ok, true);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const failed = await passwordLoginAttempt({
      state: successState,
      openid: successOpenid,
      clientInstanceId: successClient,
      identifier: 'RateSuccess',
      password: 'wrong-password',
      nowMs: successAt + 1 + attempt
    });
    assert.strictEqual(failed.code, 'INVALID_CREDENTIALS');
  }
  const succeeded = await passwordLoginAttempt({
    state: successState,
    openid: successOpenid,
    clientInstanceId: successClient,
    identifier: 'RateSuccess',
    password: 'rate-success-password',
    nowMs: successAt + 3
  });
  assert.strictEqual(succeeded.ok, true);
  const successRates = Object.fromEntries(
    successState.password_rate_limits.map((record) => [
      record.dimension,
      record.failureCount
    ])
  );
  assert.deepStrictEqual(successRates, {
    identifier_wechat: 0,
    wechat: 2,
    identifier: 2
  });

  const originalActive = process.env.CUETRACE_AUTH_KEY_ACTIVE_VERSION;
  const originalHistorical =
    process.env.CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS;
  const originalK1 = process.env.CUETRACE_AUTH_KEY_K1;
  process.env.CUETRACE_AUTH_KEY_K1 = Buffer.alloc(32, 0x63)
    .toString('base64');
  try {
    process.env.CUETRACE_AUTH_KEY_ACTIVE_VERSION = 'K1';
    process.env.CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS = '';
    const historicalState = makeState();
    const historicalAt = successAt + 60 * 1000;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failed = await passwordLoginAttempt({
        state: historicalState,
        openid: 'rate-history-openid',
        clientInstanceId: 'rate-history-client',
        identifier: 'HistoryRate',
        password: 'wrong-password',
        nowMs: historicalAt + attempt
      });
      assert.strictEqual(failed.code, 'INVALID_CREDENTIALS');
    }
    assert.strictEqual(historicalState.password_rate_limits.length, 3);

    process.env.CUETRACE_AUTH_KEY_ACTIVE_VERSION = 'K2';
    process.env.CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS = 'K1';
    const merged = await passwordLoginAttempt({
      state: historicalState,
      openid: 'rate-history-openid',
      clientInstanceId: 'rate-history-client',
      identifier: 'HistoryRate',
      password: 'wrong-password',
      nowMs: historicalAt + 3
    });
    assert.strictEqual(merged.code, 'INVALID_CREDENTIALS');
    assert.strictEqual(historicalState.password_rate_limits.length, 6);
    for (const dimension of [
      'identifier_wechat',
      'wechat',
      'identifier'
    ]) {
      const records = historicalState.password_rate_limits.filter(
        (record) => record.dimension === dimension
      );
      assert.strictEqual(records.length, 2);
      assert(records.every((record) => record.failureCount === 4));
      assert.strictEqual(
        records[0].windowStartedAt.getTime(),
        records[1].windowStartedAt.getTime()
      );
    }
    const historicalLimited = await passwordLoginAttempt({
      state: historicalState,
      openid: 'rate-history-openid',
      clientInstanceId: 'rate-history-client',
      identifier: 'HistoryRate',
      password: 'wrong-password',
      nowMs: historicalAt + 4
    });
    assert.strictEqual(historicalLimited.code, 'PASSWORD_RATE_LIMITED');
    for (const dimension of [
      'identifier_wechat',
      'wechat',
      'identifier'
    ]) {
      const records = historicalState.password_rate_limits.filter(
        (record) => record.dimension === dimension
      );
      assert(records.every((record) => record.failureCount === 5));
      if (dimension === 'identifier_wechat') {
        assert(records.every((record) => record.blockedUntil instanceof Date));
        assert.strictEqual(
          records[0].blockedUntil.getTime(),
          records[1].blockedUntil.getTime()
        );
      } else {
        assert(records.every((record) => record.blockedUntil === null));
      }
    }
  } finally {
    process.env.CUETRACE_AUTH_KEY_ACTIVE_VERSION = originalActive;
    process.env.CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS = originalHistorical;
    if (originalK1 === undefined) delete process.env.CUETRACE_AUTH_KEY_K1;
    else process.env.CUETRACE_AUTH_KEY_K1 = originalK1;
  }
}

function markDeletionPending(state, accountId, nowMs) {
  const requestedAt = nowMs - 1000;
  const scheduledAt = nowMs + 7 * 24 * 60 * 60 * 1000;
  const user = findById(state.users, accountId);
  Object.assign(user, {
    deletionStatus: 'pending',
    deletionReason: 'test',
    deletionRequestedAt: requestedAt,
    deletionScheduledAt: scheduledAt
  });
  state.account_deletion_requests.push({
    _id: accountId,
    accountId,
    deletionStatus: 'pending',
    deletionRequestedAt: requestedAt,
    deletionScheduledAt: scheduledAt,
    createdAt: new Date(requestedAt),
    updatedAt: new Date(requestedAt)
  });
}

async function testDeletionGraceCancellation() {
  const loginState = makeState();
  const loginEntry = loadAccountAuth(
    'deletion-cancel-login-openid',
    loginState
  );
  const loginAt = BASE_MS + 70 * 60 * 1000;
  const registered = await atTime(loginAt, () => loginEntry.main({
    authProtocol: 2,
    action: 'registerAccountName',
    clientInstanceId: 'deletion-cancel-register-client',
    accountName: 'DeletionCancel',
    password: 'deletion-cancel-password',
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION
  }));
  assert.strictEqual(registered.ok, true);
  const accountId = loginState.accounts[0]._id;
  markDeletionPending(loginState, accountId, loginAt + 1);
  const restored = await atTime(loginAt + 1, () => loginEntry.main({
    authProtocol: 2,
    action: 'loginPassword',
    clientInstanceId: 'deletion-cancel-login-client',
    identifier: 'DeletionCancel',
    password: 'deletion-cancel-password',
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION
  }));
  assert.strictEqual(restored.ok, true);
  assert.strictEqual(
    loginState.account_deletion_requests[0].deletionStatus,
    'canceled'
  );
  assert(
    loginState.account_deletion_requests[0].deletionCanceledAt instanceof Date
  );
  const restoredUser = findById(loginState.users, accountId);
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(restoredUser, 'deletionStatus'),
    false
  );
  assert(restoredUser.deletionCanceledAt instanceof Date);

  for (const [index, action] of [
    'setPassword',
    'logoutOthers'
  ].entries()) {
    const rotationState = makeState();
    const rotationEntry = loadAccountAuth(
      `deletion-cancel-${action}-openid`,
      rotationState
    );
    const rotationAt = loginAt + (index + 1) * 30 * 1000;
    const rotationRegistered = await atTime(
      rotationAt,
      () => rotationEntry.main({
        authProtocol: 2,
        action: 'registerAccountName',
        clientInstanceId: `deletion-cancel-${action}-client`,
        accountName: `Cancel${action}`,
        password: 'deletion-rotation-password',
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION
      })
    );
    assert.strictEqual(rotationRegistered.ok, true);
    const rotationAccountId = rotationState.accounts[0]._id;
    markDeletionPending(
      rotationState,
      rotationAccountId,
      rotationAt + 1
    );
    const rotated = await atTime(rotationAt + 1, () => (
      rotationEntry.main({
        authProtocol: 2,
        action,
        clientInstanceId: `deletion-cancel-${action}-client`,
        sessionToken: rotationRegistered.sessionToken,
        ...(action === 'setPassword'
          ? { password: 'replacement-rotation-password' }
          : {})
      })
    ));
    assert.strictEqual(rotated.ok, true);
    assert.strictEqual(rotated.kind, 'session_rotated');
    assert.strictEqual(
      rotationState.account_deletion_requests[0].deletionStatus,
      'canceled'
    );
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(
        rotationState.users[0],
        'deletionStatus'
      ),
      false
    );
  }

  const rollbackState = makeState();
  const rollbackEntry = loadAccountAuth(
    'deletion-cancel-rollback-openid',
    rollbackState
  );
  const rollbackAt = loginAt + 60 * 1000;
  const rollbackRegistered = await atTime(
    rollbackAt,
    () => rollbackEntry.main({
      authProtocol: 2,
      action: 'registerAccountName',
      clientInstanceId: 'deletion-cancel-rollback-client',
      accountName: 'DeletionRollback',
      password: 'deletion-rollback-password',
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION
    })
  );
  assert.strictEqual(rollbackRegistered.ok, true);
  const rollbackAccountId = rollbackState.accounts[0]._id;
  markDeletionPending(rollbackState, rollbackAccountId, rollbackAt + 1);
  rollbackState.account_names[0].account = 'CorruptedDisplay';
  const rollbackBefore = snapshot(rollbackState);
  const rolledBack = await atTime(rollbackAt + 1, () => (
    rollbackEntry.main({
      authProtocol: 2,
      action: 'logoutOthers',
      clientInstanceId: 'deletion-cancel-rollback-client',
      sessionToken: rollbackRegistered.sessionToken
    })
  ));
  assert.strictEqual(rolledBack.code, 'AUTH_INTERNAL_ERROR');
  assert.deepStrictEqual(snapshot(rollbackState), rollbackBefore);
}

async function testWechatEntryFlow() {
  const state = makeState();
  const openid = 'wechat-entry-openid';
  const clientInstanceId = 'wechat-entry-client';
  const entry = loadAccountAuth(openid, state);
  const unboundOperationStart = fakeDb.__operations.length;
  const unbound = await atTime(BASE_MS, () => entry.main({
    authProtocol: 2,
    action: 'loginWechat',
    clientInstanceId,
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION
  }));
  assert.deepStrictEqual(unbound, {
    ok: false,
    code: 'WECHAT_NOT_BOUND',
    msg: '当前微信尚未绑定账号',
    next: 'wechat_phone'
  });
  assert(
    fakeDb.__operations.slice(unboundOperationStart).every((operation) => (
      !['set', 'update'].includes(operation.operation)
    )),
    'unbound WeChat login must perform zero account/session writes'
  );

  const proofAt = BASE_MS + 60 * 1000;
  const phone = '13700137000';
  const normalizedPhone = '+8613700137000';
  const challengeId = await createSentSmsChallenge({
    openid,
    phone: normalizedPhone,
    purpose: 'wechat_entry',
    clientInstanceId,
    code: '778899',
    nowMs: proofAt
  });
  const proof = await atTime(proofAt + 1, () => entry.main({
    authProtocol: 2,
    action: 'verifyWechatEntryPhone',
    clientInstanceId,
    phone,
    challengeId,
    code: '778899',
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION
  }));
  assert.strictEqual(proof.ok, true);
  assert.strictEqual(proof.kind, 'wechat_phone_proof');
  assert.strictEqual(proof.expiresIn, 300);
  assert(/^v2\.K2\.[A-Za-z0-9_-]{43}$/.test(proof.proofToken));
  assert.strictEqual(state.auth_proofs.length, 1);
  const proofRecord = state.auth_proofs[0];
  assert(/^auth-proof\.K2\.[A-Za-z0-9_-]{43}$/.test(proofRecord._id));
  assert.strictEqual(proofRecord.purpose, 'wechat_entry');
  assert.deepStrictEqual(
    proofRecord.phoneBindingCandidateIds,
    [proofRecord.phoneBindingId],
    'proof must bind the complete active-to-historical phone candidate set'
  );
  assert.strictEqual(proofRecord.used, false);
  assert.strictEqual(
    proofRecord.expiresAt.getTime(),
    proofAt + 1 + 300 * 1000
  );
  assert.strictEqual(
    JSON.stringify(proofRecord).includes(proof.proofToken),
    false
  );
  assert.strictEqual(JSON.stringify(proofRecord).includes(phone), false);
  assert.strictEqual(JSON.stringify(proofRecord).includes(openid), false);

  const wrongClientBefore = snapshot(state);
  const wrongClient = await atTime(proofAt + 2, () => entry.main({
    authProtocol: 2,
    action: 'completeWechatEntry',
    clientInstanceId: 'different-proof-client',
    proofToken: proof.proofToken,
    bindWechat: false,
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION
  }));
  assert.strictEqual(wrongClient.code, 'AUTH_CONFLICT');
  assert.deepStrictEqual(snapshot(state), wrongClientBefore);

  const originalCandidateIds = [...proofRecord.phoneBindingCandidateIds];
  proofRecord.phoneBindingCandidateIds = [
    proofRecord.phoneBindingId,
    `phone.K1.${'T'.repeat(43)}`
  ];
  const tamperedCandidateBefore = snapshot(state);
  const tamperedCandidates = await atTime(proofAt + 2, () => entry.main({
    authProtocol: 2,
    action: 'completeWechatEntry',
    clientInstanceId,
    proofToken: proof.proofToken,
    bindWechat: false,
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION
  }));
  assert.strictEqual(tamperedCandidates.code, 'AUTH_CONFLICT');
  assert.deepStrictEqual(snapshot(state), tamperedCandidateBefore);
  proofRecord.phoneBindingCandidateIds = originalCandidateIds;

  proofRecord.termsVersion = 'tampered-terms';
  const tamperedConsentBefore = snapshot(state);
  const tamperedConsent = await atTime(proofAt + 2, () => entry.main({
    authProtocol: 2,
    action: 'completeWechatEntry',
    clientInstanceId,
    proofToken: proof.proofToken,
    bindWechat: false,
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION
  }));
  assert.strictEqual(tamperedConsent.code, 'AUTH_CONFLICT');
  assert.deepStrictEqual(snapshot(state), tamperedConsentBefore);
  proofRecord.termsVersion = TERMS_VERSION;

  const cancelOperationStart = fakeDb.__operations.length;
  const canceled = await atTime(proofAt + 2, () => entry.main({
    authProtocol: 2,
    action: 'completeWechatEntry',
    clientInstanceId,
    proofToken: proof.proofToken,
    bindWechat: false,
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION
  }));
  assert.strictEqual(canceled.ok, true);
  assert.strictEqual(canceled.authenticationMethod, 'sms');
  assert.strictEqual(canceled.accountDisplay, '137****7000');
  assert.strictEqual(state.accounts.length, 1);
  assert.strictEqual(state.phone_bindings.length, 1);
  assert.strictEqual(state.wechat_bindings.length, 0);
  assert.strictEqual(state.auth_proofs[0].used, true);
  assert(
    fakeDb.__operations.slice(cancelOperationStart).every((operation) => (
      operation.collection !== 'wechat_bindings'
    )),
    'canceling WeChat binding must not access WeChat bindings'
  );

  const replayBefore = snapshot(state);
  const replay = await atTime(proofAt + 3, () => entry.main({
    authProtocol: 2,
    action: 'completeWechatEntry',
    clientInstanceId,
    proofToken: proof.proofToken,
    bindWechat: false,
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION
  }));
  assert.strictEqual(replay.code, 'AUTH_CONFLICT');
  assert.deepStrictEqual(snapshot(state), replayBefore);

  const confirmOpenid = 'wechat-confirm-openid';
  const confirmClient = 'wechat-confirm-client';
  const confirmEntry = loadAccountAuth(confirmOpenid, state);
  const confirmAt = proofAt + 61 * 1000;
  const confirmChallenge = await createSentSmsChallenge({
    openid: confirmOpenid,
    phone: '+8613600136000',
    purpose: 'wechat_entry',
    clientInstanceId: confirmClient,
    code: '224466',
    nowMs: confirmAt
  });
  const confirmProof = await atTime(confirmAt + 1, () => (
    confirmEntry.main({
      authProtocol: 2,
      action: 'verifyWechatEntryPhone',
      clientInstanceId: confirmClient,
      phone: '13600136000',
      challengeId: confirmChallenge,
      code: '224466',
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION
    })
  ));
  const confirmed = await atTime(confirmAt + 2, () => (
    confirmEntry.main({
      authProtocol: 2,
      action: 'completeWechatEntry',
      clientInstanceId: confirmClient,
      proofToken: confirmProof.proofToken,
      bindWechat: true,
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION
    })
  ));
  assert.strictEqual(confirmed.ok, true);
  assert.strictEqual(confirmed.authenticationMethod, 'sms');
  assert.strictEqual(state.wechat_bindings.length, 1);
  const wechatBinding = state.wechat_bindings[0];
  const confirmedAccount = findById(state.accounts, wechatBinding.accountId);
  assert.strictEqual(confirmedAccount.wechatBindingId, wechatBinding._id);
  assert.strictEqual(wechatBinding.unionidHash, '');
  assert.strictEqual(JSON.stringify(wechatBinding).includes(confirmOpenid), false);

  const directEntry = loadAccountAuth(confirmOpenid, state);
  const direct = await atTime(confirmAt + 3, () => directEntry.main({
    authProtocol: 2,
    action: 'loginWechat',
    clientInstanceId: 'wechat-direct-client',
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION
  }));
  assert.strictEqual(direct.ok, true);
  assert.strictEqual(direct.authenticationMethod, 'wechat');

  const unionEntry = loadAccountAuth(
    confirmOpenid,
    state,
    'trusted-union-one'
  );
  const unionFilled = await atTime(confirmAt + 4, () => unionEntry.main({
    authProtocol: 2,
    action: 'loginWechat',
    clientInstanceId: 'wechat-union-client',
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION
  }));
  assert.strictEqual(unionFilled.ok, true);
  const filledUnionHash = state.wechat_bindings[0].unionidHash;
  assert(filledUnionHash);

  const mismatchBefore = snapshot(state);
  const mismatchEntry = loadAccountAuth(
    confirmOpenid,
    state,
    'trusted-union-two'
  );
  const mismatch = await atTime(confirmAt + 5, () => mismatchEntry.main({
    authProtocol: 2,
    action: 'loginWechat',
    clientInstanceId: 'wechat-union-client-2',
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION
  }));
  assert.strictEqual(mismatch.code, 'WECHAT_IDENTITY_CONFLICT');
  assert.deepStrictEqual(snapshot(state), mismatchBefore);
  assert.strictEqual(state.wechat_bindings[0].unionidHash, filledUnionHash);

  const expiryState = makeState();
  const expiryOpenid = 'wechat-expiry-openid';
  const expiryEntry = loadAccountAuth(expiryOpenid, expiryState);
  const expiryAt = BASE_MS + 5 * 60 * 1000;
  const expiryChallenge = await createSentSmsChallenge({
    openid: expiryOpenid,
    phone: '+8613500135000',
    purpose: 'wechat_entry',
    clientInstanceId: 'wechat-expiry-client',
    code: '113355',
    nowMs: expiryAt
  });
  const expiryProof = await atTime(expiryAt + 1, () => expiryEntry.main({
    authProtocol: 2,
    action: 'verifyWechatEntryPhone',
    clientInstanceId: 'wechat-expiry-client',
    phone: '13500135000',
    challengeId: expiryChallenge,
    code: '113355',
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION
  }));
  const expiryBefore = snapshot(expiryState);
  const expired = await atTime(
    expiryAt + 1 + 300 * 1000,
    () => expiryEntry.main({
      authProtocol: 2,
      action: 'completeWechatEntry',
      clientInstanceId: 'wechat-expiry-client',
      proofToken: expiryProof.proofToken,
      bindWechat: true,
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION
    })
  );
  assert.strictEqual(expired.code, 'AUTH_CONFLICT');
  assert.deepStrictEqual(snapshot(expiryState), expiryBefore);

  const contextState = makeState();
  const contextEntry = loadAccountAuth('wechat-context-one', contextState);
  const contextAt = BASE_MS + 10 * 60 * 1000;
  const contextChallenge = await createSentSmsChallenge({
    openid: 'wechat-context-one',
    phone: '+8613400134000',
    purpose: 'wechat_entry',
    clientInstanceId: 'wechat-context-client',
    code: '991122',
    nowMs: contextAt
  });
  const contextProof = await atTime(contextAt + 1, () => (
    contextEntry.main({
      authProtocol: 2,
      action: 'verifyWechatEntryPhone',
      clientInstanceId: 'wechat-context-client',
      phone: '13400134000',
      challengeId: contextChallenge,
      code: '991122',
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION
    })
  ));
  const contextBefore = snapshot(contextState);
  const otherContextEntry = loadAccountAuth(
    'wechat-context-two',
    contextState
  );
  const contextMismatch = await atTime(contextAt + 2, () => (
    otherContextEntry.main({
      authProtocol: 2,
      action: 'completeWechatEntry',
      clientInstanceId: 'wechat-context-client',
      proofToken: contextProof.proofToken,
      bindWechat: true,
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION
    })
  ));
  assert.strictEqual(contextMismatch.code, 'AUTH_CONFLICT');
  assert.deepStrictEqual(snapshot(contextState), contextBefore);

  const originalActive = process.env.CUETRACE_AUTH_KEY_ACTIVE_VERSION;
  const originalHistorical =
    process.env.CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS;
  const originalK1 = process.env.CUETRACE_AUTH_KEY_K1;
  process.env.CUETRACE_AUTH_KEY_K1 = Buffer.alloc(32, 0x51)
    .toString('base64');
  try {
    process.env.CUETRACE_AUTH_KEY_ACTIVE_VERSION = 'K1';
    process.env.CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS = '';
    const rotatedProofState = makeState();
    const rotatedOpenid = 'wechat-rotated-proof-openid';
    const rotatedEntry = loadAccountAuth(rotatedOpenid, rotatedProofState);
    const rotatedAt = BASE_MS + 20 * 60 * 1000;
    const rotatedChallenge = await createSentSmsChallenge({
      openid: rotatedOpenid,
      phone: '+8613200132000',
      purpose: 'wechat_entry',
      clientInstanceId: 'wechat-rotated-proof-client',
      code: '336699',
      nowMs: rotatedAt
    });
    const rotatedProof = await atTime(rotatedAt + 1, () => (
      rotatedEntry.main({
        authProtocol: 2,
        action: 'verifyWechatEntryPhone',
        clientInstanceId: 'wechat-rotated-proof-client',
        phone: '13200132000',
        challengeId: rotatedChallenge,
        code: '336699',
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION
      })
    ));
    const rotatedBefore = snapshot(rotatedProofState);
    process.env.CUETRACE_AUTH_KEY_ACTIVE_VERSION = 'K2';
    process.env.CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS = 'K1';
    const afterRotationEntry = loadAccountAuth(
      rotatedOpenid,
      rotatedProofState
    );
    const stalePhoneKey = await atTime(rotatedAt + 2, () => (
      afterRotationEntry.main({
        authProtocol: 2,
        action: 'completeWechatEntry',
        clientInstanceId: 'wechat-rotated-proof-client',
        proofToken: rotatedProof.proofToken,
        bindWechat: true,
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION
      })
    ));
    assert.strictEqual(stalePhoneKey.code, 'AUTH_CONFLICT');
    assert.deepStrictEqual(snapshot(rotatedProofState), rotatedBefore);

    const lineageState = makeState();
    const lineageOpenid = 'wechat-lineage-proof-openid';
    const lineageEntry = loadAccountAuth(lineageOpenid, lineageState);
    const lineageAt = rotatedAt + 60 * 1000;
    const lineageChallenge = await createSentSmsChallenge({
      openid: lineageOpenid,
      phone: '+8613000130000',
      purpose: 'wechat_entry',
      clientInstanceId: 'wechat-lineage-client',
      code: '778811',
      nowMs: lineageAt
    });
    const lineageProof = await atTime(lineageAt + 1, () => (
      lineageEntry.main({
        authProtocol: 2,
        action: 'verifyWechatEntryPhone',
        clientInstanceId: 'wechat-lineage-client',
        phone: '13000130000',
        challengeId: lineageChallenge,
        code: '778811',
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION
      })
    ));
    const lineageBase = snapshot(lineageState);
    const candidateIds = lineageState.auth_proofs[0]
      .phoneBindingCandidateIds;
    assert.strictEqual(candidateIds.length, 2);
    const lineageAccountId = `acct_${'L'.repeat(22)}`;
    function addLineageAccount(target, bindingId) {
      const timestamp = new Date(lineageAt - 1000);
      target.accounts.push({
        _id: lineageAccountId,
        status: 'active',
        accountNameBindingId: '',
        phoneBindingId: bindingId,
        wechatBindingId: '',
        emailBindingId: '',
        passwordAlgorithm: '',
        passwordSalt: '',
        passwordHash: '',
        authVersion: 1,
        termsAcceptedAt: clone(timestamp),
        termsVersion: TERMS_VERSION,
        privacyAcceptedAt: clone(timestamp),
        privacyVersion: PRIVACY_VERSION,
        createdAt: clone(timestamp),
        updatedAt: clone(timestamp)
      });
      target.users.push({
        _id: lineageAccountId,
        roles: ['member'],
        currentRole: 'member',
        role: 'member',
        nickname: '',
        avatar: '',
        createdAt: clone(timestamp),
        updatedAt: clone(timestamp)
      });
      return timestamp;
    }

    const dualState = makeState(clone(lineageBase));
    const dualTimestamp = addLineageAccount(dualState, candidateIds[0]);
    dualState.phone_bindings.push(...candidateIds.map((id, index) => ({
      _id: id,
      accountId: lineageAccountId,
      keyVersion: index === 0 ? 'K2' : 'K1',
      phoneMasked: '130****0000',
      status: 'active',
      verifiedAt: clone(dualTimestamp),
      createdAt: clone(dualTimestamp),
      updatedAt: clone(dualTimestamp)
    })));
    const dualBefore = snapshot(dualState);
    const dualConflict = await atTime(lineageAt + 2, () => (
      loadAccountAuth(lineageOpenid, dualState).main({
        authProtocol: 2,
        action: 'completeWechatEntry',
        clientInstanceId: 'wechat-lineage-client',
        proofToken: lineageProof.proofToken,
        bindWechat: false,
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION
      })
    ));
    assert.strictEqual(dualConflict.code, 'AUTH_CONFLICT');
    assert.deepStrictEqual(snapshot(dualState), dualBefore);

    const crossedState = makeState(clone(lineageBase));
    const crossedTimestamp = addLineageAccount(
      crossedState,
      candidateIds[0]
    );
    crossedState.phone_bindings.push({
      _id: candidateIds[0],
      accountId: lineageAccountId,
      keyVersion: 'K2',
      phoneMasked: '130****0000',
      status: 'active',
      verifiedAt: clone(crossedTimestamp),
      createdAt: clone(crossedTimestamp),
      updatedAt: clone(crossedTimestamp)
    }, {
      _id: candidateIds[1],
      accountId: `acct_${'X'.repeat(22)}`,
      keyVersion: 'K1',
      phoneMasked: '130****0000',
      status: 'revoked',
      verifiedAt: clone(crossedTimestamp),
      createdAt: clone(crossedTimestamp),
      updatedAt: clone(crossedTimestamp),
      revokeReason: 'key_rotated',
      revokedAt: clone(crossedTimestamp)
    });
    const crossedBefore = snapshot(crossedState);
    const crossedConflict = await atTime(lineageAt + 2, () => (
      loadAccountAuth(lineageOpenid, crossedState).main({
        authProtocol: 2,
        action: 'completeWechatEntry',
        clientInstanceId: 'wechat-lineage-client',
        proofToken: lineageProof.proofToken,
        bindWechat: false,
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION
      })
    ));
    assert.strictEqual(crossedConflict.code, 'AUTH_CONFLICT');
    assert.deepStrictEqual(snapshot(crossedState), crossedBefore);
  } finally {
    process.env.CUETRACE_AUTH_KEY_ACTIVE_VERSION = originalActive;
    process.env.CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS = originalHistorical;
    if (originalK1 === undefined) delete process.env.CUETRACE_AUTH_KEY_K1;
    else process.env.CUETRACE_AUTH_KEY_K1 = originalK1;
  }
}

async function testSecurityActions() {
  const state = makeState();
  const openid = 'security-openid';
  const entry = loadAccountAuth(openid, state);
  const registered = await atTime(BASE_MS, () => entry.main({
    authProtocol: 2,
    action: 'registerAccountName',
    clientInstanceId: 'security-client',
    accountName: 'SecurityMember',
    password: 'initial-password',
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION
  }));
  assert.strictEqual(registered.ok, true);
  const accountId = state.accounts[0]._id;
  const originalSession = state.auth_sessions[0];

  const missingSession = await entry.main({
    authProtocol: 2,
    action: 'status',
    clientInstanceId: 'security-client'
  });
  assert.strictEqual(missingSession.code, 'SESSION_REQUIRED');
  const malformedSession = await entry.main({
    authProtocol: 2,
    action: 'status',
    clientInstanceId: 'security-client',
    sessionToken: 'not-a-session-token'
  });
  assert.strictEqual(malformedSession.code, 'SESSION_EXPIRED');

  const status = await atTime(BASE_MS + 1, () => entry.main({
    authProtocol: 2,
    action: 'status',
    clientInstanceId: 'security-client',
    sessionToken: registered.sessionToken
  }));
  assert.deepStrictEqual(status, {
    ok: true,
    kind: 'security_status',
    account: 'SecurityMember',
    accountNameSet: true,
    passwordSet: true,
    phoneBound: false,
    phoneMasked: '',
    emailBound: false,
    emailMasked: '',
    wechatBound: false,
    roles: ['member'],
    currentRole: 'member',
    reauthMethods: ['password'],
    currentSession: {
      authenticatedAt: originalSession.authenticatedAt.getTime(),
      authenticationMethod: 'password',
      createdAt: originalSession.createdAt.getTime(),
      lastSeenAt: originalSession.lastSeenAt.getTime(),
      idleExpiresAt: originalSession.idleExpiresAt.getTime(),
      absoluteExpiresAt: originalSession.absoluteExpiresAt.getTime()
    },
    otherSessionCount: 0
  });
  assert.strictEqual(JSON.stringify(status).includes(accountId), false);
  assert.strictEqual(JSON.stringify(status).includes(registered.sessionToken), false);

  const malformedOther = clone(originalSession);
  malformedOther._id = `session.K2.${'Z'.repeat(43)}`;
  malformedOther.clientInstanceId = 'malformed-other-client';
  malformedOther.idleExpiresAt = new Date(
    malformedOther.idleExpiresAt.getTime() + 1
  );
  state.auth_sessions.push(malformedOther);
  const statusWithMalformedOther = await atTime(
    BASE_MS + 1,
    () => entry.main({
      authProtocol: 2,
      action: 'status',
      clientInstanceId: 'security-client',
      sessionToken: registered.sessionToken
    })
  );
  assert.strictEqual(
    statusWithMalformedOther.otherSessionCount,
    0,
    'malformed TTL relationships must not count as live sessions'
  );
  state.auth_sessions = state.auth_sessions.filter(
    (session) => session._id !== malformedOther._id
  );

  const secretBearingOther = clone(originalSession);
  secretBearingOther._id = `session.K2.${'Y'.repeat(43)}`;
  secretBearingOther.clientInstanceId = 'secret-bearing-other-client';
  secretBearingOther.sessionToken = 'raw-token-must-never-be-persisted';
  const oversizedMethodOther = clone(originalSession);
  oversizedMethodOther._id = `session.K2.${'X'.repeat(43)}`;
  oversizedMethodOther.clientInstanceId = 'oversized-method-other-client';
  oversizedMethodOther.authenticationMethod = 'm'.repeat(65);
  const unknownKeyOther = clone(originalSession);
  unknownKeyOther._id = 'session.UNKNOWN.' + crypto
    .createHash('sha256')
    .update('unknown-session-key')
    .digest('base64url');
  unknownKeyOther.keyVersion = 'UNKNOWN';
  unknownKeyOther.clientInstanceId = 'unknown-key-other-client';
  const nonCanonicalOther = clone(originalSession);
  nonCanonicalOther._id = `session.K2.${'B'.repeat(43)}`;
  nonCanonicalOther.clientInstanceId = 'non-canonical-other-client';
  state.auth_sessions.push(
    secretBearingOther,
    oversizedMethodOther,
    unknownKeyOther,
    nonCanonicalOther
  );
  const statusWithMalformedShapes = await atTime(
    BASE_MS + 1,
    () => entry.main({
      authProtocol: 2,
      action: 'status',
      clientInstanceId: 'security-client',
      sessionToken: registered.sessionToken
    })
  );
  assert.strictEqual(
    statusWithMalformedShapes.otherSessionCount,
    0,
    'secret-bearing, oversized, and unknown-key sessions must not count'
  );
  state.auth_sessions = state.auth_sessions.filter((session) => (
    session._id !== secretBearingOther._id
    && session._id !== oversizedMethodOther._id
    && session._id !== unknownKeyOther._id
    && session._id !== nonCanonicalOther._id
  ));

  const pagedSessions = Array.from({ length: 101 }, (_, index) => {
    const session = clone(originalSession);
    session._id = 'session.K2.' + crypto
      .createHash('sha256')
      .update(`security-paged-session-${index}`)
      .digest('base64url');
    session.clientInstanceId = `security-paged-client-${index}`;
    return session;
  });
  const revokedSessions = Array.from({ length: 150 }, (_, index) => {
    const session = clone(originalSession);
    session._id = 'session.K2.' + crypto
      .createHash('sha256')
      .update(`security-revoked-session-${index}`)
      .digest('base64url');
    session.clientInstanceId = `security-revoked-client-${index}`;
    session.revokedAt = new Date(BASE_MS);
    session.revokeReason = 'logout_current';
    return session;
  });
  state.auth_sessions.push(...pagedSessions, ...revokedSessions);
  const pagedQueryStart = fakeDb.__operations.length;
  const pagedStatus = await atTime(BASE_MS + 1, () => entry.main({
    authProtocol: 2,
    action: 'status',
    clientInstanceId: 'security-client',
    sessionToken: registered.sessionToken
  }));
  assert.strictEqual(
    pagedStatus.otherSessionCount,
    101,
    'status must count live sessions beyond the database default page'
  );
  const pagedQueries = fakeDb.__operations
    .slice(pagedQueryStart)
    .filter((operation) => (
      operation.operation === 'query'
      && operation.collection === 'auth_sessions'
    ));
  assert.strictEqual(
    pagedQueries.length,
    2,
    'revoked sessions must be excluded before paging'
  );
  assert(pagedQueries.every((operation) => (
    operation.query.revokedAt === ''
    && operation.orderField === '_id'
    && operation.orderDirection === 'asc'
  )));
  const pagedSessionIds = new Set(
    [...pagedSessions, ...revokedSessions].map((session) => session._id)
  );
  state.auth_sessions = state.auth_sessions.filter(
    (session) => !pagedSessionIds.has(session._id)
  );

  const wrongReauth = await atTime(BASE_MS + 2, () => entry.main({
    authProtocol: 2,
    action: 'reauthenticate',
    clientInstanceId: 'security-client',
    sessionToken: registered.sessionToken,
    method: 'password',
    password: 'wrong-password'
  }));
  assert.strictEqual(wrongReauth.code, 'INVALID_CREDENTIALS');
  const beforeReauth = clone(state.auth_sessions[0]);
  const reauthenticated = await atTime(BASE_MS + 3, () => entry.main({
    authProtocol: 2,
    action: 'reauthenticate',
    clientInstanceId: 'security-client',
    sessionToken: registered.sessionToken,
    method: 'password',
    password: 'initial-password'
  }));
  assert.deepStrictEqual(reauthenticated, {
    ok: true,
    kind: 'reauthenticated',
    authenticatedAt: BASE_MS + 3,
    authenticationMethod: 'password'
  });
  const afterReauth = state.auth_sessions[0];
  for (const field of [
    'createdAt',
    'lastSeenAt',
    'idleExpiresAt',
    'absoluteExpiresAt'
  ]) {
    assert.strictEqual(
      afterReauth[field].getTime(),
      beforeReauth[field].getTime(),
      `reauthentication must not change ${field}`
    );
  }

  const bindPhoneAt = BASE_MS + 60 * 1000;
  const phone = '13300133000';
  const normalizedPhone = '+8613300133000';
  const bindChallenge = await createSentSmsChallenge({
    openid,
    phone: normalizedPhone,
    purpose: 'bind_phone',
    clientInstanceId: 'security-client',
    accountId,
    code: '121212',
    nowMs: bindPhoneAt
  });
  const bindChallengeRecord = state.sms_codes.find(
    (record) => record.purpose === 'bind_phone'
      && record.status === 'sent'
  );
  const correctChallengeMask = bindChallengeRecord.phoneMasked;
  bindChallengeRecord.phoneMasked = '133****9999';
  const malformedMaskBefore = snapshot(state);
  const malformedMask = await atTime(bindPhoneAt + 1, () => entry.main({
    authProtocol: 2,
    action: 'bindPhone',
    clientInstanceId: 'security-client',
    sessionToken: registered.sessionToken,
    phone,
    challengeId: bindChallenge,
    code: '121212'
  }));
  assert.strictEqual(malformedMask.code, 'AUTH_INTERNAL_ERROR');
  assert.deepStrictEqual(snapshot(state), malformedMaskBefore);
  bindChallengeRecord.phoneMasked = correctChallengeMask;
  const boundPhone = await atTime(bindPhoneAt + 1, () => entry.main({
    authProtocol: 2,
    action: 'bindPhone',
    clientInstanceId: 'security-client',
    sessionToken: registered.sessionToken,
    phone,
    challengeId: bindChallenge,
    code: '121212'
  }));
  assert.deepStrictEqual(boundPhone, {
    ok: true,
    kind: 'security_mutation',
    operation: 'bind_phone',
    account: 'SecurityMember',
    accountDisplay: 'SecurityMember',
    accountNameSet: true,
    passwordSet: true,
    phoneBound: true,
    phoneMasked: '133****3000',
    emailBound: false,
    emailMasked: '',
    wechatBound: false
  });
  assert.strictEqual(state.accounts[0].phoneBindingId, state.phone_bindings[0]._id);

  const boundWechat = await atTime(bindPhoneAt + 2, () => entry.main({
    authProtocol: 2,
    action: 'bindWechat',
    clientInstanceId: 'security-client',
    sessionToken: registered.sessionToken
  }));
  assert.strictEqual(boundWechat.ok, true);
  assert.strictEqual(boundWechat.operation, 'bind_wechat');
  assert.strictEqual(boundWechat.wechatBound, true);

  const completeStatus = await atTime(bindPhoneAt + 3, () => entry.main({
    authProtocol: 2,
    action: 'status',
    clientInstanceId: 'security-client',
    sessionToken: registered.sessionToken
  }));
  assert.deepStrictEqual(completeStatus.reauthMethods, [
    'password',
    'phone',
    'wechat'
  ]);
  assert.strictEqual(completeStatus.emailBound, false);
  assert.strictEqual(completeStatus.emailMasked, '');

  const phonePasswordEntry = loadAccountAuth(
    'security-phone-password-openid',
    state
  );
  const phonePassword = await atTime(bindPhoneAt + 4, () => (
    phonePasswordEntry.main({
      authProtocol: 2,
      action: 'loginPassword',
      clientInstanceId: 'security-phone-password-client',
      identifier: phone,
      password: 'initial-password',
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION
    })
  ));
  assert.strictEqual(phonePassword.ok, true);
  assert.strictEqual(phonePassword.account, 'SecurityMember');
  assert.strictEqual(state.accounts.length, 1);

  const smsEntry = loadAccountAuth('security-phone-sms-openid', state);
  const loginSmsAt = bindPhoneAt + 61 * 1000;
  const loginChallenge = await createSentSmsChallenge({
    openid: 'security-phone-sms-openid',
    phone: normalizedPhone,
    purpose: 'login',
    clientInstanceId: 'security-phone-sms-client',
    code: '343434',
    nowMs: loginSmsAt
  });
  const phoneSms = await atTime(loginSmsAt + 1, () => smsEntry.main({
    authProtocol: 2,
    action: 'loginSms',
    clientInstanceId: 'security-phone-sms-client',
    phone,
    challengeId: loginChallenge,
    code: '343434',
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION
  }));
  assert.strictEqual(phoneSms.ok, true);
  assert.strictEqual(phoneSms.account, 'SecurityMember');
  assert.strictEqual(state.accounts.length, 1);

  const authVersionBeforePassword = state.accounts[0].authVersion;
  const passwordChanged = await atTime(loginSmsAt + 2, () => entry.main({
    authProtocol: 2,
    action: 'setPassword',
    clientInstanceId: 'forged-does-not-select-survivor',
    sessionToken: registered.sessionToken,
    password: 'replacement-password'
  }));
  assert.strictEqual(passwordChanged.ok, true);
  assert.strictEqual(passwordChanged.kind, 'session_rotated');
  assert.strictEqual(state.accounts[0].authVersion, authVersionBeforePassword + 1);
  assert.strictEqual(
    (await entry.main({
      authProtocol: 2,
      action: 'status',
      clientInstanceId: 'security-client',
      sessionToken: registered.sessionToken
    })).code,
    'SESSION_EXPIRED'
  );

  const otherSession = await atTime(loginSmsAt + 3, () => (
    phonePasswordEntry.main({
      authProtocol: 2,
      action: 'loginPassword',
      clientInstanceId: 'other-session-client',
      identifier: 'SecurityMember',
      password: 'replacement-password',
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION
    })
  ));
  assert.strictEqual(otherSession.ok, true);
  const versionBeforeLogoutOthers = state.accounts[0].authVersion;
  const loggedOutOthers = await atTime(loginSmsAt + 4, () => entry.main({
    authProtocol: 2,
    action: 'logoutOthers',
    clientInstanceId: 'other-session-client',
    sessionToken: passwordChanged.sessionToken
  }));
  assert.strictEqual(loggedOutOthers.ok, true);
  assert.strictEqual(loggedOutOthers.kind, 'session_rotated');
  assert.strictEqual(state.accounts[0].authVersion, versionBeforeLogoutOthers + 1);
  assert.strictEqual(
    (await phonePasswordEntry.main({
      authProtocol: 2,
      action: 'status',
      clientInstanceId: 'other-session-client',
      sessionToken: otherSession.sessionToken
    })).code,
    'SESSION_EXPIRED'
  );

  const logout = await atTime(loginSmsAt + 5, () => entry.main({
    authProtocol: 2,
    action: 'logoutCurrent',
    clientInstanceId: 'security-client',
    sessionToken: loggedOutOthers.sessionToken
  }));
  assert.deepStrictEqual(logout, {
    ok: true,
    kind: 'session_revoked'
  });
  assert.strictEqual(
    (await entry.main({
      authProtocol: 2,
      action: 'status',
      clientInstanceId: 'security-client',
      sessionToken: loggedOutOthers.sessionToken
    })).code,
    'SESSION_EXPIRED'
  );

  const staleState = makeState();
  const staleEntry = loadAccountAuth('stale-security-openid', staleState);
  const staleRegistered = await atTime(BASE_MS, () => staleEntry.main({
    authProtocol: 2,
    action: 'registerAccountName',
    clientInstanceId: 'stale-security-client',
    accountName: 'StaleSecurity',
    password: 'stale-password',
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION
  }));
  const staleBefore = snapshot(staleState);
  const sensitiveRequests = [
    {
      action: 'bindPhone',
      phone: '13600136000',
      challengeId: `v2.K2.${'A'.repeat(43)}`,
      code: '123456'
    },
    {
      action: 'setAccountName',
      accountName: 'StaleReplacement'
    },
    {
      action: 'setPassword',
      password: 'stale-replacement-password'
    },
    { action: 'bindWechat' },
    { action: 'logoutOthers' }
  ];
  for (const request of sensitiveRequests) {
    const staleSensitive = await atTime(
      BASE_MS + 10 * 60 * 1000 + 1,
      () => staleEntry.main({
        authProtocol: 2,
        clientInstanceId: 'stale-security-client',
        sessionToken: staleRegistered.sessionToken,
        ...request
      })
    );
    assert.strictEqual(
      staleSensitive.code,
      'RECENT_AUTH_REQUIRED',
      `${request.action} must reject stale preflight authentication`
    );
    assert.deepStrictEqual(snapshot(staleState), staleBefore);
  }

  const toctouState = makeState();
  const toctouEntry = loadAccountAuth('toctou-security-openid', toctouState);
  const toctouRegistered = await atTime(BASE_MS, () => toctouEntry.main({
    authProtocol: 2,
    action: 'registerAccountName',
    clientInstanceId: 'toctou-security-client',
    accountName: 'ToctouSecurity',
    password: 'toctou-password',
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION
  }));
  const refreshedAt = BASE_MS + 11 * 60 * 1000;
  const toctouReauth = await atTime(refreshedAt, () => toctouEntry.main({
    authProtocol: 2,
    action: 'reauthenticate',
    clientInstanceId: 'toctou-security-client',
    sessionToken: toctouRegistered.sessionToken,
    method: 'password',
    password: 'toctou-password'
  }));
  assert.strictEqual(toctouReauth.ok, true);
  const toctouBefore = snapshot(toctouState);
  fakeDb.beforeTransaction = (workingState) => {
    workingState.auth_sessions[0].authenticationMethod = '';
  };
  const malformedLiveSession = await atTime(refreshedAt + 1, () => (
    toctouEntry.main({
      authProtocol: 2,
      action: 'bindWechat',
      clientInstanceId: 'toctou-security-client',
      sessionToken: toctouRegistered.sessionToken
    })
  ));
  assert.strictEqual(malformedLiveSession.code, 'SESSION_EXPIRED');
  assert.deepStrictEqual(snapshot(toctouState), toctouBefore);

  fakeDb.beforeTransaction = (workingState) => {
    workingState.auth_sessions[0].sessionToken =
      'raw-token-must-never-be-persisted';
  };
  const secretBearingLiveSession = await atTime(
    refreshedAt + 1,
    () => toctouEntry.main({
      authProtocol: 2,
      action: 'bindWechat',
      clientInstanceId: 'toctou-security-client',
      sessionToken: toctouRegistered.sessionToken
    })
  );
  assert.strictEqual(secretBearingLiveSession.code, 'SESSION_EXPIRED');
  assert.deepStrictEqual(snapshot(toctouState), toctouBefore);

  for (const request of sensitiveRequests) {
    fakeDb.beforeTransaction = (workingState) => {
      workingState.auth_sessions[0].authenticatedAt = new Date(BASE_MS);
    };
    const toctouSensitive = await atTime(
      refreshedAt + 2,
      () => toctouEntry.main({
        authProtocol: 2,
        clientInstanceId: 'toctou-security-client',
        sessionToken: toctouRegistered.sessionToken,
        ...request
      })
    );
    assert.strictEqual(
      toctouSensitive.code,
      'RECENT_AUTH_REQUIRED',
      `${request.action} must recheck recent auth in its transaction`
    );
    assert.deepStrictEqual(snapshot(toctouState), toctouBefore);
  }
}

async function testSecurityKeyRotation() {
  const originalActive = process.env.CUETRACE_AUTH_KEY_ACTIVE_VERSION;
  const originalHistorical =
    process.env.CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS;
  const originalK1 = process.env.CUETRACE_AUTH_KEY_K1;
  process.env.CUETRACE_AUTH_KEY_K1 = Buffer.alloc(32, 0x61)
    .toString('base64');
  try {
    process.env.CUETRACE_AUTH_KEY_ACTIVE_VERSION = 'K1';
    process.env.CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS = '';
    const k1 = loadKeyring(process.env);
    const openid = 'security-rotation-openid';
    const appid = 'wx-test-app';
    const trusted = wechatIdentity({ APPID: appid, OPENID: openid });
    const normalizedPhone = '+8613100131000';
    const phoneK1 = candidateHmacIds(
      k1,
      'phone-binding',
      normalizedPhone,
      'phone'
    )[0];
    const wechatK1 = candidateHmacIds(
      k1,
      'wechat-binding',
      trusted.bindingInput,
      'wechat'
    )[0];
    const appidK1 = candidateHmacIds(
      k1,
      'wechat-binding',
      appid,
      'wechat-appid'
    )[0];
    const openidK1 = candidateHmacIds(
      k1,
      'wechat-binding',
      openid,
      'wechat-openid'
    )[0];
    const accountId = `acct_${'R'.repeat(22)}`;
    const accountName = 'RotationSecurity';
    const normalizedName = accountName.toLowerCase();
    const accountNameId = sha256(`account-name:v1:${normalizedName}`);
    const createdAt = new Date(BASE_MS - 20 * 24 * 60 * 60 * 1000);
    const verifiedAt = new Date(BASE_MS - 10 * 24 * 60 * 60 * 1000);
    const passwordRecord = hashPassword('rotation-security-password');
    const state = makeState({
      accounts: [{
        _id: accountId,
        status: 'active',
        accountNameBindingId: accountNameId,
        phoneBindingId: phoneK1.id,
        wechatBindingId: wechatK1.id,
        emailBindingId: '',
        ...passwordRecord,
        authVersion: 1,
        termsAcceptedAt: clone(createdAt),
        termsVersion: TERMS_VERSION,
        privacyAcceptedAt: clone(createdAt),
        privacyVersion: PRIVACY_VERSION,
        createdAt: clone(createdAt),
        updatedAt: clone(verifiedAt)
      }],
      account_names: [{
        _id: accountNameId,
        accountId,
        account: accountName,
        accountNormalized: normalizedName,
        status: 'active',
        createdAt: clone(createdAt),
        updatedAt: clone(createdAt)
      }],
      phone_bindings: [{
        _id: phoneK1.id,
        accountId,
        keyVersion: 'K1',
        phoneMasked: '131****1000',
        status: 'active',
        verifiedAt: clone(verifiedAt),
        createdAt: clone(createdAt),
        updatedAt: clone(verifiedAt)
      }],
      wechat_bindings: [{
        _id: wechatK1.id,
        accountId,
        keyVersion: 'K1',
        appidHash: appidK1.id,
        openidHash: openidK1.id,
        unionidHash: '',
        status: 'active',
        consentedAt: clone(verifiedAt),
        createdAt: clone(createdAt),
        updatedAt: clone(verifiedAt)
      }],
      users: [{
        _id: accountId,
        roles: ['member'],
        currentRole: 'member',
        role: 'member',
        nickname: '',
        avatar: '',
        createdAt: clone(createdAt),
        updatedAt: clone(createdAt)
      }]
    });

    process.env.CUETRACE_AUTH_KEY_ACTIVE_VERSION = 'K2';
    process.env.CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS = 'K1';
    const k2 = loadKeyring(process.env);
    const phoneK2 = candidateHmacIds(
      k2,
      'phone-binding',
      normalizedPhone,
      'phone'
    )[0];
    const wechatK2 = candidateHmacIds(
      k2,
      'wechat-binding',
      trusted.bindingInput,
      'wechat'
    )[0];
    const unionK2 = candidateHmacIds(
      k2,
      'wechat-binding',
      'security-rotation-union',
      'wechat-unionid'
    )[0];
    const entry = loadAccountAuth(
      openid,
      state,
      'security-rotation-union'
    );
    const login = await atTime(BASE_MS, () => entry.main({
      authProtocol: 2,
      action: 'loginPassword',
      clientInstanceId: 'security-rotation-client',
      identifier: accountName,
      password: 'rotation-security-password',
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION
    }));
    assert.strictEqual(login.ok, true);
    const currentSession = state.auth_sessions.find(
      (session) => session.revokedAt === ''
    );
    const reauthAt = BASE_MS + 60 * 1000;
    const challenge = await createSentSmsChallenge({
      openid,
      phone: normalizedPhone,
      purpose: 'reauth',
      clientInstanceId: 'security-rotation-client',
      accountId,
      sessionId: currentSession._id,
      code: '565656',
      nowMs: reauthAt
    });
    const phoneReauthenticated = await atTime(reauthAt + 1, () => (
      entry.main({
        authProtocol: 2,
        action: 'reauthenticate',
        clientInstanceId: 'security-rotation-client',
        sessionToken: login.sessionToken,
        method: 'phone',
        phone: '13100131000',
        challengeId: challenge,
        code: '565656'
      })
    ));
    assert.strictEqual(phoneReauthenticated.ok, true);
    assert.strictEqual(state.accounts[0].phoneBindingId, phoneK2.id);
    assert.strictEqual(findById(state.phone_bindings, phoneK1.id).status, 'revoked');
    assert.strictEqual(
      findById(state.phone_bindings, phoneK2.id).verifiedAt.getTime(),
      verifiedAt.getTime()
    );

    const wechatReauthenticated = await atTime(reauthAt + 2, () => (
      entry.main({
        authProtocol: 2,
        action: 'reauthenticate',
        clientInstanceId: 'security-rotation-client',
        sessionToken: login.sessionToken,
        method: 'wechat'
      })
    ));
    assert.strictEqual(wechatReauthenticated.ok, true);
    assert.strictEqual(state.accounts[0].wechatBindingId, wechatK2.id);
    assert.strictEqual(findById(state.wechat_bindings, wechatK1.id).status, 'revoked');
    assert.strictEqual(
      findById(state.wechat_bindings, wechatK2.id).unionidHash,
      unionK2.id
    );
  } finally {
    process.env.CUETRACE_AUTH_KEY_ACTIVE_VERSION = originalActive;
    process.env.CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS = originalHistorical;
    if (originalK1 === undefined) delete process.env.CUETRACE_AUTH_KEY_K1;
    else process.env.CUETRACE_AUTH_KEY_K1 = originalK1;
  }
}

async function testSecurityChallengeRotation() {
  const originalActive = process.env.CUETRACE_AUTH_KEY_ACTIVE_VERSION;
  const originalHistorical =
    process.env.CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS;
  const originalK1 = process.env.CUETRACE_AUTH_KEY_K1;
  process.env.CUETRACE_AUTH_KEY_K1 = Buffer.alloc(32, 0x62)
    .toString('base64');
  try {
    process.env.CUETRACE_AUTH_KEY_ACTIVE_VERSION = 'K1';
    process.env.CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS = '';

    const reauthState = makeState();
    const reauthOpenid = 'security-challenge-rotation-reauth';
    const reauthClient = 'security-challenge-rotation-reauth-client';
    const reauthEntryK1 = loadAccountAuth(reauthOpenid, reauthState);
    const loginAt = BASE_MS + 30 * 60 * 1000;
    const loginChallenge = await createSentSmsChallenge({
      openid: reauthOpenid,
      phone: '+8613400134000',
      purpose: 'login',
      clientInstanceId: reauthClient,
      code: '121212',
      nowMs: loginAt
    });
    const login = await atTime(loginAt + 1, () => reauthEntryK1.main({
      authProtocol: 2,
      action: 'loginSms',
      clientInstanceId: reauthClient,
      phone: '13400134000',
      challengeId: loginChallenge,
      code: '121212',
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION
    }));
    assert.strictEqual(login.ok, true);
    const reauthAccountId = reauthState.accounts[0]._id;
    const reauthSessionId = reauthState.auth_sessions[0]._id;
    const reauthAt = loginAt + 61 * 1000;
    const reauthChallenge = await createSentSmsChallenge({
      openid: reauthOpenid,
      phone: '+8613400134000',
      purpose: 'reauth',
      clientInstanceId: reauthClient,
      accountId: reauthAccountId,
      sessionId: reauthSessionId,
      code: '343434',
      nowMs: reauthAt
    });

    const bindState = makeState();
    const bindOpenid = 'security-challenge-rotation-bind';
    const bindClient = 'security-challenge-rotation-bind-client';
    const bindEntryK1 = loadAccountAuth(bindOpenid, bindState);
    const registered = await atTime(loginAt, () => bindEntryK1.main({
      authProtocol: 2,
      action: 'registerAccountName',
      clientInstanceId: bindClient,
      accountName: 'ChallengeRotation',
      password: 'challenge-rotation-password',
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION
    }));
    assert.strictEqual(registered.ok, true);
    const bindAccountId = bindState.accounts[0]._id;
    const bindAt = loginAt + 10 * 1000;
    const bindChallenge = await createSentSmsChallenge({
      openid: bindOpenid,
      phone: '+8613500135000',
      purpose: 'bind_phone',
      clientInstanceId: bindClient,
      accountId: bindAccountId,
      code: '565656',
      nowMs: bindAt
    });

    process.env.CUETRACE_AUTH_KEY_ACTIVE_VERSION = 'K2';
    process.env.CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS = 'K1';
    const rotatedKeyring = loadKeyring(process.env);

    const reauthEntryK2 = loadAccountAuth(reauthOpenid, reauthState);
    const reauthenticated = await atTime(reauthAt + 1, () => (
      reauthEntryK2.main({
        authProtocol: 2,
        action: 'reauthenticate',
        clientInstanceId: reauthClient,
        sessionToken: login.sessionToken,
        method: 'phone',
        phone: '13400134000',
        challengeId: reauthChallenge,
        code: '343434'
      })
    ));
    assert.strictEqual(reauthenticated.ok, true);
    const reauthActivePhone = candidateHmacIds(
      rotatedKeyring,
      'phone-binding',
      '+8613400134000',
      'phone'
    )[0];
    assert.strictEqual(
      reauthState.accounts[0].phoneBindingId,
      reauthActivePhone.id
    );

    const bindEntryK2 = loadAccountAuth(bindOpenid, bindState);
    const bound = await atTime(bindAt + 1, () => bindEntryK2.main({
      authProtocol: 2,
      action: 'bindPhone',
      clientInstanceId: bindClient,
      sessionToken: registered.sessionToken,
      phone: '13500135000',
      challengeId: bindChallenge,
      code: '565656'
    }));
    assert.strictEqual(bound.ok, true);
    const bindActivePhone = candidateHmacIds(
      rotatedKeyring,
      'phone-binding',
      '+8613500135000',
      'phone'
    )[0];
    assert.strictEqual(
      bindState.accounts[0].phoneBindingId,
      bindActivePhone.id
    );
  } finally {
    process.env.CUETRACE_AUTH_KEY_ACTIVE_VERSION = originalActive;
    process.env.CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS = originalHistorical;
    if (originalK1 === undefined) delete process.env.CUETRACE_AUTH_KEY_K1;
    else process.env.CUETRACE_AUTH_KEY_K1 = originalK1;
  }
}

function matches(document, query) {
  return Object.keys(query || {}).every((key) => {
    const expected = query[key];
    if (expected && typeof expected === 'object' && Array.isArray(expected.$in)) {
      return expected.$in.indexOf(document[key]) !== -1;
    }
    if (
      expected
      && typeof expected === 'object'
      && Object.prototype.hasOwnProperty.call(expected, '__gt')
    ) {
      return typeof document[key] === 'string'
        && document[key] > expected.__gt;
    }
    return document[key] === expected;
  });
}

function makeDatabase(state, options) {
  const root = {
    failNextRead: false,
    failNextWrite: false,
    beforeTransaction: null,
    throwOnNotFound: !options || options.throwOnNotFound !== false,
    operations: []
  };

  function createFacade(targetState, transactionMode) {
    function maybeFailRead() {
      if (root.failNextRead) {
        root.failNextRead = false;
        throw new Error('simulated read failure');
      }
    }

    function maybeFailWrite() {
      if (root.failNextWrite) {
        root.failNextWrite = false;
        throw new Error('simulated write failure');
      }
    }

    function collection(name) {
      const documents = targetState[name] || (targetState[name] = []);

      return {
        doc(id) {
          return {
            async get() {
              root.operations.push({
                operation: 'get',
                collection: name,
                id,
                transactionMode
              });
              maybeFailRead();
              const document = findById(documents, id);
              if (!document && root.throwOnNotFound) {
                throw new Error(
                  `document.get:fail document with _id ${id} does not exist`
                );
              }
              return { data: clone(document || null) };
            },
            async set({ data }) {
              root.operations.push({
                operation: 'set',
                collection: name,
                id,
                data: clone(data),
                transactionMode
              });
              maybeFailWrite();
              if (Object.prototype.hasOwnProperty.call(data, '_id')) {
                throw new Error('-501007 不能更新_id的值');
              }
              const next = Object.assign({}, clone(data), { _id: id });
              const index = documents.findIndex((item) => item._id === id);
              if (index === -1) documents.push(next);
              else documents[index] = next;
              return { _id: id };
            },
            async update({ data }) {
              root.operations.push({
                operation: 'update',
                collection: name,
                id,
                data: clone(data),
                transactionMode
              });
              maybeFailWrite();
              const index = documents.findIndex((item) => item._id === id);
              if (index === -1) throw new Error(`document ${id} does not exist`);
              const next = Object.assign({}, documents[index]);
              for (const [key, value] of Object.entries(clone(data))) {
                if (value && value.__remove === true) delete next[key];
                else next[key] = value;
              }
              documents[index] = Object.assign(next, { _id: id });
              return { stats: { updated: 1 } };
            }
          };
        },
        where(query) {
          function queryFacade(
            offset,
            maximum,
            orderField,
            orderDirection
          ) {
            return {
              skip(nextOffset) {
                return queryFacade(
                  nextOffset,
                  maximum,
                  orderField,
                  orderDirection
                );
              },
              limit(nextMaximum) {
                return queryFacade(
                  offset,
                  nextMaximum,
                  orderField,
                  orderDirection
                );
              },
              orderBy(nextField, nextDirection) {
                return queryFacade(
                  offset,
                  maximum,
                  nextField,
                  nextDirection
                );
              },
              async get() {
                let matched = documents.filter(
                  (item) => matches(item, query)
                );
                if (orderField) {
                  const direction = orderDirection === 'desc' ? -1 : 1;
                  matched = matched.sort((left, right) => {
                    const leftValue = String(left[orderField]);
                    const rightValue = String(right[orderField]);
                    if (leftValue === rightValue) return 0;
                    return (leftValue < rightValue ? -1 : 1) * direction;
                  });
                }
                root.operations.push({
                  operation: 'query',
                  collection: name,
                  query: clone(query),
                  offset,
                  maximum,
                  orderField,
                  orderDirection,
                  transactionMode
                });
                return {
                  data: clone(matched.slice(offset, offset + maximum))
                };
              }
            };
          }
          return queryFacade(0, 100, '', '');
        },
        async add({ data }) {
          maybeFailWrite();
          const id = data._id || `${name}_${documents.length + 1}`;
          documents.push(Object.assign({}, clone(data), { _id: id }));
          return { _id: id };
        }
      };
    }

    return {
      collection,
      serverDate() {
        return new Date(Date.now());
      },
      command: {
        gt(value) {
          return { __gt: value };
        },
        remove() {
          return { __remove: true };
        }
      },
      async runTransaction(callback) {
        if (transactionMode) throw new Error('nested transactions are unsupported');
        const workingState = clone(targetState);
        const beforeTransaction = root.beforeTransaction;
        root.beforeTransaction = null;
        if (beforeTransaction) beforeTransaction(workingState);
        const result = await callback(createFacade(workingState, true));
        Object.keys(targetState).forEach((key) => {
          if (Array.isArray(targetState[key])) targetState[key] = workingState[key] || [];
        });
        Object.keys(workingState).forEach((key) => {
          if (Array.isArray(workingState[key]) && !Object.prototype.hasOwnProperty.call(targetState, key)) {
            targetState[key] = workingState[key];
          }
        });
        return result;
      }
    };
  }

  const database = createFacade(state, false);
  Object.defineProperty(database, 'failNextRead', {
    get() {
      return root.failNextRead;
    },
    set(value) {
      root.failNextRead = Boolean(value);
    }
  });
  Object.defineProperty(database, 'failNextWrite', {
    get() {
      return root.failNextWrite;
    },
    set(value) {
      root.failNextWrite = Boolean(value);
    }
  });
  Object.defineProperty(database, 'beforeTransaction', {
    get() {
      return root.beforeTransaction;
    },
    set(value) {
      root.beforeTransaction = value;
    }
  });
  database.__operations = root.operations;
  return database;
}

let fakeDb;

function loadAccountAuth(openid, seed, unionid) {
  const state = makeState(seed);
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database(options) {
      fakeDb = makeDatabase(state, options);
      return fakeDb;
    },
    getWXContext() {
      return {
        APPID: 'wx-test-app',
        OPENID: openid,
        ...(unionid ? { UNIONID: unionid } : {})
      };
    }
  };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'wx-server-sdk') return fakeCloud;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(accountAuthPath)];
    return require(accountAuthPath);
  } finally {
    Module._load = originalLoad;
  }
}

function loadDataService(options) {
  const config = options || {};
  const calls = [];
  const storage = {};
  const app = {
    globalData: Object.assign({
      cloudReady: config.cloudReady !== false,
      account: '',
      roles: [],
      currentRole: '',
      openid: ''
    }, config.globalData || {})
  };
  global.getApp = () => app;
  global.wx = {
    cloud: config.withCloud === false ? null : {
      callFunction({ name, data }) {
        calls.push({ name, data });
        const result = config.resultForAction
          ? config.resultForAction(data && data.action, name, data)
          : { ok: true };
        return Promise.resolve({ result });
      }
    },
    getStorageSync(key) {
      return storage[key];
    },
    setStorageSync(key, value) {
      storage[key] = value;
    },
    removeStorageSync(key) {
      delete storage[key];
    },
    showToast() {}
  };
  delete require.cache[require.resolve(dataServicePath)];
  return { data: require(dataServicePath), app, calls, storage };
}

async function testClientAuthDelegatesAndSynchronizesState() {
  const fixture = loadDataService({
    resultForAction(action) {
      if (action === 'probe') return { ok: true, cloudReady: true };
      return {
        ok: true,
        account: 'MemberA',
        roles: ['member', 'coach'],
        currentRole: 'coach'
      };
    }
  });

  await fixture.data.registerAccount({ account: 'MemberA', password: '123456' });
  await fixture.data.loginWithPassword({ account: 'MemberA', password: '123456' });
  await fixture.data.loginWithWechat();
  await fixture.data.getAccountSecurity();
  const stateBeforeProbe = clone(fixture.app.globalData);
  await fixture.data.probeAuthCloud();

  assert.deepStrictEqual(fixture.calls, [
    { name: 'accountAuth', data: { action: 'register', account: 'MemberA', password: '123456' } },
    { name: 'accountAuth', data: { action: 'passwordLogin', account: 'MemberA', password: '123456' } },
    { name: 'accountAuth', data: { action: 'wechatLogin' } },
    { name: 'accountAuth', data: { action: 'status' } },
    { name: 'accountAuth', data: { action: 'probe' } }
  ]);
  assert.strictEqual(fixture.app.globalData.account, 'MemberA');
  assert.deepStrictEqual(fixture.app.globalData.roles, ['member', 'coach']);
  assert.strictEqual(fixture.app.globalData.currentRole, 'coach');
  assert.strictEqual(fixture.app.globalData.openid, '');
  assert.strictEqual(fixture.storage.dc_account_name, 'MemberA');
  assert.strictEqual(fixture.storage.dc_accounts, undefined);
  assert.strictEqual(fixture.storage.dc_wechat_bindings, undefined);
  assert.deepStrictEqual(fixture.app.globalData, stateBeforeProbe);
}

async function testClientAuthPinsPublicMethodActions() {
  const fixture = loadDataService({
    resultForAction() {
      return { ok: true, account: 'MemberA', roles: ['member'], currentRole: 'member' };
    }
  });

  await fixture.data.registerAccount({
    action: 'wechatLogin',
    account: 'MemberA',
    password: '123456'
  });
  await fixture.data.loginWithPassword({
    action: 'register',
    account: 'MemberA',
    password: '123456'
  });

  assert.deepStrictEqual(fixture.calls, [
    {
      name: 'accountAuth',
      data: { action: 'register', account: 'MemberA', password: '123456' }
    },
    {
      name: 'accountAuth',
      data: { action: 'passwordLogin', account: 'MemberA', password: '123456' }
    }
  ]);
}

async function testClientRecoveryMethodsPinActionsWithoutChangingSession() {
  const fixture = loadDataService({
    globalData: {
      account: 'SignedInAccount',
      roles: ['member', 'coach'],
      currentRole: 'coach'
    },
    resultForAction(action, name) {
      if (name === 'sendEmailCode') return { ok: true, msg: 'accepted' };
      return { ok: true, account: 'RecoveredAccount', roles: ['shop'], currentRole: 'shop' };
    }
  });
  const sessionBefore = clone(fixture.app.globalData);

  await fixture.data.resetPasswordByWechat({ action: 'register', password: 'newpass1' });
  await fixture.data.resetPasswordByEmail({
    action: 'wechatLogin',
    account: 'MemberA',
    email: 'member@example.com',
    code: '123456',
    password: 'newpass2'
  });
  await fixture.data.bindEmail({ action: 'status', email: 'member@example.com', code: '654321' });
  await fixture.data.sendEmailCode({
    action: 'probe',
    purpose: 'reset',
    account: 'MemberA',
    email: 'member@example.com'
  });

  assert.deepStrictEqual(fixture.calls, [
    { name: 'accountAuth', data: { action: 'resetPasswordByWechat', password: 'newpass1' } },
    {
      name: 'accountAuth',
      data: {
        action: 'resetPasswordByEmail',
        account: 'MemberA',
        email: 'member@example.com',
        code: '123456',
        password: 'newpass2'
      }
    },
    {
      name: 'accountAuth',
      data: { action: 'bindEmail', email: 'member@example.com', code: '654321' }
    },
    {
      name: 'sendEmailCode',
      data: { action: 'send', purpose: 'reset', account: 'MemberA', email: 'member@example.com' }
    }
  ]);
  assert.deepStrictEqual(fixture.app.globalData, sessionBefore);
  assert.deepStrictEqual(fixture.storage, {});

  const unavailable = loadDataService({ cloudReady: false });
  const calls = [
    () => unavailable.data.resetPasswordByWechat({ password: 'newpass1' }),
    () => unavailable.data.resetPasswordByEmail({}),
    () => unavailable.data.bindEmail({}),
    () => unavailable.data.sendEmailCode({ purpose: 'reset' })
  ];
  for (const call of calls) {
    await assert.rejects(call, (error) => error.code === 'CLOUD_NOT_READY');
  }
  assert.strictEqual(unavailable.calls.length, 0);
}

async function testClientAuthFailsClosed() {
  const unavailable = loadDataService({ cloudReady: false });
  await assert.rejects(
    () => unavailable.data.loginWithWechat(),
    (error) => error.code === 'CLOUD_NOT_READY'
  );
  assert.strictEqual(unavailable.calls.length, 0);
  assert.strictEqual(unavailable.app.globalData.openid, '');

  const rejected = loadDataService({
    resultForAction() {
      return { ok: false, code: 'WECHAT_NOT_BOUND', msg: 'not bound' };
    }
  });
  await assert.rejects(
    () => rejected.data.loginWithWechat(),
    (error) => error.code === 'WECHAT_NOT_BOUND' && error.result.code === 'WECHAT_NOT_BOUND'
  );
  assert.strictEqual(rejected.app.globalData.account, '');
}

async function testAppUsesSideEffectFreeAuthProbe() {
  const calls = [];
  let appDefinition;
  global.App = (definition) => {
    appDefinition = definition;
  };
  global.wx = {
    cloud: {
      callFunction(input) {
        calls.push(input);
        return Promise.resolve({ result: { ok: true, cloudReady: true } });
      }
    }
  };
  delete require.cache[require.resolve(appPath)];
  require(appPath);
  let refreshCount = 0;
  appDefinition.refreshBilling = () => {
    refreshCount += 1;
  };

  appDefinition.probeCloud();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepStrictEqual(calls, [
    { name: 'accountAuth', data: { action: 'probe' } }
  ]);
  assert.strictEqual(appDefinition.globalData.cloudReady, true);
  assert.strictEqual(appDefinition.globalData.account, '');
  assert.strictEqual(refreshCount, 1);

  appDefinition.globalData.cloudReady = true;
  delete global.wx.cloud;
  appDefinition.probeCloud();
  assert.strictEqual(appDefinition.globalData.cloudReady, false);

  appDefinition.globalData.cloudReady = true;
  appDefinition.globalData.cloudEnv = '';
  global.wx.cloud = {
    callFunction() {
      throw new Error('should not call without cloud env');
    }
  };
  appDefinition.probeCloud();
  assert.strictEqual(appDefinition.globalData.cloudReady, false);

  appDefinition.globalData.cloudReady = true;
  appDefinition.globalData.cloudEnv = 'test-env';
  global.wx.cloud.callFunction = () => Promise.reject(new Error('probe rejected'));
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    appDefinition.probeCloud();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    console.warn = originalWarn;
  }
  assert.strictEqual(appDefinition.globalData.cloudReady, false);
}

async function run() {
  const projectConfig = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'));
  assert.strictEqual(projectConfig.appid, 'wxa7c9920cda26d7ca');

  const setSemanticsState = makeState();
  const setSemanticsDb = makeDatabase(setSemanticsState, { throwOnNotFound: false });
  const setSemanticsBefore = snapshot(setSemanticsState);
  await assert.rejects(
    setSemanticsDb.collection('accounts').doc('path-account').set({
      data: { _id: 'payload-account', account: 'MemberSet' }
    }),
    (error) => error.message.includes('-501007') && error.message.includes('不能更新_id的值')
  );
  assert.deepStrictEqual(snapshot(setSemanticsState), setSemanticsBefore);
  await setSemanticsDb.collection('accounts').doc('path-account').set({
    data: { account: 'MemberSet' }
  });
  assert.deepStrictEqual(findById(setSemanticsState.accounts, 'path-account'), {
    account: 'MemberSet',
    _id: 'path-account'
  });

  const seed = makeState();
  const state = seed;

  const probeBefore = snapshot(state);
  assert.deepStrictEqual(
    await loadAccountAuth('wechat_probe', state).main({
      authProtocol: 2,
      action: 'probe',
      clientInstanceId: 'probe-client'
    }),
    { ok: true, kind: 'probe' }
  );
  assert.deepStrictEqual(snapshot(state), probeBefore);

  const unboundRecoveryState = makeState();
  const unboundRecoveryBefore = snapshot(unboundRecoveryState);
  const unboundRecovery = await loadAccountAuth('wechat_recovery_missing', unboundRecoveryState).main({
    action: 'resetPasswordByWechat', password: 'newpass1'
  });
  assert.strictEqual(unboundRecovery.code, 'WECHAT_NOT_BOUND');
  assert.deepStrictEqual(snapshot(unboundRecoveryState), unboundRecoveryBefore);

  const recoveryState = makeState();
  const recoveryMain = loadAccountAuth('wechat_recovery', recoveryState).main;
  assert.strictEqual((await recoveryMain({
    action: 'register', account: 'MemberA', password: 'oldpass'
  })).ok, true);
  assert.strictEqual((await recoveryMain({
    action: 'resetPasswordByWechat',
    account: 'InjectedAccount',
    openid: 'injected-openid',
    password: 'newpass1'
  })).ok, true);
  assert.strictEqual((await recoveryMain({
    action: 'passwordLogin', account: 'MemberA', password: 'oldpass'
  })).code, 'INVALID_PASSWORD');
  assert.strictEqual((await recoveryMain({
    action: 'passwordLogin', account: 'MemberA', password: 'newpass1'
  })).ok, true);

  const reserved = await loadAccountAuth('wechat_X', state).main({
    action: 'register', account: 'admin_zhx', password: '123456'
  });
  assert.strictEqual(reserved.code, 'INVALID_INPUT');
  assert.strictEqual(findAccount(state, 'admin_zhx'), undefined);
  assert.strictEqual(findBinding(state, 'wechat_X'), undefined);

  const orphanRegisterState = makeState({
    users: [{
      _id: sha256('wechat:wechat_orphan_register'),
      _openid: 'wechat_orphan_register',
      roles: ['shop'],
      currentRole: 'shop'
    }]
  });
  const orphanRegisterBefore = snapshot(orphanRegisterState);
  const orphanRegister = await loadAccountAuth('wechat_orphan_register', orphanRegisterState).main({
    action: 'register', account: 'MemberOrphanRegister', password: '123456'
  });
  assert.strictEqual(orphanRegister.code, 'ACCOUNT_NOT_BOUND');
  assert.deepStrictEqual(snapshot(orphanRegisterState), orphanRegisterBefore);

  const unboundState = makeState();
  const unboundSalt = '11'.repeat(16);
  unboundState.accounts.push({
    _id: sha256('account:memberu'),
    account: 'MemberU',
    accountNormalized: 'memberu',
    passwordAlgorithm: 'scrypt-v1',
    passwordSalt: unboundSalt,
    passwordHash: crypto.scryptSync('123456', Buffer.from(unboundSalt, 'hex'), 64).toString('hex'),
    status: 'active'
  });
  const firstPasswordBinding = await loadAccountAuth('wechat_U', unboundState).main({
    action: 'passwordLogin', account: 'MemberU', password: '123456'
  });
  assert.strictEqual(firstPasswordBinding.ok, true);
  assert.strictEqual(findAccount(unboundState, 'MemberU')._openid, 'wechat_U');
  assert.strictEqual(findBinding(unboundState, 'wechat_U').accountId, sha256('account:memberu'));
  assert.deepStrictEqual(firstPasswordBinding.roles, ['member']);

  const transactionSalt = '33'.repeat(16);
  const transactionSeed = makeState({
    accounts: [{
      _id: sha256('account:membert'),
      account: 'MemberT',
      accountNormalized: 'membert',
      passwordAlgorithm: 'scrypt-v1',
      passwordSalt: transactionSalt,
      passwordHash: crypto.scryptSync('123456', Buffer.from(transactionSalt, 'hex'), 64).toString('hex'),
      status: 'active'
    }]
  });

  const transactionMissingState = makeState(snapshot(transactionSeed));
  const transactionMissingModule = loadAccountAuth('wechat_T_missing', transactionMissingState);
  fakeDb.beforeTransaction = (workingState) => {
    workingState.accounts = [];
  };
  const transactionMissingBefore = snapshot(transactionMissingState);
  const transactionMissing = await transactionMissingModule.main({
    action: 'passwordLogin', account: 'MemberT', password: '123456'
  });
  assert.strictEqual(transactionMissing.code, 'ACCOUNT_NOT_FOUND');
  assert.deepStrictEqual(snapshot(transactionMissingState), transactionMissingBefore);

  const transactionInvalidState = makeState(snapshot(transactionSeed));
  const transactionInvalidModule = loadAccountAuth('wechat_T_invalid', transactionInvalidState);
  fakeDb.beforeTransaction = (workingState) => {
    findById(workingState.accounts, sha256('account:membert')).accountNormalized = 'different';
  };
  const transactionInvalidBefore = snapshot(transactionInvalidState);
  const transactionInvalid = await transactionInvalidModule.main({
    action: 'passwordLogin', account: 'MemberT', password: '123456'
  });
  assert.strictEqual(transactionInvalid.code, 'ACCOUNT_NOT_BOUND');
  assert.deepStrictEqual(snapshot(transactionInvalidState), transactionInvalidBefore);

  const transactionPasswordState = makeState(snapshot(transactionSeed));
  const transactionPasswordModule = loadAccountAuth('wechat_T_password', transactionPasswordState);
  fakeDb.beforeTransaction = (workingState) => {
    findById(workingState.accounts, sha256('account:membert')).passwordHash = '00'.repeat(64);
  };
  const transactionPasswordBefore = snapshot(transactionPasswordState);
  const transactionPassword = await transactionPasswordModule.main({
    action: 'passwordLogin', account: 'MemberT', password: '123456'
  });
  assert.strictEqual(transactionPassword.code, 'INVALID_PASSWORD');
  assert.deepStrictEqual(snapshot(transactionPasswordState), transactionPasswordBefore);

  const orphanPasswordState = makeState();
  const orphanPasswordSalt = '22'.repeat(16);
  orphanPasswordState.accounts.push({
    _id: sha256('account:memberorphanpassword'),
    account: 'MemberOrphanPassword',
    accountNormalized: 'memberorphanpassword',
    passwordAlgorithm: 'scrypt-v1',
    passwordSalt: orphanPasswordSalt,
    passwordHash: crypto.scryptSync('123456', Buffer.from(orphanPasswordSalt, 'hex'), 64).toString('hex'),
    status: 'active'
  });
  orphanPasswordState.users.push({
    _id: sha256('wechat:wechat_orphan_password'),
    _openid: 'wechat_orphan_password',
    roles: ['member'],
    currentRole: 'member'
  });
  const orphanPasswordBefore = snapshot(orphanPasswordState);
  const orphanPassword = await loadAccountAuth('wechat_orphan_password', orphanPasswordState).main({
    action: 'passwordLogin', account: 'MemberOrphanPassword', password: '123456'
  });
  assert.strictEqual(orphanPassword.code, 'ACCOUNT_NOT_BOUND');
  assert.deepStrictEqual(snapshot(orphanPasswordState), orphanPasswordBefore);

  const first = await loadAccountAuth('wechat_A', seed, 'union_A').main({
    action: 'register',
    account: 'MemberA',
    password: '123456'
  });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.account, 'MemberA');
  assert.deepStrictEqual(first.roles, ['member']);
  assert.strictEqual(first.currentRole, 'member');
  assert.strictEqual(first.wechatBound, true);

  const accountDoc = findById(state.accounts, sha256('account:membera'));
  assert(accountDoc.passwordHash);
  assert(accountDoc.passwordSalt);
  assert.strictEqual(accountDoc.passwordAlgorithm, 'scrypt-v1');
  assert.strictEqual(accountDoc.password, undefined);
  assert.notStrictEqual(accountDoc.passwordHash, '123456');
  assert.strictEqual(accountDoc._openid, 'wechat_A');

  const bindingDoc = findBinding(state, 'wechat_A');
  assert.strictEqual(bindingDoc.accountId, sha256('account:membera'));
  assert.strictEqual(bindingDoc.unionidHash, sha256('unionid:union_A'));
  assert.strictEqual(findById(state.users, sha256('wechat:wechat_A')).role, 'member');

  const resumed = await loadAccountAuth('wechat_A', state).main({ action: 'wechatLogin' });
  assert.strictEqual(resumed.ok, true);
  assert.strictEqual(resumed.account, 'MemberA');

  const tamperedRoleState = makeState(snapshot(state));
  const tamperedRoleUser = findById(tamperedRoleState.users, sha256('wechat:wechat_A'));
  tamperedRoleUser.roles = ['member'];
  tamperedRoleUser.currentRole = 'shop';
  tamperedRoleUser.role = 'shop';
  const tamperedRole = await loadAccountAuth('wechat_A', tamperedRoleState).main({ action: 'wechatLogin' });
  assert.deepStrictEqual(tamperedRole.roles, ['member']);
  assert.strictEqual(tamperedRole.currentRole, 'member');

  const tamperedBindingState = makeState(snapshot(state));
  findBinding(tamperedBindingState, 'wechat_A').account = 'DifferentAccount';
  const tamperedBindingBefore = snapshot(tamperedBindingState);
  const tamperedBinding = await loadAccountAuth('wechat_A', tamperedBindingState).main({
    action: 'passwordLogin', account: 'MemberA', password: '123456'
  });
  assert.strictEqual(tamperedBinding.code, 'ACCOUNT_NOT_BOUND');
  assert.deepStrictEqual(snapshot(tamperedBindingState), tamperedBindingBefore);

  const tamperedWechatState = makeState(snapshot(state));
  findBinding(tamperedWechatState, 'wechat_A').account = 'DifferentAccount';
  const tamperedWechatBefore = snapshot(tamperedWechatState);
  const tamperedWechat = await loadAccountAuth('wechat_A', tamperedWechatState).main({
    action: 'wechatLogin'
  });
  assert.strictEqual(tamperedWechat.code, 'ACCOUNT_NOT_BOUND');
  assert.deepStrictEqual(snapshot(tamperedWechatState), tamperedWechatBefore);

  const passwordLogin = await loadAccountAuth('wechat_A', state).main({
    action: 'passwordLogin', account: 'MemberA', password: '123456'
  });
  assert.strictEqual(passwordLogin.ok, true);
  assert.strictEqual(passwordLogin.account, 'MemberA');

  const malformedAccountState = makeState(snapshot(state));
  findById(malformedAccountState.accounts, sha256('account:membera')).accountNormalized = 'different';
  const malformedAccountBefore = snapshot(malformedAccountState);
  const malformedAccount = await loadAccountAuth('wechat_A', malformedAccountState).main({
    action: 'passwordLogin', account: 'MemberA', password: '123456'
  });
  assert.strictEqual(malformedAccount.code, 'ACCOUNT_NOT_BOUND');
  assert.deepStrictEqual(snapshot(malformedAccountState), malformedAccountBefore);

  const wrongPasswordBefore = snapshot(state);
  const wrongPassword = await loadAccountAuth('wechat_A', state).main({
    action: 'passwordLogin', account: 'MemberA', password: 'bad-password'
  });
  assert.strictEqual(wrongPassword.code, 'INVALID_PASSWORD');
  assert.strictEqual(wrongPassword.msg, '账号密码错误');
  assert.deepStrictEqual(snapshot(state), wrongPasswordBefore);

  const nonStringPasswordBefore = snapshot(state);
  const nonStringPassword = await loadAccountAuth('wechat_A', state).main({
    action: 'passwordLogin', account: 'MemberA', password: 123456
  });
  assert.strictEqual(nonStringPassword.code, 'INVALID_PASSWORD');
  assert.strictEqual(nonStringPassword.msg, '账号密码错误');
  assert.deepStrictEqual(snapshot(state), nonStringPasswordBefore);

  const missingAccountBefore = snapshot(state);
  const missingAccount = await loadAccountAuth('wechat_A', state).main({
    action: 'passwordLogin', account: 'MissingA', password: '123456'
  });
  assert.strictEqual(missingAccount.code, 'ACCOUNT_NOT_FOUND');
  assert.strictEqual(missingAccount.msg, '账号未注册');
  assert.deepStrictEqual(snapshot(state), missingAccountBefore);

  const secondWechat = await loadAccountAuth('wechat_B', state).main({
    action: 'passwordLogin', account: 'MemberA', password: '123456'
  });
  assert.strictEqual(secondWechat.code, 'ACCOUNT_ALREADY_BOUND');

  const secondAccount = await loadAccountAuth('wechat_A', state).main({
    action: 'register', account: 'MemberB', password: '123456'
  });
  assert.strictEqual(secondAccount.code, 'WECHAT_ALREADY_BOUND');

  const duplicateAccount = await loadAccountAuth('wechat_B', state).main({
    action: 'register', account: 'MemberA', password: '123456'
  });
  assert.strictEqual(duplicateAccount.code, 'ACCOUNT_EXISTS');

  const unknownBefore = snapshot(state);
  const unknownWechat = await loadAccountAuth('wechat_C', state).main({ action: 'wechatLogin' });
  assert.strictEqual(unknownWechat.code, 'WECHAT_NOT_BOUND');
  assert.deepStrictEqual(snapshot(state), unknownBefore);

  const boundUser = findById(state.users, sha256('wechat:wechat_A'));
  boundUser.phone = '13800138000';
  const status = await loadAccountAuth('wechat_A', state).main({ action: 'status' });
  assert.strictEqual(status.ok, true);
  assert.strictEqual(status.account, 'MemberA');
  assert.strictEqual(status.passwordSet, true);
  assert.strictEqual(status.phone, '');
  assert.strictEqual(status.emailBound, false);
  assert.strictEqual(status.emailMasked, '');
  ['passwordHash', 'passwordSalt', '_openid', 'unionidHash'].forEach((field) => {
    assert.strictEqual(status[field], undefined);
  });

  boundUser.phoneVerifiedAt = 1710000000000;
  const verifiedStatus = await loadAccountAuth('wechat_A', state).main({ action: 'status' });
  assert.strictEqual(verifiedStatus.phone, '13800138000');

  const inconsistentState = makeState(snapshot(state));
  findBinding(inconsistentState, 'wechat_A')._openid = 'wechat_other';
  const inconsistentBefore = snapshot(inconsistentState);
  const inconsistent = await loadAccountAuth('wechat_A', inconsistentState).main({
    action: 'passwordLogin', account: 'MemberA', password: '123456'
  });
  assert.strictEqual(inconsistent.code, 'ACCOUNT_NOT_BOUND');
  assert.deepStrictEqual(snapshot(inconsistentState), inconsistentBefore);

  const readFailureState = makeState();
  const readFailureBefore = snapshot(readFailureState);
  const readFailureModule = loadAccountAuth('wechat_read_failure', readFailureState);
  fakeDb.failNextRead = true;
  const readFailureConsoleError = console.error;
  console.error = () => {};
  let readFailure;
  try {
    readFailure = await readFailureModule.main({
      action: 'register', account: 'MemberR', password: '123456'
    });
  } finally {
    console.error = readFailureConsoleError;
  }
  assert.strictEqual(readFailure.code, 'AUTH_INTERNAL_ERROR');
  assert.deepStrictEqual(snapshot(readFailureState), readFailureBefore);

  fakeDb = null;
  const rollbackModule = loadAccountAuth('wechat_D', state);
  fakeDb.failNextWrite = true;
  const originalConsoleError = console.error;
  console.error = () => {};
  let rolledBack;
  try {
    rolledBack = await rollbackModule.main({
      action: 'register', account: 'MemberD', password: '123456'
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert.strictEqual(rolledBack.code, 'AUTH_INTERNAL_ERROR');
  assert.strictEqual(findAccount(state, 'MemberD'), undefined);
  assert.strictEqual(findBinding(state, 'wechat_D'), undefined);

  await testClientAuthDelegatesAndSynchronizesState();
  await testClientAuthPinsPublicMethodActions();
  await testClientRecoveryMethodsPinActionsWithoutChangingSession();
  await testClientAuthFailsClosed();
  await testAppUsesSideEffectFreeAuthProbe();

  console.log('accountWechatBinding tests passed');
}

async function runV2() {
  const state = makeState();
  const entry = loadAccountAuth('register-openid', state);
  const authorityBefore = snapshot(state);
  const rejectedAuthority = await entry.main({
    authProtocol: 2,
    action: 'registerAccountName',
    clientInstanceId: 'register-client',
    accountName: 'MemberA',
    password: '123456',
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION,
    accountId: 'client-forged-account'
  });
  assert.strictEqual(rejectedAuthority.ok, false);
  assert.strictEqual(rejectedAuthority.code, 'INVALID_INPUT');
  assert.deepStrictEqual(snapshot(state), authorityBefore);

  const result = await atTime(BASE_MS, () => entry.main({
    authProtocol: 2,
    action: 'registerAccountName',
    clientInstanceId: 'register-client',
    accountName: 'MemberA',
    password: '123456',
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION
  }));
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.kind, 'session_issued');
  assert(/^v2\.K2\.[A-Za-z0-9_-]{43}$/.test(result.sessionToken));
  assert.deepStrictEqual({
    ...result,
    sessionToken: '<token>'
  }, {
    ok: true,
    kind: 'session_issued',
    sessionToken: '<token>',
    account: 'MemberA',
    accountDisplay: 'MemberA',
    roles: ['member'],
    currentRole: 'member',
    authenticatedAt: BASE_MS,
    authenticationMethod: 'password'
  });

  assert.strictEqual(state.accounts.length, 1);
  assert(/^acct_[A-Za-z0-9_-]{22,}$/.test(state.accounts[0]._id));
  assert.deepStrictEqual(
    Object.keys(state.accounts[0]).sort(),
    [
      '_id',
      'accountNameBindingId',
      'authVersion',
      'createdAt',
      'emailBindingId',
      'passwordAlgorithm',
      'passwordHash',
      'passwordSalt',
      'phoneBindingId',
      'privacyAcceptedAt',
      'privacyVersion',
      'status',
      'termsAcceptedAt',
      'termsVersion',
      'updatedAt',
      'wechatBindingId'
    ].sort()
  );
  assert.strictEqual(state.accounts[0].termsVersion, TERMS_VERSION);
  assert.strictEqual(state.accounts[0].privacyVersion, PRIVACY_VERSION);
  assert.strictEqual(
    state.accounts[0].termsAcceptedAt.getTime(),
    BASE_MS
  );
  assert.strictEqual(
    state.accounts[0].privacyAcceptedAt.getTime(),
    BASE_MS
  );
  assert.strictEqual(state.account_names.length, 1);
  assert.strictEqual(
    state.account_names[0]._id,
    sha256('account-name:v1:membera')
  );
  assert.strictEqual(state.users.length, 1);
  assert.deepStrictEqual(state.users[0].roles, ['member']);
  assert.strictEqual(state.auth_sessions.length, 1);
  assert.strictEqual(state.phone_bindings.length, 0);
  assert.strictEqual(state.wechat_bindings.length, 0);
  assert(
    fakeDb.__operations.every((operation) => (
      operation.collection !== 'wechat_bindings'
    )),
    'account-name registration must not access WeChat bindings'
  );
  assert(
    JSON.stringify(snapshot(state)).indexOf(result.sessionToken) === -1,
    'raw session token must never be persisted'
  );

  const registeredAccountId = state.accounts[0]._id;
  const duplicateBefore = snapshot(state);
  const duplicate = await atTime(BASE_MS + 1, () => entry.main({
    authProtocol: 2,
    action: 'registerAccountName',
    clientInstanceId: 'register-client-2',
    accountName: 'membera',
    password: 'another-password',
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION
  }));
  assert.strictEqual(duplicate.code, 'ACCOUNT_NAME_EXISTS');
  assert.deepStrictEqual(snapshot(state), duplicateBefore);

  const staleConsent = await entry.main({
    authProtocol: 2,
    action: 'loginPassword',
    clientInstanceId: 'password-client',
    identifier: 'MemberA',
    password: '123456',
    termsVersion: 'old-terms',
    privacyVersion: PRIVACY_VERSION
  });
  assert.strictEqual(staleConsent.code, 'INVALID_INPUT');
  assert.deepStrictEqual(snapshot(state), duplicateBefore);

  const maintenanceRequests = [
    {
      action: 'resetPasswordByWechat',
      clientInstanceId: 'maintenance-client',
      password: '123456'
    },
    {
      action: 'resetPasswordByEmail',
      clientInstanceId: 'maintenance-client',
      email: 'member@example.com',
      code: '123456',
      password: '123456'
    },
    {
      action: 'bindEmail',
      clientInstanceId: 'maintenance-client',
      sessionToken: 'supplied-but-never-read',
      email: 'member@example.com',
      code: '123456'
    },
    {
      action: 'reauthenticate',
      clientInstanceId: 'maintenance-client',
      sessionToken: 'supplied-but-never-read',
      method: 'email',
      code: '123456'
    }
  ];
  for (const request of maintenanceRequests) {
    const operationStart = fakeDb.__operations.length;
    const maintenance = await entry.main({
      authProtocol: 2,
      ...request
    });
    assert.deepStrictEqual(maintenance, {
      ok: false,
      code: 'AUTH_MAINTENANCE',
      msg: '认证服务维护中，请稍后重试'
    });
    assert.deepStrictEqual(
      fakeDb.__operations.slice(operationStart).map((operation) => (
        [operation.operation, operation.collection, operation.id]
      )),
      [['get', 'auth_control', 'main']],
      `${request.action} must stop before business reads`
    );
  }

  const smsOpenid = 'sms-login-openid';
  const smsEntry = loadAccountAuth(smsOpenid, state);
  const smsClient = 'sms-login-client';
  const phone = '13800138000';
  const normalizedPhone = '+8613800138000';
  const firstSmsAt = BASE_MS + 60 * 1000;
  const firstChallengeId = await createSentSmsChallenge({
    openid: smsOpenid,
    phone: normalizedPhone,
    purpose: 'login',
    clientInstanceId: smsClient,
    code: '654321',
    nowMs: firstSmsAt
  });
  const smsOperationStart = fakeDb.__operations.length;
  const firstSmsLogin = await atTime(firstSmsAt + 1, () => smsEntry.main({
    authProtocol: 2,
    action: 'loginSms',
    clientInstanceId: smsClient,
    phone,
    challengeId: firstChallengeId,
    code: '654321',
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION
  }));
  assert.deepStrictEqual({
    ...firstSmsLogin,
    sessionToken: '<token>'
  }, {
    ok: true,
    kind: 'session_issued',
    sessionToken: '<token>',
    account: '',
    accountDisplay: '138****8000',
    roles: ['member'],
    currentRole: 'member',
    authenticatedAt: firstSmsAt + 1,
    authenticationMethod: 'sms'
  });
  assert.strictEqual(state.accounts.length, 2);
  const phoneBinding = state.phone_bindings[0];
  assert(phoneBinding);
  assert(/^phone\.K2\.[A-Za-z0-9_-]{43}$/.test(phoneBinding._id));
  assert.strictEqual(phoneBinding.phoneMasked, '138****8000');
  assert.strictEqual(state.accounts[1].phoneBindingId, phoneBinding._id);
  assert.strictEqual(phoneBinding.accountId, state.accounts[1]._id);
  assert.strictEqual(
    JSON.stringify(phoneBinding).includes(phone),
    false,
    'phone binding must not contain the raw phone number'
  );
  assert(
    fakeDb.__operations.slice(smsOperationStart).every((operation) => (
      operation.collection !== 'wechat_bindings'
    )),
    'SMS login must not access WeChat bindings'
  );

  const secondSmsAt = firstSmsAt + 61 * 1000;
  const secondChallengeId = await createSentSmsChallenge({
    openid: smsOpenid,
    phone: normalizedPhone,
    purpose: 'login',
    clientInstanceId: smsClient,
    code: '112233',
    nowMs: secondSmsAt
  });
  const restored = await atTime(secondSmsAt + 1, () => smsEntry.main({
    authProtocol: 2,
    action: 'loginSms',
    clientInstanceId: smsClient,
    phone,
    challengeId: secondChallengeId,
    code: '112233',
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION
  }));
  assert.strictEqual(restored.ok, true);
  assert.strictEqual(restored.accountDisplay, '138****8000');
  assert.strictEqual(state.accounts.length, 2);
  assert.strictEqual(state.phone_bindings.length, 1);
  assert.strictEqual(state.auth_sessions.length, 3);

  const passwordEntry = loadAccountAuth('password-login-openid', state);
  const passwordOperationStart = fakeDb.__operations.length;
  const passwordLogin = await atTime(secondSmsAt + 2, () => (
    passwordEntry.main({
      authProtocol: 2,
      action: 'loginPassword',
      clientInstanceId: 'password-login-client',
      identifier: 'MemberA',
      password: '123456',
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION
    })
  ));
  assert.strictEqual(passwordLogin.ok, true);
  assert.strictEqual(passwordLogin.account, 'MemberA');
  assert.strictEqual(passwordLogin.authenticationMethod, 'password');
  assert.strictEqual(state.accounts[0]._id, registeredAccountId);
  assert(
    fakeDb.__operations.slice(passwordOperationStart).every((operation) => (
      operation.collection !== 'wechat_bindings'
    )),
    'password login must not access WeChat bindings'
  );

  for (const [identifier, password] of [
    ['UnknownMember', '123456'],
    ['MemberA', 'wrong-password'],
    ['###', '123456'],
    ['13800138000', '123456']
  ]) {
    const rejected = await atTime(secondSmsAt + 3, () => (
      passwordEntry.main({
        authProtocol: 2,
        action: 'loginPassword',
        clientInstanceId: 'password-login-client',
        identifier,
        password,
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION
      })
    ));
    assert.strictEqual(rejected.code, 'INVALID_CREDENTIALS');
  }

  let limited;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    limited = await atTime(secondSmsAt + 10 + attempt, () => (
      passwordEntry.main({
        authProtocol: 2,
        action: 'loginPassword',
        clientInstanceId: 'password-rate-client',
        identifier: 'RateTarget',
        password: 'wrong-password',
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION
      })
    ));
  }
  assert.strictEqual(limited.code, 'PASSWORD_RATE_LIMITED');
  assert(
    state.password_rate_limits.length >= 3,
    'password failures must persist all three rate dimensions'
  );
  assert.strictEqual(
    JSON.stringify(state.password_rate_limits).includes('RateTarget'),
    false,
    'password rate records must not contain the raw identifier'
  );

  const displayState = makeState(snapshot(state));
  displayState.account_names[0].account = 'DifferentName';
  const displayBefore = snapshot(displayState);
  const displayFailure = await atTime(secondSmsAt + 100, () => (
    loadAccountAuth('display-integrity-openid', displayState).main({
      authProtocol: 2,
      action: 'loginPassword',
      clientInstanceId: 'display-integrity-client',
      identifier: 'MemberA',
      password: '123456',
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION
    })
  ));
  assert.strictEqual(displayFailure.code, 'AUTH_INTERNAL_ERROR');
  assert.deepStrictEqual(snapshot(displayState), displayBefore);

  const corruptSmsState = makeState(snapshot(state));
  const corruptPhoneAccount = findById(
    corruptSmsState.accounts,
    phoneBinding.accountId
  );
  corruptPhoneAccount.passwordAlgorithm = 'plaintext';
  corruptPhoneAccount.passwordSalt = 'raw-salt';
  corruptPhoneAccount.passwordHash = 'raw-password';
  const corruptOpenid = 'corrupt-sms-openid';
  const corruptEntry = loadAccountAuth(corruptOpenid, corruptSmsState);
  const corruptSmsAt = secondSmsAt + 61 * 1000;
  const corruptChallenge = await createSentSmsChallenge({
    openid: corruptOpenid,
    phone: normalizedPhone,
    purpose: 'login',
    clientInstanceId: 'corrupt-sms-client',
    code: '445566',
    nowMs: corruptSmsAt
  });
  const corruptBefore = snapshot(corruptSmsState);
  const corruptResult = await atTime(corruptSmsAt + 1, () => (
    corruptEntry.main({
      authProtocol: 2,
      action: 'loginSms',
      clientInstanceId: 'corrupt-sms-client',
      phone,
      challengeId: corruptChallenge,
      code: '445566',
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION
    })
  ));
  assert.strictEqual(corruptResult.code, 'AUTH_INTERNAL_ERROR');
  assert.deepStrictEqual(snapshot(corruptSmsState), corruptBefore);

  const spacedPhone = await atTime(secondSmsAt + 101, () => (
    passwordEntry.main({
      authProtocol: 2,
      action: 'loginPassword',
      clientInstanceId: 'spaced-phone-client',
      identifier: ' 13800138000 ',
      password: '123456',
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION
    })
  ));
  assert.strictEqual(spacedPhone.code, 'INVALID_CREDENTIALS');

  await testAccountCoreIntegrity();
  await testSmsChallengeIntegrity();
  await testPasswordRateDimensions();
  await testDeletionGraceCancellation();
  await testWechatEntryFlow();
  await testSecurityActions();
  await testSecurityKeyRotation();
  await testSecurityChallengeRotation();
  console.log('ACCOUNT_WECHAT_BINDING_V2_RED_GREEN_OK');
}

if (require.main === module) {
  runV2().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  clone,
  findById,
  findAccount,
  loadAccountAuth,
  makeState,
  sha256,
  snapshot,
  getFakeDb: () => fakeDb
};
