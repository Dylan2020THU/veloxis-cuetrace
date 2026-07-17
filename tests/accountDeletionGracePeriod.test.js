const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const root = path.resolve(__dirname, '..');
const DAY_MS = 24 * 60 * 60 * 1000;
const AUTH_ENV = Object.freeze({
  CUETRACE_AUTH_KEY_ACTIVE_VERSION: 'K2',
  CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS: '',
  CUETRACE_AUTH_KEY_K2: Buffer.alloc(32, 0x52).toString('base64')
});
const {
  deriveKey,
  loadKeyring
} = require(path.join(
  root,
  'cloudfunctions/login/lib/auth/keyring.js'
));

const AUXILIARY_COLLECTIONS = [
  'training_sessions',
  'coaches',
  'shops',
  'stores',
  'posts',
  'post_likes',
  'post_comments',
  'matches',
  'match_joins',
  'bookings',
  'sms_codes',
  'email_bindings',
  'email_codes',
  'shop_applications',
  'coach_shop_applications',
  'checkin_requests',
  'sessions',
  'coach_lessons',
  'brands',
  'members',
  'coach_member_links',
  'shop_coach_links',
  'user_follows'
];

function emptyAuxiliaryState() {
  return AUXILIARY_COLLECTIONS.reduce((state, name) => {
    state[name] = [];
    return state;
  }, {});
}

function timerEvent() {
  return { Type: 'Timer', TriggerName: 'dailyAccountDeletionPurge' };
}

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

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

async function withAuthEnvironment(callback) {
  const previous = {};
  for (const [key, value] of Object.entries(AUTH_ENV)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return await callback();
  } finally {
    for (const key of Object.keys(AUTH_ENV)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function bindingId(openid) {
  return sha256(`wechat:${openid}`);
}

function accountId(account) {
  return sha256(`account:${String(account).toLowerCase()}`);
}

function identity(openid, account) {
  const userId = bindingId(openid);
  const authId = accountId(account);
  return {
    binding: { _id: userId, _openid: openid, accountId: authId, account },
    account: { _id: authId, _openid: openid, account, status: 'active' },
    user: {
      _id: userId,
      _openid: openid,
      roles: ['member'],
      currentRole: 'member',
      role: 'member',
      nickname: account
    }
  };
}

function roleSelectionFixture(seedByte) {
  const now = 1000;
  const accountIdValue = `acct_${Buffer.alloc(16, seedByte).toString('base64url')}`;
  const sessionToken = `v2.K2.${Buffer.alloc(32, seedByte + 1).toString('base64url')}`;
  const session = {
    _id: sessionDocumentId(sessionToken),
    accountId: accountIdValue,
    keyVersion: 'K2',
    authVersion: 1,
    clientInstanceId: 'deletion-role-client',
    authenticatedAt: now,
    authenticationMethod: 'password',
    createdAt: now,
    lastSeenAt: now,
    idleExpiresAt: now + 30 * DAY_MS,
    absoluteExpiresAt: now + 90 * DAY_MS,
    revokedAt: '',
    revokeReason: ''
  };
  const account = {
    _id: accountIdValue,
    status: 'active',
    accountNameBindingId: '',
    phoneBindingId: '',
    wechatBindingId: '',
    emailBindingId: '',
    passwordAlgorithm: 'scrypt-v1',
    passwordSalt: 'salt',
    passwordHash: 'hash',
    authVersion: 1,
    termsAcceptedAt: now,
    termsVersion: '2026-07-15',
    privacyAcceptedAt: now,
    privacyVersion: '2026-07-15',
    createdAt: now,
    updatedAt: now
  };
  const user = {
    _id: accountIdValue,
    roles: ['member', 'coach'],
    currentRole: 'member',
    role: 'member',
    nickname: 'Pending User',
    avatar: '',
    deletionStatus: 'pending',
    deletionRequestedAt: 900,
    deletionScheduledAt: 5000,
    createdAt: now,
    updatedAt: now
  };
  const request = {
    _id: accountIdValue,
    accountId: accountIdValue,
    deletionStatus: 'pending',
    deletionRequestedAt: 900,
    deletionScheduledAt: 5000,
    createdAt: 900,
    updatedAt: 900
  };
  return {
    account,
    request,
    session,
    sessionToken,
    state: {
      auth_control: [{
        _id: 'main',
        maintenance: false,
        schemaVersion: 2,
        minClientProtocol: 2
      }],
      auth_sessions: [session],
      accounts: [account],
      users: [user],
      account_names: [],
      phone_bindings: [],
      account_deletion_requests: [request]
    },
    user
  };
}

function ownedFile(auth, name) {
  return `cloud://test-env.bucket/user-content/${auth.user._id}/${name}`;
}

function matches(document, query) {
  if (query && Array.isArray(query.$and)) {
    return query.$and.every((part) => matches(document, part));
  }
  if (query && Array.isArray(query.$or)) {
    return query.$or.some((part) => matches(document, part));
  }
  return Object.keys(query || {}).every((key) => {
    const expected = query[key];
    if (expected && typeof expected === 'object' && Object.prototype.hasOwnProperty.call(expected, '$lte')) {
      return document[key] <= expected.$lte;
    }
    if (expected && typeof expected === 'object' && Object.prototype.hasOwnProperty.call(expected, '$gt')) {
      return document[key] > expected.$gt;
    }
    if (expected && typeof expected === 'object' && Array.isArray(expected.$in)) {
      return expected.$in.indexOf(document[key]) !== -1;
    }
    return document[key] === expected;
  });
}

function applyUpdate(document, data) {
  const next = Object.assign({}, document);
  Object.keys(data || {}).forEach((key) => {
    const value = clone(data[key]);
    if (value && value.$remove === true) delete next[key];
    else next[key] = value;
  });
  return next;
}

function makeDatabase(state, options) {
  const config = options || {};
  let transactionCount = 0;
  const operations = {
    adds: [],
    updates: [],
    sets: [],
    deletes: [],
    removes: [],
    reads: [],
    queries: [],
    timeline: []
  };

  function facade(target, inTransaction) {
    function collection(name) {
      const hasStoredCollection = Object.prototype.hasOwnProperty.call(
        target,
        name
      );
      const hasVirtualAuthControl = Boolean(
        name === 'auth_control'
        && config.authControl
      );
      if (!hasStoredCollection && !hasVirtualAuthControl) {
        throw new Error(`collection ${name} does not exist`);
      }
      const documents = hasStoredCollection
        ? target[name]
        : [config.authControl];
      return {
        doc(id) {
          return {
            async get() {
              operations.reads.push({ collection: name, id, inTransaction });
              operations.timeline.push({ type: 'docGet', collection: name, id, inTransaction });
              return { data: clone(documents.find((item) => item._id === id) || null) };
            },
            async set({ data }) {
              const next = Object.assign({}, clone(data), { _id: id });
              const index = documents.findIndex((item) => item._id === id);
              if (index === -1) documents.push(next);
              else documents[index] = next;
              operations.sets.push({ collection: name, id, data: clone(data), inTransaction });
              return { _id: id };
            },
            async update({ data }) {
              if (
                inTransaction &&
                config.failTransactionWrite &&
                config.failTransactionWrite({
                  collection: name,
                  method: 'update',
                  id,
                  data: clone(data),
                  transactionCount
                })
              ) {
                throw new Error(`simulated ${name} update failure`);
              }
              const index = documents.findIndex((item) => item._id === id);
              if (index === -1) throw new Error(`${name}/${id} does not exist`);
              documents[index] = Object.assign(applyUpdate(documents[index], data), { _id: id });
              operations.updates.push({ collection: name, id, data: clone(data), inTransaction });
              operations.timeline.push({ type: 'docUpdate', collection: name, id, data: clone(data), inTransaction });
              return { stats: { updated: 1 } };
            },
            async delete() {
              if (
                inTransaction &&
                config.failTransactionWrite &&
                config.failTransactionWrite({ collection: name, method: 'delete', id, transactionCount })
              ) {
                throw new Error(`simulated ${name} delete failure`);
              }
              const index = documents.findIndex((item) => item._id === id);
              if (index !== -1) documents.splice(index, 1);
              operations.deletes.push({ collection: name, id, inTransaction });
              operations.timeline.push({ type: 'docDelete', collection: name, id, inTransaction });
              return { stats: { removed: index === -1 ? 0 : 1 } };
            }
          };
        },
        where(query) {
          let limitValue = 100;
          let skipValue = 0;
          const orderings = [];
          const builder = {
            orderBy(field, direction) {
              orderings.push({ field, direction });
              return builder;
            },
            skip(value) {
              skipValue = value;
              return builder;
            },
            limit(value) {
              limitValue = value;
              return builder;
            },
            async get() {
              if (inTransaction) throw new Error('transaction query is unsupported');
              const sorted = documents.filter((item) => matches(item, query)).slice();
              sorted.sort((left, right) => {
                for (const ordering of orderings) {
                  if (left[ordering.field] === right[ordering.field]) continue;
                  const compared = left[ordering.field] < right[ordering.field] ? -1 : 1;
                  return ordering.direction === 'desc' ? -compared : compared;
                }
                return 0;
              });
              const operation = {
                collection: name,
                query: clone(query),
                orderings: clone(orderings),
                skip: skipValue,
                limit: limitValue,
                inTransaction
              };
              operations.queries.push(operation);
              operations.timeline.push(Object.assign({ type: 'queryGet' }, operation));
              const data = clone(sorted.slice(skipValue, skipValue + limitValue));
              if (config.afterQueryGet) {
                await config.afterQueryGet({ collection: name, query, inTransaction, data });
              }
              return { data };
            },
            async update({ data }) {
              let updated = 0;
              documents.forEach((item, index) => {
                if (!matches(item, query)) return;
                documents[index] = applyUpdate(item, data);
                updated += 1;
              });
              operations.updates.push({ collection: name, query: clone(query), data: clone(data), inTransaction });
              return { stats: { updated } };
            },
            async remove() {
              if (config.failRemove && config.failRemove({ collection: name, query })) {
                throw new Error(`simulated ${name} helper failure`);
              }
              let removed = 0;
              for (let i = documents.length - 1; i >= 0; i -= 1) {
                if (!matches(documents[i], query)) continue;
                documents.splice(i, 1);
                removed += 1;
              }
              operations.removes.push({ collection: name, query: clone(query), removed });
              operations.timeline.push({ type: 'remove', collection: name, query: clone(query) });
              return { stats: { removed } };
            }
          };
          return builder;
        },
        async add({ data }) {
          const id = `${name}_random_${documents.length + 1}`;
          documents.push(Object.assign({}, clone(data), { _id: id }));
          operations.adds.push({ collection: name, id, data: clone(data), inTransaction });
          return { _id: id };
        }
      };
    }

    return { collection };
  }

  const database = facade(state, false);
  database.serverDate = () => 'SERVER_DATE';
  database.command = {
    lte(value) {
      return { $lte: value };
    },
    or(...conditions) {
      return { $or: conditions };
    },
    and(...conditions) {
      return { $and: conditions };
    },
    gt(value) {
      return { $gt: value };
    },
    in(values) {
      return { $in: values };
    },
    remove() {
      return { $remove: true };
    }
  };
  database.runTransaction = async (callback) => {
    transactionCount += 1;
    if (config.beforeTransaction) {
      await config.beforeTransaction({ state, count: transactionCount });
    }
    const working = clone(state);
    const transaction = facade(working, true);
    const result = await callback(transaction);
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

function loadCloudFunction(file, openid, state, options) {
  let databaseOptions = options || {};
  if (!Object.prototype.hasOwnProperty.call(state, 'auth_control')) {
    databaseOptions = Object.assign({}, databaseOptions, {
      authControl: {
      _id: 'main',
      maintenance: false,
      schemaVersion: 1,
      minClientProtocol: 1
      }
    });
  }
  const fakeDb = makeDatabase(state, databaseOptions);
  const deleteFileCalls = [];
  const wxContextCalls = [];
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database() {
      return fakeDb;
    },
    getWXContext() {
      wxContextCalls.push(openid);
      if (databaseOptions.forbidWxContext) {
        throw new Error('login must not read WXContext');
      }
      return { OPENID: openid };
    },
    async deleteFile({ fileList }) {
      deleteFileCalls.push(fileList.slice());
      if (databaseOptions.deleteFile) {
        return databaseOptions.deleteFile(fileList.slice());
      }
      return { fileList: fileList.map((fileID) => ({ fileID, code: 'SUCCESS' })) };
    }
  };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'wx-server-sdk') return fakeCloud;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const fnPath = path.join(root, file);
    delete require.cache[require.resolve(fnPath)];
    return {
      fn: require(fnPath),
      fakeDb,
      deleteFileCalls,
      wxContextCalls
    };
  } finally {
    Module._load = originalLoad;
  }
}

async function captureWarnings(callback) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    return { result: await callback(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

async function atTime(value, callback) {
  const originalNow = Date.now;
  Date.now = () => value;
  try {
    return await callback();
  } finally {
    Date.now = originalNow;
  }
}

async function testDeleteRejectsUnboundOpenidWithoutWrites() {
  const legacy = { _id: 'legacy-user', _openid: 'unbound-openid', role: 'member' };
  const state = {
    wechat_bindings: [],
    accounts: [],
    users: [clone(legacy)],
    account_deletion_requests: []
  };
  const before = clone(state);
  const { fn, fakeDb } = loadCloudFunction(
    'cloudfunctions/deleteAccount/index.js',
    'unbound-openid',
    state
  );

  const result = await atTime(1000, () => fn.main({ reason: 'privacy' }));

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'ACCOUNT_NOT_BOUND');
  assert.deepStrictEqual(state, before);
  assert.strictEqual(fakeDb.__operations.adds.length, 0);
  assert.strictEqual(fakeDb.__operations.sets.length, 0);
  assert.strictEqual(fakeDb.__operations.updates.length, 0);
}

async function testDeleteUsesDeterministicUserAndRequestWithoutExtendingRepeat() {
  const auth = identity('bound-openid', 'MemberA');
  const legacy = {
    _id: 'legacy-random-user',
    _openid: 'bound-openid',
    role: 'coach',
    roles: ['member', 'coach'],
    nickname: 'Legacy Coach'
  };
  const state = {
    wechat_bindings: [auth.binding],
    accounts: [auth.account],
    users: [clone(legacy), auth.user],
    account_deletion_requests: [],
    subscriptions: []
  };
  const { fn, fakeDb } = loadCloudFunction(
    'cloudfunctions/deleteAccount/index.js',
    'bound-openid',
    state
  );

  const first = await atTime(1000, () => fn.main({ reason: 'first reason' }));
  const second = await atTime(5000, () => fn.main({ reason: 'second reason' }));
  const deterministicUser = state.users.find((item) => item._id === auth.binding._id);
  const request = state.account_deletion_requests[0];

  assert.strictEqual(first.ok, true);
  assert.strictEqual(second.ok, true);
  assert.strictEqual(deterministicUser.deletionStatus, 'pending');
  assert.strictEqual(deterministicUser.deletionRequestedAt, first.deletionRequestedAt);
  assert.strictEqual(deterministicUser.deletionScheduledAt, first.deletionScheduledAt);
  assert.strictEqual(second.deletionScheduledAt, first.deletionScheduledAt);
  assert.deepStrictEqual(state.users.find((item) => item._id === legacy._id), legacy);
  assert.strictEqual(state.account_deletion_requests.length, 1);
  assert.strictEqual(request._id, auth.binding._id);
  assert.strictEqual(request._openid, 'bound-openid');
  assert.strictEqual(request.accountId, auth.account._id);
  assert.strictEqual(request.account, auth.account.account);
  assert.strictEqual(request.deletionStatus, 'pending');
  assert.strictEqual(request.deletionScheduledAt, first.deletionScheduledAt);
  assert.strictEqual(fakeDb.__operations.adds.length, 0);
}

async function testDeleteStartsNewWindowForStalePendingRequest() {
  const auth = identity('stale-request-openid', 'StaleA');
  const state = {
    wechat_bindings: [auth.binding],
    accounts: [auth.account],
    users: [auth.user],
    subscriptions: [],
    account_deletion_requests: [{
      _id: auth.binding._id,
      _openid: 'stale-request-openid',
      accountId: auth.account._id,
      account: auth.account.account,
      deletionStatus: 'pending',
      deletionRequestedAt: 100,
      deletionScheduledAt: 200
    }]
  };
  const { fn, fakeDb } = loadCloudFunction(
    'cloudfunctions/deleteAccount/index.js',
    'stale-request-openid',
    state
  );

  const result = await atTime(1000, () => fn.main({ reason: 'new request' }));

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.deletionRequestedAt, 1000);
  assert.strictEqual(result.deletionScheduledAt, 1000 + 7 * 24 * 60 * 60 * 1000);
  assert.strictEqual(state.account_deletion_requests[0].deletionRequestedAt, result.deletionRequestedAt);
  assert.strictEqual(state.account_deletion_requests[0].deletionScheduledAt, result.deletionScheduledAt);
}

async function testDeleteRejectsPendingUserWithoutConsistentRequest() {
  const variants = [
    { name: 'missing request', request: null },
    { name: 'missing request with active subscription', request: null, subscriptionStatus: 'active' },
    {
      name: 'mismatched schedule',
      request: { deletionRequestedAt: 10, deletionScheduledAt: 21 }
    },
    {
      name: 'non-finite schedule',
      request: { deletionRequestedAt: 10, deletionScheduledAt: '20' }
    }
  ];

  for (const variant of variants) {
    const auth = identity(`pending-${variant.name}`, `Pending${variant.name}`);
    auth.user.deletionStatus = 'pending';
    auth.user.deletionRequestedAt = 10;
    auth.user.deletionScheduledAt = 20;
    const request = variant.request && Object.assign({
      _id: auth.binding._id,
      _openid: auth.binding._openid,
      accountId: auth.account._id,
      account: auth.account.account,
      deletionStatus: 'pending'
    }, variant.request);
    const state = {
      wechat_bindings: [auth.binding],
      accounts: [auth.account],
      users: [auth.user],
      subscriptions: variant.subscriptionStatus
        ? [{ _id: `sub-${variant.name}`, _openid: auth.binding._openid, status: variant.subscriptionStatus }]
        : [],
      account_deletion_requests: request ? [request] : []
    };
    const before = clone(state);
    const { fn, fakeDb } = loadCloudFunction(
      'cloudfunctions/deleteAccount/index.js',
      auth.binding._openid,
      state
    );

    const result = await atTime(1000, () => fn.main({ reason: 'must not extend' }));

    assert.strictEqual(result.ok, false, variant.name);
    assert.strictEqual(result.code, 'DELETION_REQUEST_INCONSISTENT', variant.name);
    assert.deepStrictEqual(state, before, variant.name);
    assert.strictEqual(fakeDb.__operations.updates.length, 0, variant.name);
    assert.strictEqual(fakeDb.__operations.sets.length, 0, variant.name);
  }
}

async function testDeleteRejectsPurgingAccountWithoutWrites() {
  const fixture = dueState('purging-delete-openid', 'PurgingDeleteA');
  Object.assign(fixture.state.users[0], {
    deletionStatus: 'purging',
    purgeLeaseId: 'delete-lease',
    purgeLeaseExpiresAt: 2000
  });
  Object.assign(fixture.state.account_deletion_requests[0], {
    deletionStatus: 'purging',
    purgeLeaseId: 'delete-lease',
    purgeLeaseExpiresAt: 2000
  });
  const before = clone(fixture.state);
  const { fn, fakeDb } = loadCloudFunction(
    'cloudfunctions/deleteAccount/index.js',
    fixture.auth.binding._openid,
    fixture.state
  );

  const result = await atTime(1000, () => fn.main({ reason: 'must not reset purge' }));

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'ACCOUNT_DELETION_LOCKED');
  assert.deepStrictEqual(fixture.state, before);
  assert.strictEqual(fakeDb.__operations.updates.length, 0);
  assert.strictEqual(fakeDb.__operations.sets.length, 0);
}

async function testDeleteAllowsTerminalTombstoneForNewAccount() {
  const auth = identity('reused-openid', 'NewAccount');
  const state = {
    wechat_bindings: [auth.binding],
    accounts: [auth.account],
    users: [auth.user],
    subscriptions: [],
    account_deletion_requests: [{
      _id: auth.binding._id,
      _openid: 'old-openid-value',
      accountId: accountId('OldAccount'),
      account: 'OldAccount',
      deletionStatus: 'purged',
      deletionRequestedAt: 10,
      deletionScheduledAt: 20
    }]
  };
  const { fn } = loadCloudFunction(
    'cloudfunctions/deleteAccount/index.js',
    'reused-openid',
    state
  );

  const result = await atTime(1000, () => fn.main({ reason: 'new lifecycle' }));

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.deletionRequestedAt, 1000);
  assert.strictEqual(state.account_deletion_requests[0]._openid, 'reused-openid');
  assert.strictEqual(state.account_deletion_requests[0].accountId, auth.account._id);
  assert.strictEqual(state.account_deletion_requests[0].account, 'NewAccount');
}

async function testDeleteRejectsConflictingPendingRequestIdentity() {
  const auth = identity('conflict-openid', 'ConflictA');
  const state = {
    wechat_bindings: [auth.binding],
    accounts: [auth.account],
    users: [auth.user],
    subscriptions: [],
    account_deletion_requests: [{
      _id: auth.binding._id,
      _openid: 'another-openid',
      accountId: accountId('AnotherAccount'),
      account: 'AnotherAccount',
      deletionStatus: 'pending',
      deletionRequestedAt: 10,
      deletionScheduledAt: 20
    }]
  };
  const before = clone(state);
  const { fn } = loadCloudFunction(
    'cloudfunctions/deleteAccount/index.js',
    'conflict-openid',
    state
  );

  const result = await atTime(1000, () => fn.main({ reason: 'blocked' }));

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'DELETION_REQUEST_INCONSISTENT');
  assert.deepStrictEqual(state, before);
}

async function testDeleteRejectsActiveRecurringSubscriptionWithoutWrites() {
  for (const status of ['active', 'pending_contract', 'cancel_required']) {
    const auth = identity(`subscription-${status}`, `Subscription${status}`);
    const state = {
      wechat_bindings: [auth.binding],
      accounts: [auth.account],
      users: [auth.user],
      account_deletion_requests: [],
      subscriptions: [{ _id: `sub-${status}`, _openid: auth.binding._openid, status }]
    };
    const before = clone(state);
    const { fn, fakeDb } = loadCloudFunction(
      'cloudfunctions/deleteAccount/index.js',
      auth.binding._openid,
      state
    );

    const result = await fn.main({ reason: 'blocked by recurring payment' });

    assert.strictEqual(result.ok, false, status);
    assert.strictEqual(result.code, 'ACTIVE_SUBSCRIPTION', status);
    assert.deepStrictEqual(state, before, status);
    assert.strictEqual(fakeDb.__operations.updates.length, 0, status);
    assert.strictEqual(fakeDb.__operations.sets.length, 0, status);
  }
}

function dueState(openid, account) {
  const auth = identity(openid, account);
  auth.user.deletionStatus = 'pending';
  auth.user.deletionRequestedAt = 10;
  auth.user.deletionScheduledAt = 20;
  return {
    auth,
    state: Object.assign(emptyAuxiliaryState(), {
      wechat_bindings: [auth.binding],
      accounts: [auth.account],
      users: [auth.user],
      subscriptions: [],
      account_deletion_requests: [{
        _id: auth.binding._id,
        _openid: openid,
        accountId: auth.account._id,
        account: auth.account.account,
        deletionStatus: 'pending',
        deletionRequestedAt: 10,
        deletionScheduledAt: 20
      }],
      training_sessions: [{ _id: `${openid}-session`, _openid: openid }],
      stores: [{ _id: `${openid}-store`, _openid: openid }]
    })
  };
}

function assertPurgingLease(state, auth) {
  assert(state.accounts.some((item) => item._id === auth.account._id));
  assert(state.wechat_bindings.some((item) => item._id === auth.binding._id));
  const user = state.users.find((item) => item._id === auth.user._id);
  const request = state.account_deletion_requests.find((item) => item._id === auth.binding._id);
  assert(user);
  assert(request);
  assert.strictEqual(user.deletionStatus, 'purging');
  assert.strictEqual(request.deletionStatus, 'purging');
  assert(user.purgeLeaseId);
  assert.strictEqual(request.purgeLeaseId, user.purgeLeaseId);
  assert(Number.isFinite(user.purgeLeaseExpiresAt));
  assert.strictEqual(request.purgeLeaseExpiresAt, user.purgeLeaseExpiresAt);
  return { user, request };
}

async function testPurgeRequiresTrustedTimerInvocationWithoutDatabaseReads() {
  const variants = [
    {
      name: 'client forges timer payload',
      openid: 'attacker-openid',
      event: timerEvent()
    },
    {
      name: 'timer type is missing',
      openid: '',
      event: { TriggerName: 'dailyAccountDeletionPurge' }
    },
    {
      name: 'trigger name is forged',
      openid: '',
      event: { Type: 'Timer', TriggerName: 'attackerTrigger' }
    }
  ];

  for (const variant of variants) {
    const state = {};
    const { fn, fakeDb } = loadCloudFunction(
      'cloudfunctions/purgeDeletedAccounts/index.js',
      variant.openid,
      state
    );
    const result = await fn.main(variant.event);
    assert.deepStrictEqual(result, { ok: false, code: 'FORBIDDEN' }, variant.name);
    assert.strictEqual(fakeDb.__operations.reads.length, 0, variant.name);
    assert.strictEqual(fakeDb.__operations.queries.length, 0, variant.name);
    assert.strictEqual(fakeDb.__operations.updates.length, 0, variant.name);
    assert.strictEqual(fakeDb.__operations.deletes.length, 0, variant.name);
    assert.strictEqual(fakeDb.__operations.removes.length, 0, variant.name);
  }
}

async function testPurgeRemovesDeterministicAuthChainAndKeepsLegacyUser() {
  const fixture = dueState('purge-openid', 'PurgeA');
  fixture.state.account_deletion_requests[0].reason = 'privacy reason';
  const legacy = {
    _id: 'legacy-purge-user',
    _openid: 'purge-openid',
    role: 'coach',
    nickname: 'Legacy'
  };
  fixture.state.users.unshift(clone(legacy));
  const { fn, fakeDb } = loadCloudFunction(
    'cloudfunctions/purgeDeletedAccounts/index.js',
    '',
    fixture.state
  );

  const result = await atTime(1000, () => fn.main(timerEvent()));

  assert.strictEqual(fixture.state.accounts.find((item) => item._id === fixture.auth.account._id), undefined);
  assert.strictEqual(fixture.state.wechat_bindings.find((item) => item._id === fixture.auth.binding._id), undefined);
  assert.strictEqual(fixture.state.users.find((item) => item._id === fixture.auth.user._id), undefined);
  assert.deepStrictEqual(fixture.state.users.find((item) => item._id === legacy._id), legacy);
  assert.strictEqual(fixture.state.stores.length, 0, 'stores must be included in auxiliary cleanup');
  assert.strictEqual(
    fakeDb.__operations.removes.some((item) => item.collection === 'users'),
    false,
    'users must only be deleted through the authentication transaction'
  );
  const tombstone = fixture.state.account_deletion_requests[0];
  assert.strictEqual(tombstone.deletionStatus, 'purged');
  [
    '_openid',
    'accountId',
    'account',
    'reason',
    'deletionRequestedAt',
    'deletionScheduledAt',
    'purgeLeaseId',
    'purgeLeaseExpiresAt'
  ].forEach((field) => assert.strictEqual(Object.prototype.hasOwnProperty.call(tombstone, field), false, field));
  assert.deepStrictEqual(result, { ok: true, checked: 1, purged: 1, failed: 0 });
}

async function testPurgeHelperFailureKeepsAuthChainAndDoesNotBlockNextUser() {
  const failed = dueState('failed-openid', 'FailedA');
  const succeeds = dueState('second-openid', 'SecondA');
  const state = {};
  Object.keys(failed.state).forEach((name) => {
    state[name] = clone(failed.state[name]).concat(clone(succeeds.state[name] || []));
  });
  Object.keys(succeeds.state).forEach((name) => {
    if (!state[name]) state[name] = clone(succeeds.state[name]);
  });
  const { fn, fakeDb } = loadCloudFunction(
    'cloudfunctions/purgeDeletedAccounts/index.js',
    '',
    state,
    {
      failTransactionWrite(operation) {
        return operation.collection === 'stores' &&
          operation.method === 'delete' &&
          operation.id === failed.state.stores[0]._id;
      }
    }
  );

  const captured = await captureWarnings(() => atTime(1000, () => fn.main(timerEvent())));
  const result = captured.result;

  assertPurgingLease(state, failed.auth);
  assert.strictEqual(state.accounts.some((item) => item._id === succeeds.auth.account._id), false);
  assert.strictEqual(state.wechat_bindings.some((item) => item._id === succeeds.auth.binding._id), false);
  assert.strictEqual(state.users.some((item) => item._id === succeeds.auth.user._id), false);
  assert.strictEqual(
    state.account_deletion_requests.find((item) => item._id === succeeds.auth.binding._id).deletionStatus,
    'purged'
  );
  assert.deepStrictEqual(result, { ok: false, checked: 2, purged: 1, failed: 1 });
  assert(captured.warnings.some((line) => line.includes(bindingId('failed-openid').slice(0, 8))));
  assert(captured.warnings.every((line) => !line.includes('failed-openid')));
  const claimIndex = fakeDb.__operations.timeline.findIndex(
    (item) => item.type === 'docUpdate' && item.collection === 'users' && item.data.deletionStatus === 'purging'
  );
  const deleteIndex = fakeDb.__operations.timeline.findIndex((item) => item.type === 'docDelete');
  assert(claimIndex !== -1 && claimIndex < deleteIndex);
}

async function testPurgeAuthenticationDeleteFailureRollsBackTransaction() {
  const failures = [
    { collection: 'accounts', method: 'delete' },
    { collection: 'wechat_bindings', method: 'delete' },
    { collection: 'users', method: 'delete' },
    { collection: 'account_deletion_requests', method: 'update' }
  ];

  for (const failure of failures) {
    const fixture = dueState(`rollback-${failure.collection}`, `Rollback${failure.collection}`);
    const { fn } = loadCloudFunction(
      'cloudfunctions/purgeDeletedAccounts/index.js',
      '',
      fixture.state,
      {
        failTransactionWrite(operation) {
          if (operation.collection !== failure.collection || operation.method !== failure.method) {
            return false;
          }
          return failure.collection !== 'account_deletion_requests' ||
            operation.data.deletionStatus === 'purged';
        }
      }
    );

    const captured = await captureWarnings(() => atTime(1000, () => fn.main(timerEvent())));

    assertPurgingLease(fixture.state, fixture.auth);
    assert.deepStrictEqual(
      captured.result,
      { ok: false, checked: 1, purged: 0, failed: 1 },
      `${failure.collection}.${failure.method}`
    );
  }
}

async function testPurgeClaimWriteFailureRollsBackBeforeCleanup() {
  for (const collection of ['users', 'account_deletion_requests']) {
    const fixture = dueState(`claim-${collection}`, `Claim${collection}`);
    const before = clone(fixture.state);
    const { fn, fakeDb, deleteFileCalls } = loadCloudFunction(
      'cloudfunctions/purgeDeletedAccounts/index.js',
      '',
      fixture.state,
      {
        failTransactionWrite(operation) {
          return operation.transactionCount === 1 &&
            operation.collection === collection &&
            operation.method === 'update';
        }
      }
    );

    const captured = await captureWarnings(() => atTime(1000, () => fn.main(timerEvent())));

    assert.deepStrictEqual(captured.result, { ok: false, checked: 1, purged: 0, failed: 1 }, collection);
    assert.deepStrictEqual(fixture.state, before, collection);
    assert.strictEqual(fakeDb.__operations.removes.length, 0, collection);
    assert.strictEqual(deleteFileCalls.length, 0, collection);
  }
}

async function testPurgeLeaseBlocksUnexpiredAndAllowsExpiredTakeover() {
  const unexpired = dueState('unexpired-lease-openid', 'UnexpiredLeaseA');
  unexpired.state.users[0].deletionStatus = 'purging';
  unexpired.state.users[0].purgeLeaseId = 'existing-lease';
  unexpired.state.users[0].purgeLeaseExpiresAt = 2000;
  Object.assign(unexpired.state.account_deletion_requests[0], {
    deletionStatus: 'purging',
    purgeLeaseId: 'existing-lease',
    purgeLeaseExpiresAt: 2000
  });
  const unexpiredBefore = clone(unexpired.state);
  const unexpiredLoaded = loadCloudFunction(
    'cloudfunctions/purgeDeletedAccounts/index.js',
    '',
    unexpired.state
  );

  const blocked = await captureWarnings(() => atTime(1000, () => unexpiredLoaded.fn.main(timerEvent())));

  assert.deepStrictEqual(blocked.result, { ok: false, checked: 1, purged: 0, failed: 1 });
  assert.deepStrictEqual(unexpired.state, unexpiredBefore);
  assert.strictEqual(unexpiredLoaded.fakeDb.__operations.removes.length, 0);
  assert.strictEqual(unexpiredLoaded.deleteFileCalls.length, 0);

  const expired = dueState('expired-lease-openid', 'ExpiredLeaseA');
  expired.state.users[0].deletionStatus = 'purging';
  expired.state.users[0].purgeLeaseId = 'expired-lease';
  expired.state.users[0].purgeLeaseExpiresAt = 999;
  Object.assign(expired.state.account_deletion_requests[0], {
    deletionStatus: 'purging',
    purgeLeaseId: 'expired-lease',
    purgeLeaseExpiresAt: 999
  });
  const expiredLoaded = loadCloudFunction(
    'cloudfunctions/purgeDeletedAccounts/index.js',
    '',
    expired.state
  );

  const takenOver = await atTime(1000, () => expiredLoaded.fn.main(timerEvent()));

  assert.deepStrictEqual(takenOver, { ok: true, checked: 1, purged: 1, failed: 0 });
  assert.strictEqual(expired.state.accounts.length, 0);
  assert.strictEqual(expired.state.wechat_bindings.length, 0);
  assert.strictEqual(expired.state.users.length, 0);
  assert.strictEqual(expired.state.account_deletion_requests[0].deletionStatus, 'purged');
}

async function testPurgeFinalTransactionRejectsChangedLease() {
  const fixture = dueState('stolen-lease-openid', 'StolenLeaseA');
  fixture.state.training_sessions = [];
  fixture.state.stores = [];
  const { fn } = loadCloudFunction(
    'cloudfunctions/purgeDeletedAccounts/index.js',
    '',
    fixture.state,
    {
      beforeTransaction({ state, count }) {
        if (count !== 2) return;
        const user = state.users.find((item) => item._id === fixture.auth.user._id);
        const request = state.account_deletion_requests.find((item) => item._id === fixture.auth.binding._id);
        user.purgeLeaseId = 'stolen-lease';
        request.purgeLeaseId = 'stolen-lease';
      }
    }
  );

  const captured = await captureWarnings(() => atTime(1000, () => fn.main(timerEvent())));

  assert.deepStrictEqual(captured.result, { ok: false, checked: 1, purged: 0, failed: 1 });
  assert(fixture.state.accounts.some((item) => item._id === fixture.auth.account._id));
  assert(fixture.state.wechat_bindings.some((item) => item._id === fixture.auth.binding._id));
  const user = fixture.state.users.find((item) => item._id === fixture.auth.user._id);
  const request = fixture.state.account_deletion_requests.find((item) => item._id === fixture.auth.binding._id);
  assert.strictEqual(user.deletionStatus, 'purging');
  assert.strictEqual(request.deletionStatus, 'purging');
  assert.strictEqual(user.purgeLeaseId, 'stolen-lease');
  assert.strictEqual(request.purgeLeaseId, 'stolen-lease');
}

async function testRoleSelectionDoesNotCancelPendingDeletionGrace() {
  const fixture = roleSelectionFixture(0x61);
  const requestBefore = clone(fixture.request);
  const loaded = loadCloudFunction(
    'cloudfunctions/login/index.js',
    'must-not-be-read',
    fixture.state,
    { forbidWxContext: true }
  );

  const result = await withAuthEnvironment(() => atTime(2000, () => (
    loaded.fn.main({
      authProtocol: 2,
      role: 'coach',
      sessionToken: fixture.sessionToken
    })
  )));

  assert.deepStrictEqual(result, {
    ok: true,
    kind: 'role_selected',
    account: '',
    accountDisplay: '手机号用户',
    roles: ['member', 'coach'],
    currentRole: 'coach'
  });
  assert.deepStrictEqual(
    fixture.state.account_deletion_requests[0],
    requestBefore
  );
  assert.strictEqual(fixture.state.users[0].deletionStatus, 'pending');
  assert.strictEqual(fixture.state.users[0].deletionRequestedAt, 900);
  assert.strictEqual(fixture.state.users[0].deletionScheduledAt, 5000);
  assert.deepStrictEqual(loaded.wxContextCalls, []);
  assert(!loaded.fakeDb.__operations.reads.some(
    (operation) => operation.collection === 'account_deletion_requests'
  ));
  assert(!loaded.fakeDb.__operations.updates.some(
    (operation) => operation.collection === 'account_deletion_requests'
  ));
  assert.deepStrictEqual(
    loaded.fakeDb.__operations.updates.map((operation) => ({
      collection: operation.collection,
      id: operation.id,
      data: operation.data
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
}

async function testRoleSelectionRereadsLiveRoleInsideTransaction() {
  const fixture = roleSelectionFixture(0x62);
  const loaded = loadCloudFunction(
    'cloudfunctions/login/index.js',
    'must-not-be-read',
    fixture.state,
    {
      forbidWxContext: true,
      beforeTransaction({ state }) {
        state.users[0].roles = ['member'];
      }
    }
  );

  const result = await withAuthEnvironment(() => atTime(2000, () => (
    loaded.fn.main({
      authProtocol: 2,
      role: 'coach',
      sessionToken: fixture.sessionToken
    })
  )));

  assert.strictEqual(result.code, 'ROLE_NOT_ALLOWED');
  assert.deepStrictEqual(fixture.state.users[0].roles, ['member']);
  assert.strictEqual(fixture.state.users[0].currentRole, 'member');
  assert.strictEqual(loaded.fakeDb.__operations.updates.length, 0);
  assert(!loaded.fakeDb.__operations.reads.some(
    (operation) => operation.collection === 'account_deletion_requests'
  ));
}

async function testRoleSelectionRereadsRevokedSessionInsideTransaction() {
  const fixture = roleSelectionFixture(0x63);
  const requestBefore = clone(fixture.request);
  const loaded = loadCloudFunction(
    'cloudfunctions/login/index.js',
    'must-not-be-read',
    fixture.state,
    {
      forbidWxContext: true,
      beforeTransaction({ state }) {
        state.auth_sessions[0].revokedAt = 1500;
        state.auth_sessions[0].revokeReason = 'logout_current';
      }
    }
  );

  const result = await withAuthEnvironment(() => atTime(2000, () => (
    loaded.fn.main({
      authProtocol: 2,
      role: 'coach',
      sessionToken: fixture.sessionToken
    })
  )));

  assert.strictEqual(result.code, 'SESSION_EXPIRED');
  assert.strictEqual(fixture.state.users[0].currentRole, 'member');
  assert.strictEqual(fixture.state.users[0].role, 'member');
  assert(!loaded.fakeDb.__operations.updates.some(
    (operation) => operation.collection === 'users'
  ));
  assert.deepStrictEqual(
    fixture.state.account_deletion_requests[0],
    requestBefore
  );
  assert.deepStrictEqual(loaded.wxContextCalls, []);
}

async function testRoleSelectionRereadsAccountVersionInsideTransaction() {
  const fixture = roleSelectionFixture(0x64);
  const loaded = loadCloudFunction(
    'cloudfunctions/login/index.js',
    'must-not-be-read',
    fixture.state,
    {
      forbidWxContext: true,
      beforeTransaction({ state }) {
        state.accounts[0].authVersion = 2;
      }
    }
  );

  const result = await withAuthEnvironment(() => atTime(2000, () => (
    loaded.fn.main({
      authProtocol: 2,
      role: 'member',
      sessionToken: fixture.sessionToken
    })
  )));

  assert.strictEqual(result.code, 'SESSION_EXPIRED');
  assert.strictEqual(loaded.fakeDb.__operations.updates.length, 0);
  assert.deepStrictEqual(
    fixture.state.account_deletion_requests[0],
    fixture.request
  );
}

async function testPurgePreflightRequiresDeterministicRequest() {
  const fixture = dueState('missing-request-openid', 'MissingRequestA');
  fixture.state.account_deletion_requests = [];
  const before = clone(fixture.state);
  const { fn } = loadCloudFunction(
    'cloudfunctions/purgeDeletedAccounts/index.js',
    '',
    fixture.state
  );

  const captured = await captureWarnings(() => atTime(1000, () => fn.main(timerEvent())));
  const result = captured.result;

  assert.deepStrictEqual(fixture.state, before);
  assert.deepStrictEqual(result, { ok: false, checked: 1, purged: 0, failed: 1 });
  assert(captured.warnings.some((line) => line.includes(bindingId('missing-request-openid').slice(0, 8))));
  assert(captured.warnings.every((line) => !line.includes('missing-request-openid')));
}

async function testPurgeValidatesCompleteAccountAndFiniteRequestChain() {
  const variants = [
    {
      name: 'binding account missing',
      mutate(fixture) {
        delete fixture.state.wechat_bindings[0].account;
      }
    },
    {
      name: 'request account missing',
      mutate(fixture) {
        delete fixture.state.account_deletion_requests[0].account;
      }
    },
    {
      name: 'requested times are not finite numbers',
      mutate(fixture) {
        fixture.state.users[0].deletionRequestedAt = '10';
        fixture.state.account_deletion_requests[0].deletionRequestedAt = '10';
      }
    },
    {
      name: 'scheduled times are not finite numbers',
      mutate(fixture) {
        fixture.state.users[0].deletionScheduledAt = '20';
        fixture.state.account_deletion_requests[0].deletionScheduledAt = '20';
      }
    }
  ];

  for (const variant of variants) {
    const fixture = dueState(`invalid-${variant.name}`, `Invalid${variant.name}`);
    variant.mutate(fixture);
    const before = clone(fixture.state);
    const { fn } = loadCloudFunction(
      'cloudfunctions/purgeDeletedAccounts/index.js',
      '',
      fixture.state
    );
    const captured = await captureWarnings(() => atTime(1000, () => fn.main(timerEvent())));
    assert.deepStrictEqual(
      captured.result,
      { ok: false, checked: 1, purged: 0, failed: 1 },
      variant.name
    );
    assert.deepStrictEqual(fixture.state, before, variant.name);
  }
}

async function testPurgeProcessesAllDuePagesBeforeDeleting() {
  const state = Object.assign(emptyAuxiliaryState(), {
    wechat_bindings: [],
    accounts: [],
    users: [],
    account_deletion_requests: [],
    subscriptions: []
  });
  let validAuth;
  for (let i = 0; i < 101; i += 1) {
    const auth = identity(`batch-openid-${i}`, `Batch${i}`);
    auth.user.deletionStatus = 'pending';
    auth.user.deletionRequestedAt = 1;
    auth.user.deletionScheduledAt = i + 1;
    state.users.push(auth.user);
    if (i !== 100) continue;
    validAuth = auth;
    state.wechat_bindings.push(auth.binding);
    state.accounts.push(auth.account);
    state.account_deletion_requests.push({
      _id: auth.binding._id,
      _openid: auth.binding._openid,
      accountId: auth.account._id,
      account: auth.account.account,
      deletionStatus: 'pending',
      deletionRequestedAt: 1,
      deletionScheduledAt: 101
    });
  }
  const { fn, fakeDb } = loadCloudFunction(
    'cloudfunctions/purgeDeletedAccounts/index.js',
    '',
    state
  );

  const captured = await captureWarnings(() => atTime(1000, () => fn.main(timerEvent())));

  assert.deepStrictEqual(captured.result, { ok: false, checked: 101, purged: 1, failed: 100 });
  assert.strictEqual(state.accounts.some((item) => item._id === validAuth.account._id), false);
  const dueQueries = fakeDb.__operations.queries.filter((item) => item.collection === 'users');
  assert.deepStrictEqual(dueQueries[0].query.deletionStatus.$in, ['pending', 'purging']);
  assert.deepStrictEqual(dueQueries[1].query.$and[0].deletionStatus.$in, ['pending', 'purging']);
  assert.deepStrictEqual(dueQueries.map((item) => item.skip), [0, 0]);
  assert.deepStrictEqual(dueQueries[0].orderings, [
    { field: '_id', direction: 'asc' }
  ]);
  const secondPageIndex = fakeDb.__operations.timeline.findIndex(
    (item) => item.type === 'queryGet' && item.collection === 'users' && item.query.$and
  );
  const firstDeleteIndex = fakeDb.__operations.timeline.findIndex((item) => item.type === 'docDelete');
  assert(secondPageIndex !== -1 && secondPageIndex < firstDeleteIndex);
}

async function testPurgeCountsMalformedPendingSchedulesButSkipsValidFuture() {
  const due = dueState('schedule-due-openid', 'ScheduleDue');
  const future = dueState('schedule-future-openid', 'ScheduleFuture');
  future.state.users[0].deletionScheduledAt = 2000;
  future.state.account_deletion_requests[0].deletionScheduledAt = 2000;
  const missing = dueState('schedule-missing-openid', 'ScheduleMissing');
  delete missing.state.users[0].deletionScheduledAt;
  delete missing.state.account_deletion_requests[0].deletionScheduledAt;
  const nil = dueState('schedule-null-openid', 'ScheduleNull');
  nil.state.users[0].deletionScheduledAt = null;
  nil.state.account_deletion_requests[0].deletionScheduledAt = null;
  const text = dueState('schedule-string-openid', 'ScheduleString');
  text.state.users[0].deletionScheduledAt = '20';
  text.state.account_deletion_requests[0].deletionScheduledAt = '20';
  const fixtures = [due, future, missing, nil, text];
  const state = {};
  fixtures.forEach((fixture) => {
    Object.keys(fixture.state).forEach((name) => {
      state[name] = (state[name] || []).concat(clone(fixture.state[name]));
    });
  });
  const { fn } = loadCloudFunction(
    'cloudfunctions/purgeDeletedAccounts/index.js',
    '',
    state
  );

  const captured = await captureWarnings(() => atTime(1000, () => fn.main(timerEvent())));

  assert.deepStrictEqual(captured.result, { ok: false, checked: 4, purged: 1, failed: 3 });
  assert.strictEqual(state.accounts.some((item) => item._id === due.auth.account._id), false);
  assert.strictEqual(state.accounts.some((item) => item._id === future.auth.account._id), true);
  [missing, nil, text].forEach((fixture) => {
    assert(state.accounts.some((item) => item._id === fixture.auth.account._id));
  });
}

async function testPurgeMissingAuxiliaryCollectionFailsClosed() {
  for (const name of ['brands', 'email_bindings', 'email_codes']) {
    const fixture = dueState(`missing-${name}-openid`, `Missing${name}`);
    delete fixture.state[name];
    const { fn } = loadCloudFunction(
      'cloudfunctions/purgeDeletedAccounts/index.js',
      '',
      fixture.state
    );

    const captured = await captureWarnings(() => atTime(1000, () => fn.main(timerEvent())));

    assert.deepStrictEqual(captured.result, { ok: false, checked: 1, purged: 0, failed: 1 }, name);
    assertPurgingLease(fixture.state, fixture.auth);
  }
}

async function testPurgeEmailCleanupFailureKeepsAuthenticationChain() {
  for (const name of ['email_bindings', 'email_codes']) {
    const fixture = dueState(`email-failure-${name}`, `EmailFailure${name}`);
    fixture.state[name].push({
      _id: `${name}-owned`,
      accountId: fixture.auth.account._id,
      actorHash: sha256(fixture.auth.binding._openid)
    });
    const { fn } = loadCloudFunction(
      'cloudfunctions/purgeDeletedAccounts/index.js',
      '',
      fixture.state,
      {
        failTransactionWrite(operation) {
          return operation.collection === name && operation.method === 'delete';
        }
      }
    );

    const captured = await captureWarnings(() => atTime(1000, () => fn.main(timerEvent())));

    assert.deepStrictEqual(captured.result, { ok: false, checked: 1, purged: 0, failed: 1 }, name);
    assertPurgingLease(fixture.state, fixture.auth);
  }
}

async function testPurgeBlocksActiveRecurringSubscription() {
  for (const status of ['active', 'pending_contract', 'cancel_required']) {
    const fixture = dueState(`purge-subscription-${status}`, `PurgeSubscription${status}`);
    fixture.state.subscriptions.push({
      _id: `purge-sub-${status}`,
      _openid: fixture.auth.binding._openid,
      status
    });
    fixture.state.users[0].subscriptionStatus = status;
    const authBefore = clone({
      accounts: fixture.state.accounts,
      wechat_bindings: fixture.state.wechat_bindings,
      users: fixture.state.users,
      account_deletion_requests: fixture.state.account_deletion_requests
    });
    const { fn } = loadCloudFunction(
      'cloudfunctions/purgeDeletedAccounts/index.js',
      '',
      fixture.state
    );

    const captured = await captureWarnings(() => atTime(1000, () => fn.main(timerEvent())));

    assert.deepStrictEqual(captured.result, { ok: false, checked: 1, purged: 0, failed: 1 }, status);
    assert.deepStrictEqual({
      accounts: fixture.state.accounts,
      wechat_bindings: fixture.state.wechat_bindings,
      users: fixture.state.users,
      account_deletion_requests: fixture.state.account_deletion_requests
    }, authBefore, status);
  }
}

async function testPurgeRechecksSubscriptionBeforeDestructiveCleanup() {
  const fixture = dueState('subscription-race-openid', 'SubscriptionRaceA');
  const openid = fixture.auth.binding._openid;
  fixture.state.subscriptions.push({
    _id: 'subscription-race',
    _openid: openid,
    status: 'canceled'
  });
  const auxiliaryBefore = clone(emptyAuxiliaryState());
  AUXILIARY_COLLECTIONS.forEach((name) => {
    auxiliaryBefore[name] = clone(fixture.state[name]);
  });
  let activated = false;
  const { fn } = loadCloudFunction(
    'cloudfunctions/purgeDeletedAccounts/index.js',
    '',
    fixture.state,
    {
      afterQueryGet({ collection }) {
        if (collection !== 'posts' || activated) return;
        activated = true;
        fixture.state.subscriptions[0].status = 'active';
      }
    }
  );

  const captured = await captureWarnings(() => atTime(1000, () => fn.main(timerEvent())));

  assert.strictEqual(activated, true);
  assert.deepStrictEqual(captured.result, { ok: false, checked: 1, purged: 0, failed: 1 });
  assertPurgingLease(fixture.state, fixture.auth);
  AUXILIARY_COLLECTIONS.forEach((name) => {
    assert.deepStrictEqual(fixture.state[name], auxiliaryBefore[name], name);
  });
}

async function testPurgeRemovesPersonalDataCascadesAndCloudFilesButKeepsFinance() {
  const fixture = dueState('personal-openid', 'PersonalA');
  const openid = fixture.auth.binding._openid;
  fixture.auth.user.avatar = ownedFile(fixture.auth, 'avatars/user-avatar');
  fixture.state.coaches.push({
    _id: 'coach-owned',
    _openid: openid,
    avatar: ownedFile(fixture.auth, 'avatars/coach-avatar'),
    certificates: [ownedFile(fixture.auth, 'certificates/coach-cert')]
  });
  fixture.state.shop_applications.push({
    _id: 'shop-app-owned',
    _openid: openid,
    licenseFileID: ownedFile(fixture.auth, 'licenses/license')
  });
  fixture.state.shops.push({
    _id: 'shop-owned',
    _openid: openid,
    tableTypes: [{ image: ownedFile(fixture.auth, 'shops/table-types/snooker') }]
  });
  fixture.state.coach_shop_applications.push({
    _id: 'coach-app-owned',
    coachOpenid: openid,
    coachAvatar: ownedFile(fixture.auth, 'avatars/coach-application-avatar')
  });
  fixture.state.coach_shop_applications.push({
    _id: 'coach-app-foreign',
    coachOpenid: 'foreign-coach',
    shopOpenid: openid,
    coachAvatar: `cloud://test-env.bucket/user-content/${bindingId('foreign-coach')}/avatars/coach-avatar`
  });
  fixture.state.checkin_requests.push({
    _id: 'checkin-owned',
    memberOpenid: openid,
    avatar: ownedFile(fixture.auth, 'avatars/checkin-avatar')
  });
  fixture.state.sessions.push({ _id: 'session-owned', memberOpenid: openid });
  fixture.state.brands.push({ _id: 'brand-owned', _openid: openid, logo: ownedFile(fixture.auth, 'brands/logo') });
  fixture.state.members.push({ _id: 'member-owned', _openid: openid, avatar: ownedFile(fixture.auth, 'avatars/member-avatar') });
  fixture.state.stores[0].cover = ownedFile(fixture.auth, 'stores/cover');
  fixture.state.posts.push({
    _id: 'post-owned',
    _openid: openid,
    authorAvatar: ownedFile(fixture.auth, 'avatars/post-author'),
    images: [ownedFile(fixture.auth, 'posts/image-1'), ownedFile(fixture.auth, 'posts/image-2')],
    video: ownedFile(fixture.auth, 'posts/video'),
    cover: ownedFile(fixture.auth, 'posts/cover')
  });
  fixture.state.post_likes.push({ _id: 'like-by-post', _openid: 'foreign', postId: 'post-owned' });
  fixture.state.post_comments.push({
    _id: 'comment-by-post',
    _openid: 'foreign',
    postId: 'post-owned',
    authorAvatar: `cloud://test-env.bucket/user-content/${bindingId('foreign')}/avatars/comment`
  });
  fixture.state.matches.push({ _id: 'match-owned', _openid: openid });
  fixture.state.match_joins.push({ _id: 'join-by-match', _openid: 'foreign', matchId: 'match-owned' });
  fixture.state.shop_coach_links.push({ _id: 'link-by-store', storeId: fixture.state.stores[0]._id });
  fixture.state.checkin_requests.push({
    _id: 'checkin-by-store',
    memberOpenid: 'foreign',
    storeId: fixture.state.stores[0]._id,
    avatar: `cloud://test-env.bucket/user-content/${bindingId('foreign')}/avatars/checkin`
  });
  fixture.state.sessions.push({
    _id: 'session-by-store',
    _openid: 'foreign',
    storeId: fixture.state.stores[0]._id
  });
  fixture.state.sms_codes.push({ _id: 'sms-owned', _openid: openid });
  fixture.state.email_bindings.push(
    { _id: 'email-binding-active', accountId: fixture.auth.account._id, status: 'active' },
    { _id: 'email-binding-revoked', accountId: fixture.auth.account._id, status: 'revoked' },
    { _id: 'email-binding-foreign', accountId: 'foreign-account-id', status: 'active' }
  );
  fixture.state.email_codes.push(
    { _id: 'email-challenge-owned', accountId: fixture.auth.account._id },
    { _id: 'email-rate-owned', actorHash: sha256(openid) },
    { _id: 'email-challenge-foreign', accountId: 'foreign-account-id' },
    { _id: 'email-rate-foreign', actorHash: sha256('foreign-openid') }
  );
  fixture.state.coach_lessons.push(
    { _id: 'lesson-personal', coachOpenid: openid },
    { _id: 'lesson-zero', coachOpenid: openid, amount: 0 },
    { _id: 'lesson-financial', coachOpenid: openid, amount: 88, settlementStatus: 'pending' },
    { _id: 'lesson-refund', coachOpenid: openid, amount: -20 },
    { _id: 'lesson-unknown-amount', coachOpenid: openid, amount: 'unknown' }
  );
  fixture.state.orders = [{ _id: 'order-retained', _openid: openid }];
  fixture.state.subscriptions.push({ _id: 'subscription-retained', _openid: openid, status: 'canceled' });
  fixture.state.shop_orders = [{ _id: 'shop-order-retained', _openid: openid }];
  fixture.state.coach_settlements = [{ _id: 'settlement-retained', coachOpenid: openid }];
  fixture.state.fulfill_failures = [{ _id: 'failure-retained', _openid: openid }];
  const { fn, deleteFileCalls } = loadCloudFunction(
    'cloudfunctions/purgeDeletedAccounts/index.js',
    '',
    fixture.state
  );

  const result = await atTime(1000, () => fn.main(timerEvent()));
  const deletedFiles = deleteFileCalls.flat();

  assert.deepStrictEqual(result, { ok: true, checked: 1, purged: 1, failed: 0 });
  [
    ownedFile(fixture.auth, 'licenses/license'),
    ownedFile(fixture.auth, 'shops/table-types/snooker'),
    ownedFile(fixture.auth, 'posts/image-1'),
    ownedFile(fixture.auth, 'posts/video'),
    ownedFile(fixture.auth, 'posts/cover')
  ].forEach((fileID) => {
    assert(deletedFiles.includes(fileID), `${fileID} must be passed to cloud.deleteFile`);
  });
  [
    `cloud://test-env.bucket/user-content/${bindingId('foreign')}/avatars/comment`,
    `cloud://test-env.bucket/user-content/${bindingId('foreign')}/avatars/checkin`,
    `cloud://test-env.bucket/user-content/${bindingId('foreign-coach')}/avatars/coach-avatar`
  ].forEach((fileID) => {
    assert.strictEqual(deletedFiles.includes(fileID), false, `${fileID} belongs to another user`);
  });
  [
    'sms_codes',
    'shop_applications',
    'coach_shop_applications',
    'checkin_requests',
    'sessions',
    'brands',
    'members',
    'post_likes',
    'post_comments',
    'match_joins',
    'shop_coach_links'
  ].forEach((name) => assert.strictEqual(fixture.state[name].length, 0, name));
  assert.deepStrictEqual(fixture.state.email_bindings.map((item) => item._id), ['email-binding-foreign']);
  assert.deepStrictEqual(
    fixture.state.email_codes.map((item) => item._id).sort(),
    ['email-challenge-foreign', 'email-rate-foreign']
  );
  assert.strictEqual(fixture.state.coach_lessons.some((item) => item._id === 'lesson-personal'), false);
  assert.strictEqual(fixture.state.coach_lessons.some((item) => item._id === 'lesson-zero'), false);
  assert.strictEqual(fixture.state.coach_lessons.some((item) => item._id === 'lesson-financial'), true);
  assert.strictEqual(fixture.state.coach_lessons.some((item) => item._id === 'lesson-refund'), true);
  assert.strictEqual(fixture.state.coach_lessons.some((item) => item._id === 'lesson-unknown-amount'), true);
  ['orders', 'subscriptions', 'shop_orders', 'coach_settlements', 'fulfill_failures'].forEach((name) => {
    assert.strictEqual(fixture.state[name].length, 1, `${name} must be retained`);
  });
}

async function testPurgeCloudFileFailureKeepsAuthenticationChain() {
  const fixture = dueState('file-failure-openid', 'FileFailureA');
  const openid = fixture.auth.binding._openid;
  fixture.state.shop_applications.push({
    _id: 'file-failure-license',
    _openid: openid,
    licenseFileID: ownedFile(fixture.auth, 'licenses/failure')
  });
  fixture.state.posts.push({
    _id: 'file-failure-post',
    _openid: openid,
    images: [ownedFile(fixture.auth, 'posts/failure')]
  });
  const { fn, deleteFileCalls } = loadCloudFunction(
    'cloudfunctions/purgeDeletedAccounts/index.js',
    '',
    fixture.state,
    {
      deleteFile(fileList) {
        return {
          fileList: fileList.map((fileID, index) => ({
            fileID,
            code: index === 0 ? 'FAIL' : 'SUCCESS'
          }))
        };
      }
    }
  );

  const captured = await captureWarnings(() => atTime(1000, () => fn.main(timerEvent())));

  assert(deleteFileCalls.flat().includes(ownedFile(fixture.auth, 'licenses/failure')));
  assert(deleteFileCalls.flat().includes(ownedFile(fixture.auth, 'posts/failure')));
  assert.deepStrictEqual(captured.result, { ok: false, checked: 1, purged: 0, failed: 1 });
  assertPurgingLease(fixture.state, fixture.auth);
  assert(captured.warnings.every((line) => !line.includes(openid)));
  assert(captured.warnings.some((line) => line.includes(bindingId(openid).slice(0, 8))));
}

async function testPurgeDoesNotLetLegacySuccessStatusOverrideFailureCode() {
  const fixture = dueState('file-code-precedence-openid', 'FileCodePrecedenceA');
  fixture.state.posts.push({
    _id: 'file-code-precedence-post',
    _openid: fixture.auth.binding._openid,
    images: [ownedFile(fixture.auth, 'posts/code-precedence')]
  });
  const { fn } = loadCloudFunction(
    'cloudfunctions/purgeDeletedAccounts/index.js',
    '',
    fixture.state,
    {
      deleteFile(fileList) {
        return {
          fileList: fileList.map((fileID) => ({
            fileID,
            code: 'PERMISSION_DENIED',
            status: 0
          }))
        };
      }
    }
  );

  const captured = await captureWarnings(() => atTime(1000, () => fn.main(timerEvent())));

  assert.deepStrictEqual(captured.result, { ok: false, checked: 1, purged: 0, failed: 1 });
  assertPurgingLease(fixture.state, fixture.auth);
}

async function testPurgePaginatesFileQueriesAndBatchesCloudDeletion() {
  const fixture = dueState('many-files-openid', 'ManyFilesA');
  const openid = fixture.auth.binding._openid;
  for (let i = 0; i < 101; i += 1) {
    fixture.state.posts.push({
      _id: `many-files-post-${String(i).padStart(3, '0')}`,
      _openid: openid,
      images: [ownedFile(fixture.auth, `posts/many-file-${i}`)]
    });
  }
  let batchIndex = 0;
  const { fn, deleteFileCalls } = loadCloudFunction(
    'cloudfunctions/purgeDeletedAccounts/index.js',
    '',
    fixture.state,
    {
      deleteFile(fileList) {
        if (fileList.length > 50) throw new Error('deleteFile batch too large');
        batchIndex += 1;
        return {
          fileList: fileList.map((fileID) => {
            if (batchIndex === 1) return { fileID, code: 'SUCCESS' };
            if (batchIndex === 2) return { fileID, status: 0 };
            return { fileID, status: 'SUCCESS' };
          })
        };
      }
    }
  );

  const result = await atTime(1000, () => fn.main(timerEvent()));

  assert.deepStrictEqual(result, { ok: true, checked: 1, purged: 1, failed: 0 });
  assert.deepStrictEqual(deleteFileCalls.map((fileList) => fileList.length), [50, 50, 1]);
  assert(deleteFileCalls.flat().includes(ownedFile(fixture.auth, 'posts/many-file-100')));
  assert.strictEqual(fixture.state.posts.length, 0);
}

async function testPurgeDeletesOnlyFilesInDeterministicUserNamespace() {
  const fixture = dueState('file-namespace-openid', 'FileNamespaceA');
  const owned = ownedFile(fixture.auth, 'posts/owned-image');
  const victim = `cloud://test-env.bucket/user-content/${bindingId('victim-openid')}/posts/victim-image`;
  const legacy = 'cloud://test-env.bucket/legacy/shared-image';
  const openidOwned = `cloud://test-env.bucket/user-content/${fixture.auth.binding._openid}/posts/openid-owned`;
  const nearPrefix = `cloud://test-env.bucket/user-content/${fixture.auth.user._id}-victim/posts/image`;
  const ownerDirectory = `cloud://test-env.bucket/user-content/${fixture.auth.user._id}`;
  const encodedEscape = `cloud://test-env.bucket/user-content/${fixture.auth.user._id}/%2e%2e/victim`;
  const dotEscape = `cloud://test-env.bucket/user-content/${fixture.auth.user._id}/../victim`;
  const backslashEscape = `cloud://test-env.bucket/user-content/${fixture.auth.user._id}/posts\\victim`;
  const querySuffix = `${owned}?download=1`;
  const invalidHosts = ['.', '..', '.env', 'env.', 'env..bucket'].map(
    (host) => `cloud://${host}/user-content/${fixture.auth.user._id}/posts/image`
  );
  fixture.state.posts.push({
    _id: 'file-namespace-post',
    _openid: fixture.auth.binding._openid,
    images: [
      owned,
      openidOwned,
      victim,
      legacy,
      nearPrefix,
      ownerDirectory,
      encodedEscape,
      dotEscape,
      backslashEscape,
      querySuffix,
      ...invalidHosts
    ]
  });
  const { fn, deleteFileCalls } = loadCloudFunction(
    'cloudfunctions/purgeDeletedAccounts/index.js',
    '',
    fixture.state
  );

  const result = await atTime(1000, () => fn.main(timerEvent()));
  const deleted = deleteFileCalls.flat();

  assert.deepStrictEqual(result, { ok: true, checked: 1, purged: 1, failed: 0 });
  assert(deleted.includes(owned));
  [
    openidOwned,
    victim,
    legacy,
    nearPrefix,
    ownerDirectory,
    encodedEscape,
    dotEscape,
    backslashEscape,
    querySuffix,
    ...invalidHosts
  ].forEach((fileID) => assert.strictEqual(deleted.includes(fileID), false, fileID));
}

async function testPurgeTreatsMissingCloudFileAsIdempotentRetrySuccess() {
  const fixture = dueState('file-retry-openid', 'FileRetryA');
  fixture.state.posts.push({
    _id: 'file-retry-post',
    _openid: fixture.auth.binding._openid,
    images: [ownedFile(fixture.auth, 'posts/retry-image')]
  });
  let deletionAttempt = 0;
  const firstLoaded = loadCloudFunction(
    'cloudfunctions/purgeDeletedAccounts/index.js',
    '',
    fixture.state,
    {
      deleteFile(fileList) {
        deletionAttempt += 1;
        return { fileList: fileList.map((fileID) => ({ fileID, code: 'SUCCESS' })) };
      },
      failTransactionWrite(operation) {
        return operation.collection === 'stores' && operation.method === 'delete';
      }
    }
  );

  const first = await captureWarnings(() => atTime(1000, () => firstLoaded.fn.main(timerEvent())));
  assert.deepStrictEqual(first.result, { ok: false, checked: 1, purged: 0, failed: 1 });
  assertPurgingLease(fixture.state, fixture.auth);

  const secondLoaded = loadCloudFunction(
    'cloudfunctions/purgeDeletedAccounts/index.js',
    '',
    fixture.state,
    {
      deleteFile(fileList) {
        deletionAttempt += 1;
        return {
          fileList: fileList.map((fileID) => ({ fileID, code: 'STORAGE_FILE_NONEXIST' }))
        };
      }
    }
  );
  const second = await atTime(602000, () => secondLoaded.fn.main(timerEvent()));

  assert.deepStrictEqual(second, { ok: true, checked: 1, purged: 1, failed: 0 });
  assert.strictEqual(deletionAttempt, 2);
}

async function testPurgeRenewsLeaseBeforeEveryCloudFileBatch() {
  const fixture = dueState('file-lease-openid', 'FileLeaseA');
  for (let i = 0; i < 51; i += 1) {
    fixture.state.posts.push({
      _id: `file-lease-post-${String(i).padStart(3, '0')}`,
      _openid: fixture.auth.binding._openid,
      images: [ownedFile(fixture.auth, `posts/lease-${i}`)]
    });
  }
  const loaded = loadCloudFunction(
    'cloudfunctions/purgeDeletedAccounts/index.js',
    '',
    fixture.state,
    {
      beforeTransaction({ state, count }) {
        if (count !== 3) return;
        const user = state.users.find((item) => item._id === fixture.auth.user._id);
        const request = state.account_deletion_requests.find((item) => item._id === fixture.auth.binding._id);
        user.purgeLeaseId = 'takeover-lease';
        request.purgeLeaseId = 'takeover-lease';
      }
    }
  );

  const captured = await captureWarnings(() => atTime(1000, () => loaded.fn.main(timerEvent())));

  assert.deepStrictEqual(captured.result, { ok: false, checked: 1, purged: 0, failed: 1 });
  assert.strictEqual(loaded.deleteFileCalls.length, 1);
  assert.strictEqual(loaded.deleteFileCalls[0].length, 50);
  assert(fixture.state.accounts.some((item) => item._id === fixture.auth.account._id));
  assert.strictEqual(fixture.state.users[0].purgeLeaseId, 'takeover-lease');
}

async function testPurgeRenewsLeaseInsideEveryDatabaseDeleteBatch() {
  const fixture = dueState('database-lease-openid', 'DatabaseLeaseA');
  const loaded = loadCloudFunction(
    'cloudfunctions/purgeDeletedAccounts/index.js',
    '',
    fixture.state,
    {
      beforeTransaction({ state, count }) {
        if (count !== 3) return;
        const user = state.users.find((item) => item._id === fixture.auth.user._id);
        const request = state.account_deletion_requests.find((item) => item._id === fixture.auth.binding._id);
        user.purgeLeaseId = 'database-takeover';
        request.purgeLeaseId = 'database-takeover';
      }
    }
  );

  const captured = await captureWarnings(() => atTime(1000, () => loaded.fn.main(timerEvent())));

  assert.deepStrictEqual(captured.result, { ok: false, checked: 1, purged: 0, failed: 1 });
  assert.strictEqual(fixture.state.training_sessions.length, 0);
  assert.strictEqual(fixture.state.stores.length, 1);
  assert(fixture.state.accounts.some((item) => item._id === fixture.auth.account._id));
  assert.strictEqual(fixture.state.users[0].purgeLeaseId, 'database-takeover');
}

async function testPurgeStopsCloudBatchesWhenSubscriptionMarkerActivates() {
  const fixture = dueState('file-marker-openid', 'FileMarkerA');
  for (let i = 0; i < 51; i += 1) {
    fixture.state.posts.push({
      _id: `file-marker-post-${String(i).padStart(3, '0')}`,
      _openid: fixture.auth.binding._openid,
      images: [ownedFile(fixture.auth, `posts/marker-${i}`)]
    });
  }
  let activated = false;
  const loaded = loadCloudFunction(
    'cloudfunctions/purgeDeletedAccounts/index.js',
    '',
    fixture.state,
    {
      deleteFile(fileList) {
        if (!activated) {
          activated = true;
          fixture.state.users[0].subscriptionStatus = 'active';
        }
        return { fileList: fileList.map((fileID) => ({ fileID, code: 'SUCCESS' })) };
      }
    }
  );

  const captured = await captureWarnings(() => atTime(1000, () => loaded.fn.main(timerEvent())));

  assert.strictEqual(activated, true);
  assert.deepStrictEqual(captured.result, { ok: false, checked: 1, purged: 0, failed: 1 });
  assert.strictEqual(loaded.deleteFileCalls.length, 1);
  assert(fixture.state.accounts.some((item) => item._id === fixture.auth.account._id));
  assert.strictEqual(fixture.state.users[0].subscriptionStatus, 'active');
}

async function testPurgeStopsDatabaseBatchesWhenSubscriptionMarkerActivates() {
  const fixture = dueState('database-marker-openid', 'DatabaseMarkerA');
  const loaded = loadCloudFunction(
    'cloudfunctions/purgeDeletedAccounts/index.js',
    '',
    fixture.state,
    {
      beforeTransaction({ state, count }) {
        if (count === 3) state.users[0].subscriptionStatus = 'active';
      }
    }
  );

  const captured = await captureWarnings(() => atTime(1000, () => loaded.fn.main(timerEvent())));

  assert.deepStrictEqual(captured.result, { ok: false, checked: 1, purged: 0, failed: 1 });
  assert.strictEqual(fixture.state.training_sessions.length, 0);
  assert.strictEqual(fixture.state.stores.length, 1);
  assert(fixture.state.accounts.some((item) => item._id === fixture.auth.account._id));
  assert.strictEqual(fixture.state.users[0].subscriptionStatus, 'active');
}

async function testPurgeFinalTransactionRejectsExpiredSameLease() {
  const fixture = dueState('expired-final-openid', 'ExpiredFinalA');
  fixture.state.training_sessions = [];
  fixture.state.stores = [];
  fixture.state.users[0].avatar = ownedFile(fixture.auth, 'avatars/expire-before-final');
  let now = 1000;
  const loaded = loadCloudFunction(
    'cloudfunctions/purgeDeletedAccounts/index.js',
    '',
    fixture.state,
    {
      deleteFile(fileList) {
        now = 602000;
        return { fileList: fileList.map((fileID) => ({ fileID, code: 'SUCCESS' })) };
      }
    }
  );
  const originalNow = Date.now;
  Date.now = () => now;
  let captured;
  try {
    captured = await captureWarnings(() => loaded.fn.main(timerEvent()));
  } finally {
    Date.now = originalNow;
  }

  assert.deepStrictEqual(captured.result, { ok: false, checked: 1, purged: 0, failed: 1 });
  assert.strictEqual(loaded.deleteFileCalls.length, 1);
  assert(fixture.state.accounts.some((item) => item._id === fixture.auth.account._id));
}

async function testPurgeUsesFreshNowForEachCandidate() {
  const fixtures = [
    dueState('fresh-now-a', 'FreshNowA'),
    dueState('fresh-now-b', 'FreshNowB')
  ].sort((left, right) => left.auth.user._id.localeCompare(right.auth.user._id));
  fixtures.forEach((fixture) => {
    fixture.state.training_sessions = [];
    fixture.state.stores = [];
  });
  fixtures[1].state.users[0].deletionScheduledAt = 1500;
  fixtures[1].state.account_deletion_requests[0].deletionScheduledAt = 1500;
  const state = {};
  fixtures.forEach((fixture) => {
    Object.keys(fixture.state).forEach((name) => {
      state[name] = (state[name] || []).concat(clone(fixture.state[name]));
    });
  });
  let now = 1000;
  const loaded = loadCloudFunction(
    'cloudfunctions/purgeDeletedAccounts/index.js',
    '',
    state,
    {
      beforeTransaction({ count }) {
        if (count === 2) now = 2000;
      }
    }
  );
  const originalNow = Date.now;
  Date.now = () => now;
  let result;
  try {
    result = await loaded.fn.main(timerEvent());
  } finally {
    Date.now = originalNow;
  }

  assert.deepStrictEqual(result, { ok: true, checked: 2, purged: 2, failed: 0 });
}

async function testPurgeUsesKeysetEnumerationAndDeletesOnlyEnumeratedDocuments() {
  const fixture = dueState('keyset-openid', 'KeysetA');
  fixture.state.posts = [];
  for (let i = 0; i < 101; i += 1) {
    fixture.state.posts.push({
      _id: `keyset-post-${String(i).padStart(3, '0')}`,
      _openid: fixture.auth.binding._openid
    });
  }
  let drifted = false;
  const loaded = loadCloudFunction(
    'cloudfunctions/purgeDeletedAccounts/index.js',
    '',
    fixture.state,
    {
      afterQueryGet({ collection, query, data }) {
        if (collection !== 'posts' || drifted || data.length !== 100 || !query._openid) return;
        drifted = true;
        fixture.state.posts.splice(0, 50);
      }
    }
  );

  const result = await atTime(1000, () => loaded.fn.main(timerEvent()));

  assert.deepStrictEqual(result, { ok: true, checked: 1, purged: 1, failed: 0 });
  assert.strictEqual(drifted, true);
  assert.strictEqual(fixture.state.posts.length, 0);
  assert.strictEqual(loaded.fakeDb.__operations.removes.length, 0);
  assert(loaded.fakeDb.__operations.deletes.some(
    (item) => item.collection === 'posts' && item.id === 'keyset-post-100'
  ));
  const deletedPostIds = loaded.fakeDb.__operations.deletes
    .filter((item) => item.collection === 'posts')
    .map((item) => item.id);
  assert.strictEqual(new Set(deletedPostIds).size, deletedPostIds.length);
  const postQueries = loaded.fakeDb.__operations.queries.filter((item) => item.collection === 'posts');
  assert(postQueries.some((item) => item.query.$and));
}

async function testPurgeRepeatedScanRetainsDeletedParentCascadeScope() {
  const fixture = dueState('repeat-scan-openid', 'RepeatScanA');
  fixture.state.posts.push({
    _id: 'repeat-scan-post',
    _openid: fixture.auth.binding._openid
  });
  let inserted = false;
  const loaded = loadCloudFunction(
    'cloudfunctions/purgeDeletedAccounts/index.js',
    '',
    fixture.state,
    {
      afterQueryGet({ collection, query, data }) {
        if (collection !== 'post_comments' || !query.postId || inserted || data.length) return;
        inserted = true;
        fixture.state.post_comments.push({
          _id: 'repeat-scan-late-comment',
          _openid: 'foreign-openid',
          postId: 'repeat-scan-post'
        });
      }
    }
  );

  const result = await atTime(1000, () => loaded.fn.main(timerEvent()));

  assert.deepStrictEqual(result, { ok: true, checked: 1, purged: 1, failed: 0 });
  assert.strictEqual(inserted, true);
  assert.strictEqual(fixture.state.post_comments.some(
    (item) => item._id === 'repeat-scan-late-comment'
  ), false);
  assert.strictEqual(loaded.fakeDb.__operations.removes.length, 0);
}

async function testPurgeMatchesAllMemberIdentityAliases() {
  const fixture = dueState('member-alias-openid', 'MemberAliasA');
  const openid = fixture.auth.binding._openid;
  fixture.state.members.push(
    { _id: 'member-by-openid', openid },
    { _id: 'member-by-member-openid', memberOpenid: openid },
    { _id: 'member-foreign', openid: 'foreign-openid' }
  );
  const { fn } = loadCloudFunction(
    'cloudfunctions/purgeDeletedAccounts/index.js',
    '',
    fixture.state
  );

  const result = await atTime(1000, () => fn.main(timerEvent()));

  assert.deepStrictEqual(result, { ok: true, checked: 1, purged: 1, failed: 0 });
  assert.strictEqual(fixture.state.members.some((item) => item._id === 'member-by-openid'), false);
  assert.strictEqual(fixture.state.members.some((item) => item._id === 'member-by-member-openid'), false);
  assert.strictEqual(fixture.state.members.some((item) => item._id === 'member-foreign'), true);
}

async function testDataDeleteAccountRejectsCloudBusinessFailure() {
  const dataPath = path.join(root, 'miniprogram/services/data.js');
  const storage = {};
  global.getApp = () => ({ globalData: { cloudReady: true } });
  global.wx = {
    cloud: {
      callFunction() {
        return Promise.resolve({
          result: { ok: false, code: 'ACCOUNT_NOT_BOUND', msg: '账号未绑定' }
        });
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
    }
  };
  delete require.cache[require.resolve(dataPath)];
  const data = require(dataPath);

  await assert.rejects(
    () => data.deleteAccount({ reason: 'privacy' }),
    (error) => error.code === 'ACCOUNT_NOT_BOUND' && error.result.code === 'ACCOUNT_NOT_BOUND'
  );
}

async function testDataDeleteAccountResolvesCloudSuccessUnchanged() {
  const dataPath = path.join(root, 'miniprogram/services/data.js');
  const cloudResult = {
    ok: true,
    deletionStatus: 'pending',
    deletionRequestedAt: 1000,
    deletionScheduledAt: 2000
  };
  global.getApp = () => ({ globalData: { cloudReady: true } });
  global.wx = {
    cloud: {
      callFunction() {
        return Promise.resolve({ result: cloudResult });
      }
    },
    getStorageSync() {},
    setStorageSync() {},
    removeStorageSync() {}
  };
  delete require.cache[require.resolve(dataPath)];
  const data = require(dataPath);

  const result = await data.deleteAccount({ reason: 'privacy' });
  assert.strictEqual(result, cloudResult);
}

async function testDataDeleteAccountRejectsWhenCloudIsUnavailable() {
  const dataPath = path.join(root, 'miniprogram/services/data.js');
  const storage = {};
  global.getApp = () => ({ globalData: { cloudReady: false } });
  global.wx = {
    cloud: {},
    getStorageSync(key) {
      return storage[key];
    },
    setStorageSync(key, value) {
      storage[key] = value;
    },
    removeStorageSync(key) {
      delete storage[key];
    }
  };
  delete require.cache[require.resolve(dataPath)];
  const data = require(dataPath);

  await assert.rejects(
    () => data.deleteAccount({ reason: 'privacy' }),
    (error) => error.code === 'CLOUD_NOT_READY'
  );
  assert.strictEqual(storage.dc_account_deletion_pending, undefined);
}

async function testDataUploadsUseValidatedCurrentUserNamespace() {
  const dataPath = path.join(root, 'miniprogram/services/data.js');
  const uploads = [];
  let profileCalls = 0;
  let resolvedNamespace = bindingId('upload-openid');
  const app = { globalData: { cloudReady: true, openid: 'upload-openid' } };
  global.getApp = () => app;
  global.wx = {
    cloud: {
      uploadFile(options) {
        uploads.push(options);
        return Promise.resolve({ fileID: `cloud://test-env.bucket/${options.cloudPath}` });
      },
      callFunction({ name }) {
        assert.strictEqual(name, 'getUserProfile');
        profileCalls += 1;
        return Promise.resolve({
          result: {
            user: {
              openid: 'resolved-upload-openid',
              storageNamespace: resolvedNamespace,
              roles: ['member']
            }
          }
        });
      }
    },
    getStorageSync() {},
    setStorageSync() {},
    removeStorageSync() {}
  };
  delete require.cache[require.resolve(dataPath)];
  const data = require(dataPath);

  await data.uploadFile('/tmp/post.JPG?size=1', 'community/images');
  await data.uploadImage('/tmp/avatar.png');
  assert(uploads[0].cloudPath.startsWith(`user-content/${bindingId('upload-openid')}/community/images/`));
  assert(uploads[0].cloudPath.endsWith('.jpg'));
  assert(uploads[1].cloudPath.startsWith(`user-content/${bindingId('upload-openid')}/coach/`));
  await assert.rejects(() => data.uploadFile('/tmp/victim.jpg', '../victim'));
  await assert.rejects(() => data.uploadFile('/tmp/victim.jpg', 'safe/%2e%2e/victim'));
  assert.strictEqual(uploads.length, 2);

  app.globalData.storageNamespace = '';
  resolvedNamespace = bindingId('resolved-upload-openid');
  await Promise.all([
    data.uploadFile('/tmp/one.jpg', 'community'),
    data.uploadFile('/tmp/two.jpg', 'community')
  ]);
  assert.strictEqual(profileCalls, 2);
  assert(uploads[2].cloudPath.startsWith(`user-content/${resolvedNamespace}/community/`));
  assert(uploads[3].cloudPath.startsWith(`user-content/${resolvedNamespace}/community/`));
}

function testExistingDeletionUxAndDeploymentDocumentation() {
  const settingsJs = read('miniprogram/pages/settings/index.js');
  const loginJs = read('cloudfunctions/login/index.js');
  const legalJs = read('miniprogram/pages/legal/index.js');
  const readme = read('README.md');
  assert(settingsJs.includes('DELETE_REASONS') && settingsJs.includes('wx.showActionSheet'));
  assert(settingsJs.includes('data.deleteAccount({ reason'));
  assert(loginJs.includes("kind: 'role_selected'"));
  assert(!loginJs.includes('account_deletion_requests'));
  assert(!loginJs.includes('deletionCanceled'));
  assert(legalJs.includes('7 天保留期') && legalJs.includes('撤回注销申请'));
  ['getUserProfile', 'deleteAccount', 'purgeDeletedAccounts'].forEach((name) => {
    assert(readme.includes(name), `README upload checklist must include ${name}`);
  });
  assert(/purgeDeletedAccounts[\s\S]{0,200}(定时|触发器)/.test(readme));
  assert(readme.includes('认证链删除前会先清理该账号的全部 `email_bindings` 与 `email_codes`'));
  AUXILIARY_COLLECTIONS.forEach((name) => {
    assert(readme.includes(`\`${name}\``), `README must require pre-creating ${name}`);
  });
  ['orders', 'subscriptions', 'shop_orders', 'coach_settlements', 'fulfill_failures', 'coach_lessons'].forEach((name) => {
    assert(readme.includes(`\`${name}\``), `README retention matrix must include ${name}`);
  });
  assert(readme.includes('cancelRecurringContract'));
  assert(readme.includes('createRecurringContract') && readme.includes('并发'));
  assert(/- \[ \][^\n]*transaction\.delete/i.test(readme));
  assert(/- \[ \][^\n]*deleteFile/i.test(readme));
  assert(/- \[ \][^\n]*(Timer|定时触发器)/i.test(readme));
}

const tests = [
  testDeleteRejectsUnboundOpenidWithoutWrites,
  testDeleteUsesDeterministicUserAndRequestWithoutExtendingRepeat,
  testDeleteStartsNewWindowForStalePendingRequest,
  testDeleteRejectsPendingUserWithoutConsistentRequest,
  testDeleteRejectsPurgingAccountWithoutWrites,
  testDeleteAllowsTerminalTombstoneForNewAccount,
  testDeleteRejectsConflictingPendingRequestIdentity,
  testDeleteRejectsActiveRecurringSubscriptionWithoutWrites,
  testPurgeRequiresTrustedTimerInvocationWithoutDatabaseReads,
  testPurgeRemovesDeterministicAuthChainAndKeepsLegacyUser,
  testPurgeHelperFailureKeepsAuthChainAndDoesNotBlockNextUser,
  testPurgeAuthenticationDeleteFailureRollsBackTransaction,
  testPurgeClaimWriteFailureRollsBackBeforeCleanup,
  testPurgeLeaseBlocksUnexpiredAndAllowsExpiredTakeover,
  testPurgeFinalTransactionRejectsChangedLease,
  testRoleSelectionDoesNotCancelPendingDeletionGrace,
  testRoleSelectionRereadsLiveRoleInsideTransaction,
  testRoleSelectionRereadsRevokedSessionInsideTransaction,
  testRoleSelectionRereadsAccountVersionInsideTransaction,
  testPurgePreflightRequiresDeterministicRequest,
  testPurgeValidatesCompleteAccountAndFiniteRequestChain,
  testPurgeProcessesAllDuePagesBeforeDeleting,
  testPurgeCountsMalformedPendingSchedulesButSkipsValidFuture,
  testPurgeMissingAuxiliaryCollectionFailsClosed,
  testPurgeEmailCleanupFailureKeepsAuthenticationChain,
  testPurgeBlocksActiveRecurringSubscription,
  testPurgeRechecksSubscriptionBeforeDestructiveCleanup,
  testPurgeRemovesPersonalDataCascadesAndCloudFilesButKeepsFinance,
  testPurgeCloudFileFailureKeepsAuthenticationChain,
  testPurgeDoesNotLetLegacySuccessStatusOverrideFailureCode,
  testPurgePaginatesFileQueriesAndBatchesCloudDeletion,
  testPurgeDeletesOnlyFilesInDeterministicUserNamespace,
  testPurgeTreatsMissingCloudFileAsIdempotentRetrySuccess,
  testPurgeRenewsLeaseBeforeEveryCloudFileBatch,
  testPurgeRenewsLeaseInsideEveryDatabaseDeleteBatch,
  testPurgeStopsCloudBatchesWhenSubscriptionMarkerActivates,
  testPurgeStopsDatabaseBatchesWhenSubscriptionMarkerActivates,
  testPurgeFinalTransactionRejectsExpiredSameLease,
  testPurgeUsesFreshNowForEachCandidate,
  testPurgeUsesKeysetEnumerationAndDeletesOnlyEnumeratedDocuments,
  testPurgeRepeatedScanRetainsDeletedParentCascadeScope,
  testPurgeMatchesAllMemberIdentityAliases,
  testDataDeleteAccountRejectsCloudBusinessFailure,
  testDataDeleteAccountResolvesCloudSuccessUnchanged,
  testDataDeleteAccountRejectsWhenCloudIsUnavailable,
  testDataUploadsUseValidatedCurrentUserNamespace,
  testExistingDeletionUxAndDeploymentDocumentation
];

(async () => {
  const failures = [];
  for (const test of tests) {
    try {
      await test();
    } catch (error) {
      failures.push(`${test.name}: ${error.message}`);
    }
  }
  if (failures.length) {
    throw new Error(`account deletion regressions:\n- ${failures.join('\n- ')}`);
  }
  console.log('accountDeletionGracePeriod tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
