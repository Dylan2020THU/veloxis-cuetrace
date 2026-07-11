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

function adminRecordId(openid) {
  return crypto.createHash('sha256').update(`admin-openid:${openid}`).digest('hex');
}

function loadAdminCloudFunction(relPath, openid, fakeDb) {
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
  const fnPath = path.join(root, relPath);
  delete require.cache[require.resolve(fnPath)];
  return withWxServerSdk(fakeCloud, () => require(fnPath));
}

function createAdminAuthorizationDb(adminRecord, adminReadError) {
  const state = {
    adminDocIds: [],
    adminScans: 0,
    businessReads: 0
  };
  function query(name) {
    const api = {
      where() { return api; },
      orderBy() { return api; },
      limit() { return api; },
      async get() {
        if (name === 'admins') {
          state.adminScans += 1;
          if (adminReadError) throw adminReadError;
          return { data: adminRecord ? [adminRecord] : [] };
        }
        state.businessReads += 1;
        return { data: [] };
      }
    };
    return api;
  }
  return {
    __state: state,
    collection(name) {
      const api = query(name);
      api.doc = (id) => ({
        async get() {
          if (name === 'admins') {
            state.adminDocIds.push(id);
            if (adminReadError) throw adminReadError;
            return { data: adminRecord || null };
          }
          state.businessReads += 1;
          return { data: null };
        }
      });
      return api;
    }
  };
}

const ADMIN_AUTH_FUNCTIONS = [
  ['status', 'cloudfunctions/getAdminStatus/index.js'],
  ['stores', 'cloudfunctions/getAdminStores/index.js'],
  ['coaches', 'cloudfunctions/getAdminCoaches/index.js'],
  ['members', 'cloudfunctions/getAdminMembers/index.js'],
  ['pending', 'cloudfunctions/getPendingShopApplications/index.js'],
  ['review', 'cloudfunctions/reviewShopApplication/index.js']
];

async function testAdminFunctionsReadOnlyDeterministicAdminDocument() {
  const openid = 'deterministic_admin';
  const expectedId = adminRecordId(openid);
  const failures = [];
  for (const [name, relPath] of ADMIN_AUTH_FUNCTIONS) {
    const db = createAdminAuthorizationDb({
      _id: expectedId,
      _openid: openid,
      account: 'admin_zhx',
      status: 'active'
    });
    const fn = loadAdminCloudFunction(relPath, openid, db);
    try {
      const result = await fn.main({ loginName: 'admin_zhx' });
      if (name === 'status') assert.strictEqual(result.isAdmin, true);
      else if (name === 'review') assert.notStrictEqual(result.code, 'FORBIDDEN');
      else assert.strictEqual(result.ok, true);
      assert.deepStrictEqual(db.__state.adminDocIds, [expectedId]);
      assert.strictEqual(db.__state.adminScans, 0, `${name} must not scan admins.`);
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
    }
  }
  assert.deepStrictEqual(failures, [], failures.join('\n'));
}

async function testMissingAdminDocumentNeverBootstrapsAuthorization() {
  const openid = 'ovvdY3VKYCo7_jTzdpgGbuf26-tA';
  const failures = [];
  for (const [name, relPath] of ADMIN_AUTH_FUNCTIONS) {
    const db = createAdminAuthorizationDb(null);
    const fn = loadAdminCloudFunction(relPath, openid, db);
    try {
      const result = await fn.main({ loginName: 'admin_zhx' });
      if (name === 'status') assert.strictEqual(result.isAdmin, false);
      else {
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.code, 'FORBIDDEN');
      }
      assert.strictEqual(db.__state.businessReads, 0, `${name} must not read business data when unauthorized.`);
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
    }
  }
  assert.deepStrictEqual(failures, [], failures.join('\n'));
}

async function testAdminDocumentReadErrorsAreNeverAuthorized() {
  const failures = [];
  for (const [name, relPath] of ADMIN_AUTH_FUNCTIONS) {
    const db = createAdminAuthorizationDb(null, new Error(`admin read failed: ${name}`));
    const fn = loadAdminCloudFunction(relPath, 'admin_read_error', db);
    try {
      await assert.rejects(
        () => fn.main({ loginName: 'admin_zhx' }),
        new RegExp(`admin read failed: ${name}`)
      );
      assert.strictEqual(db.__state.businessReads, 0, `${name} must stop before business access.`);
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
    }
  }
  assert.deepStrictEqual(failures, [], failures.join('\n'));
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

async function testLocalAdminAccountStillFailsClosed() {
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
  assert.strictEqual(res.isAdmin, false, 'A public administrator account name must not authorize offline access.');
}

async function testOfflineAdminOperationsNeverUseMockData() {
  const dataPath = path.join(root, 'miniprogram/services/data.js');
  const mockPath = path.join(root, 'miniprogram/utils/mock.js');
  delete require.cache[require.resolve(dataPath)];
  delete require.cache[require.resolve(mockPath)];

  global.getApp = () => ({ globalData: { cloudReady: false, role: 'member' } });
  global.wx = {
    getStorageSync(key) {
      if (key === 'dc_admin_login_name') return 'admin_zhx';
      return null;
    },
    setStorageSync() {},
    removeStorageSync() {}
  };
  const data = require(dataPath);
  const operations = [
    () => data.getPendingShopApplications(),
    () => data.reviewShopApplication({ applicationId: 'app1', approve: true }),
    () => data.getAdminStores(),
    () => data.getAdminCoaches(),
    () => data.getAdminMembers()
  ];
  const failures = [];
  for (const operation of operations) {
    try {
      await assert.rejects(operation, (error) => error && error.code === 'CLOUD_NOT_READY');
    } catch (error) {
      failures.push(error.message);
    }
  }
  assert.deepStrictEqual(failures, [], failures.join('\n'));
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
    users: [{ _id: bindingId, _openid: openid, role: 'member', roles: ['member'] }],
    wechat_bindings: [{
      _id: bindingId,
      _openid: openid,
      accountId: crypto.createHash('sha256').update('account:member1').digest('hex'),
      account: 'member1'
    }],
    accounts: [{
      _id: crypto.createHash('sha256').update('account:member1').digest('hex'),
      _openid: openid,
      account: 'member1',
      status: 'active'
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
  const id = adminRecordId('shared_openid');
  const fakeDb = {
    collection(name) {
      return {
        doc(docId) {
          return {
            async get() {
              if (name === 'admins' && docId === id) {
                return { data: { _id: id, _openid: 'shared_openid', account: 'admin_zhx', status: 'active' } };
              }
              return { data: null };
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
  const id = adminRecordId('shared_openid');
  const fakeDb = {
    collection(name) {
      const api = {
        doc(docId) {
          return {
            async get() {
              if (name === 'admins' && docId === id) {
                return { data: { _id: id, _openid: 'shared_openid', account: 'admin_zhx', status: 'active' } };
              }
              return { data: null };
            }
          };
        },
        where() {
          return {
            orderBy() {
              return this;
            },
            limit() {
              return this;
            },
            async get() {
              if (name === 'shop_applications') {
                return { data: [{ _id: 'app1', status: 'pending' }] };
              }
              return { data: [] };
            }
          };
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
  const userDocId = crypto.createHash('sha256').update('wechat:shop_openid').digest('hex');
  const adminDocId = adminRecordId('admin_openid');
  const documents = {
    admins: {
      [adminDocId]: { _id: adminDocId, _openid: 'admin_openid', account: 'admin_zhx', status: 'active' }
    },
    shop_applications: {
      app1: { _id: 'app1', _openid: 'shop_openid', status: 'pending' }
    },
    wechat_bindings: {
      [userDocId]: {
        _id: userDocId,
        _openid: 'shop_openid',
        accountId: 'account1',
        account: 'shop_account'
      }
    },
    accounts: {
      account1: {
        _id: 'account1',
        _openid: 'shop_openid',
        account: 'shop_account',
        status: 'active'
      }
    },
    users: {
      [userDocId]: {
        _id: userDocId,
        _openid: 'shop_openid',
        role: 'member',
        currentRole: 'member',
        roles: ['member']
      }
    }
  };

  function collection(name) {
    const records = documents[name] || (documents[name] = {});
    return {
      where(query) {
        return {
          async get() {
            return {
              data: Object.values(records).filter((item) => (
                Object.keys(query || {}).every((key) => item[key] === query[key])
              ))
            };
          }
        };
      },
      doc(id) {
        return {
          async get() {
            return { data: records[id] || null };
          },
          async update({ data }) {
            if (!records[id]) throw new Error(`document ${id} does not exist`);
            records[id] = Object.assign({}, records[id], data);
            updates.push({ name, id, data });
          },
          async set({ data }) {
            records[id] = Object.assign({}, data, { _id: id });
            updates.push({ name, id, data });
          }
        };
      }
    };
  }

  const fakeDb = {
    serverDate() {
      return 'SERVER_DATE';
    },
    collection,
    runTransaction(callback) {
      return callback({ collection });
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
  const userUpdate = updates.find((item) => item.name === 'users' && item.id === userDocId);
  assert(userUpdate, 'Approving a shop application should update the applicant user document.');
  assert.deepStrictEqual(userUpdate.data.roles, ['member', 'shop']);
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(userUpdate.data, 'role'),
    false,
    'Approving shop access should not force-switch the user\'s current role.'
  );
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
    { role: 'member', roles: ['member'], account: 'admin_zhx', password: 'unit-test-admin-password' }
  ], fakeData);

  assert.strictEqual(typeof page.doAdminLogin, 'function', 'Admin login should use a dedicated admin entry path.');
}

async function testAdminAccountStringCannotBypassShopQualificationGate() {
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

  assert.deepStrictEqual(calls.login[0], ['shop'], 'Shop login should send only the requested role to server authorization.');
  assert.strictEqual(calls.getShopApplicationStatus, 1, 'A client-provided admin account must not skip shop qualification status.');
  assert.strictEqual(calls.switchTab.length, 0, 'An unapproved shop must not enter the shop home page.');
  assert.deepStrictEqual(calls.reLaunch[0], { url: '/pages/shop/apply/index' });
}

(async () => {
  await testLocalDefaultUserIsNotAdmin();
  await testLocalAdminAccountStillFailsClosed();
  await testOfflineAdminOperationsNeverUseMockData();
  await testLocalAdminOpenidDoesNotMakeOtherAccountsAdmin();
  await testCloudLoginDoesNotSeedAdminByAccount();
  await testAdminFunctionsReadOnlyDeterministicAdminDocument();
  await testMissingAdminDocumentNeverBootstrapsAuthorization();
  await testAdminDocumentReadErrorsAreNeverAuthorized();
  await testCloudAdminStatusRequiresCurrentAdminAccount();
  await testCloudReviewListRequiresCurrentAdminAccount();
  await testCloudReviewApprovalAddsShopRoleToUserRoles();
  testAdminCloudCallsIncludeCurrentLoginName();
  testSettingsEntryIsAdminOnly();
  testAdminLoginUsesDedicatedPortalPath();
  await testAdminAccountStringCannotBypassShopQualificationGate();
})();
