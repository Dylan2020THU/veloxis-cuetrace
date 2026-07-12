const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const root = path.resolve(__dirname, '..');
const nativeSetInterval = global.setInterval;
const nativeClearInterval = global.clearInterval;

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

function loadAccountSecurityPage(fakeData) {
  const pagePath = path.join(root, 'miniprogram/pages/settings/account-security/index.js');
  delete require.cache[require.resolve(pagePath)];
  let page;
  const storageReads = [];
  const navigations = [];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../../../services/data') return fakeData;
    if (request === '../../../utils/mock') return { getRole: () => 'member' };
    return originalLoad.call(this, request, parent, isMain);
  };
  global.Page = (definition) => {
    page = definition;
  };
  global.Behavior = (definition) => definition;
  global.getApp = () => ({ globalData: { userProfile: { nickname: 'forgedLocal' } } });
  global.wx = {
    getStorageSync(key) {
      storageReads.push(key);
      if (key === 'dc_accounts') {
        return [{ account: 'forgedLocal', password: 'plaintext', wechatBound: true, role: 'member' }];
      }
      if (key === 'dc_wechat_bindings') return [{ account: 'forgedLocal', role: 'member' }];
      return '';
    },
    setClipboardData() {},
    showToast() {},
    navigateTo(options) {
      navigations.push(options.url);
    }
  };
  try {
    require(pagePath);
  } finally {
    Module._load = originalLoad;
  }
  page.data = Object.assign({}, page.data);
  page.setData = function setData(next) {
    this.data = Object.assign({}, this.data, next);
  };
  page._storageReads = storageReads;
  page._navigations = navigations;
  return page;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function loadEmailBindingPage(fakeData) {
  const pagePath = path.join(root, 'miniprogram/pages/settings/email-binding/index.js');
  delete require.cache[require.resolve(pagePath)];
  let page;
  let nextTimerId = 1;
  const timers = new Map();
  const modals = [];
  const navigations = [];
  const toasts = [];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../../../services/data') return fakeData;
    return originalLoad.call(this, request, parent, isMain);
  };
  global.setInterval = (callback) => {
    const timerId = nextTimerId;
    nextTimerId += 1;
    timers.set(timerId, callback);
    return timerId;
  };
  global.clearInterval = (timerId) => {
    timers.delete(timerId);
  };
  global.Page = (definition) => {
    page = definition;
  };
  global.wx = {
    showToast(options) {
      toasts.push(options);
    },
    showModal(options) {
      modals.push(options);
      if (options.success) options.success({ confirm: true });
    },
    navigateBack() {
      navigations.push('back');
    }
  };
  try {
    require(pagePath);
  } finally {
    Module._load = originalLoad;
  }
  page.data = Object.assign({}, page.data);
  page.setData = function setData(next) {
    this.data = Object.assign({}, this.data, next);
  };
  page._timers = timers;
  page._tick = function tick() {
    Array.from(timers.values()).forEach((callback) => callback());
  };
  page._modals = modals;
  page._navigations = navigations;
  page._toasts = toasts;
  page._restoreTimers = function restoreTimers() {
    global.setInterval = nativeSetInterval;
    global.clearInterval = nativeClearInterval;
  };
  return page;
}

const settingsJs = read('miniprogram/pages/settings/index.js');
const profileWxml = read('miniprogram/pages/profile/index.wxml');
const coachProfileJs = read('miniprogram/pages/coach/profile/index.js');
const coachProfileWxml = read('miniprogram/pages/coach/profile/index.wxml');
const coachProfileWxss = read('miniprogram/pages/coach/profile/index.wxss');
const coachProfileJson = read('miniprogram/pages/coach/profile/index.json');
const textareaRule = coachProfileWxss.match(/\.field\.column \.field-input,\s*\.field-textarea\s*\{([\s\S]*?)\}/);

assert(
  /coach:\s*\{[^}]*edit:\s*'编辑教练资料'/.test(settingsJs),
  'Coach settings should label the edit entry as 编辑教练资料.'
);

assert(
  /mock\.getRole\(\)\s*===\s*'coach'[\s\S]*?wx\.navigateTo\(\{\s*url:\s*'\/pages\/coach\/profile\/index'/.test(settingsJs),
  'Coach settings edit entry should open the coach profile editor.'
);

assert(
  !profileWxml.includes('我的教练资料'),
  'The old 我的 page coach profile entry should be removed.'
);

assert(
  coachProfileJson.includes('"navigationBarTitleText": "编辑教练资料"'),
  'Coach profile page title should be 编辑教练资料.'
);

assert(
  /bindtap="applyBinding"[\s\S]*申请绑定/.test(coachProfileWxml),
  'Coach profile page should expose a standalone 申请绑定 button near the hall field.'
);

assert(
  !coachProfileWxml.includes('binding-action-row'),
  'The binding button should sit inside the status row instead of occupying a separate row.'
);

assert(
  /\.binding-apply-btn\s*\{[\s\S]*?width:\s*132rpx/.test(coachProfileWxss),
  'The binding button should use a compact fixed width.'
);

assert(
  textareaRule && /(^|\n)\s*height:\s*40rpx\s*;/.test(textareaRule[1]),
  'The coach intro textarea should set explicit height because min-height does not override the native textarea default.'
);

assert(
  !/approvedStoreId:\s*p\.hallId/.test(coachProfileJs),
  'Saved coach profile hallId must not be treated as an approved shop binding.'
);

assert(
  !coachProfileWxml.includes('保存并申请绑定'),
  'The save button should not submit binding applications.'
);

const submitBlock = coachProfileJs.match(/\n  submit\(\) \{[\s\S]*?\n  applyBinding\(\) \{/);
assert(submitBlock, 'submit() should be followed by a standalone applyBinding() method.');
assert(
  !submitBlock[0].includes('applyCoachShopBinding'),
  'submit() must save profile only and not automatically apply for binding.'
);

async function testAccountSecurityUsesCloudStatus() {
  let statusCalls = 0;
  const page = loadAccountSecurityPage({
    getAccountSecurity() {
      statusCalls += 1;
      return Promise.resolve({
        account: 'memberA',
        wechatBound: true,
        passwordSet: true,
        phone: '13800138000',
        emailBound: true,
        emailMasked: 'm***@example.com',
        roles: ['member']
      });
    },
    getUserProfile() {
      return Promise.resolve({ phone: '13900139000' });
    }
  });

  page.refresh();
  await flushPromises();

  assert.strictEqual(statusCalls, 1);
  assert.strictEqual(page.data.accountText, 'memberA');
  assert.strictEqual(page.data.passwordText, '\u5df2\u8bbe\u7f6e');
  assert.strictEqual(page.data.phoneText, '138****8000');
  assert.strictEqual(page.data.wechatText, '\u5df2\u7ed1\u5b9a');
  assert.strictEqual(page.data.emailText, 'm***@example.com');
  assert.deepStrictEqual(page._storageReads, [], 'Account security must not read legacy local authentication stores.');
}

async function testAccountSecurityFailsClosed() {
  const page = loadAccountSecurityPage({
    getAccountSecurity() {
      return Promise.reject(new Error('cloud unavailable'));
    },
    getUserProfile() {
      return Promise.resolve({ phone: '13900139000' });
    }
  });

  page.refresh();
  await flushPromises();

  assert.strictEqual(page.data.accountText, '\u672a\u767b\u5f55');
  assert.strictEqual(page.data.passwordText, '\u672a\u8bbe\u7f6e');
  assert.strictEqual(page.data.phoneText, '\u672a\u7ed1\u5b9a');
  assert.strictEqual(page.data.wechatText, '\u672a\u7ed1\u5b9a');
  assert.strictEqual(page.data.emailText, '\u672a\u7ed1\u5b9a');
  assert.deepStrictEqual(page._storageReads, [], 'Cloud failure must not fall back to local authentication records.');
}

async function testAccountSecurityEmailEntry() {
  const page = loadAccountSecurityPage({
    getAccountSecurity() {
      return Promise.resolve({ emailBound: false, emailMasked: 'forged@example.com' });
    }
  });

  page.onShow();
  await flushPromises();

  assert.strictEqual(page.data.emailText, '\u672a\u7ed1\u5b9a');
  page.onEmail();
  assert.deepStrictEqual(page._navigations, ['/pages/settings/email-binding/index']);
}

async function testEmailBindingCloudFlowAndLifecycle() {
  const sendRequest = deferred();
  const bindRequest = deferred();
  const calls = { status: 0, send: [], bind: [] };
  const page = loadEmailBindingPage({
    getAccountSecurity() {
      calls.status += 1;
      return Promise.resolve({ emailBound: true, emailMasked: 'm***@example.com' });
    },
    sendEmailCode(payload) {
      calls.send.push(payload);
      return sendRequest.promise;
    },
    bindEmail(payload) {
      calls.bind.push(payload);
      return bindRequest.promise;
    }
  });

  page.onShow();
  await flushPromises();
  assert.strictEqual(calls.status, 1);
  assert.strictEqual(page.data.currentEmail, 'm***@example.com');

  page.onEmailInput({ detail: { value: ' member@example.com ' } });
  page.sendCode();
  assert.deepStrictEqual(calls.send, [{ purpose: 'bind', email: 'member@example.com' }]);
  assert.strictEqual(page.data.sending, true);

  sendRequest.resolve({});
  await flushPromises();
  assert.strictEqual(page.data.counting, true);
  assert.strictEqual(page.data.countdown, 60);
  assert.strictEqual(page._timers.size, 1);
  page._tick();
  assert.strictEqual(page.data.countdown, 59);

  page.onCodeInput({ detail: { value: ' 123456 ' } });
  page.submit();
  assert.deepStrictEqual(calls.bind, [{ email: 'member@example.com', code: '123456' }]);
  bindRequest.resolve({});
  await flushPromises();
  assert.strictEqual(page._modals.length, 1);
  assert.deepStrictEqual(page._navigations, ['back']);

  page.onUnload();
  assert.strictEqual(page._timers.size, 0);
  page._restoreTimers();
}

async function testEmailBindingDoesNotForgeSuccessAfterFailureOrUnload() {
  const page = loadEmailBindingPage({
    getAccountSecurity() {
      return Promise.reject(new Error('offline'));
    },
    sendEmailCode() {
      return Promise.reject(new Error('send failed'));
    },
    bindEmail() {
      return Promise.reject(new Error('bind failed'));
    }
  });

  page.onShow();
  await flushPromises();
  assert.strictEqual(page.data.currentEmail, '\u672a\u7ed1\u5b9a');

  page.onEmailInput({ detail: { value: 'member@example.com' } });
  page.sendCode();
  await flushPromises();
  assert.strictEqual(page.data.counting, false);
  assert.strictEqual(page._timers.size, 0);

  page.onCodeInput({ detail: { value: '123456' } });
  page.submit();
  await flushPromises();
  assert.strictEqual(page._modals.length, 0);
  assert.strictEqual(page._navigations.length, 0);
  page._restoreTimers();

  const pendingSend = deferred();
  const pendingPage = loadEmailBindingPage({
    getAccountSecurity() {
      return Promise.resolve({ emailBound: false });
    },
    sendEmailCode() {
      return pendingSend.promise;
    },
    bindEmail() {
      return Promise.resolve({});
    }
  });
  pendingPage.onEmailInput({ detail: { value: 'member@example.com' } });
  pendingPage.sendCode();
  pendingPage.onUnload();
  pendingSend.resolve({});
  await flushPromises();
  assert.strictEqual(pendingPage.data.counting, false);
  assert.strictEqual(pendingPage._timers.size, 0);
  pendingPage._restoreTimers();
}

(async () => {
  await testAccountSecurityUsesCloudStatus();
  await testAccountSecurityFailsClosed();
  await testAccountSecurityEmailEntry();

  const emailPagePath = path.join(root, 'miniprogram/pages/settings/email-binding/index.js');
  assert(fs.existsSync(emailPagePath), 'Email binding page must exist.');
  const emailBindingWxml = read('miniprogram/pages/settings/email-binding/index.wxml');
  const appJson = read('miniprogram/app.json');
  const legalJs = read('miniprogram/pages/legal/index.js');
  assert(appJson.includes('pages/settings/email-binding/index'), 'app.json must register the email binding page.');
  assert(/bindtap="sendCode"/.test(emailBindingWxml), 'Email binding page must expose the send-code action.');
  assert(/bindtap="submit"/.test(emailBindingWxml), 'Email binding page must expose the bind action.');
  assert(/\u5df2\u9a8c\u8bc1\u90ae\u7bb1/.test(legalJs), 'Privacy policy must disclose the verified email used for account security.');
  assert(/\u9a8c\u8bc1\u7801\u53d1\u9001\u8bb0\u5f55/.test(legalJs), 'Privacy policy must disclose verification-code delivery records.');
  assert(/\u5bc6\u7801\u627e\u56de/.test(legalJs), 'Privacy policy must disclose the password-recovery purpose.');
  assert(!/\u9a8c\u8bc1\u7801\u660e\u6587|\u5bc6\u94a5/.test(legalJs), 'Privacy policy must not claim collection of code plaintext or keys.');

  await testEmailBindingCloudFlowAndLifecycle();
  await testEmailBindingDoesNotForgeSuccessAfterFailureOrUnload();
})();
