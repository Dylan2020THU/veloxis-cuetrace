const assert = require('assert');
const crypto = require('crypto');
const Module = require('module');
const path = require('path');

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

function makeDatabase(state) {
  const root = {
    failNextRead: false,
    failNextWrite: false
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
              return { data: clone(findById(documents, id) || null) };
            },
            async set({ data }) {
              maybeFailWrite();
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
  return database;
}

let fakeDb;

function loadAccountAuth(openid, seed, unionid) {
  const state = makeState(seed);
  fakeDb = makeDatabase(state);
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database() {
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
}

async function run() {
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

  const passwordLogin = await loadAccountAuth('wechat_A', state).main({
    action: 'passwordLogin', account: 'MemberA', password: '123456'
  });
  assert.strictEqual(passwordLogin.ok, true);
  assert.strictEqual(passwordLogin.account, 'MemberA');

  const wrongPassword = await loadAccountAuth('wechat_A', state).main({
    action: 'passwordLogin', account: 'MemberA', password: 'bad-password'
  });
  assert.strictEqual(wrongPassword.code, 'INVALID_CREDENTIALS');

  const missingAccount = await loadAccountAuth('wechat_A', state).main({
    action: 'passwordLogin', account: 'MissingA', password: '123456'
  });
  assert.strictEqual(missingAccount.code, 'INVALID_CREDENTIALS');

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

  const status = await loadAccountAuth('wechat_A', state).main({ action: 'status' });
  assert.strictEqual(status.ok, true);
  assert.strictEqual(status.account, 'MemberA');
  assert.strictEqual(status.passwordSet, true);
  assert.strictEqual(status.phone, '');
  ['passwordHash', 'passwordSalt', '_openid', 'unionidHash'].forEach((field) => {
    assert.strictEqual(status[field], undefined);
  });

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
  await testClientAuthFailsClosed();
  await testAppUsesSideEffectFreeAuthProbe();

  console.log('accountWechatBinding tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
