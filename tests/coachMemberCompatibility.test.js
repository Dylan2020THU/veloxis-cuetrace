const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');
const LOGIN_NOW_MS = Date.UTC(2026, 6, 16, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;
const AUTH_ENV = Object.freeze({
  CUETRACE_AUTH_KEY_ACTIVE_VERSION: 'K2',
  CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS: '',
  CUETRACE_AUTH_KEY_K2: Buffer.alloc(32, 0x42).toString('base64')
});
const {
  deriveKey,
  loadKeyring
} = require(path.join(
  root,
  'cloudfunctions/login/lib/auth/keyring.js'
));

function lengthPrefixed(value) {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function sessionDocumentId(sessionToken) {
  const keyring = loadKeyring(AUTH_ENV);
  const digest = crypto
    .createHmac(
      'sha256',
      deriveKey(keyring, 'K2', 'session-token')
    )
    .update(Buffer.concat([
      Buffer.from('cuetrace-auth-v2-hmac\0'),
      lengthPrefixed('session-token'),
      lengthPrefixed('session'),
      lengthPrefixed(sessionToken)
    ]))
    .digest('base64url');
  return `session.K2.${digest}`;
}

function accountNameId(accountName) {
  return crypto
    .createHash('sha256')
    .update(`account-name:v1:${accountName.toLowerCase()}`)
    .digest('hex');
}

function v2LoginFixture(options) {
  const settings = options || {};
  const accountId = settings.accountId
    || `acct_${Buffer.alloc(16, settings.seedByte || 0x31).toString('base64url')}`;
  const accountName = Object.prototype.hasOwnProperty.call(
    settings,
    'accountName'
  )
    ? settings.accountName
    : 'MemberOne';
  const phoneMasked = settings.phoneMasked || '';
  const accountNameBindingId = accountName
    ? accountNameId(accountName)
    : '';
  const phoneBindingId = phoneMasked
    ? `phone.K2.${Buffer.alloc(32, settings.seedByte || 0x31).toString('base64url')}`
    : '';
  const roles = settings.roles || ['member'];
  const currentRole = settings.currentRole || roles[0];
  const account = {
    _id: accountId,
    status: 'active',
    accountNameBindingId,
    phoneBindingId,
    wechatBindingId: '',
    emailBindingId: '',
    passwordAlgorithm: 'scrypt-v1',
    passwordSalt: 'salt',
    passwordHash: 'hash',
    authVersion: 1,
    termsAcceptedAt: LOGIN_NOW_MS,
    termsVersion: '2026-07-15',
    privacyAcceptedAt: LOGIN_NOW_MS,
    privacyVersion: '2026-07-15',
    createdAt: LOGIN_NOW_MS,
    updatedAt: LOGIN_NOW_MS
  };
  const sessionToken = `v2.K2.${Buffer.alloc(32, (settings.seedByte || 0x31) + 1).toString('base64url')}`;
  const session = {
    _id: sessionDocumentId(sessionToken),
    accountId,
    keyVersion: 'K2',
    authVersion: 1,
    clientInstanceId: 'role-client',
    authenticatedAt: LOGIN_NOW_MS,
    authenticationMethod: 'password',
    createdAt: LOGIN_NOW_MS,
    lastSeenAt: LOGIN_NOW_MS,
    idleExpiresAt: LOGIN_NOW_MS + 30 * DAY_MS,
    absoluteExpiresAt: LOGIN_NOW_MS + 90 * DAY_MS,
    revokedAt: '',
    revokeReason: ''
  };
  const user = {
    _id: accountId,
    roles: roles.slice(),
    currentRole,
    role: currentRole,
    nickname: 'Server User',
    avatar: 'cloud://avatar',
    createdAt: LOGIN_NOW_MS,
    updatedAt: LOGIN_NOW_MS
  };
  const state = {
    auth_control: [{
      _id: 'main',
      maintenance: false,
      schemaVersion: 2,
      minClientProtocol: 2
    }],
    auth_sessions: [session],
    accounts: [account],
    users: [user],
    account_names: accountName ? [{
      _id: accountNameBindingId,
      accountId,
      account: accountName,
      accountNormalized: accountName.toLowerCase(),
      status: 'active',
      createdAt: LOGIN_NOW_MS,
      updatedAt: LOGIN_NOW_MS
    }] : [],
    phone_bindings: phoneMasked ? [{
      _id: phoneBindingId,
      accountId,
      keyVersion: 'K2',
      phoneMasked,
      status: 'active',
      verifiedAt: LOGIN_NOW_MS,
      createdAt: LOGIN_NOW_MS,
      updatedAt: LOGIN_NOW_MS
    }] : [],
    account_deletion_requests: [],
    admins: []
  };
  return { account, session, sessionToken, state, user };
}

async function withLoginEnvironment(callback) {
  const previous = {};
  for (const [key, value] of Object.entries(AUTH_ENV)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  const originalNow = Date.now;
  Date.now = () => LOGIN_NOW_MS + 1000;
  try {
    return await callback();
  } finally {
    Date.now = originalNow;
    for (const key of Object.keys(AUTH_ENV)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

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

function createFakeDb(seed, virtualAuthControl) {
  const updates = [];
  const adds = [];
  const reads = [];

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
      const source = (
        this.name === 'auth_control'
        && !Object.prototype.hasOwnProperty.call(seed, this.name)
        && virtualAuthControl
      )
        ? [virtualAuthControl]
        : (seed[this.name] || []);
      let data = source.filter((item) => matches(item, this.query));
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
              reads.push({ collection: name, id });
              if (db.__failNextRead) {
                db.__failNextRead = false;
                throw new Error('simulated binding read failure');
              }
              const source = (
                name === 'auth_control'
                && !Object.prototype.hasOwnProperty.call(seed, name)
                && virtualAuthControl
              )
                ? [virtualAuthControl]
                : (seed[name] || []);
              const item = source.find((record) => record._id === id);
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
    runTransaction(callback) {
      return callback(db);
    },
    __updates: updates,
    __adds: adds,
    __reads: reads,
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

function loadCloudFunction(relPath, openid, seed, options) {
  const virtualAuthControl = Object.prototype.hasOwnProperty.call(
    seed,
    'auth_control'
  )
    ? null
    : {
      _id: 'main',
      maintenance: false,
      schemaVersion: 1,
      minClientProtocol: 1
    };
  const fnPath = path.join(root, relPath);
  delete require.cache[require.resolve(fnPath)];
  const fakeDb = createFakeDb(seed, virtualAuthControl);
  const wxContextCalls = [];
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: 'DYNAMIC_CURRENT_ENV',
    init() {},
    database() {
      return fakeDb;
    },
    getWXContext() {
      wxContextCalls.push(openid);
      if (options && options.forbidWxContext) {
        throw new Error('login must not read WXContext');
      }
      return { OPENID: openid };
    }
  };
  const fn = withWxServerSdk(fakeCloud, () => require(fnPath));
  return { fn, fakeDb, wxContextCalls };
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

async function testLoginRequiresSchema2SessionAndClosedInput() {
  const fixture = v2LoginFixture();
  const loaded = loadCloudFunction(
    'cloudfunctions/login/index.js',
    'must-not-be-read',
    fixture.state,
    { forbidWxContext: true }
  );

  await withLoginEnvironment(async () => {
    const v1 = await loaded.fn.main({
      authProtocol: 1,
      role: 'member',
      sessionToken: fixture.sessionToken
    });
    assert.strictEqual(v1.code, 'CLIENT_UPDATE_REQUIRED');
    assert.deepStrictEqual(
      loaded.fakeDb.__reads.map((item) => item.collection),
      ['auth_control']
    );

    const missingSession = await loaded.fn.main({
      authProtocol: 2,
      role: 'member'
    });
    assert.strictEqual(missingSession.code, 'SESSION_REQUIRED');

    const readsBeforeSurplus = loaded.fakeDb.__reads.length;
    const surplus = await loaded.fn.main({
      authProtocol: 2,
      role: 'member',
      sessionToken: fixture.sessionToken,
      accountId: fixture.account._id
    });
    assert.strictEqual(surplus.code, 'INVALID_INPUT');
    assert.deepStrictEqual(
      loaded.fakeDb.__reads
        .slice(readsBeforeSurplus)
        .map((item) => item.collection),
      ['auth_control']
    );
  });

  assert.deepStrictEqual(loaded.wxContextCalls, []);
  assert.strictEqual(loaded.fakeDb.__updates.length, 0);
}

async function testLoginSelectsLiveRoleAndReturnsSafeProjection() {
  const fixture = v2LoginFixture({
    accountName: 'CoachOne',
    phoneMasked: '138****1234',
    roles: ['member', 'coach'],
    currentRole: 'member',
    seedByte: 0x32
  });
  const loaded = loadCloudFunction(
    'cloudfunctions/login/index.js',
    'must-not-be-read',
    fixture.state,
    { forbidWxContext: true }
  );

  const result = await withLoginEnvironment(() => loaded.fn.main({
    authProtocol: 2,
    role: 'coach',
    sessionToken: fixture.sessionToken
  }));

  assert.deepStrictEqual(result, {
    ok: true,
    kind: 'role_selected',
    account: 'CoachOne',
    accountDisplay: 'CoachOne',
    roles: ['member', 'coach'],
    currentRole: 'coach'
  });
  assert(!JSON.stringify(result).includes(fixture.account._id));
  assert(!Object.prototype.hasOwnProperty.call(result, 'sessionToken'));
  assert.deepStrictEqual(loaded.wxContextCalls, []);
  assert.deepStrictEqual(
    loaded.fakeDb.__updates.map((item) => ({
      collection: item.collection,
      id: item.id,
      data: item.data
    })),
    [{
      collection: 'users',
      id: fixture.account._id,
      data: {
        currentRole: 'coach',
        role: 'coach',
        updatedAt: 'SERVER_DATE'
      }
    }]
  );
  const readCollections = loaded.fakeDb.__reads.map(
    (item) => item.collection
  );
  assert(readCollections.includes('account_names'));
  assert(readCollections.includes('phone_bindings'));
  assert(!readCollections.includes('account_deletion_requests'));
}

async function testLoginRejectsUngrantAndMalformedLiveRoles() {
  const deniedFixture = v2LoginFixture({ seedByte: 0x33 });
  const denied = loadCloudFunction(
    'cloudfunctions/login/index.js',
    'must-not-be-read',
    deniedFixture.state,
    { forbidWxContext: true }
  );
  const deniedResult = await withLoginEnvironment(() => denied.fn.main({
    authProtocol: 2,
    role: 'coach',
    sessionToken: deniedFixture.sessionToken
  }));
  assert.strictEqual(deniedResult.code, 'ROLE_NOT_ALLOWED');
  assert.strictEqual(denied.fakeDb.__updates.length, 0);

  const malformedFixture = v2LoginFixture({
    roles: ['member', 'admin'],
    seedByte: 0x34
  });
  const malformed = loadCloudFunction(
    'cloudfunctions/login/index.js',
    'must-not-be-read',
    malformedFixture.state,
    { forbidWxContext: true }
  );
  const malformedResult = await withLoginEnvironment(() => malformed.fn.main({
    authProtocol: 2,
    role: 'member',
    sessionToken: malformedFixture.sessionToken
  }));
  assert.strictEqual(malformedResult.code, 'SESSION_EXPIRED');
  assert.strictEqual(malformed.fakeDb.__updates.length, 0);
}

async function testLoginProjectsPhoneFallbackAndRejectsBrokenReverseLinks() {
  const phoneFixture = v2LoginFixture({
    accountName: '',
    phoneMasked: '139****5678',
    seedByte: 0x35
  });
  const phoneLoaded = loadCloudFunction(
    'cloudfunctions/login/index.js',
    'must-not-be-read',
    phoneFixture.state,
    { forbidWxContext: true }
  );
  const phoneResult = await withLoginEnvironment(() => phoneLoaded.fn.main({
    authProtocol: 2,
    role: 'member',
    sessionToken: phoneFixture.sessionToken
  }));
  assert.strictEqual(phoneResult.account, '');
  assert.strictEqual(phoneResult.accountDisplay, '139****5678');

  const anonymousFixture = v2LoginFixture({
    accountName: '',
    seedByte: 0x36
  });
  const anonymousLoaded = loadCloudFunction(
    'cloudfunctions/login/index.js',
    'must-not-be-read',
    anonymousFixture.state,
    { forbidWxContext: true }
  );
  const anonymousResult = await withLoginEnvironment(() => (
    anonymousLoaded.fn.main({
      authProtocol: 2,
      role: 'member',
      sessionToken: anonymousFixture.sessionToken
    })
  ));
  assert.strictEqual(anonymousResult.account, '');
  assert.strictEqual(anonymousResult.accountDisplay, '手机号用户');

  const missingName = v2LoginFixture({ seedByte: 0x37 });
  missingName.state.account_names = [];
  const missingNameLoaded = loadCloudFunction(
    'cloudfunctions/login/index.js',
    'must-not-be-read',
    missingName.state,
    { forbidWxContext: true }
  );
  const missingNameResult = await withLoginEnvironment(() => (
    missingNameLoaded.fn.main({
      authProtocol: 2,
      role: 'member',
      sessionToken: missingName.sessionToken
    })
  ));
  assert.strictEqual(missingNameResult.code, 'AUTH_INTERNAL_ERROR');
  assert.strictEqual(missingNameLoaded.fakeDb.__updates.length, 0);

  const corruptPhone = v2LoginFixture({
    accountName: 'MemberTwo',
    phoneMasked: '137****0000',
    seedByte: 0x38
  });
  corruptPhone.state.phone_bindings[0].accountId = 'acct_other';
  const corruptPhoneLoaded = loadCloudFunction(
    'cloudfunctions/login/index.js',
    'must-not-be-read',
    corruptPhone.state,
    { forbidWxContext: true }
  );
  const corruptPhoneResult = await withLoginEnvironment(() => (
    corruptPhoneLoaded.fn.main({
      authProtocol: 2,
      role: 'member',
      sessionToken: corruptPhone.sessionToken
    })
  ));
  assert.strictEqual(corruptPhoneResult.code, 'AUTH_INTERNAL_ERROR');
  assert.strictEqual(corruptPhoneLoaded.fakeDb.__updates.length, 0);
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

async function testCoachApplicationRejectsUnboundNonShopAndSelfAttackersWithoutWrites() {
  const applicantBinding = bindingFor('member_openid', 'member1');
  const ownerBinding = bindingFor('shop_openid', 'shop1');
  const variants = [
    {
      name: 'unbound applicant',
      openid: 'unbound_openid',
      expectedCode: 'ACCOUNT_NOT_BOUND',
      bindings: [ownerBinding],
      accounts: [accountFor('shop_openid', 'shop1')],
      users: [{
        _id: ownerBinding._id,
        _openid: 'shop_openid',
        roles: ['member', 'shop'],
        role: 'member',
        currentRole: 'member'
      }]
    },
    {
      name: 'store owner without shop role',
      openid: 'member_openid',
      expectedCode: 'SHOP_ROLE_REQUIRED',
      bindings: [applicantBinding, ownerBinding],
      accounts: [accountFor('member_openid', 'member1'), accountFor('shop_openid', 'shop1')],
      users: [
        {
          _id: applicantBinding._id,
          _openid: 'member_openid',
          roles: ['member'],
          role: 'member',
          currentRole: 'member'
        },
        {
          _id: ownerBinding._id,
          _openid: 'shop_openid',
          roles: ['member'],
          role: 'shop',
          currentRole: 'shop'
        }
      ]
    },
    {
      name: 'self application',
      openid: 'shop_openid',
      expectedCode: 'SELF_APPLICATION_NOT_ALLOWED',
      bindings: [ownerBinding],
      accounts: [accountFor('shop_openid', 'shop1')],
      users: [{
        _id: ownerBinding._id,
        _openid: 'shop_openid',
        roles: ['member', 'shop'],
        role: 'member',
        currentRole: 'member'
      }]
    }
  ];

  for (const variant of variants) {
    const state = {
      wechat_bindings: variant.bindings,
      accounts: variant.accounts,
      users: variant.users,
      stores: [{ _id: 'store1', _openid: 'shop_openid', name: 'Canonical Store' }],
      coach_shop_applications: []
    };
    const { fn, fakeDb } = loadCloudFunction(
      'cloudfunctions/applyCoachShopBinding/index.js',
      variant.openid,
      state
    );

    const result = await fn.main({
      storeId: 'store1',
      coachNickname: 'Attacker',
      shopOpenid: variant.openid,
      storeName: 'Forged Store'
    });

    assert.strictEqual(result.ok, false, variant.name);
    assert.strictEqual(result.code, variant.expectedCode, variant.name);
    assert.strictEqual(fakeDb.__updates.length, 0, variant.name);
    assert.strictEqual(fakeDb.__adds.length, 0, variant.name);
    assert.strictEqual(state.coach_shop_applications.length, 0, variant.name);
  }
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
  await testLoginRequiresSchema2SessionAndClosedInput();
  await testLoginSelectsLiveRoleAndReturnsSafeProjection();
  await testLoginRejectsUngrantAndMalformedLiveRoles();
  await testLoginProjectsPhoneFallbackAndRejectsBrokenReverseLinks();
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
  await testCoachApplicationRejectsUnboundNonShopAndSelfAttackersWithoutWrites();
  testCheckinPageExposesDetailFilters();
})();
