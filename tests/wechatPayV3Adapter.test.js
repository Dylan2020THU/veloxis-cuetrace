const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const clientPath = path.join(
  root,
  'cloudfunctions/_shared/wechatpay-v3/client.js'
);
const configPath = path.join(
  root,
  'cloudfunctions/_shared/wechatpay-v3/config.js'
);
const httpEventPath = path.join(
  root,
  'cloudfunctions/_shared/wechatpay-v3/http-event.js'
);
const billParserPath = path.join(
  root,
  'cloudfunctions/_shared/wechatpay-v3/bill-parser.js'
);

const {
  ENDPOINTS,
  buildRequestMessage,
  createAuthorization,
  buildVerificationMessage,
  verifyWechatPaySignature,
  signMiniProgramPayment,
  encryptSensitiveField,
  decryptResource,
  createWechatPayClient
} = require(clientPath);
const {
  ENV_NAMES,
  loadWechatPayConfig
} = require(configPath);
const {
  extractWechatPayEvent,
  getWechatPaySecurityHeaders,
  validateNormalizedSecurityHeaders
} = require(httpEventPath);
const {
  yuanToFen,
  verifyBillHash,
  parseBillCsv,
  parseVerifiedBill
} = require(billParserPath);

const DISCLAIMER = 'AI 参考官方 Java 翻译生成，非官方维护。请开发人员自行审查 AI 生成的代码逻辑，上线前充分测试以确保其适用性与准确性，AI 不对生成代码的正确性承担责任。';
const NOW_SECONDS = 1_800_000_000;
const MERCHANT_SERIAL = 'A1B2C3D4';
const PLATFORM_SERIAL = 'FACE1234';
const PLATFORM_PUBLIC_KEY_ID = 'PUB_KEY_ID_0123456789ABCDEF0123456789ABCDEF';
const API_V3_KEY = '0123456789abcdef0123456789abcdef';
const APPROVED_ENV_NAMES = Object.freeze([
  'WXPAY_V3_ENABLED',
  'WXPAY_SP_APPID',
  'WXPAY_SP_MCHID',
  'WXPAY_MERCHANT_SERIAL_NO',
  'WXPAY_MERCHANT_PRIVATE_KEY',
  'WXPAY_API_V3_KEY',
  'WXPAY_PLATFORM_CERTS_JSON',
  'WXPAY_TABLE_NOTIFY_URL',
  'WXPAY_TABLE_REFUND_NOTIFY_URL',
  'WXPAY_PLATFORM_RECEIVER_NAME',
  'WXPAY_ENCRYPTION_KEY_ID'
]);

const merchantKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const platformKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const merchantPrivatePem = merchantKeys.privateKey.export({
  type: 'pkcs8',
  format: 'pem'
});
const platformPublicPem = platformKeys.publicKey.export({
  type: 'spki',
  format: 'pem'
});

const tests = [];

function test(name, callback) {
  tests.push([name, callback]);
}

function sign(privateKey, message) {
  return crypto.sign('RSA-SHA256', message, privateKey).toString('base64');
}

function securityHeaders(privateKey, rawBody, overrides = {}) {
  const timestamp = overrides.timestamp || String(NOW_SECONDS);
  const nonce = overrides.nonce || 'wechat-response-nonce';
  const serial = overrides.serial || PLATFORM_SERIAL;
  const signature = overrides.signature || sign(
    privateKey,
    buildVerificationMessage(timestamp, nonce, rawBody)
  );

  return {
    'Wechatpay-Timestamp': timestamp,
    'Wechatpay-Nonce': nonce,
    'Wechatpay-Signature': signature,
    'Wechatpay-Serial': serial
  };
}

function validEnvironment(overrides = {}) {
  return {
    WXPAY_V3_ENABLED: 'true',
    WXPAY_SP_APPID: 'wx1234567890abcdef',
    WXPAY_SP_MCHID: '1234567890',
    WXPAY_MERCHANT_SERIAL_NO: MERCHANT_SERIAL,
    WXPAY_MERCHANT_PRIVATE_KEY: merchantPrivatePem,
    WXPAY_API_V3_KEY: API_V3_KEY,
    WXPAY_PLATFORM_CERTS_JSON: JSON.stringify({
      [PLATFORM_SERIAL]: platformPublicPem
    }),
    WXPAY_TABLE_NOTIFY_URL: 'https://example.test/wechat/table-notify',
    WXPAY_TABLE_REFUND_NOTIFY_URL: 'https://example.test/wechat/refund-notify',
    WXPAY_PLATFORM_RECEIVER_NAME: '测试平台商户',
    WXPAY_ENCRYPTION_KEY_ID: PLATFORM_SERIAL,
    ...overrides
  };
}

function clientConfig() {
  return loadWechatPayConfig(validEnvironment());
}

function parseAuthorization(value) {
  assert.match(value, /^WECHATPAY2-SHA256-RSA2048 /);
  const fields = {};
  for (const match of value.matchAll(/([a-z_]+)="([^"]*)"/g)) {
    fields[match[1]] = match[2];
  }
  return fields;
}

function signedTransport(handler) {
  return async (request) => {
    const result = await handler(request);
    const body = Buffer.isBuffer(result.body)
      ? result.body
      : Buffer.from(result.body || '', 'utf8');
    return {
      statusCode: result.statusCode || 200,
      headers: result.headers || securityHeaders(platformKeys.privateKey, body),
      body
    };
  };
}

test('adapter source contains the approved Node reference disclaimer', () => {
  assert(fs.readFileSync(clientPath, 'utf8').includes(DISCLAIMER));
});

test('gitignore covers local payment secrets and private key directories', () => {
  const patterns = new Set(
    fs.readFileSync(path.join(root, '.gitignore'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  );
  for (const required of [
    '.cursorindexingignore',
    '.specstory/',
    '.claude/',
    'deck/',
    'business files/',
    '.worktrees/',
    '.env',
    '*.pem',
    '*.p12',
    '*.key',
    'private-certificates/',
    'private-keys/'
  ]) {
    assert(patterns.has(required), `.gitignore should contain ${required}`);
  }
});

test('request canonical message preserves the exact encoded path and body', () => {
  const message = buildRequestMessage(
    'POST',
    '/v3/pay/partner/transactions/jsapi?note=a%2Fb%20c',
    '1700000000',
    'nonce-1',
    '{"amount":1}'
  );

  assert.strictEqual(
    message,
    'POST\n/v3/pay/partner/transactions/jsapi?note=a%2Fb%20c\n1700000000\nnonce-1\n{"amount":1}\n'
  );
});

test('authorization contains the required fields and a valid RSA-SHA256 signature', () => {
  const method = 'POST';
  const requestPath = ENDPOINTS.createJsapi;
  const timestamp = '1700000001';
  const nonce = 'nonce-authorization';
  const body = '{"description":"桌台订单"}';
  const authorization = createAuthorization({
    method,
    path: requestPath,
    timestamp,
    nonce,
    body,
    mchid: '1234567890',
    serialNo: MERCHANT_SERIAL,
    privateKey: merchantKeys.privateKey
  });
  const fields = parseAuthorization(authorization);

  assert.deepStrictEqual(
    Object.keys(fields).sort(),
    ['mchid', 'nonce_str', 'serial_no', 'signature', 'timestamp']
  );
  assert.strictEqual(fields.mchid, '1234567890');
  assert.strictEqual(fields.nonce_str, nonce);
  assert.strictEqual(fields.timestamp, timestamp);
  assert.strictEqual(fields.serial_no, MERCHANT_SERIAL);
  assert.strictEqual(
    crypto.verify(
      'RSA-SHA256',
      buildRequestMessage(method, requestPath, timestamp, nonce, body),
      merchantKeys.publicKey,
      Buffer.from(fields.signature, 'base64')
    ),
    true
  );
});

test('response verification uses timestamp, nonce, and untouched raw bytes', () => {
  const rawBody = Buffer.from('{"message":"原始正文"}', 'utf8');
  const headers = securityHeaders(platformKeys.privateKey, rawBody);

  assert.deepStrictEqual(
    buildVerificationMessage(
      String(NOW_SECONDS),
      'wechat-response-nonce',
      rawBody
    ),
    Buffer.concat([
      Buffer.from(`${NOW_SECONDS}\nwechat-response-nonce\n`, 'utf8'),
      rawBody,
      Buffer.from('\n', 'utf8')
    ])
  );
  assert.strictEqual(
    verifyWechatPaySignature({
      securityHeaders: getWechatPaySecurityHeaders(headers),
      rawBody,
      platformCertificates: new Map([[PLATFORM_SERIAL, platformKeys.publicKey]]),
      nowSeconds: NOW_SECONDS
    }),
    true
  );
});

test('signature verification accepts a trusted WeChat Pay public key ID', () => {
  const rawBody = Buffer.from('{"public_key_mode":true}', 'utf8');
  const headers = securityHeaders(platformKeys.privateKey, rawBody, {
    serial: PLATFORM_PUBLIC_KEY_ID
  });

  assert.strictEqual(
    verifyWechatPaySignature({
      securityHeaders: getWechatPaySecurityHeaders(headers),
      rawBody,
      platformCertificates: new Map([
        [PLATFORM_PUBLIC_KEY_ID, platformKeys.publicKey]
      ]),
      nowSeconds: NOW_SECONDS
    }),
    true
  );
});

test('signature verification rejects missing, duplicate, stale, malformed, and unknown headers', () => {
  const rawBody = Buffer.from('{"ok":true}', 'utf8');
  const base = securityHeaders(platformKeys.privateKey, rawBody);
  const verify = (headers, nowSeconds = NOW_SECONDS) => verifyWechatPaySignature({
    securityHeaders: getWechatPaySecurityHeaders(headers),
    rawBody,
    platformCertificates: new Map([[PLATFORM_SERIAL, platformKeys.publicKey]]),
    nowSeconds
  });

  for (const name of Object.keys(base)) {
    const missing = { ...base };
    delete missing[name];
    assert.throws(() => verify(missing), /header/i);
  }

  assert.throws(
    () => verify({
      ...base,
      'wechatpay-timestamp': base['Wechatpay-Timestamp']
    }),
    /duplicate/i
  );
  assert.throws(
    () => verify(securityHeaders(platformKeys.privateKey, rawBody, {
      timestamp: String(NOW_SECONDS - 301)
    })),
    /timestamp/i
  );
  for (const timestamp of [' 1800000000', '1800000000.0', '-1', 'abc']) {
    assert.throws(
      () => verify({ ...base, 'Wechatpay-Timestamp': timestamp }),
      /timestamp/i
    );
  }
  assert.throws(
    () => verify({ ...base, 'Wechatpay-Serial': 'DEADBEEF' }),
    /serial/i
  );
  assert.throws(
    () => verify({ ...base, 'Wechatpay-Signature': 'not-base64!' }),
    /signature/i
  );
});

test('signature freshness accepts exact boundaries and rejects future replay', () => {
  const rawBody = Buffer.from('{"ok":true}', 'utf8');
  const verifyAt = (timestamp) => verifyWechatPaySignature({
    securityHeaders: getWechatPaySecurityHeaders(
      securityHeaders(platformKeys.privateKey, rawBody, {
        timestamp: String(timestamp)
      })
    ),
    rawBody,
    platformCertificates: new Map([[PLATFORM_SERIAL, platformKeys.publicKey]]),
    nowSeconds: NOW_SECONDS
  });

  assert.strictEqual(verifyAt(NOW_SECONDS - 300), true);
  assert.strictEqual(verifyAt(NOW_SECONDS + 300), true);
  assert.throws(() => verifyAt(NOW_SECONDS - 301), /timestamp/i);
  assert.throws(() => verifyAt(NOW_SECONDS + 301), /timestamp/i);
});

test('security header parsing accepts Node forms and rejects same/conflicting duplicates for every header', () => {
  const rawBody = Buffer.from('{"ok":true}', 'utf8');
  const headers = securityHeaders(platformKeys.privateKey, rawBody);
  const lowercase = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  );
  const rawHeaders = Object.entries(headers).flat();

  assert.deepStrictEqual(
    getWechatPaySecurityHeaders(lowercase),
    getWechatPaySecurityHeaders(rawHeaders)
  );
  for (const [name, value] of Object.entries(headers)) {
    for (const duplicateValue of [value, `${value}conflict`]) {
      assert.throws(
        () => getWechatPaySecurityHeaders([
          ...rawHeaders,
          name.toLowerCase(), duplicateValue
        ]),
        /duplicate/i
      );
      assert.throws(
        () => getWechatPaySecurityHeaders({
          ...headers,
          [name]: [value, duplicateValue]
        }),
        /duplicate/i
      );
    }
  }
});

test('raw header parsing rejects bare normalized field names', () => {
  const normalized = {
    timestamp: String(NOW_SECONDS),
    nonce: 'normalized-nonce',
    signature: Buffer.from('normalized-signature').toString('base64'),
    serial: PLATFORM_SERIAL
  };

  assert.throws(
    () => getWechatPaySecurityHeaders(normalized),
    /required.*header|header.*missing/i
  );
  assert.deepStrictEqual(
    validateNormalizedSecurityHeaders(normalized),
    normalized
  );
  assert.throws(
    () => validateNormalizedSecurityHeaders({
      ...normalized,
      'Wechatpay-Timestamp': normalized.timestamp
    }),
    /normalized.*header/i
  );
});

test('HTTP event extraction preserves raw notification bytes and rejects duplicate security headers', () => {
  const rawBody = Buffer.from('{"id":"notice-1"}', 'utf8');
  const headers = securityHeaders(platformKeys.privateKey, rawBody);
  const extracted = extractWechatPayEvent({
    headers,
    body: rawBody.toString('base64'),
    isBase64Encoded: true
  });

  assert.deepStrictEqual(extracted.rawBody, rawBody);
  assert.deepStrictEqual(extracted.headers, {
    timestamp: String(NOW_SECONDS),
    nonce: 'wechat-response-nonce',
    signature: headers['Wechatpay-Signature'],
    serial: PLATFORM_SERIAL
  });
  assert.strictEqual(
    verifyWechatPaySignature({
      securityHeaders: validateNormalizedSecurityHeaders(extracted.headers),
      rawBody: extracted.rawBody,
      platformCertificates: new Map([[PLATFORM_SERIAL, platformKeys.publicKey]]),
      nowSeconds: NOW_SECONDS
    }),
    true
  );
  assert.throws(
    () => getWechatPaySecurityHeaders([
      'Wechatpay-Timestamp', String(NOW_SECONDS),
      'wechatpay-timestamp', String(NOW_SECONDS),
      'Wechatpay-Nonce', 'nonce',
      'Wechatpay-Signature', 'c2lnbmF0dXJl',
      'Wechatpay-Serial', PLATFORM_SERIAL
    ]),
    /duplicate/i
  );
  assert.throws(
    () => extractWechatPayEvent({
      headers,
      body: '%%%not-base64%%%',
      isBase64Encoded: true
    }),
    /base64/i
  );
});

test('mini-program payment signature uses the required prepay_id package string', () => {
  const result = signMiniProgramPayment({
    appId: 'wx1234567890abcdef',
    timeStamp: '1700000010',
    nonceStr: 'mini-program-nonce',
    prepayId: 'wx201410272009395522657a690389285100',
    privateKey: merchantKeys.privateKey
  });

  assert.deepStrictEqual(
    {
      timeStamp: result.timeStamp,
      nonceStr: result.nonceStr,
      package: result.package,
      signType: result.signType
    },
    {
      timeStamp: '1700000010',
      nonceStr: 'mini-program-nonce',
      package: 'prepay_id=wx201410272009395522657a690389285100',
      signType: 'RSA'
    }
  );
  assert.strictEqual(
    crypto.verify(
      'RSA-SHA256',
      'wx1234567890abcdef\n1700000010\nmini-program-nonce\nprepay_id=wx201410272009395522657a690389285100\n',
      merchantKeys.publicKey,
      Buffer.from(result.paySign, 'base64')
    ),
    true
  );
});

test('sensitive fields use RSA-OAEP SHA-1 and return canonical base64', () => {
  const plaintext = '测试平台商户';
  const encrypted = encryptSensitiveField(plaintext, platformKeys.publicKey);

  assert.strictEqual(
    Buffer.from(encrypted, 'base64').toString('base64'),
    encrypted
  );
  assert.strictEqual(
    crypto.privateDecrypt(
      {
        key: platformKeys.privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha1'
      },
      Buffer.from(encrypted, 'base64')
    ).toString('utf8'),
    plaintext
  );
});

test('AES-256-GCM decrypts a resource whose final 16 bytes are the auth tag', () => {
  const nonce = '123456789012';
  const associatedData = 'transaction';
  const plaintext = Buffer.from('{"trade_state":"SUCCESS"}', 'utf8');
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    Buffer.from(API_V3_KEY, 'utf8'),
    Buffer.from(nonce, 'utf8')
  );
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag()
  ]).toString('base64');

  assert.deepStrictEqual(
    decryptResource({
      resource: {
        algorithm: 'AEAD_AES_256_GCM',
        ciphertext,
        nonce,
        associated_data: associatedData
      },
      apiV3Key: API_V3_KEY
    }),
    plaintext
  );
});

test('AES-256-GCM treats omitted associated_data as empty AAD', () => {
  const nonce = '123456789012';
  const plaintext = Buffer.from('{"refund_status":"SUCCESS"}', 'utf8');
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    Buffer.from(API_V3_KEY, 'utf8'),
    Buffer.from(nonce, 'utf8')
  );
  cipher.setAAD(Buffer.alloc(0));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag()
  ]).toString('base64');

  assert.deepStrictEqual(
    decryptResource({
      resource: {
        algorithm: 'AEAD_AES_256_GCM',
        ciphertext,
        nonce
      },
      apiV3Key: API_V3_KEY
    }),
    plaintext
  );
});

test('AES resource validation rejects invalid keys, algorithms, nonce, and base64', () => {
  const resource = {
    algorithm: 'AEAD_AES_256_GCM',
    ciphertext: Buffer.alloc(17).toString('base64'),
    nonce: '123456789012',
    associated_data: ''
  };

  assert.throws(
    () => decryptResource({ resource, apiV3Key: 'too-short' }),
    /32-byte/i
  );
  assert.throws(
    () => decryptResource({ resource, apiV3Key: '密'.repeat(32) }),
    /32-byte/i
  );
  assert.throws(
    () => decryptResource({
      resource: { ...resource, algorithm: 'AES_GCM' },
      apiV3Key: API_V3_KEY
    }),
    /algorithm/i
  );
  assert.throws(
    () => decryptResource({
      resource: { ...resource, nonce: 'short' },
      apiV3Key: API_V3_KEY
    }),
    /nonce/i
  );
  assert.throws(
    () => decryptResource({
      resource: { ...resource, ciphertext: 'not-base64!' },
      apiV3Key: API_V3_KEY
    }),
    /base64/i
  );
  assert.throws(
    () => decryptResource({
      resource: { ...resource, ciphertext: Buffer.alloc(16).toString('base64') },
      apiV3Key: API_V3_KEY
    }),
    /ciphertext/i
  );
  for (const invalidResource of [
    null,
    { ...resource, ciphertext: undefined },
    { ...resource, associated_data: undefined },
    { ...resource, associated_data: 1 },
    { ...resource, nonce: undefined },
    { ...resource, ciphertext: Buffer.alloc(17).toString('base64').replace(/=+$/, '') }
  ]) {
    assert.throws(
      () => decryptResource({ resource: invalidResource, apiV3Key: API_V3_KEY })
    );
  }

  const nonce = '123456789012';
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    Buffer.from(API_V3_KEY, 'utf8'),
    Buffer.from(nonce, 'utf8')
  );
  cipher.setAAD(Buffer.from('aad', 'utf8'));
  const encrypted = Buffer.concat([
    cipher.update('plaintext', 'utf8'),
    cipher.final(),
    cipher.getAuthTag()
  ]);
  encrypted[encrypted.length - 1] ^= 0xff;
  assert.throws(
    () => decryptResource({
      resource: {
        algorithm: 'AEAD_AES_256_GCM',
        ciphertext: encrypted.toString('base64'),
        nonce,
        associated_data: 'aad'
      },
      apiV3Key: API_V3_KEY
    }),
    /decryption failed/i
  );
});

test('configuration reads only the approved environment names and returns parsed key objects', () => {
  const accessed = [];
  const env = new Proxy(validEnvironment({ UNRELATED_SECRET: 'ignored' }), {
    get(target, property) {
      if (typeof property === 'string') accessed.push(property);
      return target[property];
    }
  });
  const config = loadWechatPayConfig(env);

  assert.deepStrictEqual(ENV_NAMES, APPROVED_ENV_NAMES);
  assert.deepStrictEqual(
    [...new Set(accessed)].sort(),
    [...APPROVED_ENV_NAMES].sort()
  );
  assert.strictEqual(config.spAppId, 'wx1234567890abcdef');
  assert.strictEqual(config.spMchid, '1234567890');
  assert.strictEqual(config.merchantSerialNo, MERCHANT_SERIAL);
  assert.strictEqual(config.merchantPrivateKey.type, 'private');
  assert.strictEqual(config.apiV3Key.length, 32);
  assert.strictEqual(config.platformCertificates.get(PLATFORM_SERIAL).type, 'public');
  assert.strictEqual(config.platformReceiverName, '测试平台商户');
  assert.strictEqual(config.encryptionKeyId, PLATFORM_SERIAL);
  assert.strictEqual(config.encryptionPublicKey.type, 'public');
});

test('configuration fails closed and never includes secret values in errors', () => {
  assert.throws(
    () => loadWechatPayConfig(validEnvironment({ WXPAY_V3_ENABLED: 'false' })),
    /disabled/i
  );
  for (const name of APPROVED_ENV_NAMES.filter(
    (name) => !['WXPAY_V3_ENABLED', 'WXPAY_ENCRYPTION_KEY_ID'].includes(name)
  )) {
    const env = validEnvironment();
    delete env[name];
    assert.throws(() => loadWechatPayConfig(env), /configuration/i);
  }

  const privateSentinel = 'PRIVATE_KEY_SECRET_SENTINEL';
  const apiSentinel = 'API_V3_SECRET_SENTINEL';
  for (const overrides of [
    { WXPAY_MERCHANT_PRIVATE_KEY: privateSentinel },
    { WXPAY_API_V3_KEY: apiSentinel },
    { WXPAY_PLATFORM_CERTS_JSON: ["{\"AA\":\"PLATFORM_CER", "T_SECRET_SENTINEL\"}"].join("") }
  ]) {
    let thrown;
    try {
      loadWechatPayConfig(validEnvironment(overrides));
    } catch (error) {
      thrown = error;
    }
    assert(thrown, 'invalid secret configuration should throw');
    assert(!thrown.message.includes(privateSentinel));
    assert(!thrown.message.includes(apiSentinel));
    assert(!thrown.message.includes('PLATFORM_CERT_SECRET_SENTINEL'));
  }
});

test('configuration rejects invalid identifiers, URLs, names, and all client fallback attempts', () => {
  const invalidOverrides = [
    { WXPAY_V3_ENABLED: 'TRUE' },
    { WXPAY_SP_APPID: 'not-an-appid' },
    { WXPAY_SP_MCHID: 'merchant-id' },
    { WXPAY_MERCHANT_SERIAL_NO: 'serial with spaces' },
    { WXPAY_TABLE_NOTIFY_URL: 'http://example.test/notify' },
    { WXPAY_TABLE_NOTIFY_URL: 'https://user:pass@example.test/notify' },
    { WXPAY_TABLE_REFUND_NOTIFY_URL: 'https://example.test/notify#fragment' },
    { WXPAY_PLATFORM_RECEIVER_NAME: ' leading-space' },
    { WXPAY_PLATFORM_RECEIVER_NAME: 'name\u0000control' },
    { WXPAY_PLATFORM_RECEIVER_NAME: '商'.repeat(50) }
  ];
  for (const overrides of invalidOverrides) {
    assert.throws(() => loadWechatPayConfig(validEnvironment(overrides)));
  }

  assert.throws(
    () => loadWechatPayConfig(
      { WXPAY_V3_ENABLED: 'true' },
      validEnvironment()
    ),
    /configuration/i
  );
  assert.throws(
    () => createWechatPayClient(undefined, {
      ...validEnvironment(),
      transport: async () => { throw new Error('must not run'); }
    }),
    /server configuration/i
  );
});

test('configuration errors redact valid secrets from all observable error channels', () => {
  const validApiSecret = 'S'.repeat(32);
  const privateMarker = merchantPrivatePem.split(/\r?\n/)[1].slice(0, 32);
  const certificateMarker = platformPublicPem.split(/\r?\n/)[1].slice(0, 32);
  let error;
  try {
    loadWechatPayConfig(validEnvironment({
      WXPAY_API_V3_KEY: validApiSecret,
      WXPAY_TABLE_NOTIFY_URL: 'not-a-url'
    }));
  } catch (caught) {
    error = caught;
  }
  assert(error, 'unrelated invalid configuration should throw');

  const enumerable = {};
  for (const key of Object.keys(error)) enumerable[key] = error[key];
  const observable = [
    error.message,
    error.stack,
    String(error.cause),
    JSON.stringify(enumerable)
  ].join('\n');
  for (const secret of [validApiSecret, privateMarker, certificateMarker]) {
    assert(!observable.includes(secret), 'configuration error should redact secrets');
  }
});

test('platform certificate JSON rejects duplicates, empty serials, invalid PEM, and trailing data', () => {
  const pemJson = JSON.stringify(platformPublicPem);
  const invalidMappings = [
    `{ "AA": ${pemJson}, "AA": ${pemJson} }`,
    `{ "AA": ${pemJson}, "aa": ${pemJson} }`,
    `{ "": ${pemJson} }`,
    `{ " AA ": ${pemJson} }`,
    '{ "AA": "not-a-pem" }',
    `{ "AA": ${pemJson} } trailing`
  ];

  for (const mapping of invalidMappings) {
    assert.throws(
      () => loadWechatPayConfig(validEnvironment({
        WXPAY_PLATFORM_CERTS_JSON: mapping
      })),
      /certificate configuration/i
    );
  }
});

test('configuration normalizes one trusted public key ID and rejects ambiguous or malformed IDs', () => {
  const lowercaseHexId = 'PUB_KEY_ID_0123456789abcdef0123456789abcdef';
  const config = loadWechatPayConfig(validEnvironment({
    WXPAY_PLATFORM_CERTS_JSON: JSON.stringify({
      [PLATFORM_SERIAL]: platformPublicPem,
      [lowercaseHexId]: platformPublicPem
    })
  }));

  assert.strictEqual(config.wechatPayPublicKeyId, PLATFORM_PUBLIC_KEY_ID);
  assert.strictEqual(
    config.platformCertificates.get(PLATFORM_PUBLIC_KEY_ID).type,
    'public'
  );
  assert.strictEqual(clientConfig().wechatPayPublicKeyId, null);

  const pemJson = JSON.stringify(platformPublicPem);
  const invalidMappings = [
    `{ "${PLATFORM_PUBLIC_KEY_ID}": ${pemJson}, "PUB_KEY_ID_00000000000000000000000000000001": ${pemJson} }`,
    `{ "${PLATFORM_PUBLIC_KEY_ID}": ${pemJson}, "PUB_KEY_ID_0123456789abcdef0123456789abcdef": ${pemJson} }`,
    `{ "PUB_KEY_ID_0123456789ABCDEF0123456789ABCDE": ${pemJson} }`,
    `{ "PUB_KEY_ID_0123456789ABCDEF0123456789ABCDEF0": ${pemJson} }`,
    `{ "PUB_KEY_ID_G123456789ABCDEF0123456789ABCDEF": ${pemJson} }`,
    `{ "pub_key_id_0123456789ABCDEF0123456789ABCDEF": ${pemJson} }`,
    `{ "PUB_KEY_1D_0123456789ABCDEF0123456789ABCDEF": ${pemJson} }`,
    `{ "AA_PUB_KEY_ID_0123456789ABCDEF0123456789ABCDEF": ${pemJson} }`
  ];
  for (const mapping of invalidMappings) {
    assert.throws(
      () => loadWechatPayConfig(validEnvironment({
        WXPAY_PLATFORM_CERTS_JSON: mapping
      })),
      /certificate configuration/i
    );
  }
});

test('configuration binds sensitive encryption to one exact trusted key identifier', () => {
  const secondCertificateSerial = 'BEEF5678';
  const omittedSingle = loadWechatPayConfig(validEnvironment({
    WXPAY_ENCRYPTION_KEY_ID: undefined
  }));
  assert.strictEqual(omittedSingle.encryptionKeyId, PLATFORM_SERIAL);
  assert.strictEqual(
    omittedSingle.encryptionPublicKey,
    omittedSingle.platformCertificates.get(PLATFORM_SERIAL)
  );

  const omittedPublicKey = loadWechatPayConfig(validEnvironment({
    WXPAY_PLATFORM_CERTS_JSON: JSON.stringify({
      [PLATFORM_SERIAL]: platformPublicPem,
      [PLATFORM_PUBLIC_KEY_ID]: platformPublicPem
    }),
    WXPAY_ENCRYPTION_KEY_ID: undefined
  }));
  assert.strictEqual(omittedPublicKey.encryptionKeyId, PLATFORM_PUBLIC_KEY_ID);
  assert.strictEqual(
    omittedPublicKey.encryptionPublicKey,
    omittedPublicKey.platformCertificates.get(PLATFORM_PUBLIC_KEY_ID)
  );

  const explicitCertificate = loadWechatPayConfig(validEnvironment({
    WXPAY_PLATFORM_CERTS_JSON: JSON.stringify({
      [PLATFORM_SERIAL]: platformPublicPem,
      [secondCertificateSerial]: platformPublicPem
    }),
    WXPAY_ENCRYPTION_KEY_ID: PLATFORM_SERIAL
  }));
  assert.strictEqual(explicitCertificate.encryptionKeyId, PLATFORM_SERIAL);
  assert.strictEqual(
    explicitCertificate.encryptionPublicKey,
    explicitCertificate.platformCertificates.get(PLATFORM_SERIAL)
  );

  for (const overrides of [
    {
      WXPAY_PLATFORM_CERTS_JSON: JSON.stringify({
        [PLATFORM_SERIAL]: platformPublicPem,
        [secondCertificateSerial]: platformPublicPem
      }),
      WXPAY_ENCRYPTION_KEY_ID: undefined
    },
    { WXPAY_ENCRYPTION_KEY_ID: 'UNKNOWN1234' },
    { WXPAY_ENCRYPTION_KEY_ID: PLATFORM_SERIAL.toLowerCase() },
    { WXPAY_ENCRYPTION_KEY_ID: `${PLATFORM_SERIAL} ` }
  ]) {
    assert.throws(
      () => loadWechatPayConfig(validEnvironment(overrides)),
      /encryption key/i
    );
  }
});

test('configuration accepts only exact RSA-2048 merchant and platform keys', () => {
  for (const modulusLength of [1024, 3072]) {
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength });
    const privatePem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' });

    assert.throws(
      () => loadWechatPayConfig(validEnvironment({
        WXPAY_MERCHANT_PRIVATE_KEY: privatePem
      })),
      /merchant key material/i,
      `RSA-${modulusLength} merchant key must be rejected`
    );
    assert.throws(
      () => loadWechatPayConfig(validEnvironment({
        WXPAY_PLATFORM_CERTS_JSON: JSON.stringify({
          [PLATFORM_SERIAL]: publicPem
        })
      })),
      /certificate configuration/i,
      `RSA-${modulusLength} platform key must be rejected`
    );
  }
});

test('client verifies signed JSON responses and signs the exact wire path', async () => {
  let captured;
  const transport = signedTransport(async (request) => {
    captured = request;
    return { body: '{"prepay_id":"wx-prepay"}' };
  });
  const client = createWechatPayClient(clientConfig(), {
    transport,
    nowSeconds: () => NOW_SECONDS,
    nonce: () => 'request-nonce'
  });
  const response = await client.requestJson({
    method: 'POST',
    path: `${ENDPOINTS.createJsapi}?note=a%2Fb%20c`,
    body: { amount: { total: 1, currency: 'CNY' } }
  });
  const fields = parseAuthorization(captured.headers.Authorization);

  assert.deepStrictEqual(response, { prepay_id: 'wx-prepay' });
  assert.strictEqual(
    captured.url,
    `https://api.mch.weixin.qq.com${ENDPOINTS.createJsapi}?note=a%2Fb%20c`
  );
  assert.strictEqual(captured.path, `${ENDPOINTS.createJsapi}?note=a%2Fb%20c`);
  assert.strictEqual(
    crypto.verify(
      'RSA-SHA256',
      buildRequestMessage(
        captured.method,
        captured.path,
        fields.timestamp,
        fields.nonce_str,
        captured.body
      ),
      merchantKeys.publicKey,
      Buffer.from(fields.signature, 'base64')
    ),
    true
  );
});

test('ordinary requests select configured public-key mode without caller header control', async () => {
  let publicKeyRequest;
  const publicKeyConfig = loadWechatPayConfig(validEnvironment({
    WXPAY_PLATFORM_CERTS_JSON: JSON.stringify({
      [PLATFORM_SERIAL]: platformPublicPem,
      [PLATFORM_PUBLIC_KEY_ID]: platformPublicPem
    })
  }));
  const publicKeyClient = createWechatPayClient(publicKeyConfig, {
    transport: signedTransport(async (request) => {
      publicKeyRequest = request;
      return { body: '{"ok":true}' };
    }),
    nowSeconds: () => NOW_SECONDS,
    nonce: () => 'request-nonce'
  });
  await publicKeyClient.requestJson({
    method: 'GET',
    path: ENDPOINTS.tradeBill,
    headers: { 'Wechatpay-Serial': 'CALLER_CONTROLLED' }
  });
  assert.strictEqual(
    publicKeyRequest.headers['Wechatpay-Serial'],
    PLATFORM_PUBLIC_KEY_ID
  );

  let certificateRequest;
  const certificateClient = createWechatPayClient(clientConfig(), {
    transport: signedTransport(async (request) => {
      certificateRequest = request;
      return { body: '{"ok":true}' };
    }),
    nowSeconds: () => NOW_SECONDS,
    nonce: () => 'request-nonce'
  });
  await certificateClient.requestJson({
    method: 'GET',
    path: ENDPOINTS.tradeBill,
    headers: { 'Wechatpay-Serial': 'CALLER_CONTROLLED' }
  });
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(
      certificateRequest.headers,
      'Wechatpay-Serial'
    ),
    false
  );
});

test('sensitive receiver requests bind RSA-OAEP ciphertext and Wechatpay-Serial to the same trusted key', async () => {
  const selectedConfig = loadWechatPayConfig(validEnvironment({
    WXPAY_PLATFORM_CERTS_JSON: JSON.stringify({
      [PLATFORM_SERIAL]: platformPublicPem,
      [PLATFORM_PUBLIC_KEY_ID]: platformPublicPem
    }),
    WXPAY_ENCRYPTION_KEY_ID: PLATFORM_SERIAL
  }));
  const encryptedName = encryptSensitiveField(
    selectedConfig.platformReceiverName,
    selectedConfig.encryptionPublicKey
  );
  const requests = [];
  const client = createWechatPayClient(selectedConfig, {
    transport: signedTransport(async (request) => {
      requests.push(request);
      return { body: '{"ok":true}' };
    }),
    nowSeconds: () => NOW_SECONDS,
    nonce: () => 'request-nonce'
  });

  await client.addReceiver({ name: encryptedName });
  await client.split({ receivers: [{ name: encryptedName }] });

  assert.strictEqual(requests.length, 2);
  for (const request of requests) {
    assert.strictEqual(request.headers['Wechatpay-Serial'], PLATFORM_SERIAL);
  }
  assert.strictEqual(
    crypto.privateDecrypt({
      key: platformKeys.privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha1'
    }, Buffer.from(encryptedName, 'base64')).toString('utf8'),
    '测试平台商户'
  );
});

test('client rejects non-canonical paths before invoking the transport', async () => {
  let transportCalls = 0;
  const client = createWechatPayClient(clientConfig(), {
    transport: async () => {
      transportCalls += 1;
      throw new Error('transport should not run for an invalid path');
    },
    nowSeconds: () => NOW_SECONDS,
    nonce: () => 'request-nonce'
  });

  for (const invalidPath of [
    `${ENDPOINTS.tradeBill}?note=unencoded space`,
    `${ENDPOINTS.tradeBill}?note=中文`,
    `${ENDPOINTS.tradeBill}?note=%ZZ`,
    '/v3/../outside',
    '/v3/./outside',
    '/v3/%2e%2e/outside',
    '/v3/%2E%2E/outside',
    '/v3/.%2e/outside',
    '/v3/%2e./outside',
    '/v3/%2E/outside',
    '/v3/%2e%2e%2Foutside',
    '/v3/safe%2F..%2Foutside',
    '/v3/%5coutside',
    '/v3/path%5Coutside'
  ]) {
    await assert.rejects(
      client.requestJson({ method: 'GET', path: invalidPath }),
      /encoded.*path|path.*encoded/i
    );
  }
  assert.strictEqual(transportCalls, 0);
});

test('requestJson verifies the exact raw body before attempting JSON parsing', async () => {
  const malformed = Buffer.from('{malformed-json', 'utf8');
  const invalidClient = createWechatPayClient(clientConfig(), {
    transport: async () => ({
      statusCode: 200,
      headers: securityHeaders(platformKeys.privateKey, malformed, {
        signature: Buffer.from('invalid-signature').toString('base64')
      }),
      body: malformed
    }),
    nowSeconds: () => NOW_SECONDS,
    nonce: () => 'request-nonce'
  });
  await assert.rejects(
    invalidClient.requestJson({ method: 'GET', path: ENDPOINTS.tradeBill }),
    (error) => {
      assert.match(error.message, /signature/i);
      assert.doesNotMatch(error.message, /JSON/i);
      return true;
    }
  );

  const whitespaceJson = Buffer.from(' {\r\n  "ok": true\r\n} \n', 'utf8');
  const validClient = createWechatPayClient(clientConfig(), {
    transport: signedTransport(async () => ({ body: whitespaceJson })),
    nowSeconds: () => NOW_SECONDS,
    nonce: () => 'request-nonce'
  });
  assert.deepStrictEqual(
    await validClient.requestJson({ method: 'GET', path: ENDPOINTS.tradeBill }),
    { ok: true }
  );
});

test('client returns verified raw bytes without JSON reserialization', async () => {
  const raw = Buffer.from([0, 1, 2, 13, 10, 255]);
  const client = createWechatPayClient(clientConfig(), {
    transport: signedTransport(async () => ({ body: raw })),
    nowSeconds: () => NOW_SECONDS,
    nonce: () => 'request-nonce'
  });

  assert.deepStrictEqual(
    await client.requestRaw({ method: 'GET', path: ENDPOINTS.tradeBill }),
    raw
  );
});

test('non-2xx details are surfaced only after response signature verification', async () => {
  const trustedBody = Buffer.from(
    '{"code":"PARAM_ERROR","message":"trusted detail"}',
    'utf8'
  );
  const trustedClient = createWechatPayClient(clientConfig(), {
    transport: signedTransport(async () => ({
      statusCode: 400,
      body: trustedBody
    })),
    nowSeconds: () => NOW_SECONDS,
    nonce: () => 'request-nonce'
  });

  await assert.rejects(
    trustedClient.requestJson({ method: 'GET', path: ENDPOINTS.tradeBill }),
    (error) => {
      assert.strictEqual(error.name, 'WechatPayApiError');
      assert.strictEqual(error.statusCode, 400);
      assert.strictEqual(error.code, 'PARAM_ERROR');
      assert.strictEqual(error.detail, 'trusted detail');
      return true;
    }
  );

  const untrustedDetail = 'UNVERIFIED_ERROR_DETAIL_SENTINEL';
  const untrustedClient = createWechatPayClient(clientConfig(), {
    transport: async () => ({
      statusCode: 400,
      headers: {},
      body: Buffer.from(JSON.stringify({ message: untrustedDetail }), 'utf8')
    }),
    nowSeconds: () => NOW_SECONDS,
    nonce: () => 'request-nonce'
  });
  await assert.rejects(
    untrustedClient.requestJson({ method: 'GET', path: ENDPOINTS.tradeBill }),
    (error) => {
      assert.match(error.message, /header|signature/i);
      assert(!error.message.includes(untrustedDetail));
      assert(!JSON.stringify(error).includes(untrustedDetail));
      return true;
    }
  );
});

test('non-2xx responses with present but invalid signatures never expose their body', async () => {
  const untrustedDetail = 'INVALID_SIGNATURE_ERROR_SENTINEL';
  const body = Buffer.from(JSON.stringify({
    code: 'UNTRUSTED',
    message: untrustedDetail
  }), 'utf8');
  const client = createWechatPayClient(clientConfig(), {
    transport: async () => ({
      statusCode: 403,
      headers: securityHeaders(platformKeys.privateKey, body, {
        signature: Buffer.from('present-but-invalid').toString('base64')
      }),
      body
    }),
    nowSeconds: () => NOW_SECONDS,
    nonce: () => 'request-nonce'
  });

  await assert.rejects(
    client.requestJson({ method: 'GET', path: ENDPOINTS.tradeBill }),
    (error) => {
      const enumerable = {};
      for (const key of Object.keys(error)) enumerable[key] = error[key];
      const observable = [
        error.message,
        error.stack,
        String(error.cause),
        JSON.stringify(enumerable)
      ].join('\n');
      assert.notStrictEqual(error.name, 'WechatPayApiError');
      assert.match(error.message, /signature/i);
      assert(!observable.includes(untrustedDetail));
      return true;
    }
  );
});

test('client requires a valid signature on every successful API response', async () => {
  const body = Buffer.from('{"ok":true}', 'utf8');
  const missingSignature = createWechatPayClient(clientConfig(), {
    transport: async () => ({ statusCode: 200, headers: {}, body }),
    nowSeconds: () => NOW_SECONDS,
    nonce: () => 'request-nonce'
  });
  await assert.rejects(
    missingSignature.requestJson({ method: 'GET', path: ENDPOINTS.tradeBill }),
    /header|signature/i
  );

  const invalidSignature = createWechatPayClient(clientConfig(), {
    transport: async () => ({
      statusCode: 200,
      headers: securityHeaders(platformKeys.privateKey, body, {
        signature: Buffer.from('wrong signature').toString('base64')
      }),
      body
    }),
    nowSeconds: () => NOW_SECONDS,
    nonce: () => 'request-nonce'
  });
  await assert.rejects(
    invalidSignature.requestJson({ method: 'GET', path: ENDPOINTS.tradeBill }),
    /signature/i
  );
});

test('client rejects a correctly signed but stale API response', async () => {
  const body = Buffer.from('{"ok":true}', 'utf8');
  const client = createWechatPayClient(clientConfig(), {
    transport: async () => ({
      statusCode: 200,
      headers: securityHeaders(platformKeys.privateKey, body, {
        timestamp: String(NOW_SECONDS - 301)
      }),
      body
    }),
    nowSeconds: () => NOW_SECONDS,
    nonce: () => 'request-nonce'
  });
  await assert.rejects(
    client.requestJson({ method: 'GET', path: ENDPOINTS.tradeBill }),
    /timestamp/i
  );
});

test('client times out, honors external abort, and sanitizes transport errors', async () => {
  const waitingTransport = ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const timeoutClient = createWechatPayClient(clientConfig(), {
    transport: waitingTransport,
    timeoutMs: 15,
    nowSeconds: () => NOW_SECONDS,
    nonce: () => 'request-nonce'
  });
  await assert.rejects(
    timeoutClient.requestJson({ method: 'GET', path: ENDPOINTS.tradeBill }),
    /timed out/i
  );

  const controller = new AbortController();
  controller.abort();
  const abortClient = createWechatPayClient(clientConfig(), {
    transport: waitingTransport,
    nowSeconds: () => NOW_SECONDS,
    nonce: () => 'request-nonce'
  });
  await assert.rejects(
    abortClient.requestJson({
      method: 'GET',
      path: ENDPOINTS.tradeBill,
      signal: controller.signal
    }),
    /aborted/i
  );

  const transportSecret = 'TRANSPORT_SECRET_SENTINEL';
  const failedClient = createWechatPayClient(clientConfig(), {
    transport: async () => { throw new Error(transportSecret); },
    nowSeconds: () => NOW_SECONDS,
    nonce: () => 'request-nonce'
  });
  await assert.rejects(
    failedClient.requestJson({ method: 'GET', path: ENDPOINTS.tradeBill }),
    (error) => !error.message.includes(transportSecret)
  );
});

test('client aborts an already running injected transport', async () => {
  let transportStarted;
  const started = new Promise((resolve) => { transportStarted = resolve; });
  const client = createWechatPayClient(clientConfig(), {
    transport: ({ signal }) => new Promise((resolve, reject) => {
      transportStarted();
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
    nowSeconds: () => NOW_SECONDS,
    nonce: () => 'request-nonce'
  });
  const controller = new AbortController();
  const pending = client.requestJson({
    method: 'GET',
    path: ENDPOINTS.tradeBill,
    signal: controller.signal
  });
  await started;
  controller.abort();
  await assert.rejects(pending, /aborted/i);
});

test('bill download signs the approved download_url and validates unsigned raw bytes with SHA1', async () => {
  const downloadUrl = 'https://api.mch.weixin.qq.com/v3/billdownload/file?token=a%2Fb%20c';
  const billBytes = Buffer.from('raw,bill\r\n`1,`2\r\n', 'utf8');
  const requests = [];
  const client = createWechatPayClient(clientConfig(), {
    transport: async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        const body = Buffer.from(JSON.stringify({
          download_url: downloadUrl,
          hash_type: 'SHA1',
          hash_value: crypto.createHash('sha1').update(billBytes).digest('hex')
        }), 'utf8');
        return {
          statusCode: 200,
          headers: securityHeaders(platformKeys.privateKey, body),
          body
        };
      }
      return { statusCode: 200, headers: {}, body: billBytes };
    },
    nowSeconds: () => NOW_SECONDS,
    nonce: () => 'request-nonce'
  });

  const metadata = await client.tradeBill({ bill_date: '2026-07-13' });
  assert.deepStrictEqual(await client.downloadBill(metadata), billBytes);
  assert.strictEqual(
    requests[1].path,
    '/v3/billdownload/file?token=a%2Fb%20c'
  );
  const authorization = parseAuthorization(requests[1].headers.Authorization);
  assert.strictEqual(
    crypto.verify(
      'RSA-SHA256',
      buildRequestMessage(
        'GET',
        requests[1].path,
        authorization.timestamp,
        authorization.nonce_str,
        ''
      ),
      merchantKeys.publicKey,
      Buffer.from(authorization.signature, 'base64')
    ),
    true
  );

  for (const invalidUrl of [
    'http://api.mch.weixin.qq.com/v3/billdownload/file?token=x',
    'https://attacker.example/v3/billdownload/file?token=x',
    'https://api.mch.weixin.qq.com@attacker.example/v3/billdownload/file?token=x',
    'https://user@api.mch.weixin.qq.com/v3/billdownload/file?token=x',
    'https://api.mch.weixin.qq.com:444/v3/billdownload/file?token=x',
    'https://api.mch.weixin.qq.com/v3/billdownload/other?token=x',
    'https://api.mch.weixin.qq.com/v3/billdownload/file?token=x#fragment'
  ]) {
    await assert.rejects(
      client.downloadBill({ ...metadata, download_url: invalidUrl }),
      /download_url/i
    );
  }
});

test('bill download rejects hash mismatch and never trusts unsigned non-2xx details', async () => {
  const untrustedDetail = 'UNSIGNED_DOWNLOAD_ERROR_SENTINEL';
  const metadata = {
    download_url: 'https://api.mch.weixin.qq.com/v3/billdownload/file?token=x',
    hash_type: 'SHA1',
    hash_value: crypto.createHash('sha1').update('expected').digest('hex')
  };
  const mismatchClient = createWechatPayClient(clientConfig(), {
    transport: async () => ({
      statusCode: 200,
      headers: {},
      body: Buffer.from('tampered', 'utf8')
    }),
    nowSeconds: () => NOW_SECONDS,
    nonce: () => 'request-nonce'
  });
  await assert.rejects(mismatchClient.downloadBill(metadata), (error) => {
    assert.match(error.message, /hash mismatch/i);
    assert.strictEqual(error.code, 'BILL_HASH_INVALID');
    return true;
  });

  const errorClient = createWechatPayClient(clientConfig(), {
    transport: async () => ({
      statusCode: 400,
      headers: {},
      body: Buffer.from(JSON.stringify({ message: untrustedDetail }), 'utf8')
    }),
    nowSeconds: () => NOW_SECONDS,
    nonce: () => 'request-nonce'
  });
  await assert.rejects(errorClient.downloadBill(metadata), (error) => {
    const enumerable = {};
    for (const key of Object.keys(error)) enumerable[key] = error[key];
    const observable = [
      error.message,
      error.stack,
      String(error.cause),
      JSON.stringify(enumerable)
    ].join('\n');
    assert.match(error.message, /download.*failed/i);
    assert(!observable.includes(untrustedDetail));
    return true;
  });
});

test('bill download accepts only the official backup host and signs its original raw path and query', async () => {
  const downloadUrl = 'https://api2.mch.weixin.qq.com/v3/billdownload/file?token=a%2Fb%2fC&tag=%7E&tag=%2B';
  const billBytes = Buffer.from('backup-host-bill', 'utf8');
  let captured;
  const client = createWechatPayClient(clientConfig(), {
    transport: async (request) => {
      captured = request;
      return { statusCode: 200, headers: {}, body: billBytes };
    },
    nowSeconds: () => NOW_SECONDS,
    nonce: () => 'request-nonce'
  });
  const metadata = {
    download_url: downloadUrl,
    hash_type: 'SHA1',
    hash_value: crypto.createHash('sha1').update(billBytes).digest('hex')
  };

  assert.deepStrictEqual(await client.downloadBill(metadata), billBytes);
  assert.strictEqual(captured.url, downloadUrl);
  assert.strictEqual(
    captured.path,
    '/v3/billdownload/file?token=a%2Fb%2fC&tag=%7E&tag=%2B'
  );
  const authorization = parseAuthorization(captured.headers.Authorization);
  assert.strictEqual(
    crypto.verify(
      'RSA-SHA256',
      buildRequestMessage(
        'GET',
        captured.path,
        authorization.timestamp,
        authorization.nonce_str,
        ''
      ),
      merchantKeys.publicKey,
      Buffer.from(authorization.signature, 'base64')
    ),
    true
  );

  await assert.rejects(
    client.downloadBill({
      ...metadata,
      download_url: 'https://api3.mch.weixin.qq.com/v3/billdownload/file?token=x'
    }),
    /download_url/i
  );
});

test('endpoint wrappers fix method/path, forward bodies, return data, and propagate verified rejection', async () => {
  const captured = [];
  const client = createWechatPayClient(clientConfig(), {
    transport: signedTransport(async (request) => {
      captured.push(request);
      if (captured.length === 1) return { body: '{"wrapper":"ok"}' };
      return {
        statusCode: 409,
        body: '{"code":"CONFLICT","message":"verified conflict"}'
      };
    }),
    nowSeconds: () => NOW_SECONDS,
    nonce: () => 'request-nonce'
  });
  const overrideAttempt = {
    method: 'GET',
    path: 'https://attacker.example/',
    description: 'table'
  };

  assert.deepStrictEqual(await client.createJsapi(overrideAttempt), {
    wrapper: 'ok'
  });
  assert.strictEqual(captured[0].method, 'POST');
  assert.strictEqual(captured[0].path, ENDPOINTS.createJsapi);
  assert.deepStrictEqual(JSON.parse(captured[0].body), overrideAttempt);
  await assert.rejects(
    client.refund({ out_refund_no: 'refund-1' }),
    (error) => error.name === 'WechatPayApiError' && error.code === 'CONFLICT'
  );
});

test('client exposes only the approved endpoint paths through deterministic wrappers', async () => {
  assert.deepStrictEqual(ENDPOINTS, {
    createJsapi: '/v3/pay/partner/transactions/jsapi',
    queryByOutTradeNo: '/v3/pay/partner/transactions/out-trade-no/',
    refund: '/v3/refund/domestic/refunds',
    queryRefund: '/v3/refund/domestic/refunds/',
    addReceiver: '/v3/profitsharing/receivers/add',
    split: '/v3/profitsharing/orders',
    querySplit: '/v3/profitsharing/orders/',
    splitReturn: '/v3/profitsharing/return-orders',
    querySplitReturn: '/v3/profitsharing/return-orders/',
    unfreeze: '/v3/profitsharing/orders/unfreeze',
    profitSharingBill: '/v3/profitsharing/bills',
    tradeBill: '/v3/bill/tradebill',
    fundBill: '/v3/bill/fundflowbill'
  });
  assert(Object.isFrozen(ENDPOINTS));

  const requests = [];
  const client = createWechatPayClient(clientConfig(), {
    transport: signedTransport(async (request) => {
      requests.push(request);
      return { body: '{"ok":true}' };
    }),
    nowSeconds: () => NOW_SECONDS,
    nonce: () => 'request-nonce'
  });

  await client.createJsapi({ description: 'table' });
  await client.queryByOutTradeNo('trade/一', {
    sp_mchid: '1234567890',
    sub_mchid: '1900000109'
  });
  await client.refund({ out_refund_no: 'refund-1' });
  await client.queryRefund('refund/一', { sub_mchid: '1900000109' });
  await client.addReceiver({ account: '1234567890' });
  await client.split({ out_order_no: 'split-1' });
  await client.querySplit('split/一', {
    sub_mchid: '1900000109',
    transaction_id: '42000000000000000000000000000001'
  });
  await client.splitReturn({ out_return_no: 'return-1' });
  await client.querySplitReturn('return/一', {
    sub_mchid: '1900000109',
    out_order_no: 'split-1'
  });
  await client.unfreeze({ out_order_no: 'split-1' });
  await client.profitSharingBill({
    bill_date: '2026-07-13',
    sub_mchid: '1900000109'
  });
  await client.tradeBill({ bill_date: '2026-07-13', bill_type: 'ALL' });
  await client.fundBill({ bill_date: '2026-07-13', account_type: 'BASIC' });

  assert.deepStrictEqual(
    requests.map(({ method, path: requestPath }) => [method, requestPath]),
    [
      ['POST', ENDPOINTS.createJsapi],
      ['GET', `${ENDPOINTS.queryByOutTradeNo}trade%2F%E4%B8%80?sp_mchid=1234567890&sub_mchid=1900000109`],
      ['POST', ENDPOINTS.refund],
      ['GET', `${ENDPOINTS.queryRefund}refund%2F%E4%B8%80?sub_mchid=1900000109`],
      ['POST', ENDPOINTS.addReceiver],
      ['POST', ENDPOINTS.split],
      ['GET', `${ENDPOINTS.querySplit}split%2F%E4%B8%80?sub_mchid=1900000109&transaction_id=42000000000000000000000000000001`],
      ['POST', ENDPOINTS.splitReturn],
      ['GET', `${ENDPOINTS.querySplitReturn}return%2F%E4%B8%80?sub_mchid=1900000109&out_order_no=split-1`],
      ['POST', ENDPOINTS.unfreeze],
      ['GET', `${ENDPOINTS.profitSharingBill}?bill_date=2026-07-13&sub_mchid=1900000109`],
      ['GET', `${ENDPOINTS.tradeBill}?bill_date=2026-07-13&bill_type=ALL`],
      ['GET', `${ENDPOINTS.fundBill}?bill_date=2026-07-13&account_type=BASIC`]
    ]
  );

  await assert.rejects(
    () => client.profitSharingBill({
      bill_date: '2026-07-13',
      sub_mchid: '1900000109',
      tar_type: 'GZIP'
    }),
    /query/i
  );
  await assert.rejects(
    () => client.querySplit('split-1', {
      sub_mchid: '1900000109',
      transaction_id: '42000000000000000000000000000001',
      extra: 'forbidden'
    }),
    /query/i
  );
  await assert.rejects(
    () => client.querySplitReturn('return-1', {
      sub_mchid: '1900000109'
    }),
    /query/i
  );
  await assert.rejects(
    () => client.queryRefund('refund-1', {
      sub_mchid: '1900000109',
      extra: 'forbidden'
    }),
    /query/i
  );
});

test('bill parser accepts official backtick rows, quoting, escaped quotes, CRLF, and one summary row', () => {
  const csv = [
    '交易时间,商户订单号,商品名称,订单金额',
    '`2026-07-13 10:20:30,`order-1,"`球桌, ""夜场""",`12.34',
    '',
    '总交易单数,总交易额',
    '`1,`12.34'
  ].join('\r\n');
  const parsed = parseBillCsv(Buffer.from(csv, 'utf8'), {
    requiredHeaders: ['交易时间', '商户订单号', '订单金额']
  });

  assert.deepStrictEqual(parsed.headers, [
    '交易时间',
    '商户订单号',
    '商品名称',
    '订单金额'
  ]);
  assert.deepStrictEqual(parsed.rows, [{
    交易时间: '2026-07-13 10:20:30',
    商户订单号: 'order-1',
    商品名称: '球桌, "夜场"',
    订单金额: '12.34'
  }]);
  assert.deepStrictEqual(parsed.summary, {
    总交易单数: '1',
    总交易额: '12.34'
  });

  const lfParsed = parseBillCsv(Buffer.from(csv.replace(/\r\n/g, '\n'), 'utf8'), {
    requiredHeaders: ['商户订单号']
  });
  assert.deepStrictEqual(lfParsed, parsed);
});

test('bill parser rejects malformed quotes, inconsistent columns, missing/duplicate headers, and unsafe text', () => {
  const parse = (lines, requiredHeaders = ['商户订单号']) => parseBillCsv(
    Buffer.from(lines.join('\n'), 'utf8'),
    { requiredHeaders }
  );
  const validSummary = ['', '总交易单数,总交易额', '`1,`1.00'];

  assert.throws(
    () => parse(['商户订单号,订单金额', '"`unterminated,`1.00', ...validSummary]),
    /quote/i
  );
  assert.throws(
    () => parse(['商户订单号,订单金额', '`order-1', ...validSummary]),
    /column/i
  );
  assert.throws(
    () => parse(['交易时间,订单金额', '`time,`1.00', ...validSummary]),
    /required header/i
  );
  assert.throws(
    () => parse(['商户订单号,商户订单号', '`a,`b', ...validSummary]),
    /duplicate header/i
  );
  assert.throws(
    () => parse(['商户订单号,订单金额', '`order\u0000,`1.00', ...validSummary]),
    /unsafe|control/i
  );
  assert.throws(
    () => parse(['商户订单号,订单金额', 'order-1,`1.00', ...validSummary]),
    /backtick/i
  );
  assert.throws(
    () => parse([
      '商户订单号,订单金额',
      '`order-1,`1.00',
      '',
      '总交易单数,总交易额',
      '`1,`1.00',
      '`1,`1.00'
    ]),
    /summary/i
  );
});

test('bill parser rejects C1 control characters in headers and fields', () => {
  const parse = (header, row) => parseBillCsv(
    Buffer.from([
      header,
      row,
      '',
      '总交易单数,总交易额',
      '`1,`1.00'
    ].join('\n'), 'utf8'),
    { requiredHeaders: ['商户订单号', '订单金额'] }
  );

  assert.throws(
    () => parse('商\u0085户订单号,订单金额', '`order-1,`1.00'),
    /unsafe|control/i
  );
  assert.throws(
    () => parse('商户订单号,订单金额', '`order\u0085-1,`1.00'),
    /unsafe|control/i
  );
});

test('bill parser rejects missing or malformed official summary shapes and stray/excess fields', () => {
  const parse = (lines) => parseBillCsv(
    Buffer.from(lines.join('\n'), 'utf8'),
    { requiredHeaders: ['商户订单号', '订单金额'] }
  );
  const headerAndRow = [
    '商户订单号,订单金额',
    '`order-1,`1.00'
  ];

  assert.throws(() => parse(headerAndRow), /summary/i);
  assert.throws(
    () => parse([
      ...headerAndRow,
      '""',
      '总交易单数,总交易额',
      '`1,`1.00'
    ]),
    /summary/i,
    'a quoted empty field is not a physical blank summary separator'
  );
  assert.throws(
    () => parse([...headerAndRow, '', '总交易单数,总交易单数', '`1,`1']),
    /duplicate header/i
  );
  assert.throws(
    () => parse([...headerAndRow, '', '总交易单数,总交易额', '1,`1.00']),
    /backtick/i
  );
  assert.throws(
    () => parse([...headerAndRow, '', '总交易单数,总交易额', '`1,`1.00,`extra']),
    /column/i
  );
  assert.throws(
    () => parse([
      '商户订单号,订单金额',
      '`order-1,`1.00,`extra',
      '',
      '总交易单数,总交易额',
      '`1,`1.00'
    ]),
    /column/i
  );
  assert.throws(
    () => parse([
      '商户订单号,订\t单金额',
      '`order-1,`1.00',
      '',
      '总交易单数,总交易额',
      '`1,`1.00'
    ]),
    /unsafe|control/i
  );
  assert.throws(
    () => parse([
      '商户订单号,订单金额',
      '`order-1,`1.00',
      '',
      '总交易单数,总交\t易额',
      '`1,`1.00'
    ]),
    /unsafe|control/i
  );
  assert.throws(
    () => parse([
      '商户订单号,订单金额',
      '`or"der-1,`1.00',
      '',
      '总交易单数,总交易额',
      '`1,`1.00'
    ]),
    /quote/i
  );
});

test('configured bill amount columns are converted to exact integer fen during parsing', () => {
  const csv = Buffer.from([
    '商户订单号,订单金额,退款金额',
    '`order-1,`12.34,`-0.01',
    '',
    '总交易单数,总交易额',
    '`1,`12.34'
  ].join('\n'), 'utf8');
  const parsed = parseBillCsv(csv, {
    requiredHeaders: ['商户订单号', '订单金额', '退款金额'],
    amountHeaders: ['订单金额', '退款金额'],
    summaryAmountHeaders: ['总交易额']
  });

  assert.deepStrictEqual(parsed.rows[0], {
    商户订单号: 'order-1',
    订单金额: 1234,
    退款金额: -1
  });
  assert.deepStrictEqual(parsed.summary, {
    总交易单数: '1',
    总交易额: 1234
  });

  for (const invalidAmount of ['1.234', '90071992547410.00']) {
    const invalid = Buffer.from([
      '商户订单号,订单金额',
      `\`order-1,\`${invalidAmount}`,
      '',
      '总交易单数,总交易额',
      '`1,`1.00'
    ].join('\n'), 'utf8');
    assert.throws(
      () => parseBillCsv(invalid, {
        requiredHeaders: ['商户订单号', '订单金额'],
        amountHeaders: ['订单金额']
      }),
      /decimal yuan|safe integer/i
    );
  }
});

test('signed decimal yuan converts to safe integer fen without floating point', () => {
  assert.strictEqual(yuanToFen('0'), 0);
  assert.strictEqual(yuanToFen('001.20'), 120);
  assert.strictEqual(yuanToFen('+12.3'), 1230);
  assert.strictEqual(yuanToFen('-0.01'), -1);
  assert.strictEqual(yuanToFen('-12.34'), -1234);
  for (const value of ['1.234', '1.', '.1', '1e2', ' 1.00', '--1']) {
    assert.throws(() => yuanToFen(value), /decimal yuan/i);
  }
  assert.throws(
    () => yuanToFen('90071992547410.00'),
    /safe integer/i
  );
});

test('bill bytes require exact SHA1 metadata before parsing', () => {
  const raw = Buffer.from([
    '商户订单号,订单金额',
    '`order-1,`1.00',
    '',
    '总交易单数,总交易额',
    '`1,`1.00'
  ].join('\n'), 'utf8');
  const hashValue = crypto.createHash('sha1').update(raw).digest('hex');

  assert.strictEqual(verifyBillHash(raw, 'SHA1', hashValue.toUpperCase()), true);
  assert.deepStrictEqual(
    parseVerifiedBill(
      raw,
      { hash_type: 'SHA1', hash_value: hashValue },
      { requiredHeaders: ['商户订单号', '订单金额'] }
    ).rows[0],
    { 商户订单号: 'order-1', 订单金额: '1.00' }
  );
  assert.throws(() => verifyBillHash(raw, 'SHA256', hashValue), /hash_type|SHA1/i);
  assert.throws(() => verifyBillHash(raw, 'sha1', hashValue), /hash_type|SHA1/i);
  assert.throws(() => verifyBillHash(raw, 'SHA1', 'abc'), /hash_value/i);
  for (const malformedHash of [
    undefined,
    null,
    123,
    'g'.repeat(40),
    ` ${hashValue}`,
    `${hashValue} `,
    `${hashValue}junk`
  ]) {
    assert.throws(
      () => verifyBillHash(raw, 'SHA1', malformedHash),
      /hash_value/i
    );
  }
  assert.throws(
    () => verifyBillHash(raw, 'SHA1', '0'.repeat(40)),
    /hash mismatch/i
  );

  const malformedCsv = Buffer.from('not,csv', 'utf8');
  assert.throws(
    () => parseVerifiedBill(
      malformedCsv,
      { hash_type: 'SHA1', hash_value: '0'.repeat(40) },
      { requiredHeaders: ['商户订单号'] }
    ),
    /hash mismatch/i
  );
});

(async () => {
  for (const [name, callback] of tests) {
    await callback();
    console.log(`ok - ${name}`);
  }
  console.log(`wechat pay v3 adapter ok (${tests.length} tests)`);
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
