const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const configPath = path.join(root, 'miniprogram/config/auth.js');
const sessionPath = path.join(root, 'miniprogram/services/auth-session.js');
const dataPath = path.join(root, 'miniprogram/services/data.js');
const mockPath = path.join(root, 'miniprogram/utils/mock.js');
const appPath = path.join(root, 'miniprogram/app.js');

const EXPECTED_CONFIG = Object.freeze({
  AUTH_PROTOCOL: 2,
  TERMS_VERSION: '2026-07-15',
  PRIVACY_VERSION: '2026-07-15',
  SESSION_STORAGE_KEY: 'cuetrace_auth_v2_session',
  CLIENT_INSTANCE_STORAGE_KEY: 'cuetrace_auth_v2_client',
  MIGRATION_STORAGE_KEY: 'cuetrace_auth_v2_migrated'
});
const LEGACY_AUTH_KEYS = Object.freeze([
  'openid',
  'role',
  'dc_role',
  'dc_account_name',
  'dc_accounts',
  'dc_wechat_bindings'
]);

function fresh(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function clearClientModules() {
  [dataPath, sessionPath, configPath, mockPath].forEach((modulePath) => {
    try {
      delete require.cache[require.resolve(modulePath)];
    } catch (_) {}
  });
}

function token(byte, version = 'K1') {
  return `v2.${version}.${Buffer.alloc(32, byte).toString('base64url')}`;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function makeRuntime(options) {
  const config = options || {};
  const storage = Object.assign({}, config.storage || {});
  const calls = [];
  const removals = [];
  const writes = [];
  const reLaunch = [];
  const modals = [];
  const updateCalls = [];
  const app = {
    globalData: Object.assign({
      cloudReady: true,
      account: '',
      accountDisplay: '',
      roles: [],
      currentRole: '',
      role: '',
      openid: '',
      authWriteBlocked: false,
      authRolePickerRequired: false
    }, config.globalData || {})
  };
  let randomCalls = 0;
  let cloudResponder = config.cloudResponder || (() => Promise.resolve({
    result: { ok: true }
  }));
  global.getApp = () => app;
  global.wx = {
    cloud: config.withCloud === false ? undefined : {
      callFunction(request) {
        calls.push(clone(request));
        return cloudResponder(request);
      }
    },
    getStorageSync(key) {
      if (config.storageReadError) throw config.storageReadError;
      return storage[key];
    },
    setStorageSync(key, value) {
      if (config.storageWriteError) throw config.storageWriteError;
      storage[key] = clone(value);
      writes.push([key, clone(value)]);
    },
    removeStorageSync(key) {
      if (config.storageRemoveError) throw config.storageRemoveError;
      delete storage[key];
      removals.push(key);
    },
    getRandomValues(input) {
      randomCalls += 1;
      if (config.randomError) throw config.randomError;
      assert.deepStrictEqual(input, { length: 32 });
      const bytes = config.randomBytes
        ? Uint8Array.from(config.randomBytes)
        : Uint8Array.from({ length: 32 }, (_, index) => index);
      const buffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      );
      return config.directRandomBuffer ? buffer : { randomValues: buffer };
    },
    reLaunch(input) {
      reLaunch.push(clone(input));
    },
    showModal(input) {
      modals.push(clone(input));
    },
    getUpdateManager() {
      updateCalls.push('getUpdateManager');
      return {
        onCheckForUpdate(handler) {
          updateCalls.push('onCheckForUpdate');
          if (typeof handler === 'function') handler({ hasUpdate: true });
        },
        onUpdateReady(handler) {
          updateCalls.push('onUpdateReady');
          if (typeof handler === 'function') handler();
        },
        applyUpdate() {
          updateCalls.push('applyUpdate');
        }
      };
    },
    showToast() {}
  };
  return {
    app,
    calls,
    storage,
    removals,
    writes,
    reLaunch,
    modals,
    updateCalls,
    setCloudResponder(next) {
      cloudResponder = next;
    },
    randomCallCount() {
      return randomCalls;
    }
  };
}

function loadSessionFixture(options) {
  const runtime = makeRuntime(options);
  clearClientModules();
  const authConfig = fresh(configPath);
  const authSession = fresh(sessionPath);
  return { ...runtime, authConfig, authSession };
}

function loadDataFixture(options) {
  const runtime = makeRuntime(options);
  clearClientModules();
  const authConfig = fresh(configPath);
  const authSession = fresh(sessionPath);
  const data = fresh(dataPath);
  return { ...runtime, authConfig, authSession, data };
}

function issued(sessionToken, overrides) {
  return Object.assign({
    ok: true,
    kind: 'session_issued',
    sessionToken,
    account: 'member_a',
    accountDisplay: 'member_a',
    roles: ['member'],
    currentRole: 'member'
  }, overrides || {});
}

function installSession(fixture, sessionToken, overrides) {
  const attempt = fixture.authSession.beginAuthAttempt('fixture');
  assert.strictEqual(
    fixture.authSession.commitAuthResult(attempt, issued(sessionToken, overrides)),
    true
  );
}

function safeError(error, code, forbiddenValues) {
  if (!error || error.code !== code) return false;
  const ownKeys = Object.keys(error);
  if (ownKeys.some((key) => key !== 'code')) return false;
  if (
    ['result', 'response', 'request', 'raw', 'cause'].some(
      (key) => Object.prototype.hasOwnProperty.call(error, key)
    )
  ) {
    return false;
  }
  const visible = [
    String(error),
    typeof error.stack === 'string' ? error.stack : '',
    JSON.stringify(error)
  ].join('\n');
  return (forbiddenValues || []).every(
    (value) => !visible.includes(String(value))
  );
}

async function rejectsCode(promiseFactory, code, forbiddenValues) {
  await assert.rejects(
    promiseFactory,
    (error) => safeError(error, code, forbiddenValues)
  );
}

function testConfigAndStableClientInstance() {
  const fixture = loadSessionFixture();
  assert.deepStrictEqual(fixture.authConfig, EXPECTED_CONFIG);
  assert.deepStrictEqual(
    Object.keys(fixture.authConfig).sort(),
    Object.keys(EXPECTED_CONFIG).sort()
  );

  const expected = Buffer.from(
    Uint8Array.from({ length: 32 }, (_, index) => index)
  ).toString('hex');
  assert.strictEqual(fixture.authSession.getClientInstanceId(), expected);
  assert.strictEqual(fixture.authSession.getClientInstanceId(), expected);
  assert.strictEqual(fixture.storage[EXPECTED_CONFIG.CLIENT_INSTANCE_STORAGE_KEY], expected);
  assert.strictEqual(fixture.randomCallCount(), 1);

  const direct = loadSessionFixture({ directRandomBuffer: true });
  assert.strictEqual(direct.authSession.getClientInstanceId(), expected);

  const malformed = loadSessionFixture({
    storage: {
      [EXPECTED_CONFIG.CLIENT_INSTANCE_STORAGE_KEY]: 'A'.repeat(64)
    },
    randomBytes: new Array(32).fill(7)
  });
  assert.strictEqual(
    malformed.authSession.getClientInstanceId(),
    Buffer.alloc(32, 7).toString('hex')
  );
  assert.strictEqual(malformed.randomCallCount(), 1);

  const trailingNewline = loadSessionFixture({
    storage: {
      [EXPECTED_CONFIG.CLIENT_INSTANCE_STORAGE_KEY]: `${'a'.repeat(64)}\n`
    },
    randomBytes: new Array(32).fill(8)
  });
  assert.strictEqual(
    trailingNewline.authSession.getClientInstanceId(),
    Buffer.alloc(32, 8).toString('hex')
  );
  assert.strictEqual(trailingNewline.randomCallCount(), 1);

  const randomFailure = loadSessionFixture({
    randomError: new Error('provider detail must not escape')
  });
  assert.throws(
    () => randomFailure.authSession.getClientInstanceId(),
    (error) => (
      error.code === 'AUTH_INTERNAL_ERROR'
      && !error.message.includes('provider detail')
    )
  );

  const storageFailure = loadSessionFixture({
    storageWriteError: new Error('storage detail must not escape')
  });
  assert.throws(
    () => storageFailure.authSession.getClientInstanceId(),
    (error) => (
      error.code === 'AUTH_INTERNAL_ERROR'
      && !error.message.includes('storage detail')
    )
  );
}

function testSessionWhitelistCopiesAndCas() {
  const other = { draft: { value: 1 }, plan: 'paid', firstLoginAt: 1234 };
  const fixture = loadSessionFixture({ storage: other });
  const firstToken = token(1);
  const secondToken = token(2, 'K2');
  const attempt = fixture.authSession.beginAuthAttempt('sms');
  const response = issued(firstToken, {
    account: '',
    accountDisplay: '138****0000',
    roles: ['member', 'coach'],
    currentRole: 'coach',
    accountId: 'acct_secret',
    openid: 'openid_secret',
    password: 'secret',
    arbitrary: { secret: true }
  });
  assert.strictEqual(fixture.authSession.commitAuthResult(attempt, response), true);
  assert.strictEqual(fixture.authSession.commitAuthResult(attempt, response), false);
  const invalidAttempt = fixture.authSession.beginAuthAttempt('invalid-result');
  assert.strictEqual(
    fixture.authSession.commitAuthResult(
      invalidAttempt,
      issued(token(31), {
        roles: ['member', 'member'],
        currentRole: 'member'
      })
    ),
    false
  );

  const stored = fixture.storage[EXPECTED_CONFIG.SESSION_STORAGE_KEY];
  assert.deepStrictEqual(
    Object.keys(stored).sort(),
    ['account', 'accountDisplay', 'currentRole', 'roles', 'schemaVersion', 'sessionToken'].sort()
  );
  assert.deepStrictEqual(stored, {
    schemaVersion: 2,
    sessionToken: firstToken,
    account: '',
    accountDisplay: '138****0000',
    roles: ['member', 'coach'],
    currentRole: 'coach'
  });
  assert.strictEqual(JSON.stringify(stored).includes('acct_secret'), false);
  assert.deepStrictEqual(fixture.app.globalData.roles, ['member', 'coach']);
  assert.strictEqual(fixture.app.globalData.role, 'coach');
  assert.strictEqual(fixture.app.globalData.openid, '');

  const copy = fixture.authSession.getSession();
  copy.roles.push('shop');
  copy.accountDisplay = 'changed';
  assert.deepStrictEqual(fixture.authSession.getSession(), stored);

  assert.strictEqual(
    fixture.authSession.applySessionProjection(token(9), {
      account: 'stale',
      roles: ['shop'],
      currentRole: 'shop'
    }),
    false
  );
  assert.strictEqual(
    fixture.authSession.applySessionProjection(firstToken, {
      account: 'renamed',
      accountDisplay: 'Renamed',
      roles: ['member', 'coach'],
      currentRole: 'member',
      sessionToken: token(8),
      accountId: 'must_not_store'
    }),
    true
  );
  assert.strictEqual(fixture.authSession.getSession().sessionToken, firstToken);
  assert.strictEqual(fixture.authSession.getSession().account, 'renamed');

  assert.strictEqual(
    fixture.authSession.commitSessionRotation(token(9), {
      ok: true,
      kind: 'session_rotated',
      sessionToken: secondToken
    }),
    false
  );
  assert.strictEqual(
    fixture.authSession.commitSessionRotation(firstToken, {
      ok: true,
      kind: 'session_rotated',
      sessionToken: secondToken,
      account: 'rotated',
      accountDisplay: 'Rotated',
      roles: ['shop'],
      currentRole: 'shop',
      accountId: 'must_not_store'
    }),
    true
  );
  assert.strictEqual(fixture.authSession.getSession().sessionToken, secondToken);
  assert.strictEqual(fixture.authSession.clearSessionIfCurrent(firstToken), false);
  assert.strictEqual(fixture.authSession.clearSessionIfCurrent(secondToken), true);
  assert.strictEqual(fixture.authSession.getSession(), null);
  assert.strictEqual(fixture.storage.plan, 'paid');
  assert.deepStrictEqual(fixture.storage.draft, { value: 1 });
  assert.strictEqual(fixture.storage.firstLoginAt, 1234);
  assert.strictEqual(fixture.app.globalData.account, '');
  assert.strictEqual(fixture.app.globalData.currentRole, '');

  const malformedValues = [
    { schemaVersion: 1 },
    {
      schemaVersion: 2,
      sessionToken: 'v2.K1.not-canonical',
      account: '',
      accountDisplay: '',
      roles: ['member'],
      currentRole: 'member'
    },
    {
      schemaVersion: 2,
      sessionToken: `${token(3)}\n`,
      account: '',
      accountDisplay: '',
      roles: ['member'],
      currentRole: 'member'
    },
    {
      schemaVersion: 2,
      sessionToken: `v2.K1.${Buffer.alloc(31, 3).toString('base64url')}`,
      account: '',
      accountDisplay: '',
      roles: ['member'],
      currentRole: 'member'
    },
    {
      schemaVersion: 2,
      sessionToken: `v2.K1.${Buffer.alloc(33, 3).toString('base64url')}`,
      account: '',
      accountDisplay: '',
      roles: ['member'],
      currentRole: 'member'
    },
    {
      schemaVersion: 2,
      sessionToken: `${token(3).slice(0, -1)}B`,
      account: '',
      accountDisplay: '',
      roles: ['member'],
      currentRole: 'member'
    },
    {
      schemaVersion: 2,
      sessionToken: `${token(3)}=`,
      account: '',
      accountDisplay: '',
      roles: ['member'],
      currentRole: 'member'
    },
    {
      schemaVersion: 2,
      sessionToken: token(3),
      account: '',
      accountDisplay: '',
      roles: ['admin'],
      currentRole: 'admin'
    },
    {
      schemaVersion: 2,
      sessionToken: token(3),
      account: '',
      accountDisplay: '',
      roles: ['member'],
      currentRole: 'member',
      accountId: 'forbidden'
    }
  ];
  malformedValues.forEach((value) => {
    fixture.storage[EXPECTED_CONFIG.SESSION_STORAGE_KEY] = value;
    assert.strictEqual(fixture.authSession.getSession(), null);
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(
        fixture.storage,
        EXPECTED_CONFIG.SESSION_STORAGE_KEY
      ),
      false
    );
  });

  const failedWrite = loadSessionFixture({
    storageWriteError: new Error('storage unavailable'),
    globalData: {
      account: '',
      accountDisplay: '',
      roles: [],
      currentRole: '',
      role: '',
      openid: ''
    }
  });
  const failedAttempt = failedWrite.authSession.beginAuthAttempt('storage-failure');
  assert.strictEqual(
    failedWrite.authSession.commitAuthResult(
      failedAttempt,
      issued(token(28), {
        account: 'must-not-project',
        roles: ['shop'],
        currentRole: 'shop'
      })
    ),
    false
  );
  assert.strictEqual(failedWrite.authSession.getSession(), null);
  assert.strictEqual(failedWrite.app.globalData.account, '');
  assert.deepStrictEqual(failedWrite.app.globalData.roles, []);

  const silentWrite = loadSessionFixture();
  global.wx.setStorageSync = (key, value) => {
    if (key !== EXPECTED_CONFIG.SESSION_STORAGE_KEY) {
      silentWrite.storage[key] = clone(value);
    }
  };
  const silentAttempt = silentWrite.authSession.beginAuthAttempt('silent-write');
  assert.strictEqual(
    silentWrite.authSession.commitAuthResult(
      silentAttempt,
      issued(token(27), {
        account: 'must-not-project',
        roles: ['shop'],
        currentRole: 'shop'
      })
    ),
    false
  );
  assert.strictEqual(silentWrite.authSession.getSession(), null);
  assert.strictEqual(silentWrite.app.globalData.account, '');

  const silentCasWrite = loadSessionFixture();
  installSession(silentCasWrite, token(25), {
    account: 'original',
    accountDisplay: 'Original',
    roles: ['member'],
    currentRole: 'member'
  });
  global.wx.setStorageSync = () => {};
  assert.strictEqual(
    silentCasWrite.authSession.applySessionProjection(token(25), {
      account: 'must-not-project',
      accountDisplay: 'Must Not Project',
      roles: ['shop'],
      currentRole: 'shop'
    }),
    false
  );
  assert.strictEqual(
    silentCasWrite.authSession.commitSessionRotation(token(25), {
      ok: true,
      kind: 'session_rotated',
      sessionToken: token(24),
      account: 'must-not-rotate',
      accountDisplay: 'Must Not Rotate',
      roles: ['shop'],
      currentRole: 'shop'
    }),
    false
  );
  assert.strictEqual(silentCasWrite.authSession.getSession().sessionToken, token(25));
  assert.strictEqual(silentCasWrite.authSession.getSession().account, 'original');
  assert.strictEqual(silentCasWrite.app.globalData.account, 'original');

  const silentDelete = loadSessionFixture();
  installSession(silentDelete, token(26), {
    account: 'still-signed-in',
    roles: ['member'],
    currentRole: 'member'
  });
  global.wx.removeStorageSync = () => {};
  assert.strictEqual(
    silentDelete.authSession.clearSessionIfCurrent(token(26)),
    false
  );
  assert.strictEqual(
    silentDelete.authSession.getSession().sessionToken,
    token(26)
  );
  assert.strictEqual(silentDelete.app.globalData.account, 'still-signed-in');

  const writeThenReadFailure = loadSessionFixture();
  const writeThenReadOriginalGet = global.wx.getStorageSync;
  const writeThenReadOriginalSet = global.wx.setStorageSync;
  let failSessionReadOnce = false;
  global.wx.setStorageSync = (key, value) => {
    writeThenReadOriginalSet(key, value);
    if (key === EXPECTED_CONFIG.SESSION_STORAGE_KEY) {
      failSessionReadOnce = true;
    }
  };
  global.wx.getStorageSync = (key) => {
    if (
      key === EXPECTED_CONFIG.SESSION_STORAGE_KEY
      && failSessionReadOnce
    ) {
      failSessionReadOnce = false;
      throw new Error('post-write verification read failed');
    }
    return writeThenReadOriginalGet(key);
  };
  const uncertainAttempt = writeThenReadFailure.authSession.beginAuthAttempt(
    'write-then-read-failure'
  );
  assert.strictEqual(
    writeThenReadFailure.authSession.commitAuthResult(
      uncertainAttempt,
      issued(token(23), {
        account: 'must-roll-back',
        roles: ['shop'],
        currentRole: 'shop'
      })
    ),
    false
  );
  assert.strictEqual(writeThenReadFailure.authSession.getSession(), null);
  assert.strictEqual(writeThenReadFailure.app.globalData.account, '');

  const rotationRollback = loadSessionFixture();
  installSession(rotationRollback, token(22), {
    account: 'before-rotation',
    accountDisplay: 'Before Rotation',
    roles: ['member'],
    currentRole: 'member'
  });
  const rotationOriginalGet = global.wx.getStorageSync;
  const rotationOriginalSet = global.wx.setStorageSync;
  let failRotationReadOnce = false;
  global.wx.setStorageSync = (key, value) => {
    rotationOriginalSet(key, value);
    if (
      key === EXPECTED_CONFIG.SESSION_STORAGE_KEY
      && value.sessionToken === token(21)
    ) {
      failRotationReadOnce = true;
    }
  };
  global.wx.getStorageSync = (key) => {
    if (
      key === EXPECTED_CONFIG.SESSION_STORAGE_KEY
      && failRotationReadOnce
    ) {
      failRotationReadOnce = false;
      throw new Error('rotation verification read failed');
    }
    return rotationOriginalGet(key);
  };
  assert.strictEqual(
    rotationRollback.authSession.commitSessionRotation(token(22), {
      ok: true,
      kind: 'session_rotated',
      sessionToken: token(21),
      account: 'after-rotation',
      accountDisplay: 'After Rotation',
      roles: ['shop'],
      currentRole: 'shop'
    }),
    false
  );
  assert.strictEqual(rotationRollback.authSession.getSession().sessionToken, token(22));
  assert.strictEqual(rotationRollback.authSession.getSession().account, 'before-rotation');
  assert.strictEqual(rotationRollback.app.globalData.account, 'before-rotation');

  const deleteRollback = loadSessionFixture();
  installSession(deleteRollback, token(20), {
    account: 'before-delete',
    roles: ['member'],
    currentRole: 'member'
  });
  const deleteOriginalGet = global.wx.getStorageSync;
  const deleteOriginalRemove = global.wx.removeStorageSync;
  let failDeleteReadOnce = false;
  global.wx.removeStorageSync = (key) => {
    deleteOriginalRemove(key);
    if (key === EXPECTED_CONFIG.SESSION_STORAGE_KEY) {
      failDeleteReadOnce = true;
    }
  };
  global.wx.getStorageSync = (key) => {
    if (
      key === EXPECTED_CONFIG.SESSION_STORAGE_KEY
      && failDeleteReadOnce
    ) {
      failDeleteReadOnce = false;
      throw new Error('post-delete verification read failed');
    }
    return deleteOriginalGet(key);
  };
  assert.strictEqual(
    deleteRollback.authSession.clearSessionIfCurrent(token(20)),
    false
  );
  assert.strictEqual(deleteRollback.authSession.getSession().sessionToken, token(20));
  assert.strictEqual(deleteRollback.app.globalData.account, 'before-delete');
}

function testAttemptLifecycleAndMigration() {
  const fixture = loadSessionFixture({
    storage: {
      openid: 'legacy-openid',
      role: 'shop',
      dc_role: 'shop',
      dc_account_name: 'legacy-account',
      dc_accounts: [{ password: 'legacy' }],
      dc_wechat_bindings: { x: 'y' },
      dc_theme_mode: 'light',
      plan: 'paid',
      planExpiresAt: 9,
      billingDisplay: { amount: 1 },
      draft: { text: 'keep' },
      firstLoginAt: 456,
      [EXPECTED_CONFIG.CLIENT_INSTANCE_STORAGE_KEY]: '1'.repeat(64)
    }
  });
  const attemptA = fixture.authSession.beginAuthAttempt('sms');
  const attemptB = fixture.authSession.beginAuthAttempt('password');
  assert.strictEqual(
    fixture.authSession.commitAuthResult(attemptA, issued(token(1))),
    false
  );
  assert.strictEqual(fixture.authSession.cancelAuthAttempt(attemptA), false);
  assert.strictEqual(fixture.authSession.cancelAuthAttempt(attemptB), true);
  assert.strictEqual(
    fixture.authSession.commitAuthResult(attemptB, issued(token(2))),
    false
  );
  const forged = { generation: attemptB.generation, kind: 'sms' };
  assert.strictEqual(
    fixture.authSession.commitAuthResult(forged, issued(token(3))),
    false
  );

  assert.strictEqual(fixture.authSession.migrateLegacyAuthOnce(), true);
  assert.deepStrictEqual(fixture.removals, LEGACY_AUTH_KEYS);
  LEGACY_AUTH_KEYS.forEach((key) => {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(fixture.storage, key), false);
  });
  assert.strictEqual(fixture.storage[EXPECTED_CONFIG.MIGRATION_STORAGE_KEY], 2);
  assert.strictEqual(fixture.storage.dc_theme_mode, 'light');
  assert.strictEqual(fixture.storage.plan, 'paid');
  assert.strictEqual(fixture.storage.planExpiresAt, 9);
  assert.deepStrictEqual(fixture.storage.billingDisplay, { amount: 1 });
  assert.deepStrictEqual(fixture.storage.draft, { text: 'keep' });
  assert.strictEqual(fixture.storage.firstLoginAt, 456);
  assert.strictEqual(
    fixture.storage[EXPECTED_CONFIG.CLIENT_INSTANCE_STORAGE_KEY],
    '1'.repeat(64)
  );
  assert.strictEqual(fixture.authSession.migrateLegacyAuthOnce(), false);
  assert.deepStrictEqual(fixture.removals, LEGACY_AUTH_KEYS);

  const preMigrated = loadSessionFixture({
    storage: {
      [EXPECTED_CONFIG.MIGRATION_STORAGE_KEY]: 2,
      unrelated: 'keep'
    }
  });
  assert.strictEqual(preMigrated.authSession.migrateLegacyAuthOnce(), false);
  assert.deepStrictEqual(preMigrated.removals, []);
  assert.strictEqual(preMigrated.storage.unrelated, 'keep');

  const silentLegacyRemoval = loadSessionFixture({
    storage: {
      openid: 'must-be-removed',
      [EXPECTED_CONFIG.CLIENT_INSTANCE_STORAGE_KEY]: '2'.repeat(64)
    }
  });
  global.wx.removeStorageSync = (key) => {
    if (key !== 'openid') delete silentLegacyRemoval.storage[key];
  };
  assert.throws(
    () => silentLegacyRemoval.authSession.migrateLegacyAuthOnce(),
    (error) => error.code === 'AUTH_INTERNAL_ERROR'
  );
  assert.strictEqual(silentLegacyRemoval.storage.openid, 'must-be-removed');
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(
      silentLegacyRemoval.storage,
      EXPECTED_CONFIG.MIGRATION_STORAGE_KEY
    ),
    false
  );

  const silentMarkerWrite = loadSessionFixture({
    storage: { role: 'legacy-role' }
  });
  const normalSet = global.wx.setStorageSync;
  global.wx.setStorageSync = (key, value) => {
    if (key !== EXPECTED_CONFIG.MIGRATION_STORAGE_KEY) normalSet(key, value);
  };
  assert.throws(
    () => silentMarkerWrite.authSession.migrateLegacyAuthOnce(),
    (error) => error.code === 'AUTH_INTERNAL_ERROR'
  );
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(
      silentMarkerWrite.storage,
      EXPECTED_CONFIG.MIGRATION_STORAGE_KEY
    ),
    false
  );
}

function testEnvelopesRejectControlledFields() {
  const fixture = loadSessionFixture();
  const currentToken = token(4);
  installSession(fixture, currentToken);
  const anonymous = fixture.authSession.anonymousEnvelope({ phone: '13800000000' });
  assert.deepStrictEqual(anonymous, {
    phone: '13800000000',
    authProtocol: 2,
    clientInstanceId: fixture.authSession.getClientInstanceId()
  });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(anonymous, 'sessionToken'), false);
  const session = fixture.authSession.sessionEnvelope({ role: 'member' });
  assert.strictEqual(session.authProtocol, 2);
  assert.strictEqual(session.sessionToken, currentToken);
  assert.strictEqual(session.role, 'member');

  ['authProtocol', 'clientInstanceId', 'sessionToken', 'action'].forEach((key) => {
    assert.throws(
      () => fixture.authSession.anonymousEnvelope({ [key]: 'caller-value' }),
      (error) => error.code === 'INVALID_INPUT'
    );
    assert.throws(
      () => fixture.authSession.sessionEnvelope({ [key]: 'caller-value' }),
      (error) => error.code === 'INVALID_INPUT'
    );
  });
  [null, [], 'payload'].forEach((payload) => {
    assert.throws(
      () => fixture.authSession.anonymousEnvelope(payload),
      (error) => error.code === 'INVALID_INPUT'
    );
  });
  assert.strictEqual(
    fixture.storage[EXPECTED_CONFIG.SESSION_STORAGE_KEY].sessionToken,
    currentToken
  );

  const noSession = loadSessionFixture();
  assert.throws(
    () => noSession.authSession.sessionEnvelope({}),
    (error) => error.code === 'SESSION_REQUIRED'
  );
}

async function testTypedWrapperBoundaries() {
  const fixture = loadDataFixture({
    cloudResponder(request) {
      return Promise.resolve({
        result: {
          ok: true,
          echo: request.name,
          account: request.name === 'getUserProfile'
            ? 'session_projection'
            : `${request.name}_must_not_project`,
          roles: ['shop'],
          currentRole: 'shop'
        }
      });
    }
  });
  const currentToken = token(5);
  installSession(fixture, currentToken, {
    account: 'signed_in',
    accountDisplay: 'Signed In'
  });

  await fixture.data.callAnonymousAuth('sendSmsCode', {
    phone: '13800000000',
    purpose: 'login'
  });
  assert.strictEqual(fixture.authSession.getSession().account, 'signed_in');
  await fixture.data.callSessionCloud('getUserProfile', {});
  assert.strictEqual(fixture.authSession.getSession().account, 'session_projection');
  await fixture.data.callPublicCloud('getHalls', { city: '成都' });
  assert.strictEqual(fixture.authSession.getSession().account, 'session_projection');
  await fixture.data.callAdminCloud('getAdminStatus', {});
  assert.strictEqual(fixture.authSession.getSession().account, 'session_projection');

  assert.strictEqual(fixture.calls.length, 4);
  fixture.calls.forEach((call) => {
    assert.strictEqual(call.data.authProtocol, 2);
    assert(/^[0-9a-f]{64}$/.test(call.data.clientInstanceId));
  });
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(fixture.calls[0].data, 'sessionToken'),
    false
  );
  assert.strictEqual(fixture.calls[1].data.sessionToken, currentToken);
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(fixture.calls[2].data, 'sessionToken'),
    false
  );
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(fixture.calls[3].data, 'sessionToken'),
    false
  );
  assert.strictEqual(fixture.authSession.getSession().account, 'session_projection');
  assert.strictEqual(fixture.authSession.getSession().sessionToken, currentToken);

  const beforeInvalid = fixture.calls.length;
  const wrappers = [
    fixture.data.callAnonymousAuth,
    fixture.data.callSessionCloud,
    fixture.data.callPublicCloud,
    fixture.data.callAdminCloud
  ];
  for (const wrapper of wrappers) {
    for (const field of ['authProtocol', 'clientInstanceId', 'sessionToken', 'action']) {
      await rejectsCode(
        () => wrapper('getHalls', { [field]: 'caller-controlled' }),
        'INVALID_INPUT'
      );
    }
    await rejectsCode(() => wrapper('getHalls', null), 'INVALID_INPUT');
  }
  assert.strictEqual(fixture.calls.length, beforeInvalid);

  fixture.setCloudResponder(() => Promise.resolve({
    result: { ok: false, code: 'SESSION_EXPIRED', msg: currentToken }
  }));
  await rejectsCode(
    () => fixture.data.callPublicCloud('getHalls', {}),
    'SESSION_EXPIRED'
  );
  assert.strictEqual(fixture.authSession.getSession().sessionToken, currentToken);
  assert.strictEqual(fixture.reLaunch.length, 0);

  const noSession = loadDataFixture();
  await rejectsCode(
    () => noSession.data.callSessionCloud('getUserProfile', {}),
    'SESSION_REQUIRED'
  );
  assert.strictEqual(noSession.calls.length, 0);

  const unreadyWithoutSession = loadDataFixture({
    globalData: { cloudReady: false }
  });
  await rejectsCode(
    () => unreadyWithoutSession.data.callSessionCloud('getUserProfile', {}),
    'SESSION_REQUIRED'
  );
  assert.strictEqual(unreadyWithoutSession.calls.length, 0);

  const unready = loadDataFixture({
    globalData: { cloudReady: false },
    cloudResponder() {
      return Promise.resolve({ result: { ok: true, kind: 'probe' } });
    }
  });
  installSession(unready, token(30));
  await rejectsCode(
    () => unready.data.callAnonymousAuth('sendSmsCode', {}),
    'CLOUD_NOT_READY'
  );
  await rejectsCode(
    () => unready.data.callSessionCloud('getUserProfile', {}),
    'CLOUD_NOT_READY'
  );
  await rejectsCode(
    () => unready.data.callPublicCloud('getHalls', {}),
    'CLOUD_NOT_READY'
  );
  await rejectsCode(
    () => unready.data.callAdminCloud('getAdminStatus', {}),
    'CLOUD_NOT_READY'
  );
  assert.strictEqual(unready.calls.length, 0);
  await unready.data.probeAuthCloud();
  assert.strictEqual(unready.calls.length, 1);
  assert.strictEqual(unready.calls[0].data.action, 'probe');

  const malformed = loadDataFixture({
    cloudResponder() {
      return Promise.resolve({ result: null });
    }
  });
  installSession(malformed, token(29));
  await rejectsCode(
    () => malformed.data.callSessionCloud('getUserProfile', {}),
    'AUTH_INTERNAL_ERROR'
  );
  assert.strictEqual(malformed.authSession.getSession().sessionToken, token(29));
  assert.strictEqual(malformed.reLaunch.length, 0);

  const providerSecret = 'provider-secret-must-not-escape';
  const providerLogs = [];
  const networkFailure = loadDataFixture({
    cloudResponder() {
      return Promise.reject(new Error(providerSecret));
    }
  });
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error
  };
  console.log = (...args) => providerLogs.push(args.join(' '));
  console.warn = (...args) => providerLogs.push(args.join(' '));
  console.error = (...args) => providerLogs.push(args.join(' '));
  try {
    await rejectsCode(
      () => networkFailure.data.callPublicCloud('getHalls', {}),
      'AUTH_INTERNAL_ERROR',
      [providerSecret]
    );
  } finally {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  }
  assert.strictEqual(providerLogs.join('\n').includes(providerSecret), false);

  const missingSuccessFlag = loadDataFixture({
    cloudResponder() {
      return Promise.resolve({
        result: { kind: 'session_revoked' }
      });
    }
  });
  installSession(missingSuccessFlag, token(19));
  await rejectsCode(
    () => missingSuccessFlag.data.callSessionCloud('logout-current', {}),
    'AUTH_INTERNAL_ERROR'
  );
  assert.strictEqual(
    missingSuccessFlag.authSession.getSession().sessionToken,
    token(19)
  );
}

async function testStrictPurposeRouting() {
  const fixture = loadDataFixture({
    cloudResponder() {
      return Promise.resolve({ result: { ok: true, accepted: true } });
    }
  });
  installSession(fixture, token(6));

  await fixture.data.sendSmsCode({ phone: '13800000000', purpose: 'login' });
  await fixture.data.sendSmsCode({ phone: '13800000001', purpose: 'wechat_entry' });
  await fixture.data.sendSmsCode({ phone: '13800000002', purpose: 'bind_phone' });
  await fixture.data.sendSmsCode({ phone: '13800000003', purpose: 'reauth' });
  await fixture.data.sendEmailCode({ purpose: 'reset', email: 'a@example.com' });
  await fixture.data.sendEmailCode({ purpose: 'bind', email: 'b@example.com' });
  await fixture.data.sendEmailCode({ purpose: 'reauth' });

  const smsCalls = fixture.calls.slice(0, 4);
  assert.deepStrictEqual(
    smsCalls.map((call) => [call.name, call.data.purpose, Boolean(call.data.sessionToken)]),
    [
      ['sendSmsCode', 'login', false],
      ['sendSmsCode', 'wechat_entry', false],
      ['sendSmsCode', 'bind_phone', true],
      ['sendSmsCode', 'reauth', true]
    ]
  );
  smsCalls.forEach((call, index) => {
    const expectedKeys = [
      'authProtocol',
      'clientInstanceId',
      'phone',
      'purpose',
      ...(index >= 2 ? ['sessionToken'] : [])
    ];
    assert.deepStrictEqual(Object.keys(call.data).sort(), expectedKeys.sort());
  });
  const emailCalls = fixture.calls.slice(4);
  assert.deepStrictEqual(
    emailCalls.map((call) => [call.name, call.data.purpose, Boolean(call.data.sessionToken)]),
    [
      ['sendEmailCode', 'reset', false],
      ['sendEmailCode', 'bind', true],
      ['sendEmailCode', 'reauth', true]
    ]
  );
  assert.deepStrictEqual(
    Object.keys(emailCalls[0].data).sort(),
    ['authProtocol', 'clientInstanceId', 'email', 'purpose'].sort()
  );
  assert.deepStrictEqual(
    Object.keys(emailCalls[1].data).sort(),
    ['authProtocol', 'clientInstanceId', 'email', 'purpose', 'sessionToken'].sort()
  );
  assert.deepStrictEqual(
    Object.keys(emailCalls[2].data).sort(),
    ['authProtocol', 'clientInstanceId', 'purpose', 'sessionToken'].sort()
  );

  const invalidSms = [
    null,
    { phone: '13800000000' },
    { phone: '13800000000', purpose: 'unknown' },
    { phone: '13800000000', purpose: 'login', extra: true },
    { phone: '13800000000', purpose: 'login', action: 'send' }
  ];
  const invalidEmail = [
    null,
    { purpose: 'reset' },
    { purpose: 'bind' },
    { purpose: 'reauth', email: 'forbidden@example.com' },
    { purpose: 'reset', email: 'a@example.com', account: 'forbidden' },
    { purpose: 'unknown', email: 'a@example.com' }
  ];
  const before = fixture.calls.length;
  for (const input of invalidSms) {
    await rejectsCode(() => fixture.data.sendSmsCode(input), 'INVALID_INPUT');
  }
  for (const input of invalidEmail) {
    await rejectsCode(() => fixture.data.sendEmailCode(input), 'INVALID_INPUT');
  }
  for (const field of ['authProtocol', 'clientInstanceId', 'sessionToken', 'action']) {
    await rejectsCode(
      () => fixture.data.sendSmsCode({
        phone: '13800000000',
        purpose: 'login',
        [field]: 'forbidden'
      }),
      'INVALID_INPUT'
    );
    await rejectsCode(
      () => fixture.data.sendEmailCode({
        purpose: 'reset',
        email: 'a@example.com',
        [field]: 'forbidden'
      }),
      'INVALID_INPUT'
    );
  }
  assert.strictEqual(fixture.calls.length, before);
}

async function testRoleSelectionClientServerContract() {
  const fixture = loadDataFixture({
    cloudResponder() {
      return Promise.resolve({
        result: {
          ok: true,
          kind: 'role_selected',
          account: 'role-account',
          accountDisplay: 'Role Account',
          roles: ['member', 'coach'],
          currentRole: 'coach'
        }
      });
    }
  });
  installSession(fixture, token(17), {
    account: 'role-account',
    accountDisplay: 'Role Account',
    roles: ['member', 'coach'],
    currentRole: 'member'
  });
  const result = await fixture.data.selectRole('coach');
  assert.strictEqual(result.kind, 'role_selected');
  assert.strictEqual(fixture.authSession.getSession().currentRole, 'coach');
  assert.deepStrictEqual(
    Object.keys(fixture.calls[0].data).sort(),
    [
      'authProtocol',
      'clientInstanceId',
      'role',
      'sessionToken'
    ].sort()
  );

  const loginSource = fs.readFileSync(
    path.join(root, 'cloudfunctions/login/index.js'),
    'utf8'
  );
  assert(
    loginSource.includes("key === 'clientInstanceId'"),
    'role-selection endpoint must accept the client instance injected by callSessionCloud'
  );
}

async function testRealOutOfOrderAuthAttempts() {
  const pending = [];
  const fixture = loadDataFixture({
    cloudResponder(request) {
      const item = deferred();
      pending.push({ request: clone(request), ...item });
      return item.promise;
    }
  });
  const consent = {
    phone: '13800000000',
    challengeId: 'challenge-1',
    code: '123456',
    termsVersion: EXPECTED_CONFIG.TERMS_VERSION,
    privacyVersion: EXPECTED_CONFIG.PRIVACY_VERSION
  };
  const attemptA = fixture.data.beginAuthAttempt('sms');
  const requestA = fixture.data.loginWithSms(consent, attemptA);
  const attemptB = fixture.data.beginAuthAttempt('sms');
  const requestB = fixture.data.loginWithSms(
    Object.assign({}, consent, { challengeId: 'challenge-2' }),
    attemptB
  );
  assert.strictEqual(pending.length, 2);
  assert.strictEqual(pending[0].request.data.action, 'loginSms');
  assert.strictEqual(pending[0].request.data.authProtocol, 2);
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(pending[0].request.data, 'sessionToken'),
    false
  );

  pending[1].resolve({
    result: issued(token(8), {
      account: 'winner',
      accountDisplay: 'Winner',
      roles: ['member', 'coach'],
      currentRole: 'coach'
    })
  });
  await requestB;
  pending[0].resolve({
    result: issued(token(7), {
      account: 'stale',
      accountDisplay: 'Stale',
      roles: ['shop'],
      currentRole: 'shop'
    })
  });
  await rejectsCode(() => requestA, 'AUTH_ATTEMPT_STALE');
  assert.strictEqual(fixture.authSession.getSession().sessionToken, token(8));
  assert.strictEqual(fixture.authSession.getSession().account, 'winner');
  assert.deepStrictEqual(fixture.authSession.getSession().roles, ['member', 'coach']);

  const attemptC = fixture.data.beginAuthAttempt('wechat');
  const requestC = fixture.data.loginWithWechat({
    termsVersion: EXPECTED_CONFIG.TERMS_VERSION,
    privacyVersion: EXPECTED_CONFIG.PRIVACY_VERSION
  }, attemptC);
  assert.strictEqual(fixture.data.cancelAuthAttempt(attemptC), true);
  pending[2].resolve({
    result: issued(token(9), {
      account: 'canceled',
      roles: ['shop'],
      currentRole: 'shop'
    })
  });
  await rejectsCode(() => requestC, 'AUTH_ATTEMPT_STALE');
  assert.strictEqual(fixture.authSession.getSession().sessionToken, token(8));

  const missingAttemptRequest = fixture.data.loginWithPassword({
    identifier: 'winner',
    password: '123456',
    termsVersion: EXPECTED_CONFIG.TERMS_VERSION,
    privacyVersion: EXPECTED_CONFIG.PRIVACY_VERSION
  });
  assert.strictEqual(pending.length, 4);
  pending[3].resolve({ result: issued(token(10)) });
  await rejectsCode(() => missingAttemptRequest, 'AUTH_ATTEMPT_STALE');
  assert.strictEqual(fixture.authSession.getSession().sessionToken, token(8));

  const unbound = loadDataFixture({
    cloudResponder() {
      return Promise.resolve({
        result: {
          ok: false,
          code: 'WECHAT_NOT_BOUND',
          msg: 'raw localized message',
          next: 'wechat_phone'
        }
      });
    }
  });
  const unboundAttempt = unbound.data.beginAuthAttempt('wechat');
  const unboundResult = await unbound.data.loginWithWechat({
    termsVersion: EXPECTED_CONFIG.TERMS_VERSION,
    privacyVersion: EXPECTED_CONFIG.PRIVACY_VERSION
  }, unboundAttempt);
  assert.deepStrictEqual(unboundResult, {
    ok: false,
    code: 'WECHAT_NOT_BOUND',
    next: 'wechat_phone'
  });
  assert.strictEqual(unbound.authSession.getSession(), null);

  const malformedIssued = loadDataFixture({
    cloudResponder() {
      return Promise.resolve({
        result: issued('not-a-canonical-token')
      });
    }
  });
  const malformedAttempt = malformedIssued.data.beginAuthAttempt('sms');
  await rejectsCode(
    () => malformedIssued.data.loginWithSms(consent, malformedAttempt),
    'AUTH_INTERNAL_ERROR'
  );
  assert.strictEqual(malformedIssued.authSession.getSession(), null);

  const failedPersistence = loadDataFixture({
    storage: {
      [EXPECTED_CONFIG.CLIENT_INSTANCE_STORAGE_KEY]: '3'.repeat(64)
    },
    storageWriteError: new Error('session storage write failed'),
    cloudResponder() {
      return Promise.resolve({
        result: issued(token(18))
      });
    }
  });
  const persistenceAttempt = failedPersistence.data.beginAuthAttempt('sms');
  await rejectsCode(
    () => failedPersistence.data.loginWithSms(consent, persistenceAttempt),
    'AUTH_INTERNAL_ERROR'
  );
  assert.strictEqual(failedPersistence.authSession.getSession(), null);
}

async function testLegacyHelpersCannotCreateAuthentication() {
  const fixture = loadDataFixture({
    globalData: {
      cloudReady: false,
      account: '',
      accountDisplay: '',
      roles: [],
      currentRole: '',
      role: '',
      openid: ''
    }
  });
  const user = await fixture.data.getUserProfile();
  assert(user);
  assert.strictEqual(fixture.authSession.getSession(), null);
  assert.strictEqual(fixture.app.globalData.account, '');
  assert.strictEqual(fixture.app.globalData.accountDisplay, '');
  assert.deepStrictEqual(fixture.app.globalData.roles, []);
  assert.strictEqual(fixture.app.globalData.currentRole, '');
  assert.strictEqual(fixture.app.globalData.role, '');
  assert.strictEqual(fixture.app.globalData.openid, '');
  assert.strictEqual(await fixture.data.getRole(), '');

  await rejectsCode(
    () => fixture.data.setRole('shop'),
    'SESSION_REQUIRED'
  );
  assert.strictEqual(fixture.calls.length, 0);
  assert.strictEqual(fixture.app.globalData.role, '');
  assert.strictEqual(fixture.app.globalData.currentRole, '');
  assert.deepStrictEqual(fixture.app.globalData.roles, []);
}

async function testCapturedTokenSuppressesStaleEffects() {
  const pending = [];
  const fixture = loadDataFixture({
    cloudResponder(request) {
      const item = deferred();
      pending.push({ request: clone(request), ...item });
      return item.promise;
    }
  });
  const oldToken = token(11);
  const newToken = token(12);
  installSession(fixture, oldToken, {
    account: 'old-account',
    accountDisplay: 'Old Account',
    roles: ['member'],
    currentRole: 'member'
  });

  const staleStatus = fixture.data.callSessionCloud('getUserProfile', {});
  const staleMutation = fixture.data.callSessionCloud('saveUserProfile', {
    nickname: 'old'
  });
  const staleLogout = fixture.data.callSessionCloud('logoutUser', {});
  const staleRotation = fixture.data.callSessionCloud('setPassword', {});
  const staleError = fixture.data.callSessionCloud('getMembers', {});
  pending.forEach((item) => {
    assert.strictEqual(item.request.data.sessionToken, oldToken);
  });

  installSession(fixture, newToken, {
    account: 'new-account',
    accountDisplay: 'New Account',
    roles: ['member', 'coach'],
    currentRole: 'coach'
  });

  pending[0].resolve({
    result: {
      ok: true,
      kind: 'security_status',
      account: 'stale-status',
      roles: ['shop'],
      currentRole: 'shop'
    }
  });
  pending[1].resolve({
    result: {
      ok: true,
      kind: 'security_mutation',
      account: 'stale-mutation',
      roles: ['shop'],
      currentRole: 'shop'
    }
  });
  pending[2].resolve({ result: { ok: true, kind: 'session_revoked' } });
  pending[3].resolve({
    result: {
      ok: true,
      kind: 'session_rotated',
      sessionToken: token(13),
      account: 'stale-rotation',
      roles: ['shop'],
      currentRole: 'shop'
    }
  });
  pending[4].resolve({
    result: {
      ok: false,
      code: 'SESSION_EXPIRED',
      msg: `must not expose ${oldToken}`
    }
  });
  await Promise.all([staleStatus, staleMutation, staleLogout, staleRotation]);
  await rejectsCode(() => staleError, 'SESSION_EXPIRED');

  assert.deepStrictEqual(fixture.authSession.getSession(), {
    schemaVersion: 2,
    sessionToken: newToken,
    account: 'new-account',
    accountDisplay: 'New Account',
    roles: ['member', 'coach'],
    currentRole: 'coach'
  });
  assert.strictEqual(fixture.reLaunch.length, 0);

  fixture.setCloudResponder((request) => {
    if (request.name === 'current-status') {
      return Promise.resolve({
        result: {
          ok: true,
          kind: 'security_status',
          account: 'fresh-account',
          accountDisplay: 'Fresh Account',
          roles: ['member'],
          currentRole: 'member'
        }
      });
    }
    return Promise.resolve({
      result: {
        ok: true,
        kind: 'session_rotated',
        sessionToken: token(14),
        account: 'rotated-account',
        accountDisplay: 'Rotated Account',
        roles: ['shop'],
        currentRole: 'shop'
      }
    });
  });
  await fixture.data.callSessionCloud('current-status', {});
  assert.strictEqual(fixture.authSession.getSession().sessionToken, newToken);
  assert.strictEqual(fixture.authSession.getSession().account, 'fresh-account');
  await fixture.data.callSessionCloud('current-rotation', {});
  assert.strictEqual(fixture.authSession.getSession().sessionToken, token(14));
  assert.strictEqual(fixture.authSession.getSession().account, 'rotated-account');

  fixture.setCloudResponder(() => Promise.resolve({
    result: { ok: true, kind: 'session_revoked' }
  }));
  await fixture.data.callSessionCloud('logout-current', {});
  assert.strictEqual(fixture.authSession.getSession(), null);
}

async function testCentralSessionErrors() {
  async function currentInvalidation(code) {
    const fixture = loadDataFixture({
      cloudResponder() {
        return Promise.resolve({
          result: { ok: false, code, msg: 'raw server detail' }
        });
      }
    });
    installSession(fixture, token(15));
    await rejectsCode(
      () => fixture.data.callSessionCloud('getUserProfile', {}),
      code
    );
    assert.strictEqual(fixture.authSession.getSession(), null);
    assert.deepStrictEqual(fixture.reLaunch, [{ url: '/pages/login/index' }]);
  }
  for (const code of ['SESSION_REQUIRED', 'SESSION_EXPIRED', 'ACCOUNT_DISABLED']) {
    await currentInvalidation(code);
  }

  for (const code of ['ROLE_NOT_ALLOWED', 'AUTH_CONFLICT']) {
    const first = deferred();
    const staleFixture = loadDataFixture({
      cloudResponder(request) {
        if (staleFixture.calls.length === 1) return first.promise;
        return Promise.resolve({
          result: {
            ok: true,
            kind: 'security_status',
            account: 'must-not-refresh',
            accountDisplay: 'Must Not Refresh',
            roles: ['shop'],
            currentRole: 'shop'
          }
        });
      }
    });
    installSession(staleFixture, token(22), {
      account: 'old',
      roles: ['member'],
      currentRole: 'member'
    });
    const staleRequest = staleFixture.data.callSessionCloud(
      'saveUserProfile',
      {}
    );
    installSession(staleFixture, token(23), {
      account: 'new',
      accountDisplay: 'New',
      roles: ['member', 'coach'],
      currentRole: 'coach'
    });
    first.resolve({
      result: { ok: false, code, msg: 'stale response' }
    });
    await rejectsCode(() => staleRequest, code);
    assert.strictEqual(staleFixture.calls.length, 1);
    assert.strictEqual(staleFixture.authSession.getSession().sessionToken, token(23));
    assert.strictEqual(staleFixture.authSession.getSession().account, 'new');
    assert.strictEqual(staleFixture.app.globalData.authRolePickerRequired, false);
    assert.strictEqual(staleFixture.reLaunch.length, 0);
  }

  const roleFixture = loadDataFixture({
    cloudResponder(request) {
      if (request.name === 'accountAuth' && request.data.action === 'status') {
        return Promise.resolve({
          result: {
            ok: true,
            kind: 'security_status',
            account: 'role-account',
            accountDisplay: 'Role Account',
            roles: ['member', 'coach'],
            currentRole: 'member'
          }
        });
      }
      return Promise.resolve({
        result: { ok: false, code: 'ROLE_NOT_ALLOWED', msg: 'not allowed' }
      });
    }
  });
  const roleToken = token(16);
  installSession(roleFixture, roleToken);
  await rejectsCode(
    () => roleFixture.data.callSessionCloud('saveUserProfile', {}),
    'ROLE_NOT_ALLOWED'
  );
  assert.strictEqual(roleFixture.authSession.getSession().sessionToken, roleToken);
  assert.deepStrictEqual(roleFixture.authSession.getSession().roles, ['member', 'coach']);
  assert.strictEqual(roleFixture.app.globalData.authRolePickerRequired, true);
  assert.deepStrictEqual(
    roleFixture.reLaunch,
    [{ url: '/pages/login/index?rolePicker=1' }]
  );
  assert.strictEqual(roleFixture.calls.length, 2);
  assert.strictEqual(roleFixture.calls[1].data.sessionToken, roleToken);

  const conflictFixture = loadDataFixture({
    cloudResponder(request) {
      if (request.name === 'accountAuth' && request.data.action === 'status') {
        return Promise.resolve({
          result: {
            ok: true,
            kind: 'security_status',
            account: 'refreshed',
            accountDisplay: 'Refreshed',
            roles: ['member'],
            currentRole: 'member'
          }
        });
      }
      return Promise.resolve({
        result: { ok: false, code: 'AUTH_CONFLICT', msg: 'conflict detail' }
      });
    }
  });
  installSession(conflictFixture, token(17));
  await rejectsCode(
    () => conflictFixture.data.callSessionCloud('saveUserProfile', {}),
    'AUTH_CONFLICT'
  );
  assert.strictEqual(conflictFixture.calls.length, 2);
  assert.strictEqual(conflictFixture.authSession.getSession().account, 'refreshed');
  assert.strictEqual(conflictFixture.reLaunch.length, 0);

  const updateFixture = loadDataFixture({
    cloudResponder() {
      return Promise.resolve({
        result: {
          ok: false,
          code: 'CLIENT_UPDATE_REQUIRED',
          msg: 'sensitive provider detail'
        }
      });
    }
  });
  installSession(updateFixture, token(18));
  await rejectsCode(
    () => updateFixture.data.callPublicCloud('getHalls', {}),
    'CLIENT_UPDATE_REQUIRED'
  );
  assert(updateFixture.updateCalls.includes('getUpdateManager'));
  assert(updateFixture.modals.some((modal) => modal.showCancel === false));
  assert.strictEqual(updateFixture.authSession.getSession().sessionToken, token(18));

  const maintenanceFixture = loadDataFixture({
    cloudResponder() {
      return Promise.resolve({
        result: { ok: false, code: 'AUTH_MAINTENANCE', msg: 'maintenance detail' }
      });
    }
  });
  installSession(maintenanceFixture, token(19));
  await rejectsCode(
    () => maintenanceFixture.data.callSessionCloud('saveUserProfile', {}),
    'AUTH_MAINTENANCE'
  );
  assert.strictEqual(maintenanceFixture.app.globalData.authWriteBlocked, true);
  assert(maintenanceFixture.modals.some((modal) => modal.showCancel === false));
  assert.strictEqual(
    maintenanceFixture.authSession.getSession().sessionToken,
    token(19)
  );

  const internalFixture = loadDataFixture({
    cloudResponder() {
      return Promise.resolve({
        result: {
          ok: false,
          code: 'AUTH_INTERNAL_ERROR',
          msg: `raw ${token(20)} provider error`
        }
      });
    }
  });
  installSession(internalFixture, token(20));
  let caught;
  try {
    await internalFixture.data.callSessionCloud('getUserProfile', {});
  } catch (error) {
    caught = error;
  }
  assert(caught);
  assert.strictEqual(caught.code, 'AUTH_INTERNAL_ERROR');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(caught, 'result'), false);
  assert.strictEqual(String(caught).includes(token(20)), false);
  assert.strictEqual(JSON.stringify(caught).includes(token(20)), false);
  assert.strictEqual(internalFixture.authSession.getSession().sessionToken, token(20));
  assert.strictEqual(internalFixture.reLaunch.length, 0);
}

async function testAppBootstrapAndTypedProbe() {
  const validSession = {
    schemaVersion: 2,
    sessionToken: token(21),
    account: '',
    accountDisplay: '138****0000',
    roles: ['member', 'coach'],
    currentRole: 'coach'
  };
  const runtime = makeRuntime({
    storage: {
      openid: 'legacy-openid',
      role: 'shop',
      dc_role: 'shop',
      dc_account_name: 'legacy',
      dc_accounts: [{ password: 'legacy' }],
      dc_wechat_bindings: { legacy: true },
      [EXPECTED_CONFIG.SESSION_STORAGE_KEY]: validSession,
      firstLoginAt: 321,
      plan: 'paid',
      planExpiresAt: 654,
      dc_theme_mode: 'light',
      unrelated: 'keep'
    },
    cloudResponder() {
      return Promise.resolve({ result: { ok: true, cloudReady: true } });
    }
  });
  const orderedRead = global.wx.getStorageSync;
  let sessionReadCount = 0;
  global.wx.getStorageSync = (key) => {
    if (key === EXPECTED_CONFIG.SESSION_STORAGE_KEY) {
      sessionReadCount += 1;
      assert.strictEqual(
        runtime.storage[EXPECTED_CONFIG.MIGRATION_STORAGE_KEY],
        2,
        'legacy migration must complete before the v2 session is read'
      );
      LEGACY_AUTH_KEYS.forEach((legacyKey) => {
        assert.strictEqual(
          Object.prototype.hasOwnProperty.call(runtime.storage, legacyKey),
          false
        );
      });
    }
    return orderedRead(key);
  };
  clearClientModules();
  delete require.cache[require.resolve(appPath)];
  let appDefinition;
  global.App = (definition) => {
    appDefinition = definition;
  };
  require(appPath);
  global.getApp = () => appDefinition;

  appDefinition.bootstrap();
  assert.strictEqual(appDefinition.globalData.openid, '');
  assert.strictEqual(appDefinition.globalData.account, '');
  assert.strictEqual(appDefinition.globalData.accountDisplay, '138****0000');
  assert.deepStrictEqual(appDefinition.globalData.roles, ['member', 'coach']);
  assert.strictEqual(appDefinition.globalData.currentRole, 'coach');
  assert.strictEqual(appDefinition.globalData.role, 'coach');
  assert.strictEqual(appDefinition.globalData.firstLoginAt, 321);
  assert.strictEqual(appDefinition.globalData.plan, 'paid');
  assert.strictEqual(appDefinition.globalData.planExpiresAt, 654);
  assert(sessionReadCount >= 1);
  assert.strictEqual(runtime.storage.unrelated, 'keep');
  LEGACY_AUTH_KEYS.forEach((key) => {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(runtime.storage, key), false);
  });

  let billingRefreshes = 0;
  appDefinition.refreshBilling = () => {
    billingRefreshes += 1;
  };
  appDefinition.probeCloud();
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(appDefinition.globalData.cloudReady, true);
  assert.strictEqual(billingRefreshes, 1);
  assert.strictEqual(runtime.calls.length, 1);
  assert.strictEqual(runtime.calls[0].name, 'accountAuth');
  assert.strictEqual(runtime.calls[0].data.action, 'probe');
  assert.strictEqual(runtime.calls[0].data.authProtocol, 2);
  assert(/^[0-9a-f]{64}$/.test(runtime.calls[0].data.clientInstanceId));
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(runtime.calls[0].data, 'sessionToken'),
    false
  );

  const legacyOnly = makeRuntime({
    storage: {
      openid: 'legacy-openid',
      role: 'shop',
      firstLoginAt: 7,
      plan: 'free'
    }
  });
  clearClientModules();
  delete require.cache[require.resolve(appPath)];
  let legacyApp;
  global.App = (definition) => {
    legacyApp = definition;
  };
  require(appPath);
  global.getApp = () => legacyApp;
  legacyApp.bootstrap();
  assert.strictEqual(legacyApp.globalData.openid, '');
  assert.strictEqual(legacyApp.globalData.role, '');
  assert.strictEqual(legacyApp.globalData.account, '');
  assert.deepStrictEqual(legacyApp.globalData.roles, []);
  assert.strictEqual(legacyOnly.storage.firstLoginAt, 7);
  assert.strictEqual(legacyApp.globalData.firstLoginAt, 7);

  const selectiveFailure = makeRuntime({
    storage: {
      planExpiresAt: 999,
      unrelated: 'keep'
    }
  });
  const normalRead = global.wx.getStorageSync;
  global.wx.getStorageSync = (key) => {
    if (key === 'firstLoginAt' || key === 'plan') {
      throw new Error('isolated storage read failure');
    }
    return normalRead(key);
  };
  clearClientModules();
  delete require.cache[require.resolve(appPath)];
  let selectiveApp;
  global.App = (definition) => {
    selectiveApp = definition;
  };
  require(appPath);
  global.getApp = () => selectiveApp;
  selectiveApp.bootstrap();
  assert.strictEqual(selectiveApp.globalData.firstLoginAt, 0);
  assert.strictEqual(selectiveApp.globalData.plan, 'free');
  assert.strictEqual(selectiveApp.globalData.planExpiresAt, 999);
  assert.strictEqual(selectiveFailure.storage.unrelated, 'keep');

  const migrationFailure = makeRuntime({
    storage: {
      openid: 'legacy-openid',
      firstLoginAt: 88,
      plan: 'paid',
      planExpiresAt: 777
    }
  });
  global.wx.removeStorageSync = () => {
    throw new Error('migration removal failed');
  };
  clearClientModules();
  delete require.cache[require.resolve(appPath)];
  let failedApp;
  global.App = (definition) => {
    failedApp = definition;
  };
  require(appPath);
  global.getApp = () => failedApp;
  Object.assign(failedApp.globalData, {
    account: 'stale-account',
    accountDisplay: 'Stale Account',
    roles: ['shop'],
    currentRole: 'shop',
    role: 'shop',
    openid: 'stale-openid'
  });
  failedApp.bootstrap();
  assert.strictEqual(failedApp.globalData.account, '');
  assert.strictEqual(failedApp.globalData.accountDisplay, '');
  assert.deepStrictEqual(failedApp.globalData.roles, []);
  assert.strictEqual(failedApp.globalData.currentRole, '');
  assert.strictEqual(failedApp.globalData.role, '');
  assert.strictEqual(failedApp.globalData.openid, '');
  assert.strictEqual(failedApp.globalData.firstLoginAt, 88);
  assert.strictEqual(failedApp.globalData.plan, 'paid');
  assert.strictEqual(failedApp.globalData.planExpiresAt, 777);
  assert.strictEqual(migrationFailure.storage.openid, 'legacy-openid');
}

async function run() {
  testConfigAndStableClientInstance();
  testSessionWhitelistCopiesAndCas();
  testAttemptLifecycleAndMigration();
  testEnvelopesRejectControlledFields();
  await testTypedWrapperBoundaries();
  await testStrictPurposeRouting();
  await testRoleSelectionClientServerContract();
  await testRealOutOfOrderAuthAttempts();
  await testLegacyHelpersCannotCreateAuthentication();
  await testCapturedTokenSuppressesStaleEffects();
  await testCentralSessionErrors();
  await testAppBootstrapAndTypedProbe();
  console.log('authClientSession tests passed');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
