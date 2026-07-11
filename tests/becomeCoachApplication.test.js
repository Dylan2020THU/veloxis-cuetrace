const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');

function bindingFor(openid, account) {
  return {
    _id: crypto.createHash('sha256').update(`wechat:${openid}`).digest('hex'),
    _openid: openid,
    accountId: crypto.createHash('sha256').update(`account:${String(account).toLowerCase()}`).digest('hex'),
    account
  };
}

function accountFor(openid, account) {
  return {
    _id: crypto.createHash('sha256').update(`account:${String(account).toLowerCase()}`).digest('hex'),
    _openid: openid,
    account,
    status: 'active'
  };
}

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function valueMatches(actual, expected) {
  if (expected && expected.__op === 'in') return expected.values.indexOf(actual) !== -1;
  return actual === expected;
}

function matches(record, query) {
  return Object.keys(query || {}).every((key) => valueMatches(record[key], query[key]));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createFakeDb(seed) {
  const updates = [];
  const adds = [];
  const sets = [];
  const controls = { failTransactionWriteAt: 0, transactionWriteCount: 0 };

  function makeFacade(targetState, stagedUpdates, stagedAdds, stagedSets, transactionMode) {
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
      }

      where(query) {
        this.query = query || {};
        return this;
      }

      async get() {
        return {
          data: clone((targetState[this.name] || []).filter((item) => matches(item, this.query)))
        };
      }
    }

    return {
      command: {
        in(values) {
          return { __op: 'in', values: values || [] };
        }
      },
      collection(name) {
        const documents = targetState[name] || (targetState[name] = []);
        return {
          where(query) {
            return new Query(name).where(query);
          },
          doc(id) {
            return {
              async get() {
                const hit = documents.find((item) => item._id === id);
                return { data: hit ? clone(hit) : null };
              },
              async update({ data }) {
                maybeFailWrite();
                const index = documents.findIndex((item) => item._id === id);
                if (index === -1) throw new Error(`document ${id} does not exist`);
                documents[index] = Object.assign({}, documents[index], clone(data), { _id: id });
                stagedUpdates.push({ collection: name, id, data: clone(data) });
                return { updated: 1 };
              },
              async set({ data }) {
                maybeFailWrite();
                const item = Object.assign({}, clone(data), { _id: id });
                const index = documents.findIndex((record) => record._id === id);
                if (index === -1) documents.push(item);
                else documents[index] = item;
                stagedSets.push({ collection: name, id, data: clone(data) });
                return { _id: id };
              }
            };
          },
          async add({ data }) {
            maybeFailWrite();
            const id = data._id || `${name}_new`;
            documents.push(Object.assign({}, clone(data), { _id: id }));
            stagedAdds.push({ collection: name, data: clone(data) });
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
        const transactionSets = [];
        controls.transactionWriteCount = 0;
        const result = await callback(
          makeFacade(workingState, transactionUpdates, transactionAdds, transactionSets, true)
        );
        Object.keys(workingState).forEach((name) => {
          if (Array.isArray(workingState[name])) targetState[name] = workingState[name];
        });
        stagedUpdates.push(...transactionUpdates);
        stagedAdds.push(...transactionAdds);
        stagedSets.push(...transactionSets);
        return result;
      }
    };
  }

  const db = makeFacade(seed, updates, adds, sets, false);
  db.__updates = updates;
  db.__adds = adds;
  db.__sets = sets;
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

function linkId(storeId, coachOpenid) {
  return crypto.createHash('sha256').update(`shop-coach:${storeId}:${coachOpenid}`).digest('hex');
}

function makeReviewState() {
  const reviewer = bindingFor('shop_openid', 'shop1');
  const applicant = bindingFor('member_openid', 'member1');
  return {
    coach_shop_applications: [{
      _id: 'app1',
      _openid: 'member_openid',
      status: 'pending',
      shopOpenid: 'shop_openid',
      coachOpenid: 'member_openid',
      storeId: 'store1',
      storeName: 'Forged Store Name',
      coachNickname: 'Coach A',
      coachAvatar: 'cloud://coach-a',
      intro: 'Apply as coach'
    }],
    stores: [{ _id: 'store1', _openid: 'shop_openid', name: 'Canonical Store' }],
    wechat_bindings: [reviewer, applicant],
    accounts: [accountFor('shop_openid', 'shop1'), accountFor('member_openid', 'member1')],
    users: [
      {
        _id: reviewer._id,
        _openid: 'shop_openid',
        roles: ['member', 'shop'],
        role: 'member',
        currentRole: 'member'
      },
      {
        _id: applicant._id,
        _openid: 'member_openid',
        roles: ['member'],
        role: 'shop',
        currentRole: 'shop'
      }
    ],
    shop_coach_links: [],
    coaches: [{
      _id: applicant._id,
      _openid: 'member_openid',
      nickname: 'Existing Applicant',
      certificates: ['certificate-a']
    }]
  };
}

function testStaticWiring() {
  const appJson = read('miniprogram/app.json');
  const settingsJs = read('miniprogram/pages/settings/index.js');
  const settingsWxml = read('miniprogram/pages/settings/index.wxml');
  const dataJs = read('miniprogram/services/data.js');
  const shopCoachesWxml = read('miniprogram/pages/shop/coaches/index.wxml');
  const applyBindingCloud = read('cloudfunctions/applyCoachShopBinding/index.js');
  const saveCoachProfileCloud = read('cloudfunctions/saveCoachProfile/index.js');

  assert(appJson.includes('pages/coach/apply/index'), 'app.json should register the become coach application page.');
  assert(settingsJs.includes('canApplyCoach') && settingsJs.includes('goBecomeCoach'), 'Settings page should gate and navigate to become coach.');
  assert(settingsWxml.includes('wx:if="{{canApplyCoach}}"') && settingsWxml.includes('成为教练'), 'Settings page should show 成为教练 only when allowed.');
  assert(!settingsJs.includes("profile && profile.role === 'coach'"), 'Settings should not hide 成为教练 based only on profile.role.');
  assert(settingsJs.includes('refreshCoachApplyEntry') && settingsJs.includes('data.getMyCoachShopBindingStatus()'), 'Settings should refresh the entry from coach binding status.');
  assert(dataJs.includes('intro') && dataJs.includes('applyCoachShopBinding({ storeId, coachNickname, coachAvatar, intro })'), 'Data service should submit short intro with binding application.');
  assert(shopCoachesWxml.includes('item.intro') && shopCoachesWxml.includes('申请说明'), 'Shop coach review card should show application intro.');
  assert(applyBindingCloud.includes('intro'), 'applyCoachShopBinding cloud function should persist intro.');
  assert(!saveCoachProfileCloud.includes("role: 'coach'"), 'saveCoachProfile must not directly open coach identity.');
}

function testApplyPageExists() {
  const applyJs = read('miniprogram/pages/coach/apply/index.js');
  const applyWxml = read('miniprogram/pages/coach/apply/index.wxml');
  const applyWxss = read('miniprogram/pages/coach/apply/index.wxss');
  const applyJson = read('miniprogram/pages/coach/apply/index.json');

  assert(applyJson.includes('成为教练'), 'Apply page title should be 成为教练.');
  assert(applyJs.includes('loadStatus') && applyJs.includes('submitApplication'), 'Apply page should load status and submit application.');
  assert(applyJs.includes('data.getMyCoachShopBindingStatus()'), 'Apply page should read current binding status.');
  assert(applyJs.includes('data.applyCoachShopBinding({'), 'Apply page should submit through applyCoachShopBinding.');
  assert(!applyJs.includes("data.login('coach'"), 'Apply page must not login as coach directly.');
  assert(applyWxml.includes('教练昵称') && applyWxml.includes('申请球厅') && applyWxml.includes('申请说明'), 'Apply page should render required fields.');
  assert(/\.submit-btn/.test(applyWxss), 'Apply page should style the submit button.');
}

async function testApprovalAddsCoachRoleWithoutDroppingMember() {
  const state = makeReviewState();
  const applicantId = bindingFor('member_openid', 'member1')._id;
  const { fn, fakeDb } = loadCloudFunction(
    'cloudfunctions/reviewCoachBindingApplication/index.js',
    'shop_openid',
    state
  );

  const res = await fn.main({ applicationId: 'app1', approve: true });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.status, 'approved');
  assert.strictEqual(state.coach_shop_applications[0].status, 'approved');

  const userUpdate = fakeDb.__updates.find((item) => item.collection === 'users' && item.id === applicantId);
  assert(userUpdate, 'Approval should update the applicant user document.');
  assert.deepStrictEqual(userUpdate.data.roles, ['member', 'coach']);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(userUpdate.data, 'role'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(userUpdate.data, 'currentRole'), false);
  assert.deepStrictEqual(state.users.find((item) => item._id === applicantId).roles, ['member', 'coach']);

  assert.strictEqual(state.shop_coach_links.length, 1);
  assert.strictEqual(state.shop_coach_links[0]._id, linkId('store1', 'member_openid'));
  assert.strictEqual(state.shop_coach_links[0].shopOpenid, 'shop_openid');
  assert.strictEqual(state.shop_coach_links[0].coachOpenid, 'member_openid');
  assert.strictEqual(state.shop_coach_links[0].storeName, 'Canonical Store');

  assert.strictEqual(state.coaches.length, 1);
  assert.strictEqual(state.coaches[0]._id, applicantId);
  assert.strictEqual(state.coaches[0]._openid, 'member_openid');
  assert.strictEqual(state.coaches[0].hallId, 'store1');
  assert.strictEqual(state.coaches[0].hallName, 'Canonical Store');
  assert.strictEqual(state.coaches[0].bindingStatus, 'approved');
  assert.deepStrictEqual(state.coaches[0].certificates, ['certificate-a']);
}

async function testReviewRejectsIdentityOwnershipSelfAndStateAttacksWithoutWrites() {
  const variants = [
    {
      name: 'reviewer without shop role',
      expectedCode: 'SHOP_ROLE_REQUIRED',
      mutate(state) {
        state.users[0].roles = ['member'];
        state.users[0].role = 'shop';
      }
    },
    {
      name: 'reviewer does not own store',
      expectedCode: 'STORE_NOT_OWNED',
      mutate(state) {
        state.stores[0]._openid = 'foreign_shop';
        state.coach_shop_applications[0].shopOpenid = 'foreign_shop';
      }
    },
    {
      name: 'self review',
      expectedCode: 'SELF_REVIEW_NOT_ALLOWED',
      mutate(state) {
        state.coach_shop_applications[0]._openid = 'shop_openid';
        state.coach_shop_applications[0].coachOpenid = 'shop_openid';
      }
    },
    {
      name: 'applicant identity is corrupt',
      expectedCode: 'ACCOUNT_NOT_BOUND',
      mutate(state) {
        const applicantAccountId = bindingFor('member_openid', 'member1').accountId;
        state.accounts = state.accounts.filter((item) => item._id !== applicantAccountId);
      }
    },
    {
      name: 'application identity is corrupt',
      expectedCode: 'ACCOUNT_NOT_BOUND',
      mutate(state) {
        state.coach_shop_applications[0]._openid = 'another_openid';
      }
    },
    {
      name: 'application is no longer pending',
      expectedCode: 'APPLICATION_NOT_PENDING',
      mutate(state) {
        state.coach_shop_applications[0].status = 'approved';
      }
    }
  ];

  for (const variant of variants) {
    const state = makeReviewState();
    variant.mutate(state);
    const before = clone(state);
    const { fn, fakeDb } = loadCloudFunction(
      'cloudfunctions/reviewCoachBindingApplication/index.js',
      'shop_openid',
      state
    );

    const result = await fn.main({ applicationId: 'app1', approve: true });

    assert.strictEqual(result.ok, false, variant.name);
    assert.strictEqual(result.code, variant.expectedCode, variant.name);
    assert.deepStrictEqual(state, before, variant.name);
    assert.strictEqual(fakeDb.__updates.length, 0, variant.name);
    assert.strictEqual(fakeDb.__sets.length, 0, variant.name);
    assert.strictEqual(fakeDb.__adds.length, 0, variant.name);
  }
}

async function testApprovalRollsBackEveryWriteWhenAnyTransactionalWriteFails() {
  for (let failAt = 1; failAt <= 4; failAt += 1) {
    const state = makeReviewState();
    const before = clone(state);
    const { fn, fakeDb } = loadCloudFunction(
      'cloudfunctions/reviewCoachBindingApplication/index.js',
      'shop_openid',
      state
    );
    fakeDb.failTransactionWriteAt = failAt;

    const result = await fn.main({ applicationId: 'app1', approve: true });

    assert.strictEqual(result.ok, false, `transaction write ${failAt}`);
    assert.strictEqual(result.code, 'REVIEW_FAILED', `transaction write ${failAt}`);
    assert.deepStrictEqual(state, before, `transaction write ${failAt} must roll back all collections`);
    assert.strictEqual(fakeDb.__updates.length, 0, `transaction write ${failAt}`);
    assert.strictEqual(fakeDb.__sets.length, 0, `transaction write ${failAt}`);
    assert.strictEqual(fakeDb.__adds.length, 0, `transaction write ${failAt}`);
  }
}

async function testSaveCoachProfileRejectsUnboundOpenidWithoutWrites() {
  const { fn, fakeDb } = loadCloudFunction('cloudfunctions/saveCoachProfile/index.js', 'unbound_openid', {
    wechat_bindings: [],
    accounts: [],
    users: [],
    coaches: []
  });

  const result = await fn.main({ nickname: 'Unbound Coach', avatar: 'cloud://unbound' });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'ACCOUNT_NOT_BOUND');
  assert.strictEqual(fakeDb.__updates.length, 0);
  assert.strictEqual(fakeDb.__adds.length, 0);
  assert.strictEqual(fakeDb.__sets.length, 0);
}

async function testBoundMemberCanSaveDeterministicCoachProfileWithoutRoleGrant() {
  const openid = 'member_openid';
  const binding = bindingFor(openid, 'member1');
  const state = {
    wechat_bindings: [binding],
    accounts: [accountFor(openid, 'member1')],
    users: [{
      _id: binding._id,
      _openid: openid,
      roles: ['member'],
      role: 'member',
      currentRole: 'member',
      nickname: '',
      avatar: ''
    }],
    coaches: []
  };
  const { fn, fakeDb } = loadCloudFunction('cloudfunctions/saveCoachProfile/index.js', openid, state);

  const result = await fn.main({
    nickname: 'Applicant A',
    avatar: 'cloud://applicant',
    intro: '申请成为教练'
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(fakeDb.__adds.length, 0, 'Saving an application profile must not create random user or coach documents.');
  assert.strictEqual(fakeDb.__sets.length, 1);
  assert.strictEqual(fakeDb.__sets[0].collection, 'coaches');
  assert.strictEqual(fakeDb.__sets[0].id, binding._id);
  assert.strictEqual(fakeDb.__sets[0].data._openid, openid);

  const userUpdate = fakeDb.__updates.find((item) => item.collection === 'users');
  assert(userUpdate, 'The existing deterministic user should receive nickname/avatar updates.');
  assert.strictEqual(userUpdate.id, binding._id);
  assert.deepStrictEqual(userUpdate.data, {
    nickname: 'Applicant A',
    avatar: 'cloud://applicant',
    updatedAt: 'SERVER_DATE'
  });
  assert.deepStrictEqual(state.users[0].roles, ['member']);
  assert.strictEqual(state.users[0].role, 'member');
  assert.strictEqual(state.users[0].currentRole, 'member');
}

async function testAuthorizedCoachCanBeAddedToShop() {
  const { fn, fakeDb } = loadCloudFunction('cloudfunctions/addShopCoach/index.js', 'shop_openid', {
    users: [
      {
        _id: 'shop-user',
        _openid: 'shop_openid',
        roles: ['member', 'shop'],
        role: 'member',
        currentRole: 'member'
      },
      {
        _id: 'coach-user',
        _openid: 'coach_openid',
        roles: ['member', 'coach'],
        role: 'member',
        currentRole: 'member'
      }
    ],
    stores: [{ _id: 'store1', _openid: 'shop_openid', name: 'Canonical Store' }],
    shop_coach_links: []
  });

  const result = await fn.main({
    coachOpenid: 'coach_openid',
    storeId: 'store1',
    storeName: 'Store One'
  });

  assert.strictEqual(result.ok, true);
  const linkAdd = fakeDb.__adds.find((item) => item.collection === 'shop_coach_links');
  assert(linkAdd, 'An approved coach should be linked to the shop.');
  assert.strictEqual(linkAdd.data.coachOpenid, 'coach_openid');
  assert.strictEqual(linkAdd.data.shopOpenid, 'shop_openid');
  assert.strictEqual(linkAdd.data.storeName, 'Canonical Store');
  assert.strictEqual(linkAdd.data.status, 'active');
}

async function testReactivatedCoachLinkUsesCanonicalStoreName() {
  const { fn, fakeDb } = loadCloudFunction('cloudfunctions/addShopCoach/index.js', 'shop_openid', {
    users: [
      {
        _id: 'shop-user',
        _openid: 'shop_openid',
        roles: ['member', 'shop'],
        role: 'member',
        currentRole: 'member'
      },
      {
        _id: 'coach-user',
        _openid: 'coach_openid',
        roles: ['member', 'coach'],
        role: 'member',
        currentRole: 'member'
      }
    ],
    stores: [{ _id: 'store1', _openid: 'shop_openid', name: 'Canonical Store' }],
    shop_coach_links: [{
      _id: 'link1',
      shopOpenid: 'shop_openid',
      coachOpenid: 'coach_openid',
      storeId: 'store1',
      storeName: 'Old Store',
      status: 'inactive'
    }]
  });

  const result = await fn.main({
    coachOpenid: 'coach_openid',
    storeId: 'store1',
    storeName: 'Forged Store'
  });

  assert.strictEqual(result.ok, true);
  const linkUpdate = fakeDb.__updates.find(
    (item) => item.collection === 'shop_coach_links' && item.id === 'link1'
  );
  assert(linkUpdate, 'An inactive authorized link should be reactivated.');
  assert.strictEqual(linkUpdate.data.storeName, 'Canonical Store');
  assert.strictEqual(linkUpdate.data.status, 'active');
}

(async () => {
  testStaticWiring();
  testApplyPageExists();
  await testBoundMemberCanSaveDeterministicCoachProfileWithoutRoleGrant();
  await testSaveCoachProfileRejectsUnboundOpenidWithoutWrites();
  await testApprovalAddsCoachRoleWithoutDroppingMember();
  await testReviewRejectsIdentityOwnershipSelfAndStateAttacksWithoutWrites();
  await testApprovalRollsBackEveryWriteWhenAnyTransactionalWriteFails();
  await testAuthorizedCoachCanBeAddedToShop();
  await testReactivatedCoachLinkUsesCanonicalStoreName();
})();
