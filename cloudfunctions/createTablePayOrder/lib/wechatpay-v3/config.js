'use strict';

const crypto = require('crypto');

const ENV_NAMES = Object.freeze([
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

function configurationError(message) {
  const error = new Error(`WeChat Pay configuration ${message}`);
  error.name = 'WechatPayConfigurationError';
  return error;
}

function normalizePlatformVerificationId(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (/^[0-9A-Fa-f]+$/.test(value)) return value.toUpperCase();
  const publicKeyMatch = /^PUB_KEY_ID_([0-9A-Fa-f]{32})$/.exec(value);
  return publicKeyMatch
    ? `PUB_KEY_ID_${publicKeyMatch[1].toUpperCase()}`
    : null;
}

function readJsonString(source, start) {
  if (source[start] !== '"') throw configurationError('has invalid certificate configuration');
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      const token = source.slice(start, index + 1);
      let value;
      try {
        value = JSON.parse(token);
      } catch (_error) {
        throw configurationError('has invalid certificate configuration');
      }
      return { value, next: index + 1 };
    }
    if (character.charCodeAt(0) < 0x20) {
      throw configurationError('has invalid certificate configuration');
    }
  }
  throw configurationError('has invalid certificate configuration');
}

function skipWhitespace(source, start) {
  let index = start;
  while (index < source.length && /[\u0009\u000a\u000d\u0020]/.test(source[index])) {
    index += 1;
  }
  return index;
}

function parseCertificateJson(source) {
  if (typeof source !== 'string') {
    throw configurationError('has invalid certificate configuration');
  }
  let index = skipWhitespace(source, 0);
  if (source[index] !== '{') {
    throw configurationError('has invalid certificate configuration');
  }
  index = skipWhitespace(source, index + 1);
  const values = [];
  const serials = new Set();
  let publicKeyId = null;

  if (source[index] === '}') {
    throw configurationError('has invalid certificate configuration');
  }

  while (index < source.length) {
    const keyToken = readJsonString(source, index);
    const serial = keyToken.value;
    index = skipWhitespace(source, keyToken.next);
    if (source[index] !== ':') {
      throw configurationError('has invalid certificate configuration');
    }
    index = skipWhitespace(source, index + 1);
    const valueToken = readJsonString(source, index);
    const pem = valueToken.value;
    index = skipWhitespace(source, valueToken.next);

    const normalizedSerial = normalizePlatformVerificationId(serial);
    if (!normalizedSerial || serial !== serial.trim()) {
      throw configurationError('has invalid certificate configuration');
    }
    if (serials.has(normalizedSerial)) {
      throw configurationError('has duplicate certificate configuration');
    }
    if (normalizedSerial.startsWith('PUB_KEY_ID_')) {
      if (publicKeyId !== null) {
        throw configurationError('has invalid certificate configuration');
      }
      publicKeyId = normalizedSerial;
    }
    serials.add(normalizedSerial);
    values.push([normalizedSerial, pem]);

    if (source[index] === ',') {
      index = skipWhitespace(source, index + 1);
      continue;
    }
    if (source[index] === '}') {
      index = skipWhitespace(source, index + 1);
      if (index !== source.length) {
        throw configurationError('has invalid certificate configuration');
      }
      break;
    }
    throw configurationError('has invalid certificate configuration');
  }

  if (values.length === 0) {
    throw configurationError('has invalid certificate configuration');
  }
  return values;
}

function isExactRsa2048(key) {
  try {
    return key.asymmetricKeyType === 'rsa'
      && key.asymmetricKeyDetails !== undefined
      && key.asymmetricKeyDetails.modulusLength === 2048;
  } catch (_error) {
    return false;
  }
}

function parsePlatformCertificates(source) {
  const certificates = new Map();
  for (const [serial, pem] of parseCertificateJson(source)) {
    if (typeof pem !== 'string' || pem.length === 0) {
      throw configurationError('has invalid certificate configuration');
    }
    let publicKey;
    try {
      publicKey = crypto.createPublicKey(pem);
    } catch (_error) {
      throw configurationError('has invalid certificate configuration');
    }
    if (!isExactRsa2048(publicKey)) {
      throw configurationError('has invalid certificate configuration');
    }
    certificates.set(serial, publicKey);
  }
  return certificates;
}

function parsePrivateKey(source) {
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(source);
  } catch (_error) {
    throw configurationError('has invalid merchant key material');
  }
  if (!isExactRsa2048(privateKey)) {
    throw configurationError('has invalid merchant key material');
  }
  return privateKey;
}

function validateHttpsUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (_error) {
    throw configurationError('contains an invalid notification URL');
  }
  if (
    value !== value.trim()
    || url.protocol !== 'https:'
    || !url.hostname
    || url.username
    || url.password
    || url.hash
  ) {
    throw configurationError('contains an invalid notification URL');
  }
  return value;
}

function loadWechatPayConfig(environment = process.env) {
  if (!environment || typeof environment !== 'object') {
    throw configurationError('environment is unavailable');
  }
  const values = Object.create(null);
  for (const name of ENV_NAMES) values[name] = environment[name];

  if (values.WXPAY_V3_ENABLED !== 'true') {
    throw configurationError('is disabled');
  }
  for (const name of ENV_NAMES.slice(1, -1)) {
    if (typeof values[name] !== 'string' || values[name].length === 0) {
      throw configurationError('is incomplete');
    }
  }

  if (!/^wx[0-9A-Za-z]{16}$/.test(values.WXPAY_SP_APPID)) {
    throw configurationError('contains an invalid service-provider AppID');
  }
  if (!/^[0-9]{8,32}$/.test(values.WXPAY_SP_MCHID)) {
    throw configurationError('contains an invalid service-provider merchant ID');
  }
  if (!/^[0-9A-Fa-f]{1,64}$/.test(values.WXPAY_MERCHANT_SERIAL_NO)) {
    throw configurationError('contains an invalid merchant serial number');
  }
  if (Buffer.byteLength(values.WXPAY_API_V3_KEY, 'utf8') !== 32) {
    throw configurationError('contains an invalid APIv3 key');
  }
  if (
    values.WXPAY_PLATFORM_RECEIVER_NAME !== values.WXPAY_PLATFORM_RECEIVER_NAME.trim()
    || /[\x00-\x1f\x7f]/.test(values.WXPAY_PLATFORM_RECEIVER_NAME)
    || Buffer.byteLength(values.WXPAY_PLATFORM_RECEIVER_NAME, 'utf8') > 128
  ) {
    throw configurationError('contains an invalid platform receiver name');
  }

  // The legacy env name maps trusted response-verification identifiers to keys:
  // platform certificate serials and, optionally, one WeChat Pay public key ID.
  const platformCertificates = parsePlatformCertificates(
    values.WXPAY_PLATFORM_CERTS_JSON
  );
  const wechatPayPublicKeyId = [...platformCertificates.keys()].find(
    (identifier) => identifier.startsWith('PUB_KEY_ID_')
  ) || null;
  let encryptionKeyId;
  if (values.WXPAY_ENCRYPTION_KEY_ID !== undefined) {
    encryptionKeyId = normalizePlatformVerificationId(
      values.WXPAY_ENCRYPTION_KEY_ID
    );
    if (
      encryptionKeyId !== values.WXPAY_ENCRYPTION_KEY_ID
      || !platformCertificates.has(encryptionKeyId)
    ) {
      throw configurationError('contains an invalid encryption key identifier');
    }
  } else if (wechatPayPublicKeyId) {
    encryptionKeyId = wechatPayPublicKeyId;
  } else if (platformCertificates.size === 1) {
    [encryptionKeyId] = platformCertificates.keys();
  } else {
    throw configurationError('contains an ambiguous encryption key selection');
  }
  const config = {
    spAppId: values.WXPAY_SP_APPID,
    spMchid: values.WXPAY_SP_MCHID,
    merchantSerialNo: values.WXPAY_MERCHANT_SERIAL_NO.toUpperCase(),
    merchantPrivateKey: parsePrivateKey(values.WXPAY_MERCHANT_PRIVATE_KEY),
    apiV3Key: Buffer.from(values.WXPAY_API_V3_KEY, 'utf8'),
    platformCertificates,
    wechatPayPublicKeyId,
    encryptionKeyId,
    encryptionPublicKey: platformCertificates.get(encryptionKeyId),
    tableNotifyUrl: validateHttpsUrl(values.WXPAY_TABLE_NOTIFY_URL),
    tableRefundNotifyUrl: validateHttpsUrl(values.WXPAY_TABLE_REFUND_NOTIFY_URL),
    platformReceiverName: values.WXPAY_PLATFORM_RECEIVER_NAME
  };

  return Object.freeze(config);
}

module.exports = {
  ENV_NAMES,
  normalizePlatformVerificationId,
  loadWechatPayConfig
};
