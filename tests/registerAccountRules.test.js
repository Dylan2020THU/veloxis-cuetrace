const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

const loginJs = read('miniprogram/pages/login/index.js');
const loginWxml = read('miniprogram/pages/login/index.wxml');
const loginWxss = read('miniprogram/pages/login/index.wxss');

assert(
  loginJs.includes('const ACCOUNT_RE = /^[A-Za-z][A-Za-z0-9_]{3,19}$/;'),
  'Register account names should start with a letter and allow only letters, digits, and underscore.'
);

assert(
  loginJs.includes('return ACCOUNT_RE.test(account);'),
  'Register account validation should not allow an 11-digit phone number as an account.'
);

assert(
  !loginJs.includes('手机号可直接作为账号') && !loginJs.includes('PHONE_RE.test(account)'),
  'Register account helper text and validation should not mention or accept phone numbers as account names.'
);

assert(
  loginJs.includes('isValidRegisterAccount(account)') &&
    loginJs.includes('!this.isValidRegisterAccount(account)') &&
    loginJs.includes('ACCOUNT_RULE_TEXT'),
  'Register submit should reject accounts that do not match the account rule.'
);

assert(
  loginJs.includes("const baseRole = 'member';") &&
    loginJs.includes('role: baseRole') &&
    loginJs.includes('roles: [baseRole]'),
  'Register submit should create a base player account before identity selection.'
);

assert(
  loginWxml.includes('accountRuleText') && loginWxml.includes('class="account-rule"'),
  'Register page should display account rule helper text.'
);

assert(
  /\.account-rule\s*\{[\s\S]*?font-size:\s*22rpx/.test(loginWxss),
  'Account rule helper text should have a stable compact style.'
);
