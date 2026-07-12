const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');

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

async function testDataServiceForwardsVisibilityFields() {
  const captured = [];
  global.getApp = () => ({ globalData: { cloudReady: true } });
  global.wx = {
    cloud: {
      callFunction(args) {
        captured.push(args);
        return Promise.resolve({ result: { ok: true } });
      }
    }
  };

  const data = require(path.join(root, 'miniprogram/services/data.js'));
  await data.saveUserProfile({
    nickname: '张三',
    avatar: '',
    gender: '男',
    birthDate: '',
    phone: '13800138000',
    locationCity: '北京',
    hometown: ['云南省', '玉溪市'],
    years: '1年以下',
    level: '0级（纯萌新）',
    canSeeGender: false,
    canSeeBirthDate: true,
    canSeeHometown: false,
    canSeePhone: false
  });

  assert.strictEqual(captured.length, 1);
  assert.strictEqual(captured[0].name, 'saveUserProfile');
  assert.strictEqual(captured[0].data.canSeeGender, false);
  assert.strictEqual(captured[0].data.canSeeBirthDate, true);
  assert.strictEqual(captured[0].data.canSeeHometown, false);
  assert.strictEqual(captured[0].data.canSeePhone, false);
  assert.strictEqual(captured[0].data.phone, undefined, 'Profile service must not send an unverified phone.');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function profileIdentity(openid, account) {
  const userId = sha256(`wechat:${openid}`);
  const accountId = sha256(`account:${String(account).toLowerCase()}`);
  return {
    binding: { _id: userId, _openid: openid, accountId, account },
    account: { _id: accountId, _openid: openid, account, status: 'active' },
    user: {
      _id: userId,
      _openid: openid,
      role: 'member',
      roles: ['member'],
      currentRole: 'member',
      nickname: 'Member',
      avatar: ''
    }
  };
}

function profileMatches(document, query) {
  return Object.keys(query || {}).every((key) => document[key] === query[key]);
}

function makeProfileDatabase(state, options) {
  const config = options || {};
  const operations = { updates: [], adds: [], queriedCollections: [] };
  function facade(target, inTransaction) {
    return {
      collection(name) {
        const documents = target[name] || (target[name] = []);
        return {
          doc(id) {
            return {
              async get() {
                operations.queriedCollections.push(name);
                return { data: clone(documents.find((item) => item._id === id) || null) };
              },
              async update({ data }) {
                const index = documents.findIndex((item) => item._id === id);
                if (index === -1) throw new Error(`${name}/${id} does not exist`);
                if (config.beforeUpdate) {
                  await config.beforeUpdate({ collection: name, id, documents, index, data, inTransaction });
                }
                documents[index] = Object.assign({}, documents[index], clone(data));
                operations.updates.push({ collection: name, id, data: clone(data), inTransaction });
                return { stats: { updated: 1 } };
              }
            };
          },
          where(query) {
            return {
              async get() {
                if (inTransaction) throw new Error('transaction query is unsupported');
                operations.queriedCollections.push(name);
                return { data: clone(documents.filter((item) => profileMatches(item, query))) };
              }
            };
          },
          async add({ data }) {
            const id = `${name}_random_${documents.length + 1}`;
            documents.push(Object.assign({}, clone(data), { _id: id }));
            operations.adds.push({ collection: name, id, data: clone(data), inTransaction });
            return { _id: id };
          }
        };
      }
    };
  }

  const database = facade(state, false);
  database.serverDate = () => 'SERVER_DATE';
  database.runTransaction = async (callback) => {
    if (config.beforeTransaction) await config.beforeTransaction({ state });
    const working = clone(state);
    const result = await callback(facade(working, true));
    Object.keys(state).forEach((key) => {
      if (Array.isArray(state[key])) state[key] = working[key] || [];
    });
    Object.keys(working).forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(state, key)) state[key] = working[key];
    });
    return result;
  };
  database.__operations = operations;
  return database;
}

function loadProfileFunction(file, openid, state, options) {
  const fakeDb = makeProfileDatabase(state, options);
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database() {
      return fakeDb;
    },
    getWXContext() {
      return { OPENID: openid };
    }
  };
  const fnPath = path.join(root, file);
  delete require.cache[require.resolve(fnPath)];
  return {
    fn: withWxServerSdk(fakeCloud, () => require(fnPath)),
    fakeDb
  };
}

async function testSaveUsesDeterministicProfileAndDoesNotWritePhone() {
  const auth = profileIdentity('profile-openid', 'ProfileA');
  const legacy = {
    _id: 'legacy-profile',
    _openid: 'profile-openid',
    role: 'coach',
    roles: ['member', 'coach'],
    nickname: 'Legacy Coach',
    avatar: 'cloud://legacy'
  };
  const state = {
    wechat_bindings: [auth.binding],
    accounts: [auth.account],
    users: [clone(legacy), auth.user]
  };
  const { fn, fakeDb } = loadProfileFunction(
    'cloudfunctions/saveUserProfile/index.js',
    'profile-openid',
    state
  );

  const result = await fn.main({
    role: 'member',
    nickname: 'Deterministic Member',
    avatar: 'cloud://member',
    gender: '男',
    birthDate: '1999-01-01',
    phone: '13800138000',
    locationCity: '北京',
    hometown: ['云南省', '玉溪市'],
    years: '1年以下',
    level: '0级（纯萌新）',
    canSeeGender: false,
    canSeeBirthDate: true,
    canSeeHometown: false,
    canSeePhone: false
  });

  assert.deepStrictEqual(result, { ok: true });
  assert.strictEqual(state.users.find((item) => item._id === auth.user._id).nickname, 'Deterministic Member');
  assert.deepStrictEqual(state.users.find((item) => item._id === legacy._id), legacy);
  assert.strictEqual(fakeDb.__operations.updates.length, 1);
  assert.strictEqual(fakeDb.__operations.updates[0].id, auth.user._id);
  assert.deepStrictEqual(fakeDb.__operations.updates[0].data, {
    nickname: 'Deterministic Member',
    avatar: 'cloud://member',
    gender: '男',
    birthDate: '1999-01-01',
    locationCity: '北京',
    hometown: ['云南省', '玉溪市'],
    years: '1年以下',
    level: '0级（纯萌新）',
    canSeeGender: false,
    canSeeBirthDate: true,
    canSeeHometown: false,
    canSeePhone: false,
    updatedAt: 'SERVER_DATE'
  });
  assert.strictEqual(fakeDb.__operations.adds.length, 0);
}

async function testSavePartialUpdatePreservesExistingProfileFields() {
  const auth = profileIdentity('partial-openid', 'PartialA');
  Object.assign(auth.user, {
    roles: ['member', 'coach'],
    currentRole: 'coach',
    role: 'coach',
    nickname: 'Coach A',
    avatar: 'cloud://old-avatar',
    gender: '男',
    birthDate: '1990-01-01',
    phone: '13800138000',
    phoneVerifiedAt: 1710000000000,
    locationCity: '北京',
    hometown: ['北京', '北京市'],
    years: '5年以上',
    level: '4级',
    canSeeGender: false,
    canSeeBirthDate: false,
    canSeeHometown: true,
    canSeePhone: false
  });
  const state = {
    wechat_bindings: [auth.binding],
    accounts: [auth.account],
    users: [auth.user]
  };
  const { fn, fakeDb } = loadProfileFunction(
    'cloudfunctions/saveUserProfile/index.js',
    'partial-openid',
    state
  );

  const result = await fn.main({ avatar: 'cloud://new-avatar' });

  assert.deepStrictEqual(result, { ok: true });
  assert.deepStrictEqual(fakeDb.__operations.updates[0].data, {
    nickname: 'Coach A',
    avatar: 'cloud://new-avatar',
    gender: '男',
    birthDate: '1990-01-01',
    locationCity: '北京',
    hometown: ['北京', '北京市'],
    years: '5年以上',
    level: '4级',
    canSeeGender: false,
    canSeeBirthDate: false,
    canSeeHometown: true,
    canSeePhone: false,
    updatedAt: 'SERVER_DATE'
  });
  assert.strictEqual(state.users[0].phone, '13800138000');
  assert.strictEqual(state.users[0].phoneVerifiedAt, 1710000000000);
}

async function testSaveProfilePatchDoesNotReviveRolesAfterRead() {
  const auth = profileIdentity('toctou-openid', 'ToctouA');
  const state = {
    wechat_bindings: [auth.binding],
    accounts: [auth.account],
    users: [auth.user]
  };
  let hookCalled = false;
  const { fn, fakeDb } = loadProfileFunction(
    'cloudfunctions/saveUserProfile/index.js',
    'toctou-openid',
    state,
    {
      beforeUpdate({ collection, documents, index }) {
        if (collection !== 'users' || hookCalled) return;
        hookCalled = true;
        documents[index].roles = [];
        documents[index].currentRole = 'revoked';
        documents[index].role = 'revoked';
      }
    }
  );

  const result = await fn.main({ role: 'member', nickname: 'Safe Patch' });

  assert.deepStrictEqual(result, { ok: true });
  assert.strictEqual(hookCalled, true);
  assert.deepStrictEqual(state.users[0].roles, []);
  assert.strictEqual(state.users[0].currentRole, 'revoked');
  assert.strictEqual(state.users[0].role, 'revoked');
  ['roles', 'currentRole', 'role'].forEach((field) => {
    assert.strictEqual(fakeDb.__operations.updates[0].data[field], undefined);
  });
}

async function testSaveRequiresCompleteIdentityChain() {
  const auth = profileIdentity('incomplete-openid', 'IncompleteA');
  const state = {
    wechat_bindings: [],
    accounts: [auth.account],
    users: [auth.user]
  };
  const before = clone(state);
  const { fn, fakeDb } = loadProfileFunction(
    'cloudfunctions/saveUserProfile/index.js',
    'incomplete-openid',
    state
  );

  const result = await fn.main({ nickname: 'Must Not Write' });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'ACCOUNT_NOT_BOUND');
  assert.deepStrictEqual(state, before);
  assert.strictEqual(fakeDb.__operations.updates.length, 0);
  assert.strictEqual(fakeDb.__operations.adds.length, 0);
}

async function testSaveDoesNotAuthorizeLegacyRoleField() {
  const auth = profileIdentity('role-openid', 'RoleA');
  delete auth.user.roles;
  auth.user.role = 'coach';
  auth.user.currentRole = 'coach';
  const state = {
    wechat_bindings: [auth.binding],
    accounts: [auth.account],
    users: [auth.user]
  };
  const { fn, fakeDb } = loadProfileFunction(
    'cloudfunctions/saveUserProfile/index.js',
    'role-openid',
    state
  );

  const result = await fn.main({ role: 'coach', nickname: 'Escalated' });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'ROLE_NOT_ALLOWED');
  assert.strictEqual(fakeDb.__operations.updates.length, 0);
}

async function testSaveRejectsPendingOrPurgingDeletionWithoutWrites() {
  for (const status of ['pending', 'purging']) {
    const auth = profileIdentity(`profile-${status}`, `Profile${status}`);
    auth.user.deletionStatus = status;
    const state = {
      wechat_bindings: [auth.binding],
      accounts: [auth.account],
      users: [auth.user]
    };
    const before = clone(state);
    const { fn, fakeDb } = loadProfileFunction(
      'cloudfunctions/saveUserProfile/index.js',
      auth.binding._openid,
      state
    );

    const result = await fn.main({ role: 'member', avatar: 'cloud://must-not-write' });

    assert.strictEqual(result.ok, false, status);
    assert.strictEqual(result.code, 'ACCOUNT_DELETION_PENDING', status);
    assert.deepStrictEqual(state, before, status);
    assert.strictEqual(fakeDb.__operations.updates.length, 0, status);
  }
}

async function testSaveRereadsPurgeClaimInsideTransaction() {
  const auth = profileIdentity('profile-claim-race', 'ProfileClaimRaceA');
  const state = {
    wechat_bindings: [auth.binding],
    accounts: [auth.account],
    users: [auth.user]
  };
  const { fn, fakeDb } = loadProfileFunction(
    'cloudfunctions/saveUserProfile/index.js',
    auth.binding._openid,
    state,
    {
      beforeTransaction({ state: current }) {
        current.users[0].deletionStatus = 'purging';
      }
    }
  );

  const result = await fn.main({ role: 'member', avatar: 'cloud://must-not-race' });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'ACCOUNT_DELETION_PENDING');
  assert.strictEqual(state.users[0].deletionStatus, 'purging');
  assert.strictEqual(state.users[0].avatar, '');
  assert.strictEqual(fakeDb.__operations.updates.length, 0);
}

async function testGetUsesDeterministicProfileWithoutCoachOrShopFallback() {
  const auth = profileIdentity('read-openid', 'ReadA');
  auth.user.nickname = '';
  auth.user.role = 'coach';
  auth.user.currentRole = 'coach';
  const legacy = {
    _id: 'legacy-read-user',
    _openid: 'read-openid',
    role: 'coach',
    roles: ['member', 'coach'],
    nickname: ''
  };
  const state = {
    wechat_bindings: [auth.binding],
    accounts: [auth.account],
    users: [legacy, auth.user],
    coaches: [{ _id: 'legacy-coach', _openid: 'read-openid', nickname: 'Legacy Coach' }],
    shops: [{ _id: 'legacy-shop', _openid: 'read-openid', name: 'Legacy Shop' }]
  };
  const { fn, fakeDb } = loadProfileFunction(
    'cloudfunctions/getUserProfile/index.js',
    'read-openid',
    state
  );

  const result = await fn.main();

  assert.strictEqual(result.user.nickname, '大川会员');
  assert.deepStrictEqual(result.user.roles, ['member']);
  assert.strictEqual(result.user.currentRole, 'member');
  assert.strictEqual(result.user.role, 'member');
  assert.strictEqual(fakeDb.__operations.queriedCollections.includes('coaches'), false);
  assert.strictEqual(fakeDb.__operations.queriedCollections.includes('shops'), false);
}

async function testGetReturnsPhoneOnlyAfterVerification() {
  const auth = profileIdentity('phone-openid', 'PhoneA');
  auth.user.phone = '13800138000';
  const state = {
    wechat_bindings: [auth.binding],
    accounts: [auth.account],
    users: [auth.user]
  };
  let loaded = loadProfileFunction(
    'cloudfunctions/getUserProfile/index.js',
    'phone-openid',
    state
  );

  const unverified = await loaded.fn.main();
  assert.strictEqual(unverified.user.phone, '');

  state.users[0].phoneVerifiedAt = 1710000000000;
  loaded = loadProfileFunction('cloudfunctions/getUserProfile/index.js', 'phone-openid', state);
  const verified = await loaded.fn.main();
  assert.strictEqual(verified.user.phone, '13800138000');
}

async function testGetReturnsCompleteDeterministicProfileProjection() {
  const auth = profileIdentity('projection-openid', 'ProjectionA');
  Object.assign(auth.user, {
    nickname: '张三',
    avatar: 'cloud://avatar',
    gender: '男',
    birthDate: '1999-01-01',
    phone: '13800138000',
    phoneVerifiedAt: 1710000000000,
    locationCity: '北京',
    hometown: ['云南省', '玉溪市'],
    years: '1年以下',
    level: '0级（纯萌新）',
    canSeeGender: false,
    canSeeBirthDate: true,
    canSeeHometown: false,
    canSeePhone: false
  });
  const state = {
    wechat_bindings: [auth.binding],
    accounts: [auth.account],
    users: [auth.user]
  };
  const { fn } = loadProfileFunction(
    'cloudfunctions/getUserProfile/index.js',
    'projection-openid',
    state
  );

  const result = await fn.main();

  assert.deepStrictEqual(result.user, {
    openid: 'projection-openid',
    storageNamespace: auth.user._id,
    role: 'member',
    roles: ['member'],
    currentRole: 'member',
    nickname: '张三',
    avatar: 'cloud://avatar',
    gender: '男',
    birthDate: '1999-01-01',
    phone: '13800138000',
    locationCity: '北京',
    hometown: ['云南省', '玉溪市'],
    years: '1年以下',
    level: '0级（纯萌新）',
    canSeeGender: false,
    canSeeBirthDate: true,
    canSeeHometown: false,
    canSeePhone: false
  });
}

async function testGetRejectsIncompleteIdentityChain() {
  const auth = profileIdentity('missing-binding-openid', 'MissingBindingA');
  const state = {
    wechat_bindings: [],
    accounts: [auth.account],
    users: [auth.user]
  };
  const { fn } = loadProfileFunction(
    'cloudfunctions/getUserProfile/index.js',
    'missing-binding-openid',
    state
  );

  const result = await fn.main();
  assert.strictEqual(result.user, null);
}

(async () => {
  const tests = [
    testSaveUsesDeterministicProfileAndDoesNotWritePhone,
    testSavePartialUpdatePreservesExistingProfileFields,
    testSaveProfilePatchDoesNotReviveRolesAfterRead,
    testSaveRequiresCompleteIdentityChain,
    testSaveDoesNotAuthorizeLegacyRoleField,
    testSaveRejectsPendingOrPurgingDeletionWithoutWrites,
    testSaveRereadsPurgeClaimInsideTransaction,
    testGetUsesDeterministicProfileWithoutCoachOrShopFallback,
    testGetReturnsPhoneOnlyAfterVerification,
    testGetReturnsCompleteDeterministicProfileProjection,
    testGetRejectsIncompleteIdentityChain,
    testDataServiceForwardsVisibilityFields
  ];
  const failures = [];
  for (const test of tests) {
    try {
      await test();
    } catch (error) {
      failures.push(`${test.name}: ${error.message}`);
    }
  }
  if (failures.length) {
    throw new Error(`profile regressions:\n- ${failures.join('\n- ')}`);
  }
  console.log('saveUserProfile tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
