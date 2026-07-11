const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
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

function loadLoginPage(accounts, fakeData) {
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
  global.getApp = () => ({ globalData: { cloudReady: false } });
  global.wx = {
    getStorageSync(key) {
      if (key === 'dc_accounts') return accounts;
      return null;
    },
    setStorageSync() {},
    showToast() {},
    showLoading() {},
    hideLoading() {},
    switchTab() {},
    reLaunch() {}
  };

  try {
    require(loginPath);
  } finally {
    Module._load = originalLoad;
  }
  page.data = Object.assign({}, page.data);
  page.setData = function setData(next) {
    this.data = Object.assign({}, this.data, next);
  };
  return page;
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function testLocalDefaultUserIsNotAdmin() {
  const dataPath = path.join(root, 'miniprogram/services/data.js');
  const mockPath = path.join(root, 'miniprogram/utils/mock.js');
  delete require.cache[require.resolve(dataPath)];
  delete require.cache[require.resolve(mockPath)];

  global.getApp = () => ({ globalData: { cloudReady: false, openid: 'local-demo-user' } });
  global.wx = {
    getStorageSync(key) {
      if (key === 'dc_admins') return [];
      if (key === 'dc_role') return 'member';
      return null;
    },
    setStorageSync() {}
  };

  const data = require(dataPath);
  const res = await data.getAdminStatus();
  assert.strictEqual(res.isAdmin, false, 'Newly registered/default local users must not see 店主资质审核.');
}

async function testLocalAdminAccountIsAdmin() {
  const dataPath = path.join(root, 'miniprogram/services/data.js');
  const mockPath = path.join(root, 'miniprogram/utils/mock.js');
  delete require.cache[require.resolve(dataPath)];
  delete require.cache[require.resolve(mockPath)];

  global.getApp = () => ({ globalData: { cloudReady: false, openid: 'local-demo-user' } });
  global.wx = {
    getStorageSync(key) {
      if (key === 'dc_admins') return [];
      if (key === 'dc_role') return 'member';
      if (key === 'dc_login_default_nickname_member') return 'admin_zhx';
      return null;
    },
    setStorageSync() {}
  };

  const data = require(dataPath);
  const res = await data.getAdminStatus();
  assert.strictEqual(res.isAdmin, true, 'The built-in admin account should see 店主资质审核.');
}

async function testLocalAdminOpenidDoesNotMakeOtherAccountsAdmin() {
  const dataPath = path.join(root, 'miniprogram/services/data.js');
  const mockPath = path.join(root, 'miniprogram/utils/mock.js');
  delete require.cache[require.resolve(dataPath)];
  delete require.cache[require.resolve(mockPath)];

  global.getApp = () => ({ globalData: { cloudReady: false, openid: 'local-demo-user', role: 'member' } });
  global.wx = {
    getStorageSync(key) {
      if (key === 'dc_admins') return [{ _openid: 'local-demo-user', account: 'admin_zhx', status: 'active' }];
      if (key === 'dc_role') return 'member';
      if (key === 'dc_login_default_nickname_member') return 'zhx1';
      return null;
    },
    setStorageSync() {}
  };

  const data = require(dataPath);
  const res = await data.getAdminStatus();
  assert.strictEqual(res.isAdmin, false, 'A normal account must not inherit admin status from the same local openid.');
}

async function testCloudLoginDoesNotSeedAdminByAccount() {
  const adds = [];
  const updates = [];
  const openid = 'admin_openid';
  const bindingId = crypto.createHash('sha256').update(`wechat:${openid}`).digest('hex');
  const state = {
    users: [{ _id: 'user_doc', _openid: openid, role: 'member', roles: ['member'] }],
    wechat_bindings: [{
      _id: bindingId,
      _openid: openid,
      accountId: crypto.createHash('sha256').update('account:member1').digest('hex'),
      account: 'member1'
    }],
    admins: []
  };
  const fakeDb = {
    command: {
      remove() {
        return { remove: true };
      }
    },
    serverDate() {
      return 'SERVER_DATE';
    },
    collection(name) {
      return {
        where(query) {
          const api = {
            limit() {
              return api;
            },
            async get() {
              return {
                data: (state[name] || []).filter((item) => (
                  Object.keys(query || {}).every((key) => item[key] === query[key])
                ))
              };
            },
            async update({ data }) {
              updates.push({ name, query, data });
            }
          };
          return api;
        },
        doc(id) {
          return {
            async get() {
              const item = (state[name] || []).find((record) => record._id === id);
              return { data: item || null };
            },
            async update({ data }) {
              updates.push({ name, id, data });
              const item = (state[name] || []).find((record) => record._id === id);
              if (item) Object.assign(item, data);
            }
          };
        },
        async add({ data }) {
          adds.push({ name, data });
          (state[name] || (state[name] = [])).push(Object.assign({ _id: `${name}_new` }, data));
          return { _id: `${name}_new` };
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

  const fnPath = path.join(root, 'cloudfunctions/login/index.js');
  delete require.cache[require.resolve(fnPath)];
  const login = withWxServerSdk(fakeCloud, () => require(fnPath));
  const result = await login.main({ role: 'member', roles: ['member', 'coach'], loginName: 'admin_zhx' });

  assert.strictEqual(result.role, 'member');
  assert.strictEqual(adds.some((item) => item.name === 'admins'), false, 'Normal login must not create admin records.');
  assert.deepStrictEqual(state.admins, []);
}

async function testCloudAdminStatusRequiresCurrentAdminAccount() {
  const fakeDb = {
    collection(name) {
      return {
        where() {
          return {
            async get() {
              if (name === 'admins') {
                return { data: [{ _openid: 'shared_openid', account: 'admin_zhx', status: 'active' }] };
              }
              return { data: [] };
            }
          };
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
      return { OPENID: 'shared_openid' };
    }
  };

  const fnPath = path.join(root, 'cloudfunctions/getAdminStatus/index.js');
  delete require.cache[require.resolve(fnPath)];
  const getAdminStatus = withWxServerSdk(fakeCloud, () => require(fnPath));

  const normal = await getAdminStatus.main({ loginName: 'zhx1' });
  assert.strictEqual(normal.isAdmin, false, 'Cloud admin status must not be granted to a non-admin account on the same openid.');

  const admin = await getAdminStatus.main({ loginName: 'admin_zhx' });
  assert.strictEqual(admin.isAdmin, true, 'Cloud admin status should be granted only to the configured admin account.');
}

async function testCloudReviewListRequiresCurrentAdminAccount() {
  const fakeDb = {
    collection(name) {
      return {
        where() {
          return {
            orderBy() {
              return this;
            },
            limit() {
              return this;
            },
            async get() {
              if (name === 'admins') {
                return { data: [{ _openid: 'shared_openid', account: 'admin_zhx', status: 'active' }] };
              }
              if (name === 'shop_applications') {
                return { data: [{ _id: 'app1', status: 'pending' }] };
              }
              return { data: [] };
            }
          };
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
      return { OPENID: 'shared_openid' };
    }
  };

  const fnPath = path.join(root, 'cloudfunctions/getPendingShopApplications/index.js');
  delete require.cache[require.resolve(fnPath)];
  const getPendingShopApplications = withWxServerSdk(fakeCloud, () => require(fnPath));

  const normal = await getPendingShopApplications.main({ loginName: 'zhx1' });
  assert.strictEqual(normal.ok, false, 'Non-admin account should not list shop review applications on the same openid.');
  assert.strictEqual(normal.code, 'FORBIDDEN');

  const admin = await getPendingShopApplications.main({ loginName: 'admin_zhx' });
  assert.strictEqual(admin.ok, true, 'Configured admin account should list shop review applications.');
}

async function testCloudReviewApprovalAddsShopRoleToUserRoles() {
  const updates = [];
  const fakeDb = {
    serverDate() {
      return 'SERVER_DATE';
    },
    collection(name) {
      return {
        where(query) {
          return {
            async get() {
              if (name === 'admins') {
                return { data: [{ _openid: 'admin_openid', account: 'admin_zhx', status: 'active' }] };
              }
              if (name === 'users') {
                return { data: [{ _id: 'user_doc', _openid: query._openid, role: 'member', roles: ['member'] }] };
              }
              return { data: [] };
            }
          };
        },
        doc(id) {
          return {
            async get() {
              if (name === 'shop_applications') {
                return { data: { _id: id, _openid: 'shop_openid', status: 'pending' } };
              }
              return { data: null };
            },
            async update({ data }) {
              updates.push({ name, id, data });
            }
          };
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
      return { OPENID: 'admin_openid' };
    }
  };

  const fnPath = path.join(root, 'cloudfunctions/reviewShopApplication/index.js');
  delete require.cache[require.resolve(fnPath)];
  const reviewShopApplication = withWxServerSdk(fakeCloud, () => require(fnPath));
  const res = await reviewShopApplication.main({ loginName: 'admin_zhx', applicationId: 'app1', approve: true });

  assert.strictEqual(res.ok, true);
  const userUpdate = updates.find((item) => item.name === 'users' && item.id === 'user_doc');
  assert(userUpdate, 'Approving a shop application should update the applicant user document.');
  assert.deepStrictEqual(userUpdate.data.roles, ['member', 'shop']);
  assert.strictEqual(userUpdate.data.role, 'shop');
}

function testAdminCloudCallsIncludeCurrentLoginName() {
  const dataJs = read('miniprogram/services/data.js');
  assert(
    /callCloud\('getPendingShopApplications',\s*\{\s*status,\s*loginName\s*\}\)/.test(dataJs),
    'getPendingShopApplications should pass current loginName to cloud authorization.'
  );
  assert(
    /callCloud\('reviewShopApplication',\s*\{\s*applicationId,\s*approve,\s*reason,\s*loginName\s*\}\)/.test(dataJs),
    'reviewShopApplication should pass current loginName to cloud authorization.'
  );
}

function testSettingsEntryIsAdminOnly() {
  const wxml = read('miniprogram/pages/settings/index.wxml');
  assert(
    /wx:if="\{\{isAdmin\}\}"[\s\S]*店主资质审核/.test(wxml),
    '店主资质审核 entry should be guarded by isAdmin.'
  );
}

function testAdminLoginUsesDedicatedPortalPath() {
  const fakeData = {
    loginAdmin() {
      return Promise.resolve({ ok: true });
    }
  };
  const page = loadLoginPage([
    { role: 'member', roles: ['member'], account: 'admin_zhx', password: '2612694' }
  ], fakeData);

  assert.strictEqual(typeof page.doAdminLogin, 'function', 'Admin login should use a dedicated admin entry path.');
}

async function testAdminShopLoginSkipsQualificationGate() {
  const calls = {
    login: [],
    getShopApplicationStatus: 0,
    switchTab: [],
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
      calls.getShopApplicationStatus += 1;
      return Promise.resolve({ status: 'none' });
    },
    markFirstLogin() {
      return Promise.resolve();
    }
  };
  const page = loadLoginPage([], fakeData);
  global.wx.switchTab = (args) => calls.switchTab.push(args);
  global.wx.reLaunch = (args) => calls.reLaunch.push(args);

  page.doShopLogin('admin_zhx', ['member', 'coach', 'shop']);
  await flushPromises();
  await flushPromises();

  assert.deepStrictEqual(calls.login[0], ['shop', ['member', 'coach', 'shop'], 'admin_zhx']);
  assert.strictEqual(calls.getShopApplicationStatus, 0, 'Admin shop login should not check shop qualification status.');
  assert.deepStrictEqual(calls.switchTab[0], { url: '/pages/shop/hall-status/index' });
  assert.strictEqual(calls.reLaunch.length, 0, 'Admin shop login should not redirect to shop apply page.');
}

(async () => {
  await testLocalDefaultUserIsNotAdmin();
  await testLocalAdminAccountIsAdmin();
  await testLocalAdminOpenidDoesNotMakeOtherAccountsAdmin();
  await testCloudLoginDoesNotSeedAdminByAccount();
  await testCloudAdminStatusRequiresCurrentAdminAccount();
  await testCloudReviewListRequiresCurrentAdminAccount();
  await testCloudReviewApprovalAddsShopRoleToUserRoles();
  testAdminCloudCallsIncludeCurrentLoginName();
  testSettingsEntryIsAdminOnly();
  testAdminLoginUsesDedicatedPortalPath();
  await testAdminShopLoginSkipsQualificationGate();
})();
