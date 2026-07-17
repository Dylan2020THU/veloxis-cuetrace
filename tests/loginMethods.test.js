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
    navigateTo: [],
    loading: [],
    hiddenLoading: 0
  };
  const app = { globalData: Object.assign({ cloudReady: false, account: '', roles: [] }, appData || {}) };
  const authAttempts = { begun: [], cancelled: [] };
  let attemptSequence = 0;
  const service = Object.assign({
    beginAuthAttempt(kind) {
      const attempt = { id: ++attemptSequence, kind };
      authAttempts.begun.push(attempt);
      return attempt;
    },
    cancelAuthAttempt(attempt) {
      authAttempts.cancelled.push(attempt);
      return true;
    },
    selectRole() {
      return Promise.resolve({ ok: true });
    }
  }, fakeData || {});
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../../services/data') return service;
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
    showLoading(options) {
      calls.loading.push(options);
    },
    hideLoading() {
      calls.hiddenLoading += 1;
    },
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
  page._testAuthAttempts = authAttempts;
  page._testService = service;
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

function testAuthV2PresentationSource() {
assert(
  loginJs.includes('wechatLogin()'),
  'Login page should expose a dedicated WeChat login handler.'
);

assert(
  loginJs.includes("mode: 'login'") && loginJs.includes("loginType: 'sms'"),
  'Auth v2 should default to login mode with SMS login selected.'
);

assert(
  loginWxml.indexOf('验证码登录') !== -1 &&
    loginWxml.indexOf('密码登录') > loginWxml.indexOf('验证码登录'),
  'Login tabs should show 验证码登录 before 密码登录.'
);

assert(
  loginWxml.includes('未注册手机号验证后将自动创建账号') &&
    loginWxml.includes('手机号或账号') &&
    loginWxml.includes('未设置密码可使用验证码登录'),
  'The login forms should explain phone auto-registration and password fallback without enumeration.'
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
  loginWxml.includes("mode === 'wechatPhone'") &&
    loginWxml.includes('bindtap="verifyWechatEntryPhone"') &&
    !loginWxml.includes("mode === 'wechatBind'"),
  'An unbound WeChat should enter the Auth v2 phone-proof mode.'
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
  loginJs.includes("'login'") &&
    loginJs.includes("'register'") &&
    loginJs.includes("'recover'") &&
    loginJs.includes("'wechatPhone'") &&
    loginJs.includes("'rolePicker'"),
  'The page should implement exactly the five Auth v2 presentation modes.'
);

assert(
  loginJs.includes('showRolePicker(') && loginJs.includes('chooseRole('),
  'Login page should defer role selection until after account verification.'
);

assert(
  loginWxml.includes("mode === 'rolePicker'") &&
    loginWxml.includes('{{pendingAccountDisplay}}') &&
    !loginWxml.includes('{{pendingAccount}}'),
  'Role picker should render only accountDisplay, never the internal account id.'
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

assert(
  loginWxml.includes('disabled="{{recoverySubmitting}}"') &&
    loginWxml.includes("{{recoverySubmitting ? '提交中' : '重置密码'}}"),
  'Recovery submit should be disabled and show submitting copy while pending.'
);

assert(
  !loginJs.includes('verifySmsCode') &&
    !loginJs.includes('dc_accounts') &&
    !loginJs.includes('dc_wechat_bindings') &&
    !loginJs.includes('registerAccount('),
  'Auth v2 login must not retain legacy local auth or retired facade calls.'
);

assert(
  loginJs.includes('TERMS_VERSION') && loginJs.includes('PRIVACY_VERSION'),
  'Configured agreement versions should be submitted only by checked actions.'
);
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
  assert.strictEqual(page._testCalls.hiddenLoading, 1, 'Starting a new recovery flow should close the superseded loader.');
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
  assert(page._testCalls.toasts.some((item) => item.title === '若信息匹配，验证码将发送至绑定邮箱'));
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

async function testWechatRecoveryFailuresAreUniformAndNonEnumerating() {
  for (const code of ['WECHAT_NOT_BOUND', 'ACCOUNT_NOT_FOUND', 'ACCOUNT_DISABLED']) {
    const page = loadLoginPage([], {
      resetPasswordByWechat() {
        return Promise.reject(Object.assign(new Error(`private:${code}`), { code }));
      }
    });
    page.openRecovery();
    page.setData({ recoveryPassword: 'newpass3', recoveryConfirm: 'newpass3' });
    page.submitRecovery();
    await settle();

    assert.strictEqual(page.data.mode, 'recover');
    assert.strictEqual(page.data.recoveryType, 'wechat', `${code} must not reveal binding state by switching recovery modes.`);
    assert.deepStrictEqual(
      page._testCalls.toasts.map((item) => item.title),
      ['无法重置密码，请确认信息后重试']
    );
  }
}

async function testRecoverySubmissionIsSingleFlightForWechatAndEmail() {
  for (const type of ['wechat', 'email']) {
    const request = deferred();
    const resetCalls = [];
    const fakeData = type === 'wechat'
      ? {
        resetPasswordByWechat(input) {
          resetCalls.push(input);
          return request.promise;
        }
      }
      : {
        resetPasswordByEmail(input) {
          resetCalls.push(input);
          return request.promise;
        }
      };
    const page = loadLoginPage([], fakeData);
    page.openRecovery();
    if (type === 'email') {
      page.switchRecoveryType({ currentTarget: { dataset: { type: 'email' } } });
    }
    page.setData({
      recoveryAccount: 'MemberA',
      recoveryEmail: 'member@example.com',
      recoveryCode: '123456',
      recoveryPassword: 'newpass1',
      recoveryConfirm: 'newpass1'
    });

    page.submitRecovery();
    page.submitRecovery();

    assert.strictEqual(resetCalls.length, 1, `${type} recovery should submit once while pending.`);
    assert.strictEqual(page.data.recoverySubmitting, true);
    request.resolve({ ok: true, account: 'CanonicalAccount' });
    await flushPromises();
    assert.strictEqual(page.data.recoverySubmitting, false);
  }
}

async function testRecoverySubmissionCallbacksAreIgnoredAfterLifecycleInvalidation() {
  for (const type of ['wechat', 'email']) {
    for (const action of ['switch', 'back', 'success', 'unload']) {
      for (const outcome of ['resolve', 'reject']) {
        const request = deferred();
        const fakeData = type === 'wechat'
          ? { resetPasswordByWechat() { return request.promise; } }
          : { resetPasswordByEmail() { return request.promise; } };
        const page = loadLoginPage([], fakeData);
        page.openRecovery();
        if (type === 'email') {
          page.switchRecoveryType({ currentTarget: { dataset: { type: 'email' } } });
        }
        page.setData({
          recoveryAccount: 'MemberA',
          recoveryEmail: 'member@example.com',
          recoveryCode: '123456',
          recoveryPassword: 'newpass1',
          recoveryConfirm: 'newpass1'
        });
        page.submitRecovery();

        if (action === 'switch') {
          page.switchRecoveryType({
            currentTarget: { dataset: { type: type === 'wechat' ? 'email' : 'wechat' } }
          });
        } else if (action === 'back') {
          page.backToLogin();
        } else if (action === 'success') {
          page.finishRecovery({ account: 'FreshAccount' });
        } else {
          page.onUnload();
        }
        assert.strictEqual(page.data.recoverySubmitting, false, `${action} should end pending submit state.`);
        const mode = page.data.mode;
        const recoveryType = page.data.recoveryType;
        const toastCount = page._testCalls.toasts.length;
        let staleSetDataCalls = 0;
        const setData = page.setData;
        page.setData = function trackStaleSetData(next) {
          staleSetDataCalls += 1;
          setData.call(this, next);
        };

        if (outcome === 'resolve') request.resolve({ ok: true, account: 'StaleAccount' });
        else request.reject(new Error('stale reset failure'));
        await flushPromises();

        assert.strictEqual(staleSetDataCalls, 0, `${type}/${action}/${outcome} should not setData.`);
        assert.strictEqual(page._testCalls.toasts.length, toastCount, `${type}/${action}/${outcome} should not toast.`);
        assert.strictEqual(page.data.mode, mode, `${type}/${action}/${outcome} should not change mode.`);
        assert.strictEqual(page.data.recoveryType, recoveryType, `${type}/${action}/${outcome} should not change type.`);
      }
    }
  }
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
    accountDisplay: 'Server Account',
    currentRole: 'member',
    roles: ['member', 'coach'],
    userProfile: { nickname: 'profileName', roles: ['member', 'shop'] }
  });

  page.onLoad({ switchRole: '1' });
  await flushPromises();
  await flushPromises();

  assert.strictEqual(page.data.mode, 'rolePicker');
  assert.strictEqual(page.data.pendingAccount, 'serverAccount');
  assert.strictEqual(page.data.pendingAccountDisplay, 'Server Account');
  assert.deepStrictEqual(page.data.pendingRoles, ['member', 'coach']);
  assert.deepStrictEqual(page.data.availableRoles.map((item) => [item.key, item.enabled]), [
    ['member', true],
    ['coach', true],
    ['shop', false]
  ]);
  assert.strictEqual(legacyNameReads, 0, 'Switch-role recovery must not use a locally remembered login name.');
  page.onUnload();
}

async function testSwitchRoleRefreshesMissingRuntimeSessionFromCloud() {
  const statusCalls = [];
  const fakeData = {
    getAccountSecurity() {
      statusCalls.push(true);
      return Promise.resolve({ account: 'cloudAccount', accountDisplay: 'Cloud Account', roles: ['member', 'shop'], currentRole: 'shop' });
    }
  };
  const page = loadLoginPage([], fakeData, { account: '', currentRole: '', roles: [] });

  page.onLoad({ switchRole: '1' });
  await flushPromises();
  await flushPromises();

  assert.strictEqual(page.data.mode, 'rolePicker');
  assert.strictEqual(page.data.pendingAccount, 'cloudAccount');
  assert.strictEqual(page.data.pendingAccountDisplay, 'Cloud Account');
  assert.deepStrictEqual(page.data.pendingRoles, ['member', 'shop']);
  assert.deepStrictEqual(page.data.availableRoles.map((item) => [item.key, item.enabled]), [
    ['member', true],
    ['coach', false],
    ['shop', true]
  ]);
  assert.strictEqual(statusCalls.length, 1);
  assert.strictEqual(page._testCalls.hiddenLoading, 1, 'The current status success should close its loader.');
  page.onUnload();
}

async function testSwitchRoleStatusRequestIsSingleFlightAndLifecycleSafe() {
  const request = deferred();
  let statusCalls = 0;
  const page = loadLoginPage([], {
    getAccountSecurity() {
      statusCalls += 1;
      return request.promise;
    }
  }, { account: '', accountDisplay: '', currentRole: '', roles: [] });
  page.openSwitchRolePicker();
  page.openSwitchRolePicker();
  assert.strictEqual(statusCalls, 1, 'Switch-role status loading should be single-flight.');
  assert.strictEqual(page._testCalls.loading.length, 1);
  request.resolve({ account: 'cloudAccount', accountDisplay: 'Cloud Account', roles: ['member'], currentRole: 'member' });
  await settle();
  assert.strictEqual(page.data.mode, 'rolePicker');
  assert.strictEqual(page._testCalls.hiddenLoading, 1);

  for (const outcome of ['resolve', 'reject']) {
    const failure = deferred();
    const current = loadLoginPage([], {
      getAccountSecurity() { return failure.promise; }
    }, { account: '', accountDisplay: '', currentRole: '', roles: [] });
    current.openSwitchRolePicker();
    if (outcome === 'resolve') {
      failure.resolve({ account: 'cloudAccount', accountDisplay: 'Cloud Account', roles: ['member'], currentRole: 'member' });
    } else {
      failure.reject(new Error('current status failure'));
    }
    await settle();
    assert.strictEqual(current._testCalls.hiddenLoading, 1, `Current ${outcome} should close its loader.`);
    if (outcome === 'reject') assert.strictEqual(current._testCalls.toasts.length, 1);
  }

  const invalidations = [
    ['mode change', (current) => current.goRegister()],
    ['hide', (current) => current.onHide()],
    ['unload', (current) => current.onUnload()]
  ];
  for (const [name, invalidate] of invalidations) {
    for (const outcome of ['resolve', 'reject']) {
      const late = deferred();
      const current = loadLoginPage([], {
        getAccountSecurity() { return late.promise; }
      }, { account: '', accountDisplay: '', currentRole: '', roles: [] });
      current.openSwitchRolePicker();
      invalidate(current);
      const mode = current.data.mode;
      const toastCount = current._testCalls.toasts.length;
      const hideCount = current._testCalls.hiddenLoading;
      if (outcome === 'resolve') {
        late.resolve({ account: 'stale', accountDisplay: 'Stale', roles: ['shop'], currentRole: 'shop' });
      } else {
        late.reject(new Error('late status failure'));
      }
      await settle();
      assert.strictEqual(current.data.mode, mode, `${name}/${outcome} must not open a stale role picker.`);
      assert.strictEqual(current._testCalls.toasts.length, toastCount, `${name}/${outcome} must not toast.`);
      assert.strictEqual(current._testCalls.hiddenLoading, hideCount, `${name}/${outcome} must not hide another loader.`);
    }
  }
}

async function testRolePickerRedirectSignalsAreConsumed() {
  const session = {
    account: 'serverAccount',
    accountDisplay: 'Server Account',
    currentRole: 'member',
    roles: ['member', 'coach']
  };

  const optionPage = loadLoginPage([], {}, Object.assign({ authRolePickerRequired: false }, session));
  optionPage.onLoad({ rolePicker: '1' });
  assert.strictEqual(optionPage.data.mode, 'rolePicker', 'rolePicker=1 should open the role picker.');
  optionPage.onUnload();

  const appSignalPage = loadLoginPage([], {}, Object.assign({ authRolePickerRequired: true }, session));
  appSignalPage.onLoad({});
  assert.strictEqual(appSignalPage.data.mode, 'rolePicker', 'The app-level role-picker signal should open the role picker.');
  assert.strictEqual(
    appSignalPage._testApp.globalData.authRolePickerRequired,
    false,
    'The app-level role-picker signal should be consumed once.'
  );
  appSignalPage.onUnload();
}

const TERMS_VERSION = '2026-07-15';
const PRIVACY_VERSION = '2026-07-15';

function sessionResult(overrides) {
  return Object.assign({
    ok: true,
    kind: 'session_issued',
    account: 'internal-account',
    accountDisplay: '138****0000',
    roles: ['member'],
    currentRole: 'member'
  }, overrides || {});
}

async function settle() {
  await flushPromises();
  await flushPromises();
}

async function testAuthV2DefaultsAndConsentGates() {
  const calls = { send: 0, sms: 0, password: 0, register: 0, wechat: 0, verify: 0, complete: 0 };
  const page = loadLoginPage([], {
    sendSmsCode() { calls.send += 1; return Promise.resolve({ challengeId: 'challenge' }); },
    loginWithSms() { calls.sms += 1; return Promise.resolve(sessionResult()); },
    loginWithPassword() { calls.password += 1; return Promise.resolve(sessionResult()); },
    registerAccountName() { calls.register += 1; return Promise.resolve(sessionResult()); },
    loginWithWechat() { calls.wechat += 1; return Promise.resolve(sessionResult()); },
    verifyWechatEntryPhone() { calls.verify += 1; return Promise.resolve({ proofToken: 'proof' }); },
    completeWechatEntry() { calls.complete += 1; return Promise.resolve(sessionResult()); }
  });

  assert.strictEqual(page.data.mode, 'login');
  assert.strictEqual(page.data.loginType, 'sms');
  assert.strictEqual(page.data.agreementChecked, false);
  page.openAgreement();
  page.openPrivacyPolicy();
  assert.strictEqual(page.data.agreementChecked, false, 'Opening legal pages is not consent.');
  page.setData({ phone: '13800138000', code: '123456' });
  page.sendCode();
  page.submit();
  page.setData({ agreementChecked: true });
  page.switchType({ currentTarget: { dataset: { type: 'password' } } });
  assert.strictEqual(page.data.agreementChecked, false, 'Switching login tabs should require fresh consent.');
  page.setData({ identifier: 'memberA', password: '123456' });
  page.submit();
  page.setData({ agreementChecked: true });
  page.goRegister();
  assert.strictEqual(page.data.agreementChecked, false, 'Entering registration should require fresh consent.');
  page.setData({ regAccount: 'memberA', regPassword: '123456', regConfirm: '123456' });
  page.register();
  page.setData({ agreementChecked: true });
  page.backToLogin();
  assert.strictEqual(page.data.agreementChecked, false, 'Returning to login should require fresh consent.');
  page.wechatLogin();
  page.setData({ agreementChecked: true });
  page.enterWechatPhone();
  assert.strictEqual(page.data.agreementChecked, false, 'Starting WeChat phone proof should require fresh consent.');
  page.setData({ phone: '13800138000', code: '123456', smsChallengeId: 'challenge', smsChallengePhone: '13800138000' });
  page.verifyWechatEntryPhone();

  assert.deepStrictEqual(calls, { send: 0, sms: 0, password: 0, register: 0, wechat: 0, verify: 0, complete: 0 });
  assert.strictEqual(page._testAuthAttempts.begun.length, 0, 'Unchecked actions must not begin a data-layer attempt.');
}

async function testSmsRequestsUseCurrentChallengeAndExactVersions() {
  const sendCalls = [];
  const loginCalls = [];
  const challengeIds = ['challenge-old', 'challenge-current'];
  const page = loadLoginPage([], {
    sendSmsCode(input) {
      sendCalls.push(input);
      return Promise.resolve({ ok: true, challengeId: challengeIds.shift() });
    },
    loginWithSms(input, attempt) {
      loginCalls.push([input, attempt]);
      return Promise.resolve(sessionResult());
    }
  });
  page.startCodeCountdown = () => {};
  page.setData({ agreementChecked: true, phone: '13800138000' });
  page.sendCode();
  await settle();
  assert.strictEqual(page.data.smsChallengeId, 'challenge-old');

  page.setData({ counting: false, agreementChecked: true });
  page.sendCode();
  await settle();
  assert.strictEqual(page.data.smsChallengeId, 'challenge-current', 'A successful new send must replace the old challenge.');
  assert.deepStrictEqual(sendCalls, [
    { phone: '13800138000', purpose: 'login' },
    { phone: '13800138000', purpose: 'login' }
  ]);

  page.setData({ code: ' 123456 ', agreementChecked: true });
  page.submit();
  await settle();
  assert.strictEqual(page._testAuthAttempts.begun.length, 1);
  assert.strictEqual(page._testAuthAttempts.begun[0].kind, 'loginSms');
  assert.deepStrictEqual(loginCalls, [[{
    phone: '13800138000',
    challengeId: 'challenge-current',
    code: '123456',
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION
  }, page._testAuthAttempts.begun[0]]]);
}

async function testSmsSubmitRequiresChallengeForCurrentPhone() {
  const loginCalls = [];
  const page = loadLoginPage([], {
    loginWithSms(input) { loginCalls.push(input); return Promise.resolve(sessionResult()); }
  });
  page.setData({
    agreementChecked: true,
    phone: '13800138000',
    code: '123456',
    smsChallengeId: 'challenge-a',
    smsChallengePhone: '13800138000'
  });
  page.onInput({ currentTarget: { dataset: { field: 'phone' } }, detail: { value: '13900139000' } });
  assert.strictEqual(page.data.smsChallengeId, '', 'Changing the phone must invalidate its challenge.');
  page.submit();
  await settle();
  assert.strictEqual(loginCalls.length, 0);
  assert(page._testCalls.toasts.some((item) => item.title.includes('验证码')));
}

async function testPasswordRegisterAndWechatUseExactAttempts() {
  const passwordCalls = [];
  const passwordPage = loadLoginPage([], {
    loginWithPassword(input, attempt) {
      passwordCalls.push([input, attempt]);
      return Promise.resolve(sessionResult({ account: 'acct-secret', accountDisplay: '手机号用户' }));
    }
  });
  passwordPage.switchType({ currentTarget: { dataset: { type: 'password' } } });
  passwordPage.setData({ agreementChecked: true, identifier: ' MemberA ', password: '123456' });
  passwordPage.submit();
  await settle();
  assert.deepStrictEqual(passwordCalls, [[{
    identifier: 'MemberA', password: '123456', termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION
  }, passwordPage._testAuthAttempts.begun[0]]]);
  assert.strictEqual(passwordPage._testAuthAttempts.begun[0].kind, 'loginPassword');
  assert.strictEqual(passwordPage.data.pendingAccount, 'acct-secret');
  assert.strictEqual(passwordPage.data.pendingAccountDisplay, '手机号用户');

  const registerCalls = [];
  const registerPage = loadLoginPage([], {
    registerAccountName(input, attempt) {
      registerCalls.push([input, attempt]);
      return Promise.resolve(sessionResult());
    }
  });
  registerPage.goRegister();
  registerPage.setData({ agreementChecked: true, regAccount: ' MemberA ', regPassword: '123456', regConfirm: '123456' });
  registerPage.register();
  await settle();
  assert.deepStrictEqual(registerCalls, [[{
    accountName: 'MemberA', password: '123456', termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION
  }, registerPage._testAuthAttempts.begun[0]]]);
  assert.strictEqual(registerPage._testAuthAttempts.begun[0].kind, 'registerAccountName');

  const wechatCalls = [];
  const wechatPage = loadLoginPage([], {
    loginWithWechat(input, attempt) {
      wechatCalls.push([input, attempt]);
      return Promise.resolve(sessionResult());
    }
  });
  wechatPage.setData({ agreementChecked: true });
  wechatPage.wechatLogin();
  await settle();
  assert.deepStrictEqual(wechatCalls, [[{
    termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION
  }, wechatPage._testAuthAttempts.begun[0]]]);
  assert.strictEqual(wechatPage._testAuthAttempts.begun[0].kind, 'loginWechat');
  assert.strictEqual(wechatPage.data.mode, 'rolePicker');
}

async function testWechatUnboundResolvedUnionAndCompletionBranches() {
  const unboundPage = loadLoginPage([], {
    loginWithWechat() {
      return Promise.resolve({ ok: false, code: 'WECHAT_NOT_BOUND', next: 'wechat_phone' });
    }
  });
  unboundPage.setData({ agreementChecked: true });
  unboundPage.wechatLogin();
  await settle();
  assert.strictEqual(unboundPage.data.mode, 'wechatPhone');
  assert.strictEqual(unboundPage.data.agreementChecked, false, 'Entering a new WeChat phone flow requires fresh consent.');
  assert(unboundPage._testAuthAttempts.cancelled.includes(unboundPage._testAuthAttempts.begun[0]));

  for (const bindWechat of [false, true]) {
    const sendCalls = [];
    const verifyCalls = [];
    const completeCalls = [];
    const page = loadLoginPage([], {
      sendSmsCode(input) {
        sendCalls.push(input);
        return Promise.resolve({ ok: true, challengeId: 'wechat-challenge' });
      },
      verifyWechatEntryPhone(input) {
        verifyCalls.push(input);
        return Promise.resolve({ ok: true, proofToken: 'proof-token' });
      },
      completeWechatEntry(input, attempt) {
        completeCalls.push([input, attempt]);
        return Promise.resolve(sessionResult());
      }
    });
    page.startCodeCountdown = () => {};
    page.enterWechatPhone();
    page.setData({
      agreementChecked: true,
      phone: '13800138000'
    });
    page.sendCode();
    await settle();
    assert.deepStrictEqual(sendCalls, [{ phone: '13800138000', purpose: 'wechat_entry' }]);
    page.setData({ code: '123456', agreementChecked: true });
    page.verifyWechatEntryPhone();
    await settle();
    assert.deepStrictEqual(verifyCalls, [{
      phone: '13800138000',
      challengeId: 'wechat-challenge',
      code: '123456',
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION
    }]);
    assert.strictEqual(page._testCalls.modals.length, 1);
    assert.strictEqual(page._testCalls.modals[0].content, '是否绑定当前微信？绑定后，后续可直接使用微信登录。');
    page._testCalls.modals[0].success({ confirm: bindWechat, cancel: !bindWechat });
    await settle();
    assert.deepStrictEqual(completeCalls, [[{
      proofToken: 'proof-token',
      bindWechat,
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION
    }, page._testAuthAttempts.begun[0]]]);
    assert.strictEqual(page._testAuthAttempts.begun[0].kind, 'completeWechatEntry');
    const bindingToasts = page._testCalls.toasts.filter((item) => item.title === '绑定成功，后续可直接使用微信登录');
    assert.strictEqual(bindingToasts.length, bindWechat ? 1 : 0);
    assert.strictEqual(page.data.mode, 'rolePicker');
  }
}

async function testWechatCompletionRechecksConsentAndIsSingleFlight() {
  const request = deferred();
  const completeCalls = [];
  const page = loadLoginPage([], {
    verifyWechatEntryPhone() { return Promise.resolve({ ok: true, proofToken: 'proof-token' }); },
    completeWechatEntry(input) { completeCalls.push(input); return request.promise; }
  });
  page.enterWechatPhone();
  page.setData({
    agreementChecked: true,
    phone: '13800138000',
    code: '123456',
    smsChallengeId: 'wechat-challenge',
    smsChallengePhone: '13800138000'
  });
  page.verifyWechatEntryPhone();
  await settle();
  page.setData({ agreementChecked: false });
  page._testCalls.modals[0].success({ confirm: true });
  assert.strictEqual(completeCalls.length, 0, 'Completion must not start after consent becomes unchecked.');

  page.setData({ agreementChecked: true });
  page.completeWechatEntry('proof-token', true);
  page.completeWechatEntry('proof-token', true);
  assert.strictEqual(completeCalls.length, 1, 'WeChat completion should be single-flight.');
  request.resolve(sessionResult());
  await settle();
}

async function testEveryAuthButtonIsSingleFlight() {
  const cases = [
    {
      name: 'sms login',
      setup(page) { page.setData({ agreementChecked: true, phone: '13800138000', code: '123456', smsChallengeId: 'c', smsChallengePhone: '13800138000' }); },
      method: 'loginWithSms', invoke(page) { page.submit(); }
    },
    {
      name: 'password login',
      setup(page) { page.switchType({ currentTarget: { dataset: { type: 'password' } } }); page.setData({ agreementChecked: true, identifier: 'memberA', password: '123456' }); },
      method: 'loginWithPassword', invoke(page) { page.submit(); }
    },
    {
      name: 'registration',
      setup(page) { page.goRegister(); page.setData({ agreementChecked: true, regAccount: 'memberA', regPassword: '123456', regConfirm: '123456' }); },
      method: 'registerAccountName', invoke(page) { page.register(); }
    },
    {
      name: 'WeChat login',
      setup(page) { page.setData({ agreementChecked: true }); },
      method: 'loginWithWechat', invoke(page) { page.wechatLogin(); }
    },
    {
      name: 'WeChat phone verification',
      setup(page) { page.enterWechatPhone(); page.setData({ agreementChecked: true, phone: '13800138000', code: '123456', smsChallengeId: 'c', smsChallengePhone: '13800138000' }); },
      method: 'verifyWechatEntryPhone', invoke(page) { page.verifyWechatEntryPhone(); }
    }
  ];

  for (const item of cases) {
    const request = deferred();
    let count = 0;
    const fakeData = {};
    fakeData[item.method] = () => { count += 1; return request.promise; };
    const page = loadLoginPage([], fakeData);
    item.setup(page);
    item.invoke(page);
    item.invoke(page);
    assert.strictEqual(count, 1, `${item.name} should be single-flight.`);
    request.resolve(item.method === 'verifyWechatEntryPhone' ? { proofToken: 'proof' } : sessionResult());
    await settle();
  }

  const sendRequest = deferred();
  let sendCount = 0;
  const sendPage = loadLoginPage([], {
    sendSmsCode() { sendCount += 1; return sendRequest.promise; }
  });
  sendPage.startCodeCountdown = () => {};
  sendPage.setData({ agreementChecked: true, phone: '13800138000' });
  sendPage.sendCode();
  sendPage.sendCode();
  assert.strictEqual(sendCount, 1, 'SMS send should be single-flight.');
  sendRequest.resolve({ challengeId: 'challenge' });
  await settle();
}

async function testPasswordFailuresDoNotEnumerateAccounts() {
  const toastTitles = [];
  for (const code of ['ACCOUNT_NOT_FOUND', 'INVALID_PASSWORD', 'INVALID_CREDENTIALS']) {
    const page = loadLoginPage([], {
      loginWithPassword() {
        return Promise.reject(Object.assign(new Error(`private:${code}`), { code }));
      }
    });
    page.switchType({ currentTarget: { dataset: { type: 'password' } } });
    page.setData({ agreementChecked: true, identifier: 'memberA', password: 'badpass' });
    page.submit();
    await settle();
    assert.strictEqual(page._testCalls.modals.length, 0);
    toastTitles.push(page._testCalls.toasts[0].title);
  }
  assert.deepStrictEqual(toastTitles, ['账号或密码错误', '账号或密码错误', '账号或密码错误']);
}

async function testEmailRecoveryHasNoIdentifierAndUsesNonEnumeratingErrors() {
  const sendCalls = [];
  const resetCalls = [];
  const page = loadLoginPage([], {
    sendEmailCode(input) { sendCalls.push(input); return Promise.resolve({ ok: true }); },
    resetPasswordByEmail(input) { resetCalls.push(input); return Promise.resolve({ ok: true }); }
  });
  page.startRecoveryCountdown = () => {};
  page.openRecovery();
  page.switchRecoveryType({ currentTarget: { dataset: { type: 'email' } } });
  page.setData({ recoveryEmail: ' member@example.com ', recoveryCode: ' 123456 ', recoveryPassword: 'newpass1', recoveryConfirm: 'newpass1' });
  page.sendRecoveryEmailCode();
  await settle();
  page.submitRecovery();
  await settle();
  assert.deepStrictEqual(sendCalls, [{ purpose: 'reset', email: 'member@example.com' }]);
  assert.deepStrictEqual(resetCalls, [{ email: 'member@example.com', code: '123456', password: 'newpass1' }]);
  assert.strictEqual(page.data.mode, 'login');
  assert.strictEqual(page.data.loginType, 'password');

  const sendFailed = loadLoginPage([], {
    sendEmailCode() {
      return Promise.reject(Object.assign(new Error('private email state'), { code: 'EMAIL_NOT_BOUND' }));
    }
  });
  sendFailed.openRecovery();
  sendFailed.switchRecoveryType({ currentTarget: { dataset: { type: 'email' } } });
  sendFailed.setData({ recoveryEmail: 'member@example.com' });
  sendFailed.sendRecoveryEmailCode();
  await settle();
  assert.strictEqual(sendFailed._testCalls.toasts[0].title, '验证码发送失败，请稍后重试');

  const titles = [];
  for (const code of ['EMAIL_NOT_BOUND', 'ACCOUNT_NOT_FOUND']) {
    const failed = loadLoginPage([], {
      resetPasswordByEmail() { return Promise.reject(Object.assign(new Error(`private:${code}`), { code })); }
    });
    failed.openRecovery();
    failed.switchRecoveryType({ currentTarget: { dataset: { type: 'email' } } });
    failed.setData({ recoveryEmail: 'member@example.com', recoveryCode: '123456', recoveryPassword: 'newpass1', recoveryConfirm: 'newpass1' });
    failed.submitRecovery();
    await settle();
    titles.push(failed._testCalls.toasts[0].title);
  }
  assert.deepStrictEqual(titles, ['无法重置密码，请确认信息后重试', '无法重置密码，请确认信息后重试']);
}

async function testRecoveryButtonsSingleFlightAndLifecycleStale() {
  for (const outcome of ['resolve', 'reject']) {
    const sendRequest = deferred();
    const submitRequest = deferred();
    let sendCount = 0;
    let submitCount = 0;
    const page = loadLoginPage([], {
      sendEmailCode() { sendCount += 1; return sendRequest.promise; },
      resetPasswordByEmail() { submitCount += 1; return submitRequest.promise; }
    });
    page.startRecoveryCountdown = () => {};
    page.openRecovery();
    page.switchRecoveryType({ currentTarget: { dataset: { type: 'email' } } });
    page.setData({ recoveryEmail: 'member@example.com', recoveryCode: '123456', recoveryPassword: 'newpass1', recoveryConfirm: 'newpass1' });
    page.sendRecoveryEmailCode();
    page.sendRecoveryEmailCode();
    assert.strictEqual(sendCount, 1);
    page.submitRecovery();
    page.submitRecovery();
    assert.strictEqual(submitCount, 1);
    page.onHide();
    const toastCount = page._testCalls.toasts.length;
    const mode = page.data.mode;
    if (outcome === 'resolve') {
      sendRequest.resolve({ ok: true });
      submitRequest.resolve({ ok: true });
    } else {
      sendRequest.reject(new Error('private send failure'));
      submitRequest.reject(new Error('private reset failure'));
    }
    await settle();
    assert.strictEqual(page._testCalls.toasts.length, toastCount);
    assert.strictEqual(page.data.mode, mode);
  }
}

async function testRecoveryLoadingOwnership() {
  const sendRequest = deferred();
  const submitRequest = deferred();
  const page = loadLoginPage([], {
    sendEmailCode() { return sendRequest.promise; },
    resetPasswordByEmail() { return submitRequest.promise; }
  });
  page.startRecoveryCountdown = () => {};
  page.openRecovery();
  page.switchRecoveryType({ currentTarget: { dataset: { type: 'email' } } });
  page.setData({ recoveryEmail: 'member@example.com', recoveryCode: '123456', recoveryPassword: 'newpass1', recoveryConfirm: 'newpass1' });
  page.sendRecoveryEmailCode();
  page.submitRecovery();
  const hidesBeforeOldResult = page._testCalls.hiddenLoading;
  sendRequest.resolve({ ok: true });
  await settle();
  assert.strictEqual(page._testCalls.hiddenLoading, hidesBeforeOldResult, 'An email-send result must not hide a newer recovery-submit loader.');
  submitRequest.resolve({ ok: true });
  await settle();
  assert(page._testCalls.hiddenLoading > hidesBeforeOldResult);
}

async function testStaleAuthCallbacksAcrossEveryTransition() {
  const transitions = [
    ['login tab switch', (page) => page.switchType({ currentTarget: { dataset: { type: 'sms' } } })],
    ['mode change', (page) => page.goRegister()],
    ['enter WeChat phone', (page) => page.enterWechatPhone()],
    ['page back', (page) => page.onBackPress()],
    ['hide', (page) => page.onHide()],
    ['unload', (page) => page.onUnload()]
  ];
  for (const [name, transition] of transitions) {
    for (const outcome of ['resolve', 'reject']) {
      const request = deferred();
      const page = loadLoginPage([], { loginWithPassword() { return request.promise; } });
      page.switchType({ currentTarget: { dataset: { type: 'password' } } });
      page.setData({ agreementChecked: true, identifier: 'memberA', password: '123456' });
      page.submit();
      const attempt = page._testAuthAttempts.begun[0];
      transition(page);
      const mode = page.data.mode;
      const toastCount = page._testCalls.toasts.length;
      const modalCount = page._testCalls.modals.length;
      const navCount = page._testCalls.switchTab.length + page._testCalls.reLaunch.length + page._testCalls.navigateTo.length;
      if (outcome === 'resolve') request.resolve(sessionResult());
      else request.reject(new Error('private stale failure'));
      await settle();
      assert(page._testAuthAttempts.cancelled.includes(attempt), `${name} should cancel the active data attempt.`);
      assert.strictEqual(page.data.mode, mode, `${name}/${outcome} must not reopen the role picker.`);
      assert.strictEqual(page._testCalls.toasts.length, toastCount, `${name}/${outcome} must not toast.`);
      assert.strictEqual(page._testCalls.modals.length, modalCount, `${name}/${outcome} must not show a modal.`);
      assert.strictEqual(page._testCalls.switchTab.length + page._testCalls.reLaunch.length + page._testCalls.navigateTo.length, navCount, `${name}/${outcome} must not navigate.`);
    }
  }
}

async function testLeavingWechatPhoneSuppressesLateResolveAndReject() {
  for (const outcome of ['resolve', 'reject']) {
    const request = deferred();
    const page = loadLoginPage([], { verifyWechatEntryPhone() { return request.promise; } });
    page.enterWechatPhone();
    page.setData({ agreementChecked: true, phone: '13800138000', code: '123456', smsChallengeId: 'c', smsChallengePhone: '13800138000' });
    page.verifyWechatEntryPhone();
    page.backToLogin();
    const toastCount = page._testCalls.toasts.length;
    if (outcome === 'resolve') request.resolve({ proofToken: 'proof' });
    else request.reject(new Error('private verify failure'));
    await settle();
    assert.strictEqual(page.data.mode, 'login');
    assert.strictEqual(page._testCalls.modals.length, 0);
    assert.strictEqual(page._testCalls.toasts.length, toastCount);
  }
}

async function testNewerAttemptOwnsLoadingAndLateCallbacks() {
  const first = deferred();
  const second = deferred();
  const requests = [first, second];
  const page = loadLoginPage([], { loginWithPassword() { return requests.shift().promise; } });
  page.switchType({ currentTarget: { dataset: { type: 'password' } } });
  page.setData({ agreementChecked: true, identifier: 'memberA', password: '123456' });
  page.submit();
  const firstAttempt = page._testAuthAttempts.begun[0];
  page.onHide();
  page.onShow();
  page.setData({ agreementChecked: true });
  page.submit();
  const secondAttempt = page._testAuthAttempts.begun[1];
  assert.notStrictEqual(firstAttempt, secondAttempt);
  const hidesBeforeLate = page._testCalls.hiddenLoading;
  first.resolve(sessionResult({ accountDisplay: 'stale' }));
  await settle();
  assert.strictEqual(page._testCalls.hiddenLoading, hidesBeforeLate, 'An old callback must not hide the newer loading state.');
  assert.notStrictEqual(page.data.pendingAccountDisplay, 'stale');
  second.resolve(sessionResult({ accountDisplay: 'fresh' }));
  await settle();
  assert.strictEqual(page.data.pendingAccountDisplay, 'fresh');
}

async function testSmsSendLateCallbacksAreSilent() {
  for (const outcome of ['resolve', 'reject']) {
    const request = deferred();
    const page = loadLoginPage([], { sendSmsCode() { return request.promise; } });
    page.startCodeCountdown = () => {};
    page.setData({ agreementChecked: true, phone: '13800138000' });
    page.sendCode();
    page.switchType({ currentTarget: { dataset: { type: 'password' } } });
    const toastCount = page._testCalls.toasts.length;
    if (outcome === 'resolve') request.resolve({ challengeId: 'stale-challenge' });
    else request.reject(new Error('private SMS failure'));
    await settle();
    assert.strictEqual(page.data.smsChallengeId, '');
    assert.strictEqual(page._testCalls.toasts.length, toastCount);
  }
}

async function testPhoneEditCancelsPendingSmsSend() {
  for (const outcome of ['resolve', 'reject']) {
    const first = deferred();
    const sendCalls = [];
    let countdownCalls = 0;
    const page = loadLoginPage([], {
      sendSmsCode(input) {
        sendCalls.push(input);
        return sendCalls.length === 1
          ? first.promise
          : Promise.resolve({ ok: true, challengeId: 'new-challenge' });
      }
    });
    page.startCodeCountdown = () => { countdownCalls += 1; };
    page.setData({
      agreementChecked: true,
      phone: '13800138000',
      counting: false,
      smsChallengeId: 'old-challenge',
      smsChallengePhone: '13800138000'
    });
    page.sendCode();
    page.onInput({ currentTarget: { dataset: { field: 'phone' } }, detail: { value: '13900139000' } });

    assert.strictEqual(page.data.phone, '13900139000');
    assert.strictEqual(page.data.sendingCode, false, 'Editing the phone should release the pending send immediately.');
    assert.strictEqual(page.data.counting, false);
    assert.strictEqual(page.data.smsChallengeId, '');
    const toastCount = page._testCalls.toasts.length;
    if (outcome === 'resolve') first.resolve({ ok: true, challengeId: 'stale-challenge' });
    else first.reject(new Error('stale send failure'));
    await settle();
    assert.strictEqual(page._testCalls.toasts.length, toastCount);
    assert.strictEqual(page.data.smsChallengeId, '');
    assert.strictEqual(countdownCalls, 0, 'A stale send must not start a countdown.');

    page.setData({ agreementChecked: true });
    page.sendCode();
    await settle();
    assert.strictEqual(sendCalls.length, 2, 'The edited phone should be able to request immediately.');
    assert.strictEqual(page.data.smsChallengeId, 'new-challenge');
    assert.strictEqual(countdownCalls, 1);
  }
}

async function testPhoneEditCancelsPendingWechatVerificationAndDecision() {
  for (const outcome of ['resolve', 'reject']) {
    const request = deferred();
    const completeCalls = [];
    const page = loadLoginPage([], {
      verifyWechatEntryPhone() { return request.promise; },
      completeWechatEntry(input) { completeCalls.push(input); return Promise.resolve(sessionResult()); }
    });
    page.enterWechatPhone();
    page.setData({
      agreementChecked: true,
      phone: '13800138000',
      code: '123456',
      smsChallengeId: 'wechat-challenge',
      smsChallengePhone: '13800138000'
    });
    page.verifyWechatEntryPhone();
    page.onInput({ currentTarget: { dataset: { field: 'phone' } }, detail: { value: '13900139000' } });
    assert.strictEqual(page.data.wechatVerifying, false);
    const toastCount = page._testCalls.toasts.length;
    if (outcome === 'resolve') request.resolve({ ok: true, proofToken: 'stale-proof' });
    else request.reject(new Error('stale verification failure'));
    await settle();
    assert.strictEqual(page._testCalls.modals.length, 0);
    assert.strictEqual(page._testCalls.toasts.length, toastCount);
    assert.strictEqual(completeCalls.length, 0);
  }

  const page = loadLoginPage([], {
    verifyWechatEntryPhone() { return Promise.resolve({ ok: true, proofToken: 'proof-before-edit' }); },
    completeWechatEntry() { throw new Error('A decision for the old phone must not complete.'); }
  });
  page.enterWechatPhone();
  page.setData({
    agreementChecked: true,
    phone: '13800138000',
    code: '123456',
    smsChallengeId: 'wechat-challenge',
    smsChallengePhone: '13800138000'
  });
  page.verifyWechatEntryPhone();
  await settle();
  assert.strictEqual(page._testCalls.modals.length, 1);
  page.onInput({ currentTarget: { dataset: { field: 'phone' } }, detail: { value: '13900139000' } });
  page._testCalls.modals[0].success({ confirm: true });
  await settle();
  assert.strictEqual(page._testAuthAttempts.begun.length, 0, 'Editing the phone must invalidate an open binding decision.');
}

async function testPhoneEditCancelsPendingSmsLogin() {
  for (const outcome of ['resolve', 'reject']) {
    const request = deferred();
    const page = loadLoginPage([], { loginWithSms() { return request.promise; } });
    page.setData({
      agreementChecked: true,
      phone: '13800138000',
      code: '123456',
      smsChallengeId: 'login-challenge',
      smsChallengePhone: '13800138000'
    });
    page.submit();
    const attempt = page._testAuthAttempts.begun[0];
    page.onInput({ currentTarget: { dataset: { field: 'phone' } }, detail: { value: '13900139000' } });
    assert(page._testAuthAttempts.cancelled.includes(attempt), 'Editing the phone must cancel the pending SMS-login attempt.');
    const toastCount = page._testCalls.toasts.length;
    if (outcome === 'resolve') request.resolve(sessionResult({ accountDisplay: 'stale login' }));
    else request.reject(new Error('stale login failure'));
    await settle();
    assert.strictEqual(page.data.mode, 'login');
    assert.strictEqual(page.data.phone, '13900139000');
    assert.strictEqual(page.data.pendingAccountDisplay, '');
    assert.strictEqual(page._testCalls.toasts.length, toastCount);
  }
}

async function testAccountDisplayServerRolesAndSessionRoleSelection() {
  const selectCalls = [];
  let legacyLoginCalls = 0;
  const page = loadLoginPage([], {
    loginWithPassword() {
      return Promise.resolve(sessionResult({
        account: 'acct_internal_secret',
        accountDisplay: '139****5678',
        roles: ['member', 'admin', 'shop', 'member']
      }));
    },
    selectRole(role) { selectCalls.push(role); return Promise.resolve({ ok: true }); },
    login() { legacyLoginCalls += 1; return Promise.resolve(); },
    getUserProfile() { return Promise.resolve({}); },
    markFirstLogin() { return Promise.resolve(); }
  });
  page.switchType({ currentTarget: { dataset: { type: 'password' } } });
  page.setData({ agreementChecked: true, identifier: 'memberA', password: '123456' });
  page.submit();
  await settle();
  assert.strictEqual(page.data.mode, 'rolePicker');
  assert.strictEqual(page.data.pendingAccount, 'acct_internal_secret');
  assert.strictEqual(page.data.pendingAccountDisplay, '139****5678');
  assert.deepStrictEqual(page.data.pendingRoles, ['member', 'shop']);
  assert.deepStrictEqual(page.data.availableRoles.map((item) => [item.key, item.enabled]), [
    ['member', true], ['coach', false], ['shop', true]
  ]);
  page.chooseRole({ currentTarget: { dataset: { role: 'shop' } } });
  page.enterSelectedRole();
  await settle();
  assert.deepStrictEqual(selectCalls, ['shop']);
  assert.strictEqual(legacyLoginCalls, 0);

  page.handleAuthenticated(sessionResult({ account: { secret: true }, accountDisplay: '手机号用户', roles: ['member'] }));
  assert.strictEqual(page.data.pendingAccount, '');
  assert.strictEqual(page.data.pendingAccountDisplay, '手机号用户');
}

async function testSuccessfulEmailResetClearsAuthV2Session() {
  const dataPath = path.join(root, 'miniprogram/services/data.js');
  const authSessionPath = path.join(root, 'miniprogram/services/auth-session.js');
  delete require.cache[require.resolve(dataPath)];
  delete require.cache[require.resolve(authSessionPath)];
  const sessionKey = 'cuetrace_auth_v2_session';
  const clientKey = 'cuetrace_auth_v2_client';
  const storage = {
    [clientKey]: 'a'.repeat(64),
    [sessionKey]: {
      schemaVersion: 2,
      sessionToken: `v2.TEST.${'A'.repeat(43)}`,
      account: 'internal',
      accountDisplay: 'Member A',
      roles: ['member'],
      currentRole: 'member'
    }
  };
  const cloudCalls = [];
  global.getApp = () => ({ globalData: { cloudReady: true, account: 'internal', accountDisplay: 'Member A', roles: ['member'], currentRole: 'member', role: 'member' } });
  global.wx = {
    getStorageSync(key) { return storage[key]; },
    setStorageSync(key, value) { storage[key] = value; },
    removeStorageSync(key) { delete storage[key]; },
    cloud: {
      callFunction(input) {
        cloudCalls.push(input);
        return Promise.resolve({ result: { ok: true } });
      }
    },
    showToast() {}
  };
  const service = require(dataPath);
  await service.resetPasswordByEmail({ email: 'member@example.com', code: '123456', password: 'newpass1' });
  assert.strictEqual(storage[sessionKey], undefined, 'A successful public reset must clear the local Auth v2 session.');
  assert.deepStrictEqual(cloudCalls[0].data.email, 'member@example.com');
  assert.strictEqual(cloudCalls[0].data.account, undefined);

  storage[sessionKey] = {
    schemaVersion: 2,
    sessionToken: `v2.TEST.${'E'.repeat(43)}`,
    account: 'internal',
    accountDisplay: 'Member A',
    roles: ['member'],
    currentRole: 'member'
  };
  await service.resetPasswordByWechat({ password: 'newpass2' });
  assert.strictEqual(storage[sessionKey], undefined, 'A successful WeChat public reset must also clear the local Auth v2 session.');

  const oldSession = {
    schemaVersion: 2,
    sessionToken: `v2.TEST.${'I'.repeat(43)}`,
    account: 'old-internal',
    accountDisplay: 'Old account',
    roles: ['member'],
    currentRole: 'member'
  };
  const newSession = {
    schemaVersion: 2,
    sessionToken: `v2.TEST.${'M'.repeat(43)}`,
    account: 'new-internal',
    accountDisplay: 'New account',
    roles: ['member'],
    currentRole: 'member'
  };
  storage[sessionKey] = oldSession;
  const lateReset = deferred();
  global.wx.cloud.callFunction = () => lateReset.promise;
  const lateResetResult = service.resetPasswordByEmail({
    email: 'member@example.com', code: '123456', password: 'newpass3'
  });
  storage[sessionKey] = newSession;
  lateReset.resolve({ result: { ok: true } });
  await lateResetResult;
  assert.deepStrictEqual(
    storage[sessionKey],
    newSession,
    'A late reset may clear only the session token captured when that reset started.'
  );

  delete storage[sessionKey];
  const noSessionReset = deferred();
  global.wx.cloud.callFunction = () => noSessionReset.promise;
  const noSessionResult = service.resetPasswordByWechat({ password: 'newpass4' });
  storage[sessionKey] = newSession;
  noSessionReset.resolve({ result: { ok: true } });
  await noSessionResult;
  assert.deepStrictEqual(
    storage[sessionKey],
    newSession,
    'A reset started without a session must not clear a session created while it is pending.'
  );

  const unclearedSession = Object.assign({}, oldSession, {
    sessionToken: `v2.TEST.${'U'.repeat(43)}`
  });
  storage[sessionKey] = unclearedSession;
  global.wx.cloud.callFunction = () => Promise.resolve({ result: { ok: true } });
  global.wx.removeStorageSync = (key) => {
    if (key !== sessionKey) delete storage[key];
  };
  await assert.rejects(
    () => service.resetPasswordByEmail({
      email: 'member@example.com', code: '123456', password: 'newpass5'
    }),
    (error) => error && error.code === 'AUTH_INTERNAL_ERROR',
    'A reset must fail closed when its captured current session cannot be cleared.'
  );
  assert.deepStrictEqual(storage[sessionKey], unclearedSession);
}

(async () => {
  await testAuthV2DefaultsAndConsentGates();
  await testSmsRequestsUseCurrentChallengeAndExactVersions();
  await testSmsSubmitRequiresChallengeForCurrentPhone();
  await testPasswordRegisterAndWechatUseExactAttempts();
  await testWechatUnboundResolvedUnionAndCompletionBranches();
  await testWechatCompletionRechecksConsentAndIsSingleFlight();
  await testEveryAuthButtonIsSingleFlight();
  await testPasswordFailuresDoNotEnumerateAccounts();
  await testEmailRecoveryHasNoIdentifierAndUsesNonEnumeratingErrors();
  await testWechatRecoveryFailuresAreUniformAndNonEnumerating();
  await testStaleRecoveryEmailSuccessIsIgnoredAfterSwitchOrExit();
  await testOnlyLatestRecoveryEmailRequestCanUpdatePage();
  await testRecoveryEmailCallbacksAreIgnoredAfterUnload();
  await testRecoverySubmissionIsSingleFlightForWechatAndEmail();
  await testRecoverySubmissionCallbacksAreIgnoredAfterLifecycleInvalidation();
  await testRecoveryButtonsSingleFlightAndLifecycleStale();
  await testRecoveryLoadingOwnership();
  await testStaleAuthCallbacksAcrossEveryTransition();
  await testLeavingWechatPhoneSuppressesLateResolveAndReject();
  await testNewerAttemptOwnsLoadingAndLateCallbacks();
  await testSmsSendLateCallbacksAreSilent();
  await testPhoneEditCancelsPendingSmsSend();
  await testPhoneEditCancelsPendingWechatVerificationAndDecision();
  await testPhoneEditCancelsPendingSmsLogin();
  await testAccountDisplayServerRolesAndSessionRoleSelection();
  await testSwitchRoleParamOpensRolePickerFromCurrentSession();
  await testSwitchRoleRefreshesMissingRuntimeSessionFromCloud();
  await testSwitchRoleStatusRequestIsSingleFlightAndLifecycleSafe();
  await testRolePickerRedirectSignalsAreConsumed();
  await testSuccessfulEmailResetClearsAuthV2Session();
  testAuthV2PresentationSource();
})();
