const assert = require('assert');
const crypto = require('crypto');
const path = require('path');

const root = path.resolve(__dirname, '..');

function loadSharedModules(names) {
  const loaded = {};
  const missing = [];
  for (const name of names) {
    const modulePath = path.join(
      root,
      'cloudfunctions',
      '_shared',
      'auth',
      `${name}.js`
    );
    try {
      loaded[name] = require(modulePath);
    } catch (error) {
      if (
        error
        && error.code === 'MODULE_NOT_FOUND'
        && String(error.message).includes(modulePath)
      ) {
        missing.push(name);
        continue;
      }
      throw error;
    }
  }
  if (missing.length > 0) {
    const error = new Error(
      `MODULE_NOT_FOUND: missing shared auth modules: ${missing.join(', ')}`
    );
    error.code = 'MODULE_NOT_FOUND';
    throw error;
  }
  return loaded;
}

const {
  keyring: {
    loadKeyring,
    deriveKey,
    versionedHmacId,
    candidateHmacIds
  },
  identifiers: {
    normalizePhone,
    normalizeAccountName,
    newAccountId,
    wechatIdentity
  },
  password: {
    hashPassword,
    verifyPasswordOrDummy
  }
} = loadSharedModules(['keyring', 'identifiers', 'password']);

const ACTIVE_ROOT = Buffer.alloc(32, 0x11);
const HISTORICAL_ROOT = Buffer.alloc(48, 0x22);
const ACTIVE_ROOT_BASE64 = ACTIVE_ROOT.toString('base64');
const HISTORICAL_ROOT_BASE64 = HISTORICAL_ROOT.toString('base64');

function validEnvironment(overrides) {
  return {
    CUETRACE_AUTH_KEY_ACTIVE_VERSION: 'K2',
    CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS: 'K1',
    CUETRACE_AUTH_KEY_K2: ACTIVE_ROOT_BASE64,
    CUETRACE_AUTH_KEY_K1: HISTORICAL_ROOT_BASE64,
    ...overrides
  };
}

function expectCode(action, code) {
  assert.throws(action, (error) => {
    assert.strictEqual(error && error.code, code);
    return true;
  });
}

function errorFrom(action) {
  try {
    action();
  } catch (error) {
    return error;
  }
  assert.fail('expected action to throw');
}

function countCodePoints(value) {
  return [...value].length;
}

function assertScryptCall(call) {
  assert.strictEqual(call.passwordType, 'string');
  assert.strictEqual(call.saltLength, 16);
  assert.strictEqual(call.keylen, 64);
  assert.deepStrictEqual(call.options, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  });
}

function withScryptInstrumentation(action) {
  const original = crypto.scryptSync;
  const calls = [];
  crypto.scryptSync = function instrumentedScrypt(
    password,
    salt,
    keylen,
    options
  ) {
    calls.push({
      passwordType: typeof password,
      saltLength: Buffer.from(salt).length,
      keylen,
      options: { ...options }
    });
    return original.call(this, password, salt, keylen, options);
  };
  try {
    return action(calls);
  } finally {
    crypto.scryptSync = original;
  }
}

function testKeyringConfigurationAndDerivation() {
  const keyring = loadKeyring(validEnvironment());
  assert.strictEqual(keyring.activeVersion, 'K2');
  assert.deepStrictEqual(keyring.historicalVersions, ['K1']);
  assert(keyring.keys, 'deriveKey needs protected key material');

  const serialized = JSON.stringify(keyring);
  assert(!serialized.includes(ACTIVE_ROOT_BASE64));
  assert(!serialized.includes(HISTORICAL_ROOT_BASE64));
  assert(!serialized.includes(ACTIVE_ROOT.toString('hex')));
  assert(!serialized.includes(HISTORICAL_ROOT.toString('hex')));

  const actualPhoneKey = deriveKey(keyring, 'K2', 'phone-binding');
  const expectedPhoneKey = Buffer.from(crypto.hkdfSync(
    'sha256',
    ACTIVE_ROOT,
    Buffer.from('cuetrace-auth-v2'),
    Buffer.from('phone-binding'),
    32
  ));
  assert(Buffer.isBuffer(actualPhoneKey));
  assert.strictEqual(actualPhoneKey.length, 32);
  assert(actualPhoneKey.equals(expectedPhoneKey));

  const wechatKey = deriveKey(keyring, 'K2', 'wechat-binding');
  const historicalPhoneKey = deriveKey(keyring, 'K1', 'phone-binding');
  assert(!actualPhoneKey.equals(wechatKey), 'HKDF purposes must be separated');
  assert(
    !actualPhoneKey.equals(historicalPhoneKey),
    'root key versions must derive independent keys'
  );

  const rawIdentifier = '+8613800138000';
  const phoneId = versionedHmacId(
    keyring,
    'phone-binding',
    rawIdentifier,
    'phone'
  );
  const purposeSeparatedId = versionedHmacId(
    keyring,
    'wechat-binding',
    rawIdentifier,
    'phone'
  );
  const prefixSeparatedId = versionedHmacId(
    keyring,
    'phone-binding',
    rawIdentifier,
    'credential'
  );
  assert.match(phoneId, /^phone\.K2\.[A-Za-z0-9_-]{43}$/);
  assert.notStrictEqual(phoneId, purposeSeparatedId);
  assert.notStrictEqual(phoneId, prefixSeparatedId);
  assert(!JSON.stringify({ phoneId }).includes(rawIdentifier));

  const candidates = candidateHmacIds(
    keyring,
    'phone-binding',
    rawIdentifier,
    'phone'
  );
  assert.deepStrictEqual(
    candidates.map(({ keyVersion, isActive }) => ({ keyVersion, isActive })),
    [
      { keyVersion: 'K2', isActive: true },
      { keyVersion: 'K1', isActive: false }
    ]
  );
  assert.strictEqual(candidates[0].id, phoneId);
  assert.match(candidates[1].id, /^phone\.K1\.[A-Za-z0-9_-]{43}$/);
  assert.notStrictEqual(candidates[0].id, candidates[1].id);

  for (const purpose of [
    'phone-binding',
    'wechat-binding',
    'session-token',
    'sms-code',
    'sms-challenge',
    'auth-proof',
    'rate-limit'
  ]) {
    assert.strictEqual(deriveKey(keyring, 'K2', purpose).length, 32);
  }
  expectCode(
    () => deriveKey(keyring, 'K2', 'unapproved-purpose'),
    'AUTH_CONFIG_INVALID'
  );
}

function testStrictKeyringValidation() {
  const invalidEnvironments = [
    {},
    validEnvironment({
      CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS: undefined
    }),
    validEnvironment({ CUETRACE_AUTH_KEY_ACTIVE_VERSION: 'bad-version' }),
    validEnvironment({ CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS: 'K1,K1' }),
    validEnvironment({ CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS: 'K2' }),
    validEnvironment({
      CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS: 'K1,MISSING'
    }),
    validEnvironment({ CUETRACE_AUTH_KEY_K2: 'not base64!' }),
    validEnvironment({ CUETRACE_AUTH_KEY_K2: ACTIVE_ROOT_BASE64.slice(0, -1) }),
    validEnvironment({
      CUETRACE_AUTH_KEY_K2: Buffer.alloc(31, 0x33).toString('base64')
    }),
    validEnvironment({ CUETRACE_AUTH_KEY_K1: '' })
  ];
  for (const environment of invalidEnvironments) {
    const error = errorFrom(() => loadKeyring(environment));
    assert.strictEqual(error.code, 'AUTH_CONFIG_INVALID');
    const serialized = JSON.stringify({
      name: error.name,
      code: error.code,
      message: error.message,
      stack: error.stack
    });
    assert(!serialized.includes(ACTIVE_ROOT_BASE64));
    assert(!serialized.includes(HISTORICAL_ROOT_BASE64));
    assert(!serialized.includes('not base64!'));
    assert(!serialized.includes('CUETRACE_AUTH_KEY_K2'));
  }

  const missingHistoricalSecret = 'historical-secret-must-not-leak';
  const error = errorFrom(() => loadKeyring(validEnvironment({
    CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS: 'K1,OLD',
    CUETRACE_AUTH_KEY_OLD: missingHistoricalSecret
  })));
  assert.strictEqual(error.code, 'AUTH_CONFIG_INVALID');
  assert(!JSON.stringify(error).includes(missingHistoricalSecret));
  assert(!String(error.stack).includes(missingHistoricalSecret));
}

function testIdentifierNormalization() {
  assert.strictEqual(normalizePhone('13800138000'), '+8613800138000');
  for (const value of [
    null,
    undefined,
    13800138000,
    '',
    ' 13800138000',
    '13800138000 ',
    '+8613800138000',
    '138-0013-8000',
    '23800138000',
    '1380013800',
    '138001380000'
  ]) {
    expectCode(() => normalizePhone(value), 'INVALID_PHONE');
  }

  assert.strictEqual(normalizeAccountName(' Abc_1 '), 'abc_1');
  assert.strictEqual(normalizeAccountName('Abc1'), 'abc1');
  assert.strictEqual(
    normalizeAccountName('A1234567890123456789'),
    'a1234567890123456789'
  );
  for (const value of [
    null,
    1234,
    '',
    'Ab1',
    'A12345678901234567890',
    '1abc',
    '13800138000',
    'ab-c',
    'ab c',
    'ábcd',
    'Ａbcd',
    'abc\n1'
  ]) {
    expectCode(() => normalizeAccountName(value), 'INVALID_ACCOUNT_NAME');
  }
}

function testRandomAccountIds() {
  let requestedBytes = 0;
  const first = newAccountId((length) => {
    requestedBytes = length;
    return Buffer.alloc(length, 0x41);
  });
  assert(requestedBytes >= 16);
  assert.match(first, /^acct_[A-Za-z0-9_-]{22,}$/);
  assert(!first.includes('='));
  assert(!first.includes(String(Date.now())));

  const second = newAccountId((length) => Buffer.alloc(length, 0x42));
  assert.notStrictEqual(first, second);
  expectCode(
    () => newAccountId(() => Buffer.alloc(15)),
    'AUTH_RANDOM_INVALID'
  );
}

function testTrustedWechatIdentity() {
  const first = wechatIdentity({
    APPID: 'ab',
    OPENID: 'c',
    UNIONID: 'union-secret'
  });
  const second = wechatIdentity({
    APPID: 'a',
    OPENID: 'bc'
  });
  assert.strictEqual(typeof first.bindingInput, 'string');
  assert.strictEqual(typeof first.unionidAuditInput, 'string');
  assert.notStrictEqual(
    first.bindingInput,
    second.bindingInput,
    'APPID/OPENID pairs must use an unambiguous representation'
  );
  assert(first.unionidAuditInput);
  assert.strictEqual(second.unionidAuditInput, '');
  assert.deepStrictEqual(Object.keys(first), []);
  assert.deepStrictEqual({ ...first }, {});
  assert.strictEqual(
    wechatIdentity({
      APPID: 'ab',
      OPENID: 'c',
      UNIONID: 'union-secret'
    }).bindingInput,
    first.bindingInput
  );

  const serialized = JSON.stringify(first);
  for (const secret of ['ab', 'c', 'union-secret']) {
    assert(
      !serialized.includes(secret),
      `serialized WeChat identity leaked ${secret}`
    );
  }

  for (const context of [
    null,
    {},
    { APPID: '', OPENID: 'open' },
    { APPID: 'app', OPENID: '' },
    { APPID: ' ', OPENID: 'open' },
    { APPID: 'app', OPENID: ' ' },
    { APPID: 1, OPENID: 'open' },
    { APPID: 'app', OPENID: 1 },
    { APPID: 'app', OPENID: 'open', UNIONID: '' },
    { APPID: 'app', OPENID: 'open', UNIONID: ' ' },
    { APPID: 'app', OPENID: 'open', UNIONID: null }
  ]) {
    expectCode(() => wechatIdentity(context), 'INVALID_WECHAT_IDENTITY');
  }
}

function testPasswordHashingAndVerification() {
  const password = 'päss🔐A';
  assert.strictEqual(countCodePoints(password), 6);
  const salt = Buffer.from('00112233445566778899aabbccddeeff', 'hex');

  const record = withScryptInstrumentation((calls) => {
    let requestedBytes = 0;
    const value = hashPassword(password, (length) => {
      requestedBytes = length;
      return Buffer.from(salt);
    });
    assert.strictEqual(requestedBytes, 16);
    assert.strictEqual(calls.length, 1);
    assertScryptCall(calls[0]);
    return value;
  });

  assert.deepStrictEqual(Object.keys(record).sort(), [
    'passwordAlgorithm',
    'passwordHash',
    'passwordSalt'
  ]);
  assert.strictEqual(record.passwordAlgorithm, 'scrypt-v1');
  assert.strictEqual(record.passwordSalt, salt.toString('hex'));
  assert.match(record.passwordSalt, /^[0-9a-f]{32}$/);
  assert.match(record.passwordHash, /^[0-9a-f]{128}$/);
  assert(!JSON.stringify(record).includes(password));

  withScryptInstrumentation((calls) => {
    assert.strictEqual(verifyPasswordOrDummy(password, record), true);
    assert.strictEqual(calls.length, 1);
    assertScryptCall(calls[0]);
  });

  const equalCostCases = [
    ['unknown account', password, null],
    ['unset password', password, {
      passwordAlgorithm: '',
      passwordSalt: '',
      passwordHash: ''
    }],
    ['malformed algorithm', password, {
      ...record,
      passwordAlgorithm: 'scrypt-v2'
    }],
    ['malformed salt', password, {
      ...record,
      passwordSalt: 'zz'.repeat(16)
    }],
    ['malformed hash', password, {
      ...record,
      passwordHash: '00'
    }],
    ['invalid password type', 123456, record],
    ['invalid password length', 'short', record],
    ['wrong password', 'wrong-password', record]
  ];
  for (const [label, candidate, account] of equalCostCases) {
    withScryptInstrumentation((calls) => {
      assert.strictEqual(
        verifyPasswordOrDummy(candidate, account),
        false,
        label
      );
      assert.strictEqual(calls.length, 1, `${label} must perform one scrypt`);
      assertScryptCall(calls[0]);
    });
  }

  expectCode(
    () => hashPassword('short', () => Buffer.alloc(16)),
    'INVALID_PASSWORD'
  );
  expectCode(
    () => hashPassword('x'.repeat(65), () => Buffer.alloc(16)),
    'INVALID_PASSWORD'
  );
  expectCode(
    () => hashPassword('valid1', () => Buffer.alloc(15)),
    'AUTH_RANDOM_INVALID'
  );

  const spacesMatter = hashPassword(
    ' abcde ',
    () => Buffer.from('ffeeddccbbaa99887766554433221100', 'hex')
  );
  assert.strictEqual(verifyPasswordOrDummy(' abcde ', spacesMatter), true);
  assert.strictEqual(verifyPasswordOrDummy('abcde', spacesMatter), false);
}

function main() {
  testKeyringConfigurationAndDerivation();
  testStrictKeyringValidation();
  testIdentifierNormalization();
  testRandomAccountIds();
  testTrustedWechatIdentity();
  testPasswordHashingAndVerification();
  console.log('AUTH_PRIMITIVES_OK');
}

main();
