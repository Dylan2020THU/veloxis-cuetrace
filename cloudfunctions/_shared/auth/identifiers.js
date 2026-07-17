'use strict';

const crypto = require('crypto');

function validationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizePhone(value) {
  if (typeof value !== 'string' || !/^1\d{10}$/.test(value)) {
    throw validationError('INVALID_PHONE', 'The phone number is invalid.');
  }
  return `+86${value}`;
}

function normalizeAccountName(value) {
  if (typeof value !== 'string') {
    throw validationError(
      'INVALID_ACCOUNT_NAME',
      'The account name is invalid.'
    );
  }
  const normalized = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9_]{3,19}$/.test(normalized)) {
    throw validationError(
      'INVALID_ACCOUNT_NAME',
      'The account name is invalid.'
    );
  }
  return normalized.toLowerCase();
}

function newAccountId(randomBytes) {
  const makeRandomBytes = randomBytes || crypto.randomBytes;
  if (typeof makeRandomBytes !== 'function') {
    throw validationError(
      'AUTH_RANDOM_INVALID',
      'Secure random generation failed.'
    );
  }
  let bytes;
  try {
    bytes = makeRandomBytes(16);
  } catch (_) {
    throw validationError(
      'AUTH_RANDOM_INVALID',
      'Secure random generation failed.'
    );
  }
  if (
    !Buffer.isBuffer(bytes)
    && !(bytes instanceof Uint8Array)
  ) {
    throw validationError(
      'AUTH_RANDOM_INVALID',
      'Secure random generation failed.'
    );
  }
  const value = Buffer.from(bytes);
  if (value.length < 16) {
    throw validationError(
      'AUTH_RANDOM_INVALID',
      'Secure random generation failed.'
    );
  }
  return `acct_${value.toString('base64url')}`;
}

function nonEmptyTrustedValue(value) {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.trim().length > 0
  );
}

function identityPart(label, value) {
  return `${label}:${Buffer.byteLength(value)}:${value}`;
}

function wechatIdentity(wxContext) {
  if (
    !wxContext
    || typeof wxContext !== 'object'
    || !nonEmptyTrustedValue(wxContext.APPID)
    || !nonEmptyTrustedValue(wxContext.OPENID)
  ) {
    throw validationError(
      'INVALID_WECHAT_IDENTITY',
      'The trusted WeChat identity is invalid.'
    );
  }
  const hasUnionId = Object.prototype.hasOwnProperty.call(
    wxContext,
    'UNIONID'
  ) && wxContext.UNIONID !== undefined;
  if (hasUnionId && !nonEmptyTrustedValue(wxContext.UNIONID)) {
    throw validationError(
      'INVALID_WECHAT_IDENTITY',
      'The trusted WeChat identity is invalid.'
    );
  }

  const bindingInput = [
      identityPart('appid', wxContext.APPID),
      identityPart('openid', wxContext.OPENID)
    ].join('|');
  const unionidAuditInput = hasUnionId
    ? identityPart('unionid', wxContext.UNIONID)
    : '';
  const identity = {};
  Object.defineProperties(identity, {
    bindingInput: {
      value: bindingInput,
      enumerable: false,
      configurable: false,
      writable: false
    },
    unionidAuditInput: {
      value: unionidAuditInput,
      enumerable: false,
      configurable: false,
      writable: false
    },
    toJSON: {
      value() {
        return { hasUnionId };
      },
      enumerable: false,
      configurable: false,
      writable: false
    },
  });
  return Object.freeze(identity);
}

module.exports = {
  normalizePhone,
  normalizeAccountName,
  newAccountId,
  wechatIdentity
};
