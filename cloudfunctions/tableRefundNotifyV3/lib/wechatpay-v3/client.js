'use strict';

// AI 参考官方 Java 翻译生成，非官方维护。请开发人员自行审查 AI 生成的代码逻辑，上线前充分测试以确保其适用性与准确性，AI 不对生成代码的正确性承担责任。

const crypto = require('crypto');
const https = require('https');
const { TextDecoder } = require('util');
const {
  decodeBase64Strict,
  getWechatPaySecurityHeaders,
  validateNormalizedSecurityHeaders
} = require('./http-event');
const { normalizePlatformVerificationId } = require('./config');
const { verifyBillHash } = require('./bill-parser');

const API_ORIGIN = 'https://api.mch.weixin.qq.com';
const BILL_DOWNLOAD_ORIGINS = Object.freeze([
  API_ORIGIN,
  'https://api2.mch.weixin.qq.com'
]);
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

const ENDPOINTS = Object.freeze({
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

function assertMessagePart(name, value) {
  if (typeof value !== 'string' || value.length === 0 || /[\r\n]/.test(value)) {
    throw new TypeError(`${name} must be non-empty text without line breaks`);
  }
}

function buildRequestMessage(method, path, timestamp, nonce, body) {
  assertMessagePart('method', method);
  assertMessagePart('path', path);
  assertMessagePart('timestamp', timestamp);
  assertMessagePart('nonce', nonce);
  if (typeof body !== 'string') throw new TypeError('body must be text');
  return `${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`;
}

function createAuthorization({
  method,
  path,
  timestamp,
  nonce,
  body,
  mchid,
  serialNo,
  privateKey
}) {
  assertMessagePart('mchid', mchid);
  assertMessagePart('serialNo', serialNo);
  if (/[,"\\]/.test(mchid) || /[,"\\]/.test(serialNo)) {
    throw new TypeError('authorization identity contains unsafe characters');
  }
  const signature = crypto.sign(
    'RSA-SHA256',
    buildRequestMessage(method, path, timestamp, nonce, body),
    privateKey
  ).toString('base64');
  return 'WECHATPAY2-SHA256-RSA2048 '
    + `mchid="${mchid}",`
    + `nonce_str="${nonce}",`
    + `timestamp="${timestamp}",`
    + `serial_no="${serialNo}",`
    + `signature="${signature}"`;
}

function rawBytes(value, label) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  throw new TypeError(`${label} must be raw bytes or text`);
}

function buildVerificationMessage(timestamp, nonce, rawBody) {
  assertMessagePart('timestamp', timestamp);
  assertMessagePart('nonce', nonce);
  return Buffer.concat([
    Buffer.from(`${timestamp}\n${nonce}\n`, 'utf8'),
    rawBytes(rawBody, 'rawBody'),
    Buffer.from('\n', 'utf8')
  ]);
}

function certificateForSerial(platformCertificates, serial) {
  const normalized = normalizePlatformVerificationId(serial);
  if (!normalized) {
    throw new TypeError('Wechatpay serial header is malformed');
  }
  let certificate;
  if (platformCertificates instanceof Map) {
    certificate = platformCertificates.get(normalized)
      || platformCertificates.get(serial);
  } else if (platformCertificates && typeof platformCertificates === 'object') {
    certificate = platformCertificates[normalized]
      || platformCertificates[serial];
  }
  if (!certificate) throw new Error('unknown WeChat Pay platform serial');
  return certificate;
}

function verifyWechatPaySignature({
  securityHeaders,
  rawBody,
  platformCertificates,
  nowSeconds,
  maxSkewSeconds = 300
}) {
  const security = validateNormalizedSecurityHeaders(securityHeaders);
  if (!/^(?:0|[1-9][0-9]{0,10})$/.test(security.timestamp)) {
    throw new TypeError('Wechatpay timestamp header is malformed');
  }
  const timestamp = Number(security.timestamp);
  if (
    !Number.isSafeInteger(timestamp)
    || !Number.isSafeInteger(nowSeconds)
    || !Number.isSafeInteger(maxSkewSeconds)
    || maxSkewSeconds < 0
  ) {
    throw new TypeError('Wechatpay timestamp verification input is malformed');
  }
  if (Math.abs(nowSeconds - timestamp) > maxSkewSeconds) {
    throw new Error('Wechatpay timestamp is outside the accepted freshness window');
  }
  const signature = decodeBase64Strict(
    security.signature,
    'Wechatpay signature'
  );
  const certificate = certificateForSerial(
    platformCertificates,
    security.serial
  );
  const valid = crypto.verify(
    'RSA-SHA256',
    buildVerificationMessage(security.timestamp, security.nonce, rawBody),
    certificate,
    signature
  );
  if (!valid) throw new Error('Wechatpay response signature verification failed');
  return true;
}

function signMiniProgramPayment({
  appId,
  timeStamp,
  nonceStr,
  prepayId,
  privateKey
}) {
  assertMessagePart('appId', appId);
  assertMessagePart('timeStamp', timeStamp);
  assertMessagePart('nonceStr', nonceStr);
  assertMessagePart('prepayId', prepayId);
  const packageValue = `prepay_id=${prepayId}`;
  const message = `${appId}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`;
  return {
    timeStamp,
    nonceStr,
    package: packageValue,
    signType: 'RSA',
    paySign: crypto.sign('RSA-SHA256', message, privateKey).toString('base64')
  };
}

function encryptSensitiveField(plaintext, platformPublicKey) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new TypeError('sensitive plaintext must be non-empty text');
  }
  return crypto.publicEncrypt(
    {
      key: platformPublicKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha1'
    },
    Buffer.from(plaintext, 'utf8')
  ).toString('base64');
}

function apiV3KeyBytes(value) {
  const key = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : (typeof value === 'string' ? Buffer.from(value, 'utf8') : null);
  if (!key || key.length !== 32) {
    throw new TypeError('APIv3 key must be exactly 32-byte UTF-8 data');
  }
  return key;
}

function decryptResource({ resource, apiV3Key }) {
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
    throw new TypeError('encrypted resource is required');
  }
  if (resource.algorithm !== 'AEAD_AES_256_GCM') {
    throw new TypeError('encrypted resource algorithm must be AEAD_AES_256_GCM');
  }
  if (
    typeof resource.nonce !== 'string'
    || Buffer.byteLength(resource.nonce, 'utf8') !== 12
    || /[\x00-\x1f\x7f]/.test(resource.nonce)
  ) {
    throw new TypeError('encrypted resource nonce must be 12-byte text');
  }
  const hasAssociatedData = Object.prototype.hasOwnProperty.call(
    resource,
    'associated_data'
  );
  if (hasAssociatedData && typeof resource.associated_data !== 'string') {
    throw new TypeError('encrypted resource associated_data must be text');
  }
  const associatedData = hasAssociatedData ? resource.associated_data : '';
  const encrypted = decodeBase64Strict(
    resource.ciphertext,
    'encrypted resource ciphertext'
  );
  if (encrypted.length <= 16) {
    throw new TypeError('encrypted resource ciphertext must include data and a 16-byte tag');
  }

  const ciphertext = encrypted.subarray(0, encrypted.length - 16);
  const authTag = encrypted.subarray(encrypted.length - 16);
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      apiV3KeyBytes(apiV3Key),
      Buffer.from(resource.nonce, 'utf8')
    );
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    if (error instanceof TypeError && /32-byte/.test(error.message)) throw error;
    throw new Error('encrypted resource decryption failed');
  }
}

function defaultTransport(request) {
  return new Promise((resolve, reject) => {
    const outgoing = https.request(
      request.url,
      {
        method: request.method,
        headers: request.headers,
        signal: request.signal
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => resolve({
          statusCode: response.statusCode,
          headers: response.rawHeaders,
          body: Buffer.concat(chunks)
        }));
        response.on('error', reject);
      }
    );
    outgoing.on('error', reject);
    outgoing.setTimeout(request.timeoutMs, () => {
      outgoing.destroy(new Error('request timeout'));
    });
    if (request.body.length > 0) outgoing.write(request.body);
    outgoing.end();
  });
}

function dispatchTransport(transport, request, timeoutMs, externalSignal) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let timeout;

    function cleanup() {
      clearTimeout(timeout);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    }
    function finish(callback, value) {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    }
    function onExternalAbort() {
      controller.abort();
      finish(reject, new Error('WeChat Pay request was aborted'));
    }

    if (externalSignal && externalSignal.aborted) {
      finish(reject, new Error('WeChat Pay request was aborted'));
      return;
    }
    if (externalSignal) {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    timeout = setTimeout(() => {
      controller.abort();
      finish(reject, new Error('WeChat Pay request timed out'));
    }, timeoutMs);

    Promise.resolve()
      .then(() => transport({
        ...request,
        signal: controller.signal,
        timeoutMs
      }))
      .then(
        (response) => finish(resolve, response),
        () => finish(reject, new Error('WeChat Pay transport failed'))
      );
  });
}

function requestBody(body) {
  if (body === undefined) return '';
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TypeError('request body must be an object');
  }
  return JSON.stringify(body);
}

function pathWithQuery(path, query) {
  if (query === undefined) return path;
  if (!query || typeof query !== 'object' || Array.isArray(query) || path.includes('?')) {
    throw new TypeError('request query must be a plain object for a path without a query');
  }
  const parameters = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (
      !name
      || /[\x00-\x1f\x7f]/.test(name)
      || !['string', 'number', 'boolean'].includes(typeof value)
    ) {
      throw new TypeError('request query contains an invalid value');
    }
    parameters.append(name, String(value));
  }
  const encoded = parameters.toString();
  return encoded ? `${path}?${encoded}` : path;
}

function exactQuery(query, names) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw new TypeError('request query must contain the exact approved fields');
  }
  const actualNames = Object.keys(query);
  if (
    actualNames.length !== names.length
    || names.some((name) => !Object.prototype.hasOwnProperty.call(query, name))
  ) {
    throw new TypeError('request query must contain the exact approved fields');
  }
  const exact = {};
  for (const name of names) {
    assertMessagePart(`query ${name}`, query[name]);
    exact[name] = query[name];
  }
  return exact;
}

function assertRequestPath(path) {
  let canonicalPath = null;
  let rawPathname = '';
  if (typeof path === 'string') {
    rawPathname = path.split('?', 1)[0];
    try {
      const parsed = new URL(path, API_ORIGIN);
      if (parsed.origin === API_ORIGIN) {
        canonicalPath = `${parsed.pathname}${parsed.search}`;
      }
    } catch (_error) {
      canonicalPath = null;
    }
  }
  const traversalPathname = rawPathname
    .replace(/%2e/gi, '.')
    .replace(/%2f/gi, '/')
    .replace(/%5c/gi, '\\');
  const hasDotSegment = traversalPathname
    .split(/[\\/]/)
    .some((segment) => segment === '.' || segment === '..');
  if (
    typeof path !== 'string'
    || !path.startsWith('/v3/')
    || !/^[A-Za-z0-9\-._~!$&'()*+,;=:@/?%]+$/.test(path)
    || /%(?![0-9A-Fa-f]{2})/.test(path)
    || /%5c/i.test(rawPathname)
    || hasDotSegment
    || canonicalPath !== path
  ) {
    throw new TypeError('request path must be an encoded /v3/ path');
  }
}

function billDownloadDetails(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new TypeError('verified bill download_url metadata is required');
  }
  const value = metadata.download_url;
  const approvedOrigin = typeof value === 'string'
    ? BILL_DOWNLOAD_ORIGINS.find((origin) => (
      value.startsWith(`${origin}/v3/billdownload/file?`)
    ))
    : null;
  if (
    typeof value !== 'string'
    || !approvedOrigin
    || !/^[\x21-\x7e]+$/.test(value)
  ) {
    throw new TypeError('bill download_url is not approved');
  }
  let url;
  try {
    url = new URL(value);
  } catch (_error) {
    throw new TypeError('bill download_url is not approved');
  }
  if (
    url.href !== value
    || url.origin !== approvedOrigin
    || url.username
    || url.password
    || url.hash
    || url.pathname !== '/v3/billdownload/file'
    || url.search.length <= 1
  ) {
    throw new TypeError('bill download_url is not approved');
  }
  const path = value.slice(approvedOrigin.length);
  try {
    assertRequestPath(path);
  } catch (_error) {
    throw new TypeError('bill download_url is not approved');
  }
  return {
    url: value,
    path,
    hashType: metadata.hash_type,
    hashValue: metadata.hash_value
  };
}

function decodeJson(rawBody, label) {
  if (rawBody.length === 0) return null;
  let text;
  try {
    text = utf8Decoder.decode(rawBody);
  } catch (_error) {
    throw new Error(`${label} is not valid UTF-8 JSON`);
  }
  try {
    return JSON.parse(text);
  } catch (_error) {
    throw new Error(`${label} is not valid JSON`);
  }
}

class WechatPayApiError extends Error {
  constructor(statusCode, parsed) {
    const code = parsed && typeof parsed.code === 'string'
      ? parsed.code.slice(0, 128)
      : null;
    super(`WeChat Pay API request failed (${statusCode}${code ? `, ${code}` : ''})`);
    this.name = 'WechatPayApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.detail = parsed && typeof parsed.message === 'string'
      ? parsed.message.slice(0, 1024)
      : null;
  }
}

function createWechatPayClient(config, options = {}) {
  if (
    !config
    || typeof config !== 'object'
    || typeof config.spMchid !== 'string'
    || typeof config.merchantSerialNo !== 'string'
    || !config.merchantPrivateKey
    || !config.platformCertificates
  ) {
    throw new TypeError('valid WeChat Pay server configuration is required');
  }
  const configuredPublicKeyId = config.wechatPayPublicKeyId;
  if (
    configuredPublicKeyId !== undefined
    && configuredPublicKeyId !== null
    && (
      normalizePlatformVerificationId(configuredPublicKeyId) !== configuredPublicKeyId
      || !configuredPublicKeyId.startsWith('PUB_KEY_ID_')
    )
  ) {
    throw new TypeError('valid WeChat Pay public key ID is required');
  }
  const configuredEncryptionKeyId = config.encryptionKeyId;
  if (
    configuredEncryptionKeyId !== undefined
    && configuredEncryptionKeyId !== null
    && (
      normalizePlatformVerificationId(configuredEncryptionKeyId)
        !== configuredEncryptionKeyId
      || !config.platformCertificates.has(configuredEncryptionKeyId)
    )
  ) {
    throw new TypeError('valid WeChat Pay encryption key ID is required');
  }
  const transport = options.transport || defaultTransport;
  const nowSeconds = options.nowSeconds || (() => Math.floor(Date.now() / 1000));
  const makeNonce = options.nonce || (() => crypto.randomBytes(16).toString('hex'));
  const timeoutMs = options.timeoutMs === undefined ? 10_000 : options.timeoutMs;
  if (typeof transport !== 'function' || typeof nowSeconds !== 'function' || typeof makeNonce !== 'function') {
    throw new TypeError('invalid WeChat Pay client dependency');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive integer');
  }

  async function execute({
    method,
    path,
    query,
    body,
    signal,
    responseType,
    wechatpaySerial
  }) {
    if (typeof method !== 'string' || !/^(?:GET|POST)$/.test(method)) {
      throw new TypeError('request method must be GET or POST');
    }
    const wirePath = pathWithQuery(path, query);
    assertRequestPath(wirePath);
    const serializedBody = requestBody(body);
    const timestamp = String(nowSeconds());
    const nonce = makeNonce();
    assertMessagePart('request timestamp', timestamp);
    assertMessagePart('request nonce', nonce);
    const headers = {
      Accept: 'application/json',
      Authorization: createAuthorization({
        method,
        path: wirePath,
        timestamp,
        nonce,
        body: serializedBody,
        mchid: config.spMchid,
        serialNo: config.merchantSerialNo,
        privateKey: config.merchantPrivateKey
      }),
      'User-Agent': 'veloxis-cuetrace-wechatpay-v3-reference'
    };
    const selectedSerial = wechatpaySerial === undefined
      ? configuredPublicKeyId
      : wechatpaySerial;
    if (selectedSerial) {
      headers['Wechatpay-Serial'] = selectedSerial;
    }
    if (serializedBody.length > 0) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      headers['Content-Length'] = Buffer.byteLength(serializedBody, 'utf8');
    }

    const response = await dispatchTransport(
      transport,
      {
        method,
        path: wirePath,
        url: `${API_ORIGIN}${wirePath}`,
        headers,
        body: serializedBody
      },
      timeoutMs,
      signal
    );
    if (
      !response
      || !Number.isInteger(response.statusCode)
      || response.statusCode < 100
      || response.statusCode > 599
      || (!Buffer.isBuffer(response.body) && !(response.body instanceof Uint8Array))
    ) {
      throw new Error('WeChat Pay transport returned a malformed response');
    }
    const responseBody = Buffer.from(response.body);
    verifyWechatPaySignature({
      securityHeaders: getWechatPaySecurityHeaders(response.headers),
      rawBody: responseBody,
      platformCertificates: config.platformCertificates,
      nowSeconds: nowSeconds()
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      let parsed = null;
      try {
        parsed = decodeJson(responseBody, 'verified WeChat Pay error response');
      } catch (_error) {
        parsed = null;
      }
      throw new WechatPayApiError(response.statusCode, parsed);
    }
    if (responseType === 'raw') return responseBody;
    return decodeJson(responseBody, 'verified WeChat Pay response');
  }

  async function downloadBill(metadata, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('bill download options must be an object');
    }
    const details = billDownloadDetails(metadata);
    const timestamp = String(nowSeconds());
    const nonce = makeNonce();
    assertMessagePart('request timestamp', timestamp);
    assertMessagePart('request nonce', nonce);
    const headers = {
      Accept: 'application/octet-stream',
      Authorization: createAuthorization({
        method: 'GET',
        path: details.path,
        timestamp,
        nonce,
        body: '',
        mchid: config.spMchid,
        serialNo: config.merchantSerialNo,
        privateKey: config.merchantPrivateKey
      }),
      'User-Agent': 'veloxis-cuetrace-wechatpay-v3-reference'
    };
    const response = await dispatchTransport(
      transport,
      {
        method: 'GET',
        path: details.path,
        url: details.url,
        headers,
        body: ''
      },
      timeoutMs,
      options.signal
    );
    if (
      !response
      || !Number.isInteger(response.statusCode)
      || response.statusCode < 100
      || response.statusCode > 599
      || (!Buffer.isBuffer(response.body) && !(response.body instanceof Uint8Array))
    ) {
      throw new Error('WeChat Pay bill download returned a malformed response');
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const error = new Error(`WeChat Pay bill download failed (${response.statusCode})`);
      error.name = 'WechatPayBillDownloadError';
      error.statusCode = response.statusCode;
      throw error;
    }
    const responseBody = Buffer.from(response.body);
    verifyBillHash(responseBody, details.hashType, details.hashValue);
    return responseBody;
  }

  const publicRequest = (request, responseType, wechatpaySerial) => {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new TypeError('request must be an object');
    }
    return execute({
      method: request.method,
      path: request.path,
      query: request.query,
      body: request.body,
      signal: request.signal,
      responseType,
      wechatpaySerial
    });
  };
  const requestJson = (request) => publicRequest(request, 'json');
  const requestRaw = (request) => publicRequest(request, 'raw');
  const sensitiveJson = (request) => {
    if (!configuredEncryptionKeyId) {
      throw new TypeError('valid WeChat Pay encryption key ID is required');
    }
    return publicRequest(request, 'json', configuredEncryptionKeyId);
  };

  return Object.freeze({
    requestJson,
    requestRaw,
    downloadBill,
    createJsapi: (body) => requestJson({ method: 'POST', path: ENDPOINTS.createJsapi, body }),
    queryByOutTradeNo: (outTradeNo, query) => {
      assertMessagePart('outTradeNo', outTradeNo);
      return requestJson({
        method: 'GET',
        path: `${ENDPOINTS.queryByOutTradeNo}${encodeURIComponent(outTradeNo)}`,
        query
      });
    },
    refund: (body) => requestJson({ method: 'POST', path: ENDPOINTS.refund, body }),
    queryRefund: async (outRefundNo, query) => {
      assertMessagePart('outRefundNo', outRefundNo);
      return requestJson({
        method: 'GET',
        path: `${ENDPOINTS.queryRefund}${encodeURIComponent(outRefundNo)}`,
        query: exactQuery(query, ['sub_mchid'])
      });
    },
    addReceiver: (body) => sensitiveJson({ method: 'POST', path: ENDPOINTS.addReceiver, body }),
    split: (body) => sensitiveJson({ method: 'POST', path: ENDPOINTS.split, body }),
    querySplit: async (outOrderNo, query) => {
      assertMessagePart('outOrderNo', outOrderNo);
      return requestJson({
        method: 'GET',
        path: `${ENDPOINTS.querySplit}${encodeURIComponent(outOrderNo)}`,
        query: exactQuery(query, ['sub_mchid', 'transaction_id'])
      });
    },
    splitReturn: (body) => requestJson({ method: 'POST', path: ENDPOINTS.splitReturn, body }),
    querySplitReturn: async (outReturnNo, query) => {
      assertMessagePart('outReturnNo', outReturnNo);
      return requestJson({
        method: 'GET',
        path: `${ENDPOINTS.querySplitReturn}${encodeURIComponent(outReturnNo)}`,
        query: exactQuery(query, ['sub_mchid', 'out_order_no'])
      });
    },
    unfreeze: (body) => requestJson({ method: 'POST', path: ENDPOINTS.unfreeze, body }),
    profitSharingBill: async (query) => requestJson({
      method: 'GET',
      path: ENDPOINTS.profitSharingBill,
      query: exactQuery(query, ['bill_date', 'sub_mchid'])
    }),
    tradeBill: (query) => requestJson({ method: 'GET', path: ENDPOINTS.tradeBill, query }),
    fundBill: (query) => requestJson({ method: 'GET', path: ENDPOINTS.fundBill, query })
  });
}

module.exports = {
  ENDPOINTS,
  buildRequestMessage,
  createAuthorization,
  buildVerificationMessage,
  verifyWechatPaySignature,
  signMiniProgramPayment,
  encryptSensitiveField,
  decryptResource,
  createWechatPayClient
};
