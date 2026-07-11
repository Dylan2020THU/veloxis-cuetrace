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

function loadLoginPage(accounts, fakeData) {
  const loginPath = path.join(root, 'miniprogram/pages/login/index.js');
  delete require.cache[require.resolve(loginPath)];

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
  global.getApp = () => ({ globalData: { cloudReady: false } });
  global.wx = {
    getStorageSync(key) {
      if (key === 'dc_accounts') return accounts;
      return '';
    },
    setStorageSync() {},
    removeStorageSync() {},
    showToast() {},
    showLoading() {},
    hideLoading() {},
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

function loadAdminStoresPage(fakeData) {
  const pagePath = path.join(root, 'miniprogram/pages/admin/stores/index.js');
  delete require.cache[require.resolve(pagePath)];

  let page;
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../../../services/data') return fakeData;
    return originalLoad.call(this, request, parent, isMain);
  };

  global.Page = (def) => {
    page = def;
  };
  global.wx = {
    navigateTo() {},
    reLaunch() {}
  };

  try {
    require(pagePath);
  } finally {
    Module._load = originalLoad;
  }
  page.data = JSON.parse(JSON.stringify(page.data));
  page.setData = function setData(next, cb) {
    this.data = Object.assign({}, this.data, next);
    if (typeof cb === 'function') cb();
  };
  return page;
}

async function testAdminPasswordLoginBypassesRolePicker() {
  const calls = { loginAdmin: [], reLaunch: [] };
  const fakeData = {
    loginAdmin(args) {
      calls.loginAdmin.push(args);
      return Promise.resolve({ ok: true });
    }
  };
  const page = loadLoginPage([], fakeData);
  global.wx.reLaunch = (args) => calls.reLaunch.push(args);

  page.setData({
    account: 'admin_zhx',
    password: '2612694',
    agreementChecked: true,
    loginType: 'password'
  });
  page.submit();
  await flushPromises();
  await flushPromises();

  assert.deepStrictEqual(calls.loginAdmin[0], { account: 'admin_zhx', password: '2612694' });
  assert.strictEqual(page.data.step, 'auth', 'Admin login must not enter the normal role picker.');
  assert.deepStrictEqual(calls.reLaunch[0], { url: '/pages/admin/stores/index' });
}

async function testAdminMissingCloudFunctionShowsDeployMessage() {
  let toast = null;
  const err = new Error('cloud.callFunction:fail Error: errCode: -501000 | errMsg: FunctionName parameter could not be found.');
  err.errCode = -501000;
  const fakeData = {
    loginAdmin() {
      return Promise.reject(err);
    }
  };
  const page = loadLoginPage([], fakeData);
  global.wx.showToast = (args) => {
    toast = args;
  };

  page.doAdminLogin('admin_zhx', '2612694');
  await flushPromises();
  await flushPromises();

  assert(toast, 'Admin login failure should show a toast.');
  assert.strictEqual(toast.title, '请先部署 adminLogin 云函数');
}

function testStaticAdminWiring() {
  const appJsonText = read('miniprogram/app.json');
  const appJson = JSON.parse(appJsonText);
  const tabJs = read('miniprogram/custom-tab-bar/index.js');
  const dataJs = read('miniprogram/services/data.js');

  assert(appJson.pages.includes('pages/admin/stores/index'), 'app.json should register admin stores page.');
  assert(appJson.pages.includes('pages/admin/coaches/index'), 'app.json should register admin coaches page.');
  assert(appJson.pages.includes('pages/admin/members/index'), 'app.json should register admin members page.');
  assert(appJson.pages.includes('pages/admin/profile/index'), 'app.json should register admin profile page.');
  assert(appJson.tabBar.list.length <= 10, 'WeChat app.json tabBar.list cannot contain more than 10 items.');
  assert(
    !appJson.tabBar.list.some((item) => item.pagePath.indexOf('pages/admin/') === 0),
    'Admin pages should use in-page nav instead of consuming app.json tabBar slots.'
  );
  assert(
    tabJs.includes('admin: [') &&
      tabJs.includes("text: '门店'") &&
      tabJs.includes("text: '教练'") &&
      tabJs.includes("text: '会员'"),
    'Custom tab bar should have admin tabs.'
  );
  assert(dataJs.includes('function loginAdmin({ account, password })'), 'Data service should expose loginAdmin.');
  assert(dataJs.includes("mock.setRole('admin')"), 'Admin login should persist admin role for custom tab rendering.');
}

function testAdminDataServiceExports() {
  const dataJs = read('miniprogram/services/data.js');
  assert(dataJs.includes('getAdminStores'), 'Data service should expose getAdminStores.');
  assert(dataJs.includes('getAdminCoaches'), 'Data service should expose getAdminCoaches.');
  assert(dataJs.includes('getAdminMembers'), 'Data service should expose getAdminMembers.');
  assert(dataJs.includes("callCloud('getAdminStores', { loginName })"), 'getAdminStores should pass admin loginName.');
  assert(dataJs.includes("callCloud('getAdminCoaches', { loginName })"), 'getAdminCoaches should pass admin loginName.');
  assert(dataJs.includes("callCloud('getAdminMembers', { loginName })"), 'getAdminMembers should pass admin loginName.');
}

function withWxServerSdk(fakeCloud, fn) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'wx-server-sdk') return fakeCloud;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return fn();
  } finally {
    Module._load = originalLoad;
  }
}

function loadAdminLogin(openid, adminSeed) {
  const admins = (adminSeed || []).map((item) => Object.assign({}, item));
  const fakeDb = {
    serverDate() {
      return 'SERVER_DATE';
    },
    collection(name) {
      assert.strictEqual(name, 'admins');
      return {
        where(query) {
          return {
            async get() {
              return {
                data: admins.filter((item) => (
                  Object.keys(query || {}).every((key) => item[key] === query[key])
                ))
              };
            }
          };
        },
        doc(id) {
          return {
            async update({ data }) {
              const item = admins.find((record) => record._id === id);
              if (item) Object.assign(item, data);
            }
          };
        },
        async add({ data }) {
          admins.push(Object.assign({ _id: `admin_${admins.length + 1}` }, data));
        }
      };
    }
  };
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: 'DYNAMIC_CURRENT_ENV',
    init() {},
    database() {
      return fakeDb;
    },
    getWXContext() {
      return { OPENID: openid };
    }
  };
  const fnPath = path.join(root, 'cloudfunctions/adminLogin/index.js');
  delete require.cache[require.resolve(fnPath)];
  return {
    adminLogin: withWxServerSdk(fakeCloud, () => require(fnPath)),
    admins
  };
}

async function testAdminLoginRejectsAccountBoundToOtherWechat() {
  const password = require('../miniprogram/utils/adminAuth').ADMIN_ACCOUNTS[0].password;
  const { adminLogin, admins } = loadAdminLogin('other_wechat', [{
    _id: 'admin_existing',
    _openid: 'bound_wechat',
    account: 'admin_zhx',
    status: 'active'
  }]);

  const result = await adminLogin.main({ account: 'admin_zhx', password });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'ACCOUNT_ALREADY_BOUND');
  assert.strictEqual(admins.length, 1);
}

async function testAdminLoginRejectsWechatBoundToOtherAccount() {
  const password = require('../miniprogram/utils/adminAuth').ADMIN_ACCOUNTS[0].password;
  const { adminLogin, admins } = loadAdminLogin('bound_wechat', [{
    _id: 'admin_existing',
    _openid: 'bound_wechat',
    account: 'legacy_admin',
    status: 'active'
  }]);

  const result = await adminLogin.main({ account: 'admin_zhx', password });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'WECHAT_ALREADY_BOUND');
  assert.strictEqual(admins.length, 1);
}

async function testAdminStoresCloudRequiresAdminLoginName() {
  const fakeDb = {
    serverDate() {
      return 'SERVER_DATE';
    },
    collection(name) {
      const api = {
        where() {
          return api;
        },
        orderBy() {
          return api;
        },
        limit() {
          return api;
        },
        async get() {
          if (name === 'admins') return { data: [{ _openid: 'admin_openid', account: 'admin_zhx', status: 'active' }] };
          if (name === 'stores') return { data: [{ _id: 'store1', _openid: 'shop_openid', name: 'A厅', checkinEnabled: true }] };
          if (name === 'shop_applications') return { data: [] };
          if (name === 'shops') return { data: [] };
          if (name === 'users') return { data: [] };
          return { data: [] };
        }
      };
      return api;
    }
  };
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: 'DYNAMIC_CURRENT_ENV',
    init() {},
    database() {
      return fakeDb;
    },
    getWXContext() {
      return { OPENID: 'admin_openid' };
    }
  };
  const fnPath = path.join(root, 'cloudfunctions/getAdminStores/index.js');
  delete require.cache[require.resolve(fnPath)];
  const getAdminStores = withWxServerSdk(fakeCloud, () => require(fnPath));

  const denied = await getAdminStores.main({ loginName: 'zhx1' });
  assert.strictEqual(denied.ok, false);
  assert.strictEqual(denied.code, 'FORBIDDEN');

  const allowed = await getAdminStores.main({ loginName: 'admin_zhx' });
  assert.strictEqual(allowed.ok, true);
  assert.strictEqual(allowed.summary.totalStores, 2);
  assert.strictEqual(allowed.summary.checkinEnabledStores, 2);
  assert(allowed.stores.some((item) => item.storeId === 'store1'), 'Admin stores should include real stores from collection.');
  assert(allowed.stores.some((item) => item.storeId === 'seed_store_dachuan_flag'), 'Admin stores should also include the official seed store.');
}

async function testAdminStoresCloudIncludesOfficialSeedStore() {
  const fakeDb = {
    collection(name) {
      const api = {
        where() {
          return api;
        },
        limit() {
          return api;
        },
        async get() {
          if (name === 'admins') return { data: [{ _openid: 'admin_openid', account: 'admin_zhx', status: 'active' }] };
          return { data: [] };
        }
      };
      return api;
    }
  };
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: 'DYNAMIC_CURRENT_ENV',
    init() {},
    database() {
      return fakeDb;
    },
    getWXContext() {
      return { OPENID: 'admin_openid' };
    }
  };
  const fnPath = path.join(root, 'cloudfunctions/getAdminStores/index.js');
  delete require.cache[require.resolve(fnPath)];
  const getAdminStores = withWxServerSdk(fakeCloud, () => require(fnPath));

  const res = await getAdminStores.main({ loginName: 'admin_zhx' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.summary.totalStores, 1, 'Admin stores should include the same official seed store shown in bookable tables.');
  assert.strictEqual(res.stores[0].storeId, 'seed_store_dachuan_flag');
  assert(res.stores[0].storeName, 'Official seed store should have a display name.');
  assert.strictEqual(res.stores[0].applicationStatus, 'approved');
}

async function testAdminStoresPageKeepsBackendPendingApplicationCount() {
  const page = loadAdminStoresPage({
    getAdminStores() {
      return Promise.resolve({
        summary: {
          totalStores: 1,
          approvedStores: 1,
          pendingApplications: 1,
          checkinEnabledStores: 1
        },
        stores: [
          {
            storeId: 'store1',
            storeName: 'A厅',
            ownerName: '店主',
            applicationStatus: 'approved',
            checkinEnabled: true
          }
        ]
      });
    }
  });

  page.load();
  await flushPromises();
  await flushPromises();

  assert.strictEqual(page.data.summary.pendingApplications, 1);
}

function testAdminPagesExistAndRenderRequiredSections() {
  const storesJs = read('miniprogram/pages/admin/stores/index.js');
  const storesWxml = read('miniprogram/pages/admin/stores/index.wxml');
  const coachesJs = read('miniprogram/pages/admin/coaches/index.js');
  const coachesWxml = read('miniprogram/pages/admin/coaches/index.wxml');
  const membersJs = read('miniprogram/pages/admin/members/index.js');
  const membersWxml = read('miniprogram/pages/admin/members/index.wxml');
  const profileJs = read('miniprogram/pages/admin/profile/index.js');
  const profileWxml = read('miniprogram/pages/admin/profile/index.wxml');
  const commonWxss = read('miniprogram/pages/admin/common.wxss');

  assert(
    storesJs.includes('data.getAdminStores()') &&
      storesWxml.includes('数据总览') &&
      storesWxml.includes('门店明细'),
    'Stores admin page should load and render overview/list.'
  );
  assert(storesWxml.includes('店主资质审核'), 'Stores admin page should expose shop qualification review entry.');
  assert(!storesWxml.includes('logout-btn') && !storesWxml.includes('bindtap="logout"'), 'Stores page should not show top logout button.');
  assert(
    coachesJs.includes('data.getAdminCoaches()') &&
      coachesWxml.includes('数据总览') &&
      coachesWxml.includes('教练明细'),
    'Coaches admin page should load and render overview/list.'
  );
  assert(!coachesWxml.includes('logout-btn') && !coachesWxml.includes('bindtap="logout"'), 'Coaches page should not show top logout button.');
  assert(
    membersJs.includes('data.getAdminMembers()') &&
      membersWxml.includes('数据总览') &&
      membersWxml.includes('会员明细'),
    'Members admin page should load and render overview/list.'
  );
  assert(!membersWxml.includes('logout-btn') && !membersWxml.includes('bindtap="logout"'), 'Members page should not show top logout button.');
  assert(profileJs.includes('data.getAdminProfile()') && profileWxml.includes('管理员账号') && profileWxml.includes('退出登录'), 'Profile page should show admin account info and logout.');
  assert(
    storesWxml.includes('我的') &&
      coachesWxml.includes('我的') &&
      membersWxml.includes('我的') &&
      profileWxml.includes('admin-bottom-nav'),
    'Admin bottom nav should include profile tab on every admin page.'
  );
  assert(
    storesWxml.includes('admin-tab-icon') &&
      coachesWxml.includes('admin-tab-icon') &&
      membersWxml.includes('admin-tab-icon') &&
      profileWxml.includes('admin-tab-icon'),
    'Admin bottom nav should render icons.'
  );
  assert(
    storesJs.includes('goAdminTab') &&
      coachesJs.includes('goAdminTab') &&
      membersJs.includes('goAdminTab') &&
      profileJs.includes('goAdminTab'),
    'Admin pages should navigate through in-page bottom nav.'
  );
  assert(/\.overview-value\s*\{[\s\S]*?font-size:\s*4[4-9]rpx/.test(commonWxss), 'Overview numbers should be visually larger.');
  assert(commonWxss.includes('.icon-store') && commonWxss.includes('.icon-profile'), 'Admin nav icons should be defined in common styles.');
}

(async () => {
  await testAdminPasswordLoginBypassesRolePicker();
  await testAdminMissingCloudFunctionShowsDeployMessage();
  await testAdminLoginRejectsAccountBoundToOtherWechat();
  await testAdminLoginRejectsWechatBoundToOtherAccount();
  testStaticAdminWiring();
  testAdminDataServiceExports();
  await testAdminStoresCloudRequiresAdminLoginName();
  await testAdminStoresCloudIncludesOfficialSeedStore();
  await testAdminStoresPageKeepsBackendPendingApplicationCount();
  testAdminPagesExistAndRenderRequiredSections();
})();
