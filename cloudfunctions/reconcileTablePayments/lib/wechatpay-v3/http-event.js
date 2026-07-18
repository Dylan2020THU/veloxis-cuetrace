'use strict';

const SECURITY_HEADERS = Object.freeze({
  'wechatpay-timestamp': 'timestamp',
  'wechatpay-nonce': 'nonce',
  'wechatpay-signature': 'signature',
  'wechatpay-serial': 'serial'
});
const NORMALIZED_HEADER_NAMES = Object.freeze([
  'timestamp',
  'nonce',
  'signature',
  'serial'
]);

function decodeBase64Strict(value, label, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${label} must be base64 text`);
  }
  if (value.length === 0) return Buffer.alloc(0);
  if (
    value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new TypeError(`${label} must be canonical base64 text`);
  }

  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new TypeError(`${label} must be canonical base64 text`);
  }
  return decoded;
}

function headerEntries(headers) {
  if (Array.isArray(headers)) {
    if (headers.length % 2 !== 0) {
      throw new TypeError('response headers are malformed');
    }
    const entries = [];
    for (let index = 0; index < headers.length; index += 2) {
      entries.push([headers[index], headers[index + 1]]);
    }
    return entries;
  }
  if (!headers || typeof headers !== 'object') {
    throw new TypeError('response headers are required');
  }
  return Object.entries(headers).flatMap(([name, value]) => {
    if (Array.isArray(value)) return value.map((item) => [name, item]);
    return [[name, value]];
  });
}

function validateNormalizedSecurityHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new TypeError('normalized WeChat Pay security headers are required');
  }
  const names = Object.keys(headers);
  if (
    names.length !== NORMALIZED_HEADER_NAMES.length
    || names.some((name) => !NORMALIZED_HEADER_NAMES.includes(name))
  ) {
    throw new TypeError('normalized WeChat Pay security headers are malformed');
  }

  const normalized = {};
  for (const name of NORMALIZED_HEADER_NAMES) {
    const value = headers[name];
    if (
      !Object.prototype.hasOwnProperty.call(headers, name)
      || typeof value !== 'string'
      || value.length === 0
      || /[\x00-\x1f\x7f]/.test(value)
    ) {
      throw new TypeError('normalized WeChat Pay security headers are malformed');
    }
    normalized[name] = value;
  }
  return normalized;
}

function getWechatPaySecurityHeaders(headers) {
  const found = Object.create(null);

  for (const [rawName, rawValue] of headerEntries(headers)) {
    if (typeof rawName !== 'string') {
      throw new TypeError('response header name is malformed');
    }
    const key = SECURITY_HEADERS[rawName.toLowerCase()];
    if (!key) continue;
    if (Object.prototype.hasOwnProperty.call(found, key)) {
      throw new Error(`duplicate Wechatpay-${key} header`);
    }
    if (
      typeof rawValue !== 'string'
      || rawValue.length === 0
      || /[\x00-\x1f\x7f]/.test(rawValue)
    ) {
      throw new TypeError(`Wechatpay-${key} header is malformed`);
    }
    found[key] = rawValue;
  }

  for (const key of ['timestamp', 'nonce', 'signature', 'serial']) {
    if (!Object.prototype.hasOwnProperty.call(found, key)) {
      throw new Error(`required Wechatpay-${key} header is missing`);
    }
  }

  return validateNormalizedSecurityHeaders({
    timestamp: found.timestamp,
    nonce: found.nonce,
    signature: found.signature,
    serial: found.serial
  });
}

function rawBodyFromEvent(event) {
  if (!event || typeof event !== 'object') {
    throw new TypeError('HTTP event is required');
  }

  if (Buffer.isBuffer(event.rawBody)) return Buffer.from(event.rawBody);
  if (event.rawBody instanceof Uint8Array) return Buffer.from(event.rawBody);
  if (typeof event.rawBody === 'string') {
    return Buffer.from(event.rawBody, 'utf8');
  }
  if (Buffer.isBuffer(event.body)) return Buffer.from(event.body);
  if (event.body instanceof Uint8Array) return Buffer.from(event.body);
  if (typeof event.body !== 'string') {
    throw new TypeError('raw HTTP event body is required');
  }
  if (event.isBase64Encoded === true) {
    return decodeBase64Strict(event.body, 'HTTP event body', true);
  }
  return Buffer.from(event.body, 'utf8');
}

function extractWechatPayEvent(event) {
  return {
    headers: getWechatPaySecurityHeaders(event && event.headers),
    rawBody: rawBodyFromEvent(event)
  };
}

module.exports = {
  decodeBase64Strict,
  getWechatPaySecurityHeaders,
  validateNormalizedSecurityHeaders,
  rawBodyFromEvent,
  extractWechatPayEvent
};
