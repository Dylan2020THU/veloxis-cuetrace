const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function exists(file) {
  return fs.existsSync(path.join(root, file));
}

const settingsJs = read('miniprogram/pages/settings/index.js');
const dataJs = read('miniprogram/services/data.js');
const deleteAccountJs = read('cloudfunctions/deleteAccount/index.js');
const loginJs = read('cloudfunctions/login/index.js');
const legalJs = read('miniprogram/pages/legal/index.js');

assert(
  settingsJs.includes('DELETE_REASONS') && settingsJs.includes('wx.showActionSheet'),
  'Settings deletion flow should collect a deletion reason before confirmation.'
);

assert(
  settingsJs.includes('data.deleteAccount({ reason') && settingsJs.includes('7 天') && settingsJs.includes('重新登录'),
  'Settings deletion flow should submit the selected reason and explain the 7-day cancellation window.'
);

assert(
  /function deleteAccount\(opts\)/.test(dataJs) && dataJs.includes('deletionScheduledAt') && dataJs.includes('deletionCanceled'),
  'Data service should submit deletion options, keep mock pending deletion state, and surface login cancellation.'
);

assert(
  deleteAccountJs.includes("deletionStatus: 'pending'") &&
    deleteAccountJs.includes('deletionRequestedAt') &&
    deleteAccountJs.includes('deletionScheduledAt') &&
    deleteAccountJs.includes('account_deletion_requests'),
  'deleteAccount cloud function should mark a pending deletion request instead of deleting immediately.'
);

assert(
  !deleteAccountJs.includes('ownCollections') && !/where\(\{\s*_openid:\s*OPENID\s*\}\)\.remove\(\)/.test(deleteAccountJs),
  'deleteAccount cloud function should not immediately remove user-owned collections.'
);

assert(
  loginJs.includes("deletionStatus === 'pending'") &&
    loginJs.includes('deletionScheduledAt') &&
    loginJs.includes('deletionCanceled') &&
    loginJs.includes('deletionCanceledAt'),
  'login cloud function should cancel pending deletion when the user logs in within the grace period.'
);

assert(
  exists('cloudfunctions/purgeDeletedAccounts/index.js') &&
    exists('cloudfunctions/purgeDeletedAccounts/package.json') &&
    exists('cloudfunctions/purgeDeletedAccounts/config.json'),
  'A scheduled purgeDeletedAccounts cloud function should exist.'
);

const purgeJs = exists('cloudfunctions/purgeDeletedAccounts/index.js')
  ? read('cloudfunctions/purgeDeletedAccounts/index.js')
  : '';

assert(
  purgeJs.includes("deletionStatus: 'pending'") &&
    purgeJs.includes('deletionScheduledAt') &&
    purgeJs.includes('removed') &&
    purgeJs.includes('training_sessions'),
  'purgeDeletedAccounts should remove pending accounts after the grace period.'
);

assert(
  legalJs.includes('7 天') && legalJs.includes('重新登录'),
  'User agreement should disclose the 7-day account deletion grace period.'
);
