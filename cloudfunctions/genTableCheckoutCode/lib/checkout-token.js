'use strict';

const crypto = require('crypto');

function encodeCheckoutToken(bytes) {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function decodeCheckoutToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(token)) {
    throw new TypeError('checkout token must be canonical 128-bit base64url text');
  }
  const bytes = Buffer.from(
    token.replace(/-/g, '+').replace(/_/g, '/') + '==',
    'base64'
  );
  if (bytes.length !== 16 || encodeCheckoutToken(bytes) !== token) {
    throw new TypeError('checkout token must be canonical 128-bit base64url text');
  }
  return bytes;
}

function generateCheckoutToken() {
  return encodeCheckoutToken(crypto.randomBytes(16));
}

function hashCheckoutToken(token) {
  decodeCheckoutToken(token);
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

module.exports = {
  decodeCheckoutToken,
  generateCheckoutToken,
  hashCheckoutToken
};
