const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');

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

function createFakeDb(seed) {
  const updates = [];
  const adds = [];

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
      return { data: (seed[this.name] || []).filter((item) => matches(item, this.query)) };
    }
  }

  const db = {
    command: {
      in(values) {
        return { __op: 'in', values: values || [] };
      }
    },
    collection(name) {
      return {
        where(query) {
          return new Query(name).where(query);
        },
        doc(id) {
          return {
            async get() {
              const hit = (seed[name] || []).find((item) => item._id === id);
              if (!hit) throw new Error('not found');
              return { data: hit };
            },
            async update({ data }) {
              updates.push({ collection: name, id, data });
              return { updated: 1 };
            }
          };
        },
        async add({ data }) {
          adds.push({ collection: name, data });
          return { _id: `${name}_new` };
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
  const { fn, fakeDb } = loadCloudFunction('cloudfunctions/reviewCoachBindingApplication/index.js', 'shop_openid', {
    coach_shop_applications: [
      {
        _id: 'app1',
        shopOpenid: 'shop_openid',
        coachOpenid: 'member_openid',
        storeId: 'store1',
        storeName: 'A厅',
        coachNickname: 'Coach A'
      }
    ],
    shop_coach_links: [],
    coaches: [],
    users: [
      { _id: 'user1', _openid: 'member_openid', roles: ['member'], role: 'member', currentRole: 'member' }
    ]
  });

  const res = await fn.main({ applicationId: 'app1', approve: true });
  assert.strictEqual(res.ok, true);

  const userUpdate = fakeDb.__updates.find((item) => item.collection === 'users' && item.id === 'user1');
  assert(userUpdate, 'Approval should update the applicant user document.');
  assert.deepStrictEqual(userUpdate.data.roles, ['member', 'coach']);
  assert.strictEqual(userUpdate.data.role, 'member');
  assert.strictEqual(userUpdate.data.currentRole, 'member');
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
  await testApprovalAddsCoachRoleWithoutDroppingMember();
  await testAuthorizedCoachCanBeAddedToShop();
  await testReactivatedCoachLinkUsesCanonicalStoreName();
})();
