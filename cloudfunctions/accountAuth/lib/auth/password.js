'use strict';

const crypto = require('crypto');

const SCRYPT_OPTIONS = Object.freeze({
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024
});
const DUMMY_PASSWORD = 'cuetrace-auth-dummy-password';
const DUMMY_SALT = Buffer.from(
  '5f8d6c17d08f43dd84750f4b87c559f1',
  'hex'
);
const DUMMY_HASH = Buffer.from(
  '89062343ccc2610b32816b93cc4680d4'
  + 'f4f93138069e5aaf9ae3173782d188ad'
  + 'ed51f65a293f7a5bac55784534be1b9e'
  + '5903f08b93df6d800f12b7f3a7f21829',
  'hex'
);

function passwordError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validPassword(password) {
  return (
    typeof password === 'string'
    && [...password].length >= 6
    && [...password].length <= 64
  );
}

function scrypt(password, salt) {
  return crypto.scryptSync(
    password,
    salt,
    64,
    SCRYPT_OPTIONS
  );
}

function hashPassword(password, randomBytes) {
  if (!validPassword(password)) {
    throw passwordError('INVALID_PASSWORD', 'The password is invalid.');
  }
  const makeRandomBytes = randomBytes || crypto.randomBytes;
  if (typeof makeRandomBytes !== 'function') {
    throw passwordError(
      'AUTH_RANDOM_INVALID',
      'Secure random generation failed.'
    );
  }
  let salt;
  try {
    salt = makeRandomBytes(16);
  } catch (_) {
    throw passwordError(
      'AUTH_RANDOM_INVALID',
      'Secure random generation failed.'
    );
  }
  if (
    (!Buffer.isBuffer(salt) && !(salt instanceof Uint8Array))
    || Buffer.from(salt).length !== 16
  ) {
    throw passwordError(
      'AUTH_RANDOM_INVALID',
      'Secure random generation failed.'
    );
  }
  const saltBuffer = Buffer.from(salt);
  const hash = scrypt(password, saltBuffer);
  return {
    passwordAlgorithm: 'scrypt-v1',
    passwordSalt: saltBuffer.toString('hex'),
    passwordHash: hash.toString('hex')
  };
}

function strictPasswordRecord(account) {
  if (
    !account
    || typeof account !== 'object'
    || account.passwordAlgorithm !== 'scrypt-v1'
    || typeof account.passwordSalt !== 'string'
    || !/^[0-9a-f]{32}$/.test(account.passwordSalt)
    || typeof account.passwordHash !== 'string'
    || !/^[0-9a-f]{128}$/.test(account.passwordHash)
  ) {
    return null;
  }
  return {
    salt: Buffer.from(account.passwordSalt, 'hex'),
    hash: Buffer.from(account.passwordHash, 'hex')
  };
}

function verifyPasswordOrDummy(password, account) {
  const passwordIsValid = validPassword(password);
  const record = strictPasswordRecord(account);
  const candidate = passwordIsValid ? password : DUMMY_PASSWORD;
  const salt = record ? record.salt : DUMMY_SALT;
  const expected = record ? record.hash : DUMMY_HASH;
  let actual;
  try {
    actual = scrypt(candidate, salt);
  } catch (_) {
    return false;
  }
  const equal = crypto.timingSafeEqual(actual, expected);
  return Boolean(passwordIsValid && record && equal);
}

module.exports = {
  hashPassword,
  verifyPasswordOrDummy
};
