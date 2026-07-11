const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');

function matches(record, query) {
  return Object.keys(query || {}).every((key) => record[key] === query[key]);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function bindingId(openid) {
  return crypto.createHash('sha256').update(`wechat:${openid}`).digest('hex');
}

function accountId(account) {
  return crypto.createHash('sha256').update(`account:${String(account).toLowerCase()}`).digest('hex');
}

function boundIdentity(openid, account, roles) {
  const userId = bindingId(openid);
  const boundAccountId = accountId(account);
  return {
    wechat_bindings: [{
      _id: userId,
      _openid: openid,
      accountId: boundAccountId,
      account
    }],
    accounts: [{
      _id: boundAccountId,
      _openid: openid,
      account,
      status: 'active'
    }],
    users: [{
      _id: userId,
      _openid: openid,
      roles,
      role: 'member',
      currentRole: 'member'
    }]
  };
}

function createFakeDb(seed) {
  const updates = [];
  const adds = [];
  const controls = { failTransactionWriteAt: 0, transactionWriteCount: 0 };

  function makeFacade(targetState, stagedUpdates, stagedAdds, transactionMode) {
    function maybeFailWrite() {
      if (!transactionMode) return;
      controls.transactionWriteCount += 1;
      if (controls.transactionWriteCount === controls.failTransactionWriteAt) {
        throw new Error('simulated transaction write failure');
      }
    }

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
        let data = (targetState[this.name] || []).filter((item) => matches(item, this.query));
        if (this.limitCount) data = data.slice(0, this.limitCount);
        return { data: clone(data) };
      }
    }

    return {
      collection(name) {
        const documents = targetState[name] || (targetState[name] = []);
        return {
          where(query) {
            return new Query(name).where(query);
          },
          doc(id) {
            return {
              async get() {
                const item = documents.find((record) => record._id === id);
                return { data: item ? clone(item) : null };
              },
              async set({ data }) {
                maybeFailWrite();
                const item = Object.assign({}, clone(data), { _id: id });
                const index = documents.findIndex((record) => record._id === id);
                if (index === -1) documents.push(item);
                else documents[index] = item;
                stagedAdds.push({ collection: name, id, data: clone(data) });
                return { _id: id };
              },
              async update({ data }) {
                maybeFailWrite();
                const index = documents.findIndex((record) => record._id === id);
                if (index === -1) throw new Error(`document ${id} does not exist`);
                documents[index] = Object.assign({}, documents[index], clone(data), { _id: id });
                stagedUpdates.push({ collection: name, id, data: clone(data) });
                return { updated: 1 };
              }
            };
          },
          async add({ data }) {
            maybeFailWrite();
            const id = data._id || `${name}_new`;
            const item = Object.assign({}, clone(data), { _id: id });
            documents.push(item);
            stagedAdds.push({ collection: name, id, data: clone(data) });
            return { _id: id };
          }
        };
      },
      serverDate() {
        return 'SERVER_DATE';
      },
      async runTransaction(callback) {
        if (transactionMode) throw new Error('nested transactions are unsupported');
        const workingState = clone(targetState);
        const transactionUpdates = [];
        const transactionAdds = [];
        controls.transactionWriteCount = 0;
        const result = await callback(
          makeFacade(workingState, transactionUpdates, transactionAdds, true)
        );
        Object.keys(workingState).forEach((name) => {
          if (Array.isArray(workingState[name])) targetState[name] = workingState[name];
        });
        updates.push(...transactionUpdates);
        adds.push(...transactionAdds);
        return result;
      }
    };
  }

  const db = makeFacade(seed, updates, adds, false);
  db.__updates = updates;
  db.__adds = adds;
  Object.defineProperty(db, 'failTransactionWriteAt', {
    get() {
      return controls.failTransactionWriteAt;
    },
    set(value) {
      controls.failTransactionWriteAt = Number(value) || 0;
    }
  });
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
  const shopUserId = bindingId('shop_openid');
  const state = {
    admins: [{ _id: 'admin1', _openid: 'admin_openid', account: 'admin_zhx', status: 'active' }],
    shop_applications: [{ _id: 'shop-app', _openid: 'shop_openid', status: 'pending' }],
    wechat_bindings: [{
      _id: shopUserId,
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
  assert.strictEqual(state.users[0]._id, shopUserId);
  assert.strictEqual(state.users[0]._openid, 'shop_openid');
  assert.deepStrictEqual(state.users[0].roles, ['member', 'shop']);
  assert.strictEqual(state.users[0].role, 'member');
  assert.strictEqual(state.users[0].currentRole, 'member');
}

async function testShopApprovalPreservesExistingRolesAndCurrentRole() {
  const coachUserId = bindingId('coach_openid');
  const state = {
    admins: [{ _id: 'admin1', _openid: 'admin_openid', account: 'admin_zhx', status: 'active' }],
    shop_applications: [{ _id: 'shop-app', _openid: 'coach_openid', status: 'pending' }],
    wechat_bindings: [{
      _id: coachUserId,
      _openid: 'coach_openid',
      accountId: 'account1',
      account: 'coach_account'
    }],
    accounts: [{
      _id: 'account1',
      _openid: 'coach_openid',
      account: 'coach_account',
      status: 'active'
    }],
    users: [{
      _id: coachUserId,
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

async function testShopApprovalRejectsInvalidIdentityRelationsWithoutWrites() {
  const applicantOpenid = 'shop_openid';
  const applicantId = bindingId(applicantOpenid);
  const variants = [
    {
      name: 'missing binding',
      wechat_bindings: [],
      accounts: []
    },
    {
      name: 'disabled account',
      wechat_bindings: [{
        _id: applicantId,
        _openid: applicantOpenid,
        accountId: 'account1',
        account: 'shop_account'
      }],
      accounts: [{
        _id: 'account1',
        _openid: applicantOpenid,
        account: 'shop_account',
        status: 'disabled'
      }]
    },
    {
      name: 'mismatched account owner',
      wechat_bindings: [{
        _id: applicantId,
        _openid: applicantOpenid,
        accountId: 'account1',
        account: 'shop_account'
      }],
      accounts: [{
        _id: 'account1',
        _openid: 'another_openid',
        account: 'shop_account',
        status: 'active'
      }]
    },
    {
      name: 'mismatched user owner',
      wechat_bindings: [{
        _id: applicantId,
        _openid: applicantOpenid,
        accountId: 'account1',
        account: 'shop_account'
      }],
      accounts: [{
        _id: 'account1',
        _openid: applicantOpenid,
        account: 'shop_account',
        status: 'active'
      }],
      userOpenid: 'another_openid'
    }
  ];
  const observed = [];

  for (const variant of variants) {
    const state = {
      admins: [{ _id: 'admin1', _openid: 'admin_openid', account: 'admin_zhx', status: 'active' }],
      shop_applications: [{ _id: 'shop-app', _openid: applicantOpenid, status: 'pending' }],
      wechat_bindings: variant.wechat_bindings,
      accounts: variant.accounts,
      users: [{
        _id: applicantId,
        _openid: variant.userOpenid || applicantOpenid,
        roles: ['member'],
        role: 'member',
        currentRole: 'member'
      }]
    };
    const { fn, fakeDb } = loadCloudFunction(
      'cloudfunctions/reviewShopApplication/index.js',
      'admin_openid',
      state
    );
    const result = await fn.main({
      applicationId: 'shop-app',
      approve: true,
      loginName: 'admin_zhx'
    });
    observed.push({
      name: variant.name,
      ok: result.ok,
      code: result.code,
      applicationStatus: state.shop_applications[0].status,
      roles: state.users[0].roles,
      writes: fakeDb.__updates.length + fakeDb.__adds.length
    });
  }

  assert.deepStrictEqual(observed, variants.map((variant) => ({
    name: variant.name,
    ok: false,
    code: 'ACCOUNT_NOT_BOUND',
    applicationStatus: 'pending',
    roles: ['member'],
    writes: 0
  })));
}

async function testShopApprovalDoesNotPromoteLegacyRoleField() {
  const applicantOpenid = 'legacy_openid';
  const applicantId = bindingId(applicantOpenid);
  const state = {
    admins: [{ _id: 'admin1', _openid: 'admin_openid', account: 'admin_zhx', status: 'active' }],
    shop_applications: [{ _id: 'shop-app', _openid: applicantOpenid, status: 'pending' }],
    wechat_bindings: [{
      _id: applicantId,
      _openid: applicantOpenid,
      accountId: 'account1',
      account: 'legacy_account'
    }],
    accounts: [{
      _id: 'account1',
      _openid: applicantOpenid,
      account: 'legacy_account',
      status: 'active'
    }],
    users: [{
      _id: applicantId,
      _openid: applicantOpenid,
      roles: ['member'],
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
  assert.deepStrictEqual(state.users[0].roles, ['member', 'shop']);
  assert.strictEqual(state.users[0].role, 'coach');
  assert.strictEqual(state.users[0].currentRole, 'coach');
}

async function testShopApprovalRollsBackApplicationWhenUserWriteFails() {
  const applicantOpenid = 'shop_openid';
  const applicantId = bindingId(applicantOpenid);
  const state = {
    admins: [{ _id: 'admin1', _openid: 'admin_openid', account: 'admin_zhx', status: 'active' }],
    shop_applications: [{ _id: 'shop-app', _openid: applicantOpenid, status: 'pending' }],
    wechat_bindings: [{
      _id: applicantId,
      _openid: applicantOpenid,
      accountId: 'account1',
      account: 'shop_account'
    }],
    accounts: [{
      _id: 'account1',
      _openid: applicantOpenid,
      account: 'shop_account',
      status: 'active'
    }],
    users: [{
      _id: applicantId,
      _openid: applicantOpenid,
      roles: ['member'],
      role: 'member',
      currentRole: 'member'
    }]
  };
  const { fn, fakeDb } = loadCloudFunction(
    'cloudfunctions/reviewShopApplication/index.js',
    'admin_openid',
    state
  );
  fakeDb.failTransactionWriteAt = 2;
  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await fn.main({ applicationId: 'shop-app', approve: true, loginName: 'admin_zhx' });
  } finally {
    console.error = originalConsoleError;
  }

  assert.strictEqual(result.ok, false);
  assert.strictEqual(state.shop_applications[0].status, 'pending');
  assert.deepStrictEqual(state.users[0].roles, ['member']);
  assert.strictEqual(fakeDb.__updates.length, 0);
  assert.strictEqual(fakeDb.__adds.length, 0);
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

async function testSaveShopStoreRequiresBoundShopRoleWithoutWrites() {
  const variants = [
    {
      name: 'unbound caller',
      expectedCode: 'ACCOUNT_NOT_BOUND',
      state: { wechat_bindings: [], accounts: [], users: [], stores: [] }
    },
    {
      name: 'bound member',
      expectedCode: 'SHOP_ROLE_REQUIRED',
      state: Object.assign(boundIdentity('member_openid', 'member1', ['member']), { stores: [] })
    }
  ];

  for (const variant of variants) {
    const openid = variant.name === 'unbound caller' ? 'unbound_openid' : 'member_openid';
    const { fn, fakeDb } = loadCloudFunction(
      'cloudfunctions/saveShopStore/index.js',
      openid,
      variant.state
    );

    const result = await fn.main({ store: { name: 'Forged Store' } });

    assert.strictEqual(result.ok, false, variant.name);
    assert.strictEqual(result.code, variant.expectedCode, variant.name);
    assert.strictEqual(fakeDb.__updates.length, 0, variant.name);
    assert.strictEqual(fakeDb.__adds.length, 0, variant.name);
    assert.strictEqual(variant.state.stores.length, 0, variant.name);
  }
}

async function testSaveShopStoreNeverFallsBackToAddForForeignOrMissingStore() {
  const variants = [
    {
      name: 'foreign store',
      stores: [{ _id: 'store1', _openid: 'another_shop', name: 'Foreign Store' }]
    },
    {
      name: 'missing store',
      stores: []
    }
  ];

  for (const variant of variants) {
    const state = Object.assign(boundIdentity('shop_openid', 'shop1', ['member', 'shop']), {
      stores: variant.stores
    });
    const before = clone(state.stores);
    const { fn, fakeDb } = loadCloudFunction(
      'cloudfunctions/saveShopStore/index.js',
      'shop_openid',
      state
    );

    const result = await fn.main({ store: { _id: 'store1', name: 'Hijacked Store' } });

    assert.strictEqual(result.ok, false, variant.name);
    assert.strictEqual(result.code, 'STORE_NOT_OWNED', variant.name);
    assert.deepStrictEqual(state.stores, before, variant.name);
    assert.strictEqual(fakeDb.__updates.length, 0, variant.name);
    assert.strictEqual(fakeDb.__adds.length, 0, `${variant.name} must not fall back to add.`);
  }
}

(async () => {
  await testRolePickerApplyDoesNotTreatLegacyShopAsApproved();
  await testRolePickerApplyDoesNotAutoEnterShopWhenStatusApproved();
  await testRolePickerApplyNeverShowsAdminReviewEntry();
  await testShopApprovalUpsertsRoleLedgerForBoundAccount();
  await testShopApprovalPreservesExistingRolesAndCurrentRole();
  await testShopApprovalRejectsInvalidIdentityRelationsWithoutWrites();
  await testShopApprovalDoesNotPromoteLegacyRoleField();
  await testShopApprovalRollsBackApplicationWhenUserWriteFails();
  await testShopApprovalRejectsMissingUserWithoutAccountBinding();
  await testSaveShopProfileRejectsMemberWithoutWrites();
  await testSaveShopProfileAllowsAuthorizedShopWithoutRoleWrites();
  await testSaveShopProfileCreatesProfileFromAuthoritativeShopRole();
  await testSaveShopStoreRequiresBoundShopRoleWithoutWrites();
  await testSaveShopStoreNeverFallsBackToAddForForeignOrMissingStore();
})();
