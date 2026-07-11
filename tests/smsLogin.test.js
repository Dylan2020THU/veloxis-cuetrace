const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function exists(file) {
  return fs.existsSync(path.join(root, file));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function hashCode(phone, code, secret) {
  return sha256(`${phone}:${code}:${secret}`);
}

function smsCodeId(openid, phone) {
  return sha256(`sms:${openid}:${phone}`);
}

function matches(document, query) {
  return Object.keys(query || {}).every((key) => document[key] === query[key]);
}

function loadVerifySms(openid, seed) {
  const state = seed;
  const writes = [];
  const controls = {
    beforeTransaction: null,
    failReadCollection: '',
    failTransactionWriteAt: 0,
    transactionWriteCount: 0
  };
  const verifyPath = path.join(root, 'cloudfunctions/verifySmsCode/index.js');
  let transactionQueue = Promise.resolve();

  function makeDatabase(targetState, stagedWrites, transactionMode) {
    function collection(name) {
      const documents = targetState[name] || (targetState[name] = []);
      return {
        doc(id) {
          return {
            async get() {
              if (controls.failReadCollection === name) {
                controls.failReadCollection = '';
                throw new Error(`simulated ${name} read failure`);
              }
              const found = documents.find((item) => item._id === id);
              return { data: found ? clone(found) : null };
            },
            async update({ data }) {
              if (transactionMode) {
                controls.transactionWriteCount += 1;
                if (controls.transactionWriteCount === controls.failTransactionWriteAt) {
                  throw new Error('simulated transaction write failure');
                }
              }
              const index = documents.findIndex((item) => item._id === id);
              if (index === -1) throw new Error(`document ${id} does not exist`);
              documents[index] = Object.assign({}, documents[index], clone(data));
              stagedWrites.push({ type: 'update', collection: name, id, data: clone(data) });
              return { stats: { updated: 1 } };
            }
          };
        },
        where(query) {
          const get = async (limit) => {
            const result = {
              data: clone(documents.filter((item) => matches(item, query)).slice(0, limit))
            };
            return result;
          };
          return {
            limit(limit) {
              return { get: () => get(limit) };
            },
            get: () => get(documents.length)
          };
        },
        async add({ data }) {
          const id = data._id || `${name}_${documents.length + 1}`;
          documents.push(Object.assign({}, clone(data), { _id: id }));
          stagedWrites.push({ type: 'add', collection: name, id, data: clone(data) });
          return { _id: id };
        }
      };
    }

    return {
      collection,
      serverDate() {
        return 'server-date';
      },
      runTransaction(callback) {
        if (transactionMode) throw new Error('nested transactions are unsupported');
        const execute = async () => {
          if (controls.beforeTransaction) {
            const callback = controls.beforeTransaction;
            controls.beforeTransaction = null;
            callback(state);
          }
          const workingState = clone(state);
          const transactionWrites = [];
          controls.transactionWriteCount = 0;
          const result = await callback(makeDatabase(workingState, transactionWrites, true));
          Object.keys(workingState).forEach((name) => {
            if (Array.isArray(workingState[name])) state[name] = workingState[name];
          });
          writes.push(...transactionWrites);
          return result;
        };
        const pending = transactionQueue.then(execute);
        transactionQueue = pending.catch(() => {});
        return pending;
      }
    };
  }

  const fakeDb = makeDatabase(state, writes, false);

  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database() {
      return fakeDb;
    },
    getWXContext() {
      return { OPENID: openid };
    }
  };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'wx-server-sdk') return fakeCloud;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(verifyPath)];
    return {
      fn: require(verifyPath),
      state,
      writes,
      beforeTransaction(callback) {
        controls.beforeTransaction = callback;
      },
      failReadOf(collectionName) {
        controls.failReadCollection = collectionName;
      },
      failTransactionWriteAt(writeNumber) {
        controls.failTransactionWriteAt = writeNumber;
      }
    };
  } finally {
    Module._load = originalLoad;
  }
}

function createSendDatabase(seed) {
  const state = seed;
  const writes = [];
  let transactionQueue = Promise.resolve();

  function makeDatabase(targetState, stagedWrites, transactionMode) {
    function collection(name) {
      const documents = targetState[name] || (targetState[name] = []);
      return {
        doc(id) {
          return {
            async get() {
              const found = documents.find((item) => item._id === id);
              return { data: found ? clone(found) : null };
            },
            async set({ data }) {
              const next = Object.assign({}, clone(data), { _id: id });
              const index = documents.findIndex((item) => item._id === id);
              if (index === -1) documents.push(next);
              else documents[index] = next;
              stagedWrites.push({ type: 'set', collection: name, id, data: clone(data) });
              return { _id: id };
            },
            async update({ data }) {
              const index = documents.findIndex((item) => item._id === id);
              if (index === -1) throw new Error(`document ${id} does not exist`);
              documents[index] = Object.assign({}, documents[index], clone(data));
              stagedWrites.push({ type: 'update', collection: name, id, data: clone(data) });
              return { stats: { updated: 1 } };
            }
          };
        },
        where(query) {
          const get = async (limit) => ({
            data: clone(documents.filter((item) => matches(item, query)).slice(0, limit))
          });
          return {
            limit(limit) {
              return { get: () => get(limit) };
            },
            get: () => get(documents.length)
          };
        },
        async add({ data }) {
          const id = data._id || `${name}_${documents.length + 1}`;
          documents.push(Object.assign({}, clone(data), { _id: id }));
          stagedWrites.push({ type: 'add', collection: name, id, data: clone(data) });
          return { _id: id };
        }
      };
    }

    return {
      collection,
      serverDate() {
        return 'server-date';
      },
      runTransaction(callback) {
        if (transactionMode) throw new Error('nested transactions are unsupported');
        const execute = async () => {
          const workingState = clone(state);
          const transactionWrites = [];
          const result = await callback(makeDatabase(workingState, transactionWrites, true));
          Object.keys(workingState).forEach((name) => {
            if (Array.isArray(workingState[name])) state[name] = workingState[name];
          });
          writes.push(...transactionWrites);
          return result;
        };
        const pending = transactionQueue.then(execute, execute);
        transactionQueue = pending.then(() => undefined, () => undefined);
        return pending;
      }
    };
  }

  return {
    db: makeDatabase(state, writes, false),
    state,
    writes
  };
}

function createFakeHttps(behavior) {
  const requests = [];
  return {
    requests,
    request(options, onResponse) {
      const record = { options, body: '', timeoutMs: 0 };
      const requestHandlers = {};
      requests.push(record);
      const request = {
        on(event, handler) {
          requestHandlers[event] = handler;
          return request;
        },
        setTimeout(timeoutMs, handler) {
          record.timeoutMs = timeoutMs;
          record.timeoutHandler = handler;
          return request;
        },
        write(chunk) {
          record.body += String(chunk);
        },
        destroy(error) {
          if (requestHandlers.error) requestHandlers.error(error || new Error('request destroyed'));
        },
        end() {
          setImmediate(() => {
            const outcome = typeof behavior === 'function'
              ? behavior(requests.length - 1, record)
              : (behavior || { type: 'success' });
            if (outcome.type === 'error') {
              if (requestHandlers.error) requestHandlers.error(new Error(outcome.message || 'provider failure'));
              return;
            }
            const responseHandlers = {};
            const response = {
              statusCode: outcome.statusCode || 200,
              on(event, handler) {
                responseHandlers[event] = handler;
              }
            };
            onResponse(response);
            const payload = outcome.payload || {
              Response: {
                SendStatusSet: [{ Code: 'Ok', Message: 'send success' }]
              }
            };
            if (responseHandlers.data) responseHandlers.data(JSON.stringify(payload));
            if (responseHandlers.end) responseHandlers.end();
          });
        }
      };
      return request;
    }
  };
}

function loadSendSms(openid, seed, randomValues, httpsBehavior) {
  const database = createSendDatabase(seed);
  const fakeHttps = createFakeHttps(httpsBehavior);
  const randomIntCalls = [];
  const values = (randomValues || []).slice();
  const fakeCrypto = Object.assign({}, crypto, {
    randomInt(min, max) {
      randomIntCalls.push({ min, max });
      return values.length ? values.shift() : 123456;
    }
  });
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database() {
      return database.db;
    },
    getWXContext() {
      return { OPENID: openid };
    }
  };
  const sendPath = path.join(root, 'cloudfunctions/sendSmsCode/index.js');
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'wx-server-sdk') return fakeCloud;
    if (request === 'https') return fakeHttps;
    if (request === 'crypto') return fakeCrypto;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(sendPath)];
    return Object.assign(database, {
      fn: require(sendPath),
      httpsRequests: fakeHttps.requests,
      randomIntCalls
    });
  } finally {
    Module._load = originalLoad;
  }
}

const SMS_ENV_KEYS = [
  'CUETRACE_SMS_SECRET_ID',
  'CUETRACE_SMS_SECRET_KEY',
  'CUETRACE_SMS_SDK_APP_ID',
  'CUETRACE_SMS_SIGN_NAME',
  'CUETRACE_SMS_TEMPLATE_ID',
  'SMS_CODE_HASH_SECRET'
];

async function withSmsEnvironment(fn) {
  const previous = {};
  const values = {
    CUETRACE_SMS_SECRET_ID: 'test-secret-id',
    CUETRACE_SMS_SECRET_KEY: 'test-secret-key',
    CUETRACE_SMS_SDK_APP_ID: 'test-sdk-app-id',
    CUETRACE_SMS_SIGN_NAME: 'test-sign-name',
    CUETRACE_SMS_TEMPLATE_ID: 'test-template-id',
    SMS_CODE_HASH_SECRET: 'sms-test-secret'
  };
  SMS_ENV_KEYS.forEach((key) => {
    previous[key] = process.env[key];
    process.env[key] = values[key];
  });
  try {
    return await fn(values.SMS_CODE_HASH_SECRET);
  } finally {
    SMS_ENV_KEYS.forEach((key) => {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    });
  }
}

function validCode(openid, phone, secret) {
  const now = Date.now();
  return {
    _id: smsCodeId(openid, phone),
    _openid: openid,
    phone,
    codeHash: hashCode(phone, '123456', secret),
    failedAttempts: 0,
    locked: false,
    used: false,
    createdAt: now,
    expiresAt: now + 60000
  };
}

function boundSeed(openid, phone, secret) {
  const bindingId = sha256(`wechat:${openid}`);
  const accountId = sha256('account:membera');
  return {
    sms_codes: [validCode(openid, phone, secret)],
    wechat_bindings: [{
      _id: bindingId,
      _openid: openid,
      accountId,
      account: 'memberA'
    }],
    accounts: [{
      _id: accountId,
      _openid: openid,
      account: 'memberA',
      accountNormalized: 'membera',
      status: 'active'
    }],
    users: [{
      _id: bindingId,
      _openid: openid,
      phone,
      role: 'member',
      roles: ['member'],
      currentRole: 'member'
    }]
  };
}

assert(exists('cloudfunctions/sendSmsCode/index.js'), 'sendSmsCode cloud function should exist.');
assert(exists('cloudfunctions/sendSmsCode/package.json'), 'sendSmsCode package.json should exist.');
assert(exists('cloudfunctions/verifySmsCode/index.js'), 'verifySmsCode cloud function should exist.');
assert(exists('cloudfunctions/verifySmsCode/package.json'), 'verifySmsCode package.json should exist.');

const sendSmsCode = read('cloudfunctions/sendSmsCode/index.js');
assert(sendSmsCode.includes('CUETRACE_SMS_SECRET_ID'), 'sendSmsCode should read Tencent Cloud secret id from env.');
assert(sendSmsCode.includes('CUETRACE_SMS_SECRET_KEY'), 'sendSmsCode should read Tencent Cloud secret key from env.');
assert(sendSmsCode.includes('CUETRACE_SMS_SDK_APP_ID'), 'sendSmsCode should read Tencent SMS app id from env.');
assert(sendSmsCode.includes('CUETRACE_SMS_SIGN_NAME'), 'sendSmsCode should read Tencent SMS sign name from env.');
assert(sendSmsCode.includes('CUETRACE_SMS_TEMPLATE_ID'), 'sendSmsCode should read Tencent SMS template id from env.');
assert(!sendSmsCode.includes('TENCENTCLOUD_'), 'sendSmsCode should not use Tencent Cloud reserved env prefixes.');
assert(sendSmsCode.includes('CONFIG_MISSING'), 'sendSmsCode should fail clearly when SMS is not configured.');
assert(sendSmsCode.includes('sms_codes'), 'sendSmsCode should persist generated codes in sms_codes.');
assert(sendSmsCode.includes('crypto.createHash'), 'sendSmsCode should store a hashed code, not plaintext.');
assert(!sendSmsCode.includes('123456'), 'sendSmsCode should not hardcode demo verification codes.');
assert(!sendSmsCode.includes('.orderBy('), 'sendSmsCode should not require a database index for resend checks.');

const verifySmsCode = read('cloudfunctions/verifySmsCode/index.js');
assert(!verifySmsCode.includes('TENCENTCLOUD_'), 'verifySmsCode should not use Tencent Cloud reserved env prefixes.');
assert(verifySmsCode.includes('sms_codes'), 'verifySmsCode should read sms_codes.');
assert(verifySmsCode.includes('expiresAt'), 'verifySmsCode should reject expired codes.');
assert(verifySmsCode.includes('used'), 'verifySmsCode should mark successful codes as used.');
assert(verifySmsCode.includes('INVALID_CODE'), 'verifySmsCode should report invalid codes clearly.');
assert(!verifySmsCode.includes('.orderBy('), 'verifySmsCode should not require a database index for code checks.');
assert(verifySmsCode.includes("transaction.collection('users')"), 'verifySmsCode should update the verified phone inside the transaction.');
assert(verifySmsCode.includes('phoneVerifiedAt'), 'verifySmsCode should record when the phone was verified.');

const dataJs = read('miniprogram/services/data.js');
assert(dataJs.includes('function sendSmsCode'), 'data.js should expose sendSmsCode().');
assert(dataJs.includes("callCloud('sendSmsCode'"), 'sendSmsCode() should call the sendSmsCode cloud function.');
assert(dataJs.includes('function verifySmsCode'), 'data.js should expose verifySmsCode().');
assert(dataJs.includes("callCloud('verifySmsCode'"), 'verifySmsCode() should call the verifySmsCode cloud function.');
assert(/module\.exports\s*=\s*\{[\s\S]*sendSmsCode[\s\S]*verifySmsCode/.test(dataJs), 'data.js should export SMS helpers.');

const loginJs = read('miniprogram/pages/login/index.js');
assert(/data\s*\.\s*sendSmsCode\(phone\)/.test(loginJs), 'Login page should call data.sendSmsCode().');
assert(
  loginJs.search(/data\s*\.\s*sendSmsCode\(phone\)/) < loginJs.indexOf('this.startCodeCountdown()'),
  'Login page should call data.sendSmsCode() before starting the countdown.'
);
assert(/data\s*\.\s*verifySmsCode/.test(loginJs), 'SMS login should call data.verifySmsCode().');
assert(
  /data\s*\.\s*verifySmsCode\([\s\S]*?\.then\(\(result\)\s*=>\s*\{[\s\S]*?this\.handleAuthenticated\(result\)/.test(loginJs),
  'SMS login should use the account and roles returned by verifySmsCode().'
);
assert(!/验证码已发送[\s\S]{0,120}setInterval/.test(loginJs), 'Login page should not show success and start countdown before cloud send succeeds.');

async function testConcurrentSendUsesSingleAtomicCooldown() {
  await withSmsEnvironment(async () => {
    const openid = 'wechat_concurrent_send';
    const phone = '13800138000';
    const fixture = loadSendSms(openid, { sms_codes: [] }, [123456, 654321]);

    const results = await Promise.all([
      fixture.fn.main({ phone }),
      fixture.fn.main({ phone })
    ]);

    assert.strictEqual(results.filter((result) => result.ok).length, 1);
    assert.strictEqual(results.filter((result) => result.code === 'TOO_FREQUENT').length, 1);
    assert.strictEqual(fixture.httpsRequests.length, 1, 'Only the transaction winner may call Tencent SMS.');
    assert.strictEqual(fixture.randomIntCalls.length, 1, 'Only the transaction winner should generate a code.');
    assert.deepStrictEqual(fixture.randomIntCalls[0], { min: 100000, max: 1000000 });
    assert.strictEqual(fixture.state.sms_codes.length, 1);
    assert.strictEqual(fixture.state.sms_codes[0]._id, smsCodeId(openid, phone));
  });
}

async function testFailedSendKeepsCooldownAndDoesNotLeakProviderDetails() {
  await withSmsEnvironment(async () => {
    const openid = 'wechat_failed_send';
    const phone = '13800138000';
    const providerDetail = `provider rejected +86${phone} verification 123456`;
    const fixture = loadSendSms(
      openid,
      { sms_codes: [] },
      [123456, 654321],
      { type: 'error', message: providerDetail }
    );

    const failed = await fixture.fn.main({ phone });
    const immediateRetry = await fixture.fn.main({ phone });

    assert.strictEqual(failed.ok, false);
    assert.strictEqual(failed.code, 'SMS_SEND_FAILED');
    assert(!JSON.stringify(failed).includes(phone), 'SMS errors must not expose the requested phone.');
    assert(!JSON.stringify(failed).includes('123456'), 'SMS errors must not expose a verification code.');
    assert.strictEqual(immediateRetry.ok, false);
    assert.strictEqual(immediateRetry.code, 'TOO_FREQUENT');
    assert.strictEqual(fixture.httpsRequests.length, 1, 'A failed provider call must still retain the cooldown claim.');
    const request = fixture.httpsRequests[0];
    const timeoutMs = request.timeoutMs || request.options.timeout;
    assert(timeoutMs >= 1000 && timeoutMs <= 10000, 'Tencent SMS HTTPS must have a bounded timeout.');
    assert.strictEqual(fixture.state.sms_codes.length, 1);
    assert.strictEqual(fixture.state.sms_codes[0].used, true, 'A failed send must leave no usable code.');
  });
}

async function testNewSendReplacesPreviousCode() {
  await withSmsEnvironment(async (secret) => {
    const openid = 'wechat_latest_send';
    const phone = '13800138000';
    const fixture = loadSendSms(openid, { sms_codes: [] }, [123456, 654321]);

    const first = await fixture.fn.main({ phone });
    assert.strictEqual(first.ok, true);
    fixture.state.sms_codes.forEach((item) => {
      item.createdAt = Date.now() - 61000;
      item.lastSendAttemptAt = Date.now() - 61000;
      item.lockedAt = 123;
      item.usedAt = 456;
    });
    const second = await fixture.fn.main({ phone });
    assert.strictEqual(second.ok, true);

    const sentCodes = fixture.httpsRequests.map((request) => JSON.parse(request.body).TemplateParamSet[0]);
    assert.deepStrictEqual(sentCodes, ['123456', '654321']);
    assert.strictEqual(fixture.state.sms_codes.length, 1, 'A new send must overwrite the deterministic latest-code document.');
    assert.strictEqual(fixture.state.sms_codes[0]._id, smsCodeId(openid, phone));
    assert.strictEqual(fixture.state.sms_codes[0].codeHash, hashCode(phone, '654321', secret));
    assert.notStrictEqual(fixture.state.sms_codes[0].codeHash, hashCode(phone, '123456', secret));
    assert.strictEqual(fixture.state.sms_codes[0].lockedAt, 0);
    assert.strictEqual(fixture.state.sms_codes[0].usedAt, 0);

    const identity = boundSeed(openid, phone, secret);
    fixture.state.wechat_bindings = identity.wechat_bindings;
    fixture.state.accounts = identity.accounts;
    fixture.state.users = identity.users;
    const verifier = loadVerifySms(openid, fixture.state);
    const oldResult = await verifier.fn.main({ phone, code: '123456' });
    const newResult = await verifier.fn.main({ phone, code: '654321' });
    assert.strictEqual(oldResult.ok, false, 'The previous code must stop working after a newer send.');
    assert.strictEqual(oldResult.code, 'INVALID_CODE');
    assert.strictEqual(newResult.ok, true);
  });
}

async function testFiveWrongCodesAtomicallyLockLatestCode() {
  const secret = 'sms-test-secret';
  const openid = 'wechat_wrong_limit';
  const phone = '13800138000';
  const previousSecret = process.env.SMS_CODE_HASH_SECRET;
  process.env.SMS_CODE_HASH_SECRET = secret;
  try {
    const fixture = loadVerifySms(openid, boundSeed(openid, phone, secret));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await fixture.fn.main({ phone, code: '000000' });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.code, 'INVALID_CODE');
      assert(!JSON.stringify(result).includes(phone));
      assert(!JSON.stringify(result).includes('000000'));
    }
    assert.strictEqual(fixture.state.sms_codes[0].failedAttempts, 5);
    assert.strictEqual(fixture.state.sms_codes[0].locked, true);
    assert.strictEqual(fixture.state.sms_codes[0].used, true);

    const correctAfterLock = await fixture.fn.main({ phone, code: '123456' });
    assert.strictEqual(correctAfterLock.ok, false);
    assert.strictEqual(correctAfterLock.code, 'INVALID_CODE');
    assert.strictEqual(fixture.state.users[0].phoneVerifiedAt, undefined);
  } finally {
    if (previousSecret === undefined) delete process.env.SMS_CODE_HASH_SECRET;
    else process.env.SMS_CODE_HASH_SECRET = previousSecret;
  }
}

async function testMalformedLatestCodeIsRejectedWithoutWrites() {
  const secret = 'sms-test-secret';
  const openid = 'wechat_malformed_code';
  const phone = '13800138000';
  const previousSecret = process.env.SMS_CODE_HASH_SECRET;
  process.env.SMS_CODE_HASH_SECRET = secret;
  const mutations = [
    (code) => { delete code.createdAt; },
    (code) => { delete code.expiresAt; },
    (code) => { delete code.failedAttempts; },
    (code) => { code.failedAttempts = -1; },
    (code) => { code.failedAttempts = 1.5; },
    (code) => { code.failedAttempts = 5; },
    (code) => { delete code.locked; }
  ];
  try {
    for (const mutate of mutations) {
      const seed = boundSeed(openid, phone, secret);
      mutate(seed.sms_codes[0]);
      const fixture = loadVerifySms(openid, seed);
      const result = await fixture.fn.main({ phone, code: '123456' });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.code, 'INVALID_CODE');
      assert.strictEqual(fixture.state.sms_codes[0].used, false);
      assert.strictEqual(fixture.state.users[0].phoneVerifiedAt, undefined);
      assert.deepStrictEqual(fixture.writes, [], 'Malformed code state must be rejected without normalization writes.');
    }
  } finally {
    if (previousSecret === undefined) delete process.env.SMS_CODE_HASH_SECRET;
    else process.env.SMS_CODE_HASH_SECRET = previousSecret;
  }
}

async function testConcurrentWrongAndCorrectCannotBypassAttemptLimit() {
  const secret = 'sms-test-secret';
  const openid = 'wechat_wrong_correct_race';
  const phone = '13800138000';
  const previousSecret = process.env.SMS_CODE_HASH_SECRET;
  process.env.SMS_CODE_HASH_SECRET = secret;
  try {
    const fixture = loadVerifySms(openid, boundSeed(openid, phone, secret));
    const results = await Promise.all([
      fixture.fn.main({ phone, code: '000000' }),
      fixture.fn.main({ phone, code: '000001' }),
      fixture.fn.main({ phone, code: '000002' }),
      fixture.fn.main({ phone, code: '000003' }),
      fixture.fn.main({ phone, code: '000004' }),
      fixture.fn.main({ phone, code: '123456' })
    ]);

    assert.strictEqual(results.filter((result) => result.ok).length, 0);
    assert.strictEqual(results.filter((result) => result.code === 'INVALID_CODE').length, 6);
    assert.strictEqual(fixture.state.sms_codes[0].failedAttempts, 5);
    assert.strictEqual(fixture.state.sms_codes[0].locked, true);
    assert.strictEqual(fixture.state.sms_codes[0].used, true);
    assert.strictEqual(fixture.state.users[0].phoneVerifiedAt, undefined);
  } finally {
    if (previousSecret === undefined) delete process.env.SMS_CODE_HASH_SECRET;
    else process.env.SMS_CODE_HASH_SECRET = previousSecret;
  }
}

async function testUnboundWechatCannotConsumeCodeOrCreateUser() {
  const secret = 'sms-test-secret';
  const openid = 'wechat_unbound';
  const phone = '13800138000';
  const previousSecret = process.env.SMS_CODE_HASH_SECRET;
  process.env.SMS_CODE_HASH_SECRET = secret;
  try {
    const fixture = loadVerifySms(openid, {
      sms_codes: [validCode(openid, phone, secret)],
      wechat_bindings: [],
      accounts: [],
      users: []
    });
    const result = await fixture.fn.main({ phone, code: '123456' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'WECHAT_NOT_BOUND');
    assert.strictEqual(fixture.state.users.length, 0);
    assert.strictEqual(fixture.state.sms_codes[0].used, false);
    assert.strictEqual(fixture.writes.length, 0, 'Unbound SMS verification must not write any collection.');
  } finally {
    if (previousSecret === undefined) delete process.env.SMS_CODE_HASH_SECRET;
    else process.env.SMS_CODE_HASH_SECRET = previousSecret;
  }
}

async function testIncompleteAccountChainCannotConsumeCode() {
  const secret = 'sms-test-secret';
  const openid = 'wechat_incomplete_account';
  const phone = '13800138000';
  const previousSecret = process.env.SMS_CODE_HASH_SECRET;
  process.env.SMS_CODE_HASH_SECRET = secret;
  const cases = [
    ['missing names', (seed) => {
      delete seed.wechat_bindings[0].account;
      delete seed.accounts[0].account;
      delete seed.accounts[0].accountNormalized;
    }],
    ['blank names', (seed) => {
      seed.wechat_bindings[0].account = '';
      seed.accounts[0].account = '';
      seed.accounts[0].accountNormalized = '';
    }],
    ['mismatched normalized name', (seed) => {
      seed.accounts[0].accountNormalized = 'other-account';
    }],
    ['non-deterministic account id', (seed) => {
      seed.wechat_bindings[0].accountId = 'forged-account-id';
      seed.accounts[0]._id = 'forged-account-id';
    }]
  ];
  try {
    for (const [name, mutate] of cases) {
      const seed = boundSeed(openid, phone, secret);
      mutate(seed);
      const fixture = loadVerifySms(openid, seed);
      const result = await fixture.fn.main({ phone, code: '123456' });
      assert.strictEqual(result.ok, false, name);
      assert.strictEqual(result.code, 'ACCOUNT_NOT_BOUND', name);
      assert.strictEqual(fixture.state.sms_codes[0].used, false, name);
      assert.strictEqual(fixture.state.users[0].phoneVerifiedAt, undefined, name);
      assert.deepStrictEqual(fixture.writes, [], `${name} must be rejected without writes.`);
    }
  } finally {
    if (previousSecret === undefined) delete process.env.SMS_CODE_HASH_SECRET;
    else process.env.SMS_CODE_HASH_SECRET = previousSecret;
  }
}

async function testSmsCanReplaceDifferentBoundUserPhone() {
  const secret = 'sms-test-secret';
  const openid = 'wechat_bound_mismatch';
  const requestedPhone = '13800138000';
  const seed = boundSeed(openid, '13900139000', secret);
  seed.sms_codes = [validCode(openid, requestedPhone, secret)];
  const previousSecret = process.env.SMS_CODE_HASH_SECRET;
  process.env.SMS_CODE_HASH_SECRET = secret;
  try {
    const fixture = loadVerifySms(openid, seed);
    const result = await fixture.fn.main({ phone: requestedPhone, code: '123456' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.phone, requestedPhone);
    assert.strictEqual(fixture.state.users[0].phone, requestedPhone);
    assert(fixture.state.users[0].phoneVerifiedAt, 'Successful replacement should record phoneVerifiedAt.');
    assert.strictEqual(fixture.state.sms_codes[0].used, true);
  } finally {
    if (previousSecret === undefined) delete process.env.SMS_CODE_HASH_SECRET;
    else process.env.SMS_CODE_HASH_SECRET = previousSecret;
  }
}

async function testSmsCanSetMissingBoundUserPhone() {
  const secret = 'sms-test-secret';
  const openid = 'wechat_bound_missing_phone';
  const phone = '13800138000';
  const seed = boundSeed(openid, phone, secret);
  delete seed.users[0].phone;
  const previousSecret = process.env.SMS_CODE_HASH_SECRET;
  process.env.SMS_CODE_HASH_SECRET = secret;
  try {
    const fixture = loadVerifySms(openid, seed);
    const result = await fixture.fn.main({ phone, code: '123456' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.phone, phone);
    assert.strictEqual(fixture.state.users[0].phone, phone);
    assert(fixture.state.users[0].phoneVerifiedAt, 'First successful verification should record phoneVerifiedAt.');
    assert.strictEqual(fixture.state.sms_codes[0].used, true);
  } finally {
    if (previousSecret === undefined) delete process.env.SMS_CODE_HASH_SECRET;
    else process.env.SMS_CODE_HASH_SECRET = previousSecret;
  }
}

async function testBoundSmsReturnsServerIdentity() {
  const secret = 'sms-test-secret';
  const openid = 'wechat_bound';
  const phone = '13800138000';
  const previousSecret = process.env.SMS_CODE_HASH_SECRET;
  process.env.SMS_CODE_HASH_SECRET = secret;
  try {
    const fixture = loadVerifySms(openid, boundSeed(openid, phone, secret));
    const result = await fixture.fn.main({ phone, code: '123456' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.phone, phone);
    assert.strictEqual(result.account, 'memberA');
    assert.deepStrictEqual(result.roles, ['member']);
    assert.strictEqual(fixture.state.users.length, 1);
    assert.strictEqual(fixture.state.users[0].phone, phone);
    assert(fixture.state.users[0].phoneVerifiedAt, 'Successful verification should record phoneVerifiedAt.');
    assert.strictEqual(fixture.writes.some((item) => item.type === 'add'), false, 'SMS verification must never create a user.');
  } finally {
    if (previousSecret === undefined) delete process.env.SMS_CODE_HASH_SECRET;
    else process.env.SMS_CODE_HASH_SECRET = previousSecret;
  }
}

async function testForgedUserAssociationAfterCandidateIsRejectedWithoutWrites() {
  const secret = 'sms-test-secret';
  const openid = 'wechat_user_race';
  const phone = '13800138000';
  const previousSecret = process.env.SMS_CODE_HASH_SECRET;
  process.env.SMS_CODE_HASH_SECRET = secret;
  try {
    const fixture = loadVerifySms(openid, boundSeed(openid, phone, secret));
    fixture.beforeTransaction((state) => {
      state.users[0]._openid = 'forged_openid';
    });

    const result = await fixture.fn.main({ phone, code: '123456' });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'ACCOUNT_NOT_BOUND');
    assert.strictEqual(fixture.state.sms_codes[0].used, false);
    assert.strictEqual(fixture.writes.length, 0, 'Changed user association must be rejected before consuming the code.');
  } finally {
    if (previousSecret === undefined) delete process.env.SMS_CODE_HASH_SECRET;
    else process.env.SMS_CODE_HASH_SECRET = previousSecret;
  }
}

async function testTransactionRollsBackCodeWhenUserUpdateFails() {
  const secret = 'sms-test-secret';
  const openid = 'wechat_transaction_failure';
  const phone = '13800138000';
  const previousSecret = process.env.SMS_CODE_HASH_SECRET;
  process.env.SMS_CODE_HASH_SECRET = secret;
  try {
    const fixture = loadVerifySms(openid, boundSeed(openid, phone, secret));
    fixture.failTransactionWriteAt(2);

    await assert.rejects(
      () => fixture.fn.main({ phone, code: '123456' }),
      /simulated transaction write failure/
    );

    assert.strictEqual(fixture.state.sms_codes[0].used, false);
    assert.strictEqual(fixture.state.users[0].phoneVerifiedAt, undefined);
    assert.strictEqual(fixture.writes.length, 0, 'A failed transaction must expose no partial writes.');
  } finally {
    if (previousSecret === undefined) delete process.env.SMS_CODE_HASH_SECRET;
    else process.env.SMS_CODE_HASH_SECRET = previousSecret;
  }
}

async function testConcurrentVerificationConsumesCodeOnce() {
  const secret = 'sms-test-secret';
  const openid = 'wechat_concurrent';
  const phone = '13800138000';
  const previousSecret = process.env.SMS_CODE_HASH_SECRET;
  process.env.SMS_CODE_HASH_SECRET = secret;
  try {
    const fixture = loadVerifySms(openid, boundSeed(openid, phone, secret));
    const results = await Promise.all([
      fixture.fn.main({ phone, code: '123456' }),
      fixture.fn.main({ phone, code: '123456' })
    ]);

    assert.strictEqual(results.filter((result) => result.ok).length, 1);
    const rejected = results.find((result) => !result.ok);
    assert(rejected, 'One concurrent verification should be rejected.');
    assert.strictEqual(rejected.code, 'INVALID_CODE');
    assert.strictEqual(fixture.writes.filter((item) => item.collection === 'sms_codes').length, 1);
  } finally {
    if (previousSecret === undefined) delete process.env.SMS_CODE_HASH_SECRET;
    else process.env.SMS_CODE_HASH_SECRET = previousSecret;
  }
}

async function testCurrentRoleMustBelongToServerRoles() {
  const secret = 'sms-test-secret';
  const openid = 'wechat_contradictory_role';
  const phone = '13800138000';
  const seed = boundSeed(openid, phone, secret);
  seed.users[0].currentRole = 'shop';
  seed.users[0].role = 'shop';
  const previousSecret = process.env.SMS_CODE_HASH_SECRET;
  process.env.SMS_CODE_HASH_SECRET = secret;
  try {
    const fixture = loadVerifySms(openid, seed);
    const result = await fixture.fn.main({ phone, code: '123456' });

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.roles, ['member']);
    assert.strictEqual(result.currentRole, 'member');
  } finally {
    if (previousSecret === undefined) delete process.env.SMS_CODE_HASH_SECRET;
    else process.env.SMS_CODE_HASH_SECRET = previousSecret;
  }
}

async function testBindingReadFailurePropagatesWithoutWrites() {
  const secret = 'sms-test-secret';
  const openid = 'wechat_read_failure';
  const phone = '13800138000';
  const previousSecret = process.env.SMS_CODE_HASH_SECRET;
  process.env.SMS_CODE_HASH_SECRET = secret;
  try {
    const fixture = loadVerifySms(openid, boundSeed(openid, phone, secret));
    fixture.failReadOf('wechat_bindings');

    await assert.rejects(
      () => fixture.fn.main({ phone, code: '123456' }),
      /simulated wechat_bindings read failure/
    );

    assert.strictEqual(fixture.state.sms_codes[0].used, false);
    assert.strictEqual(fixture.writes.length, 0);
  } finally {
    if (previousSecret === undefined) delete process.env.SMS_CODE_HASH_SECRET;
    else process.env.SMS_CODE_HASH_SECRET = previousSecret;
  }
}

function testVerifySmsUsesExplicitDeterministicRelations() {
  assert(/user\._id\s*!==\s*bindingId/.test(verifySmsCode), 'verifySmsCode should explicitly validate the deterministic user id.');
  assert(/binding\.accountId\s*!==\s*account\._id/.test(verifySmsCode), 'verifySmsCode should validate binding-to-account document identity.');
  assert(verifySmsCode.includes('db.runTransaction'), 'Code consumption and user verification must share one transaction.');
  assert(!verifySmsCode.includes('.get().catch(() => null)'), 'Database read failures must propagate instead of becoming missing records.');
}

(async () => {
  await testConcurrentSendUsesSingleAtomicCooldown();
  await testFailedSendKeepsCooldownAndDoesNotLeakProviderDetails();
  await testNewSendReplacesPreviousCode();
  await testFiveWrongCodesAtomicallyLockLatestCode();
  await testMalformedLatestCodeIsRejectedWithoutWrites();
  await testConcurrentWrongAndCorrectCannotBypassAttemptLimit();
  await testUnboundWechatCannotConsumeCodeOrCreateUser();
  await testIncompleteAccountChainCannotConsumeCode();
  await testSmsCanReplaceDifferentBoundUserPhone();
  await testSmsCanSetMissingBoundUserPhone();
  await testBoundSmsReturnsServerIdentity();
  await testForgedUserAssociationAfterCandidateIsRejectedWithoutWrites();
  await testTransactionRollsBackCodeWhenUserUpdateFails();
  await testConcurrentVerificationConsumesCodeOnce();
  await testCurrentRoleMustBelongToServerRoles();
  await testBindingReadFailurePropagatesWithoutWrites();
  testVerifySmsUsesExplicitDeterministicRelations();
  assert(!loginJs.includes('findRegisteredAccount'), 'SMS login must not consult local account records.');
  assert(!loginJs.includes('readRegisteredAccounts'), 'Login page must not expose a local authentication source.');
  assert(!loginJs.includes('normalizeAccountRoles'), 'Login page must not derive roles from local account records.');
})();
