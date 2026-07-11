const assert = require('assert');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');

function matches(record, query) {
  return Object.keys(query || {}).every((key) => record[key] === query[key]);
}

function createFakeDb(seed) {
  const updates = [];
  const adds = [];

  class Query {
    constructor(name) {
      this.name = name;
      this.query = {};
      this.limitCount = null;
    }

    where(query) {
      this.query = query || {};
      return this;
    }

    limit(count) {
      this.limitCount = Number(count) || 0;
      return this;
    }

    async get() {
      let data = (seed[this.name] || []).filter((item) => matches(item, this.query));
      if (this.limitCount) data = data.slice(0, this.limitCount);
      return { data };
    }
  }

  const db = {
    collection(name) {
      return {
        where(query) {
          return new Query(name).where(query);
        },
        doc(id) {
          return {
            async get() {
              const item = (seed[name] || []).find((record) => record._id === id);
              return { data: item || null };
            },
            async update({ data }) {
              updates.push({ collection: name, id, data });
              const item = (seed[name] || []).find((record) => record._id === id);
              if (item) Object.assign(item, data);
              return { updated: item ? 1 : 0 };
            }
          };
        },
        async add({ data }) {
          const item = Object.assign({ _id: `${name}_new` }, data);
          adds.push({ collection: name, data });
          (seed[name] || (seed[name] = [])).push(item);
          return { _id: item._id };
        }
      };
    },
    serverDate() {
      return 'SERVER_DATE';
    },
    __updates: updates,
    __adds: adds
  };
  return db;
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

function loadCloudFunction(relPath, openid, seed) {
  const fnPath = path.join(root, relPath);
  delete require.cache[require.resolve(fnPath)];
  const fakeDb = createFakeDb(seed);
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
  const fn = withWxServerSdk(fakeCloud, () => require(fnPath));
  return { fn, fakeDb };
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

function loadShopApplyPage(fakeData) {
  const pagePath = path.join(root, 'miniprogram/pages/shop/apply/index.js');
  delete require.cache[require.resolve(pagePath)];

  let page;
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (fakeData && request === '../../../services/data') return fakeData;
    return originalLoad.call(this, request, parent, isMain);
  };
  global.Page = (def) => {
    page = def;
  };
  global.Behavior = (def) => def;
  global.getApp = () => ({ globalData: { cloudReady: false } });
  global.wx = {
    showToast() {},
    showLoading() {},
    hideLoading() {},
    reLaunch() {},
    navigateTo() {}
  };

  try {
    require(pagePath);
  } finally {
    Module._load = originalLoad;
  }
  page.data = JSON.parse(JSON.stringify(page.data));
  page.setData = function setData(next) {
    this.data = Object.assign({}, this.data, next);
  };
  return page;
}

async function testRolePickerApplyDoesNotTreatLegacyShopAsApproved() {
  const calls = { reLaunch: [] };
  const fakeData = {
    getAdminStatus() {
      return Promise.resolve({ isAdmin: false });
    },
    getShopApplicationStatus() {
      return Promise.resolve({ status: 'approved', legacy: true, application: null });
    }
  };
  const page = loadShopApplyPage(fakeData);
  global.wx.reLaunch = (args) => calls.reLaunch.push(args);

  page.onLoad({ source: 'rolePicker' });
  await flushPromises();
  await flushPromises();

  assert.strictEqual(calls.reLaunch.length, 0, 'Role-picker shop application should not enter shop home from legacy mock shop data.');
  assert.strictEqual(page.data.status, 'none', 'Role-picker shop application should render the qualification form.');
  assert.strictEqual(page.data.loading, false);
}

async function testRolePickerApplyDoesNotAutoEnterShopWhenStatusApproved() {
  const calls = { reLaunch: [] };
  const fakeData = {
    getAdminStatus() {
      return Promise.resolve({ isAdmin: false });
    },
    getShopApplicationStatus() {
      return Promise.resolve({ status: 'approved', application: { _id: 'app1' } });
    }
  };
  const page = loadShopApplyPage(fakeData);
  global.wx.reLaunch = (args) => calls.reLaunch.push(args);

  page.onLoad({ source: 'rolePicker' });
  await flushPromises();
  await flushPromises();

  assert.strictEqual(calls.reLaunch.length, 0, 'Role-picker shop application should not auto-enter shop home even if openid has approved shop status.');
  assert.strictEqual(page.data.status, 'none', 'Role-picker shop application should still render the qualification form for the selected account.');
  assert.strictEqual(page.data.loading, false);
}

async function testRolePickerApplyNeverShowsAdminReviewEntry() {
  const fakeData = {
    getAdminStatus() {
      return Promise.resolve({ isAdmin: true });
    },
    getShopApplicationStatus() {
      return Promise.resolve({ status: 'pending', application: { _id: 'app1' } });
    }
  };
  const page = loadShopApplyPage(fakeData);

  page.onLoad({ source: 'rolePicker' });
  await flushPromises();
  await flushPromises();

  assert.strictEqual(page.data.isAdmin, false, 'Role-picker shop application must not expose admin review entry.');
  assert.strictEqual(page.data.status, 'pending');
}

async function testShopApprovalUpsertsRoleLedgerForBoundAccount() {
  const state = {
    admins: [{ _id: 'admin1', _openid: 'admin_openid', account: 'admin_zhx', status: 'active' }],
    shop_applications: [{ _id: 'shop-app', _openid: 'shop_openid', status: 'pending' }],
    wechat_bindings: [{
      _id: 'binding1',
      _openid: 'shop_openid',
      accountId: 'account1',
      account: 'shop_account'
    }],
    accounts: [{
      _id: 'account1',
      _openid: 'shop_openid',
      account: 'shop_account',
      status: 'active'
    }],
    users: []
  };
  const { fn } = loadCloudFunction(
    'cloudfunctions/reviewShopApplication/index.js',
    'admin_openid',
    state
  );

  const result = await fn.main({ applicationId: 'shop-app', approve: true, loginName: 'admin_zhx' });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(state.users.length, 1, 'Approval should restore the missing authoritative user ledger.');
  assert.strictEqual(state.users[0]._openid, 'shop_openid');
  assert.deepStrictEqual(state.users[0].roles, ['member', 'shop']);
  assert.strictEqual(state.users[0].role, 'member');
  assert.strictEqual(state.users[0].currentRole, 'member');
}

async function testShopApprovalPreservesExistingRolesAndCurrentRole() {
  const state = {
    admins: [{ _id: 'admin1', _openid: 'admin_openid', account: 'admin_zhx', status: 'active' }],
    shop_applications: [{ _id: 'shop-app', _openid: 'coach_openid', status: 'pending' }],
    users: [{
      _id: 'user1',
      _openid: 'coach_openid',
      roles: ['member', 'coach'],
      role: 'coach',
      currentRole: 'coach'
    }]
  };
  const { fn } = loadCloudFunction(
    'cloudfunctions/reviewShopApplication/index.js',
    'admin_openid',
    state
  );

  const result = await fn.main({ applicationId: 'shop-app', approve: true, loginName: 'admin_zhx' });

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(state.users[0].roles, ['member', 'coach', 'shop']);
  assert.strictEqual(state.users[0].role, 'coach');
  assert.strictEqual(state.users[0].currentRole, 'coach');
}

async function testShopApprovalRejectsMissingUserWithoutAccountBinding() {
  const state = {
    admins: [{ _id: 'admin1', _openid: 'admin_openid', account: 'admin_zhx', status: 'active' }],
    shop_applications: [{ _id: 'shop-app', _openid: 'bare_openid', status: 'pending' }],
    wechat_bindings: [],
    accounts: [],
    users: []
  };
  const { fn, fakeDb } = loadCloudFunction(
    'cloudfunctions/reviewShopApplication/index.js',
    'admin_openid',
    state
  );

  const result = await fn.main({ applicationId: 'shop-app', approve: true, loginName: 'admin_zhx' });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'ACCOUNT_NOT_BOUND');
  assert.strictEqual(state.shop_applications[0].status, 'pending');
  assert.strictEqual(state.users.length, 0);
  assert.strictEqual(fakeDb.__updates.length, 0);
  assert.strictEqual(fakeDb.__adds.length, 0);
}

async function testSaveShopProfileRejectsMemberWithoutWrites() {
  const state = {
    users: [{ _id: 'user1', _openid: 'member_openid', roles: ['member'], role: 'member' }],
    shops: [{ _id: 'shop1', _openid: 'member_openid', name: 'Legacy Shop' }],
    shop_applications: [{ _id: 'app1', _openid: 'member_openid', status: 'approved' }]
  };
  const { fn, fakeDb } = loadCloudFunction(
    'cloudfunctions/saveShopProfile/index.js',
    'member_openid',
    state
  );

  const result = await fn.main({ name: 'Unauthorized Shop' });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'SHOP_NOT_APPROVED');
  assert.strictEqual(state.shops[0].name, 'Legacy Shop');
  assert.deepStrictEqual(state.users[0].roles, ['member']);
  assert.strictEqual(fakeDb.__updates.length, 0);
  assert.strictEqual(fakeDb.__adds.length, 0);
}

async function testSaveShopProfileAllowsAuthorizedShopWithoutRoleWrites() {
  const state = {
    users: [{
      _id: 'user1',
      _openid: 'shop_openid',
      roles: ['member', 'shop'],
      role: 'member',
      currentRole: 'member'
    }],
    shops: [{ _id: 'shop1', _openid: 'shop_openid', name: 'Old Shop' }],
    shop_applications: []
  };
  const { fn, fakeDb } = loadCloudFunction(
    'cloudfunctions/saveShopProfile/index.js',
    'shop_openid',
    state
  );

  const result = await fn.main({ name: 'Authorized Shop' });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(state.shops[0].name, 'Authorized Shop');
  assert.deepStrictEqual(state.users[0].roles, ['member', 'shop']);
  assert.strictEqual(state.users[0].role, 'member');
  assert.strictEqual(
    fakeDb.__updates.some((item) => item.collection === 'users'),
    false,
    'Saving shop profile must not grant or switch business roles.'
  );
}

async function testSaveShopProfileCreatesProfileFromAuthoritativeShopRole() {
  const state = {
    users: [{
      _id: 'user1',
      _openid: 'shop_openid',
      roles: ['member', 'shop'],
      role: 'member',
      currentRole: 'member'
    }],
    shops: [],
    shop_applications: []
  };
  const { fn, fakeDb } = loadCloudFunction(
    'cloudfunctions/saveShopProfile/index.js',
    'shop_openid',
    state
  );

  const result = await fn.main({ name: 'New Shop' });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(state.shops.length, 1);
  assert.strictEqual(state.shops[0]._openid, 'shop_openid');
  assert.strictEqual(state.shops[0].name, 'New Shop');
  assert.strictEqual(
    fakeDb.__updates.some((item) => item.collection === 'users'),
    false,
    'Creating a profile must not write business-role authorization.'
  );
}

(async () => {
  await testRolePickerApplyDoesNotTreatLegacyShopAsApproved();
  await testRolePickerApplyDoesNotAutoEnterShopWhenStatusApproved();
  await testRolePickerApplyNeverShowsAdminReviewEntry();
  await testShopApprovalUpsertsRoleLedgerForBoundAccount();
  await testShopApprovalPreservesExistingRolesAndCurrentRole();
  await testShopApprovalRejectsMissingUserWithoutAccountBinding();
  await testSaveShopProfileRejectsMemberWithoutWrites();
  await testSaveShopProfileAllowsAuthorizedShopWithoutRoleWrites();
  await testSaveShopProfileCreatesProfileFromAuthoritativeShopRole();
})();
