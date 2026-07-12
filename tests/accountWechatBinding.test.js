const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const root = path.resolve(__dirname, '..');
const accountAuthPath = path.resolve(__dirname, '..', 'cloudfunctions', 'accountAuth', 'index.js');
const dataServicePath = path.resolve(__dirname, '..', 'miniprogram', 'services', 'data.js');
const appPath = path.resolve(__dirname, '..', 'miniprogram', 'app.js');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeState(seed) {
  const source = seed || {};
  source.accounts = Array.isArray(source.accounts) ? source.accounts : [];
  source.wechat_bindings = Array.isArray(source.wechat_bindings) ? source.wechat_bindings : [];
  source.users = Array.isArray(source.users) ? source.users : [];
  return source;
}

function snapshot(state) {
  return clone({
    accounts: state.accounts,
    wechat_bindings: state.wechat_bindings,
    users: state.users
  });
}

function findById(collection, id) {
  return collection.find((item) => item._id === id);
}

function findAccount(state, account) {
  const normalized = String(account || '').trim().toLowerCase();
  return state.accounts.find((item) => item.accountNormalized === normalized);
}

function findBinding(state, openid) {
  return findById(state.wechat_bindings, sha256(`wechat:${openid}`));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function matches(document, query) {
  return Object.keys(query || {}).every((key) => {
    const expected = query[key];
    if (expected && typeof expected === 'object' && Array.isArray(expected.$in)) {
      return expected.$in.indexOf(document[key]) !== -1;
    }
    return document[key] === expected;
  });
}

function makeDatabase(state, options) {
  const root = {
    failNextRead: false,
    failNextWrite: false,
    beforeTransaction: null,
    throwOnNotFound: !options || options.throwOnNotFound !== false
  };

  function createFacade(targetState, transactionMode) {
    function maybeFailRead() {
      if (root.failNextRead) {
        root.failNextRead = false;
        throw new Error('simulated read failure');
      }
    }

    function maybeFailWrite() {
      if (root.failNextWrite) {
        root.failNextWrite = false;
        throw new Error('simulated write failure');
      }
    }

    function collection(name) {
      const documents = targetState[name] || (targetState[name] = []);

      return {
        doc(id) {
          return {
            async get() {
              maybeFailRead();
              const document = findById(documents, id);
              if (!document && root.throwOnNotFound) {
                throw new Error(`document with _id ${id} does not exist`);
              }
              return { data: clone(document || null) };
            },
            async set({ data }) {
              maybeFailWrite();
              if (Object.prototype.hasOwnProperty.call(data, '_id')) {
                throw new Error('-501007 不能更新_id的值');
              }
              const next = Object.assign({}, clone(data), { _id: id });
              const index = documents.findIndex((item) => item._id === id);
              if (index === -1) documents.push(next);
              else documents[index] = next;
              return { _id: id };
            },
            async update({ data }) {
              maybeFailWrite();
              const index = documents.findIndex((item) => item._id === id);
              if (index === -1) throw new Error(`document ${id} does not exist`);
              documents[index] = Object.assign({}, documents[index], clone(data), { _id: id });
              return { stats: { updated: 1 } };
            }
          };
        },
        where(query) {
          return {
            async get() {
              return { data: clone(documents.filter((item) => matches(item, query))) };
            }
          };
        },
        async add({ data }) {
          maybeFailWrite();
          const id = data._id || `${name}_${documents.length + 1}`;
          documents.push(Object.assign({}, clone(data), { _id: id }));
          return { _id: id };
        }
      };
    }

    return {
      collection,
      serverDate() {
        return 'server-date';
      },
      async runTransaction(callback) {
        if (transactionMode) throw new Error('nested transactions are unsupported');
        const workingState = clone(targetState);
        const beforeTransaction = root.beforeTransaction;
        root.beforeTransaction = null;
        if (beforeTransaction) beforeTransaction(workingState);
        const result = await callback(createFacade(workingState, true));
        Object.keys(targetState).forEach((key) => {
          if (Array.isArray(targetState[key])) targetState[key] = workingState[key] || [];
        });
        Object.keys(workingState).forEach((key) => {
          if (Array.isArray(workingState[key]) && !Object.prototype.hasOwnProperty.call(targetState, key)) {
            targetState[key] = workingState[key];
          }
        });
        return result;
      }
    };
  }

  const database = createFacade(state, false);
  Object.defineProperty(database, 'failNextRead', {
    get() {
      return root.failNextRead;
    },
    set(value) {
      root.failNextRead = Boolean(value);
    }
  });
  Object.defineProperty(database, 'failNextWrite', {
    get() {
      return root.failNextWrite;
    },
    set(value) {
      root.failNextWrite = Boolean(value);
    }
  });
  Object.defineProperty(database, 'beforeTransaction', {
    get() {
      return root.beforeTransaction;
    },
    set(value) {
      root.beforeTransaction = value;
    }
  });
  return database;
}

let fakeDb;

function loadAccountAuth(openid, seed, unionid) {
  const state = makeState(seed);
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database(options) {
      fakeDb = makeDatabase(state, options);
      return fakeDb;
    },
    getWXContext() {
      return { OPENID: openid, UNIONID: unionid || '' };
    }
  };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'wx-server-sdk') return fakeCloud;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(accountAuthPath)];
    return require(accountAuthPath);
  } finally {
    Module._load = originalLoad;
  }
}

function loadDataService(options) {
  const config = options || {};
  const calls = [];
  const storage = {};
  const app = {
    globalData: Object.assign({
      cloudReady: config.cloudReady !== false,
      account: '',
      roles: [],
      currentRole: '',
      openid: ''
    }, config.globalData || {})
  };
  global.getApp = () => app;
  global.wx = {
    cloud: config.withCloud === false ? null : {
      callFunction({ name, data }) {
        calls.push({ name, data });
        const result = config.resultForAction
          ? config.resultForAction(data && data.action, name, data)
          : { ok: true };
        return Promise.resolve({ result });
      }
    },
    getStorageSync(key) {
      return storage[key];
    },
    setStorageSync(key, value) {
      storage[key] = value;
    },
    removeStorageSync(key) {
      delete storage[key];
    },
    showToast() {}
  };
  delete require.cache[require.resolve(dataServicePath)];
  return { data: require(dataServicePath), app, calls, storage };
}

async function testClientAuthDelegatesAndSynchronizesState() {
  const fixture = loadDataService({
    resultForAction(action) {
      if (action === 'probe') return { ok: true, cloudReady: true };
      return {
        ok: true,
        account: 'MemberA',
        roles: ['member', 'coach'],
        currentRole: 'coach'
      };
    }
  });

  await fixture.data.registerAccount({ account: 'MemberA', password: '123456' });
  await fixture.data.loginWithPassword({ account: 'MemberA', password: '123456' });
  await fixture.data.loginWithWechat();
  await fixture.data.getAccountSecurity();
  const stateBeforeProbe = clone(fixture.app.globalData);
  await fixture.data.probeAuthCloud();

  assert.deepStrictEqual(fixture.calls, [
    { name: 'accountAuth', data: { action: 'register', account: 'MemberA', password: '123456' } },
    { name: 'accountAuth', data: { action: 'passwordLogin', account: 'MemberA', password: '123456' } },
    { name: 'accountAuth', data: { action: 'wechatLogin' } },
    { name: 'accountAuth', data: { action: 'status' } },
    { name: 'accountAuth', data: { action: 'probe' } }
  ]);
  assert.strictEqual(fixture.app.globalData.account, 'MemberA');
  assert.deepStrictEqual(fixture.app.globalData.roles, ['member', 'coach']);
  assert.strictEqual(fixture.app.globalData.currentRole, 'coach');
  assert.strictEqual(fixture.app.globalData.openid, '');
  assert.strictEqual(fixture.storage.dc_account_name, 'MemberA');
  assert.strictEqual(fixture.storage.dc_accounts, undefined);
  assert.strictEqual(fixture.storage.dc_wechat_bindings, undefined);
  assert.deepStrictEqual(fixture.app.globalData, stateBeforeProbe);
}

async function testClientAuthPinsPublicMethodActions() {
  const fixture = loadDataService({
    resultForAction() {
      return { ok: true, account: 'MemberA', roles: ['member'], currentRole: 'member' };
    }
  });

  await fixture.data.registerAccount({
    action: 'wechatLogin',
    account: 'MemberA',
    password: '123456'
  });
  await fixture.data.loginWithPassword({
    action: 'register',
    account: 'MemberA',
    password: '123456'
  });

  assert.deepStrictEqual(fixture.calls, [
    {
      name: 'accountAuth',
      data: { action: 'register', account: 'MemberA', password: '123456' }
    },
    {
      name: 'accountAuth',
      data: { action: 'passwordLogin', account: 'MemberA', password: '123456' }
    }
  ]);
}

async function testClientAuthFailsClosed() {
  const unavailable = loadDataService({ cloudReady: false });
  await assert.rejects(
    () => unavailable.data.loginWithWechat(),
    (error) => error.code === 'CLOUD_NOT_READY'
  );
  assert.strictEqual(unavailable.calls.length, 0);
  assert.strictEqual(unavailable.app.globalData.openid, '');

  const rejected = loadDataService({
    resultForAction() {
      return { ok: false, code: 'WECHAT_NOT_BOUND', msg: 'not bound' };
    }
  });
  await assert.rejects(
    () => rejected.data.loginWithWechat(),
    (error) => error.code === 'WECHAT_NOT_BOUND' && error.result.code === 'WECHAT_NOT_BOUND'
  );
  assert.strictEqual(rejected.app.globalData.account, '');
}

async function testAppUsesSideEffectFreeAuthProbe() {
  const calls = [];
  let appDefinition;
  global.App = (definition) => {
    appDefinition = definition;
  };
  global.wx = {
    cloud: {
      callFunction(input) {
        calls.push(input);
        return Promise.resolve({ result: { ok: true, cloudReady: true } });
      }
    }
  };
  delete require.cache[require.resolve(appPath)];
  require(appPath);
  let refreshCount = 0;
  appDefinition.refreshBilling = () => {
    refreshCount += 1;
  };

  appDefinition.probeCloud();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepStrictEqual(calls, [
    { name: 'accountAuth', data: { action: 'probe' } }
  ]);
  assert.strictEqual(appDefinition.globalData.cloudReady, true);
  assert.strictEqual(appDefinition.globalData.account, '');
  assert.strictEqual(refreshCount, 1);

  appDefinition.globalData.cloudReady = true;
  delete global.wx.cloud;
  appDefinition.probeCloud();
  assert.strictEqual(appDefinition.globalData.cloudReady, false);

  appDefinition.globalData.cloudReady = true;
  appDefinition.globalData.cloudEnv = '';
  global.wx.cloud = {
    callFunction() {
      throw new Error('should not call without cloud env');
    }
  };
  appDefinition.probeCloud();
  assert.strictEqual(appDefinition.globalData.cloudReady, false);

  appDefinition.globalData.cloudReady = true;
  appDefinition.globalData.cloudEnv = 'test-env';
  global.wx.cloud.callFunction = () => Promise.reject(new Error('probe rejected'));
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    appDefinition.probeCloud();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    console.warn = originalWarn;
  }
  assert.strictEqual(appDefinition.globalData.cloudReady, false);
}

async function run() {
  const projectConfig = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'));
  assert.strictEqual(projectConfig.appid, 'wxa7c9920cda26d7ca');

  const setSemanticsState = makeState();
  const setSemanticsDb = makeDatabase(setSemanticsState, { throwOnNotFound: false });
  const setSemanticsBefore = snapshot(setSemanticsState);
  await assert.rejects(
    setSemanticsDb.collection('accounts').doc('path-account').set({
      data: { _id: 'payload-account', account: 'MemberSet' }
    }),
    (error) => error.message.includes('-501007') && error.message.includes('不能更新_id的值')
  );
  assert.deepStrictEqual(snapshot(setSemanticsState), setSemanticsBefore);
  await setSemanticsDb.collection('accounts').doc('path-account').set({
    data: { account: 'MemberSet' }
  });
  assert.deepStrictEqual(findById(setSemanticsState.accounts, 'path-account'), {
    account: 'MemberSet',
    _id: 'path-account'
  });

  const seed = makeState();
  const state = seed;

  const probeBefore = snapshot(state);
  assert.deepStrictEqual(
    await loadAccountAuth('wechat_probe', state).main({ action: 'probe' }),
    { ok: true, cloudReady: true }
  );
  assert.deepStrictEqual(snapshot(state), probeBefore);

  const reserved = await loadAccountAuth('wechat_X', state).main({
    action: 'register', account: 'admin_zhx', password: '123456'
  });
  assert.strictEqual(reserved.code, 'INVALID_INPUT');
  assert.strictEqual(findAccount(state, 'admin_zhx'), undefined);
  assert.strictEqual(findBinding(state, 'wechat_X'), undefined);

  const orphanRegisterState = makeState({
    users: [{
      _id: sha256('wechat:wechat_orphan_register'),
      _openid: 'wechat_orphan_register',
      roles: ['shop'],
      currentRole: 'shop'
    }]
  });
  const orphanRegisterBefore = snapshot(orphanRegisterState);
  const orphanRegister = await loadAccountAuth('wechat_orphan_register', orphanRegisterState).main({
    action: 'register', account: 'MemberOrphanRegister', password: '123456'
  });
  assert.strictEqual(orphanRegister.code, 'ACCOUNT_NOT_BOUND');
  assert.deepStrictEqual(snapshot(orphanRegisterState), orphanRegisterBefore);

  const unboundState = makeState();
  const unboundSalt = '11'.repeat(16);
  unboundState.accounts.push({
    _id: sha256('account:memberu'),
    account: 'MemberU',
    accountNormalized: 'memberu',
    passwordAlgorithm: 'scrypt-v1',
    passwordSalt: unboundSalt,
    passwordHash: crypto.scryptSync('123456', Buffer.from(unboundSalt, 'hex'), 64).toString('hex'),
    status: 'active'
  });
  const firstPasswordBinding = await loadAccountAuth('wechat_U', unboundState).main({
    action: 'passwordLogin', account: 'MemberU', password: '123456'
  });
  assert.strictEqual(firstPasswordBinding.ok, true);
  assert.strictEqual(findAccount(unboundState, 'MemberU')._openid, 'wechat_U');
  assert.strictEqual(findBinding(unboundState, 'wechat_U').accountId, sha256('account:memberu'));
  assert.deepStrictEqual(firstPasswordBinding.roles, ['member']);

  const transactionSalt = '33'.repeat(16);
  const transactionSeed = makeState({
    accounts: [{
      _id: sha256('account:membert'),
      account: 'MemberT',
      accountNormalized: 'membert',
      passwordAlgorithm: 'scrypt-v1',
      passwordSalt: transactionSalt,
      passwordHash: crypto.scryptSync('123456', Buffer.from(transactionSalt, 'hex'), 64).toString('hex'),
      status: 'active'
    }]
  });

  const transactionMissingState = makeState(snapshot(transactionSeed));
  const transactionMissingModule = loadAccountAuth('wechat_T_missing', transactionMissingState);
  fakeDb.beforeTransaction = (workingState) => {
    workingState.accounts = [];
  };
  const transactionMissingBefore = snapshot(transactionMissingState);
  const transactionMissing = await transactionMissingModule.main({
    action: 'passwordLogin', account: 'MemberT', password: '123456'
  });
  assert.strictEqual(transactionMissing.code, 'ACCOUNT_NOT_FOUND');
  assert.deepStrictEqual(snapshot(transactionMissingState), transactionMissingBefore);

  const transactionInvalidState = makeState(snapshot(transactionSeed));
  const transactionInvalidModule = loadAccountAuth('wechat_T_invalid', transactionInvalidState);
  fakeDb.beforeTransaction = (workingState) => {
    findById(workingState.accounts, sha256('account:membert')).accountNormalized = 'different';
  };
  const transactionInvalidBefore = snapshot(transactionInvalidState);
  const transactionInvalid = await transactionInvalidModule.main({
    action: 'passwordLogin', account: 'MemberT', password: '123456'
  });
  assert.strictEqual(transactionInvalid.code, 'ACCOUNT_NOT_BOUND');
  assert.deepStrictEqual(snapshot(transactionInvalidState), transactionInvalidBefore);

  const transactionPasswordState = makeState(snapshot(transactionSeed));
  const transactionPasswordModule = loadAccountAuth('wechat_T_password', transactionPasswordState);
  fakeDb.beforeTransaction = (workingState) => {
    findById(workingState.accounts, sha256('account:membert')).passwordHash = '00'.repeat(64);
  };
  const transactionPasswordBefore = snapshot(transactionPasswordState);
  const transactionPassword = await transactionPasswordModule.main({
    action: 'passwordLogin', account: 'MemberT', password: '123456'
  });
  assert.strictEqual(transactionPassword.code, 'INVALID_PASSWORD');
  assert.deepStrictEqual(snapshot(transactionPasswordState), transactionPasswordBefore);

  const orphanPasswordState = makeState();
  const orphanPasswordSalt = '22'.repeat(16);
  orphanPasswordState.accounts.push({
    _id: sha256('account:memberorphanpassword'),
    account: 'MemberOrphanPassword',
    accountNormalized: 'memberorphanpassword',
    passwordAlgorithm: 'scrypt-v1',
    passwordSalt: orphanPasswordSalt,
    passwordHash: crypto.scryptSync('123456', Buffer.from(orphanPasswordSalt, 'hex'), 64).toString('hex'),
    status: 'active'
  });
  orphanPasswordState.users.push({
    _id: sha256('wechat:wechat_orphan_password'),
    _openid: 'wechat_orphan_password',
    roles: ['member'],
    currentRole: 'member'
  });
  const orphanPasswordBefore = snapshot(orphanPasswordState);
  const orphanPassword = await loadAccountAuth('wechat_orphan_password', orphanPasswordState).main({
    action: 'passwordLogin', account: 'MemberOrphanPassword', password: '123456'
  });
  assert.strictEqual(orphanPassword.code, 'ACCOUNT_NOT_BOUND');
  assert.deepStrictEqual(snapshot(orphanPasswordState), orphanPasswordBefore);

  const first = await loadAccountAuth('wechat_A', seed, 'union_A').main({
    action: 'register',
    account: 'MemberA',
    password: '123456'
  });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.account, 'MemberA');
  assert.deepStrictEqual(first.roles, ['member']);
  assert.strictEqual(first.currentRole, 'member');
  assert.strictEqual(first.wechatBound, true);

  const accountDoc = findById(state.accounts, sha256('account:membera'));
  assert(accountDoc.passwordHash);
  assert(accountDoc.passwordSalt);
  assert.strictEqual(accountDoc.passwordAlgorithm, 'scrypt-v1');
  assert.strictEqual(accountDoc.password, undefined);
  assert.notStrictEqual(accountDoc.passwordHash, '123456');
  assert.strictEqual(accountDoc._openid, 'wechat_A');

  const bindingDoc = findBinding(state, 'wechat_A');
  assert.strictEqual(bindingDoc.accountId, sha256('account:membera'));
  assert.strictEqual(bindingDoc.unionidHash, sha256('unionid:union_A'));
  assert.strictEqual(findById(state.users, sha256('wechat:wechat_A')).role, 'member');

  const resumed = await loadAccountAuth('wechat_A', state).main({ action: 'wechatLogin' });
  assert.strictEqual(resumed.ok, true);
  assert.strictEqual(resumed.account, 'MemberA');

  const tamperedRoleState = makeState(snapshot(state));
  const tamperedRoleUser = findById(tamperedRoleState.users, sha256('wechat:wechat_A'));
  tamperedRoleUser.roles = ['member'];
  tamperedRoleUser.currentRole = 'shop';
  tamperedRoleUser.role = 'shop';
  const tamperedRole = await loadAccountAuth('wechat_A', tamperedRoleState).main({ action: 'wechatLogin' });
  assert.deepStrictEqual(tamperedRole.roles, ['member']);
  assert.strictEqual(tamperedRole.currentRole, 'member');

  const tamperedBindingState = makeState(snapshot(state));
  findBinding(tamperedBindingState, 'wechat_A').account = 'DifferentAccount';
  const tamperedBindingBefore = snapshot(tamperedBindingState);
  const tamperedBinding = await loadAccountAuth('wechat_A', tamperedBindingState).main({
    action: 'passwordLogin', account: 'MemberA', password: '123456'
  });
  assert.strictEqual(tamperedBinding.code, 'ACCOUNT_NOT_BOUND');
  assert.deepStrictEqual(snapshot(tamperedBindingState), tamperedBindingBefore);

  const tamperedWechatState = makeState(snapshot(state));
  findBinding(tamperedWechatState, 'wechat_A').account = 'DifferentAccount';
  const tamperedWechatBefore = snapshot(tamperedWechatState);
  const tamperedWechat = await loadAccountAuth('wechat_A', tamperedWechatState).main({
    action: 'wechatLogin'
  });
  assert.strictEqual(tamperedWechat.code, 'ACCOUNT_NOT_BOUND');
  assert.deepStrictEqual(snapshot(tamperedWechatState), tamperedWechatBefore);

  const passwordLogin = await loadAccountAuth('wechat_A', state).main({
    action: 'passwordLogin', account: 'MemberA', password: '123456'
  });
  assert.strictEqual(passwordLogin.ok, true);
  assert.strictEqual(passwordLogin.account, 'MemberA');

  const malformedAccountState = makeState(snapshot(state));
  findById(malformedAccountState.accounts, sha256('account:membera')).accountNormalized = 'different';
  const malformedAccountBefore = snapshot(malformedAccountState);
  const malformedAccount = await loadAccountAuth('wechat_A', malformedAccountState).main({
    action: 'passwordLogin', account: 'MemberA', password: '123456'
  });
  assert.strictEqual(malformedAccount.code, 'ACCOUNT_NOT_BOUND');
  assert.deepStrictEqual(snapshot(malformedAccountState), malformedAccountBefore);

  const wrongPasswordBefore = snapshot(state);
  const wrongPassword = await loadAccountAuth('wechat_A', state).main({
    action: 'passwordLogin', account: 'MemberA', password: 'bad-password'
  });
  assert.strictEqual(wrongPassword.code, 'INVALID_PASSWORD');
  assert.strictEqual(wrongPassword.msg, '账号密码错误');
  assert.deepStrictEqual(snapshot(state), wrongPasswordBefore);

  const nonStringPasswordBefore = snapshot(state);
  const nonStringPassword = await loadAccountAuth('wechat_A', state).main({
    action: 'passwordLogin', account: 'MemberA', password: 123456
  });
  assert.strictEqual(nonStringPassword.code, 'INVALID_PASSWORD');
  assert.strictEqual(nonStringPassword.msg, '账号密码错误');
  assert.deepStrictEqual(snapshot(state), nonStringPasswordBefore);

  const missingAccountBefore = snapshot(state);
  const missingAccount = await loadAccountAuth('wechat_A', state).main({
    action: 'passwordLogin', account: 'MissingA', password: '123456'
  });
  assert.strictEqual(missingAccount.code, 'ACCOUNT_NOT_FOUND');
  assert.strictEqual(missingAccount.msg, '账号未注册');
  assert.deepStrictEqual(snapshot(state), missingAccountBefore);

  const secondWechat = await loadAccountAuth('wechat_B', state).main({
    action: 'passwordLogin', account: 'MemberA', password: '123456'
  });
  assert.strictEqual(secondWechat.code, 'ACCOUNT_ALREADY_BOUND');

  const secondAccount = await loadAccountAuth('wechat_A', state).main({
    action: 'register', account: 'MemberB', password: '123456'
  });
  assert.strictEqual(secondAccount.code, 'WECHAT_ALREADY_BOUND');

  const duplicateAccount = await loadAccountAuth('wechat_B', state).main({
    action: 'register', account: 'MemberA', password: '123456'
  });
  assert.strictEqual(duplicateAccount.code, 'ACCOUNT_EXISTS');

  const unknownBefore = snapshot(state);
  const unknownWechat = await loadAccountAuth('wechat_C', state).main({ action: 'wechatLogin' });
  assert.strictEqual(unknownWechat.code, 'WECHAT_NOT_BOUND');
  assert.deepStrictEqual(snapshot(state), unknownBefore);

  const boundUser = findById(state.users, sha256('wechat:wechat_A'));
  boundUser.phone = '13800138000';
  const status = await loadAccountAuth('wechat_A', state).main({ action: 'status' });
  assert.strictEqual(status.ok, true);
  assert.strictEqual(status.account, 'MemberA');
  assert.strictEqual(status.passwordSet, true);
  assert.strictEqual(status.phone, '');
  ['passwordHash', 'passwordSalt', '_openid', 'unionidHash'].forEach((field) => {
    assert.strictEqual(status[field], undefined);
  });

  boundUser.phoneVerifiedAt = 1710000000000;
  const verifiedStatus = await loadAccountAuth('wechat_A', state).main({ action: 'status' });
  assert.strictEqual(verifiedStatus.phone, '13800138000');

  const inconsistentState = makeState(snapshot(state));
  findBinding(inconsistentState, 'wechat_A')._openid = 'wechat_other';
  const inconsistentBefore = snapshot(inconsistentState);
  const inconsistent = await loadAccountAuth('wechat_A', inconsistentState).main({
    action: 'passwordLogin', account: 'MemberA', password: '123456'
  });
  assert.strictEqual(inconsistent.code, 'ACCOUNT_NOT_BOUND');
  assert.deepStrictEqual(snapshot(inconsistentState), inconsistentBefore);

  const readFailureState = makeState();
  const readFailureBefore = snapshot(readFailureState);
  const readFailureModule = loadAccountAuth('wechat_read_failure', readFailureState);
  fakeDb.failNextRead = true;
  const readFailureConsoleError = console.error;
  console.error = () => {};
  let readFailure;
  try {
    readFailure = await readFailureModule.main({
      action: 'register', account: 'MemberR', password: '123456'
    });
  } finally {
    console.error = readFailureConsoleError;
  }
  assert.strictEqual(readFailure.code, 'AUTH_INTERNAL_ERROR');
  assert.deepStrictEqual(snapshot(readFailureState), readFailureBefore);

  fakeDb = null;
  const rollbackModule = loadAccountAuth('wechat_D', state);
  fakeDb.failNextWrite = true;
  const originalConsoleError = console.error;
  console.error = () => {};
  let rolledBack;
  try {
    rolledBack = await rollbackModule.main({
      action: 'register', account: 'MemberD', password: '123456'
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert.strictEqual(rolledBack.code, 'AUTH_INTERNAL_ERROR');
  assert.strictEqual(findAccount(state, 'MemberD'), undefined);
  assert.strictEqual(findBinding(state, 'wechat_D'), undefined);

  await testClientAuthDelegatesAndSynchronizesState();
  await testClientAuthPinsPublicMethodActions();
  await testClientAuthFailsClosed();
  await testAppUsesSideEffectFreeAuthProbe();

  console.log('accountWechatBinding tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
