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
  const attempts = { begun: [], cancelled: [] };
  let attemptSequence = 0;
  const service = Object.assign({
    beginAuthAttempt(kind) {
      const attempt = { id: ++attemptSequence, kind };
      attempts.begun.push(attempt);
      return attempt;
    },
    cancelAuthAttempt(attempt) {
      attempts.cancelled.push(attempt);
      return true;
    }
  }, fakeData || {});
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../../services/data') return service;
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
  return { page, calls, attempts, service };
}

const loginJs = read('miniprogram/pages/login/index.js');
const loginWxml = read('miniprogram/pages/login/index.wxml');
const loginWxss = read('miniprogram/pages/login/index.wxss');
const accountAuthJs = read('cloudfunctions/accountAuth/index.js');

function testRegistrationSourceContract() {
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
  loginJs.includes('registerAccountName') &&
    !loginJs.includes('registerAccount(') &&
    !loginJs.includes('dc_accounts') &&
    !loginJs.includes('dc_wechat_bindings'),
  'Registration must use only the Auth v2 facade and never local auth registries.'
);

assert(
  loginWxml.includes('accountRuleText') && loginWxml.includes('class="account-rule"'),
  'Register page should display account rule helper text.'
);

assert(
  /\.account-rule\s*\{[\s\S]*?font-size:\s*22rpx/.test(loginWxss),
  'Account rule helper text should have a stable compact style.'
);

const registerActionFields = accountAuthJs.match(
  /registerAccountName:\s*Object\.freeze\(\[([\s\S]*?)\]\)/
);
assert(registerActionFields, 'accountAuth must declare the v2 registration request shape.');
assert(registerActionFields[1].includes("'accountName'"));
assert(registerActionFields[1].includes("'password'"));
assert(registerActionFields[1].includes("'termsVersion'"));
assert(registerActionFields[1].includes("'privacyVersion'"));
assert(
  !registerActionFields[1].includes('confirmPassword'),
  'Password confirmation is client-only and must not enter the server union.'
);
assert(
  accountAuthJs.includes('supportedSchemaVersions: [2]'),
  'accountAuth must reject retired schema versions.'
);
assert(
  !accountAuthJs.includes('_openid')
    && !/Object\.freeze\(\[[\s\S]*?'OPENID'/.test(
      accountAuthJs.match(
        /const ACTION_FIELDS = Object\.freeze\(\{([\s\S]*?)\n\}\);/
      )[1]
    ),
  'accountAuth must not accept legacy or client-supplied WeChat authority fields.'
);
}

async function testRegisterUsesCloudResultAndOpensRolePicker() {
  const registerCalls = [];
  let legacyCalls = 0;
  const result = {
    account: 'internal-server-id',
    accountDisplay: 'serverMember',
    roles: ['member'],
    currentRole: 'member'
  };
  const fixture = loadRegisterPage({
    registerAccountName(input, attempt) {
      registerCalls.push([input, attempt]);
      return Promise.resolve(result);
    },
    registerAccount() {
      legacyCalls += 1;
      return Promise.resolve(result);
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

  assert.strictEqual(legacyCalls, 0, 'Auth v2 registration must not call the legacy alias.');
  assert.strictEqual(fixture.attempts.begun.length, 1);
  assert.strictEqual(fixture.attempts.begun[0].kind, 'registerAccountName');
  assert.deepStrictEqual(registerCalls, [[{
    accountName: 'memberA',
    password: '123456',
    termsVersion: '2026-07-15',
    privacyVersion: '2026-07-15'
  }, fixture.attempts.begun[0]]]);
  assert.strictEqual(fixture.page.data.mode, 'rolePicker');
  assert.strictEqual(fixture.page.data.pendingAccount, 'internal-server-id');
  assert.strictEqual(fixture.page.data.pendingAccountDisplay, 'serverMember');
  assert.deepStrictEqual(fixture.page.data.pendingRoles, ['member']);
  assert(!fixture.calls.storageReads.includes('dc_accounts'), 'Registration must not read local account records.');
  assert(!fixture.calls.storageWrites.some(([key]) => key === 'dc_accounts' || key === 'dc_wechat_bindings'), 'Registration must not persist local auth records.');
}

async function testRegisterServerConflictStaysOnForm() {
  const error = Object.assign(new Error('该账号已注册'), { code: 'ACCOUNT_NAME_EXISTS' });
  const fixture = loadRegisterPage({
    registerAccountName() {
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

  assert.strictEqual(fixture.page.data.mode, 'register');
  assert(fixture.calls.toasts.some((item) => item.title === '该账号已注册'));
  assert.strictEqual(fixture.calls.navigations.length, 0);
}

async function testRegisterConsentAndSingleFlight() {
  const request = {};
  request.promise = new Promise((resolve) => { request.resolve = resolve; });
  let calls = 0;
  const fixture = loadRegisterPage({
    registerAccountName() {
      calls += 1;
      return request.promise;
    }
  });
  fixture.page.goRegister();
  fixture.page.setData({ regAccount: 'memberA', regPassword: '123456', regConfirm: '123456' });
  fixture.page.register();
  assert.strictEqual(calls, 0, 'Unchecked registration must not send a request.');
  assert.strictEqual(fixture.attempts.begun.length, 0);

  fixture.page.setData({ agreementChecked: true });
  fixture.page.register();
  fixture.page.register();
  assert.strictEqual(calls, 1, 'Registration should be single-flight.');
  request.resolve({ account: 'internal', accountDisplay: 'memberA', roles: ['member'] });
  await flushPromises();
}

(async () => {
  await testRegisterUsesCloudResultAndOpensRolePicker();
  await testRegisterServerConflictStaysOnForm();
  await testRegisterConsentAndSingleFlight();
  testRegistrationSourceContract();
})();
