const assert = require('assert');
const crypto = require('crypto');
const path = require('path');

const root = path.resolve(__dirname, '..');

function loadSharedModules(names) {
  const loaded = {};
  const missing = [];
  for (const name of names) {
    const modulePath = path.join(
      root,
      'cloudfunctions',
      '_shared',
      'auth',
      `${name}.js`
    );
    try {
      loaded[name] = require(modulePath);
    } catch (error) {
      if (
        error
        && error.code === 'MODULE_NOT_FOUND'
        && String(error.message).includes(modulePath)
      ) {
        missing.push(name);
        continue;
      }
      throw error;
    }
  }
  if (missing.length > 0) {
    const error = new Error(
      `MODULE_NOT_FOUND: missing shared auth modules: ${missing.join(', ')}`
    );
    error.code = 'MODULE_NOT_FOUND';
    throw error;
  }
  return loaded;
}

const {
  keyring: {
    loadKeyring,
    versionedHmacId,
    candidateHmacIds
  },
  session: {
    prepareSessionToken,
    issueSession,
    requireSession,
    revokeCurrentSession,
    rotateCurrentSession,
    revokeOtherSessions,
    requireRecentAuthentication
  }
} = loadSharedModules(['keyring', 'session']);

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const CREATED_AT = new Date('2026-07-16T12:00:00.000Z');
const ACCOUNT = {
  _id: 'acct_test_account_123456789',
  status: 'active',
  authVersion: 7,
  roles: ['untrusted-account-role']
};
const USER = {
  _id: ACCOUNT._id,
  roles: ['member', 'coach'],
  role: 'member',
  currentRole: 'coach'
};

function clone(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clone(item)])
    );
  }
  return value;
}

function seedCollections(seed) {
  const collections = new Map();
  for (const [name, documents] of Object.entries(seed || {})) {
    collections.set(
      name,
      new Map(
        Object.entries(documents).map(([id, value]) => [id, clone(value)])
      )
    );
  }
  return collections;
}

function createDatabase(seed, behavior) {
  const settings = behavior || {};
  const collections = seedCollections(seed);
  const calls = [];

  function collectionStore(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  }

  function api(scope) {
    return {
      collection(name) {
        return {
          doc(id) {
            const ref = {
              collectionName: name,
              id,
              async get() {
                calls.push({ scope, operation: 'get', name, id });
                const key = `${name}/${id}`;
                if (
                  settings.getErrors
                  && Object.prototype.hasOwnProperty.call(
                    settings.getErrors,
                    key
                  )
                ) {
                  throw settings.getErrors[key];
                }
                if (
                  settings.getResults
                  && Object.prototype.hasOwnProperty.call(
                    settings.getResults,
                    key
                  )
                ) {
                  return clone(settings.getResults[key]);
                }
                const store = collectionStore(name);
                if (!store.has(id)) return { data: null };
                return { data: clone(store.get(id)) };
              },
              async set(payload) {
                calls.push({
                  scope,
                  operation: 'set',
                  name,
                  id,
                  payload: clone(payload)
                });
                const key = `${name}/${id}`;
                if (
                  settings.setErrors
                  && Object.prototype.hasOwnProperty.call(
                    settings.setErrors,
                    key
                  )
                ) {
                  throw settings.setErrors[key];
                }
                assert(payload && payload.data, 'set requires a data object');
                collectionStore(name).set(id, {
                  _id: id,
                  ...clone(payload.data)
                });
                return { updated: 1 };
              },
              async update(payload) {
                calls.push({
                  scope,
                  operation: 'update',
                  name,
                  id,
                  payload: clone(payload)
                });
                const key = `${name}/${id}`;
                if (
                  settings.updateErrors
                  && Object.prototype.hasOwnProperty.call(
                    settings.updateErrors,
                    key
                  )
                ) {
                  throw settings.updateErrors[key];
                }
                assert(payload && payload.data, 'update requires a data object');
                const store = collectionStore(name);
                if (!store.has(id)) {
                  const error = new Error('document missing');
                  error.code = 'DATABASE_DOCUMENT_NOT_FOUND';
                  throw error;
                }
                store.set(id, {
                  ...store.get(id),
                  ...clone(payload.data)
                });
                return { updated: 1 };
              }
            };
            return ref;
          }
        };
      }
    };
  }

  return {
    db: api('db'),
    transaction: api('transaction'),
    calls,
    get(name, id) {
      const store = collectionStore(name);
      return store.has(id) ? clone(store.get(id)) : undefined;
    },
    ids(name) {
      return [...collectionStore(name).keys()];
    }
  };
}

async function runTransactionalFixture(seed, behavior, callback) {
  const original = createDatabase(seed);
  const attempted = createDatabase(seed, behavior);
  try {
    const result = await callback(attempted.transaction);
    return {
      committed: true,
      result,
      state: attempted,
      attempted
    };
  } catch (error) {
    return {
      committed: false,
      error,
      state: original,
      attempted
    };
  }
}

function keyringFixture() {
  return loadKeyring({
    CUETRACE_AUTH_KEY_ACTIVE_VERSION: 'K2',
    CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS: 'K1',
    CUETRACE_AUTH_KEY_K2: Buffer.alloc(32, 0x31).toString('base64'),
    CUETRACE_AUTH_KEY_K1: Buffer.alloc(32, 0x32).toString('base64')
  });
}

async function withRandomBytes(byte, action) {
  const original = crypto.randomBytes;
  const calls = [];
  crypto.randomBytes = function deterministicRandomBytes(length) {
    calls.push(length);
    return Buffer.alloc(length, byte);
  };
  try {
    return await action(calls);
  } finally {
    crypto.randomBytes = original;
  }
}

async function withThrowingRandomBytes(action) {
  const original = crypto.randomBytes;
  let calls = 0;
  crypto.randomBytes = function forbiddenTransactionRandomBytes() {
    calls += 1;
    throw new Error('transaction random generation is forbidden');
  };
  try {
    const result = await action();
    assert.strictEqual(calls, 0);
    return result;
  } finally {
    crypto.randomBytes = original;
  }
}

function assertFailure(result, code, secrets) {
  assert(result && typeof result === 'object');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, code);
  assert.strictEqual(typeof result.msg, 'string');
  assert(result.msg.length > 0);
  const serialized = JSON.stringify(result);
  for (const secret of secrets || []) {
    assert(
      !serialized.includes(secret),
      `${code} result leaked ${secret}`
    );
  }
}

function validSeed(sessionRecord, account, user) {
  return {
    auth_sessions: {
      [sessionRecord._id]: clone(sessionRecord)
    },
    accounts: {
      [sessionRecord.accountId]: clone(account || ACCOUNT)
    },
    users: {
      [sessionRecord.accountId]: clone(user || USER)
    }
  };
}

async function issueFixture(byte, options) {
  const settings = options || {};
  const harness = createDatabase();
  const keyring = settings.keyring || keyringFixture();
  const account = settings.account || ACCOUNT;
  const result = await withRandomBytes(byte, async (calls) => {
    const issued = await issueSession({
      transaction: harness.transaction,
      account,
      clientInstanceId: settings.clientInstanceId || 'client-shared',
      method: settings.method || 'password',
      now: settings.now || CREATED_AT,
      keyring
    });
    assert.deepStrictEqual(calls, [32]);
    return issued;
  });
  return { ...result, harness, keyring };
}

function setCall(harness, collectionName) {
  return harness.calls.find(
    (call) => call.operation === 'set' && call.name === collectionName
  );
}

async function testIssueSessionContract() {
  const issued = await issueFixture(0x5a);
  const { sessionToken, sessionRecord, harness, keyring } = issued;
  const tokenParts = sessionToken.split('.');
  assert.deepStrictEqual(tokenParts.slice(0, 2), ['v2', 'K2']);
  assert.strictEqual(tokenParts.length, 3);
  assert.match(tokenParts[2], /^[A-Za-z0-9_-]{43}$/);
  assert.strictEqual(Buffer.from(tokenParts[2], 'base64url').length, 32);

  assert.strictEqual(
    sessionRecord._id,
    versionedHmacId(keyring, 'session-token', sessionToken, 'session')
  );
  assert.match(sessionRecord._id, /^session\.K2\.[A-Za-z0-9_-]{43}$/);
  assert(!sessionRecord._id.includes(sessionToken));
  assert.deepStrictEqual(sessionRecord, {
    _id: sessionRecord._id,
    accountId: ACCOUNT._id,
    keyVersion: 'K2',
    authVersion: 7,
    clientInstanceId: 'client-shared',
    authenticatedAt: CREATED_AT,
    authenticationMethod: 'password',
    createdAt: CREATED_AT,
    lastSeenAt: CREATED_AT,
    idleExpiresAt: new Date(CREATED_AT.getTime() + 30 * DAY_MS),
    absoluteExpiresAt: new Date(CREATED_AT.getTime() + 90 * DAY_MS),
    revokedAt: '',
    revokeReason: ''
  });

  const write = setCall(harness, 'auth_sessions');
  assert(write, 'issueSession must write auth_sessions in the transaction');
  assert.strictEqual(write.scope, 'transaction');
  assert.strictEqual(write.id, sessionRecord._id);
  assert(
    !Object.prototype.hasOwnProperty.call(write.payload.data, '_id'),
    'CloudBase set data must not include the document _id'
  );
  const { _id, ...persistedSessionData } = sessionRecord;
  assert.deepStrictEqual(write.payload, { data: persistedSessionData });
  assert.deepStrictEqual(
    harness.get('auth_sessions', sessionRecord._id),
    sessionRecord
  );
  assert(!JSON.stringify(write).includes(sessionToken));
  assert.strictEqual(
    JSON.stringify({ sessionToken, sessionRecord })
      .split(sessionToken).length - 1,
    1,
    'the raw token must appear only once in the returned value'
  );

  const inactiveHarness = createDatabase();
  await assert.rejects(
    issueSession({
      transaction: inactiveHarness.transaction,
      account: { ...ACCOUNT, status: 'disabled' },
      clientInstanceId: 'client-shared',
      method: 'password',
      now: CREATED_AT,
      keyring
    }),
    (error) => error && error.code === 'AUTH_INTERNAL_ERROR'
  );
  assert.strictEqual(inactiveHarness.calls.length, 0);
}

async function testPreparedSessionTokenOutsideTransaction() {
  const keyring = keyringFixture();
  let requestedBytes = 0;
  const preparedSessionToken = prepareSessionToken(
    keyring,
    (length) => {
      requestedBytes = length;
      return Buffer.alloc(length, 0x73);
    }
  );
  assert.strictEqual(requestedBytes, 32);
  assert.match(
    preparedSessionToken,
    /^v2\.K2\.[A-Za-z0-9_-]{43}$/
  );

  const firstHarness = createDatabase();
  const first = await withThrowingRandomBytes(() => issueSession({
    transaction: firstHarness.transaction,
    account: clone(ACCOUNT),
    clientInstanceId: 'prepared-client',
    method: 'sms',
    now: CREATED_AT,
    keyring,
    preparedSessionToken
  }));
  assert.strictEqual(first.sessionToken, preparedSessionToken);

  const retryHarness = createDatabase();
  const retry = await withThrowingRandomBytes(() => issueSession({
    transaction: retryHarness.transaction,
    account: clone(ACCOUNT),
    clientInstanceId: 'prepared-client',
    method: 'sms',
    now: CREATED_AT,
    keyring,
    preparedSessionToken
  }));
  assert.strictEqual(retry.sessionToken, preparedSessionToken);
  assert.strictEqual(retry.sessionRecord._id, first.sessionRecord._id);
  assert.deepStrictEqual(retry.sessionRecord, first.sessionRecord);

  const invalidPreparedTokens = [
    null,
    `v2.K1.${Buffer.alloc(32, 0x74).toString('base64url')}`,
    `v2.K2.${Buffer.alloc(31, 0x75).toString('base64url')}`,
    `v2.K2.${Buffer.alloc(32, 0x76).toString('base64')} `
  ];
  for (const invalidToken of invalidPreparedTokens) {
    const harness = createDatabase();
    await assert.rejects(
      issueSession({
        transaction: harness.transaction,
        account: clone(ACCOUNT),
        clientInstanceId: 'prepared-client',
        method: 'sms',
        now: CREATED_AT,
        keyring,
        preparedSessionToken: invalidToken
      }),
      (error) => error && error.code === 'AUTH_INTERNAL_ERROR'
    );
    assert.strictEqual(harness.calls.length, 0);
  }
}

async function testRequireSessionSuccessAndLiveRoles(issued) {
  const now = new Date(CREATED_AT.getTime() + HOUR_MS);
  const harness = createDatabase(validSeed(
    issued.sessionRecord,
    { ...ACCOUNT, roles: ['admin'] },
    { ...USER, roles: ['member', 'shop_owner'] }
  ));
  const context = await requireSession({
    db: harness.db,
    event: {
      sessionToken: issued.sessionToken,
      accountId: 'forged-account',
      roles: ['admin'],
      token: 'ignored-token'
    },
    now,
    keyring: issued.keyring
  });

  assert.deepStrictEqual(Object.keys(context).sort(), [
    'account',
    'accountId',
    'roles',
    'session',
    'sessionRef',
    'user'
  ]);
  assert.strictEqual(context.accountId, ACCOUNT._id);
  assert.strictEqual(context.account._id, ACCOUNT._id);
  assert.strictEqual(context.user._id, ACCOUNT._id);
  assert.deepStrictEqual(context.roles, ['member', 'shop_owner']);
  assert.notStrictEqual(context.roles, context.user.roles);
  assert.strictEqual(context.session._id, issued.sessionRecord._id);
  assert.strictEqual(context.sessionRef.collectionName, 'auth_sessions');
  assert.strictEqual(context.sessionRef.id, issued.sessionRecord._id);
  assert(!JSON.stringify(context).includes(issued.sessionToken));

  const reads = harness.calls
    .filter((call) => call.operation === 'get')
    .map((call) => `${call.name}/${call.id}`);
  assert.deepStrictEqual(reads, [
    `auth_sessions/${issued.sessionRecord._id}`,
    `accounts/${ACCOUNT._id}`,
    `users/${ACCOUNT._id}`
  ]);
  assert.strictEqual(
    harness.calls.filter((call) => call.operation === 'update').length,
    0
  );
}

async function testHistoricalSessionVersionReadsDirectly(issued) {
  const historicalToken =
    `v2.K1.${Buffer.alloc(32, 0x41).toString('base64url')}`;
  const historicalId = candidateHmacIds(
    issued.keyring,
    'session-token',
    historicalToken,
    'session'
  ).find((candidate) => candidate.keyVersion === 'K1').id;
  const historicalRecord = {
    ...clone(issued.sessionRecord),
    _id: historicalId,
    keyVersion: 'K1'
  };
  const harness = createDatabase(validSeed(historicalRecord));
  const context = await requireSession({
    db: harness.db,
    event: { sessionToken: historicalToken },
    now: new Date(CREATED_AT.getTime() + HOUR_MS),
    keyring: issued.keyring
  });
  assert.strictEqual(context.accountId, ACCOUNT._id);
  assert.strictEqual(context.session._id, historicalId);
  assert.strictEqual(context.session.keyVersion, 'K1');
  const sessionReads = harness.calls.filter(
    (call) => call.operation === 'get' && call.name === 'auth_sessions'
  );
  assert.deepStrictEqual(
    sessionReads.map((call) => call.id),
    [historicalId],
    'the token version must select exactly one historical-key document ID'
  );
}

async function testMissingMalformedAndInfrastructureFailures(issued) {
  assertFailure(
    await requireSession({
      db: createDatabase().db,
      event: {},
      now: CREATED_AT,
      keyring: issued.keyring
    }),
    'SESSION_REQUIRED'
  );
  for (const malformedToken of [null, 123]) {
    assertFailure(
      await requireSession({
        db: createDatabase().db,
        event: { sessionToken: malformedToken },
        now: CREATED_AT,
        keyring: issued.keyring
      }),
      'SESSION_EXPIRED'
    );
  }
  assertFailure(
    await requireSession({
      db: createDatabase().db,
      event: { sessionToken: '' },
      now: CREATED_AT,
      keyring: issued.keyring
    }),
    'SESSION_REQUIRED'
  );
  assertFailure(
    await requireSession({
      db: createDatabase().db,
      event: { token: issued.sessionToken },
      now: CREATED_AT,
      keyring: issued.keyring
    }),
    'SESSION_REQUIRED',
    [issued.sessionToken]
  );

  for (const token of [
    'v1.K2.abc',
    'v2.bad-version.abc',
    'v2.K2.short',
    `v2.K2.${'a'.repeat(42)}=`,
    `v2.UNKNOWN.${'a'.repeat(43)}`
  ]) {
    assertFailure(
      await requireSession({
        db: createDatabase().db,
        event: { sessionToken: token },
        now: CREATED_AT,
        keyring: issued.keyring
      }),
      'SESSION_EXPIRED',
      [token]
    );
  }

  assertFailure(
    await requireSession({
      db: createDatabase().db,
      event: { sessionToken: issued.sessionToken },
      now: CREATED_AT,
      keyring: issued.keyring
    }),
    'SESSION_EXPIRED',
    [issued.sessionToken]
  );

  const notFoundError = new Error('verified missing document');
  notFoundError.code = 'DATABASE_DOCUMENT_NOT_FOUND';
  assertFailure(
    await requireSession({
      db: createDatabase({}, {
        getErrors: {
          [`auth_sessions/${issued.sessionRecord._id}`]: notFoundError
        }
      }).db,
      event: { sessionToken: issued.sessionToken },
      now: CREATED_AT,
      keyring: issued.keyring
    }),
    'SESSION_EXPIRED',
    [issued.sessionToken]
  );

  const infrastructureError = new Error(
    `network failed while reading ${issued.sessionToken}`
  );
  infrastructureError.code = 'ETIMEDOUT';
  assertFailure(
    await requireSession({
      db: createDatabase({}, {
        getErrors: {
          [`auth_sessions/${issued.sessionRecord._id}`]: infrastructureError
        }
      }).db,
      event: { sessionToken: issued.sessionToken },
      now: CREATED_AT,
      keyring: issued.keyring
    }),
    'AUTH_INTERNAL_ERROR',
    [issued.sessionToken]
  );

  const genericDatabaseFailure = new Error(
    'document.get:fail permission denied'
  );
  genericDatabaseFailure.errCode = -502001;
  genericDatabaseFailure.code = 'DATABASE_REQUEST_FAILED';
  assertFailure(
    await requireSession({
      db: createDatabase({}, {
        getErrors: {
          [`auth_sessions/${issued.sessionRecord._id}`]:
            genericDatabaseFailure
        }
      }).db,
      event: { sessionToken: issued.sessionToken },
      now: CREATED_AT,
      keyring: issued.keyring
    }),
    'AUTH_INTERNAL_ERROR',
    [issued.sessionToken]
  );

  const legacyMissing = new Error(
    `document.get:fail document with _id `
    + `${issued.sessionRecord._id} does not exist`
  );
  legacyMissing.errCode = -502001;
  assertFailure(
    await requireSession({
      db: createDatabase({}, {
        getErrors: {
          [`auth_sessions/${issued.sessionRecord._id}`]: legacyMissing
        }
      }).db,
      event: { sessionToken: issued.sessionToken },
      now: CREATED_AT,
      keyring: issued.keyring
    }),
    'SESSION_EXPIRED',
    [issued.sessionToken]
  );

  const wrongDocumentMissing = new Error(
    'document.get:fail document with _id another-document does not exist'
  );
  wrongDocumentMissing.errCode = -502001;
  assertFailure(
    await requireSession({
      db: createDatabase({}, {
        getErrors: {
          [`auth_sessions/${issued.sessionRecord._id}`]:
            wrongDocumentMissing
        }
      }).db,
      event: { sessionToken: issued.sessionToken },
      now: CREATED_AT,
      keyring: issued.keyring
    }),
    'AUTH_INTERNAL_ERROR',
    [issued.sessionToken]
  );

  assertFailure(
    await requireSession({
      db: createDatabase({}, {
        getResults: {
          [`auth_sessions/${issued.sessionRecord._id}`]: {}
        }
      }).db,
      event: { sessionToken: issued.sessionToken },
      now: CREATED_AT,
      keyring: issued.keyring
    }),
    'AUTH_INTERNAL_ERROR',
    [issued.sessionToken]
  );

  assertFailure(
    await requireSession({
      db: createDatabase({}, {
        getResults: {
          [`auth_sessions/${issued.sessionRecord._id}`]: {
            data: undefined
          }
        }
      }).db,
      event: { sessionToken: issued.sessionToken },
      now: CREATED_AT,
      keyring: issued.keyring
    }),
    'AUTH_INTERNAL_ERROR',
    [issued.sessionToken]
  );
}

async function testIntegrityAndExpiryFailures(issued) {
  const now = new Date(CREATED_AT.getTime() + HOUR_MS);
  const sessionCases = [
    ['revoked', {
      revokedAt: new Date(CREATED_AT.getTime() + 1)
    }],
    ['idle boundary', {
      idleExpiresAt: now
    }],
    ['absolute boundary', {
      absoluteExpiresAt: now
    }],
    ['document id mismatch', {
      _id: `session.K2.${'b'.repeat(43)}`
    }],
    ['key version mismatch', {
      keyVersion: 'K1'
    }],
    ['missing account id', {
      accountId: ''
    }],
    ['malformed auth version', {
      authVersion: 0
    }],
    ['malformed last seen', {
      lastSeenAt: 'not-a-date'
    }],
    ['future authentication', {
      authenticatedAt: new Date(now.getTime() + 1)
    }]
  ];
  for (const [label, overrides] of sessionCases) {
    const record = { ...clone(issued.sessionRecord), ...overrides };
    const seed = validSeed(record);
    seed.auth_sessions = {
      [issued.sessionRecord._id]: record
    };
    assertFailure(
      await requireSession({
        db: createDatabase(seed).db,
        event: { sessionToken: issued.sessionToken },
        now,
        keyring: issued.keyring
      }),
      'SESSION_EXPIRED',
      [issued.sessionToken, label]
    );
  }

  const accountCases = [
    ['account reference mismatch', {
      account: { ...ACCOUNT, _id: 'acct_other' },
      user: USER
    }],
    ['auth version mismatch', {
      account: { ...ACCOUNT, authVersion: ACCOUNT.authVersion + 1 },
      user: USER
    }],
    ['malformed auth version', {
      account: { ...ACCOUNT, authVersion: '7' },
      user: USER
    }],
    ['user reference mismatch', {
      account: ACCOUNT,
      user: { ...USER, _id: 'acct_other' }
    }],
    ['empty roles', {
      account: ACCOUNT,
      user: { ...USER, roles: [] }
    }],
    ['malformed roles', {
      account: ACCOUNT,
      user: { ...USER, roles: ['member', ''] }
    }]
  ];
  for (const [label, values] of accountCases) {
    assertFailure(
      await requireSession({
        db: createDatabase(validSeed(
          issued.sessionRecord,
          values.account,
          values.user
        )).db,
        event: { sessionToken: issued.sessionToken },
        now,
        keyring: issued.keyring
      }),
      'SESSION_EXPIRED',
      [issued.sessionToken, label]
    );
  }

  const missingUserSeed = validSeed(issued.sessionRecord);
  delete missingUserSeed.users[ACCOUNT._id];
  assertFailure(
    await requireSession({
      db: createDatabase(missingUserSeed).db,
      event: { sessionToken: issued.sessionToken },
      now,
      keyring: issued.keyring
    }),
    'SESSION_EXPIRED',
    [issued.sessionToken]
  );

  const missingAccountSeed = validSeed(issued.sessionRecord);
  delete missingAccountSeed.accounts[ACCOUNT._id];
  assertFailure(
    await requireSession({
      db: createDatabase(missingAccountSeed).db,
      event: { sessionToken: issued.sessionToken },
      now,
      keyring: issued.keyring
    }),
    'SESSION_EXPIRED',
    [issued.sessionToken]
  );

  assertFailure(
    await requireSession({
      db: createDatabase(validSeed(
        issued.sessionRecord,
        { ...ACCOUNT, status: 'disabled' },
        USER
      )).db,
      event: { sessionToken: issued.sessionToken },
      now,
      keyring: issued.keyring
    }),
    'ACCOUNT_DISABLED',
    [issued.sessionToken]
  );
}

async function testExpiryBoundariesAndActivityThrottle(issued) {
  const idleBoundary = issued.sessionRecord.idleExpiresAt.getTime();
  const absoluteBoundary = issued.sessionRecord.absoluteExpiresAt.getTime();

  const beforeIdle = await requireSession({
    db: createDatabase(validSeed(issued.sessionRecord)).db,
    event: { sessionToken: issued.sessionToken },
    now: new Date(idleBoundary - 1),
    keyring: issued.keyring
  });
  assert.strictEqual(beforeIdle.accountId, ACCOUNT._id);

  assertFailure(
    await requireSession({
      db: createDatabase(validSeed(issued.sessionRecord)).db,
      event: { sessionToken: issued.sessionToken },
      now: new Date(idleBoundary),
      keyring: issued.keyring
    }),
    'SESSION_EXPIRED'
  );

  const absoluteOnlyRecord = {
    ...clone(issued.sessionRecord),
    lastSeenAt: new Date(absoluteBoundary - HOUR_MS),
    idleExpiresAt: new Date(absoluteBoundary - HOUR_MS + 30 * DAY_MS)
  };
  assertFailure(
    await requireSession({
      db: createDatabase(validSeed(absoluteOnlyRecord)).db,
      event: { sessionToken: issued.sessionToken },
      now: new Date(absoluteBoundary),
      keyring: issued.keyring
    }),
    'SESSION_EXPIRED'
  );

  const beforeThrottle = createDatabase(validSeed(issued.sessionRecord));
  await requireSession({
    db: beforeThrottle.db,
    event: { sessionToken: issued.sessionToken },
    now: new Date(CREATED_AT.getTime() + 6 * HOUR_MS - 1),
    keyring: issued.keyring
  });
  assert.strictEqual(
    beforeThrottle.calls.filter((call) => call.operation === 'update').length,
    0
  );

  const atThrottle = createDatabase(validSeed(issued.sessionRecord));
  const refreshAt = new Date(CREATED_AT.getTime() + 6 * HOUR_MS);
  const refreshed = await requireSession({
    db: atThrottle.db,
    event: { sessionToken: issued.sessionToken },
    now: refreshAt,
    keyring: issued.keyring
  });
  const updates = atThrottle.calls.filter(
    (call) => call.operation === 'update'
  );
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(updates[0].name, 'auth_sessions');
  assert.strictEqual(updates[0].id, issued.sessionRecord._id);
  assert.deepStrictEqual(Object.keys(updates[0].payload.data).sort(), [
    'idleExpiresAt',
    'lastSeenAt'
  ]);
  assert.deepStrictEqual(updates[0].payload.data, {
    lastSeenAt: refreshAt,
    idleExpiresAt: new Date(refreshAt.getTime() + 30 * DAY_MS)
  });
  assert.deepStrictEqual(refreshed.session.lastSeenAt, refreshAt);
  assert.deepStrictEqual(
    refreshed.session.idleExpiresAt,
    new Date(refreshAt.getTime() + 30 * DAY_MS)
  );
  assert.deepStrictEqual(
    refreshed.session.authenticatedAt,
    issued.sessionRecord.authenticatedAt
  );
  assert.deepStrictEqual(
    refreshed.session.createdAt,
    issued.sessionRecord.createdAt
  );
  assert.deepStrictEqual(
    refreshed.session.absoluteExpiresAt,
    issued.sessionRecord.absoluteExpiresAt
  );
}

async function testCurrentLogoutUsesDocumentId(issued, otherIssued) {
  const seed = validSeed(issued.sessionRecord);
  seed.auth_sessions[otherIssued.sessionRecord._id] =
    clone(otherIssued.sessionRecord);
  const harness = createDatabase(seed);
  const revokeAt = new Date(CREATED_AT.getTime() + 2 * HOUR_MS);
  const result = await revokeCurrentSession({
    transaction: harness.transaction,
    session: {
      ...clone(issued.sessionRecord),
      clientInstanceId: 'forged-client-instance'
    },
    now: revokeAt,
    reason: issued.sessionToken
  });
  assert.deepStrictEqual(result, { kind: 'session_revoked' });

  const revoked = harness.get('auth_sessions', issued.sessionRecord._id);
  const other = harness.get('auth_sessions', otherIssued.sessionRecord._id);
  assert.deepStrictEqual(revoked.revokedAt, revokeAt);
  assert.strictEqual(typeof revoked.revokeReason, 'string');
  assert(revoked.revokeReason.length > 0 && revoked.revokeReason.length <= 64);
  assert(!revoked.revokeReason.includes(issued.sessionToken));
  assert.strictEqual(other.revokedAt, '');
  assert.strictEqual(other.revokeReason, '');

  const updates = harness.calls.filter(
    (call) => call.operation === 'update'
  );
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(updates[0].id, issued.sessionRecord._id);
}

async function testCurrentRotationPreservesLogicalDates(issued, otherIssued) {
  const seed = validSeed(issued.sessionRecord);
  seed.auth_sessions[otherIssued.sessionRecord._id] =
    clone(otherIssued.sessionRecord);

  const staleAccountHarness = createDatabase(seed);
  await assert.rejects(
    rotateCurrentSession({
      transaction: staleAccountHarness.transaction,
      account: { ...ACCOUNT, authVersion: 8 },
      session: clone(issued.sessionRecord),
      now: new Date(CREATED_AT.getTime() + 3 * HOUR_MS),
      keyring: issued.keyring,
      reason: 'password_changed'
    }),
    (error) => error && error.code === 'SESSION_EXPIRED'
  );
  assert.strictEqual(
    staleAccountHarness.calls.filter(
      (call) => call.operation === 'update' || call.operation === 'set'
    ).length,
    0,
    'rotate must not write when live account authVersion is stale'
  );

  const harness = createDatabase(seed);
  const rotateAt = new Date(CREATED_AT.getTime() + 3 * HOUR_MS);
  await harness.transaction
    .collection('accounts')
    .doc(ACCOUNT._id)
    .update({ data: { authVersion: 8 } });
  const preparedSessionToken = prepareSessionToken(
    issued.keyring,
    (length) => Buffer.alloc(length, 0x6b)
  );
  const result = await withThrowingRandomBytes(() => (
    rotateCurrentSession({
      transaction: harness.transaction,
      account: { ...ACCOUNT, authVersion: 8 },
      session: {
        ...clone(issued.sessionRecord),
        clientInstanceId: 'forged-client-instance'
      },
      now: rotateAt,
      keyring: issued.keyring,
      reason: 'password_changed',
      preparedSessionToken
    })
  ));
  assert.deepStrictEqual(Object.keys(result).sort(), ['kind', 'sessionToken']);
  assert.strictEqual(result.kind, 'session_rotated');
  assert.match(result.sessionToken, /^v2\.K2\.[A-Za-z0-9_-]{43}$/);

  const oldRecord = harness.get('auth_sessions', issued.sessionRecord._id);
  const otherRecord = harness.get(
    'auth_sessions',
    otherIssued.sessionRecord._id
  );
  assert.deepStrictEqual(oldRecord.revokedAt, rotateAt);
  assert.strictEqual(oldRecord.revokeReason, 'password_changed');
  assert.strictEqual(otherRecord.revokedAt, '');

  const newIds = harness.ids('auth_sessions').filter(
    (id) => (
      id !== issued.sessionRecord._id
      && id !== otherIssued.sessionRecord._id
    )
  );
  assert.strictEqual(newIds.length, 1);
  const newRecord = harness.get('auth_sessions', newIds[0]);
  assert.strictEqual(newRecord.accountId, ACCOUNT._id);
  assert.strictEqual(newRecord.authVersion, 8);
  assert.strictEqual(newRecord.keyVersion, 'K2');
  assert.strictEqual(
    newRecord.clientInstanceId,
    issued.sessionRecord.clientInstanceId,
    'rotation must use the authenticated document, not forged client metadata'
  );
  assert.strictEqual(
    newRecord.authenticationMethod,
    issued.sessionRecord.authenticationMethod
  );
  assert.deepStrictEqual(
    newRecord.createdAt,
    issued.sessionRecord.createdAt
  );
  assert.deepStrictEqual(
    newRecord.authenticatedAt,
    issued.sessionRecord.authenticatedAt
  );
  assert.deepStrictEqual(
    newRecord.absoluteExpiresAt,
    issued.sessionRecord.absoluteExpiresAt
  );
  assert.deepStrictEqual(newRecord.lastSeenAt, rotateAt);
  assert.deepStrictEqual(
    newRecord.idleExpiresAt,
    new Date(rotateAt.getTime() + 30 * DAY_MS)
  );
  assert(!JSON.stringify(harness.calls).includes(result.sessionToken));

  const rotatedContext = await requireSession({
    db: harness.db,
    event: { sessionToken: result.sessionToken },
    now: rotateAt,
    keyring: issued.keyring
  });
  assert.strictEqual(rotatedContext.accountId, ACCOUNT._id);
  assert.strictEqual(rotatedContext.session.authVersion, 8);
  assertFailure(
    await requireSession({
      db: harness.db,
      event: { sessionToken: otherIssued.sessionToken },
      now: rotateAt,
      keyring: issued.keyring
    }),
    'SESSION_EXPIRED',
    [otherIssued.sessionToken]
  );

  const inactiveHarness = createDatabase(seed);
  await assert.rejects(
    rotateCurrentSession({
      transaction: inactiveHarness.transaction,
      account: { ...ACCOUNT, status: 'disabled' },
      session: clone(issued.sessionRecord),
      now: rotateAt,
      keyring: issued.keyring,
      reason: 'password_changed'
    }),
    (error) => error && error.code === 'ACCOUNT_DISABLED'
  );
  assert.strictEqual(
    inactiveHarness.calls.filter(
      (call) => call.operation === 'update' || call.operation === 'set'
    ).length,
    0
  );
}

async function testOtherSessionRevocationUsesAuthVersion(
  issued,
  otherIssued
) {
  const seed = validSeed(issued.sessionRecord);
  seed.auth_sessions[otherIssued.sessionRecord._id] =
    clone(otherIssued.sessionRecord);
  const harness = createDatabase(seed);
  const rotateAt = new Date(CREATED_AT.getTime() + 4 * HOUR_MS);
  const preparedSessionToken = prepareSessionToken(
    issued.keyring,
    (length) => Buffer.alloc(length, 0x7c)
  );
  const result = await withThrowingRandomBytes(() => (
    revokeOtherSessions({
      transaction: harness.transaction,
      account: { ...ACCOUNT, authVersion: 999 },
      currentSession: {
        ...clone(issued.sessionRecord),
        clientInstanceId: 'forged-client-instance'
      },
      now: rotateAt,
      keyring: issued.keyring,
      preparedSessionToken
    })
  ));
  assert.strictEqual(result.kind, 'session_rotated');

  const liveAccount = harness.get('accounts', ACCOUNT._id);
  assert.strictEqual(
    liveAccount.authVersion,
    8,
    'the transaction must increment the live account version'
  );
  const accountUpdates = harness.calls.filter(
    (call) => (
      call.operation === 'update'
      && call.name === 'accounts'
      && call.id === ACCOUNT._id
    )
  );
  assert.strictEqual(accountUpdates.length, 1);
  assert.strictEqual(accountUpdates[0].payload.data.authVersion, 8);

  const currentOld = harness.get(
    'auth_sessions',
    issued.sessionRecord._id
  );
  const otherOld = harness.get(
    'auth_sessions',
    otherIssued.sessionRecord._id
  );
  assert(currentOld.revokedAt instanceof Date);
  assert.strictEqual(otherOld.revokedAt, '');
  assert.strictEqual(otherOld.authVersion, 7);

  const newIds = harness.ids('auth_sessions').filter(
    (id) => (
      id !== issued.sessionRecord._id
      && id !== otherIssued.sessionRecord._id
    )
  );
  assert.strictEqual(newIds.length, 1);
  const newRecord = harness.get('auth_sessions', newIds[0]);
  assert.strictEqual(newRecord.authVersion, 8);
  assert.strictEqual(
    newRecord.clientInstanceId,
    issued.sessionRecord.clientInstanceId
  );

  assertFailure(
    await requireSession({
      db: harness.db,
      event: { sessionToken: otherIssued.sessionToken },
      now: rotateAt,
      keyring: issued.keyring
    }),
    'SESSION_EXPIRED',
    [otherIssued.sessionToken]
  );
  const currentContext = await requireSession({
    db: harness.db,
    event: { sessionToken: result.sessionToken },
    now: rotateAt,
    keyring: issued.keyring
  });
  assert.strictEqual(currentContext.accountId, ACCOUNT._id);
  assert.strictEqual(currentContext.session.authVersion, 8);
}

async function testMutationFailuresRejectForTransactionRollback(
  issued,
  otherIssued
) {
  const rotateAt = new Date(CREATED_AT.getTime() + 5 * HOUR_MS);
  const rotateSeed = validSeed(issued.sessionRecord);
  rotateSeed.auth_sessions[otherIssued.sessionRecord._id] =
    clone(otherIssued.sessionRecord);
  const rotateSetError = new Error(
    `database set failed ${issued.sessionToken}`
  );
  rotateSetError.code = 'DATABASE_REQUEST_FAILED';
  const expectedNewToken =
    `v2.K2.${Buffer.alloc(32, 0x6d).toString('base64url')}`;
  const expectedNewId = versionedHmacId(
    issued.keyring,
    'session-token',
    expectedNewToken,
    'session'
  );
  const rotateHarness = createDatabase(rotateSeed, {
    setErrors: {
      [`auth_sessions/${expectedNewId}`]: rotateSetError
    }
  });
  await assert.rejects(
    withRandomBytes(0x6d, () => rotateCurrentSession({
      transaction: rotateHarness.transaction,
      account: clone(ACCOUNT),
      session: clone(issued.sessionRecord),
      now: rotateAt,
      keyring: issued.keyring,
      reason: 'password_changed'
    })),
    (error) => {
      assert.strictEqual(error && error.code, 'AUTH_INTERNAL_ERROR');
      assert(!String(error.message).includes(issued.sessionToken));
      assert(!String(error.message).includes(expectedNewToken));
      return true;
    }
  );
  assert.deepStrictEqual(
    rotateHarness.calls
      .filter(
        (call) => call.operation === 'update' || call.operation === 'set'
      )
      .map((call) => `${call.operation}:${call.name}/${call.id}`),
    [
      `update:auth_sessions/${issued.sessionRecord._id}`,
      `set:auth_sessions/${expectedNewId}`
    ],
    'a post-revoke set failure must reject so the transaction callback aborts'
  );

  const revokeUpdateError = new Error('database update failed');
  revokeUpdateError.code = 'DATABASE_REQUEST_FAILED';
  const revokeHarness = createDatabase(rotateSeed, {
    updateErrors: {
      [`auth_sessions/${issued.sessionRecord._id}`]: revokeUpdateError
    }
  });
  await assert.rejects(
    revokeCurrentSession({
      transaction: revokeHarness.transaction,
      session: clone(issued.sessionRecord),
      now: rotateAt,
      reason: 'logout_current'
    }),
    (error) => error && error.code === 'AUTH_INTERNAL_ERROR'
  );

  const revokeOtherSetError = new Error('new current session set failed');
  revokeOtherSetError.code = 'DATABASE_REQUEST_FAILED';
  const expectedOtherToken =
    `v2.K2.${Buffer.alloc(32, 0x6e).toString('base64url')}`;
  const expectedOtherId = versionedHmacId(
    issued.keyring,
    'session-token',
    expectedOtherToken,
    'session'
  );
  const revokeOtherHarness = createDatabase(rotateSeed, {
    setErrors: {
      [`auth_sessions/${expectedOtherId}`]: revokeOtherSetError
    }
  });
  await assert.rejects(
    withRandomBytes(0x6e, () => revokeOtherSessions({
      transaction: revokeOtherHarness.transaction,
      account: clone(ACCOUNT),
      currentSession: clone(issued.sessionRecord),
      now: rotateAt,
      keyring: issued.keyring
    })),
    (error) => error && error.code === 'AUTH_INTERNAL_ERROR'
  );
  assert.deepStrictEqual(
    revokeOtherHarness.calls
      .filter(
        (call) => call.operation === 'update' || call.operation === 'set'
      )
      .map((call) => `${call.operation}:${call.name}/${call.id}`),
    [
      `update:accounts/${ACCOUNT._id}`,
      `update:auth_sessions/${issued.sessionRecord._id}`,
      `set:auth_sessions/${expectedOtherId}`
    ],
    'authVersion/revoke writes followed by set failure must reject'
  );
}

async function testMutationValidationFailuresAbortPriorStagedWrites(
  issued
) {
  const now = new Date(CREATED_AT.getTime() + 5 * HOUR_MS);
  const cases = [
    {
      label: 'missing current session',
      seed: {
        accounts: { [ACCOUNT._id]: clone(ACCOUNT) },
        users: { [ACCOUNT._id]: clone(USER) }
      },
      behavior: {},
      expectedCode: 'SESSION_EXPIRED',
      invoke: (transaction) => revokeCurrentSession({
        transaction,
        session: clone(issued.sessionRecord),
        now,
        reason: 'logout_current'
      })
    },
    {
      label: 'integrity mismatch',
      seed: validSeed({
        ...clone(issued.sessionRecord),
        authVersion: issued.sessionRecord.authVersion + 1
      }),
      behavior: {},
      expectedCode: 'SESSION_EXPIRED',
      invoke: (transaction) => rotateCurrentSession({
        transaction,
        account: clone(ACCOUNT),
        session: clone(issued.sessionRecord),
        now,
        keyring: issued.keyring,
        reason: 'password_changed'
      })
    },
    {
      label: 'account read failure',
      seed: validSeed(issued.sessionRecord),
      behavior: {
        getErrors: {
          [`accounts/${ACCOUNT._id}`]: Object.assign(
            new Error('permission denied'),
            { code: 'DATABASE_REQUEST_FAILED', errCode: -502001 }
          )
        }
      },
      expectedCode: 'AUTH_INTERNAL_ERROR',
      invoke: (transaction) => revokeOtherSessions({
        transaction,
        account: clone(ACCOUNT),
        currentSession: clone(issued.sessionRecord),
        now,
        keyring: issued.keyring
      })
    }
  ];

  for (const testCase of cases) {
    const transactionResult = await runTransactionalFixture(
      testCase.seed,
      testCase.behavior,
      async (transaction) => {
        await transaction
          .collection('staged_changes')
          .doc(testCase.label)
          .set({ data: { value: 'must-rollback' } });
        return testCase.invoke(transaction);
      }
    );
    assert.strictEqual(
      transactionResult.committed,
      false,
      `${testCase.label} must reject the transaction callback`
    );
    assert.strictEqual(
      transactionResult.error && transactionResult.error.code,
      testCase.expectedCode
    );
    assert.strictEqual(
      transactionResult.state.get('staged_changes', testCase.label),
      undefined,
      `${testCase.label} must leave zero committed staged writes`
    );
    assert.deepStrictEqual(
      transactionResult.attempted.get(
        'staged_changes',
        testCase.label
      ),
      {
        _id: testCase.label,
        value: 'must-rollback'
      }
    );
  }
}

function testRecentAuthenticationBoundary() {
  const now = new Date('2026-07-16T15:00:00.000Z');
  assert.strictEqual(
    requireRecentAuthentication({
      authenticatedAt: new Date(now.getTime() - 10 * MINUTE_MS)
    }, now),
    true
  );
  assertFailure(
    requireRecentAuthentication({
      authenticatedAt: new Date(now.getTime() - 10 * MINUTE_MS - 1)
    }, now),
    'RECENT_AUTH_REQUIRED'
  );
  assertFailure(
    requireRecentAuthentication({
      authenticatedAt: new Date(now.getTime() + 1)
    }, now),
    'RECENT_AUTH_REQUIRED'
  );
  assertFailure(
    requireRecentAuthentication({ authenticatedAt: 'invalid' }, now),
    'RECENT_AUTH_REQUIRED'
  );
  assertFailure(
    requireRecentAuthentication({}, now),
    'RECENT_AUTH_REQUIRED'
  );
}

async function main() {
  await testIssueSessionContract();
  await testPreparedSessionTokenOutsideTransaction();
  const issued = await issueFixture(0x5a);
  const otherIssued = await issueFixture(0x5b, {
    clientInstanceId: issued.sessionRecord.clientInstanceId
  });
  await testRequireSessionSuccessAndLiveRoles(issued);
  await testHistoricalSessionVersionReadsDirectly(issued);
  await testMissingMalformedAndInfrastructureFailures(issued);
  await testIntegrityAndExpiryFailures(issued);
  await testExpiryBoundariesAndActivityThrottle(issued);
  await testCurrentLogoutUsesDocumentId(issued, otherIssued);
  await testCurrentRotationPreservesLogicalDates(issued, otherIssued);
  await testOtherSessionRevocationUsesAuthVersion(issued, otherIssued);
  await testMutationFailuresRejectForTransactionRollback(
    issued,
    otherIssued
  );
  await testMutationValidationFailuresAbortPriorStagedWrites(issued);
  testRecentAuthenticationBoundary();
  console.log('AUTH_SESSIONS_OK');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
