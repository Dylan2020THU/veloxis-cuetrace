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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function loadDataServiceForLogin(cloudReady) {
  const dataPath = path.join(root, 'miniprogram/services/data.js');
  const calls = [];
  const app = {
    globalData: {
      cloudReady,
      openid: '',
      roles: [],
      currentRole: '',
      role: ''
    }
  };
  global.getApp = () => app;
  global.wx = {
    cloud: {
      callFunction(input) {
        calls.push(input);
        return Promise.resolve({
          result: {
            ok: true,
            openid: 'openid_from_cloud',
            roles: ['member', 'coach'],
            currentRole: 'coach'
          }
        });
      }
    },
    getStorageSync() {
      return null;
    },
    setStorageSync() {},
    removeStorageSync() {},
    showToast() {}
  };
  delete require.cache[require.resolve(dataPath)];
  return { data: require(dataPath), app, calls };
}

async function testDataLoginUsesOnlyServerAuthorizedRole() {
  const connected = loadDataServiceForLogin(true);
  const openid = await connected.data.login('coach', ['member', 'coach'], 'coach1');
  assert.strictEqual(openid, 'openid_from_cloud');
  assert.deepStrictEqual(connected.calls, [
    { name: 'login', data: { role: 'coach' } }
  ]);

  const disconnected = loadDataServiceForLogin(false);
  await assert.rejects(
    () => disconnected.data.login('member'),
    (error) => error.code === 'CLOUD_NOT_READY'
  );
  assert.strictEqual(disconnected.calls.length, 0);
  assert.strictEqual(disconnected.app.globalData.openid, '');
}

function loadLoginPage(accounts, fakeData, appData) {
  const loginPath = path.join(root, 'miniprogram/pages/login/index.js');
  const dataPath = path.join(root, 'miniprogram/services/data.js');
  const mockPath = path.join(root, 'miniprogram/utils/mock.js');
  delete require.cache[require.resolve(loginPath)];
  delete require.cache[require.resolve(dataPath)];
  delete require.cache[require.resolve(mockPath)];

  let page;
  const calls = {
    storageReads: [],
    storageWrites: [],
    storageRemovals: [],
    toasts: [],
    modals: [],
    switchTab: [],
    reLaunch: [],
    navigateTo: []
  };
  const app = { globalData: Object.assign({ cloudReady: false, account: '', roles: [] }, appData || {}) };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (fakeData && request === '../../services/data') return fakeData;
    return originalLoad.call(this, request, parent, isMain);
  };
  global.Page = (def) => {
    page = def;
  };
  global.Behavior = (def) => def;
  global.getApp = () => app;
  global.wx = {
    getStorageSync(key) {
      calls.storageReads.push(key);
      if (key === 'dc_accounts') return accounts;
      return null;
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
    showModal(options) {
      calls.modals.push(options);
    },
    switchTab(options) {
      calls.switchTab.push(options);
    },
    reLaunch(options) {
      calls.reLaunch.push(options);
    },
    navigateTo(options) {
      calls.navigateTo.push(options);
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
  page._testCalls = calls;
  page._testApp = app;
  return page;
}

const loginJs = read('miniprogram/pages/login/index.js');
const loginWxml = read('miniprogram/pages/login/index.wxml');
const loginWxss = read('miniprogram/pages/login/index.wxss');

function cssBlock(selector) {
  const escaped = selector.replace('.', '\\.');
  const match = loginWxss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match ? match[1] : '';
}

assert(
  loginJs.includes('wechatLogin()'),
  'Login page should expose a dedicated WeChat login handler.'
);

assert(
  !loginWxml.includes('微信登录 ·'),
  'Primary role button should not switch to WeChat login copy when cloud is ready.'
);

assert(
  !loginWxml.includes('wx:for="{{roles}}"') &&
    !loginWxml.includes('bindtap="selectRole"') &&
    !loginWxml.includes('bindtap="goNext"'),
  'Login page should not render the old pre-login identity selector.'
);

assert(
  loginWxml.includes('账号登录') && loginWxml.includes('手机号登录'),
  'Login page should show account login and phone login for every role.'
);

assert(
  loginWxml.includes('其他登录方式') && /class="wechat-icon-btn"[\s\S]*bindtap="wechatLogin"/.test(loginWxml),
  'WeChat login should be presented as an icon button under 其他登录方式.'
);

const wechatButtonMatch = loginWxml.match(/<button[^>]*class="wechat-icon-btn"[^>]*bindtap="wechatLogin"[^>]*>([\s\S]*?)<\/button>/);
assert(wechatButtonMatch, 'WeChat login icon button should exist.');
const wechatButtonText = wechatButtonMatch[1].replace(/<[^>]+>/g, '').trim();
assert(
  !wechatButtonText,
  'The WeChat login button should not display a text label.'
);

assert(
  /<image[^>]+class="wechat-logo-img"[^>]+src="\/images\/login\/WeChat_logo\.ico"/.test(loginWxml),
  'The WeChat login button should render the configured official WeChat icon image.'
);

assert(
  loginWxml.includes('当前微信尚未绑定账号') &&
    loginWxml.includes('每个账号和微信只能绑定一次') &&
    !loginWxml.includes('bindtap="bindWechat"') &&
    !loginWxml.includes('绑定账号或手机号'),
  'An unbound WeChat should show binding guidance instead of the old local binding form.'
);

assert(
  !loginWxml.includes('wechat-logo-bubble') && !loginWxss.includes('wechat-logo-bubble') && !loginWxss.includes('wechat-dot'),
  'The WeChat login button should not use the old hand-drawn logo.'
);

assert(
  !/\.theme-dark \.wechat-icon-btn/.test(loginWxss),
  'The WeChat icon background should not vary by theme.'
);

assert(
  !cssBlock('.hero').includes('background: linear-gradient') &&
    !cssBlock('.hero-name').includes('color: #fff'),
  'Login hero should stay clean without the old blue block.'
);

assert(
  /\.wechat-icon-btn::after\s*\{[\s\S]*?border:\s*none/.test(loginWxss),
  'The WeChat logo icon should remove the native button pseudo-border.'
);

assert(
  /\.wechat-icon-btn\s*\{[\s\S]*?min-width:\s*74rpx[\s\S]*?max-width:\s*74rpx/.test(loginWxss) &&
    /\.wechat-logo-img\s*\{[\s\S]*?width:\s*74rpx[\s\S]*?height:\s*74rpx/.test(loginWxss),
  'The WeChat logo icon should be locked to 80% of the previous 92rpx size.'
);

assert(
  loginJs.includes("step: 'auth'"),
  'Login page should start from account login/register, not role selection.'
);

assert(
  loginJs.includes('showRolePicker(') && loginJs.includes('chooseRole('),
  'Login page should defer role selection until after account verification.'
);

assert(
  /<block\s+wx:(?:el)?if="\{\{step === 'auth'\}\}">/.test(loginWxml),
  'Login form should render in auth step.'
);

assert(
  loginWxml.includes('wx:for="{{availableRoles}}"') &&
    loginWxml.includes('bindtap="chooseRole"') &&
    loginWxml.includes('role-lock') &&
    loginWxml.includes('bindtap="enterSelectedRole"'),
  'Role picker should render every role, lock unopened roles, and enter only after confirmation.'
);

assert(
  loginWxml.includes('忘记密码') && loginWxml.includes('bindtap="openRecovery"'),
  'Password login should expose a recovery entry.'
);

assert(
  loginWxml.includes("mode === 'register'") &&
    loginWxml.includes("recoveryType === 'wechat'") &&
    loginWxml.includes("recoveryType === 'email'") &&
    loginWxml.includes('bindtap="sendRecoveryEmailCode"') &&
    loginWxml.includes('bindtap="submitRecovery"'),
  'Recovery UI should provide independent WeChat and email password-reset flows.'
);

async function testPasswordLoginErrorsAreHandledExplicitly() {
  const missing = loadLoginPage([], {
    loginWithPassword() {
      return Promise.reject(Object.assign(new Error('missing'), { code: 'ACCOUNT_NOT_FOUND' }));
    }
  });
  missing.setData({
    account: 'NewMember',
    password: '123456',
    agreementChecked: true,
    loginType: 'password'
  });

  missing.submit();
  await flushPromises();

  assert.strictEqual(missing._testCalls.modals.length, 1);
  assert.strictEqual(missing._testCalls.modals[0].title, '账号未注册');
  assert.strictEqual(missing._testCalls.modals[0].content, '未找到该账号，是否现在注册？');
  missing._testCalls.modals[0].success({ confirm: true });
  assert.strictEqual(missing.data.mode, 'register');
  assert.strictEqual(missing.data.regAccount, 'NewMember');
  assert.strictEqual(missing.data.regPassword, '');
  assert.strictEqual(missing.data.regConfirm, '');

  const invalid = loadLoginPage([], {
    loginWithPassword() {
      return Promise.reject(Object.assign(new Error('wrong'), { code: 'INVALID_PASSWORD' }));
    }
  });
  invalid.setData({
    account: 'MemberA',
    password: 'badpass',
    agreementChecked: true,
    loginType: 'password'
  });

  invalid.submit();
  await flushPromises();

  assert(invalid._testCalls.toasts.some((item) => item.title === '账号密码错误'));
  assert.strictEqual(invalid._testCalls.modals.length, 0);
}

async function testWechatRecoveryNeedsNoAgreementAndPrefillsServerAccount() {
  const resetCalls = [];
  const page = loadLoginPage([], {
    resetPasswordByWechat(input) {
      resetCalls.push(input);
      return Promise.resolve({ ok: true, account: 'ServerMember' });
    }
  });
  page.setData({ account: 'typedAccount', agreementChecked: false });
  page.openRecovery();
  page.setData({ recoveryPassword: 'newpass1', recoveryConfirm: 'newpass1' });

  page.submitRecovery();
  await flushPromises();

  assert.deepStrictEqual(resetCalls, [{ password: 'newpass1' }]);
  assert.strictEqual(page.data.mode, 'login');
  assert.strictEqual(page.data.account, 'ServerMember');
  assert.strictEqual(page.data.password, '');
  assert(page._testCalls.toasts.some((item) => item.title.includes('新密码登录')));
}

async function testEmailRecoverySendsCodeAndUsesIndependentCountdown() {
  const sendCalls = [];
  const resetCalls = [];
  let countdownCalls = 0;
  const page = loadLoginPage([], {
    sendEmailCode(input) {
      sendCalls.push(input);
      return Promise.resolve({ ok: true, msg: '若信息匹配，验证码将发送至绑定邮箱' });
    },
    resetPasswordByEmail(input) {
      resetCalls.push(input);
      return Promise.resolve({ ok: true, account: 'CanonicalAccount' });
    }
  });
  page.startRecoveryCountdown = () => {
    countdownCalls += 1;
  };
  page.openRecovery();
  page.switchRecoveryType({ currentTarget: { dataset: { type: 'email' } } });
  page.setData({
    agreementChecked: false,
    recoveryAccount: ' MemberA ',
    recoveryEmail: ' member@example.com ',
    recoveryCode: ' 123456 ',
    recoveryPassword: 'newpass2',
    recoveryConfirm: 'newpass2'
  });

  page.sendRecoveryEmailCode();
  await flushPromises();
  assert.deepStrictEqual(sendCalls, [{
    purpose: 'reset',
    account: 'MemberA',
    email: 'member@example.com'
  }]);
  assert.strictEqual(countdownCalls, 1);
  assert.strictEqual(page.data.counting, false, 'Recovery must not reuse the SMS countdown state.');

  page.submitRecovery();
  await flushPromises();
  assert.deepStrictEqual(resetCalls, [{
    account: 'MemberA',
    email: 'member@example.com',
    code: '123456',
    password: 'newpass2'
  }]);
  assert.strictEqual(page.data.mode, 'login');
  assert.strictEqual(page.data.account, 'CanonicalAccount');
}

async function testStaleRecoveryEmailSuccessIsIgnoredAfterSwitchOrExit() {
  for (const action of ['switch', 'back']) {
    const request = deferred();
    let countdownCalls = 0;
    const page = loadLoginPage([], {
      sendEmailCode() {
        return request.promise;
      }
    });
    page.startRecoveryCountdown = () => {
      countdownCalls += 1;
    };
    page.openRecovery();
    page.switchRecoveryType({ currentTarget: { dataset: { type: 'email' } } });
    page.setData({ recoveryAccount: 'MemberA', recoveryEmail: 'member@example.com' });
    page.sendRecoveryEmailCode();

    if (action === 'switch') {
      page.switchRecoveryType({ currentTarget: { dataset: { type: 'wechat' } } });
    } else {
      page.backToLogin();
    }
    const sendingAfterExit = page.data.recoverySending;
    const toastCount = page._testCalls.toasts.length;
    let staleSetDataCalls = 0;
    const setData = page.setData;
    page.setData = function trackStaleSetData(next) {
      staleSetDataCalls += 1;
      setData.call(this, next);
    };

    request.resolve({ ok: true, msg: '验证码已发送' });
    await flushPromises();

    assert.strictEqual(staleSetDataCalls, 0, `${action} should ignore stale recovery setData.`);
    assert.strictEqual(countdownCalls, 0, `${action} should not start a stale recovery timer.`);
    assert.strictEqual(page._testCalls.toasts.length, toastCount, `${action} should not show a stale success toast.`);
    assert.strictEqual(sendingAfterExit, false, `${action} should reset recovery sending state immediately.`);
    assert.strictEqual(page.data.recoveryCounting, false);
    assert.strictEqual(page.data.recoveryCountdown, 60);
  }
}

async function testOnlyLatestRecoveryEmailRequestCanUpdatePage() {
  const first = deferred();
  const second = deferred();
  const requests = [first, second];
  let countdownCalls = 0;
  const page = loadLoginPage([], {
    sendEmailCode() {
      return requests.shift().promise;
    }
  });
  page.startRecoveryCountdown = () => {
    countdownCalls += 1;
  };

  page.openRecovery();
  page.switchRecoveryType({ currentTarget: { dataset: { type: 'email' } } });
  page.setData({ recoveryAccount: 'MemberA', recoveryEmail: 'member@example.com' });
  page.sendRecoveryEmailCode();
  page.openRecovery();
  page.switchRecoveryType({ currentTarget: { dataset: { type: 'email' } } });
  page.setData({ recoveryAccount: 'MemberA', recoveryEmail: 'member@example.com' });
  page.sendRecoveryEmailCode();

  first.resolve({ ok: true, msg: '旧请求' });
  await flushPromises();
  assert.strictEqual(page._testCalls.toasts.length, 0);
  assert.strictEqual(countdownCalls, 0);
  assert.strictEqual(page.data.recoverySending, true, 'The latest request should remain pending.');

  second.resolve({ ok: true, msg: '新请求' });
  await flushPromises();
  assert(page._testCalls.toasts.some((item) => item.title === '新请求'));
  assert.strictEqual(countdownCalls, 1);
  assert.strictEqual(page.data.recoverySending, false);
}

async function testRecoveryEmailCallbacksAreIgnoredAfterUnload() {
  for (const outcome of ['resolve', 'reject']) {
    const request = deferred();
    let countdownCalls = 0;
    const page = loadLoginPage([], {
      sendEmailCode() {
        return request.promise;
      }
    });
    page.startRecoveryCountdown = () => {
      countdownCalls += 1;
    };
    page.openRecovery();
    page.switchRecoveryType({ currentTarget: { dataset: { type: 'email' } } });
    page.setData({ recoveryAccount: 'MemberA', recoveryEmail: 'member@example.com' });
    page.sendRecoveryEmailCode();
    page.onUnload();
    const toastCount = page._testCalls.toasts.length;
    let staleSetDataCalls = 0;
    const setData = page.setData;
    page.setData = function trackStaleSetData(next) {
      staleSetDataCalls += 1;
      setData.call(this, next);
    };

    if (outcome === 'resolve') request.resolve({ ok: true, msg: '验证码已发送' });
    else request.reject(new Error('发送失败'));
    await flushPromises();

    assert.strictEqual(staleSetDataCalls, 0, `Unload should ignore stale ${outcome} setData.`);
    assert.strictEqual(countdownCalls, 0, `Unload should not start a timer after ${outcome}.`);
    assert.strictEqual(page._testCalls.toasts.length, toastCount, `Unload should not toast after ${outcome}.`);
  }
}

async function testWechatNotBoundRecoveryGuidesEmailAndTimersAreCleared() {
  const page = loadLoginPage([], {
    resetPasswordByWechat() {
      return Promise.reject(Object.assign(new Error('not bound'), { code: 'WECHAT_NOT_BOUND' }));
    }
  });
  let clearCalls = 0;
  page.clearRecoveryCountdown = () => {
    clearCalls += 1;
  };
  page.openRecovery();
  page.setData({ recoveryPassword: 'newpass3', recoveryConfirm: 'newpass3' });

  page.submitRecovery();
  await flushPromises();

  assert.strictEqual(page.data.recoveryType, 'email');
  assert(page._testCalls.toasts.some((item) => item.title.includes('邮箱')));
  page.switchRecoveryType({ currentTarget: { dataset: { type: 'wechat' } } });
  page.onUnload();
  assert.strictEqual(clearCalls, 2, 'Switching recovery type and unloading should clear its timer.');
}

async function testPasswordLoginUsesServerAuthResult() {
  const authCalls = [];
  const loginCalls = [];
  const fakeData = {
    loginWithPassword(input) {
      authCalls.push(input);
      return Promise.resolve({ account: 'serverCoach', roles: ['member', 'coach'], currentRole: 'coach' });
    },
    login(...args) {
      loginCalls.push(args);
      return Promise.resolve('openid');
    },
    rememberLoginNickname() {},
    getUserProfile() {
      return Promise.resolve({});
    },
    markFirstLogin() {
      return Promise.resolve();
    }
  };
  const page = loadLoginPage([
    { account: 'localAdmin', password: '123456', role: 'shop', roles: ['member', 'coach', 'shop'] }
  ], fakeData);
  page.setData({
    account: 'submittedCoach',
    password: '123456',
    agreementChecked: true,
    loginType: 'password'
  });

  page.submit();
  await flushPromises();
  await flushPromises();

  assert.deepStrictEqual(authCalls, [{ account: 'submittedCoach', password: '123456' }]);
  assert.strictEqual(loginCalls.length, 0, 'Account verification should not call data.login before role selection.');
  assert.strictEqual(page.data.step, 'role');
  assert.strictEqual(page.data.pendingAccount, 'serverCoach');
  assert.deepStrictEqual(page.data.pendingRoles, ['member', 'coach']);
  assert.deepStrictEqual(page.data.availableRoles.map((item) => [item.key, item.enabled]), [
    ['member', true],
    ['coach', true],
    ['shop', false]
  ]);

  page.chooseRole({ currentTarget: { dataset: { role: 'coach' } } });
  assert.strictEqual(page.data.role, 'coach');
  assert.strictEqual(loginCalls.length, 0, 'Choosing an opened role should not login until entering.');
  page.enterSelectedRole();
  await flushPromises();
  await flushPromises();

  assert.deepStrictEqual(loginCalls[0], ['coach']);
  assert(!page._testCalls.storageReads.includes('dc_accounts'), 'Password auth must not read local accounts.');
  assert(!page._testCalls.storageWrites.some(([key]) => key === 'dc_accounts' || key === 'dc_wechat_bindings'), 'Password auth must not write local auth records.');
  assert.deepStrictEqual(page._testCalls.storageRemovals.sort(), ['dc_accounts', 'dc_wechat_bindings']);
}

async function testWechatLoginUsesServerAuthResult() {
  const fakeData = {
    loginWithWechat() {
      return Promise.resolve({ account: 'serverMember', roles: ['member'], currentRole: 'member' });
    }
  };
  const page = loadLoginPage([
    { account: 'forgedShop', password: '123456', role: 'shop', roles: ['shop'] }
  ], fakeData);
  page.setData({ agreementChecked: true });

  page.wechatLogin();
  await flushPromises();

  assert.strictEqual(page.data.step, 'role');
  assert.strictEqual(page.data.pendingAccount, 'serverMember');
  assert.deepStrictEqual(page.data.pendingRoles, ['member']);
  assert(!page._testCalls.storageReads.includes('dc_accounts'), 'WeChat auth must ignore forged local accounts.');
}

async function testWechatNotBoundShowsGuidance() {
  const error = Object.assign(new Error('当前微信尚未绑定账号'), { code: 'WECHAT_NOT_BOUND' });
  const page = loadLoginPage([], {
    loginWithWechat() {
      return Promise.reject(error);
    }
  });
  page.setData({ agreementChecked: true });

  page.wechatLogin();
  await flushPromises();

  assert.strictEqual(page.data.mode, 'wechatBind');
  assert.strictEqual(page.data.step, 'auth');
  assert.strictEqual(page._testCalls.switchTab.length + page._testCalls.reLaunch.length, 0);
}

async function testCloudFailureStaysOnAuthStep() {
  const error = Object.assign(new Error('云服务未连接，无法登录'), { code: 'CLOUD_NOT_READY' });
  const page = loadLoginPage([], {
    loginWithPassword() {
      return Promise.reject(error);
    }
  });
  page.setData({
    account: 'memberA',
    password: '123456',
    agreementChecked: true,
    loginType: 'password'
  });

  page.submit();
  await flushPromises();

  assert.strictEqual(page.data.step, 'auth');
  assert.strictEqual(page._testCalls.switchTab.length + page._testCalls.reLaunch.length, 0);
  assert(page._testCalls.toasts.some((item) => item.title.includes('云服务')));
}

async function testSmsCodeSendDoesNotUseLocalAccounts() {
  const sendCalls = [];
  let localLookupCalls = 0;
  let countdownCalls = 0;
  const page = loadLoginPage([{ account: 'forgedLocal', phone: '13800138000', roles: ['shop'] }], {
    sendSmsCode(phone) {
      sendCalls.push(phone);
      return Promise.resolve({ ok: true });
    }
  });
  page.findRegisteredAccount = () => {
    localLookupCalls += 1;
    return null;
  };
  page.startCodeCountdown = () => {
    countdownCalls += 1;
  };
  page.setData({ phone: '13800138000' });

  page.sendCode();
  await flushPromises();

  assert.strictEqual(localLookupCalls, 0, 'Sending an SMS code must not consult local accounts.');
  assert.deepStrictEqual(sendCalls, ['13800138000']);
  assert.strictEqual(countdownCalls, 1);
  assert(!page._testCalls.storageReads.includes('dc_accounts'));
}

async function testSmsLoginUsesServerAuthResult() {
  const verifyCalls = [];
  let localLookupCalls = 0;
  let localRoleCalls = 0;
  const page = loadLoginPage([{ account: 'forgedShop', phone: '13800138000', roles: ['shop'] }], {
    verifySmsCode(phone, code) {
      verifyCalls.push([phone, code]);
      return Promise.resolve({
        ok: true,
        phone,
        account: 'serverMember',
        roles: ['member'],
        currentRole: 'member'
      });
    }
  });
  page.findRegisteredAccount = () => {
    localLookupCalls += 1;
    return { account: 'forgedShop', roles: ['shop'] };
  };
  page.resolveApprovedRoles = () => {
    localRoleCalls += 1;
    return Promise.resolve(['shop']);
  };
  page.setData({
    loginType: 'sms',
    phone: '13800138000',
    code: '123456',
    agreementChecked: true
  });

  page.submit();
  await flushPromises();
  await flushPromises();

  assert.deepStrictEqual(verifyCalls, [['13800138000', '123456']]);
  assert.strictEqual(localLookupCalls, 0, 'SMS authentication must not read a local account.');
  assert.strictEqual(localRoleCalls, 0, 'SMS authentication must not derive roles from local state.');
  assert.strictEqual(page.data.pendingAccount, 'serverMember');
  assert.deepStrictEqual(page.data.pendingRoles, ['member']);
  assert(!page._testCalls.storageReads.includes('dc_accounts'));
}

async function testLockedShopRoleOpensApplicationWithoutShopLogin() {
  const calls = {
    login: [],
    navigateTo: [],
    reLaunch: []
  };
  const fakeData = {
    login(...args) {
      calls.login.push(args);
      return Promise.resolve('openid');
    },
    rememberLoginNickname() {},
    getUserProfile() {
      return Promise.resolve({});
    },
    markFirstLogin() {
      return Promise.resolve();
    }
  };
  const page = loadLoginPage([
    { account: 'member1', password: '123456', role: 'member', roles: ['member'] }
  ], fakeData);
  global.wx.showModal = (options) => options.success({ confirm: true });
  global.wx.navigateTo = (args) => calls.navigateTo.push(args);
  global.wx.reLaunch = (args) => calls.reLaunch.push(args);
  page.setData({
    step: 'role',
    pendingAccount: 'member1',
    pendingRoles: ['member'],
    availableRoles: [
      { key: 'member', label: '球员', enabled: true },
      { key: 'coach', label: '教练', enabled: false },
      { key: 'shop', label: '店主', enabled: false }
    ],
    role: 'member',
    roleLabel: '球员'
  });

  page.chooseRole({ currentTarget: { dataset: { role: 'shop' } } });
  await flushPromises();
  await flushPromises();

  assert.strictEqual(calls.login.length, 0, 'Opening shop identity should not call data.login before qualification approval.');
  assert.strictEqual(calls.navigateTo[0].url, '/pages/shop/apply/index?source=rolePicker');
  assert.strictEqual(typeof calls.navigateTo[0].fail, 'function');
  assert.strictEqual(calls.reLaunch.length, 0, 'Opening shop identity should not reLaunch away from the role picker.');
}

async function testServerRolesAloneDriveRolePicker() {
  let localStatusCalls = 0;
  const fakeData = {
    loginWithPassword() {
      return Promise.resolve({ account: 'serverMember', roles: ['member'], currentRole: 'member' });
    },
    getShopApplicationStatus() {
      localStatusCalls += 1;
      return Promise.resolve({ status: 'approved' });
    }
  };
  const page = loadLoginPage([
    { account: 'member1', password: '123456', role: 'shop', roles: ['member', 'shop'] }
  ], fakeData);
  page.setData({
    account: 'member1',
    password: '123456',
    agreementChecked: true,
    loginType: 'password'
  });

  page.submit();
  await flushPromises();
  await flushPromises();

  const shop = page.data.availableRoles.find((item) => item.key === 'shop');
  assert(shop && !shop.enabled, 'Only roles returned by accountAuth should enable role options.');
  assert.deepStrictEqual(page.data.pendingRoles, ['member']);
  assert.strictEqual(localStatusCalls, 0, 'Password authentication must not augment server roles from another source.');
}

async function testSwitchRoleParamOpensRolePickerFromCurrentSession() {
  let legacyNameReads = 0;
  const fakeData = {
    getCurrentLoginName() {
      legacyNameReads += 1;
      return 'forgedLocalName';
    }
  };
  const page = loadLoginPage([], fakeData, {
    account: 'serverAccount',
    currentRole: 'member',
    roles: ['member', 'coach'],
    userProfile: { nickname: 'profileName', roles: ['member', 'shop'] }
  });

  page.onLoad({ switchRole: '1' });
  await flushPromises();
  await flushPromises();

  assert.strictEqual(page.data.step, 'role');
  assert.strictEqual(page.data.pendingAccount, 'serverAccount');
  assert.deepStrictEqual(page.data.pendingRoles, ['member', 'coach']);
  assert.deepStrictEqual(page.data.availableRoles.map((item) => [item.key, item.enabled]), [
    ['member', true],
    ['coach', true],
    ['shop', false]
  ]);
  assert.strictEqual(legacyNameReads, 0, 'Switch-role recovery must not use a locally remembered login name.');
}

async function testSwitchRoleRefreshesMissingRuntimeSessionFromCloud() {
  const statusCalls = [];
  const fakeData = {
    getAccountSecurity() {
      statusCalls.push(true);
      return Promise.resolve({ account: 'cloudAccount', roles: ['member', 'shop'], currentRole: 'shop' });
    }
  };
  const page = loadLoginPage([], fakeData, { account: '', currentRole: '', roles: [] });

  page.onLoad({ switchRole: '1' });
  await flushPromises();
  await flushPromises();

  assert.strictEqual(page.data.step, 'role');
  assert.strictEqual(page.data.pendingAccount, 'cloudAccount');
  assert.deepStrictEqual(page.data.pendingRoles, ['member', 'shop']);
  assert.deepStrictEqual(page.data.availableRoles.map((item) => [item.key, item.enabled]), [
    ['member', true],
    ['coach', false],
    ['shop', true]
  ]);
  assert.strictEqual(statusCalls.length, 1);
}

(async () => {
  await testPasswordLoginErrorsAreHandledExplicitly();
  await testWechatRecoveryNeedsNoAgreementAndPrefillsServerAccount();
  await testEmailRecoverySendsCodeAndUsesIndependentCountdown();
  await testStaleRecoveryEmailSuccessIsIgnoredAfterSwitchOrExit();
  await testOnlyLatestRecoveryEmailRequestCanUpdatePage();
  await testRecoveryEmailCallbacksAreIgnoredAfterUnload();
  await testWechatNotBoundRecoveryGuidesEmailAndTimersAreCleared();
  await testPasswordLoginUsesServerAuthResult();
  await testWechatLoginUsesServerAuthResult();
  await testWechatNotBoundShowsGuidance();
  await testCloudFailureStaysOnAuthStep();
  await testSmsCodeSendDoesNotUseLocalAccounts();
  await testSmsLoginUsesServerAuthResult();
  await testLockedShopRoleOpensApplicationWithoutShopLogin();
  await testServerRolesAloneDriveRolePicker();
  await testSwitchRoleParamOpensRolePickerFromCurrentSession();
  await testSwitchRoleRefreshesMissingRuntimeSessionFromCloud();
  await testDataLoginUsesOnlyServerAuthorizedRole();
  const page = loadLoginPage([
    { account: 'member1', password: '123456', role: 'member', roles: ['member'] }
  ]);
  let modalOptions = null;
  global.wx.showModal = (options) => {
    modalOptions = options;
  };
  page.setData({
    step: 'role',
    pendingAccount: 'member1',
    pendingRoles: ['member'],
    availableRoles: [
      { key: 'member', label: '球员', enabled: true },
      { key: 'coach', label: '教练', enabled: false },
      { key: 'shop', label: '店主', enabled: false }
    ],
    role: 'member',
    roleLabel: '球员'
  });
  page.chooseRole({ currentTarget: { dataset: { role: 'coach' } } });
  assert(modalOptions && modalOptions.content.includes('店主'), 'Locked coach role should prompt for shop owner certification.');
})();
