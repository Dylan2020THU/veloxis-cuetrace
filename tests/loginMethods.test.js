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
    showModal() {},
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

async function testBindWechatReusesPasswordAuthentication() {
  const authCalls = [];
  const page = loadLoginPage([], {
    loginWithPassword(input) {
      authCalls.push(input);
      return Promise.resolve({ account: 'memberA', roles: ['member'], currentRole: 'member' });
    }
  });
  page.setData({
    mode: 'wechatBind',
    account: 'memberA',
    password: '123456',
    agreementChecked: true,
    loginType: 'password'
  });

  page.bindWechat();
  await flushPromises();

  assert.deepStrictEqual(authCalls, [{ account: 'memberA', password: '123456' }]);
  assert.strictEqual(page.data.step, 'role');
  assert.strictEqual(page.data.pendingAccount, 'memberA');
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
  await testPasswordLoginUsesServerAuthResult();
  await testWechatLoginUsesServerAuthResult();
  await testWechatNotBoundShowsGuidance();
  await testCloudFailureStaysOnAuthStep();
  await testBindWechatReusesPasswordAuthentication();
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
