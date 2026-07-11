const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

function loadRegisterPage(fakeData) {
  const loginPath = path.join(root, 'miniprogram/pages/login/index.js');
  delete require.cache[require.resolve(loginPath)];

  let page;
  const calls = { storageReads: [], storageWrites: [], storageRemovals: [], toasts: [], navigations: [] };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../../services/data') return fakeData;
    return originalLoad.call(this, request, parent, isMain);
  };
  global.Page = (definition) => {
    page = definition;
  };
  global.Behavior = (definition) => definition;
  global.getApp = () => ({ globalData: { cloudReady: true, account: '', roles: [] } });
  global.wx = {
    getStorageSync(key) {
      calls.storageReads.push(key);
      return key === 'dc_accounts'
        ? [{ account: 'forgedAdmin', password: 'plaintext', roles: ['member', 'coach', 'shop'] }]
        : null;
    },
    setStorageSync(key, value) {
      calls.storageWrites.push([key, value]);
    },
    removeStorageSync(key) {
      calls.storageRemovals.push(key);
    },
    showToast(options) {
      calls.toasts.push(options);
    },
    showLoading() {},
    hideLoading() {},
    navigateTo(options) {
      calls.navigations.push(options);
    }
  };

  try {
    require(loginPath);
  } finally {
    Module._load = originalLoad;
  }
  page.data = JSON.parse(JSON.stringify(page.data));
  page.setData = function setData(next) {
    this.data = Object.assign({}, this.data, next);
  };
  return { page, calls };
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
  loginWxml.includes('accountRuleText') && loginWxml.includes('class="account-rule"'),
  'Register page should display account rule helper text.'
);

assert(
  /\.account-rule\s*\{[\s\S]*?font-size:\s*22rpx/.test(loginWxss),
  'Account rule helper text should have a stable compact style.'
);

async function testRegisterUsesCloudResultAndOpensRolePicker() {
  const registerCalls = [];
  const fixture = loadRegisterPage({
    registerAccount(input) {
      registerCalls.push(input);
      return Promise.resolve({ account: 'serverMember', roles: ['member'], currentRole: 'member' });
    }
  });
  fixture.page.setData({
    mode: 'register',
    regAccount: 'memberA',
    regPassword: '123456',
    regConfirm: '123456',
    agreementChecked: true
  });

  fixture.page.register();
  await flushPromises();

  assert.deepStrictEqual(registerCalls, [{ account: 'memberA', password: '123456' }]);
  assert.strictEqual(fixture.page.data.step, 'role');
  assert.strictEqual(fixture.page.data.pendingAccount, 'serverMember');
  assert.deepStrictEqual(fixture.page.data.pendingRoles, ['member']);
  assert(!fixture.calls.storageReads.includes('dc_accounts'), 'Registration must not read local account records.');
  assert(!fixture.calls.storageWrites.some(([key]) => key === 'dc_accounts' || key === 'dc_wechat_bindings'), 'Registration must not persist local auth records.');
}

async function testRegisterServerConflictStaysOnForm() {
  const error = Object.assign(new Error('该账号已注册'), { code: 'ACCOUNT_EXISTS' });
  const fixture = loadRegisterPage({
    registerAccount() {
      return Promise.reject(error);
    }
  });
  fixture.page.setData({
    mode: 'register',
    regAccount: 'memberA',
    regPassword: '123456',
    regConfirm: '123456',
    agreementChecked: true
  });

  fixture.page.register();
  await flushPromises();

  assert.strictEqual(fixture.page.data.step, 'auth');
  assert.strictEqual(fixture.page.data.mode, 'register');
  assert(fixture.calls.toasts.some((item) => item.title === '该账号已注册'));
  assert.strictEqual(fixture.calls.navigations.length, 0);
}

(async () => {
  await testRegisterUsesCloudResultAndOpensRolePicker();
  await testRegisterServerConflictStaysOnForm();
})();
