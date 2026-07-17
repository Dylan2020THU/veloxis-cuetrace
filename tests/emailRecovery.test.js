'use strict';

const assert = require('assert');
const crypto = require('crypto');
const Module = require('module');
const path = require('path');

const {
  clone,
  findById,
  getFakeDb,
  loadAccountAuth,
  makeState,
  snapshot
} = require('./accountWechatBinding.test');
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
  requireSession
} = require('../cloudfunctions/accountAuth/lib/auth/session');

const sendEmailCodePath = path.resolve(
  __dirname,
  '..',
  'cloudfunctions',
  'sendEmailCode',
  'index.js'
);
const BASE_MS = Date.parse('2026-07-16T12:00:00.000Z');
const TERMS_VERSION = '2026-07-15';
const PRIVACY_VERSION = '2026-07-15';
const TEST_SECRET = 'email-recovery-v2-test-secret';
const PUBLIC_RESET_RESULT = Object.freeze({
  ok: true,
  accepted: true,
  msg: '若信息匹配，验证码将发送至绑定邮箱'
});
const EMAIL_ENV_KEYS = Object.freeze([
  'CUETRACE_SES_SECRET_ID',
  'CUETRACE_SES_SECRET_KEY',
  'CUETRACE_SES_REGION',
  'CUETRACE_SES_FROM_EMAIL',
  'CUETRACE_SES_TEMPLATE_ID',
  'CUETRACE_SES_SUBJECT',
  'CUETRACE_SES_REPLY_TO',
  'CUETRACE_EMAIL_CODE_SECRET'
]);
const AUTH_ENV_KEYS = Object.freeze([
  'CUETRACE_AUTH_KEY_ACTIVE_VERSION',
  'CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS',
  'CUETRACE_AUTH_KEY_K1',
  'CUETRACE_AUTH_KEY_K2'
]);

function configureEnvironment(overrides) {
  const values = Object.assign({
    CUETRACE_AUTH_KEY_ACTIVE_VERSION: 'K2',
    CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS: '',
    CUETRACE_AUTH_KEY_K1: '',
    CUETRACE_AUTH_KEY_K2: Buffer.alloc(32, 0x42).toString('base64'),
    CUETRACE_SES_SECRET_ID: 'test-secret-id',
    CUETRACE_SES_SECRET_KEY: 'test-secret-key',
    CUETRACE_SES_REGION: 'ap-guangzhou',
    CUETRACE_SES_FROM_EMAIL: '强化杆迹 <noreply@example.com>',
    CUETRACE_SES_TEMPLATE_ID: '12345',
    CUETRACE_SES_SUBJECT: '强化杆迹验证码',
    CUETRACE_SES_REPLY_TO: '',
    CUETRACE_EMAIL_CODE_SECRET: TEST_SECRET
  }, overrides || {});
  for (const key of [...AUTH_ENV_KEYS, ...EMAIL_ENV_KEYS]) {
    process.env[key] = values[key] || '';
  }
}

function saveEnvironment(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnvironment(saved) {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function emailBindingId(email) {
  return sha256('email:' + normalizeEmail(email));
}

function emailCodeId(purpose, email) {
  return sha256('email-code:' + purpose + ':' + normalizeEmail(email));
}

function maskEmail(email) {
  const normalized = normalizeEmail(email);
  const separator = normalized.lastIndexOf('@');
  const local = normalized.slice(0, separator);
  const domain = normalized.slice(separator + 1);
  return local.slice(0, 2)
    + '*'.repeat(Math.max(2, local.length - 2))
    + '@'
    + domain;
}

function atTime(nowMs, callback) {
  const originalNow = Date.now;
  Date.now = () => nowMs;
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      Date.now = originalNow;
    });
}

async function withImmediateTimers(startedAt, callback) {
  const originalSetTimeout = global.setTimeout;
  const originalNow = Date.now;
  const delays = [];
  let now = startedAt;
  global.setTimeout = (handler, delay) => {
    delays.push(delay);
    now += delay;
    handler();
    return 1;
  };
  Date.now = () => now;
  try {
    const result = await callback({
      advance(milliseconds) {
        now += milliseconds;
      },
      now() {
        return now;
      }
    });
    return {
      result,
      delays,
      elapsed: now - startedAt
    };
  } finally {
    global.setTimeout = originalSetTimeout;
    Date.now = originalNow;
  }
}

function timeValue(value) {
  if (value instanceof Date) return value.getTime();
  return Number(value);
}

function assertPublicTiming(timed, expectedDelay) {
  assert.deepStrictEqual(timed.result, PUBLIC_RESET_RESULT);
  assert.deepStrictEqual(timed.delays, [expectedDelay]);
  assert.strictEqual(timed.elapsed, 9500);
}

function assertNoSecrets(value, secrets) {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) {
    assert.strictEqual(
      serialized.includes(secret),
      false,
      'secret leaked: ' + secret
    );
  }
}

function loadSendEmailCode(state, options) {
  const config = options || {};
  const clientConfigs = [];
  const sendCalls = [];
  const randomCalls = [];
  const codeNumbers = Array.isArray(config.codeNumbers)
    ? [...config.codeNumbers]
    : [];
  let wxContextCalls = 0;

  loadAccountAuth('email-send-bootstrap-openid', state);
  const db = getFakeDb();
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database() {
      return db;
    },
    getWXContext() {
      wxContextCalls += 1;
      throw new Error('sendEmailCode must not read WXContext');
    }
  };
  const fakeSes = {
    ses: {
      v20201002: {
        Client: class FakeSesClient {
          constructor(clientConfig) {
            if (config.clientError) throw config.clientError;
            clientConfigs.push(clientConfig);
          }

          async SendEmail(params) {
            sendCalls.push(clone(params));
            if (config.sendEmail) {
              return config.sendEmail(params, sendCalls.length);
            }
            return { RequestId: 'ses-request-id-' + sendCalls.length };
          }
        }
      }
    }
  };
  const fakeCrypto = Object.assign({}, crypto, {
    randomInt(min, max) {
      randomCalls.push({ method: 'randomInt', min, max });
      assert.strictEqual(min, 0);
      assert.strictEqual(max, 1000000);
      if (codeNumbers.length) return codeNumbers.shift();
      return config.codeNumber === undefined ? 123456 : config.codeNumber;
    },
    randomBytes(size) {
      randomCalls.push({ method: 'randomBytes', size });
      if (config.randomBytes) return config.randomBytes(size, randomCalls.length);
      return crypto.randomBytes(size);
    }
  });
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'wx-server-sdk') return fakeCloud;
    if (request === 'tencentcloud-sdk-nodejs-ses') return fakeSes;
    if (request === 'crypto') return fakeCrypto;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[sendEmailCodePath];
    const loaded = require(sendEmailCodePath);
    return {
      main: loaded.main,
      db,
      clientConfigs,
      sendCalls,
      randomCalls,
      get wxContextCalls() {
        return wxContextCalls;
      }
    };
  } finally {
    Module._load = originalLoad;
  }
}

function loadAccountFixture(state, openid, unionid) {
  const loaded = loadAccountAuth(openid, state, unionid);
  return {
    main: loaded.main,
    db: getFakeDb()
  };
}

async function registerNamedAccount(options) {
  const state = options.state;
  const fixture = loadAccountFixture(
    state,
    options.openid || 'register-openid'
  );
  const nowMs = options.nowMs || BASE_MS;
  const clientInstanceId = options.clientInstanceId || 'register-client';
  const result = await atTime(nowMs, () => fixture.main({
    authProtocol: 2,
    action: 'registerAccountName',
    clientInstanceId,
    accountName: options.accountName,
    password: options.password || 'old-password',
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION
  }));
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.kind, 'session_issued');
  const relation = state.account_names.find(
    (item) => item.accountNormalized === options.accountName.toLowerCase()
  );
  assert(relation, 'registration must create account-name relation');
  const account = findById(state.accounts, relation.accountId);
  const user = findById(state.users, relation.accountId);
  assert(account);
  assert(user);
  return {
    state,
    fixture,
    account,
    user,
    result,
    sessionToken: result.sessionToken,
    clientInstanceId,
    nowMs
  };
}

async function createSentSmsChallenge(options) {
  const keyring = loadKeyring(process.env);
  const identity = wechatIdentity({
    APPID: 'wx-test-app',
    OPENID: options.openid
  });
  const now = new Date(options.nowMs);
  const claim = await options.db.runTransaction((transaction) => (
    claimSmsChallenge({
      transaction,
      phone: options.phone,
      purpose: 'login',
      scope: {
        purpose: 'login',
        clientInstanceId: options.clientInstanceId,
        wechatBindingInput: identity.bindingInput,
        accountId: '',
        sessionId: ''
      },
      wxIdentity: identity,
      now,
      keyring
    })
  ));
  const finalized = await options.db.runTransaction((transaction) => (
    finalizeSmsSend({
      transaction,
      claim,
      providerResult: {
        status: 'sent',
        code: options.code
      },
      now,
      keyring
    })
  ));
  assert.strictEqual(finalized.ok, true);
  return claim.challengeId;
}

async function loginPhoneSession(options) {
  const fixture = options.fixture || loadAccountFixture(
    options.state,
    options.openid
  );
  const challengeId = await createSentSmsChallenge({
    db: fixture.db,
    openid: options.openid,
    phone: options.normalizedPhone,
    clientInstanceId: options.clientInstanceId,
    code: options.code,
    nowMs: options.nowMs
  });
  const result = await atTime(options.nowMs + 1, () => fixture.main({
    authProtocol: 2,
    action: 'loginSms',
    clientInstanceId: options.clientInstanceId,
    phone: options.phone,
    challengeId,
    code: options.code,
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION
  }));
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.kind, 'session_issued');
  const phoneBinding = statePhoneBinding(options.state, options.normalizedPhone);
  const account = findById(options.state.accounts, phoneBinding.accountId);
  return {
    fixture,
    result,
    sessionToken: result.sessionToken,
    account,
    phoneBinding
  };
}

function statePhoneBinding(state, normalizedPhone) {
  const candidates = candidateHmacIds(
    loadKeyring(process.env),
    'phone-binding',
    normalizedPhone,
    'phone'
  );
  const binding = state.phone_bindings.find((item) => (
    candidates.some((candidate) => candidate.id === item._id)
    && item.status === 'active'
  ));
  assert(binding, 'phone binding must exist');
  return binding;
}

function addActiveEmailBinding(state, account, email, nowMs) {
  const normalized = normalizeEmail(email);
  const id = emailBindingId(normalized);
  const binding = {
    _id: id,
    accountId: account._id,
    email: normalized,
    emailNormalized: normalized,
    status: 'active',
    boundAt: new Date(nowMs),
    updatedAt: new Date(nowMs)
  };
  const index = state.email_bindings.findIndex((item) => item._id === id);
  if (index === -1) state.email_bindings.push(binding);
  else state.email_bindings[index] = binding;
  account.emailBindingId = id;
  account.updatedAt = new Date(nowMs);
  return binding;
}

function addPhoneBinding(state, account, phone, nowMs) {
  const candidate = candidateHmacIds(
    loadKeyring(process.env),
    'phone-binding',
    phone,
    'phone'
  )[0];
  const national = phone.slice(3);
  const binding = {
    _id: candidate.id,
    accountId: account._id,
    keyVersion: candidate.keyVersion,
    phoneMasked: national.slice(0, 3) + '****' + national.slice(-4),
    status: 'active',
    verifiedAt: new Date(nowMs),
    createdAt: new Date(nowMs),
    updatedAt: new Date(nowMs)
  };
  state.phone_bindings.push(binding);
  account.phoneBindingId = binding._id;
  return binding;
}

function wechatMaterialFor(openid, unionid, keyring) {
  const context = {
    APPID: 'wx-test-app',
    OPENID: openid,
    ...(unionid ? { UNIONID: unionid } : {})
  };
  const identity = wechatIdentity(context);
  const bindings = candidateHmacIds(
    keyring,
    'wechat-binding',
    identity.bindingInput,
    'wechat'
  );
  const appids = candidateHmacIds(
    keyring,
    'wechat-binding',
    context.APPID,
    'wechat-appid'
  );
  const openids = candidateHmacIds(
    keyring,
    'wechat-binding',
    context.OPENID,
    'wechat-openid'
  );
  const unionids = unionid
    ? candidateHmacIds(
      keyring,
      'wechat-binding',
      unionid,
      'wechat-unionid'
    )
    : [];
  return bindings.map((candidate) => ({
    ...candidate,
    appidHash: appids.find(
      (item) => item.keyVersion === candidate.keyVersion
    ).id,
    openidHash: openids.find(
      (item) => item.keyVersion === candidate.keyVersion
    ).id,
    unionidHash: unionid
      ? unionids.find(
        (item) => item.keyVersion === candidate.keyVersion
      ).id
      : ''
  }));
}

function addWechatBinding(
  state,
  account,
  openid,
  unionid,
  nowMs,
  keyVersion
) {
  const materials = wechatMaterialFor(
    openid,
    unionid,
    loadKeyring(process.env)
  );
  const material = keyVersion
    ? materials.find((item) => item.keyVersion === keyVersion)
    : materials[0];
  assert(material, 'requested WeChat key version must exist');
  const binding = {
    _id: material.id,
    accountId: account._id,
    keyVersion: material.keyVersion,
    appidHash: material.appidHash,
    openidHash: material.openidHash,
    unionidHash: material.unionidHash,
    status: 'active',
    consentedAt: new Date(nowMs),
    createdAt: new Date(nowMs),
    updatedAt: new Date(nowMs)
  };
  state.wechat_bindings.push(binding);
  account.wechatBindingId = binding._id;
  return binding;
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

function markPurging(state, accountId) {
  const user = findById(state.users, accountId);
  user.deletionStatus = 'purging';
}

function assertOnlyProtocolRead(operations) {
  assert.deepStrictEqual(
    operations.map((operation) => [
      operation.operation,
      operation.collection,
      operation.id,
      operation.transactionMode
    ]),
    [['get', 'auth_control', 'main', false]]
  );
}

function assertSessionReadTwice(operations, sessionId) {
  for (const collection of ['auth_sessions', 'accounts', 'users']) {
    const reads = operations.filter((operation) => (
      operation.operation === 'get'
      && operation.collection === collection
      && (
        collection !== 'auth_sessions'
        || operation.id === sessionId
      )
    ));
    assert(
      reads.some((operation) => operation.transactionMode === false),
      collection + ' must be read during session preflight'
    );
    assert(
      reads.some((operation) => operation.transactionMode === true),
      collection + ' must be reread in reservation transaction'
    );
  }
}

async function sendAndBind(options) {
  const sendFixture = loadSendEmailCode(options.state, {
    codeNumber: options.codeNumber === undefined
      ? 123456
      : options.codeNumber
  });
  const sent = await atTime(options.nowMs, () => sendFixture.main({
    authProtocol: 2,
    clientInstanceId: options.clientInstanceId,
    purpose: 'bind',
    email: options.email,
    sessionToken: options.sessionToken
  }));
  assert.deepStrictEqual(sent, {
    ok: true,
    accepted: true,
    msg: '验证码已发送'
  });
  const accountFixture = loadAccountFixture(
    options.state,
    options.openid || 'bind-account-openid'
  );
  const bound = await atTime(options.nowMs + 1, () => accountFixture.main({
    authProtocol: 2,
    action: 'bindEmail',
    clientInstanceId: options.clientInstanceId,
    sessionToken: options.sessionToken,
    email: options.email,
    code: String(
      options.codeNumber === undefined ? 123456 : options.codeNumber
    ).padStart(6, '0')
  }));
  return {
    sent,
    bound,
    sendFixture,
    accountFixture
  };
}

async function sendPublicReset(options) {
  let advanceProvider = () => {};
  const fixture = loadSendEmailCode(options.state, {
    codeNumber: options.codeNumber,
    clientError: options.clientError,
    sendEmail: options.sendEmail
      ? () => options.sendEmail(advanceProvider)
      : undefined
  });
  if (options.beforeCall) options.beforeCall(fixture);
  const timed = await withImmediateTimers(
    options.nowMs,
    (clock) => {
      advanceProvider = clock.advance;
      return fixture.main({
        authProtocol: 2,
        clientInstanceId: options.clientInstanceId,
        purpose: 'reset',
        email: options.email
      });
    }
  );
  return { fixture, timed };
}

async function withTransactionWriteFailure(
  db,
  collectionName,
  operationName,
  callback
) {
  const originalRunTransaction = db.runTransaction.bind(db);
  db.runTransaction = (handler) => originalRunTransaction(async (transaction) => {
    const originalCollection = transaction.collection.bind(transaction);
    transaction.collection = (name) => {
      const collection = originalCollection(name);
      if (name !== collectionName) return collection;
      const originalDoc = collection.doc.bind(collection);
      collection.doc = (id) => {
        const ref = originalDoc(id);
        ref[operationName] = async () => {
          const error = new Error('simulated later transaction write failure');
          error.code = 'DATABASE_REQUEST_FAILED';
          throw error;
        };
        return ref;
      };
      return collection;
    };
    return handler(transaction);
  });
  try {
    return await callback();
  } finally {
    db.runTransaction = originalRunTransaction;
  }
}

function assertBindingV2(binding, accountId, email) {
  assert(binding);
  assert.strictEqual(binding.accountId, accountId);
  assert.strictEqual(binding.email, normalizeEmail(email));
  assert.strictEqual(binding.emailNormalized, normalizeEmail(email));
  assert.strictEqual(binding.status, 'active');
  assert(binding.boundAt instanceof Date);
  assert(binding.updatedAt instanceof Date);
  for (const forbidden of [
    '_openid',
    'account',
    'accountNormalized',
    'emailMasked',
    'verifiedAt',
    'createdAt'
  ]) {
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(binding, forbidden),
      false,
      'binding must not contain ' + forbidden
    );
  }
}

function findChallenge(state, purpose, email) {
  return findById(state.email_codes, emailCodeId(purpose, email));
}

async function testStrictSendUnionAndProtocolFirst() {
  const state = makeState();
  const fixture = loadSendEmailCode(state);
  const oldProtocolStart = fixture.db.__operations.length;
  const oldProtocol = await withImmediateTimers(BASE_MS, () => fixture.main({
    authProtocol: 1,
    clientInstanceId: 'strict-client',
    purpose: 'reset',
    email: 'strict@example.com',
    account: 'forged-account'
  }));
  assert.strictEqual(oldProtocol.result.code, 'CLIENT_UPDATE_REQUIRED');
  assertOnlyProtocolRead(
    fixture.db.__operations.slice(oldProtocolStart)
  );
  assert.strictEqual(fixture.clientConfigs.length, 0);
  assert.strictEqual(fixture.sendCalls.length, 0);
  assert.strictEqual(fixture.randomCalls.length, 0);
  assert.strictEqual(fixture.wxContextCalls, 0);

  const invalidRequests = [
    {
      label: 'reset forbids account',
      request: {
        authProtocol: 2,
        clientInstanceId: 'strict-client',
        purpose: 'reset',
        email: 'strict@example.com',
        account: 'forged'
      }
    },
    {
      label: 'reset forbids session',
      request: {
        authProtocol: 2,
        clientInstanceId: 'strict-client',
        purpose: 'reset',
        email: 'strict@example.com',
        sessionToken: 'forged'
      }
    },
    {
      label: 'reset forbids legacy action',
      request: {
        authProtocol: 2,
        clientInstanceId: 'strict-client',
        purpose: 'reset',
        email: 'strict@example.com',
        action: 'send'
      }
    },
    {
      label: 'bind requires email',
      request: {
        authProtocol: 2,
        clientInstanceId: 'strict-client',
        purpose: 'bind',
        sessionToken: 'forged'
      }
    },
    {
      label: 'reauth forbids email',
      request: {
        authProtocol: 2,
        clientInstanceId: 'strict-client',
        purpose: 'reauth',
        sessionToken: 'forged',
        email: 'replacement@example.com'
      }
    },
    {
      label: 'unknown purpose',
      request: {
        authProtocol: 2,
        clientInstanceId: 'strict-client',
        purpose: 'login',
        email: 'strict@example.com'
      }
    },
    {
      label: 'empty client instance',
      request: {
        authProtocol: 2,
        clientInstanceId: '',
        purpose: 'reset',
        email: 'strict@example.com'
      }
    },
    {
      label: 'surplus field',
      request: {
        authProtocol: 2,
        clientInstanceId: 'strict-client',
        purpose: 'reset',
        email: 'strict@example.com',
        extra: true
      }
    }
  ];
  for (const testCase of invalidRequests) {
    const operationStart = fixture.db.__operations.length;
    const randomStart = fixture.randomCalls.length;
    const clientStart = fixture.clientConfigs.length;
    const sendStart = fixture.sendCalls.length;
    const result = await fixture.main(testCase.request);
    assert.strictEqual(
      result.code,
      'INVALID_INPUT',
      testCase.label
    );
    assertOnlyProtocolRead(
      fixture.db.__operations.slice(operationStart)
    );
    assert.strictEqual(fixture.randomCalls.length, randomStart);
    assert.strictEqual(fixture.clientConfigs.length, clientStart);
    assert.strictEqual(fixture.sendCalls.length, sendStart);
    assert.strictEqual(fixture.wxContextCalls, 0);
  }

  for (const purpose of ['bind', 'reauth']) {
    const operationStart = fixture.db.__operations.length;
    const result = await fixture.main({
      authProtocol: 2,
      clientInstanceId: 'strict-client',
      purpose,
      ...(purpose === 'bind'
        ? { email: 'strict@example.com' }
        : {})
    });
    assert.strictEqual(result.code, 'SESSION_REQUIRED');
    assertOnlyProtocolRead(
      fixture.db.__operations.slice(operationStart)
    );
  }
}

async function testSessionSendScopesAndLiveReread() {
  const state = makeState();
  const registered = await registerNamedAccount({
    state,
    accountName: 'SessionMail',
    openid: 'session-mail-openid',
    clientInstanceId: 'session-register-client',
    nowMs: BASE_MS
  });
  const sendFixture = loadSendEmailCode(state);
  const operationStart = sendFixture.db.__operations.length;
  const sent = await atTime(BASE_MS + 1000, () => sendFixture.main({
    authProtocol: 2,
    clientInstanceId: 'session-bind-client',
    purpose: 'bind',
    email: ' Session@Target.Example ',
    sessionToken: registered.sessionToken
  }));
  assert.deepStrictEqual(sent, {
    ok: true,
    accepted: true,
    msg: '验证码已发送'
  });
  assert.strictEqual(sendFixture.wxContextCalls, 0);
  const sessionId = state.auth_sessions[0]._id;
  assertSessionReadTwice(
    sendFixture.db.__operations.slice(operationStart),
    sessionId
  );
  const challenge = findChallenge(
    state,
    'bind',
    'session@target.example'
  );
  assert(challenge);
  assert.strictEqual(challenge.accountId, registered.account._id);
  assert.strictEqual(
    challenge.emailBindingId,
    emailBindingId('session@target.example')
  );
  assert.strictEqual(challenge.targetHash, challenge.emailBindingId);
  assert.strictEqual(challenge.status, 'active');
  assert.strictEqual(challenge.attemptsLeft, 5);
  assert.strictEqual(typeof challenge.scopeHash, 'string');
  assert(challenge.scopeHash.length > 0);
  assertNoSecrets(challenge, [
    'session@target.example',
    registered.sessionToken,
    'session-bind-client',
    '123456'
  ]);

  addActiveEmailBinding(
    state,
    findById(state.accounts, registered.account._id),
    'existing@example.com',
    BASE_MS + 2000
  );
  const strictReauth = loadSendEmailCode(state);
  const strictResult = await strictReauth.main({
    authProtocol: 2,
    clientInstanceId: 'reauth-send-client',
    purpose: 'reauth',
    sessionToken: registered.sessionToken,
    email: 'replacement@example.com'
  });
  assert.strictEqual(strictResult.code, 'INVALID_INPUT');
  assert.strictEqual(strictReauth.sendCalls.length, 0);

  const reauthFixture = loadSendEmailCode(state);
  const reauthOperationStart = reauthFixture.db.__operations.length;
  const reauthSent = await atTime(BASE_MS + 3000, () => reauthFixture.main({
    authProtocol: 2,
    clientInstanceId: 'reauth-send-client',
    purpose: 'reauth',
    sessionToken: registered.sessionToken
  }));
  assert.deepStrictEqual(reauthSent, {
    ok: true,
    accepted: true,
    msg: '验证码已发送'
  });
  assert.deepStrictEqual(
    reauthFixture.sendCalls[0].Destination,
    ['existing@example.com']
  );
  assertSessionReadTwice(
    reauthFixture.db.__operations.slice(reauthOperationStart),
    sessionId
  );
  assert.strictEqual(reauthFixture.wxContextCalls, 0);

  const malformedEmailState = makeState(snapshot(state));
  findById(
    malformedEmailState.email_bindings,
    emailBindingId('existing@example.com')
  ).emailMasked = 'ex*****@example.com';
  const malformedEmailFixture = loadSendEmailCode(
    malformedEmailState
  );
  const malformedEmailBefore = snapshot(malformedEmailState);
  const malformedEmail = await atTime(BASE_MS + 64 * 1000, () => (
    malformedEmailFixture.main({
      authProtocol: 2,
      clientInstanceId: 'reauth-send-client',
      purpose: 'reauth',
      sessionToken: registered.sessionToken
    })
  ));
  assert.strictEqual(malformedEmail.code, 'AUTH_INTERNAL_ERROR');
  assert.strictEqual(malformedEmailFixture.sendCalls.length, 0);
  assert.deepStrictEqual(
    snapshot(malformedEmailState),
    malformedEmailBefore
  );

  const tamperedState = makeState(snapshot(state));
  const tamperedFixture = loadSendEmailCode(tamperedState);
  tamperedFixture.db.beforeTransaction = (workingState) => {
    const live = findById(
      workingState.auth_sessions,
      tamperedState.auth_sessions[0]._id
    );
    live.authVersion += 1;
  };
  const tamperedBefore = snapshot(tamperedState);
  const tampered = await atTime(BASE_MS + 4000, () => tamperedFixture.main({
    authProtocol: 2,
    clientInstanceId: 'tampered-bind-client',
    purpose: 'bind',
    email: 'tampered@example.com',
    sessionToken: registered.sessionToken
  }));
  assert.strictEqual(tampered.code, 'SESSION_EXPIRED');
  assert.strictEqual(tamperedFixture.sendCalls.length, 0);
  assert.deepStrictEqual(snapshot(tamperedState), tamperedBefore);

  const malformedAccountState = makeState(snapshot(state));
  const malformedAccountFixture = loadSendEmailCode(
    malformedAccountState
  );
  malformedAccountFixture.db.beforeTransaction = (workingState) => {
    findById(
      workingState.accounts,
      registered.account._id
    ).phoneBindingId = null;
  };
  const malformedAccountBefore = snapshot(malformedAccountState);
  const malformedAccount = await atTime(BASE_MS + 4500, () => (
    malformedAccountFixture.main({
      authProtocol: 2,
      clientInstanceId: 'malformed-account-client',
      purpose: 'bind',
      email: 'malformed-account@example.com',
      sessionToken: registered.sessionToken
    })
  ));
  assert.strictEqual(malformedAccount.code, 'SESSION_EXPIRED');
  assert.strictEqual(malformedAccountFixture.sendCalls.length, 0);
  assert.deepStrictEqual(
    snapshot(malformedAccountState),
    malformedAccountBefore
  );

  const malformedUserState = makeState(snapshot(state));
  const malformedUserFixture = loadSendEmailCode(malformedUserState);
  malformedUserFixture.db.beforeTransaction = (workingState) => {
    findById(
      workingState.users,
      registered.account._id
    ).currentRole = 'administrator';
  };
  const malformedUserBefore = snapshot(malformedUserState);
  const malformedUser = await atTime(BASE_MS + 5000, () => (
    malformedUserFixture.main({
      authProtocol: 2,
      clientInstanceId: 'malformed-user-client',
      purpose: 'bind',
      email: 'malformed-user@example.com',
      sessionToken: registered.sessionToken
    })
  ));
  assert.strictEqual(malformedUser.code, 'SESSION_EXPIRED');
  assert.strictEqual(malformedUserFixture.sendCalls.length, 0);
  assert.deepStrictEqual(
    snapshot(malformedUserState),
    malformedUserBefore
  );

  const purgingState = makeState(snapshot(state));
  markPurging(purgingState, registered.account._id);
  const purgingFixture = loadSendEmailCode(purgingState);
  const purging = await purgingFixture.main({
    authProtocol: 2,
    clientInstanceId: 'purging-bind-client',
    purpose: 'bind',
    email: 'purging@example.com',
    sessionToken: registered.sessionToken
  });
  assert.strictEqual(purging.code, 'ACCOUNT_DELETION_LOCKED');
  assert.strictEqual(purgingFixture.sendCalls.length, 0);
}

async function testBindingReplacementIntegrityRollbackAndStatus() {
  const state = makeState();
  const first = await registerNamedAccount({
    state,
    accountName: 'EmailOwner',
    openid: 'email-owner-openid',
    clientInstanceId: 'email-owner-register',
    nowMs: BASE_MS
  });
  const other = await registerNamedAccount({
    state,
    accountName: 'OtherOwner',
    openid: 'other-owner-openid',
    clientInstanceId: 'other-owner-register',
    nowMs: BASE_MS + 1
  });

  const missingReverseState = makeState(snapshot(state));
  const missingReverseEmail = 'missing-reverse@example.com';
  findById(
    missingReverseState.accounts,
    other.account._id
  ).emailBindingId = emailBindingId(missingReverseEmail);
  const missingReverseFixture = loadSendEmailCode(
    missingReverseState
  );
  const missingReverseBefore = snapshot(missingReverseState);
  const missingReverse = await atTime(BASE_MS + 1000, () => (
    missingReverseFixture.main({
      authProtocol: 2,
      clientInstanceId: 'missing-reverse-client',
      purpose: 'bind',
      email: missingReverseEmail,
      sessionToken: first.sessionToken
    })
  ));
  assert.strictEqual(missingReverse.code, 'AUTH_INTERNAL_ERROR');
  assert.strictEqual(missingReverseFixture.sendCalls.length, 0);
  assert.deepStrictEqual(
    snapshot(missingReverseState),
    missingReverseBefore
  );

  const firstEmail = 'first.long@example.com';
  const firstBound = await sendAndBind({
    state,
    email: ' First.Long@Example.com ',
    sessionToken: first.sessionToken,
    clientInstanceId: 'owner-bind-client',
    nowMs: BASE_MS + 2000
  });
  assert.deepStrictEqual(firstBound.bound, {
    ok: true,
    kind: 'security_mutation',
    operation: 'bind_email',
    account: 'EmailOwner',
    accountDisplay: 'EmailOwner',
    accountNameSet: true,
    passwordSet: true,
    phoneBound: false,
    phoneMasked: '',
    emailBound: true,
    emailMasked: maskEmail(firstEmail),
    wechatBound: false
  });
  const firstBinding = findById(
    state.email_bindings,
    emailBindingId(firstEmail)
  );
  assertBindingV2(firstBinding, first.account._id, firstEmail);
  assert.strictEqual(
    findById(state.accounts, first.account._id).emailBindingId,
    firstBinding._id
  );
  assert.strictEqual(
    findChallenge(state, 'bind', firstEmail).status,
    'used'
  );

  const statusFixture = loadAccountFixture(
    state,
    'status-email-owner-openid'
  );
  const status = await atTime(BASE_MS + 3000, () => statusFixture.main({
    authProtocol: 2,
    action: 'status',
    clientInstanceId: 'owner-status-client',
    sessionToken: first.sessionToken
  }));
  assert.strictEqual(status.emailBound, true);
  assert.strictEqual(status.emailMasked, maskEmail(firstEmail));
  assert.deepStrictEqual(status.reauthMethods, ['password', 'email']);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(status, 'email'), false);

  const secondEmail = 'next@example.com';
  const replaced = await sendAndBind({
    state,
    email: secondEmail,
    sessionToken: first.sessionToken,
    clientInstanceId: 'owner-bind-client',
    nowMs: BASE_MS + 63 * 1000
  });
  assert.strictEqual(replaced.bound.ok, true);
  const revokedFirstBinding = findById(
    state.email_bindings,
    firstBinding._id
  );
  assert.strictEqual(revokedFirstBinding.status, 'revoked');
  assert(revokedFirstBinding.revokedAt instanceof Date);
  const secondBinding = findById(
    state.email_bindings,
    emailBindingId(secondEmail)
  );
  assertBindingV2(secondBinding, first.account._id, secondEmail);
  assert.strictEqual(
    findById(state.accounts, first.account._id).emailBindingId,
    secondBinding._id
  );

  const duplicateFixture = loadSendEmailCode(state);
  const duplicate = await atTime(BASE_MS + 125 * 1000, () => (
    duplicateFixture.main({
      authProtocol: 2,
      clientInstanceId: 'other-bind-client',
      purpose: 'bind',
      email: secondEmail,
      sessionToken: other.sessionToken
    })
  ));
  assert.strictEqual(duplicate.code, 'EMAIL_ALREADY_BOUND');
  assert.strictEqual(duplicateFixture.sendCalls.length, 0);

  const duplicateReverseState = makeState(snapshot(state));
  findById(
    duplicateReverseState.accounts,
    other.account._id
  ).emailBindingId = emailBindingId(secondEmail);
  const duplicateReverseReset = await sendPublicReset({
    state: duplicateReverseState,
    email: secondEmail,
    clientInstanceId: 'duplicate-reverse-reset-client',
    nowMs: BASE_MS + 126 * 1000
  });
  assertPublicTiming(duplicateReverseReset.timed, 9500);
  assert.strictEqual(duplicateReverseReset.fixture.sendCalls.length, 0);

  const corruptOwnerState = makeState(snapshot(state));
  findById(
    corruptOwnerState.email_bindings,
    emailBindingId(secondEmail)
  ).accountId = other.account._id;
  const corruptOwnerFixture = loadSendEmailCode(corruptOwnerState);
  const corruptOwnerBefore = snapshot(corruptOwnerState);
  const corruptOwner = await atTime(BASE_MS + 126 * 1000, () => (
    corruptOwnerFixture.main({
      authProtocol: 2,
      clientInstanceId: 'owner-bind-client',
      purpose: 'bind',
      email: secondEmail,
      sessionToken: first.sessionToken
    })
  ));
  assert.strictEqual(corruptOwner.code, 'AUTH_INTERNAL_ERROR');
  assert.strictEqual(corruptOwnerFixture.sendCalls.length, 0);
  assert.deepStrictEqual(snapshot(corruptOwnerState), corruptOwnerBefore);

  const staleReverseEmail = 'stale-reverse@example.com';
  const staleReverseSend = loadSendEmailCode(state);
  const staleReverseSent = await atTime(BASE_MS + 190 * 1000, () => (
    staleReverseSend.main({
      authProtocol: 2,
      clientInstanceId: 'stale-reverse-client',
      purpose: 'bind',
      email: staleReverseEmail,
      sessionToken: first.sessionToken
    })
  ));
  assert.strictEqual(staleReverseSent.ok, true);
  findById(
    state.accounts,
    other.account._id
  ).emailBindingId = emailBindingId(staleReverseEmail);
  const staleReverseBefore = snapshot(state);
  const staleReverseFixture = loadAccountFixture(
    state,
    'stale-reverse-caller'
  );
  const staleReverse = await atTime(
    BASE_MS + 190 * 1000 + 1,
    () => staleReverseFixture.main({
      authProtocol: 2,
      action: 'bindEmail',
      clientInstanceId: 'stale-reverse-client',
      sessionToken: first.sessionToken,
      email: staleReverseEmail,
      code: '123456'
    })
  );
  assert.strictEqual(staleReverse.code, 'AUTH_INTERNAL_ERROR');
  assert.deepStrictEqual(snapshot(state), staleReverseBefore);
  assert.strictEqual(
    findChallenge(state, 'bind', staleReverseEmail).status,
    'active'
  );

  const malformedState = makeState(snapshot(state));
  findById(
    malformedState.email_bindings,
    emailBindingId(secondEmail)
  ).accountId = other.account._id;
  const malformedFixture = loadAccountFixture(
    malformedState,
    'malformed-status-openid'
  );
  const malformedBefore = snapshot(malformedState);
  const malformed = await atTime(BASE_MS + 126 * 1000, () => (
    malformedFixture.main({
      authProtocol: 2,
      action: 'status',
      clientInstanceId: 'malformed-status-client',
      sessionToken: first.sessionToken
    })
  ));
  assert.strictEqual(malformed.code, 'AUTH_INTERNAL_ERROR');
  assert.deepStrictEqual(snapshot(malformedState), malformedBefore);

  const rollbackSend = loadSendEmailCode(state);
  const rollbackEmail = 'rollback@example.com';
  const rollbackSent = await atTime(BASE_MS + 187 * 1000, () => (
    rollbackSend.main({
      authProtocol: 2,
      clientInstanceId: 'rollback-bind-client',
      purpose: 'bind',
      email: rollbackEmail,
      sessionToken: first.sessionToken
    })
  ));
  assert.strictEqual(rollbackSent.ok, true);
  const rollbackAccount = loadAccountFixture(
    state,
    'rollback-account-openid'
  );
  const rollbackBefore = snapshot(state);
  const rollbackResult = await withTransactionWriteFailure(
    rollbackAccount.db,
    'accounts',
    'update',
    () => atTime(BASE_MS + 187 * 1000 + 1, () => (
      rollbackAccount.main({
        authProtocol: 2,
        action: 'bindEmail',
        clientInstanceId: 'rollback-bind-client',
        sessionToken: first.sessionToken,
        email: rollbackEmail,
        code: '123456'
      })
    ))
  );
  assert.strictEqual(rollbackResult.code, 'AUTH_INTERNAL_ERROR');
  assert.deepStrictEqual(snapshot(state), rollbackBefore);
  assert.strictEqual(
    findChallenge(state, 'bind', rollbackEmail).status,
    'active'
  );
}

async function testChallengeLifecycleCooldownAndStaleFinalize() {
  const cooldownState = makeState();
  const registered = await registerNamedAccount({
    state: cooldownState,
    accountName: 'CooldownOwner',
    openid: 'cooldown-owner-openid',
    clientInstanceId: 'cooldown-register',
    nowMs: BASE_MS
  });
  const fixture = loadSendEmailCode(cooldownState);
  const first = await atTime(BASE_MS + 1000, () => fixture.main({
    authProtocol: 2,
    clientInstanceId: 'cooldown-client',
    purpose: 'bind',
    email: 'target@example.com',
    sessionToken: registered.sessionToken
  }));
  assert.strictEqual(first.ok, true);
  const targetCooldown = await atTime(BASE_MS + 1001, () => fixture.main({
    authProtocol: 2,
    clientInstanceId: 'different-client',
    purpose: 'bind',
    email: 'target@example.com',
    sessionToken: registered.sessionToken
  }));
  assert.strictEqual(targetCooldown.code, 'EMAIL_CODE_COOLDOWN');
  const scopeCooldown = await atTime(BASE_MS + 1002, () => fixture.main({
    authProtocol: 2,
    clientInstanceId: 'cooldown-client',
    purpose: 'bind',
    email: 'different@example.com',
    sessionToken: registered.sessionToken
  }));
  assert.strictEqual(scopeCooldown.code, 'EMAIL_CODE_COOLDOWN');
  assert.strictEqual(fixture.sendCalls.length, 1);
  assertNoSecrets(cooldownState.email_codes, [
    'target@example.com',
    'different@example.com',
    'cooldown-client',
    registered.sessionToken,
    '123456'
  ]);

  const lockState = makeState();
  const lockOwner = await registerNamedAccount({
    state: lockState,
    accountName: 'LockOwner',
    openid: 'lock-owner-openid',
    clientInstanceId: 'lock-register',
    nowMs: BASE_MS
  });
  const lockSend = loadSendEmailCode(lockState);
  const lockEmail = 'lock@example.com';
  assert.strictEqual((await atTime(BASE_MS + 2000, () => lockSend.main({
    authProtocol: 2,
    clientInstanceId: 'lock-client',
    purpose: 'bind',
    email: lockEmail,
    sessionToken: lockOwner.sessionToken
  }))).ok, true);
  const lockAccount = loadAccountFixture(lockState, 'lock-consume-openid');
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const result = await atTime(BASE_MS + 2000 + attempt, () => (
      lockAccount.main({
        authProtocol: 2,
        action: 'bindEmail',
        clientInstanceId: 'lock-client',
        sessionToken: lockOwner.sessionToken,
        email: lockEmail,
        code: '000000'
      })
    ));
    assert.strictEqual(
      result.code,
      attempt === 5 ? 'EMAIL_CODE_LOCKED' : 'EMAIL_CODE_INVALID'
    );
    assert.strictEqual(
      findChallenge(lockState, 'bind', lockEmail).attemptsLeft,
      5 - attempt
    );
  }
  assert.strictEqual(
    findChallenge(lockState, 'bind', lockEmail).status,
    'locked'
  );
  const lockedBefore = snapshot(lockState);
  const lockedReuse = await atTime(BASE_MS + 2006, () => lockAccount.main({
    authProtocol: 2,
    action: 'bindEmail',
    clientInstanceId: 'lock-client',
    sessionToken: lockOwner.sessionToken,
    email: lockEmail,
    code: '123456'
  }));
  assert.strictEqual(lockedReuse.code, 'EMAIL_CODE_LOCKED');
  assert.deepStrictEqual(snapshot(lockState), lockedBefore);

  const expiryState = makeState();
  const expiryOwner = await registerNamedAccount({
    state: expiryState,
    accountName: 'ExpiryOwner',
    openid: 'expiry-owner-openid',
    clientInstanceId: 'expiry-register',
    nowMs: BASE_MS
  });
  const expirySend = loadSendEmailCode(expiryState);
  const expiryEmail = 'expiry@example.com';
  await atTime(BASE_MS + 3000, () => expirySend.main({
    authProtocol: 2,
    clientInstanceId: 'expiry-client',
    purpose: 'bind',
    email: expiryEmail,
    sessionToken: expiryOwner.sessionToken
  }));
  const expiryChallenge = findChallenge(
    expiryState,
    'bind',
    expiryEmail
  );
  assert(expiryChallenge.createdAt instanceof Date);
  assert(expiryChallenge.expiresAt instanceof Date);
  assert.strictEqual(
    timeValue(expiryChallenge.expiresAt),
    timeValue(expiryChallenge.sentAt) + 10 * 60 * 1000
  );
  const expiryAccount = loadAccountFixture(
    expiryState,
    'expiry-consume-openid'
  );
  const expiryBefore = snapshot(expiryState);
  const expired = await atTime(
    timeValue(expiryChallenge.expiresAt),
    () => expiryAccount.main({
      authProtocol: 2,
      action: 'bindEmail',
      clientInstanceId: 'expiry-client',
      sessionToken: expiryOwner.sessionToken,
      email: expiryEmail,
      code: '123456'
    })
  );
  assert.strictEqual(expired.code, 'EMAIL_CODE_EXPIRED');
  assert.deepStrictEqual(snapshot(expiryState), expiryBefore);

  const invalidTtlState = makeState();
  const invalidTtlOwner = await registerNamedAccount({
    state: invalidTtlState,
    accountName: 'InvalidTtlOwner',
    openid: 'invalid-ttl-owner-openid',
    clientInstanceId: 'invalid-ttl-register',
    nowMs: BASE_MS
  });
  const invalidTtlEmail = 'invalid-ttl@example.com';
  const invalidTtlSend = loadSendEmailCode(invalidTtlState);
  await atTime(BASE_MS + 3500, () => invalidTtlSend.main({
    authProtocol: 2,
    clientInstanceId: 'invalid-ttl-client',
    purpose: 'bind',
    email: invalidTtlEmail,
    sessionToken: invalidTtlOwner.sessionToken
  }));
  const invalidTtlChallenge = findChallenge(
    invalidTtlState,
    'bind',
    invalidTtlEmail
  );
  invalidTtlChallenge.expiresAt = new Date(
    invalidTtlChallenge.expiresAt.getTime() + 1
  );
  const invalidTtlBefore = snapshot(invalidTtlState);
  const invalidTtlFixture = loadAccountFixture(
    invalidTtlState,
    'invalid-ttl-caller'
  );
  const invalidTtl = await atTime(BASE_MS + 3501, () => (
    invalidTtlFixture.main({
      authProtocol: 2,
      action: 'bindEmail',
      clientInstanceId: 'invalid-ttl-client',
      sessionToken: invalidTtlOwner.sessionToken,
      email: invalidTtlEmail,
      code: '123456'
    })
  ));
  assert.strictEqual(invalidTtl.code, 'AUTH_INTERNAL_ERROR');
  assert.deepStrictEqual(snapshot(invalidTtlState), invalidTtlBefore);

  const usedState = makeState();
  const usedOwner = await registerNamedAccount({
    state: usedState,
    accountName: 'UsedOwner',
    openid: 'used-owner-openid',
    clientInstanceId: 'used-register',
    nowMs: BASE_MS
  });
  const used = await sendAndBind({
    state: usedState,
    email: 'used@example.com',
    sessionToken: usedOwner.sessionToken,
    clientInstanceId: 'used-client',
    nowMs: BASE_MS + 4000
  });
  assert.strictEqual(used.bound.ok, true);
  const usedBefore = snapshot(usedState);
  const reused = await atTime(BASE_MS + 4002, () => (
    used.accountFixture.main({
      authProtocol: 2,
      action: 'bindEmail',
      clientInstanceId: 'used-client',
      sessionToken: usedOwner.sessionToken,
      email: 'used@example.com',
      code: '123456'
    })
  ));
  assert.strictEqual(reused.code, 'EMAIL_CODE_INVALID');
  assert.deepStrictEqual(snapshot(usedState), usedBefore);

  const staleState = makeState();
  const staleOwner = await registerNamedAccount({
    state: staleState,
    accountName: 'StaleOwner',
    openid: 'stale-owner-openid',
    clientInstanceId: 'stale-register',
    nowMs: BASE_MS
  });
  let resolveFirst;
  const firstProvider = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  const staleFixture = loadSendEmailCode(staleState, {
    codeNumbers: [111111, 222222],
    sendEmail(params, callNumber) {
      if (callNumber === 1) return firstProvider;
      return { RequestId: 'second-request' };
    }
  });
  const originalNow = Date.now;
  let nowMs = BASE_MS + 5000;
  Date.now = () => nowMs;
  try {
    const request = {
      authProtocol: 2,
      clientInstanceId: 'stale-client',
      purpose: 'bind',
      email: 'stale@example.com',
      sessionToken: staleOwner.sessionToken
    };
    const firstPromise = staleFixture.main(request);
    while (staleFixture.sendCalls.length < 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    nowMs += 61 * 1000;
    const secondResult = await staleFixture.main(request);
    assert.strictEqual(secondResult.ok, true);
    const afterSecond = clone(
      findChallenge(staleState, 'bind', 'stale@example.com')
    );
    resolveFirst({ RequestId: 'late-first-request' });
    await firstPromise;
    assert.deepStrictEqual(
      findChallenge(staleState, 'bind', 'stale@example.com'),
      afterSecond,
      'late SES completion must not overwrite the newer reservation'
    );
  } finally {
    Date.now = originalNow;
  }
}

async function makeResetTarget(options) {
  const state = makeState();
  const registered = await registerNamedAccount({
    state,
    accountName: options.accountName,
    openid: options.openid,
    clientInstanceId: options.clientInstanceId,
    nowMs: options.nowMs
  });
  addActiveEmailBinding(
    state,
    registered.account,
    options.email,
    options.nowMs + 1
  );
  return { state, registered };
}

async function testPublicResetEnumerationTimingAndSes() {
  const unknown = await sendPublicReset({
    state: makeState(),
    email: 'unknown@example.com',
    clientInstanceId: 'unknown-reset-client',
    nowMs: BASE_MS
  });
  assertPublicTiming(unknown.timed, 9500);
  assert.strictEqual(unknown.fixture.sendCalls.length, 0);
  assert.strictEqual(unknown.fixture.wxContextCalls, 0);

  const successTarget = await makeResetTarget({
    accountName: 'ResetSuccess',
    openid: 'reset-success-openid',
    clientInstanceId: 'reset-success-register',
    email: 'reset-success@example.com',
    nowMs: BASE_MS
  });
  const success = await sendPublicReset({
    state: successTarget.state,
    email: ' RESET-SUCCESS@EXAMPLE.COM ',
    clientInstanceId: 'reset-success-client',
    nowMs: BASE_MS + 1000,
    codeNumber: 7,
    sendEmail(advance) {
      advance(2000);
      return { RequestId: 'ses-success-request' };
    }
  });
  assertPublicTiming(success.timed, 7500);
  assert.strictEqual(success.fixture.sendCalls.length, 1);
  assert.strictEqual(success.fixture.wxContextCalls, 0);
  assert.deepStrictEqual(success.fixture.clientConfigs[0].credential, {
    secretId: 'test-secret-id',
    secretKey: 'test-secret-key'
  });
  assert.strictEqual(
    success.fixture.clientConfigs[0].region,
    'ap-guangzhou'
  );
  assert.strictEqual(
    success.fixture.clientConfigs[0].profile.httpProfile.endpoint,
    'ses.tencentcloudapi.com'
  );
  assert.strictEqual(
    success.fixture.clientConfigs[0].profile.httpProfile.reqTimeout,
    8
  );
  assert.deepStrictEqual(success.fixture.sendCalls[0], {
    FromEmailAddress: '强化杆迹 <noreply@example.com>',
    Destination: ['reset-success@example.com'],
    Subject: '强化杆迹验证码',
    Template: {
      TemplateID: 12345,
      TemplateData: '{"code":"000007","minutes":"10"}'
    },
    TriggerType: 1
  });
  const successChallenge = findChallenge(
    successTarget.state,
    'reset',
    'reset-success@example.com'
  );
  assert(successChallenge);
  assert.strictEqual(successChallenge.status, 'active');
  assert.strictEqual(
    successChallenge.accountId,
    successTarget.registered.account._id
  );
  assertNoSecrets(successChallenge, [
    'reset-success@example.com',
    '000007',
    'reset-success-client'
  ]);

  const coolingFirst = await makeResetTarget({
    accountName: 'ResetCooling',
    openid: 'reset-cooling-openid',
    clientInstanceId: 'reset-cooling-register',
    email: 'reset-cooling@example.com',
    nowMs: BASE_MS
  });
  const coolingInitial = await sendPublicReset({
    state: coolingFirst.state,
    email: 'reset-cooling@example.com',
    clientInstanceId: 'reset-cooling-client',
    nowMs: BASE_MS + 2000
  });
  assertPublicTiming(coolingInitial.timed, 9500);
  const cooling = await sendPublicReset({
    state: coolingFirst.state,
    email: 'reset-cooling@example.com',
    clientInstanceId: 'reset-cooling-client',
    nowMs: BASE_MS + 12000
  });
  assertPublicTiming(cooling.timed, 9500);
  assert.strictEqual(cooling.fixture.sendCalls.length, 0);

  const purgingTarget = await makeResetTarget({
    accountName: 'ResetPurging',
    openid: 'reset-purging-openid',
    clientInstanceId: 'reset-purging-register',
    email: 'reset-purging@example.com',
    nowMs: BASE_MS
  });
  markPurging(
    purgingTarget.state,
    purgingTarget.registered.account._id
  );
  const purging = await sendPublicReset({
    state: purgingTarget.state,
    email: 'reset-purging@example.com',
    clientInstanceId: 'reset-purging-client',
    nowMs: BASE_MS + 3000
  });
  assertPublicTiming(purging.timed, 9500);
  assert.strictEqual(purging.fixture.sendCalls.length, 0);

  const disabledTarget = await makeResetTarget({
    accountName: 'ResetDisabled',
    openid: 'reset-disabled-openid',
    clientInstanceId: 'reset-disabled-register',
    email: 'reset-disabled@example.com',
    nowMs: BASE_MS
  });
  disabledTarget.registered.account.status = 'disabled';
  const disabled = await sendPublicReset({
    state: disabledTarget.state,
    email: 'reset-disabled@example.com',
    clientInstanceId: 'reset-disabled-client',
    nowMs: BASE_MS + 4000
  });
  assertPublicTiming(disabled.timed, 9500);
  assert.strictEqual(disabled.fixture.sendCalls.length, 0);

  const databaseTarget = await makeResetTarget({
    accountName: 'ResetDatabase',
    openid: 'reset-database-openid',
    clientInstanceId: 'reset-database-register',
    email: 'reset-database@example.com',
    nowMs: BASE_MS
  });
  const clientTarget = await makeResetTarget({
    accountName: 'ResetClientFailure',
    openid: 'reset-client-failure-openid',
    clientInstanceId: 'reset-client-failure-register',
    email: 'reset-client-error@example.com',
    nowMs: BASE_MS
  });
  const originalConsoleError = console.error;
  console.error = () => {};
  let databaseFailure;
  let clientFailure;
  let sesFailure;
  let sesTarget;
  try {
    databaseFailure = await sendPublicReset({
      state: databaseTarget.state,
      email: 'reset-database@example.com',
      clientInstanceId: 'reset-database-client',
      nowMs: BASE_MS + 5000,
      beforeCall(fixture) {
        fixture.db.beforeTransaction = () => {
          throw new Error('simulated database failure');
        };
      }
    });
    clientFailure = await sendPublicReset({
      state: clientTarget.state,
      email: 'reset-client-error@example.com',
      clientInstanceId: 'reset-client-error-client',
      nowMs: BASE_MS + 6000,
      clientError: Object.assign(
        new Error('client init includes reset-client-error@example.com'),
        { code: 'ClientError' }
      )
    });
    sesTarget = await makeResetTarget({
      accountName: 'ResetSesFailure',
      openid: 'reset-ses-openid',
      clientInstanceId: 'reset-ses-register',
      email: 'reset-ses@example.com',
      nowMs: BASE_MS
    });
    sesFailure = await sendPublicReset({
      state: sesTarget.state,
      email: 'reset-ses@example.com',
      clientInstanceId: 'reset-ses-client',
      nowMs: BASE_MS + 7000,
      sendEmail(advance) {
        advance(8000);
        const error = new Error(
          'SES failed reset-ses@example.com 123456 ' + TEST_SECRET
        );
        error.code = 'InternalError';
        error.requestId = 'safe-provider-id';
        throw error;
      }
    });
  } finally {
    console.error = originalConsoleError;
  }
  assertPublicTiming(databaseFailure.timed, 9500);
  assertPublicTiming(clientFailure.timed, 9500);
  assertPublicTiming(sesFailure.timed, 1500);
  assert.strictEqual(databaseFailure.fixture.sendCalls.length, 0);
  assert.strictEqual(clientFailure.fixture.sendCalls.length, 0);
  assert.strictEqual(
    findChallenge(
      clientTarget.state,
      'reset',
      'reset-client-error@example.com'
    ).status,
    'failed'
  );
  const failedSesChallenge = findChallenge(
    sesTarget.state,
    'reset',
    'reset-ses@example.com'
  );
  assert(failedSesChallenge);
  assert.strictEqual(failedSesChallenge.status, 'failed');
  assert.strictEqual(Boolean(failedSesChallenge.codeHash), false);

  const logs = [];
  const logTarget = await makeResetTarget({
    accountName: 'ResetLog',
    openid: 'reset-log-openid',
    clientInstanceId: 'reset-log-register',
    email: 'reset-log@example.com',
    nowMs: BASE_MS
  });
  const logFixture = loadSendEmailCode(logTarget.state, {
    sendEmail() {
      const error = new Error(
        'failure reset-log@example.com 123456 '
          + TEST_SECRET
          + ' old-password'
      );
      error.code = 'InternalError';
      error.requestId = 'provider-request-id';
      throw error;
    }
  });
  console.error = (...args) => logs.push(args);
  try {
    const timed = await withImmediateTimers(
      BASE_MS + 8000,
      () => logFixture.main({
        authProtocol: 2,
        clientInstanceId: 'reset-log-client',
        purpose: 'reset',
        email: 'reset-log@example.com'
      })
    );
    assertPublicTiming(timed, 9500);
  } finally {
    console.error = originalConsoleError;
  }
  assertNoSecrets(logs, [
    'reset-log@example.com',
    '123456',
    TEST_SECRET,
    'old-password'
  ]);

  const invalidFixture = loadSendEmailCode(makeState());
  const invalidStart = invalidFixture.db.__operations.length;
  const invalid = await invalidFixture.main({
    authProtocol: 2,
    clientInstanceId: 'invalid-email-client',
    purpose: 'reset',
    email: 'not-an-email'
  });
  assert.strictEqual(invalid.code, 'EMAIL_INVALID');
  assertOnlyProtocolRead(
    invalidFixture.db.__operations.slice(invalidStart)
  );
  assert.strictEqual(invalidFixture.sendCalls.length, 0);

  const saved = saveEnvironment(EMAIL_ENV_KEYS);
  try {
    configureEnvironment({
      CUETRACE_SES_SECRET_ID: '',
      CUETRACE_SES_SECRET_KEY: '',
      CUETRACE_SES_FROM_EMAIL: '',
      CUETRACE_SES_TEMPLATE_ID: '',
      CUETRACE_EMAIL_CODE_SECRET: ''
    });
    const missingFixture = loadSendEmailCode(makeState());
    const missing = await missingFixture.main({
      authProtocol: 2,
      clientInstanceId: 'missing-config-client',
      purpose: 'reset',
      email: 'missing-config@example.com'
    });
    assert.strictEqual(missing.code, 'EMAIL_NOT_CONFIGURED');
    assert.strictEqual(missingFixture.sendCalls.length, 0);
  } finally {
    restoreEnvironment(saved);
  }
}

async function testPhoneOnlyResetRevokesSessionsAndKeepsDeletionGrace() {
  const state = makeState();
  const openid = 'phone-only-openid';
  const phone = '13800138000';
  const normalizedPhone = '+8613800138000';
  const fixture = loadAccountFixture(state, openid);
  const first = await loginPhoneSession({
    state,
    fixture,
    openid,
    phone,
    normalizedPhone,
    clientInstanceId: 'phone-only-client-one',
    code: '101010',
    nowMs: BASE_MS
  });
  const second = await loginPhoneSession({
    state,
    fixture,
    openid,
    phone,
    normalizedPhone,
    clientInstanceId: 'phone-only-client-two',
    code: '202020',
    nowMs: BASE_MS + 61 * 1000
  });
  assert.strictEqual(state.accounts.length, 1);
  assert.strictEqual(state.account_names.length, 0);
  assert.strictEqual(first.account._id, second.account._id);
  const accountId = first.account._id;

  const email = 'phone-only@example.com';
  const bound = await sendAndBind({
    state,
    email,
    sessionToken: first.sessionToken,
    clientInstanceId: 'phone-only-bind-client',
    nowMs: BASE_MS + 62 * 1000
  });
  assert.strictEqual(bound.bound.ok, true);
  assert.strictEqual(
    findById(state.email_bindings, emailBindingId(email)).accountId,
    accountId
  );

  const resetSend = await sendPublicReset({
    state,
    email,
    clientInstanceId: 'phone-only-reset-client',
    nowMs: BASE_MS + 63 * 1000
  });
  assertPublicTiming(resetSend.timed, 9500);
  assert.strictEqual(resetSend.fixture.sendCalls.length, 1);

  markDeletionPending(
    state,
    accountId,
    BASE_MS + 63 * 1000 + 9501
  );
  const deletionUserBefore = clone(
    findById(state.users, accountId)
  );
  const deletionRequestBefore = clone(
    findById(state.account_deletion_requests, accountId)
  );
  const authVersionBefore = findById(
    state.accounts,
    accountId
  ).authVersion;
  const resetFixture = loadAccountFixture(
    state,
    'public-email-reset-openid'
  );
  const reset = await atTime(
    BASE_MS + 63 * 1000 + 9502,
    () => resetFixture.main({
      authProtocol: 2,
      action: 'resetPasswordByEmail',
      clientInstanceId: 'phone-only-reset-client',
      email: ' PHONE-ONLY@EXAMPLE.COM ',
      code: '123456',
      password: 'new-phone-password'
    })
  );
  assert.deepStrictEqual(reset, {
    ok: true,
    kind: 'password_reset',
    next: 'login'
  });
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(reset, 'sessionToken'),
    false
  );
  assertNoSecrets(reset, [
    email,
    accountId,
    first.sessionToken,
    second.sessionToken,
    'new-phone-password'
  ]);
  assert.strictEqual(state.accounts.length, 1);
  assert.strictEqual(
    findById(state.accounts, accountId).authVersion,
    authVersionBefore + 1
  );
  assert.strictEqual(
    findChallenge(state, 'reset', email).status,
    'used'
  );
  assert.deepStrictEqual(
    findById(state.users, accountId),
    deletionUserBefore,
    'password reset must not cancel deletion grace'
  );
  assert.deepStrictEqual(
    findById(state.account_deletion_requests, accountId),
    deletionRequestBefore,
    'password reset must not cancel deletion request'
  );

  const keyring = loadKeyring(process.env);
  for (const token of [first.sessionToken, second.sessionToken]) {
    const session = await requireSession({
      db: resetFixture.db,
      event: { sessionToken: token },
      now: new Date(BASE_MS + 63 * 1000 + 9503),
      keyring
    });
    assert.strictEqual(session.code, 'SESSION_EXPIRED');
  }
}

async function testEmailResetInactiveAndDeletionIntegrity() {
  const disabledTarget = await makeResetTarget({
    accountName: 'DisabledConsume',
    openid: 'disabled-consume-openid',
    clientInstanceId: 'disabled-consume-register',
    email: 'disabled-consume@example.com',
    nowMs: BASE_MS
  });
  const disabledSend = await sendPublicReset({
    state: disabledTarget.state,
    email: 'disabled-consume@example.com',
    clientInstanceId: 'disabled-consume-client',
    nowMs: BASE_MS + 10 * 1000
  });
  assertPublicTiming(disabledSend.timed, 9500);
  const disabledAccount = findById(
    disabledTarget.state.accounts,
    disabledTarget.registered.account._id
  );
  disabledAccount.status = 'disabled';
  const disabledBefore = snapshot(disabledTarget.state);
  const disabledFixture = loadAccountFixture(
    disabledTarget.state,
    'disabled-consume-caller'
  );
  const disabled = await atTime(BASE_MS + 19501, () => (
    disabledFixture.main({
      authProtocol: 2,
      action: 'resetPasswordByEmail',
      clientInstanceId: 'disabled-consume-client',
      email: 'disabled-consume@example.com',
      code: '123456',
      password: 'disabled-new-password'
    })
  ));
  assert.strictEqual(disabled.code, 'EMAIL_CODE_INVALID');
  assert.deepStrictEqual(snapshot(disabledTarget.state), disabledBefore);

  const malformedTarget = await makeResetTarget({
    accountName: 'MalformedDeletion',
    openid: 'malformed-deletion-openid',
    clientInstanceId: 'malformed-deletion-register',
    email: 'malformed-deletion@example.com',
    nowMs: BASE_MS
  });
  const malformedSend = await sendPublicReset({
    state: malformedTarget.state,
    email: 'malformed-deletion@example.com',
    clientInstanceId: 'malformed-deletion-client',
    nowMs: BASE_MS + 20 * 1000
  });
  assertPublicTiming(malformedSend.timed, 9500);
  const malformedAccountId = malformedTarget.registered.account._id;
  markDeletionPending(
    malformedTarget.state,
    malformedAccountId,
    BASE_MS + 29501
  );
  malformedTarget.state.account_deletion_requests.length = 0;
  const malformedBefore = snapshot(malformedTarget.state);
  const malformedFixture = loadAccountFixture(
    malformedTarget.state,
    'malformed-deletion-caller'
  );
  const malformed = await atTime(BASE_MS + 29502, () => (
    malformedFixture.main({
      authProtocol: 2,
      action: 'resetPasswordByEmail',
      clientInstanceId: 'malformed-deletion-client',
      email: 'malformed-deletion@example.com',
      code: '123456',
      password: 'malformed-new-password'
    })
  ));
  assert.strictEqual(malformed.code, 'AUTH_INTERNAL_ERROR');
  assert.deepStrictEqual(snapshot(malformedTarget.state), malformedBefore);

  const duplicateTarget = await makeResetTarget({
    accountName: 'DuplicateResetOwner',
    openid: 'duplicate-reset-owner-openid',
    clientInstanceId: 'duplicate-reset-owner-register',
    email: 'duplicate-reset@example.com',
    nowMs: BASE_MS
  });
  const duplicateOther = await registerNamedAccount({
    state: duplicateTarget.state,
    accountName: 'DuplicateResetOther',
    openid: 'duplicate-reset-other-openid',
    clientInstanceId: 'duplicate-reset-other-register',
    nowMs: BASE_MS + 1
  });
  const duplicateSend = await sendPublicReset({
    state: duplicateTarget.state,
    email: 'duplicate-reset@example.com',
    clientInstanceId: 'duplicate-reset-client',
    nowMs: BASE_MS + 30 * 1000
  });
  assertPublicTiming(duplicateSend.timed, 9500);
  findById(
    duplicateTarget.state.accounts,
    duplicateOther.account._id
  ).emailBindingId = emailBindingId('duplicate-reset@example.com');
  const duplicateBefore = snapshot(duplicateTarget.state);
  const duplicateFixture = loadAccountFixture(
    duplicateTarget.state,
    'duplicate-reset-caller'
  );
  const duplicate = await atTime(BASE_MS + 39501, () => (
    duplicateFixture.main({
      authProtocol: 2,
      action: 'resetPasswordByEmail',
      clientInstanceId: 'duplicate-reset-client',
      email: 'duplicate-reset@example.com',
      code: '123456',
      password: 'duplicate-reset-password'
    })
  ));
  assert.strictEqual(duplicate.code, 'AUTH_INTERNAL_ERROR');
  assert.deepStrictEqual(snapshot(duplicateTarget.state), duplicateBefore);
}

async function testEmailReauthIsBoundToExactSession() {
  const state = makeState();
  const first = await registerNamedAccount({
    state,
    accountName: 'ReauthOwner',
    openid: 'reauth-owner-openid',
    clientInstanceId: 'reauth-register',
    nowMs: BASE_MS
  });
  await sendAndBind({
    state,
    email: 'reauth@example.com',
    sessionToken: first.sessionToken,
    clientInstanceId: 'reauth-bind-client',
    nowMs: BASE_MS + 1000
  });
  const secondFixture = loadAccountFixture(
    state,
    'reauth-second-login-openid'
  );
  const secondLogin = await atTime(BASE_MS + 2000, () => secondFixture.main({
    authProtocol: 2,
    action: 'loginPassword',
    clientInstanceId: 'reauth-second-client',
    identifier: 'ReauthOwner',
    password: 'old-password',
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION
  }));
  assert.strictEqual(secondLogin.ok, true);
  const firstSession = state.auth_sessions.find(
    (session) => session.clientInstanceId === 'reauth-register'
  );
  const secondSession = state.auth_sessions.find(
    (session) => session.clientInstanceId === 'reauth-second-client'
  );
  assert(firstSession);
  assert(secondSession);

  const reauthSendAt = BASE_MS + 6 * 60 * 60 * 1000 - 1;
  const wrongSessionAt = reauthSendAt + 1;
  const correctReauthAt = reauthSendAt + 2;
  const sendFixture = loadSendEmailCode(state);
  const sent = await atTime(reauthSendAt, () => sendFixture.main({
    authProtocol: 2,
    clientInstanceId: 'reauth-register',
    purpose: 'reauth',
    sessionToken: first.sessionToken
  }));
  assert.strictEqual(sent.ok, true);
  const challenge = findChallenge(
    state,
    'reauth',
    'reauth@example.com'
  );
  assert(challenge);
  const attemptsBefore = challenge.attemptsLeft;

  const wrongSessionFixture = loadAccountFixture(
    state,
    'reauth-wrong-session-openid'
  );
  const wrongSession = await atTime(wrongSessionAt, () => (
    wrongSessionFixture.main({
      authProtocol: 2,
      action: 'reauthenticate',
      clientInstanceId: 'reauth-second-client',
      sessionToken: secondLogin.sessionToken,
      method: 'email',
      code: '123456'
    })
  ));
  assert.strictEqual(wrongSession.code, 'EMAIL_CODE_INVALID');
  assert.strictEqual(challenge.status, 'active');
  assert.strictEqual(challenge.attemptsLeft, attemptsBefore);

  const firstBefore = clone(firstSession);
  const secondBefore = clone(secondSession);
  const correctFixture = loadAccountFixture(
    state,
    'reauth-correct-session-openid'
  );
  const correct = await atTime(correctReauthAt, () => correctFixture.main({
    authProtocol: 2,
    action: 'reauthenticate',
    clientInstanceId: 'reauth-register',
    sessionToken: first.sessionToken,
    method: 'email',
    code: '123456'
  }));
  assert.deepStrictEqual(correct, {
    ok: true,
    kind: 'reauthenticated',
    authenticatedAt: correctReauthAt,
    authenticationMethod: 'email'
  });
  assert.strictEqual(
    findChallenge(state, 'reauth', 'reauth@example.com').status,
    'used'
  );
  const liveFirstSession = findById(state.auth_sessions, firstSession._id);
  const liveSecondSession = findById(state.auth_sessions, secondSession._id);
  for (const key of Object.keys(firstBefore)) {
    if (key === 'authenticatedAt' || key === 'authenticationMethod') {
      continue;
    }
    assert.deepStrictEqual(liveFirstSession[key], firstBefore[key]);
  }
  assert.strictEqual(
    liveFirstSession.authenticatedAt.getTime(),
    correctReauthAt
  );
  assert.strictEqual(liveFirstSession.authenticationMethod, 'email');
  assert.deepStrictEqual(liveSecondSession, secondBefore);

  const reusedBefore = snapshot(state);
  const reused = await atTime(correctReauthAt + 1, () => correctFixture.main({
    authProtocol: 2,
    action: 'reauthenticate',
    clientInstanceId: 'reauth-register',
    sessionToken: first.sessionToken,
    method: 'email',
    code: '123456'
  }));
  assert.strictEqual(reused.code, 'EMAIL_CODE_INVALID');
  assert.deepStrictEqual(snapshot(state), reusedBefore);
}

async function testStatusMethodOrderAndNoStoredMask() {
  const state = makeState();
  const registered = await registerNamedAccount({
    state,
    accountName: 'MethodOrder',
    openid: 'method-order-openid',
    clientInstanceId: 'method-order-register',
    nowMs: BASE_MS
  });
  addPhoneBinding(
    state,
    registered.account,
    '+8613900139000',
    BASE_MS + 1
  );
  const email = addActiveEmailBinding(
    state,
    registered.account,
    'method-order@example.com',
    BASE_MS + 1
  );
  addWechatBinding(
    state,
    registered.account,
    'method-order-wechat',
    '',
    BASE_MS + 1
  );
  const fixture = loadAccountFixture(state, 'status-method-openid');
  const status = await atTime(BASE_MS + 2, () => fixture.main({
    authProtocol: 2,
    action: 'status',
    clientInstanceId: 'method-order-register',
    sessionToken: registered.sessionToken
  }));
  assert.deepStrictEqual(
    status.reauthMethods,
    ['password', 'phone', 'email', 'wechat']
  );
  assert.strictEqual(status.emailBound, true);
  assert.strictEqual(
    status.emailMasked,
    maskEmail('method-order@example.com')
  );
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(email, 'emailMasked'),
    false
  );
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(email, 'verifiedAt'),
    false
  );
}

async function testWechatResetRequiresCompleteV2GraphAndMigratesHistory() {
  const activeState = makeState();
  const active = await registerNamedAccount({
    state: activeState,
    accountName: 'WechatReset',
    openid: 'wechat-reset-register-openid',
    clientInstanceId: 'wechat-reset-register',
    nowMs: BASE_MS
  });
  addWechatBinding(
    activeState,
    active.account,
    'wechat-reset-owner',
    'union-reset-owner',
    BASE_MS + 1
  );
  const activeAccountId = active.account._id;
  const oldVersion = active.account.authVersion;
  const resetFixture = loadAccountFixture(
    activeState,
    'wechat-reset-owner',
    'union-reset-owner'
  );
  const reset = await atTime(BASE_MS + 2, () => resetFixture.main({
    authProtocol: 2,
    action: 'resetPasswordByWechat',
    clientInstanceId: 'wechat-reset-client',
    password: 'new-wechat-password'
  }));
  assert.deepStrictEqual(reset, {
    ok: true,
    kind: 'password_reset',
    next: 'login'
  });
  assert.strictEqual(
    findById(activeState.accounts, activeAccountId).authVersion,
    oldVersion + 1
  );
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(reset, 'sessionToken'),
    false
  );
  assertNoSecrets(reset, [
    activeAccountId,
    'wechat-reset-owner',
    'union-reset-owner',
    'new-wechat-password'
  ]);

  const failureCases = [
    {
      label: 'missing binding',
      mutate(state, account) {
        account.wechatBindingId = '';
        state.wechat_bindings.length = 0;
      },
      code: 'WECHAT_NOT_BOUND'
    },
    {
      label: 'one-sided binding',
      mutate(state, account) {
        state.wechat_bindings.length = 0;
        assert(account.wechatBindingId);
      },
      code: 'AUTH_INTERNAL_ERROR'
    },
    {
      label: 'disabled account',
      mutate(state, account) {
        account.status = 'disabled';
      },
      code: 'ACCOUNT_DISABLED'
    },
    {
      label: 'purging account',
      mutate(state, account) {
        markPurging(state, account._id);
      },
      code: 'ACCOUNT_DELETION_LOCKED'
    },
    {
      label: 'union audit conflict',
      mutate(state) {
        const binding = state.wechat_bindings[0];
        binding.unionidHash = binding.unionidHash.slice(0, -1)
          + (binding.unionidHash.endsWith('A') ? 'B' : 'A');
      },
      code: 'AUTH_INTERNAL_ERROR'
    },
    {
      label: 'duplicate reverse reference',
      mutate(state, account) {
        const duplicateAccountId =
          'acct_DUPLICATE_WECHAT_RESET_123456';
        state.accounts.push({
          ...clone(account),
          _id: duplicateAccountId,
          accountNameBindingId: '',
          phoneBindingId: '',
          emailBindingId: '',
          wechatBindingId: account.wechatBindingId
        });
        state.users.push({
          ...clone(state.users[0]),
          _id: duplicateAccountId
        });
      },
      code: 'AUTH_INTERNAL_ERROR'
    }
  ];
  for (const testCase of failureCases) {
    const state = makeState(snapshot(activeState));
    const account = state.accounts[0];
    account.authVersion = oldVersion;
    testCase.mutate(state, account);
    const before = snapshot(state);
    const fixture = loadAccountFixture(
      state,
      'wechat-reset-owner',
      'union-reset-owner'
    );
    const originalConsoleWarn = console.warn;
    console.warn = () => {};
    let result;
    try {
      result = await atTime(BASE_MS + 3, () => fixture.main({
        authProtocol: 2,
        action: 'resetPasswordByWechat',
        clientInstanceId: 'wechat-reset-failure-client',
        password: 'must-not-write'
      }));
    } finally {
      console.warn = originalConsoleWarn;
    }
    assert.strictEqual(result.code, testCase.code, testCase.label);
    assert.deepStrictEqual(snapshot(state), before, testCase.label);
  }

  const saved = saveEnvironment(AUTH_ENV_KEYS);
  try {
    configureEnvironment({
      CUETRACE_AUTH_KEY_ACTIVE_VERSION: 'K2',
      CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS: 'K1',
      CUETRACE_AUTH_KEY_K1: Buffer.alloc(32, 0x31).toString('base64'),
      CUETRACE_AUTH_KEY_K2: Buffer.alloc(32, 0x42).toString('base64')
    });
    const historicalState = makeState();
    const historical = await registerNamedAccount({
      state: historicalState,
      accountName: 'HistoricalWechat',
      openid: 'historical-register-openid',
      clientInstanceId: 'historical-register',
      nowMs: BASE_MS
    });
    const oldBinding = addWechatBinding(
      historicalState,
      historical.account,
      'historical-wechat-owner',
      'historical-union-owner',
      BASE_MS + 1,
      'K1'
    );
    const historicalFixture = loadAccountFixture(
      historicalState,
      'historical-wechat-owner',
      'historical-union-owner'
    );
    const historicalReset = await atTime(
      BASE_MS + 2,
      () => historicalFixture.main({
        authProtocol: 2,
        action: 'resetPasswordByWechat',
        clientInstanceId: 'historical-reset-client',
        password: 'historical-new-password'
      })
    );
    assert.strictEqual(historicalReset.ok, true);
    const activeCandidate = wechatMaterialFor(
      'historical-wechat-owner',
      'historical-union-owner',
      loadKeyring(process.env)
    )[0];
    const activeBinding = findById(
      historicalState.wechat_bindings,
      activeCandidate.id
    );
    assert(activeBinding);
    assert.strictEqual(activeBinding.status, 'active');
    assert.strictEqual(
      findById(historicalState.wechat_bindings, oldBinding._id).status,
      'revoked'
    );
    assert.strictEqual(
      findById(
        historicalState.accounts,
        historical.account._id
      ).wechatBindingId,
      activeBinding._id
    );
  } finally {
    restoreEnvironment(saved);
  }
}

async function main() {
  const saved = saveEnvironment([
    ...AUTH_ENV_KEYS,
    ...EMAIL_ENV_KEYS
  ]);
  configureEnvironment();
  try {
    await testStrictSendUnionAndProtocolFirst();
    await testSessionSendScopesAndLiveReread();
    await testBindingReplacementIntegrityRollbackAndStatus();
    await testChallengeLifecycleCooldownAndStaleFinalize();
    await testPublicResetEnumerationTimingAndSes();
    await testPhoneOnlyResetRevokesSessionsAndKeepsDeletionGrace();
    await testEmailResetInactiveAndDeletionIntegrity();
    await testEmailReauthIsBoundToExactSession();
    await testStatusMethodOrderAndNoStoredMask();
    await testWechatResetRequiresCompleteV2GraphAndMigratesHistory();
    console.log('EMAIL_RECOVERY_V2_TASK6_OK');
  } finally {
    restoreEnvironment(saved);
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
