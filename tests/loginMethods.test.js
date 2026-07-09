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

function loadLoginPage(accounts, fakeData, appData) {
  const loginPath = path.join(root, 'miniprogram/pages/login/index.js');
  const dataPath = path.join(root, 'miniprogram/services/data.js');
  const mockPath = path.join(root, 'miniprogram/utils/mock.js');
  delete require.cache[require.resolve(loginPath)];
  delete require.cache[require.resolve(dataPath)];
  delete require.cache[require.resolve(mockPath)];

  let page;
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (fakeData && request === '../../services/data') return fakeData;
    return originalLoad.call(this, request, parent, isMain);
  };
  global.Page = (def) => {
    page = def;
  };
  global.Behavior = (def) => def;
  global.getApp = () => ({ globalData: Object.assign({ cloudReady: false }, appData || {}) });
  global.wx = {
    getStorageSync(key) {
      if (key === 'dc_accounts') return accounts;
      return null;
    },
    setStorageSync() {},
    showToast() {},
    showLoading() {},
    hideLoading() {},
    showModal() {},
    switchTab() {},
    reLaunch() {},
    navigateTo() {}
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

async function testPasswordLoginShowsRolePickerBeforeLogin() {
  const loginCalls = [];
  const fakeData = {
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
    { account: 'coach1', password: '123456', role: 'coach', roles: ['member', 'coach'] }
  ], fakeData);
  page.setData({
    account: 'coach1',
    password: '123456',
    agreementChecked: true,
    loginType: 'password'
  });

  page.submit();
  await flushPromises();
  await flushPromises();

  assert.strictEqual(loginCalls.length, 0, 'Account verification should not call data.login before role selection.');
  assert.strictEqual(page.data.step, 'role');
  assert.strictEqual(page.data.pendingAccount, 'coach1');
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

  assert.deepStrictEqual(loginCalls[0], ['coach', ['member', 'coach'], 'coach1']);
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
    getShopApplicationStatus() {
      return Promise.resolve({ status: 'approved' });
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

async function testApprovedShopApplicationEnablesShopRolePickerOption() {
  const fakeData = {
    getShopApplicationStatus() {
      return Promise.resolve({ status: 'approved' });
    }
  };
  const page = loadLoginPage([
    { account: 'member1', password: '123456', role: 'member', roles: ['member'] }
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
  assert(shop && shop.enabled, 'Approved shop qualification should enable the shop role on the role picker.');
  assert.deepStrictEqual(page.data.pendingRoles, ['member', 'shop']);
}

async function testSwitchRoleParamOpensRolePickerFromCurrentSession() {
  const fakeData = {
    getCurrentLoginName() {
      return 'zhx1';
    },
    getShopApplicationStatus() {
      return Promise.resolve({ status: 'none' });
    }
  };
  const page = loadLoginPage([], fakeData, {
    currentRole: 'member',
    roles: ['member', 'coach'],
    userProfile: { nickname: 'zhx1', roles: ['member', 'coach'] }
  });

  page.onLoad({ switchRole: '1' });
  await flushPromises();
  await flushPromises();

  assert.strictEqual(page.data.step, 'role');
  assert.strictEqual(page.data.pendingAccount, 'zhx1');
  assert.deepStrictEqual(page.data.pendingRoles, ['member', 'coach']);
  assert.deepStrictEqual(page.data.availableRoles.map((item) => [item.key, item.enabled]), [
    ['member', true],
    ['coach', true],
    ['shop', false]
  ]);
}

async function testSwitchRoleUsesRegisteredAccountRolesBeforeSessionRoles() {
  const fakeData = {
    getCurrentLoginName() {
      return 'zhx1';
    },
    getShopApplicationStatus() {
      return Promise.resolve({ status: 'approved' });
    }
  };
  const page = loadLoginPage([
    { account: 'zhx1', password: '123456', role: 'member', roles: ['member', 'shop'] }
  ], fakeData, {
    currentRole: 'member',
    roles: ['member', 'coach', 'shop'],
    userProfile: { nickname: 'zhx1', roles: ['member', 'coach', 'shop'] }
  });

  page.onLoad({ switchRole: '1' });
  await flushPromises();
  await flushPromises();

  assert.strictEqual(page.data.step, 'role');
  assert.strictEqual(page.data.pendingAccount, 'zhx1');
  assert.deepStrictEqual(page.data.pendingRoles, ['member', 'shop']);
  assert.deepStrictEqual(page.data.availableRoles.map((item) => [item.key, item.enabled]), [
    ['member', true],
    ['coach', false],
    ['shop', true]
  ]);
}

(async () => {
  await testPasswordLoginShowsRolePickerBeforeLogin();
  await testLockedShopRoleOpensApplicationWithoutShopLogin();
  await testApprovedShopApplicationEnablesShopRolePickerOption();
  await testSwitchRoleParamOpensRolePickerFromCurrentSession();
  await testSwitchRoleUsesRegisteredAccountRolesBeforeSessionRoles();
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
