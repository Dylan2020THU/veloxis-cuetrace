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

function userIdFor(openid) {
  return bindingFor(openid, '')._id;
}

function accountFor(openid, account, overrides) {
  const doc = {
    _id: crypto.createHash('sha256').update(`account:${String(account).toLowerCase()}`).digest('hex'),
    _openid: openid,
    account,
    status: 'active'
  };
  return Object.assign(doc, overrides || {});
}

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function valueMatches(actual, expected) {
  if (expected && expected.__op === 'in') return expected.values.indexOf(actual) !== -1;
  if (expected && expected.__op === 'range') {
    if (expected.gte !== undefined && actual < expected.gte) return false;
    if (expected.lte !== undefined && actual > expected.lte) return false;
    return true;
  }
  return actual === expected;
}

function matches(record, query) {
  return Object.keys(query || {}).every((key) => valueMatches(record[key], query[key]));
}

function project(record, fields) {
  if (!fields) return Object.assign({}, record);
  const out = {};
  Object.keys(fields).forEach((key) => {
    if (fields[key]) out[key] = record[key];
  });
  return out;
}

function createFakeDb(seed) {
  const updates = [];
  const adds = [];

  class Query {
    constructor(name) {
      this.name = name;
      this.query = {};
      this.fields = null;
      this.skipCount = 0;
      this.limitCount = null;
      this.orderField = '';
      this.orderDirection = 'asc';
    }

    where(query) {
      this.query = query || {};
      return this;
    }

    field(fields) {
      this.fields = fields;
      return this;
    }

    skip(n) {
      this.skipCount = Number(n) || 0;
      return this;
    }

    limit(n) {
      this.limitCount = Number(n) || 0;
      return this;
    }

    orderBy(field, direction) {
      this.orderField = field;
      this.orderDirection = direction || 'asc';
      return this;
    }

    async get() {
      let data = (seed[this.name] || []).filter((item) => matches(item, this.query));
      if (this.orderField) {
        const field = this.orderField;
        const dir = this.orderDirection === 'desc' ? -1 : 1;
        data = data.slice().sort((a, b) => String(a[field] || '').localeCompare(String(b[field] || '')) * dir);
      }
      if (this.skipCount) data = data.slice(this.skipCount);
      if (this.limitCount) data = data.slice(0, this.limitCount);
      if (this.fields) data = data.map((item) => project(item, this.fields));
      return { data };
    }

    async update({ data }) {
      updates.push({ collection: this.name, query: this.query, data });
      return { updated: 1 };
    }
  }

  const db = {
    command: {
      in(values) {
        return { __op: 'in', values: values || [] };
      },
      gte(value) {
        return {
          __op: 'range',
          gte: value,
          and(other) {
            return Object.assign({}, this, other || {});
          }
        };
      },
      lte(value) {
        return { __op: 'range', lte: value };
      },
      remove() {
        return { __op: 'remove' };
      }
    },
    collection(name) {
      return {
        where(query) {
          return new Query(name).where(query);
        },
        field(fields) {
          return new Query(name).field(fields);
        },
        orderBy(field, direction) {
          return new Query(name).orderBy(field, direction);
        },
        skip(n) {
          return new Query(name).skip(n);
        },
        limit(n) {
          return new Query(name).limit(n);
        },
        doc(id) {
          return {
            async get() {
              if (db.__failNextRead) {
                db.__failNextRead = false;
                throw new Error('simulated binding read failure');
              }
              const item = (seed[name] || []).find((record) => record._id === id);
              return { data: item || null };
            },
            async update({ data }) {
              updates.push({ collection: name, id, data });
              const item = (seed[name] || []).find((record) => record._id === id);
              if (item) Object.assign(item, data);
              return { updated: 1 };
            }
          };
        },
        async add({ data }) {
          adds.push({ collection: name, data });
          (seed[name] || (seed[name] = [])).push(Object.assign({ _id: `${name}_new` }, data));
          return { _id: `${name}_new` };
        },
        async get() {
          return new Query(name).get();
        }
      };
    },
    serverDate() {
      return 'SERVER_DATE';
    },
    __updates: updates,
    __adds: adds,
    __failNextRead: false
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

function loadLoginPage(accounts) {
  const loginPath = path.join(root, 'miniprogram/pages/login/index.js');
  const dataPath = path.join(root, 'miniprogram/services/data.js');
  const mockPath = path.join(root, 'miniprogram/utils/mock.js');
  delete require.cache[require.resolve(loginPath)];
  delete require.cache[require.resolve(dataPath)];
  delete require.cache[require.resolve(mockPath)];

  let page;
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
    hideLoading() {}
  };
  require(loginPath);
  return page;
}

async function testLoginUsesDeterministicUserInsteadOfLegacyCoach() {
  const deterministicUserId = userIdFor('coach_openid');
  const state = {
    wechat_bindings: [bindingFor('coach_openid', 'coach1')],
    accounts: [accountFor('coach_openid', 'coach1')],
    users: [
      {
        _id: 'legacy-coach',
        _openid: 'coach_openid',
        role: 'coach',
        roles: ['member', 'coach'],
        nickname: 'Legacy Coach',
        avatar: 'cloud://legacy'
      },
      {
        _id: deterministicUserId,
        _openid: 'coach_openid',
        role: 'member',
        roles: ['member'],
        nickname: 'Deterministic Member',
        avatar: 'cloud://member'
      }
    ]
  };
  const { fn, fakeDb } = loadCloudFunction('cloudfunctions/login/index.js', 'coach_openid', state);

  const denied = await fn.main({ role: 'coach' });
  assert.strictEqual(denied.ok, false);
  assert.strictEqual(denied.code, 'ROLE_NOT_ALLOWED');
  assert.strictEqual(fakeDb.__updates.length, 0);

  const member = await fn.main({ role: 'member' });
  assert.strictEqual(member.role, 'member');
  assert.deepStrictEqual(member.roles, ['member']);
  assert.strictEqual(member.nickname, 'Deterministic Member');
  const userUpdate = fakeDb.__updates.find((item) => item.collection === 'users');
  assert(userUpdate, 'Member login should update the deterministic user document.');
  assert.strictEqual(userUpdate.id, deterministicUserId);
}

async function testLoginReturnsShopOnlyRoles() {
  const { fn } = loadCloudFunction('cloudfunctions/login/index.js', 'shop_openid', {
    wechat_bindings: [bindingFor('shop_openid', 'shop1')],
    accounts: [accountFor('shop_openid', 'shop1')],
    users: [
      { _id: userIdFor('shop_openid'), _openid: 'shop_openid', roles: ['shop'], nickname: 'Shop', avatar: '' }
    ]
  });
  const res = await fn.main({ role: 'shop' });
  assert.deepStrictEqual(res.roles, ['shop']);
  assert.strictEqual(res.currentRole, 'shop');
}

async function testLoginRejectsClientRoleEscalationAndAllowsServerRole() {
  const state = {
    wechat_bindings: [bindingFor('coach_openid', 'coach1')],
    accounts: [accountFor('coach_openid', 'coach1')],
    users: [
      {
        _id: userIdFor('coach_openid'),
        _openid: 'coach_openid',
        role: 'member',
        roles: ['member'],
        nickname: 'Coach',
        avatar: ''
      }
    ],
    admins: []
  };
  const { fn } = loadCloudFunction('cloudfunctions/login/index.js', 'coach_openid', state);
  const denied = await fn.main({
    role: 'coach',
    roles: ['member', 'coach', 'shop'],
    loginName: 'admin_zhx'
  });
  assert.strictEqual(denied.ok, false);
  assert.strictEqual(denied.code, 'ROLE_NOT_ALLOWED');
  assert.deepStrictEqual(state.users[0].roles, ['member']);
  assert.deepStrictEqual(state.admins, []);

  state.users[0].roles = ['member', 'coach'];
  const allowed = await fn.main({ role: 'coach' });
  assert.strictEqual(allowed.role, 'coach');
  assert.deepStrictEqual(allowed.roles, ['member', 'coach']);
}

async function testLoginRejectsMissingAccountWithoutWrites() {
  const state = {
    wechat_bindings: [bindingFor('member_openid', 'member1')],
    accounts: [],
    users: [{ _id: userIdFor('member_openid'), _openid: 'member_openid', role: 'member', roles: ['member'] }],
    admins: []
  };
  const { fn, fakeDb } = loadCloudFunction('cloudfunctions/login/index.js', 'member_openid', state);

  const result = await fn.main({ role: 'member' });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'ACCOUNT_NOT_BOUND');
  assert.strictEqual(fakeDb.__updates.length, 0);
  assert.strictEqual(fakeDb.__adds.length, 0);
  assert.deepStrictEqual(state.admins, []);
}

async function testLoginRejectsContradictoryAccountBindingWithoutWrites() {
  const state = {
    wechat_bindings: [bindingFor('member_openid', 'member1')],
    accounts: [accountFor('member_openid', 'member1', { account: 'different_account' })],
    users: [{ _id: userIdFor('member_openid'), _openid: 'member_openid', role: 'member', roles: ['member'] }],
    admins: []
  };
  const { fn, fakeDb } = loadCloudFunction('cloudfunctions/login/index.js', 'member_openid', state);

  const result = await fn.main({ role: 'member' });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'ACCOUNT_NOT_BOUND');
  assert.strictEqual(fakeDb.__updates.length, 0);
  assert.strictEqual(fakeDb.__adds.length, 0);
  assert.deepStrictEqual(state.admins, []);
}

async function testLoginPropagatesBindingReadFailureWithoutWrites() {
  const state = {
    wechat_bindings: [bindingFor('member_openid', 'member1')],
    accounts: [accountFor('member_openid', 'member1')],
    users: [{ _id: userIdFor('member_openid'), _openid: 'member_openid', role: 'member', roles: ['member'] }],
    admins: []
  };
  const { fn, fakeDb } = loadCloudFunction('cloudfunctions/login/index.js', 'member_openid', state);
  fakeDb.__failNextRead = true;

  await assert.rejects(() => fn.main({ role: 'member' }), /simulated binding read failure/);
  assert.strictEqual(fakeDb.__updates.length, 0);
  assert.strictEqual(fakeDb.__adds.length, 0);
  assert.deepStrictEqual(state.admins, []);
}

async function testMarkFirstLoginRejectsUnboundOpenidWithoutWrites() {
  const { fn, fakeDb } = loadCloudFunction('cloudfunctions/markFirstLogin/index.js', 'unbound_openid', {
    wechat_bindings: [],
    accounts: [],
    users: []
  });

  const result = await fn.main({ role: 'coach', firstLoginAt: 123456 });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'ACCOUNT_NOT_BOUND');
  assert.strictEqual(fakeDb.__updates.length, 0);
  assert.strictEqual(fakeDb.__adds.length, 0);
}

async function testMarkFirstLoginRejectsUnauthorizedRoleWithoutWrites() {
  const openid = 'member_openid';
  const { fn, fakeDb } = loadCloudFunction('cloudfunctions/markFirstLogin/index.js', openid, {
    wechat_bindings: [bindingFor(openid, 'member1')],
    accounts: [accountFor(openid, 'member1')],
    users: [{
      _id: userIdFor(openid),
      _openid: openid,
      roles: ['member'],
      role: 'member',
      currentRole: 'member'
    }]
  });

  const result = await fn.main({ role: 'coach', firstLoginAt: 123456 });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'ROLE_NOT_ALLOWED');
  assert.strictEqual(fakeDb.__updates.length, 0);
  assert.strictEqual(fakeDb.__adds.length, 0);
}

async function testMarkFirstLoginUsesServerTimeWithoutGrantingRoles() {
  const openid = 'member_openid';
  const { fn, fakeDb } = loadCloudFunction('cloudfunctions/markFirstLogin/index.js', openid, {
    wechat_bindings: [bindingFor(openid, 'member1')],
    accounts: [accountFor(openid, 'member1')],
    users: [{
      _id: userIdFor(openid),
      _openid: openid,
      roles: ['member'],
      role: 'member',
      currentRole: 'member'
    }]
  });

  const result = await fn.main({ role: 'member', firstLoginAt: 123456 });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.firstLoginAt, 'SERVER_DATE');
  assert.strictEqual(fakeDb.__adds.length, 0);
  assert.strictEqual(fakeDb.__updates.length, 1);
  assert.strictEqual(fakeDb.__updates[0].id, userIdFor(openid));
  assert.deepStrictEqual(fakeDb.__updates[0].data, {
    firstLoginAt: 'SERVER_DATE',
    'per_role.member.firstLoginAt': 'SERVER_DATE'
  });
}

function testLoginPageHasNoLocalEntitlementSource() {
  const loginJs = read('miniprogram/pages/login/index.js');
  assert(!loginJs.includes('readRegisteredAccounts'), 'Login must not expose locally persisted account entitlements.');
  assert(!loginJs.includes('findRegisteredAccount'), 'Login must not authenticate through local account records.');
  assert(!loginJs.includes("getStorageSync('dc_accounts')"), 'Login must not read the legacy local account store.');
}

async function testDataLoginForwardsOnlySelectedRole() {
  const dataPath = path.join(root, 'miniprogram/services/data.js');
  const mockPath = path.join(root, 'miniprogram/utils/mock.js');
  delete require.cache[require.resolve(dataPath)];
  delete require.cache[require.resolve(mockPath)];

  const calls = [];
  global.getApp = () => ({ globalData: { cloudReady: true } });
  global.wx = {
    cloud: {
      callFunction(args) {
        calls.push(args);
        return Promise.resolve({
          result: {
            openid: 'coach_openid',
            role: 'coach',
            roles: ['member', 'coach'],
            currentRole: 'coach'
          }
        });
      }
    }
  };

  const data = require(dataPath);
  await data.login('coach', ['member', 'coach']);
  assert.deepStrictEqual(calls[0].data, { role: 'coach' });
}

function testLoginFailuresSurfaceCloudMessage() {
  const loginJs = read('miniprogram/pages/login/index.js');
  assert(loginJs.includes("(e && e.message) || '登录失败，请重试'"), 'Login failure toast should show cloud error message when available.');
}

async function testOwnHeatmapMergesCoachLessons() {
  const { fn } = loadCloudFunction('cloudfunctions/getHeatmap/index.js', 'coach_openid', {
    training_sessions: [
      { _id: 's1', _openid: 'coach_openid', date: '2026-07-08', durationMinutes: 60, verified: true }
    ],
    coach_lessons: [
      { _id: 'l1', coachOpenid: 'coach_openid', date: '2026-07-08', durationMinutes: 90, verified: true }
    ],
    coach_member_links: [],
    shop_coach_links: []
  });
  const res = await fn.main({ startKey: '2026-07-08', endKey: '2026-07-08' });
  assert.strictEqual(res.stats.length, 1);
  assert.strictEqual(res.stats[0].totalMinutes, 150);
  assert.strictEqual(res.stats[0].personalMinutes, 60);
  assert.strictEqual(res.stats[0].coachMinutes, 90);
  assert.strictEqual(res.stats[0].kind, 'coach');
}

async function testTargetHeatmapDoesNotMergeCoachLessons() {
  const { fn } = loadCloudFunction('cloudfunctions/getHeatmap/index.js', 'coach_openid', {
    training_sessions: [
      { _id: 's1', _openid: 'member_openid', date: '2026-07-08', durationMinutes: 60, verified: true }
    ],
    coach_lessons: [
      { _id: 'l1', coachOpenid: 'member_openid', date: '2026-07-08', durationMinutes: 90, verified: true }
    ],
    coach_member_links: [
      { coachOpenid: 'coach_openid', memberOpenid: 'member_openid', status: 'active' }
    ],
    shop_coach_links: []
  });
  const res = await fn.main({ startKey: '2026-07-08', endKey: '2026-07-08', targetOpenid: 'member_openid' });
  assert.strictEqual(res.stats.length, 1);
  assert.strictEqual(res.stats[0].totalMinutes, 60);
  assert.strictEqual(res.stats[0].coachMinutes || 0, 0);
  assert.strictEqual(res.stats[0].kind || 'personal', 'personal');
}

async function testOwnDayDetailMergesCoachLessons() {
  const { fn } = loadCloudFunction('cloudfunctions/getDayDetail/index.js', 'coach_openid', {
    training_sessions: [
      { _id: 's1', _openid: 'coach_openid', date: '2026-07-08', hallName: 'A厅', startTime: '10:00', durationMinutes: 60, verified: true }
    ],
    coach_lessons: [
      { _id: 'l1', coachOpenid: 'coach_openid', date: '2026-07-08', hallName: 'A厅', memberNickname: '学员A', startTime: '11:00', durationMinutes: 90, verified: true }
    ],
    coach_member_links: [],
    shop_coach_links: []
  });
  const res = await fn.main({ dateKey: '2026-07-08' });
  assert.deepStrictEqual(res.sessions.map((s) => s.kind), ['personal', 'coach']);
  assert.strictEqual(res.sessions[1].memberNickname, '学员A');
}

async function testTargetDayDetailDoesNotMergeCoachLessons() {
  const { fn } = loadCloudFunction('cloudfunctions/getDayDetail/index.js', 'coach_openid', {
    training_sessions: [
      { _id: 's1', _openid: 'member_openid', date: '2026-07-08', startTime: '10:00', durationMinutes: 60, verified: true }
    ],
    coach_lessons: [
      { _id: 'l1', coachOpenid: 'member_openid', date: '2026-07-08', startTime: '11:00', durationMinutes: 90, verified: true }
    ],
    coach_member_links: [
      { coachOpenid: 'coach_openid', memberOpenid: 'member_openid', status: 'active' }
    ],
    shop_coach_links: []
  });
  const res = await fn.main({ dateKey: '2026-07-08', targetOpenid: 'member_openid' });
  assert.strictEqual(res.sessions.length, 1);
  assert.strictEqual(res.sessions[0].kind, 'personal');
}

async function testAddShopCoachRejectsMemberWithoutLinkWrites() {
  const state = {
    users: [
      {
        _id: 'shop-user',
        _openid: 'shop_openid',
        roles: ['member', 'shop'],
        role: 'member',
        currentRole: 'member'
      },
      {
        _id: 'member-user',
        _openid: 'member_openid',
        roles: ['member'],
        role: 'member',
        currentRole: 'member'
      }
    ],
    shop_coach_links: []
  };
  const { fn, fakeDb } = loadCloudFunction(
    'cloudfunctions/addShopCoach/index.js',
    'shop_openid',
    state
  );

  const result = await fn.main({ coachOpenid: 'member_openid', storeId: 'store1' });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'COACH_ROLE_REQUIRED');
  assert.strictEqual(state.shop_coach_links.length, 0);
  assert.strictEqual(fakeDb.__updates.length, 0);
  assert.strictEqual(fakeDb.__adds.length, 0);
}

async function testAddShopCoachRejectsNonShopCallerWithoutLinkWrites() {
  const state = {
    users: [
      {
        _id: 'caller-user',
        _openid: 'member_caller',
        roles: ['member'],
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
    shop_coach_links: []
  };
  const { fn, fakeDb } = loadCloudFunction(
    'cloudfunctions/addShopCoach/index.js',
    'member_caller',
    state
  );

  const result = await fn.main({ coachOpenid: 'coach_openid' });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'SHOP_ROLE_REQUIRED');
  assert.strictEqual(state.shop_coach_links.length, 0);
  assert.strictEqual(fakeDb.__updates.length, 0);
  assert.strictEqual(fakeDb.__adds.length, 0);
}

async function testAddShopCoachRejectsForeignStoreWithoutLinkWrites() {
  const state = {
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
    stores: [{ _id: 'foreign-store', _openid: 'another_shop', name: 'Foreign Store' }],
    shop_coach_links: []
  };
  const { fn, fakeDb } = loadCloudFunction(
    'cloudfunctions/addShopCoach/index.js',
    'shop_openid',
    state
  );

  const result = await fn.main({
    coachOpenid: 'coach_openid',
    storeId: 'foreign-store',
    storeName: 'Forged Name'
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'STORE_NOT_OWNED');
  assert.strictEqual(state.shop_coach_links.length, 0);
  assert.strictEqual(fakeDb.__updates.length, 0);
  assert.strictEqual(fakeDb.__adds.length, 0);
}

function testCheckinPageExposesDetailFilters() {
  const js = read('miniprogram/pages/checkin/index.js');
  const wxml = read('miniprogram/pages/checkin/index.wxml');
  const wxss = read('miniprogram/pages/checkin/index.wxss');

  assert(js.includes('detailFilters') && js.includes("key: 'coach'"), 'Checkin page should define all/personal/coach filters.');
  assert(js.includes('switchDetailFilter') && js.includes('applyDetailFilter'), 'Checkin page should expose filter methods.');
  assert(wxml.includes('bindtap="switchDetailFilter"') && wxml.includes('detail-filter'), 'Checkin page should render detail filter buttons.');
  assert(wxml.includes('教学课时'), 'Coach lesson rows should use 教学课时 copy.');
  assert(/\.detail-filter/.test(wxss), 'Detail filter should have WXSS styles.');
}

(async () => {
  await testMarkFirstLoginUsesServerTimeWithoutGrantingRoles();
  await testMarkFirstLoginRejectsUnauthorizedRoleWithoutWrites();
  await testMarkFirstLoginRejectsUnboundOpenidWithoutWrites();
  await testLoginPropagatesBindingReadFailureWithoutWrites();
  await testLoginRejectsContradictoryAccountBindingWithoutWrites();
  await testLoginRejectsMissingAccountWithoutWrites();
  await testLoginUsesDeterministicUserInsteadOfLegacyCoach();
  await testLoginReturnsShopOnlyRoles();
  await testLoginRejectsClientRoleEscalationAndAllowsServerRole();
  testLoginPageHasNoLocalEntitlementSource();
  await testDataLoginForwardsOnlySelectedRole();
  testLoginFailuresSurfaceCloudMessage();
  await testOwnHeatmapMergesCoachLessons();
  await testTargetHeatmapDoesNotMergeCoachLessons();
  await testOwnDayDetailMergesCoachLessons();
  await testTargetDayDetailDoesNotMergeCoachLessons();
  await testAddShopCoachRejectsNonShopCallerWithoutLinkWrites();
  await testAddShopCoachRejectsForeignStoreWithoutLinkWrites();
  await testAddShopCoachRejectsMemberWithoutLinkWrites();
  testCheckinPageExposesDetailFilters();
})();
