'use strict';

const crypto = require('crypto');

const VERSION_PATTERN = /^[A-Z0-9_]+$/;
const PREFIX_PATTERN = /^[A-Za-z0-9_-]+$/;
const PURPOSES = new Set([
  'phone-binding',
  'wechat-binding',
  'session-token',
  'sms-code',
  'sms-challenge',
  'auth-proof',
  'rate-limit'
]);
const HKDF_SALT = Buffer.from('cuetrace-auth-v2');
const HMAC_NAMESPACE = Buffer.from('cuetrace-auth-v2-hmac\0');

function configurationError() {
  const error = new Error('Authentication configuration is invalid.');
  error.code = 'AUTH_CONFIG_INVALID';
  return error;
}

function validVersion(value) {
  return typeof value === 'string' && VERSION_PATTERN.test(value);
}

function decodeRootKey(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw configurationError();
  }
  const decoded = Buffer.from(value, 'base64');
  if (
    decoded.length < 32
    || decoded.toString('base64') !== value
  ) {
    throw configurationError();
  }
  return decoded;
}

function loadKeyring(env) {
  try {
    if (!env || typeof env !== 'object') throw configurationError();
    const activeVersion = env.CUETRACE_AUTH_KEY_ACTIVE_VERSION;
    if (!validVersion(activeVersion)) throw configurationError();

    if (
      !Object.prototype.hasOwnProperty.call(
        env,
        'CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS'
      )
      || typeof env.CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS !== 'string'
    ) {
      throw configurationError();
    }
    const historicalValue =
      env.CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS;
    let historicalVersions = [];
    if (historicalValue !== '') {
      historicalVersions = historicalValue
        .split(',')
        .map((version) => version.trim());
    }
    if (
      historicalVersions.some((version) => !validVersion(version))
      || new Set(historicalVersions).size !== historicalVersions.length
      || historicalVersions.includes(activeVersion)
    ) {
      throw configurationError();
    }

    const versions = [activeVersion, ...historicalVersions];
    const keys = new Map();
    for (const version of versions) {
      const variableName = `CUETRACE_AUTH_KEY_${version}`;
      keys.set(version, decodeRootKey(env[variableName]));
    }

    const keyring = {
      activeVersion,
      historicalVersions: Object.freeze([...historicalVersions])
    };
    Object.defineProperty(keyring, 'keys', {
      value: keys,
      enumerable: false,
      configurable: false,
      writable: false
    });
    return Object.freeze(keyring);
  } catch (error) {
    if (error && error.code === 'AUTH_CONFIG_INVALID') throw error;
    throw configurationError();
  }
}

function rootKey(keyring, version) {
  if (
    !keyring
    || !validVersion(version)
    || !(keyring.keys instanceof Map)
    || !keyring.keys.has(version)
  ) {
    throw configurationError();
  }
  const key = keyring.keys.get(version);
  if (!Buffer.isBuffer(key) || key.length < 32) {
    throw configurationError();
  }
  return key;
}

function deriveKey(keyring, version, purpose) {
  if (!PURPOSES.has(purpose)) throw configurationError();
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    rootKey(keyring, version),
    HKDF_SALT,
    Buffer.from(purpose),
    32
  ));
}

function lengthPrefixed(value) {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function hmacInput(purpose, prefix, value) {
  if (
    !PURPOSES.has(purpose)
    || typeof prefix !== 'string'
    || !PREFIX_PATTERN.test(prefix)
    || typeof value !== 'string'
    || value.length === 0
  ) {
    throw configurationError();
  }
  return Buffer.concat([
    HMAC_NAMESPACE,
    lengthPrefixed(purpose),
    lengthPrefixed(prefix),
    lengthPrefixed(value)
  ]);
}

function hmacIdForVersion(keyring, version, purpose, value, prefix) {
  const digest = crypto
    .createHmac('sha256', deriveKey(keyring, version, purpose))
    .update(hmacInput(purpose, prefix, value))
    .digest('base64url');
  return `${prefix}.${version}.${digest}`;
}

function versionedHmacId(keyring, purpose, value, prefix) {
  if (!keyring || !validVersion(keyring.activeVersion)) {
    throw configurationError();
  }
  return hmacIdForVersion(
    keyring,
    keyring.activeVersion,
    purpose,
    value,
    prefix
  );
}

function candidateHmacIds(keyring, purpose, value, prefix) {
  if (
    !keyring
    || !validVersion(keyring.activeVersion)
    || !Array.isArray(keyring.historicalVersions)
  ) {
    throw configurationError();
  }
  return [
    keyring.activeVersion,
    ...keyring.historicalVersions
  ].map((keyVersion, index) => Object.freeze({
    id: hmacIdForVersion(
      keyring,
      keyVersion,
      purpose,
      value,
      prefix
    ),
    keyVersion,
    isActive: index === 0
  }));
}

module.exports = {
  loadKeyring,
  deriveKey,
  versionedHmacId,
  candidateHmacIds
};
