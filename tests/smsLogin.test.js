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

function matches(document, query) {
  return Object.keys(query || {}).every((key) => document[key] === query[key]);
}

function loadVerifySms(openid, seed) {
  const state = seed;
  const writes = [];
  const verifyPath = path.join(root, 'cloudfunctions/verifySmsCode/index.js');

  function collection(name) {
    const documents = state[name] || (state[name] = []);
    return {
      doc(id) {
        return {
          async get() {
            const found = documents.find((item) => item._id === id);
            return { data: found ? clone(found) : null };
          },
          async update({ data }) {
            const index = documents.findIndex((item) => item._id === id);
            if (index === -1) throw new Error(`document ${id} does not exist`);
            documents[index] = Object.assign({}, documents[index], clone(data));
            writes.push({ type: 'update', collection: name, id, data: clone(data) });
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
        writes.push({ type: 'add', collection: name, id, data: clone(data) });
        return { _id: id };
      }
    };
  }

  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database() {
      return {
        collection,
        serverDate() {
          return 'server-date';
        }
      };
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
    return { fn: require(verifyPath), state, writes };
  } finally {
    Module._load = originalLoad;
  }
}

function validCode(openid, phone, secret) {
  const now = Date.now();
  return {
    _id: `code_${openid}`,
    _openid: openid,
    phone,
    codeHash: hashCode(phone, '123456', secret),
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
assert(verifySmsCode.includes("db.collection('users')"), 'verifySmsCode should bind the verified phone to the current user.');
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

async function testSmsPhoneMustMatchBoundUser() {
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
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'PHONE_NOT_MATCH');
    assert.strictEqual(fixture.state.sms_codes[0].used, false);
    assert.strictEqual(fixture.writes.length, 0, 'Mismatched phone verification must not consume the code.');
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

(async () => {
  await testUnboundWechatCannotConsumeCodeOrCreateUser();
  await testSmsPhoneMustMatchBoundUser();
  await testBoundSmsReturnsServerIdentity();
  assert(!loginJs.includes('findRegisteredAccount'), 'SMS login must not consult local account records.');
  assert(!loginJs.includes('readRegisteredAccounts'), 'Login page must not expose a local authentication source.');
  assert(!loginJs.includes('normalizeAccountRoles'), 'Login page must not derive roles from local account records.');
})();
