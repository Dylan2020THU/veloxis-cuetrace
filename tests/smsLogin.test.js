'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const root = path.resolve(__dirname, '..');
const smsPath = path.join(
  root,
  'cloudfunctions',
  '_shared',
  'auth',
  'sms.js'
);
const sendPath = path.join(
  root,
  'cloudfunctions',
  'sendSmsCode',
  'index.js'
);
const verifySmsPath = path.join(
  root,
  'cloudfunctions',
  'verifySmsCode',
  'index.js'
);
const purgeAuthArtifactsPath = path.join(
  root,
  'cloudfunctions',
  'purgeAuthArtifacts',
  'index.js'
);
const {
  loadKeyring,
  candidateHmacIds
} = require(path.join(
  root,
  'cloudfunctions',
  '_shared',
  'auth',
  'keyring.js'
));
const {
  normalizePhone,
  wechatIdentity
} = require(path.join(
  root,
  'cloudfunctions',
  '_shared',
  'auth',
  'identifiers.js'
));
const {
  prepareSessionToken,
  issueSession
} = require(path.join(
  root,
  'cloudfunctions',
  '_shared',
  'auth',
  'session.js'
));
const {
  claimSmsChallenge,
  finalizeSmsSend,
  consumeSmsChallenge,
  challengeDocumentId,
  scopeHashForVersion,
  SMS_CODE_TTL_MS,
  SMS_RESEND_MS,
  SMS_WINDOW_MS
} = require(smsPath);

const RAW_PHONE = '13800138000';
const E164_PHONE = '+8613800138000';
const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_MS = Date.UTC(2026, 6, 16, 12, 0, 0);
const DATA_SERVICE_SHA256 =
  'aad0677eb4082faddab25d1c7ee5bac23f07f66e40f18e7a461f50f461b0e241';
const LOGIN_PAGE_SHA256 =
  'ba9b0712fd78e90fe931c07af4fa64789669193caba7c1d4192e81ced5971377';

function file(relativePath) {
  return path.join(root, relativePath);
}

function read(relativePath) {
  return fs.readFileSync(file(relativePath), 'utf8');
}

function fileSha256(relativePath) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(file(relativePath)))
    .digest('hex');
}

function clone(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = clone(item);
    }
    return result;
  }
  return value;
}

function seedCollections(seed) {
  const result = new Map();
  for (const [name, documents] of Object.entries(seed || {})) {
    const store = new Map();
    if (Array.isArray(documents)) {
      for (const document of documents) {
        assert(
          document && typeof document._id === 'string',
          'seed arrays require document _id values'
        );
        store.set(document._id, clone(document));
      }
    } else {
      for (const [id, document] of Object.entries(documents || {})) {
        store.set(id, { _id: id, ...clone(document) });
      }
    }
    result.set(name, store);
  }
  return result;
}

function cloneCollections(collections) {
  const result = new Map();
  for (const [name, store] of collections.entries()) {
    const next = new Map();
    for (const [id, document] of store.entries()) {
      next.set(id, clone(document));
    }
    result.set(name, next);
  }
  return result;
}

function exactMissingError(id) {
  return new Error(
    'document.get:fail document with _id '
      + id
      + ' does not exist'
  );
}

function createDatabase(seed, behavior) {
  const settings = behavior || {};
  let collections = seedCollections(seed);
  let queue = Promise.resolve();
  let commitVersion = 0;
  let armedBarrier = null;
  const calls = [];
  const transactionStats = {
    attempts: 0,
    commits: 0,
    conflicts: 0,
    retries: 0,
    firstAttemptBarrierWaits: 0
  };

  function storeFor(target, name) {
    if (!target.has(name)) target.set(name, new Map());
    return target.get(name);
  }

  function api(scope, currentCollections) {
    return {
      collection(name) {
        return {
          doc(id) {
            return {
              async get() {
                const target = currentCollections();
                const store = storeFor(target, name);
                const exists = store.has(id);
                const call = {
                  scope,
                  operation: 'get',
                  collection: name,
                  id,
                  exists
                };
                calls.push(call);
                if (typeof settings.getBehavior === 'function') {
                  const decision = settings.getBehavior({
                    ...call,
                    exactMissingMessage:
                      'document.get:fail document with _id '
                      + id
                      + ' does not exist'
                  });
                  if (decision && decision.throw) throw decision.throw;
                  if (
                    decision
                    && Object.prototype.hasOwnProperty.call(
                      decision,
                      'return'
                    )
                  ) {
                    return clone(decision.return);
                  }
                }
                if (!exists) {
                  call.missingWasThrown = true;
                  throw exactMissingError(id);
                }
                return { data: clone(store.get(id)) };
              },
              async set(payload) {
                const call = {
                  scope,
                  operation: 'set',
                  collection: name,
                  id,
                  payload: clone(payload)
                };
                calls.push(call);
                assert(
                  payload
                    && payload.data
                    && typeof payload.data === 'object',
                  'set requires data'
                );
                assert(
                  !Object.prototype.hasOwnProperty.call(
                    payload.data,
                    '_id'
                  ),
                  'set({data}) must exclude _id'
                );
                if (typeof settings.setBehavior === 'function') {
                  const decision = settings.setBehavior(call);
                  if (decision && decision.throw) throw decision.throw;
                }
                storeFor(currentCollections(), name).set(id, {
                  _id: id,
                  ...clone(payload.data)
                });
                if (scope === 'db') commitVersion += 1;
                return { _id: id };
              },
              async update(payload) {
                const call = {
                  scope,
                  operation: 'update',
                  collection: name,
                  id,
                  payload: clone(payload)
                };
                calls.push(call);
                assert(
                  payload
                    && payload.data
                    && typeof payload.data === 'object',
                  'update requires data'
                );
                if (typeof settings.updateBehavior === 'function') {
                  const decision = settings.updateBehavior(call);
                  if (decision && decision.throw) throw decision.throw;
                }
                const store = storeFor(currentCollections(), name);
                if (!store.has(id)) throw exactMissingError(id);
                store.set(id, {
                  ...store.get(id),
                  ...clone(payload.data)
                });
                if (scope === 'db') commitVersion += 1;
                return { stats: { updated: 1 } };
              }
            };
          }
        };
      }
    };
  }

  const db = api('db', () => collections);
  async function runSerialTransaction(callback) {
    transactionStats.attempts += 1;
    const working = cloneCollections(collections);
    const transaction = api('transaction', () => working);
    const result = await callback(transaction);
    if (typeof settings.beforeCommit === 'function') {
      await settings.beforeCommit({ working, result });
    }
    collections = working;
    commitVersion += 1;
    transactionStats.commits += 1;
    return result;
  }

  function reserveFirstAttemptBarrier() {
    if (!armedBarrier) return null;
    const barrier = armedBarrier;
    barrier.claimed += 1;
    if (barrier.claimed === barrier.participants) {
      armedBarrier = null;
    }
    return barrier;
  }

  async function runOptimisticTransaction(
    callback,
    firstAttemptBarrier
  ) {
    const maximumAttempts = Number.isSafeInteger(
      settings.maximumTransactionAttempts
    )
      ? settings.maximumTransactionAttempts
      : 20;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      transactionStats.attempts += 1;
      const snapshotVersion = commitVersion;
      const working = cloneCollections(collections);
      const transaction = api('transaction', () => working);
      let result;
      let attemptError;
      try {
        result = await callback(transaction);
        if (typeof settings.beforeCommit === 'function') {
          await settings.beforeCommit({ working, result });
        }
      } catch (error) {
        attemptError = error;
      }
      if (attempt === 1 && firstAttemptBarrier) {
        await firstAttemptBarrier.wait();
      }
      if (attemptError) throw attemptError;
      if (commitVersion !== snapshotVersion) {
        transactionStats.conflicts += 1;
        if (attempt === maximumAttempts) {
          throw new Error('optimistic transaction retry limit exceeded');
        }
        transactionStats.retries += 1;
        continue;
      }
      collections = working;
      commitVersion += 1;
      transactionStats.commits += 1;
      return result;
    }
    throw new Error('optimistic transaction retry limit exceeded');
  }

  db.runTransaction = function runTransaction(callback) {
    if (settings.optimisticTransactions) {
      return runOptimisticTransaction(
        callback,
        reserveFirstAttemptBarrier()
      );
    }
    const execute = async () => {
      return runSerialTransaction(callback);
    };
    const pending = queue.then(execute, execute);
    queue = pending.then(
      () => undefined,
      () => undefined
    );
    return pending;
  };

  return {
    db,
    calls,
    transactionStats,
    armFirstAttemptBarrier(participants) {
      assert(
        settings.optimisticTransactions,
        'first-attempt barriers require optimistic transactions'
      );
      assert(
        Number.isSafeInteger(participants) && participants >= 2,
        'barrier participants must be an integer >= 2'
      );
      assert.strictEqual(
        armedBarrier,
        null,
        'a first-attempt barrier is already armed'
      );
      let arrivals = 0;
      let release;
      const released = new Promise((resolve) => {
        release = resolve;
      });
      armedBarrier = {
        participants,
        claimed: 0,
        async wait() {
          transactionStats.firstAttemptBarrierWaits += 1;
          arrivals += 1;
          if (arrivals === participants) release();
          await released;
        }
      };
    },
    get(name, id) {
      const store = storeFor(collections, name);
      return store.has(id) ? clone(store.get(id)) : undefined;
    },
    all(name) {
      return [...storeFor(collections, name).values()].map(clone);
    },
    snapshot() {
      const result = {};
      for (const [name, store] of collections.entries()) {
        result[name] = [...store.values()].map(clone);
      }
      return result;
    },
    resetCalls() {
      calls.length = 0;
    }
  };
}

function optimisticStats(database) {
  assert(
    database.transactionStats,
    'optimistic transaction stats must be exposed'
  );
  return { ...database.transactionStats };
}

function assertOptimisticRetries(
  database,
  before,
  barrierParticipants,
  label
) {
  const after = optimisticStats(database);
  assert(
    after.conflicts > before.conflicts,
    label + ' must detect a snapshot-version conflict'
  );
  assert(
    after.retries > before.retries,
    label + ' must automatically retry a conflict'
  );
  assert.strictEqual(
    after.firstAttemptBarrierWaits
      - before.firstAttemptBarrierWaits,
    barrierParticipants,
    label + ' must synchronize every first attempt'
  );
}

const ROOT_KEYS = Object.freeze({
  K1: Buffer.alloc(32, 0x11).toString('base64'),
  K2: Buffer.alloc(32, 0x22).toString('base64')
});

function keyringFixture(activeVersion, historicalVersions) {
  const historical = historicalVersions || [];
  return loadKeyring({
    CUETRACE_AUTH_KEY_ACTIVE_VERSION: activeVersion || 'K2',
    CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS: historical.join(','),
    CUETRACE_AUTH_KEY_K1: ROOT_KEYS.K1,
    CUETRACE_AUTH_KEY_K2: ROOT_KEYS.K2
  });
}

function wxFixture(suffix) {
  const label = suffix || 'default';
  return wechatIdentity({
    APPID: 'wx-app-' + label,
    OPENID: 'openid-' + label
  });
}

function trustedWxContext(suffix) {
  const label = suffix || 'default';
  return {
    APPID: 'wx-app-' + label,
    OPENID: 'openid-' + label
  };
}

function scopeFixture(
  purpose,
  wxIdentityValue,
  clientInstanceId,
  accountId,
  sessionId
) {
  return Object.freeze({
    purpose,
    clientInstanceId: clientInstanceId || 'client-default',
    wechatBindingInput: wxIdentityValue.bindingInput,
    accountId: accountId || '',
    sessionId: purpose === 'reauth' ? (sessionId || '') : ''
  });
}

function phoneFor(index) {
  return '+8613800138' + String(index).padStart(3, '0');
}

function activePhoneBindingId(keyring, phone) {
  return candidateHmacIds(
    keyring,
    'phone-binding',
    phone,
    'phone'
  )[0].id;
}

async function withRandomBytes(byte, action) {
  const original = crypto.randomBytes;
  let calls = 0;
  crypto.randomBytes = function deterministicRandomBytes(length) {
    calls += 1;
    return Buffer.alloc(length, (byte + calls - 1) & 0xff);
  };
  try {
    return await action(() => calls);
  } finally {
    crypto.randomBytes = original;
  }
}

async function withNow(nowMs, action) {
  const original = Date.now;
  Date.now = () => nowMs;
  try {
    return await action();
  } finally {
    Date.now = original;
  }
}

function createFakeTimers() {
  let nowMs = 0;
  let nextId = 1;
  const pending = new Map();
  const scheduled = [];
  const cleared = [];

  function setTimeoutFake(handler, timeoutMs) {
    assert.strictEqual(typeof handler, 'function');
    assert(Number.isFinite(timeoutMs) && timeoutMs >= 0);
    const id = nextId;
    nextId += 1;
    pending.set(id, {
      id,
      dueAt: nowMs + timeoutMs,
      handler
    });
    scheduled.push({ id, timeoutMs });
    return id;
  }

  function clearTimeoutFake(id) {
    cleared.push(id);
    pending.delete(id);
  }

  function advanceBy(elapsedMs) {
    assert(Number.isFinite(elapsedMs) && elapsedMs >= 0);
    const targetMs = nowMs + elapsedMs;
    while (true) {
      const due = Array.from(pending.values())
        .filter((timer) => timer.dueAt <= targetMs)
        .sort((left, right) => (
          left.dueAt - right.dueAt || left.id - right.id
        ))[0];
      if (!due) break;
      nowMs = due.dueAt;
      pending.delete(due.id);
      due.handler();
    }
    nowMs = targetMs;
  }

  return {
    scheduled,
    cleared,
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimeoutFake,
    advanceBy,
    activeCount() {
      return pending.size;
    }
  };
}

async function withFakeTimers(action) {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timers = createFakeTimers();
  global.setTimeout = timers.setTimeout;
  global.clearTimeout = timers.clearTimeout;
  try {
    return await action(timers);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
}

async function flushUntil(predicate, message) {
  for (let turn = 0; turn < 5; turn += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert(predicate(), message);
}

const ENV_KEYS = [
  'CUETRACE_AUTH_KEY_ACTIVE_VERSION',
  'CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS',
  'CUETRACE_AUTH_KEY_K1',
  'CUETRACE_AUTH_KEY_K2',
  'CUETRACE_SMS_SECRET_ID',
  'CUETRACE_SMS_SECRET_KEY',
  'CUETRACE_SMS_SDK_APP_ID',
  'CUETRACE_SMS_SIGN_NAME',
  'CUETRACE_SMS_TEMPLATE_ID',
  'CUETRACE_SMS_REGION',
  'CUETRACE_SMS_TEMPLATE_PARAMS',
  'SMS_CODE_HASH_SECRET'
];

const BASE_ENV = Object.freeze({
  CUETRACE_AUTH_KEY_ACTIVE_VERSION: 'K2',
  CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS: 'K1',
  CUETRACE_AUTH_KEY_K1: ROOT_KEYS.K1,
  CUETRACE_AUTH_KEY_K2: ROOT_KEYS.K2,
  CUETRACE_SMS_SECRET_ID: 'provider-secret-id',
  CUETRACE_SMS_SECRET_KEY: 'provider-secret-key',
  CUETRACE_SMS_SDK_APP_ID: 'provider-sdk-app-id',
  CUETRACE_SMS_SIGN_NAME: 'provider-sign-name',
  CUETRACE_SMS_TEMPLATE_ID: 'provider-template-id',
  CUETRACE_SMS_REGION: 'ap-guangzhou',
  CUETRACE_SMS_TEMPLATE_PARAMS: 'code,expire',
  SMS_CODE_HASH_SECRET: 'forbidden-legacy-code-secret'
});

async function withEnvironment(overrides, action) {
  const previous = {};
  const values = { ...BASE_ENV, ...(overrides || {}) };
  for (const key of ENV_KEYS) {
    previous[key] = process.env[key];
    if (
      !Object.prototype.hasOwnProperty.call(values, key)
      || values[key] === undefined
    ) {
      delete process.env[key];
    } else {
      process.env[key] = values[key];
    }
  }
  try {
    return await action();
  } finally {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function createFakeHttps(behavior) {
  const requests = [];
  return {
    requests,
    request(options, onResponse) {
      const record = {
        options: clone(options),
        body: '',
        timeoutMs: 0,
        destroyed: false
      };
      const requestHandlers = {};
      requests.push(record);
      const request = {
        on(event, handler) {
          requestHandlers[event] = handler;
          return request;
        },
        setTimeout(timeoutMs, handler) {
          record.timeoutMs = timeoutMs;
          record.timeoutHandler = handler;
          return request;
        },
        write(chunk) {
          record.body += String(chunk);
        },
        destroy(error) {
          record.destroyed = true;
          if (requestHandlers.error) {
            requestHandlers.error(
              error || new Error('request destroyed')
            );
          }
        },
        end() {
          setImmediate(() => {
            const outcome = typeof behavior === 'function'
              ? behavior(requests.length - 1, record)
              : (behavior || { type: 'success' });
            if (outcome.type === 'timeout') {
              if (record.timeoutHandler) record.timeoutHandler();
              return;
            }
            if (outcome.type === 'error') {
              if (requestHandlers.error) {
                requestHandlers.error(
                  new Error(
                    outcome.message || 'provider transport failure'
                  )
                );
              }
              return;
            }
            const responseHandlers = {};
            const response = {
              statusCode: outcome.statusCode || 200,
              on(event, handler) {
                responseHandlers[event] = handler;
                return response;
              }
            };
            record.emitResponse = (event, value) => {
              if (responseHandlers[event]) {
                responseHandlers[event](value);
              }
            };
            onResponse(response);
            const interruptedEvent = {
              'response-aborted': 'aborted',
              'response-error': 'error',
              'response-close': 'close'
            }[outcome.type];
            if (interruptedEvent) {
              record.responseEventEmitted = interruptedEvent;
              record.emitResponse('data', '{"Response":');
              record.emitResponse(
                interruptedEvent,
                interruptedEvent === 'error'
                  ? new Error('provider response interrupted')
                  : undefined
              );
              return;
            }
            if (outcome.type === 'slow-drip') {
              record.emitResponse(
                'data',
                outcome.chunk || '{"Response":'
              );
              return;
            }
            const payload = outcome.payload || {
              Response: {
                RequestId: 'provider-request-id',
                SendStatusSet: [{
                  Code: 'Ok',
                  Message: 'provider accepted'
                }]
              }
            };
            if (responseHandlers.data) {
              responseHandlers.data(JSON.stringify(payload));
            }
            if (responseHandlers.end) responseHandlers.end();
          });
        }
      };
      return request;
    }
  };
}

function mergeEntrySeed(seed, control) {
  const result = clone(seed || {});
  if (!result.auth_control) result.auth_control = {};
  if (control !== null) {
    result.auth_control.main = {
      _id: 'main',
      maintenance: false,
      schemaVersion: 2,
      minClientProtocol: 2,
      ...(control || {})
    };
  }
  return result;
}

function createEntryHarness(options) {
  const settings = options || {};
  const database = createDatabase(
    mergeEntrySeed(settings.seed, settings.control),
    settings.dbBehavior
  );
  const fakeHttps = createFakeHttps(settings.httpsBehavior);
  const randomIntValues = (settings.randomIntValues || []).slice();
  const randomBytesValues =
    (settings.randomBytesValues || []).slice();
  const randomIntCalls = [];
  const randomBytesCalls = [];
  const counters = {
    init: 0,
    database: 0,
    getWXContext: 0
  };
  const fakeCrypto = new Proxy(crypto, {
    get(target, property) {
      if (property === 'randomInt') {
        return function fakeRandomInt(min, max) {
          randomIntCalls.push({ min, max });
          return randomIntValues.length
            ? randomIntValues.shift()
            : 123456;
        };
      }
      if (property === 'randomBytes') {
        return function fakeRandomBytes(length) {
          randomBytesCalls.push(length);
          if (randomBytesValues.length) {
            const next = randomBytesValues.shift();
            const bytes = Buffer.isBuffer(next)
              ? Buffer.from(next)
              : Buffer.alloc(length, next);
            assert.strictEqual(
              bytes.length,
              length,
              'random byte fixture length'
            );
            return bytes;
          }
          return Buffer.alloc(
            length,
            0x40 + randomBytesCalls.length
          );
        };
      }
      return target[property];
    }
  });
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {
      counters.init += 1;
    },
    database() {
      counters.database += 1;
      return database.db;
    },
    getWXContext() {
      counters.getWXContext += 1;
      return clone(
        settings.wxContext || trustedWxContext('entry')
      );
    }
  };

  const sendDirectory = path.dirname(sendPath);
  for (const cachePath of Object.keys(require.cache)) {
    if (cachePath.startsWith(sendDirectory)) {
      delete require.cache[cachePath];
    }
  }
  const originalLoad = Module._load;
  Module._load = function patchedLoad(
    request,
    parent,
    isMain
  ) {
    if (request === 'wx-server-sdk') return fakeCloud;
    if (request === 'https') return fakeHttps;
    if (request === 'crypto') return fakeCrypto;
    return originalLoad.call(this, request, parent, isMain);
  };
  let entry;
  try {
    entry = require(sendPath);
  } finally {
    Module._load = originalLoad;
  }

  return {
    entry,
    database,
    httpsRequests: fakeHttps.requests,
    randomIntCalls,
    randomBytesCalls,
    counters
  };
}

function loadCloudEntry(entryPath, fakeCloud) {
  const entryDirectory = path.dirname(entryPath);
  for (const cachePath of Object.keys(require.cache)) {
    if (cachePath.startsWith(entryDirectory)) {
      delete require.cache[cachePath];
    }
  }
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'wx-server-sdk') return fakeCloud;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(entryPath);
  } finally {
    Module._load = originalLoad;
  }
}

function createRetiredVerifyHarness(controlOverrides) {
  const calls = [];
  const control = {
    _id: 'main',
    maintenance: false,
    schemaVersion: 2,
    minClientProtocol: 2,
    ...(controlOverrides || {})
  };
  let getWXContextCalls = 0;
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database() {
      return {
        collection(name) {
          if (name !== 'auth_control') {
            throw new Error(`retired verifySmsCode read ${name}`);
          }
          return {
            doc(id) {
              return {
                async get() {
                  calls.push({ operation: 'get', collection: name, id });
                  assert.strictEqual(id, 'main');
                  return { data: clone(control) };
                }
              };
            }
          };
        }
      };
    },
    getWXContext() {
      getWXContextCalls += 1;
      throw new Error('retired verifySmsCode must not read WXContext');
    }
  };
  return {
    entry: loadCloudEntry(verifySmsPath, fakeCloud),
    calls,
    getWXContextCalls: () => getWXContextCalls
  };
}

function createPurgeDatabase(seed, behavior) {
  const settings = behavior || {};
  const collections = seedCollections(seed);
  const calls = [];
  const allowedCollections = new Set([
    'sms_codes',
    'auth_proofs',
    'auth_sessions'
  ]);

  function storeFor(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  }

  const command = {
    lte(value) {
      assert(value instanceof Date, 'cleanup boundary must be a Date');
      return { operator: 'lte', value: new Date(value.getTime()) };
    }
  };
  const db = {
    command,
    collection(name) {
      calls.push({ operation: 'collection', collection: name });
      if (!allowedCollections.has(name)) {
        throw new Error(`purgeAuthArtifacts accessed forbidden collection ${name}`);
      }
      return {
        where(query) {
          const fields = Object.keys(query || {});
          assert.strictEqual(fields.length, 1, 'cleanup query must have one expiry criterion');
          const field = fields[0];
          const condition = query[field];
          assert.strictEqual(condition && condition.operator, 'lte');
          return {
            limit(value) {
              assert(
                Number.isSafeInteger(value) && value > 0 && value <= 100,
                'cleanup query limit must be at most 100'
              );
              return {
                async get() {
                  const call = {
                    operation: 'query',
                    collection: name,
                    field,
                    limit: value
                  };
                  calls.push(call);
                  if (
                    settings.failQuery
                    && settings.failQuery.collection === name
                    && settings.failQuery.field === field
                  ) {
                    throw new Error('private cleanup query failure');
                  }
                  const boundary = condition.value.getTime();
                  const data = [...storeFor(name).values()]
                    .filter((document) => (
                      document[field] instanceof Date
                      && document[field].getTime() <= boundary
                    ))
                    .slice(0, value)
                    .map(clone);
                  return { data };
                }
              };
            }
          };
        },
        doc(id) {
          return {
            async remove() {
              const call = {
                operation: 'remove',
                collection: name,
                id
              };
              calls.push(call);
              if (
                settings.failRemove
                && settings.failRemove.collection === name
                && settings.failRemove.id === id
              ) {
                throw new Error('private cleanup delete failure');
              }
              const removed = storeFor(name).delete(id) ? 1 : 0;
              return { stats: { removed } };
            }
          };
        }
      };
    }
  };

  return {
    db,
    calls,
    all(name) {
      return [...storeFor(name).values()].map(clone);
    }
  };
}

function createPurgeHarness(seed, behavior) {
  const database = createPurgeDatabase(seed, behavior);
  let getWXContextCalls = 0;
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database() {
      return database.db;
    },
    getWXContext() {
      getWXContextCalls += 1;
      throw new Error('timer cleanup must not read WXContext');
    }
  };
  return {
    entry: loadCloudEntry(purgeAuthArtifactsPath, fakeCloud),
    database,
    getWXContextCalls: () => getWXContextCalls
  };
}

async function claimDirect(database, options) {
  return database.db.runTransaction((transaction) => (
    claimSmsChallenge({
      transaction,
      phone: options.phone || E164_PHONE,
      purpose: options.purpose || 'login',
      scope: options.scope,
      wxIdentity: options.wxIdentity,
      now: new Date(options.nowMs),
      keyring: options.keyring
    })
  ));
}

async function finalizeDirect(database, options) {
  return database.db.runTransaction((transaction) => (
    finalizeSmsSend({
      transaction,
      claim: options.claim,
      providerResult: options.providerResult,
      now: new Date(options.nowMs),
      keyring: options.keyring
    })
  ));
}

async function consumeDirect(database, options) {
  return database.db.runTransaction((transaction) => (
    consumeSmsChallenge({
      transaction,
      challengeId: options.challengeId,
      code: options.code,
      expectedPurpose: options.expectedPurpose,
      expectedScope: options.expectedScope,
      now: new Date(options.nowMs),
      keyring: options.keyring
    })
  ));
}

async function sentChallenge(database, options) {
  const claim = await claimDirect(database, options);
  const finalized = await finalizeDirect(database, {
    claim,
    providerResult: {
      status: 'sent',
      code: options.code || '123456'
    },
    nowMs: options.finalizeAtMs === undefined
      ? options.nowMs
      : options.finalizeAtMs,
    keyring: options.keyring
  });
  assert.strictEqual(finalized.ok, true);
  return claim;
}

function baseAccount(accountId, phoneBindingId) {
  return {
    _id: accountId,
    status: 'active',
    authVersion: 1,
    phoneBindingId: phoneBindingId || ''
  };
}

function baseUser(accountId) {
  return {
    _id: accountId,
    roles: ['member'],
    currentRole: 'member',
    role: 'member'
  };
}

async function issueHarnessSession(
  harness,
  keyring,
  accountId,
  nowMs,
  clientInstanceId
) {
  const account = harness.database.get('accounts', accountId);
  assert(account, 'session fixture account must exist');
  const preparedSessionToken = prepareSessionToken(
    keyring,
    () => Buffer.alloc(32, 0x77)
  );
  const issued = await harness.database.db.runTransaction(
    (transaction) => issueSession({
      transaction,
      account,
      clientInstanceId: clientInstanceId || 'session-client',
      method: 'password',
      now: new Date(nowMs),
      keyring,
      preparedSessionToken
    })
  );
  return issued;
}

function sendEvent(overrides) {
  return {
    phone: RAW_PHONE,
    purpose: 'login',
    clientInstanceId: 'client-entry',
    authProtocol: 2,
    ...(overrides || {})
  };
}

function assertFailure(result, code) {
  assert(result && typeof result === 'object');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, code);
  assert.strictEqual(typeof result.msg, 'string');
}

function assertRejectCode(error, code) {
  return Boolean(
    error
    && error.code === code
    && typeof error.message === 'string'
    && !error.message.includes(RAW_PHONE)
    && !error.message.includes(E164_PHONE)
  );
}

async function updatePhoneRate(database, challenge, mutationFor) {
  const rate = database.get(
    'sms_rate_limits',
    challenge.phoneRateId
  );
  assert(rate, 'phone-rate fixture must exist');
  const data = typeof mutationFor === 'function'
    ? mutationFor(rate)
    : mutationFor;
  await database.db
    .collection('sms_rate_limits')
    .doc(challenge.phoneRateId)
    .update({ data });
}

async function testRateDocumentIntegrityBeforeClaim() {
  const cases = [
    {
      name: 'empty phone events',
      kind: 'phone',
      mutate() {
        return { events: [] };
      }
    },
    {
      name: 'phone lastAcceptedAt mismatch',
      kind: 'phone',
      mutate(record) {
        return {
          lastAcceptedAt: new Date(
            record.lastAcceptedAt.getTime() - 1
          )
        };
      }
    },
    {
      name: 'over-limit phone events',
      kind: 'phone',
      eventCount: 11
    },
    {
      name: 'empty WeChat events',
      kind: 'wechat',
      mutate() {
        return { events: [] };
      }
    },
    {
      name: 'WeChat lastAcceptedAt mismatch',
      kind: 'wechat',
      mutate(record) {
        return {
          lastAcceptedAt: new Date(
            record.lastAcceptedAt.getTime() - 1
          )
        };
      }
    },
    {
      name: 'over-limit WeChat events',
      kind: 'wechat',
      eventCount: 31
    }
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const testCase = cases[index];
    const keyring = keyringFixture('K2', ['K1']);
    const wxIdentityValue = wxFixture('rate-integrity-' + index);
    const database = createDatabase();
    const scope = scopeFixture(
      'login',
      wxIdentityValue,
      'rate-integrity-' + index
    );
    await withRandomBytes(0x2a + index, () => (
      claimDirect(database, {
        purpose: 'login',
        scope,
        wxIdentity: wxIdentityValue,
        nowMs: BASE_MS,
        keyring
      })
    ));
    const rate = database
      .all('sms_rate_limits')
      .find((record) => record.kind === testCase.kind);
    assert(rate, testCase.name);
    let mutation;
    if (testCase.eventCount) {
      const events = Array.from(
        { length: testCase.eventCount },
        (_, eventIndex) => ({
          challengeId: 'sms-challenge.K2.'
            + Buffer.alloc(32, eventIndex + 1)
              .toString('base64url'),
          acceptedAt: new Date(
            BASE_MS - testCase.eventCount + eventIndex + 1
          )
        })
      );
      mutation = {
        events,
        lastAcceptedAt: new Date(BASE_MS)
      };
    } else {
      mutation = testCase.mutate(rate);
    }
    await database.db
      .collection('sms_rate_limits')
      .doc(rate._id)
      .update({ data: mutation });
    const before = database.snapshot();

    await assert.rejects(
      () => claimDirect(database, {
        purpose: 'login',
        scope,
        wxIdentity: wxIdentityValue,
        nowMs: BASE_MS + SMS_RESEND_MS,
        keyring
      }),
      (error) => assertRejectCode(error, 'AUTH_INTERNAL_ERROR'),
      testCase.name + ' must abort claim'
    );
    assert.deepStrictEqual(
      database.snapshot(),
      before,
      testCase.name + ' must not commit any mutation'
    );
  }
}

async function testPreviousChallengeIntegrityBeforeSupersession() {
  const cases = [
    {
      name: 'already superseded',
      mutation: {
        status: 'superseded',
        providerMarker: 'superseded'
      }
    },
    {
      name: 'impossible failed attempt and use state',
      mutation: {
        status: 'failed',
        providerMarker: 'failed',
        failedAttempts: 1,
        used: true,
        usedAt: new Date(BASE_MS)
      }
    },
    {
      name: 'future-created challenge',
      mutation: {
        createdAt: new Date(BASE_MS + SMS_RESEND_MS + 1)
      }
    },
    {
      name: 'different valid-format phone mask',
      mutation: { phoneMasked: '139****0000' }
    },
    {
      name: 'previous active event timestamp drift',
      mutation: {},
      rateMutation(rate) {
        const driftedAt = new Date(
          BASE_MS - SMS_WINDOW_MS - 1
        );
        return {
          events: rate.events.map((event) => ({
            ...event,
            acceptedAt: driftedAt
          })),
          lastAcceptedAt: driftedAt
        };
      }
    },
    {
      name: 'malformed challenge',
      mutation: { phoneMasked: 'not-masked' }
    },
    {
      name: 'non-candidate phone binding',
      mutationFor(keyring) {
        return {
          phoneBindingId: candidateHmacIds(
            keyring,
            'phone-binding',
            phoneFor(901),
            'phone'
          )[0].id
        };
      }
    },
    {
      name: 'non-candidate phone rate',
      mutationFor(keyring) {
        return {
          phoneRateId: candidateHmacIds(
            keyring,
            'rate-limit',
            phoneFor(902),
            'sms-phone-rate'
          )[0].id
        };
      }
    }
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const testCase = cases[index];
    const keyring = keyringFixture('K2', ['K1']);
    const wxIdentityValue = wxFixture('previous-integrity-' + index);
    const database = createDatabase();
    const scope = scopeFixture(
      'login',
      wxIdentityValue,
      'previous-integrity-' + index
    );
    let firstClaim;
    await withRandomBytes(0x3a + index, async () => {
      firstClaim = await claimDirect(database, {
        purpose: 'login',
        scope,
        wxIdentity: wxIdentityValue,
        nowMs: BASE_MS,
        keyring
      });
    });
    const mutation = testCase.mutationFor
      ? testCase.mutationFor(keyring)
      : testCase.mutation;
    await database.db
      .collection('sms_codes')
      .doc(firstClaim.challengeDocumentId)
      .update({ data: mutation });
    if (testCase.rateMutation) {
      await updatePhoneRate(
        database,
        firstClaim,
        testCase.rateMutation
      );
    }
    const before = database.snapshot();

    await assert.rejects(
      () => claimDirect(database, {
        purpose: 'login',
        scope,
        wxIdentity: wxIdentityValue,
        nowMs: BASE_MS + SMS_RESEND_MS,
        keyring
      }),
      (error) => assertRejectCode(error, 'AUTH_INTERNAL_ERROR'),
      testCase.name + ' must abort supersession'
    );
    assert.deepStrictEqual(
      database.snapshot(),
      before,
      testCase.name + ' must remain unchanged'
    );
  }
}

function assertNoSensitiveText(value, sensitiveValues) {
  const serialized = JSON.stringify(value);
  for (const sensitive of sensitiveValues) {
    assert(
      !serialized.includes(sensitive),
      'sensitive value leaked: ' + sensitive
    );
  }
}

async function testScopeVectorAndCanonicalChallenge() {
  const keyring = keyringFixture('K2', ['K1']);
  const wxIdentityValue = wechatIdentity({
    APPID: 'wx-app-vector',
    OPENID: 'openid-vector'
  });
  const scope = scopeFixture(
    'login',
    wxIdentityValue,
    'client-vector'
  );
  assert.strictEqual(
    scopeHashForVersion(
      keyring,
      'K2',
      'login',
      scope
    ),
    'scope.K2.QskuRClLfO-nGWIJQrwH2MgUZRoyqOe54J3Txmun8-I',
    'scope hash construction is a compatibility vector'
  );

  const database = createDatabase();
  await withRandomBytes(0x5a, async (getCalls) => {
    const claim = await claimDirect(database, {
      phone: E164_PHONE,
      purpose: 'login',
      scope,
      wxIdentity: wxIdentityValue,
      nowMs: BASE_MS,
      keyring
    });
    assert.strictEqual(getCalls(), 1);
    assert.match(
      claim.challengeId,
      /^v2\.K2\.[A-Za-z0-9_-]{22}$/
    );
    const randomPart = claim.challengeId.split('.')[2];
    assert.strictEqual(
      Buffer.from(randomPart, 'base64url').length,
      16
    );
    assert.strictEqual(
      Buffer.from(randomPart, 'base64url').toString('base64url'),
      randomPart
    );
    const documentId = challengeDocumentId(
      keyring,
      claim.challengeId
    );
    assert.strictEqual(claim.challengeDocumentId, documentId);
    assert.notStrictEqual(documentId, claim.challengeId);
    const record = database.get('sms_codes', documentId);
    assert(record, 'pending challenge must be persisted');
    assert.strictEqual(record.status, 'pending');
    assert.strictEqual(record.keyVersion, 'K2');
    assert.strictEqual(record.purpose, 'login');
    assert.strictEqual(record.scopeHash, scopeHashForVersion(
      keyring,
      'K2',
      'login',
      scope
    ));
    assert.strictEqual(record.phoneMasked, '138****8000');
    assert.strictEqual(record.codeHash, '');
    assert.strictEqual(record.expiresAt, null);
    assert.strictEqual(record.lastSentAt, null);
    assert.strictEqual(record.failedAttempts, 0);
    assert.strictEqual(record.locked, false);
    assert.strictEqual(record.used, false);
    assert.strictEqual(record.usedAt, null);
    const rateDocuments = database.all('sms_rate_limits');
    assert.strictEqual(
      rateDocuments.length,
      2,
      'missing historical rate documents must not be created'
    );
    assert.deepStrictEqual(
      rateDocuments.map((item) => item.kind).sort(),
      ['phone', 'wechat']
    );
    assert.deepStrictEqual(
      [...new Set(
        rateDocuments.map((item) => item.keyVersion)
      )],
      ['K2']
    );
    assertNoSensitiveText(database.snapshot(), [
      RAW_PHONE,
      E164_PHONE,
      claim.challengeId,
      wxIdentityValue.bindingInput,
      'wx-app-vector',
      'openid-vector'
    ]);
  });
}

async function testFinalizerRejectsCorruptedPendingState() {
  const keyring = keyringFixture('K2', ['K1']);
  const wxIdentityValue = wxFixture('finalizer-corruption');
  const scope = scopeFixture(
    'login',
    wxIdentityValue,
    'finalizer-corruption'
  );
  const corruptions = [
    {
      name: 'rate key version',
      providerResult: {
        status: 'sent',
        code: '123456'
      },
      async apply(database, claim, challenge) {
        await database.db.runTransaction(
          (transaction) => transaction
            .collection('sms_rate_limits')
            .doc(challenge.phoneRateId)
            .update({ data: { keyVersion: 'K1' } })
        );
      }
    },
    {
      name: 'non-initial pending attempt state',
      providerResult: { status: 'failed' },
      async apply(database, claim) {
        await database.db.runTransaction(
          (transaction) => transaction
            .collection('sms_codes')
            .doc(claim.challengeDocumentId)
            .update({ data: { failedAttempts: 1 } })
        );
      }
    },
    {
      name: 'future-created pending state',
      providerResult: {
        status: 'sent',
        code: '123456'
      },
      async apply(database, claim) {
        await database.db.runTransaction(
          (transaction) => transaction
            .collection('sms_codes')
            .doc(claim.challengeDocumentId)
            .update({
              data: {
                createdAt: new Date(BASE_MS + 10000)
              }
            })
        );
      }
    },
    {
      name: 'empty rate events',
      async apply(database, claim, challenge) {
        await updatePhoneRate(database, challenge, {
          events: []
        });
      }
    },
    {
      name: 'active pointer absent from rate events',
      async apply(database, claim, challenge) {
        await updatePhoneRate(database, challenge, (rate) => ({
          events: rate.events.map((event) => ({
            ...event,
            challengeId: 'sms-challenge.K2.'
              + 'D'.repeat(43)
          }))
        }));
      }
    },
    {
      name: 'current active event timestamp drift',
      async apply(database, claim, challenge) {
        await updatePhoneRate(database, challenge, (rate) => ({
          events: rate.events.map((event) => ({
            ...event,
            acceptedAt: new Date(BASE_MS - 1)
          })),
          lastAcceptedAt: new Date(BASE_MS - 1)
        }));
      }
    },
    {
      name: 'stale active event is not newer',
      async apply(database, claim, challenge) {
        const newerChallengeId = 'sms-challenge.K2.'
          + 'F'.repeat(43);
        await updatePhoneRate(database, challenge, (rate) => ({
          events: [
            ...rate.events,
            {
              challengeId: newerChallengeId,
              acceptedAt: new Date(BASE_MS)
            }
          ],
          lastAcceptedAt: new Date(BASE_MS),
          purposes: {
            ...rate.purposes,
            login: {
              generation: claim.generation + 1,
              activeChallengeId: newerChallengeId
            }
          }
        }));
      }
    },
    {
      name: 'malformed unrelated purpose state',
      async apply(database, claim, challenge) {
        await updatePhoneRate(database, challenge, (rate) => ({
          purposes: {
            ...rate.purposes,
            reauth: {
              generation: 1,
              activeChallengeId: null
            }
          }
        }));
      }
    },
    {
      name: 'lower-generation pointer',
      async apply(database, claim, challenge) {
        await updatePhoneRate(database, challenge, (rate) => ({
          purposes: {
            ...rate.purposes,
            login: {
              generation: 0,
              activeChallengeId: null
            }
          }
        }));
      }
    },
    {
      name: 'same-generation different pointer',
      async apply(database, claim, challenge) {
        await updatePhoneRate(database, challenge, (rate) => ({
          purposes: {
            ...rate.purposes,
            login: {
              generation: claim.generation,
              activeChallengeId: 'sms-challenge.K2.'
                + 'B'.repeat(43)
            }
          }
        }));
      }
    },
    {
      name: 'higher-generation same pointer',
      async apply(database, claim, challenge) {
        await updatePhoneRate(database, challenge, (rate) => ({
          purposes: {
            ...rate.purposes,
            login: {
              generation: claim.generation + 1,
              activeChallengeId: claim.challengeDocumentId
            }
          }
        }));
      }
    }
  ];

  for (let index = 0; index < corruptions.length; index += 1) {
    const corruption = corruptions[index];
    const database = createDatabase();
    let claim;
    await withRandomBytes(0x19 + index, async () => {
      claim = await claimDirect(database, {
        phone: phoneFor(400 + index),
        purpose: 'login',
        scope,
        wxIdentity: wxIdentityValue,
        nowMs: BASE_MS,
        keyring
      });
    });
    const challenge = database.get(
      'sms_codes',
      claim.challengeDocumentId
    );
    await corruption.apply(database, claim, challenge);
    const before = database.snapshot();
    await assert.rejects(
      () => finalizeDirect(database, {
        claim,
        providerResult: corruption.providerResult || {
          status: 'sent',
          code: '123456'
        },
        nowMs: BASE_MS + 1,
        keyring
      }),
      (error) => assertRejectCode(
        error,
        'AUTH_INTERNAL_ERROR'
      ),
      corruption.name
    );
    assert.deepStrictEqual(
      database.snapshot(),
      before,
      corruption.name + ' must remain unchanged'
    );
    const unchanged = database.get(
      'sms_codes',
      claim.challengeDocumentId
    );
    assert.strictEqual(unchanged.status, 'pending');
    assert.strictEqual(unchanged.codeHash, '');
    assert.strictEqual(unchanged.expiresAt, null);
  }
}

async function testConsumeRejectsCorruptedRateAndTimeReversal() {
  const corruptions = [
    {
      name: 'empty rate events',
      mutate() {
        return { events: [] };
      }
    },
    {
      name: 'active pointer absent from rate events',
      mutate(rate) {
        return {
          events: rate.events.map((event) => ({
            ...event,
            challengeId: 'sms-challenge.K2.'
              + 'E'.repeat(43)
          }))
        };
      }
    },
    {
      name: 'current active event timestamp drift',
      mutate(rate) {
        return {
          events: rate.events.map((event) => ({
            ...event,
            acceptedAt: new Date(BASE_MS - 1)
          })),
          lastAcceptedAt: new Date(BASE_MS - 1)
        };
      }
    },
    {
      name: 'stale active event is not newer',
      mutate(rate, claim) {
        const newerChallengeId = 'sms-challenge.K2.'
          + 'G'.repeat(43);
        return {
          events: [
            ...rate.events,
            {
              challengeId: newerChallengeId,
              acceptedAt: new Date(BASE_MS)
            }
          ],
          lastAcceptedAt: new Date(BASE_MS),
          purposes: {
            ...rate.purposes,
            login: {
              generation: claim.generation + 1,
              activeChallengeId: newerChallengeId
            }
          }
        };
      }
    },
    {
      name: 'malformed unrelated purpose state',
      mutate(rate) {
        return {
          purposes: {
            ...rate.purposes,
            reauth: {
              generation: 1,
              activeChallengeId: null
            }
          }
        };
      }
    },
    {
      name: 'lower-generation pointer',
      mutate(rate) {
        return {
          purposes: {
            ...rate.purposes,
            login: {
              generation: 0,
              activeChallengeId: null
            }
          }
        };
      }
    },
    {
      name: 'same-generation different pointer',
      mutate(rate, claim) {
        return {
          purposes: {
            ...rate.purposes,
            login: {
              generation: claim.generation,
              activeChallengeId: 'sms-challenge.K2.'
                + 'C'.repeat(43)
            }
          }
        };
      }
    },
    {
      name: 'higher-generation same pointer',
      mutate(rate, claim) {
        return {
          purposes: {
            ...rate.purposes,
            login: {
              generation: claim.generation + 1,
              activeChallengeId: claim.challengeDocumentId
            }
          }
        };
      }
    }
  ];

  for (let index = 0; index < corruptions.length; index += 1) {
    const corruption = corruptions[index];
    const keyring = keyringFixture('K2', ['K1']);
    const wxIdentityValue = wxFixture('consume-rate-' + index);
    const database = createDatabase();
    const scope = scopeFixture(
      'login',
      wxIdentityValue,
      'consume-rate-' + index
    );
    let claim;
    await withRandomBytes(0x52 + index, async () => {
      claim = await sentChallenge(database, {
        phone: phoneFor(500 + index),
        purpose: 'login',
        scope,
        wxIdentity: wxIdentityValue,
        nowMs: BASE_MS,
        code: '123456',
        keyring
      });
    });
    const challenge = database.get(
      'sms_codes',
      claim.challengeDocumentId
    );
    await updatePhoneRate(database, challenge, (rate) => (
      corruption.mutate(rate, claim)
    ));
    const before = database.snapshot();

    const result = await consumeDirect(database, {
      challengeId: claim.challengeId,
      code: '123456',
      expectedPurpose: 'login',
      expectedScope: scope,
      nowMs: BASE_MS + 1,
      keyring
    });
    assertFailure(result, 'SMS_CODE_INVALID');
    assert.deepStrictEqual(
      database.snapshot(),
      before,
      corruption.name + ' must remain unchanged'
    );
  }

  const transportBehavior = {};
  const transportKeyring = keyringFixture('K2', ['K1']);
  const transportIdentity = wxFixture('consume-rate-transport');
  const transportDatabase = createDatabase(
    undefined,
    transportBehavior
  );
  const transportScope = scopeFixture(
    'login',
    transportIdentity,
    'consume-rate-transport'
  );
  let transportClaim;
  await withRandomBytes(0x5e, async () => {
    transportClaim = await sentChallenge(transportDatabase, {
      phone: phoneFor(598),
      purpose: 'login',
      scope: transportScope,
      wxIdentity: transportIdentity,
      nowMs: BASE_MS,
      code: '123456',
      keyring: transportKeyring
    });
  });
  transportBehavior.getBehavior = (call) => (
    call.scope === 'transaction'
    && call.collection === 'sms_rate_limits'
      ? { throw: new Error('rate transport unavailable') }
      : null
  );
  const transportBefore = transportDatabase.snapshot();
  await assert.rejects(
    () => consumeDirect(transportDatabase, {
      challengeId: transportClaim.challengeId,
      code: '123456',
      expectedPurpose: 'login',
      expectedScope: transportScope,
      nowMs: BASE_MS + 1,
      keyring: transportKeyring
    }),
    (error) => assertRejectCode(error, 'AUTH_INTERNAL_ERROR'),
    'rate transport failure must abort consume'
  );
  assert.deepStrictEqual(
    transportDatabase.snapshot(),
    transportBefore,
    'rate transport failure must not write'
  );

  const keyring = keyringFixture('K2', ['K1']);
  const wxIdentityValue = wxFixture('consume-time-reversal');
  const database = createDatabase();
  const scope = scopeFixture(
    'login',
    wxIdentityValue,
    'consume-time-reversal'
  );
  let claim;
  await withRandomBytes(0x5f, async () => {
    claim = await sentChallenge(database, {
      phone: phoneFor(599),
      purpose: 'login',
      scope,
      wxIdentity: wxIdentityValue,
      nowMs: BASE_MS,
      finalizeAtMs: BASE_MS + 100,
      code: '654321',
      keyring
    });
  });
  for (const code of ['000000', '654321']) {
    const result = await consumeDirect(database, {
      challengeId: claim.challengeId,
      code,
      expectedPurpose: 'login',
      expectedScope: scope,
      nowMs: BASE_MS + 50,
      keyring
    });
    assertFailure(result, 'SMS_CODE_INVALID');
    const record = database.get(
      'sms_codes',
      claim.challengeDocumentId
    );
    assert.strictEqual(
      record.failedAttempts,
      0,
      'time reversal must reject before attempt comparison'
    );
    assert.strictEqual(record.used, false);
    assert.strictEqual(record.usedAt, null);
  }
}

async function testProtocolGuardIsFirstEffect() {
  await withEnvironment({
    CUETRACE_AUTH_KEY_ACTIVE_VERSION: undefined,
    CUETRACE_SMS_SECRET_ID: undefined
  }, async () => {
    const harness = createEntryHarness();
    harness.database.resetCalls();
    const v1 = await harness.entry.main(
      sendEvent({ authProtocol: 1 })
    );
    assertFailure(v1, 'CLIENT_UPDATE_REQUIRED');
    assert.deepStrictEqual(
      harness.database.calls.map((call) => (
        call.collection + '/' + call.id
      )),
      ['auth_control/main']
    );
    assert.strictEqual(harness.counters.getWXContext, 0);
    assert.deepStrictEqual(harness.randomBytesCalls, []);
    assert.deepStrictEqual(harness.randomIntCalls, []);
    assert.strictEqual(harness.httpsRequests.length, 0);

    harness.database.resetCalls();
    const missing = await harness.entry.main({
      phone: RAW_PHONE,
      purpose: 'login',
      clientInstanceId: 'client-entry'
    });
    assertFailure(missing, 'CLIENT_UPDATE_REQUIRED');
    assert.deepStrictEqual(
      harness.database.calls.map((call) => (
        call.collection + '/' + call.id
      )),
      ['auth_control/main']
    );
    assert.strictEqual(harness.counters.getWXContext, 0);
    assert.deepStrictEqual(harness.randomBytesCalls, []);
    assert.deepStrictEqual(harness.randomIntCalls, []);
    assert.strictEqual(harness.httpsRequests.length, 0);
  });

  await withEnvironment({}, async () => {
    const maintenance = createEntryHarness({
      control: { maintenance: true }
    });
    maintenance.database.resetCalls();
    const result = await maintenance.entry.main(sendEvent());
    assertFailure(result, 'AUTH_MAINTENANCE');
    assert.deepStrictEqual(
      maintenance.database.calls.map((call) => (
        call.collection + '/' + call.id
      )),
      ['auth_control/main']
    );
    assert.strictEqual(maintenance.counters.getWXContext, 0);
    assert.deepStrictEqual(maintenance.randomBytesCalls, []);
    assert.deepStrictEqual(maintenance.randomIntCalls, []);
    assert.strictEqual(maintenance.httpsRequests.length, 0);
  });
}

async function testVerifySmsCodeIsAProtocolTwoRetiredShim() {
  const source = read('cloudfunctions/verifySmsCode/index.js');
  assert(
    source.includes('supportedSchemaVersions: [2]'),
    'verifySmsCode must accept only auth protocol schema 2'
  );
  const harness = createRetiredVerifyHarness();
  const result = await harness.entry.main({
    authProtocol: 2,
    phone: RAW_PHONE,
    code: '123456',
    accountId: 'forbidden-client-authority'
  });
  assert.deepStrictEqual(result, {
    ok: false,
    code: 'CLIENT_UPDATE_REQUIRED',
    msg: '客户端版本过低，请更新后重试'
  });
  assert.deepStrictEqual(harness.calls, [
    { operation: 'get', collection: 'auth_control', id: 'main' }
  ]);
  assert.strictEqual(harness.getWXContextCalls(), 0);
  for (const forbidden of [
    'sms_codes',
    'accounts',
    'account_names',
    'phone_bindings',
    'wechat_bindings',
    'users',
    'auth_sessions'
  ]) {
    assert(
      !source.includes(`collection('${forbidden}')`),
      `retired verifySmsCode must not access ${forbidden}`
    );
  }
}

async function testPurgeAuthArtifactsBoundaryAndBounds() {
  const invalid = createPurgeHarness({});
  for (const event of [
    {},
    { Type: 'Timer' },
    { TriggerName: 'purgeAuthArtifactsTimer' },
    { Type: 'timer', TriggerName: 'purgeAuthArtifactsTimer' },
    { Type: 'Timer', TriggerName: 'wrongTimer' },
    { Type: 'Timer', TriggerName: 'purgeAuthArtifactsTimer ' }
  ]) {
    const result = await invalid.entry.main(event);
    assert.deepStrictEqual(result, { ok: false, code: 'FORBIDDEN' });
  }
  assert.deepStrictEqual(
    invalid.database.calls,
    [],
    'untrusted timer events must perform zero database reads or writes'
  );
  assert.strictEqual(invalid.getWXContextCalls(), 0);

  const expired = new Date(BASE_MS);
  const future = new Date(BASE_MS + 1);
  const smsCodes = [];
  for (let index = 0; index < 101; index += 1) {
    smsCodes.push({ _id: `sms-expired-${index}`, expiresAt: expired });
  }
  smsCodes.push({ _id: 'sms-live', expiresAt: future });
  const authProofs = [
    { _id: 'proof-expired-a', expiresAt: expired },
    { _id: 'proof-expired-b', expiresAt: expired },
    { _id: 'proof-live', expiresAt: future }
  ];
  const authSessions = [{
    _id: 'session-both-expired',
    idleExpiresAt: expired,
    absoluteExpiresAt: expired
  }];
  for (let index = 0; index < 100; index += 1) {
    authSessions.push({
      _id: `session-idle-${index}`,
      idleExpiresAt: expired,
      absoluteExpiresAt: future
    });
  }
  for (let index = 0; index < 100; index += 1) {
    authSessions.push({
      _id: `session-absolute-${index}`,
      idleExpiresAt: future,
      absoluteExpiresAt: expired
    });
  }
  authSessions.push({
    _id: 'session-live',
    idleExpiresAt: future,
    absoluteExpiresAt: future
  });

  const harness = createPurgeHarness({
    sms_codes: smsCodes,
    auth_proofs: authProofs,
    auth_sessions: authSessions,
    accounts: [{ _id: 'account-must-survive', status: 'active' }],
    users: [{ _id: 'user-must-survive', roles: ['member'] }],
    phone_bindings: [{ _id: 'phone-must-survive' }]
  });
  const result = await withNow(BASE_MS, () => harness.entry.main({
    Type: 'Timer',
    TriggerName: 'purgeAuthArtifactsTimer',
    Time: '2026-07-16T12:00:00.000Z',
    Message: 'platform metadata is allowed'
  }));
  assert.deepStrictEqual(result, {
    ok: true,
    smsCodesDeleted: 100,
    authProofsDeleted: 2,
    authSessionsDeleted: 100
  });
  assert.strictEqual(harness.getWXContextCalls(), 0);
  assert.deepStrictEqual(
    harness.database.calls
      .filter((call) => call.operation === 'query')
      .map(({ collection, field, limit }) => ({ collection, field, limit })),
    [
      { collection: 'sms_codes', field: 'expiresAt', limit: 100 },
      { collection: 'auth_proofs', field: 'expiresAt', limit: 100 },
      { collection: 'auth_sessions', field: 'idleExpiresAt', limit: 100 }
    ]
  );
  assert.deepStrictEqual(
    [...new Set(harness.database.calls.map((call) => call.collection))],
    ['sms_codes', 'auth_proofs', 'auth_sessions']
  );
  assert.strictEqual(
    harness.database.calls.filter((call) => (
      call.operation === 'remove'
      && call.collection === 'auth_sessions'
      && call.id === 'session-both-expired'
    )).length,
    1,
    'a session matching both expiry criteria must be deleted once'
  );
  assert.strictEqual(harness.database.all('sms_codes').length, 2);
  assert.strictEqual(harness.database.all('auth_proofs').length, 1);
  assert.strictEqual(harness.database.all('auth_sessions').length, 102);
  assert.strictEqual(harness.database.all('accounts').length, 1);
  assert.strictEqual(harness.database.all('users').length, 1);
  assert.strictEqual(harness.database.all('phone_bindings').length, 1);
}

async function testPurgeAuthArtifactsFailuresAndDeploymentConfig() {
  const queryFailure = createPurgeHarness(
    { sms_codes: [{ _id: 'sms-expired', expiresAt: new Date(BASE_MS) }] },
    { failQuery: { collection: 'sms_codes', field: 'expiresAt' } }
  );
  const queryResult = await withNow(BASE_MS, () => queryFailure.entry.main({
    Type: 'Timer',
    TriggerName: 'purgeAuthArtifactsTimer'
  }));
  assert.deepStrictEqual(queryResult, {
    ok: false,
    code: 'AUTH_INTERNAL_ERROR'
  });
  assert.strictEqual(
    queryFailure.database.calls.some((call) => call.operation === 'remove'),
    false
  );
  assert(!JSON.stringify(queryResult).includes('private cleanup query failure'));

  const deleteFailure = createPurgeHarness(
    { sms_codes: [{ _id: 'sms-expired', expiresAt: new Date(BASE_MS) }] },
    { failRemove: { collection: 'sms_codes', id: 'sms-expired' } }
  );
  const deleteResult = await withNow(BASE_MS, () => deleteFailure.entry.main({
    Type: 'Timer',
    TriggerName: 'purgeAuthArtifactsTimer'
  }));
  assert.deepStrictEqual(deleteResult, {
    ok: false,
    code: 'AUTH_INTERNAL_ERROR'
  });
  assert(!JSON.stringify(deleteResult).includes('private cleanup delete failure'));

  assert.deepStrictEqual(
    JSON.parse(read('cloudfunctions/purgeAuthArtifacts/config.json')),
    {
      triggers: [{
        name: 'purgeAuthArtifactsTimer',
        type: 'timer',
        config: '0 0 * * * * *'
      }]
    }
  );
  const packageJson = JSON.parse(
    read('cloudfunctions/purgeAuthArtifacts/package.json')
  );
  assert.strictEqual(packageJson.name, 'purgeAuthArtifacts');
  assert.strictEqual(packageJson.main, 'index.js');
  assert.strictEqual(packageJson.dependencies['wx-server-sdk'], '~2.6.3');
  assert.strictEqual(
    fs.existsSync(file('cloudfunctions/purgeAuthArtifacts/package-lock.json')),
    false,
    'purgeAuthArtifacts must not add a package lock'
  );
  const source = read('cloudfunctions/purgeAuthArtifacts/index.js');
  assert(!/authProtocol|guardClientRequest|protocol-guard/.test(source));
}

async function testFirstMissingDocumentsCreateAndSendLeadingZero() {
  await withEnvironment({}, async () => {
    const harness = createEntryHarness({
      randomBytesValues: [Buffer.alloc(16, 0x31)],
      randomIntValues: [42]
    });
    const result = await withNow(
      BASE_MS,
      () => harness.entry.main(sendEvent())
    );
    assert.deepStrictEqual(Object.keys(result).sort(), [
      'challengeId',
      'expiresIn',
      'ok',
      'resendAfter'
    ]);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.expiresIn, 300);
    assert.strictEqual(result.resendAfter, 60);
    assert.match(
      result.challengeId,
      /^v2\.K2\.[A-Za-z0-9_-]{22}$/
    );
    assert.deepStrictEqual(harness.randomBytesCalls, [16]);
    assert.deepStrictEqual(
      harness.randomIntCalls,
      [{ min: 0, max: 1000000 }]
    );
    assert.strictEqual(harness.httpsRequests.length, 1);
    const request = harness.httpsRequests[0];
    assert(
      request.timeoutMs >= 1000 && request.timeoutMs <= 10000,
      'provider timeout must be bounded'
    );
    const body = JSON.parse(request.body);
    assert.deepStrictEqual(body.PhoneNumberSet, [E164_PHONE]);
    assert.strictEqual(body.TemplateParamSet[0], '000042');

    const missingCollections = new Set(
      harness.database.calls
        .filter((call) => call.missingWasThrown)
        .map((call) => call.collection)
    );
    assert(missingCollections.has('sms_codes'));
    assert(missingCollections.has('sms_rate_limits'));
    const challengeDocument = harness.database.all('sms_codes')[0];
    assert(challengeDocument);
    assert.strictEqual(challengeDocument.status, 'sent');
    assert.strictEqual(
      challengeDocument.expiresAt.getTime(),
      BASE_MS + SMS_CODE_TTL_MS
    );
    assert.strictEqual(
      challengeDocument.lastSentAt.getTime(),
      BASE_MS
    );
    assert.strictEqual(
      challengeDocument._id,
      challengeDocumentId(
        keyringFixture('K2', ['K1']),
        result.challengeId
      )
    );
    assert.notStrictEqual(
      challengeDocument.codeHash,
      '000042'
    );
    assertNoSensitiveText(harness.database.snapshot(), [
      RAW_PHONE,
      E164_PHONE,
      result.challengeId,
      '000042',
      'provider-secret-key',
      'forbidden-legacy-code-secret',
      'provider-request-id',
      'provider accepted'
    ]);
    assertNoSensitiveText(result, [
      RAW_PHONE,
      E164_PHONE,
      '000042',
      'provider-secret-key'
    ]);
    const forbiddenCollections = new Set([
      'accounts',
      'users',
      'auth_sessions',
      'wechat_bindings'
    ]);
    assert.strictEqual(
      harness.database.calls.some(
        (call) => forbiddenCollections.has(call.collection)
      ),
      false,
      'anonymous send must touch only auth control and SMS state'
    );
  });
}

async function testMissingDiscriminationAndConfigurationFailure() {
  const cases = [
    {
      name: 'error code alone',
      decision() {
        const error = new Error('document absent');
        error.code = 'DATABASE_DOCUMENT_NOT_FOUND';
        return { throw: error };
      }
    },
    {
      name: 'wrong id in missing message',
      decision() {
        return { throw: exactMissingError('wrong-document-id') };
      }
    },
    {
      name: 'malformed get result',
      decision() {
        return { return: {} };
      }
    },
    {
      name: 'generic database failure',
      decision() {
        const error = new Error('generic database failure');
        error.code = -502001;
        error.errCode = 'DATABASE_REQUEST_FAILED';
        return { throw: error };
      }
    }
  ];
  for (const testCase of cases) {
    await withEnvironment({}, async () => {
      let injected = false;
      const harness = createEntryHarness({
        dbBehavior: {
          getBehavior(call) {
            if (
              !injected
              && call.scope === 'transaction'
              && call.collection !== 'auth_control'
            ) {
              injected = true;
              return testCase.decision(call);
            }
            return undefined;
          }
        }
      });
      const result = await withNow(
        BASE_MS,
        () => harness.entry.main(sendEvent())
      );
      assertFailure(result, 'SMS_SEND_FAILED');
      assert.strictEqual(
        harness.httpsRequests.length,
        0,
        testCase.name
      );
      assert.deepStrictEqual(
        harness.randomIntCalls,
        [],
        testCase.name
      );
      assert.deepStrictEqual(
        harness.database.all('sms_codes'),
        [],
        testCase.name
      );
      assertNoSensitiveText(result, [
        RAW_PHONE,
        E164_PHONE,
        'generic database failure',
        'wrong-document-id'
      ]);
    });
  }

  await withEnvironment({
    CUETRACE_SMS_SECRET_ID: undefined
  }, async () => {
    const harness = createEntryHarness();
    const result = await harness.entry.main(sendEvent());
    assertFailure(result, 'SMS_SEND_FAILED');
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(result, 'missing'),
      false
    );
    assert.strictEqual(harness.httpsRequests.length, 0);
    assert.deepStrictEqual(harness.randomBytesCalls, []);
    assert.deepStrictEqual(harness.randomIntCalls, []);
    assert.strictEqual(
      harness.database.calls.some(
        (call) => call.collection === 'sms_rate_limits'
      ),
      false
    );
  });

  const invalidProviderConfigurations = [
    ['blank secret id', { CUETRACE_SMS_SECRET_ID: ' \t ' }],
    ['blank secret key', { CUETRACE_SMS_SECRET_KEY: ' \t ' }],
    ['blank sdk app id', { CUETRACE_SMS_SDK_APP_ID: ' \t ' }],
    ['blank sign name', { CUETRACE_SMS_SIGN_NAME: ' \t ' }],
    ['blank template id', { CUETRACE_SMS_TEMPLATE_ID: ' \t ' }],
    [
      'empty template parameter list',
      { CUETRACE_SMS_TEMPLATE_PARAMS: ',' }
    ]
  ];
  for (const [name, overrides] of invalidProviderConfigurations) {
    await withEnvironment(overrides, async () => {
      const harness = createEntryHarness();
      const result = await harness.entry.main(sendEvent({
        clientInstanceId: 'invalid-provider-config'
      }));
      assertFailure(result, 'SMS_SEND_FAILED');
      assert.strictEqual(harness.httpsRequests.length, 0, name);
      assert.deepStrictEqual(harness.randomBytesCalls, [], name);
      assert.deepStrictEqual(harness.randomIntCalls, [], name);
      assert.deepStrictEqual(
        harness.database.all('sms_codes'),
        [],
        name
      );
      assert.strictEqual(
        harness.database.calls.some(
          (call) => call.collection === 'sms_rate_limits'
        ),
        false,
        name
      );
    });
  }
}

async function testAnonymousPurposeAuthorization() {
  for (const purpose of ['login', 'wechat_entry']) {
    await withEnvironment({}, async () => {
      const harness = createEntryHarness({
        randomIntValues: [123456]
      });
      const result = await withNow(
        BASE_MS,
        () => harness.entry.main(sendEvent({
          purpose,
          clientInstanceId: 'anonymous-' + purpose
        }))
      );
      assert.strictEqual(result.ok, true, purpose);
      assert.strictEqual(harness.httpsRequests.length, 1, purpose);
      assert.strictEqual(
        harness.database.calls.some((call) => (
          [
            'accounts',
            'users',
            'auth_sessions',
            'wechat_bindings'
          ].includes(call.collection)
        )),
        false,
        purpose
      );
    });
  }

  await withEnvironment({}, async () => {
    const harness = createEntryHarness({
      wxContext: { APPID: '', OPENID: '' }
    });
    const result = await harness.entry.main(sendEvent());
    assertFailure(result, 'UNAUTHORIZED');
    assert.strictEqual(harness.httpsRequests.length, 0);
    assert.deepStrictEqual(harness.randomBytesCalls, []);
    assert.deepStrictEqual(harness.randomIntCalls, []);
  });
}

async function testSessionPurposeAuthorizationAndScope() {
  await withEnvironment({}, async () => {
    const harness = createEntryHarness();
    for (const purpose of ['bind_phone', 'reauth']) {
      const result = await harness.entry.main(
        sendEvent({ purpose })
      );
      assertFailure(result, 'SESSION_REQUIRED');
    }
    assert.strictEqual(harness.httpsRequests.length, 0);
    assert.deepStrictEqual(harness.randomBytesCalls, []);
    assert.deepStrictEqual(harness.randomIntCalls, []);
  });

  await withEnvironment({}, async () => {
    const keyring = keyringFixture('K2', ['K1']);
    const accountId = 'acct_bind_phone';
    const harness = createEntryHarness({
      seed: {
        accounts: [baseAccount(accountId)],
        users: [baseUser(accountId)]
      },
      randomIntValues: [234567]
    });
    const issued = await issueHarnessSession(
      harness,
      keyring,
      accountId,
      BASE_MS,
      'session-bind-client'
    );
    const result = await withNow(
      BASE_MS,
      () => harness.entry.main(sendEvent({
        purpose: 'bind_phone',
        clientInstanceId: 'bind-client',
        sessionToken: issued.sessionToken,
        accountId: 'forged-account',
        sessionId: 'forged-session',
        APPID: 'forged-appid',
        OPENID: 'forged-openid',
        roles: ['admin']
      }))
    );
    assert.strictEqual(result.ok, true);
    const record = harness.database.all('sms_codes')[0];
    const wxIdentityValue = wxFixture('entry');
    const expectedScope = scopeFixture(
      'bind_phone',
      wxIdentityValue,
      'bind-client',
      accountId,
      ''
    );
    assert.strictEqual(
      record.scopeHash,
      scopeHashForVersion(
        keyring,
        'K2',
        'bind_phone',
        expectedScope
      )
    );
    const wronglySessionBound = {
      ...expectedScope,
      sessionId: issued.sessionRecord._id
    };
    assert.notStrictEqual(
      record.scopeHash,
      scopeHashForVersion(
        keyring,
        'K2',
        'bind_phone',
        wronglySessionBound
      ),
      'bind_phone must not bind the exact session id'
    );
    assertNoSensitiveText(record, [
      'forged-account',
      'forged-session',
      'forged-appid',
      'forged-openid'
    ]);
  });

  const keyring = keyringFixture('K2', ['K1']);
  const candidates = candidateHmacIds(
    keyring,
    'phone-binding',
    E164_PHONE,
    'phone'
  );
  assert.strictEqual(candidates.length, 2);
  for (const candidate of candidates) {
    await withEnvironment({}, async () => {
      const accountId =
        'acct_reauth_' + candidate.keyVersion.toLowerCase();
      const harness = createEntryHarness({
        seed: {
          accounts: [
            baseAccount(accountId, candidate.id)
          ],
          users: [baseUser(accountId)]
        },
        randomIntValues: [345678]
      });
      const issued = await issueHarnessSession(
        harness,
        keyring,
        accountId,
        BASE_MS,
        'session-reauth-client'
      );
      const result = await withNow(
        BASE_MS,
        () => harness.entry.main(sendEvent({
          purpose: 'reauth',
          clientInstanceId: 'reauth-client',
          sessionToken: issued.sessionToken,
          accountId: 'forged-account',
          sessionId: 'forged-session'
        }))
      );
      assert.strictEqual(result.ok, true, candidate.keyVersion);
      const record = harness.database.all('sms_codes')[0];
      const expectedScope = scopeFixture(
        'reauth',
        wxFixture('entry'),
        'reauth-client',
        accountId,
        issued.sessionRecord._id
      );
      assert.strictEqual(
        record.scopeHash,
        scopeHashForVersion(
          keyring,
          'K2',
          'reauth',
          expectedScope
        ),
        candidate.keyVersion
      );

      const providerCalls = harness.httpsRequests.length;
      const wrongPhone = await withNow(
        BASE_MS + SMS_RESEND_MS,
        () => harness.entry.main(sendEvent({
          phone: '13900139000',
          purpose: 'reauth',
          clientInstanceId: 'reauth-client',
          sessionToken: issued.sessionToken
        }))
      );
      assertFailure(wrongPhone, 'INVALID_PHONE');
      assert.strictEqual(
        harness.httpsRequests.length,
        providerCalls,
        'reauth mismatch must not call the provider'
      );
    });
  }
}

async function testGlobalCooldownAndExactBoundaries() {
  assert.strictEqual(SMS_RESEND_MS, 60 * 1000);
  assert.strictEqual(SMS_WINDOW_MS, DAY_MS);
  const keyring = keyringFixture('K2', ['K1']);
  const wxIdentityValue = wxFixture('cooldown');
  const database = createDatabase();

  await withRandomBytes(0x20, async () => {
    await claimDirect(database, {
      purpose: 'login',
      scope: scopeFixture(
        'login',
        wxIdentityValue,
        'client-one'
      ),
      wxIdentity: wxIdentityValue,
      nowMs: BASE_MS,
      keyring
    });
    await assert.rejects(
      () => claimDirect(database, {
        purpose: 'wechat_entry',
        scope: scopeFixture(
          'wechat_entry',
          wxIdentityValue,
          'client-two'
        ),
        wxIdentity: wxIdentityValue,
        nowMs: BASE_MS + SMS_RESEND_MS - 1,
        keyring
      }),
      (error) => assertRejectCode(error, 'SMS_TOO_FREQUENT'),
      'phone cooldown spans purpose and client instance'
    );
    const atBoundary = await claimDirect(database, {
      purpose: 'wechat_entry',
      scope: scopeFixture(
        'wechat_entry',
        wxIdentityValue,
        'client-two'
      ),
      wxIdentity: wxIdentityValue,
      nowMs: BASE_MS + SMS_RESEND_MS,
      keyring
    });
    assert.strictEqual(atBoundary.generation, 1);
  });

  const windowDatabase = createDatabase();
  await withRandomBytes(0x30, async () => {
    const first = await claimDirect(windowDatabase, {
      purpose: 'login',
      scope: scopeFixture(
        'login',
        wxIdentityValue,
        'window-one'
      ),
      wxIdentity: wxIdentityValue,
      nowMs: BASE_MS,
      keyring
    });
    const second = await claimDirect(windowDatabase, {
      purpose: 'login',
      scope: scopeFixture(
        'login',
        wxIdentityValue,
        'window-two'
      ),
      wxIdentity: wxIdentityValue,
      nowMs: BASE_MS + SMS_WINDOW_MS,
      keyring
    });
    assert.strictEqual(second.generation, first.generation + 1);
    const phoneRates = windowDatabase
      .all('sms_rate_limits')
      .filter((record) => record.kind === 'phone');
    assert.strictEqual(phoneRates.length, 1);
    assert.strictEqual(
      phoneRates[0].events.length,
      1,
      'an event exactly 24 hours old is pruned'
    );
    assert.strictEqual(
      phoneRates[0].events[0].challengeId,
      second.challengeDocumentId
    );
  });
}

async function testRollingPhoneAndWechatLimits() {
  const keyring = keyringFixture('K2', ['K1']);
  const wxIdentityValue = wxFixture('daily-phone');
  const phoneDatabase = createDatabase();
  await withRandomBytes(0x50, async () => {
    for (let index = 0; index < 10; index += 1) {
      const claim = await claimDirect(phoneDatabase, {
        purpose: 'login',
        scope: scopeFixture(
          'login',
          wxIdentityValue,
          'phone-limit-' + index
        ),
        wxIdentity: wxIdentityValue,
        nowMs: BASE_MS + index * (SMS_RESEND_MS + 1),
        keyring
      });
      assert.strictEqual(claim.generation, index + 1);
    }
    await assert.rejects(
      () => claimDirect(phoneDatabase, {
        purpose: 'login',
        scope: scopeFixture(
          'login',
          wxIdentityValue,
          'phone-limit-rejected'
        ),
        wxIdentity: wxIdentityValue,
        nowMs: BASE_MS + 10 * (SMS_RESEND_MS + 1),
        keyring
      }),
      (error) => assertRejectCode(error, 'SMS_TOO_FREQUENT')
    );
    const activePhoneRate = phoneDatabase
      .all('sms_rate_limits')
      .find((record) => (
        record.kind === 'phone'
        && record.keyVersion === 'K2'
      ));
    assert.strictEqual(activePhoneRate.events.length, 10);
  });

  const wxRateIdentity = wxFixture('daily-wechat');
  const wxDatabase = createDatabase();
  await withRandomBytes(0x70, async () => {
    for (let index = 0; index < 30; index += 1) {
      const purpose = index % 2 === 0
        ? 'login'
        : 'wechat_entry';
      await claimDirect(wxDatabase, {
        phone: phoneFor(index),
        purpose,
        scope: scopeFixture(
          purpose,
          wxRateIdentity,
          'wx-limit-' + index
        ),
        wxIdentity: wxRateIdentity,
        nowMs: BASE_MS,
        keyring
      });
    }
    await assert.rejects(
      () => claimDirect(wxDatabase, {
        phone: phoneFor(30),
        purpose: 'login',
        scope: scopeFixture(
          'login',
          wxRateIdentity,
          'wx-limit-rejected'
        ),
        wxIdentity: wxRateIdentity,
        nowMs: BASE_MS,
        keyring
      }),
      (error) => assertRejectCode(error, 'SMS_TOO_FREQUENT')
    );
    const activeWechatRate = wxDatabase
      .all('sms_rate_limits')
      .find((record) => (
        record.kind === 'wechat'
        && record.keyVersion === 'K2'
      ));
    assert.strictEqual(activeWechatRate.events.length, 30);
  });
}

async function testRotationMergeAndDeduplication() {
  const keyringK1 = keyringFixture('K1', []);
  const keyringK2 = keyringFixture('K2', ['K1']);
  const wxIdentityValue = wxFixture('rotation');
  const database = createDatabase();
  await withRandomBytes(0x90, async () => {
    await claimDirect(database, {
      purpose: 'login',
      scope: scopeFixture(
        'login',
        wxIdentityValue,
        'rotation-one'
      ),
      wxIdentity: wxIdentityValue,
      nowMs: BASE_MS,
      keyring: keyringK1
    });
    await claimDirect(database, {
      purpose: 'login',
      scope: scopeFixture(
        'login',
        wxIdentityValue,
        'rotation-two'
      ),
      wxIdentity: wxIdentityValue,
      nowMs: BASE_MS + SMS_RESEND_MS,
      keyring: keyringK2
    });

    let phoneRates = database
      .all('sms_rate_limits')
      .filter((record) => record.kind === 'phone');
    assert.deepStrictEqual(
      phoneRates.map((record) => record.keyVersion).sort(),
      ['K1', 'K2']
    );
    for (const record of phoneRates) {
      assert.strictEqual(record.events.length, 2);
      assert.strictEqual(record.purposes.login.generation, 2);
    }
    let wechatRates = database
      .all('sms_rate_limits')
      .filter((record) => record.kind === 'wechat');
    assert.deepStrictEqual(
      wechatRates.map((record) => record.keyVersion).sort(),
      ['K1', 'K2']
    );
    for (const record of wechatRates) {
      assert.strictEqual(
        record.events.length,
        2,
        'existing historical WeChat rate state is synchronized'
      );
    }

    await claimDirect(database, {
      purpose: 'login',
      scope: scopeFixture(
        'login',
        wxIdentityValue,
        'rotation-three'
      ),
      wxIdentity: wxIdentityValue,
      nowMs: BASE_MS + 2 * SMS_RESEND_MS,
      keyring: keyringK2
    });
    phoneRates = database
      .all('sms_rate_limits')
      .filter((record) => record.kind === 'phone');
    for (const record of phoneRates) {
      assert.strictEqual(
        record.events.length,
        3,
        'mirrored history must be deduplicated'
      );
      assert.strictEqual(record.purposes.login.generation, 3);
      assert.strictEqual(
        new Set(
          record.events.map((event) => event.challengeId)
        ).size,
        3
      );
    }
    wechatRates = database
      .all('sms_rate_limits')
      .filter((record) => record.kind === 'wechat');
    for (const record of wechatRates) {
      assert.strictEqual(
        record.events.length,
        3,
        'historical WeChat events must be deduplicated'
      );
      assert.strictEqual(
        new Set(
          record.events.map((event) => event.challengeId)
        ).size,
        3
      );
    }
  });
}

async function testFourPurposesAndScopeIsolation() {
  const keyring = keyringFixture('K2', ['K1']);
  const wxIdentityValue = wxFixture('purposes');
  const database = createDatabase();
  const fixtures = [
    {
      purpose: 'login',
      phone: phoneFor(100),
      scope: scopeFixture(
        'login',
        wxIdentityValue,
        'purpose-login'
      )
    },
    {
      purpose: 'wechat_entry',
      phone: phoneFor(101),
      scope: scopeFixture(
        'wechat_entry',
        wxIdentityValue,
        'purpose-wechat'
      )
    },
    {
      purpose: 'bind_phone',
      phone: phoneFor(102),
      scope: scopeFixture(
        'bind_phone',
        wxIdentityValue,
        'purpose-bind',
        'acct-purpose-bind',
        ''
      )
    },
    {
      purpose: 'reauth',
      phone: phoneFor(103),
      scope: scopeFixture(
        'reauth',
        wxIdentityValue,
        'purpose-reauth',
        'acct-purpose-reauth',
        'session-purpose-reauth'
      )
    }
  ];

  await withRandomBytes(0xb0, async () => {
    for (let index = 0; index < fixtures.length; index += 1) {
      const fixture = fixtures[index];
      const claim = await sentChallenge(database, {
        phone: fixture.phone,
        purpose: fixture.purpose,
        scope: fixture.scope,
        wxIdentity: wxIdentityValue,
        nowMs: BASE_MS,
        code: '12' + String(index).padStart(4, '0'),
        keyring
      });
      fixture.claim = claim;
      fixture.code = '12' + String(index).padStart(4, '0');
    }
  });

  for (let index = 0; index < fixtures.length; index += 1) {
    const fixture = fixtures[index];
    const otherPurpose =
      fixtures[(index + 1) % fixtures.length].purpose;
    const crossPurpose = await consumeDirect(database, {
      challengeId: fixture.claim.challengeId,
      code: fixture.code,
      expectedPurpose: otherPurpose,
      expectedScope: fixture.scope,
      nowMs: BASE_MS + 1,
      keyring
    });
    assertFailure(crossPurpose, 'SMS_CODE_INVALID');

    const wrongScope = {
      ...fixture.scope,
      clientInstanceId:
        fixture.scope.clientInstanceId + '-forged'
    };
    const scopeMismatch = await consumeDirect(database, {
      challengeId: fixture.claim.challengeId,
      code: fixture.code,
      expectedPurpose: fixture.purpose,
      expectedScope: wrongScope,
      nowMs: BASE_MS + 2,
      keyring
    });
    assertFailure(scopeMismatch, 'SMS_CODE_INVALID');
    assert.strictEqual(
      database.get(
        'sms_codes',
        fixture.claim.challengeDocumentId
      ).failedAttempts,
      0,
      'structural rejection must not consume an attempt'
    );

    const consumed = await consumeDirect(database, {
      challengeId: fixture.claim.challengeId,
      code: fixture.code,
      expectedPurpose: fixture.purpose,
      expectedScope: fixture.scope,
      nowMs: BASE_MS + 3,
      keyring
    });
    assert.strictEqual(consumed.ok, true);
    assert.strictEqual(consumed.purpose, fixture.purpose);
    assert.match(
      consumed.phoneBindingId,
      /^phone\.K2\.[A-Za-z0-9_-]{43}$/
    );
    assert.strictEqual(typeof consumed.phoneMasked, 'string');
    assertNoSensitiveText(consumed, [
      fixture.phone,
      fixture.code,
      fixture.claim.challengeId,
      fixture.scope.wechatBindingInput,
      fixture.scope.clientInstanceId
    ]);
  }
}

async function testRejectedStatesAndExpiryBoundary() {
  const keyring = keyringFixture('K2', ['K1']);
  const wxIdentityValue = wxFixture('states');

  const pendingDatabase = createDatabase();
  let pendingClaim;
  await withRandomBytes(0xc0, async () => {
    pendingClaim = await claimDirect(pendingDatabase, {
      purpose: 'login',
      scope: scopeFixture(
        'login',
        wxIdentityValue,
        'pending-client'
      ),
      wxIdentity: wxIdentityValue,
      nowMs: BASE_MS,
      keyring
    });
  });
  const pending = await consumeDirect(pendingDatabase, {
    challengeId: pendingClaim.challengeId,
    code: '123456',
    expectedPurpose: 'login',
    expectedScope: scopeFixture(
      'login',
      wxIdentityValue,
      'pending-client'
    ),
    nowMs: BASE_MS + 1,
    keyring
  });
  assertFailure(pending, 'SMS_CODE_INVALID');
  assert.strictEqual(
    pendingDatabase.get(
      'sms_codes',
      pendingClaim.challengeDocumentId
    ).failedAttempts,
    0
  );

  const failedDatabase = createDatabase();
  let failedClaim;
  await withRandomBytes(0xc1, async () => {
    failedClaim = await claimDirect(failedDatabase, {
      purpose: 'login',
      scope: scopeFixture(
        'login',
        wxIdentityValue,
        'failed-client'
      ),
      wxIdentity: wxIdentityValue,
      nowMs: BASE_MS,
      keyring
    });
  });
  const failedFinalization = await finalizeDirect(
    failedDatabase,
    {
      claim: failedClaim,
      providerResult: { status: 'failed' },
      nowMs: BASE_MS + 1,
      keyring
    }
  );
  assert.strictEqual(failedFinalization.ok, false);
  const failedRecord = failedDatabase.get(
    'sms_codes',
    failedClaim.challengeDocumentId
  );
  assert.strictEqual(failedRecord.status, 'failed');
  assert.strictEqual(failedRecord.codeHash, '');
  assert.strictEqual(failedRecord.expiresAt, null);
  assert.strictEqual(failedRecord.lastSentAt, null);
  const failedConsume = await consumeDirect(failedDatabase, {
    challengeId: failedClaim.challengeId,
    code: '123456',
    expectedPurpose: 'login',
    expectedScope: scopeFixture(
      'login',
      wxIdentityValue,
      'failed-client'
    ),
    nowMs: BASE_MS + 2,
    keyring
  });
  assertFailure(failedConsume, 'SMS_CODE_INVALID');

  const supersededDatabase = createDatabase();
  let oldClaim;
  let newClaim;
  await withRandomBytes(0xc2, async () => {
    oldClaim = await claimDirect(supersededDatabase, {
      purpose: 'login',
      scope: scopeFixture(
        'login',
        wxIdentityValue,
        'old-client'
      ),
      wxIdentity: wxIdentityValue,
      nowMs: BASE_MS,
      keyring
    });
    newClaim = await claimDirect(supersededDatabase, {
      purpose: 'login',
      scope: scopeFixture(
        'login',
        wxIdentityValue,
        'new-client'
      ),
      wxIdentity: wxIdentityValue,
      nowMs: BASE_MS + SMS_RESEND_MS,
      keyring
    });
  });
  const oldRecord = supersededDatabase.get(
    'sms_codes',
    oldClaim.challengeDocumentId
  );
  assert.strictEqual(oldRecord.status, 'superseded');
  assert.strictEqual(oldRecord.codeHash, '');
  assert.strictEqual(oldRecord.expiresAt, null);
  assert.strictEqual(oldRecord.lastSentAt, null);
  const supersededConsume = await consumeDirect(
    supersededDatabase,
    {
      challengeId: oldClaim.challengeId,
      code: '123456',
      expectedPurpose: 'login',
      expectedScope: scopeFixture(
        'login',
        wxIdentityValue,
        'old-client'
      ),
      nowMs: BASE_MS + SMS_RESEND_MS + 1,
      keyring
    }
  );
  assertFailure(supersededConsume, 'SMS_CODE_INVALID');
  assert.strictEqual(
    supersededDatabase.get(
      'sms_codes',
      oldClaim.challengeDocumentId
    ).failedAttempts,
    0
  );
  assert.strictEqual(newClaim.generation, oldClaim.generation + 1);

  const staleDatabase = createDatabase();
  let staleClaim;
  const staleScope = scopeFixture(
    'login',
    wxIdentityValue,
    'stale-client'
  );
  await withRandomBytes(0xc4, async () => {
    staleClaim = await sentChallenge(staleDatabase, {
      purpose: 'login',
      scope: staleScope,
      wxIdentity: wxIdentityValue,
      nowMs: BASE_MS,
      code: '234567',
      keyring
    });
  });
  const staleChallengeRecord = staleDatabase.get(
    'sms_codes',
    staleClaim.challengeDocumentId
  );
  const staleRate = staleDatabase.get(
    'sms_rate_limits',
    staleChallengeRecord.phoneRateId
  );
  const newerStaleChallengeId = 'sms-challenge.K2.'
    + 'A'.repeat(43);
  await staleDatabase.db.runTransaction(
    (transaction) => transaction
      .collection('sms_rate_limits')
      .doc(staleChallengeRecord.phoneRateId)
      .update({
        data: {
          events: [
            ...staleRate.events,
            {
              challengeId: newerStaleChallengeId,
              acceptedAt: new Date(BASE_MS + 1)
            }
          ],
          lastAcceptedAt: new Date(BASE_MS + 1),
          purposes: {
            ...staleRate.purposes,
            login: {
              generation: staleClaim.generation + 1,
              activeChallengeId: newerStaleChallengeId
            }
          }
        }
      })
  );
  const stale = await consumeDirect(staleDatabase, {
    challengeId: staleClaim.challengeId,
    code: '234567',
    expectedPurpose: 'login',
    expectedScope: staleScope,
    nowMs: BASE_MS + 1,
    keyring
  });
  assertFailure(stale, 'SMS_CODE_INVALID');
  assert.strictEqual(
    staleDatabase.get(
      'sms_codes',
      staleClaim.challengeDocumentId
    ).failedAttempts,
    0
  );

  const expiredDatabase = createDatabase();
  const expiredScope = scopeFixture(
    'login',
    wxIdentityValue,
    'expired-client'
  );
  let expiredClaim;
  await withRandomBytes(0xc5, async () => {
    expiredClaim = await sentChallenge(expiredDatabase, {
      purpose: 'login',
      scope: expiredScope,
      wxIdentity: wxIdentityValue,
      nowMs: BASE_MS,
      code: '345678',
      keyring
    });
  });
  const expired = await consumeDirect(expiredDatabase, {
    challengeId: expiredClaim.challengeId,
    code: '345678',
    expectedPurpose: 'login',
    expectedScope: expiredScope,
    nowMs: BASE_MS + SMS_CODE_TTL_MS,
    keyring
  });
  assertFailure(expired, 'SMS_CODE_EXPIRED');
  assert.strictEqual(
    expiredDatabase.get(
      'sms_codes',
      expiredClaim.challengeDocumentId
    ).failedAttempts,
    0
  );

  for (const invalidId of [
    'v2.K2.AQ',
    'v2.K3.' + Buffer.alloc(16, 1).toString('base64url'),
    'v2.K2.' + Buffer.alloc(15, 1).toString('base64url'),
    'v2.K2.' + Buffer.alloc(16, 1).toString('base64')
  ]) {
    const invalid = await consumeDirect(expiredDatabase, {
      challengeId: invalidId,
      code: '345678',
      expectedPurpose: 'login',
      expectedScope: expiredScope,
      nowMs: BASE_MS + 1,
      keyring
    });
    assertFailure(invalid, 'SMS_CODE_INVALID');
  }
}

async function testProviderSuccessFinalizerLosesToNewGeneration() {
  const keyring = keyringFixture('K2', ['K1']);
  const wxIdentityValue = wxFixture('finalizer-race');
  const database = createDatabase();
  const oldScope = scopeFixture(
    'login',
    wxIdentityValue,
    'provider-old'
  );
  const newScope = scopeFixture(
    'login',
    wxIdentityValue,
    'provider-new'
  );
  let oldClaim;
  let newClaim;
  await withRandomBytes(0xd0, async () => {
    oldClaim = await claimDirect(database, {
      purpose: 'login',
      scope: oldScope,
      wxIdentity: wxIdentityValue,
      nowMs: BASE_MS,
      keyring
    });
    newClaim = await claimDirect(database, {
      purpose: 'login',
      scope: newScope,
      wxIdentity: wxIdentityValue,
      nowMs: BASE_MS + SMS_RESEND_MS,
      keyring
    });
  });
  const oldFinalization = await finalizeDirect(database, {
    claim: oldClaim,
    providerResult: {
      status: 'sent',
      code: '456789'
    },
    nowMs: BASE_MS + SMS_RESEND_MS + 1,
    keyring
  });
  assert.strictEqual(oldFinalization.ok, false);
  const oldRecord = database.get(
    'sms_codes',
    oldClaim.challengeDocumentId
  );
  assert.strictEqual(oldRecord.status, 'superseded');
  assert.strictEqual(oldRecord.codeHash, '');
  assert.strictEqual(oldRecord.expiresAt, null);

  const newFinalization = await finalizeDirect(database, {
    claim: newClaim,
    providerResult: {
      status: 'sent',
      code: '567890'
    },
    nowMs: BASE_MS + SMS_RESEND_MS + 2,
    keyring
  });
  assert.strictEqual(newFinalization.ok, true);
  const oldConsume = await consumeDirect(database, {
    challengeId: oldClaim.challengeId,
    code: '456789',
    expectedPurpose: 'login',
    expectedScope: oldScope,
    nowMs: BASE_MS + SMS_RESEND_MS + 3,
    keyring
  });
  assertFailure(oldConsume, 'SMS_CODE_INVALID');
  const newConsume = await consumeDirect(database, {
    challengeId: newClaim.challengeId,
    code: '567890',
    expectedPurpose: 'login',
    expectedScope: newScope,
    nowMs: BASE_MS + SMS_RESEND_MS + 3,
    keyring
  });
  assert.strictEqual(newConsume.ok, true);
}

async function testProviderFailuresRetainClaimsAndFailClosed() {
  const providerDetail =
    'provider rejected ' + E164_PHONE + ' code 654321';
  await withEnvironment({}, async () => {
    const harness = createEntryHarness({
      httpsBehavior: {
        type: 'error',
        message: providerDetail
      },
      randomIntValues: [654321]
    });
    const failed = await withNow(
      BASE_MS,
      () => harness.entry.main(sendEvent())
    );
    assertFailure(failed, 'SMS_SEND_FAILED');
    assertNoSensitiveText(failed, [
      providerDetail,
      RAW_PHONE,
      E164_PHONE,
      '654321'
    ]);
    const record = harness.database.all('sms_codes')[0];
    assert.strictEqual(record.status, 'failed');
    assert.strictEqual(record.codeHash, '');
    assert.strictEqual(record.expiresAt, null);
    assert.strictEqual(record.lastSentAt, null);
    assert.strictEqual(record.providerMarker, 'failed');
    const retry = await withNow(
      BASE_MS,
      () => harness.entry.main(sendEvent({
        clientInstanceId: 'retry-client'
      }))
    );
    assertFailure(retry, 'SMS_TOO_FREQUENT');
    assert.strictEqual(harness.httpsRequests.length, 1);
    const phoneRate = harness.database
      .all('sms_rate_limits')
      .find((item) => item.kind === 'phone');
    assert.strictEqual(phoneRate.events.length, 1);
    assertNoSensitiveText(harness.database.snapshot(), [
      providerDetail,
      '654321',
      'provider-secret-key'
    ]);
  });

  await withEnvironment({}, async () => {
    const harness = createEntryHarness({
      httpsBehavior: { type: 'timeout' },
      randomIntValues: [765432]
    });
    const result = await withNow(
      BASE_MS,
      () => harness.entry.main(sendEvent())
    );
    assertFailure(result, 'SMS_SEND_FAILED');
    assert.strictEqual(harness.httpsRequests.length, 1);
    assert.strictEqual(harness.httpsRequests[0].destroyed, true);
    assert(
      harness.httpsRequests[0].timeoutMs >= 1000
      && harness.httpsRequests[0].timeoutMs <= 10000
    );
    const record = harness.database.all('sms_codes')[0];
    assert.strictEqual(record.status, 'failed');
    assert.strictEqual(record.codeHash, '');
    assert.strictEqual(record.expiresAt, null);
  });

  await withEnvironment({}, async () => {
    const harness = createEntryHarness({
      randomIntValues: [876543],
      dbBehavior: {
        updateBehavior(call) {
          if (
            call.collection === 'sms_codes'
            && call.payload
            && call.payload.data
            && call.payload.data.status === 'sent'
          ) {
            return {
              throw: new Error(
                'simulated finalization database failure'
              )
            };
          }
          return undefined;
        }
      }
    });
    const result = await withNow(
      BASE_MS,
      () => harness.entry.main(sendEvent())
    );
    assertFailure(result, 'SMS_SEND_FAILED');
    assert.strictEqual(harness.httpsRequests.length, 1);
    const record = harness.database.all('sms_codes')[0];
    assert.strictEqual(
      record.status,
      'pending',
      'provider success plus DB failure must stay non-consumable'
    );
    assert.strictEqual(record.codeHash, '');
    assert.strictEqual(record.expiresAt, null);
    assertNoSensitiveText(result, [
      'simulated finalization database failure',
      '876543',
      RAW_PHONE,
      E164_PHONE
    ]);
  });
}

async function testProviderAbsoluteDeadline() {
  await withEnvironment({}, async () => {
    await withFakeTimers(async (timers) => {
      const harness = createEntryHarness({
        httpsBehavior: { type: 'slow-drip' },
        randomIntValues: [345678]
      });
      let settled = false;
      const outcomePromise = harness.entry.main(sendEvent());
      outcomePromise.then(
        () => { settled = true; },
        () => { settled = true; }
      );

      await flushUntil(
        () => Boolean(
          harness.httpsRequests[0]
          && harness.httpsRequests[0].emitResponse
        ),
        'provider response must start'
      );
      assert.strictEqual(
        timers.scheduled.length,
        1,
        'provider request must schedule one absolute deadline'
      );
      const deadlineMs = timers.scheduled[0].timeoutMs;
      assert(
        deadlineMs >= 1000 && deadlineMs <= 10000,
        'absolute provider deadline must be 1-10 seconds'
      );
      assert.strictEqual(
        harness.httpsRequests[0].timeoutMs,
        deadlineMs,
        'socket inactivity timeout must remain enabled'
      );

      timers.advanceBy(deadlineMs - 1);
      harness.httpsRequests[0].emitResponse('data', ' ');
      await Promise.resolve();
      assert.strictEqual(settled, false);
      assert.strictEqual(
        timers.scheduled.length,
        1,
        'response data must not reset the absolute deadline'
      );

      timers.advanceBy(1);
      const result = await outcomePromise;
      assertFailure(result, 'SMS_SEND_FAILED');
      assert.strictEqual(harness.httpsRequests[0].destroyed, true);
      assert.strictEqual(timers.activeCount(), 0);
      assert(timers.cleared.includes(timers.scheduled[0].id));
      const record = harness.database.all('sms_codes')[0];
      assert.strictEqual(record.status, 'failed');
      assert.strictEqual(record.codeHash, '');
      assert.strictEqual(record.expiresAt, null);
    });
  });
}

async function testProviderInterruptedResponsesSettle() {
  await withEnvironment({}, async () => {
    await withFakeTimers(async (timers) => {
      const eventCases = [
        ['aborted', 'response-aborted'],
        ['error', 'response-error'],
        ['close', 'response-close']
      ];
      const running = eventCases.map(([event, type], index) => {
        const harness = createEntryHarness({
          httpsBehavior: { type },
          randomIntValues: [456780 + index]
        });
        const item = {
          event,
          harness,
          settled: false,
          resultPromise: null
        };
        item.resultPromise = harness.entry.main(sendEvent({
          clientInstanceId: 'interrupted-' + event
        }));
        item.resultPromise.then(
          () => { item.settled = true; },
          () => { item.settled = true; }
        );
        return item;
      });

      await flushUntil(
        () => running.every((item) => (
          item.harness.httpsRequests[0]
          && item.harness.httpsRequests[0]
            .responseEventEmitted === item.event
        )),
        'all provider interruption events must fire'
      );
      for (let turn = 0; turn < 5; turn += 1) {
        if (running.every((item) => item.settled)) break;
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.deepStrictEqual(
        running.map((item) => ({
          event: item.event,
          settled: item.settled
        })),
        eventCases.map(([event]) => ({ event, settled: true })),
        'interrupted provider responses must settle immediately'
      );

      const results = await Promise.all(
        running.map((item) => item.resultPromise)
      );
      for (let index = 0; index < running.length; index += 1) {
        assertFailure(results[index], 'SMS_SEND_FAILED');
        const records = running[index]
          .harness.database.all('sms_codes');
        assert.strictEqual(records.length, 1);
        assert.strictEqual(records[0].status, 'failed');
      }
      assert.strictEqual(timers.activeCount(), 0);
    });
  });
}

async function testWrongAttemptsLockAndCommit() {
  const keyring = keyringFixture('K2', ['K1']);
  const wxIdentityValue = wxFixture('attempts');
  const database = createDatabase();
  const scope = scopeFixture(
    'login',
    wxIdentityValue,
    'attempt-client'
  );
  let claim;
  await withRandomBytes(0xe0, async () => {
    claim = await sentChallenge(database, {
      purpose: 'login',
      scope,
      wxIdentity: wxIdentityValue,
      nowMs: BASE_MS,
      code: '123456',
      keyring
    });
  });

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const result = await consumeDirect(database, {
      challengeId: claim.challengeId,
      code: '000000',
      expectedPurpose: 'login',
      expectedScope: scope,
      nowMs: BASE_MS + attempt,
      keyring
    });
    assertFailure(
      result,
      attempt === 5 ? 'SMS_CODE_LOCKED' : 'SMS_CODE_INVALID'
    );
    const record = database.get(
      'sms_codes',
      claim.challengeDocumentId
    );
    assert.strictEqual(
      record.failedAttempts,
      attempt,
      'wrong-attempt result must commit its mutation'
    );
    assert.strictEqual(record.locked, attempt === 5);
    assert.strictEqual(record.used, false);
  }
  const correctAfterLock = await consumeDirect(database, {
    challengeId: claim.challengeId,
    code: '123456',
    expectedPurpose: 'login',
    expectedScope: scope,
    nowMs: BASE_MS + 6,
    keyring
  });
  assertFailure(correctAfterLock, 'SMS_CODE_LOCKED');
}

async function testConcurrentConsumeOnceAndFourWrongRace() {
  const keyring = keyringFixture('K2', ['K1']);
  const wxIdentityValue = wxFixture('consume-race');
  const onceDatabase = createDatabase(undefined, {
    optimisticTransactions: true
  });
  const onceScope = scopeFixture(
    'login',
    wxIdentityValue,
    'consume-once'
  );
  let onceClaim;
  await withRandomBytes(0xe2, async () => {
    onceClaim = await sentChallenge(onceDatabase, {
      purpose: 'login',
      scope: onceScope,
      wxIdentity: wxIdentityValue,
      nowMs: BASE_MS,
      code: '234567',
      keyring
    });
  });
  const onceStatsBefore = optimisticStats(onceDatabase);
  onceDatabase.armFirstAttemptBarrier(2);
  const onceResults = await Promise.all([
    consumeDirect(onceDatabase, {
      challengeId: onceClaim.challengeId,
      code: '234567',
      expectedPurpose: 'login',
      expectedScope: onceScope,
      nowMs: BASE_MS + 1,
      keyring
    }),
    consumeDirect(onceDatabase, {
      challengeId: onceClaim.challengeId,
      code: '234567',
      expectedPurpose: 'login',
      expectedScope: onceScope,
      nowMs: BASE_MS + 1,
      keyring
    })
  ]);
  assert.strictEqual(
    onceResults.filter((result) => result.ok).length,
    1
  );
  assert.strictEqual(
    onceResults.filter(
      (result) => result.code === 'SMS_CODE_INVALID'
    ).length,
    1
  );
  assert.strictEqual(
    onceDatabase.get(
      'sms_codes',
      onceClaim.challengeDocumentId
    ).used,
    true
  );
  assertOptimisticRetries(
    onceDatabase,
    onceStatsBefore,
    2,
    'consume-once race'
  );

  const raceDatabase = createDatabase(undefined, {
    optimisticTransactions: true
  });
  const raceScope = scopeFixture(
    'login',
    wxIdentityValue,
    'four-wrong-race'
  );
  let raceClaim;
  await withRandomBytes(0xe3, async () => {
    raceClaim = await sentChallenge(raceDatabase, {
      phone: phoneFor(200),
      purpose: 'login',
      scope: raceScope,
      wxIdentity: wxIdentityValue,
      nowMs: BASE_MS,
      code: '345678',
      keyring
    });
  });
  const raceStatsBefore = optimisticStats(raceDatabase);
  raceDatabase.armFirstAttemptBarrier(5);
  const raceResults = await Promise.all([
    '000000',
    '000001',
    '000002',
    '000003',
    '345678'
  ].map((code, index) => consumeDirect(raceDatabase, {
    challengeId: raceClaim.challengeId,
    code,
    expectedPurpose: 'login',
    expectedScope: raceScope,
    nowMs: BASE_MS + index + 1,
    keyring
  })));
  assert.strictEqual(
    raceResults.filter((result) => result.ok).length,
    1
  );
  assert.strictEqual(
    raceResults.filter(
      (result) => result.code === 'SMS_CODE_INVALID'
    ).length,
    4
  );
  const raceRecord = raceDatabase.get(
    'sms_codes',
    raceClaim.challengeDocumentId
  );
  assert(
    raceRecord.failedAttempts >= 0
      && raceRecord.failedAttempts <= 4,
    'committed wrong attempts may precede or follow the success'
  );
  assert.strictEqual(raceRecord.locked, false);
  assert.strictEqual(raceRecord.used, true);
  assertOptimisticRetries(
    raceDatabase,
    raceStatsBefore,
    5,
    'four-wrong/correct race'
  );
}

async function testSuccessfulConsumeRollsBackWithLaterCallerWrite() {
  const keyring = keyringFixture('K2', ['K1']);
  const wxIdentityValue = wxFixture('caller-rollback');
  const database = createDatabase();
  const scope = scopeFixture(
    'login',
    wxIdentityValue,
    'caller-rollback'
  );
  let claim;
  await withRandomBytes(0xe4, async () => {
    claim = await sentChallenge(database, {
      purpose: 'login',
      scope,
      wxIdentity: wxIdentityValue,
      nowMs: BASE_MS,
      code: '456789',
      keyring
    });
  });

  await assert.rejects(
    () => database.db.runTransaction(async (transaction) => {
      const consumed = await consumeSmsChallenge({
        transaction,
        challengeId: claim.challengeId,
        code: '456789',
        expectedPurpose: 'login',
        expectedScope: scope,
        now: new Date(BASE_MS + 1),
        keyring
      });
      assert.strictEqual(consumed.ok, true);
      await transaction
        .collection('accounts')
        .doc('missing-later-account')
        .update({ data: { status: 'active' } });
      return consumed;
    }),
    /document\.get:fail document with _id missing-later-account/
  );
  assert.strictEqual(
    database.get(
      'sms_codes',
      claim.challengeDocumentId
    ).used,
    false,
    'later caller failure must roll back successful consumption'
  );
  const retry = await consumeDirect(database, {
    challengeId: claim.challengeId,
    code: '456789',
    expectedPurpose: 'login',
    expectedScope: scope,
    nowMs: BASE_MS + 2,
    keyring
  });
  assert.strictEqual(retry.ok, true);
}

async function testConcurrentEntryClaimsOneProviderWinner() {
  await withEnvironment({}, async () => {
    const harness = createEntryHarness({
      randomIntValues: [111111, 222222],
      dbBehavior: { optimisticTransactions: true }
    });
    const statsBefore = optimisticStats(harness.database);
    harness.database.armFirstAttemptBarrier(2);
    const results = await withNow(
      BASE_MS,
      () => Promise.all([
        harness.entry.main(sendEvent({
          clientInstanceId: 'concurrent-one'
        })),
        harness.entry.main(sendEvent({
          clientInstanceId: 'concurrent-two'
        }))
      ])
    );
    assert.strictEqual(
      results.filter((result) => result.ok).length,
      1
    );
    assert.strictEqual(
      results.filter(
        (result) => result.code === 'SMS_TOO_FREQUENT'
      ).length,
      1
    );
    assert.strictEqual(harness.httpsRequests.length, 1);
    assert.strictEqual(harness.randomIntCalls.length, 1);
    assert.deepStrictEqual(
      harness.randomIntCalls[0],
      { min: 0, max: 1000000 }
    );
    assertOptimisticRetries(
      harness.database,
      statsBefore,
      2,
      'concurrent entry claim'
    );
  });
}

async function testInvalidInputsAndCorruptedRecordShapes() {
  const invalidInputs = [
    {
      event: sendEvent({ phone: '+8613800138000' }),
      code: 'INVALID_PHONE'
    },
    {
      event: sendEvent({ purpose: 'password_reset' }),
      code: 'INVALID_ARGUMENT'
    },
    {
      event: sendEvent({ clientInstanceId: '' }),
      code: 'INVALID_ARGUMENT'
    },
    {
      event: sendEvent({ clientInstanceId: 123 }),
      code: 'INVALID_ARGUMENT'
    }
  ];
  for (const fixture of invalidInputs) {
    await withEnvironment({}, async () => {
      const harness = createEntryHarness();
      const result = await harness.entry.main(fixture.event);
      assertFailure(result, fixture.code);
      assert.strictEqual(harness.httpsRequests.length, 0);
      assert.deepStrictEqual(harness.randomBytesCalls, []);
      assert.deepStrictEqual(harness.randomIntCalls, []);
      assert.strictEqual(
        harness.database.calls.some((call) => (
          call.collection === 'sms_codes'
          || call.collection === 'sms_rate_limits'
        )),
        false,
        'invalid input must not claim SMS state'
      );
    });
  }

  const mutations = [
    {
      name: 'wrong keyVersion',
      data: { keyVersion: 'K1' }
    },
    {
      name: 'wrong phoneRateId',
      data: { phoneRateId: 'wrong-rate-id' }
    },
    {
      name: 'invalid generation',
      data: { generation: 0 }
    },
    {
      name: 'malformed expiry',
      data: { expiresAt: 'not-a-date' }
    }
  ];
  const keyring = keyringFixture('K2', ['K1']);
  for (let index = 0; index < mutations.length; index += 1) {
    const wxIdentityValue = wxFixture(
      'shape-' + index
    );
    const database = createDatabase();
    const scope = scopeFixture(
      'login',
      wxIdentityValue,
      'shape-client-' + index
    );
    let claim;
    await withRandomBytes(0xf0 + index, async () => {
      claim = await sentChallenge(database, {
        phone: phoneFor(300 + index),
        purpose: 'login',
        scope,
        wxIdentity: wxIdentityValue,
        nowMs: BASE_MS,
        code: '567890',
        keyring
      });
    });
    await database.db.runTransaction(
      (transaction) => transaction
        .collection('sms_codes')
        .doc(claim.challengeDocumentId)
        .update({ data: mutations[index].data })
    );
    const before = database.get(
      'sms_codes',
      claim.challengeDocumentId
    ).failedAttempts;
    const result = await consumeDirect(database, {
      challengeId: claim.challengeId,
      code: '567890',
      expectedPurpose: 'login',
      expectedScope: scope,
      nowMs: BASE_MS + 1,
      keyring
    });
    assertFailure(result, 'SMS_CODE_INVALID');
    assert.strictEqual(
      database.get(
        'sms_codes',
        claim.challengeDocumentId
      ).failedAttempts,
      before,
      mutations[index].name
        + ' must reject before an attempt write'
    );
  }
}

async function testNoSensitiveLogsOrSourceFallbacks() {
  await withEnvironment({}, async () => {
    const logs = [];
    const original = {
      log: console.log,
      error: console.error,
      warn: console.warn
    };
    console.log = (...args) => logs.push(args);
    console.error = (...args) => logs.push(args);
    console.warn = (...args) => logs.push(args);
    try {
      const harness = createEntryHarness({
        httpsBehavior: {
          type: 'error',
          message: 'provider-private-detail-999999'
        },
        randomIntValues: [999999]
      });
      const result = await withNow(
        BASE_MS,
        () => harness.entry.main(sendEvent())
      );
      assertFailure(result, 'SMS_SEND_FAILED');
    } finally {
      console.log = original.log;
      console.error = original.error;
      console.warn = original.warn;
    }
    assertNoSensitiveText(logs, [
      RAW_PHONE,
      E164_PHONE,
      '999999',
      'provider-private-detail',
      'provider-secret-key',
      'forbidden-legacy-code-secret'
    ]);
  });

  const sendSource = read(
    'cloudfunctions/sendSmsCode/index.js'
  );
  const smsSource = read(
    'cloudfunctions/_shared/auth/sms.js'
  );
  assert(sendSource.includes(
    "require('./lib/auth/sms')"
  ));
  assert(sendSource.includes('supportedSchemaVersions: [2]'));
  assert(sendSource.includes('normalizePhone'));
  assert(sendSource.includes('wechatIdentity'));
  assert(sendSource.includes('requireSession'));
  assert(!sendSource.includes('function smsCodeId(openid, phone)'));
  assert(!sendSource.includes('SMS_CODE_HASH_SECRET'));
  assert(!smsSource.includes('SMS_CODE_HASH_SECRET'));
  assert(!smsSource.includes('CUETRACE_SMS_SECRET_KEY'));
  assert(!sendSource.includes("collection('wechat_bindings')"));
  assert(!smsSource.includes("collection('wechat_bindings')"));

  assert.strictEqual(
    fileSha256('miniprogram/services/data.js'),
    DATA_SERVICE_SHA256,
    'mini-program data service must remain unchanged'
  );
  assert.strictEqual(
    fileSha256('miniprogram/pages/login/index.js'),
    LOGIN_PAGE_SHA256,
    'mini-program login page must remain unchanged'
  );
}

async function main() {
  await testRateDocumentIntegrityBeforeClaim();
  await testPreviousChallengeIntegrityBeforeSupersession();
  await testFinalizerRejectsCorruptedPendingState();
  await testConsumeRejectsCorruptedRateAndTimeReversal();
  await testScopeVectorAndCanonicalChallenge();
  await testProtocolGuardIsFirstEffect();
  await testVerifySmsCodeIsAProtocolTwoRetiredShim();
  await testPurgeAuthArtifactsBoundaryAndBounds();
  await testPurgeAuthArtifactsFailuresAndDeploymentConfig();
  await testFirstMissingDocumentsCreateAndSendLeadingZero();
  await testMissingDiscriminationAndConfigurationFailure();
  await testAnonymousPurposeAuthorization();
  await testSessionPurposeAuthorizationAndScope();
  await testGlobalCooldownAndExactBoundaries();
  await testRollingPhoneAndWechatLimits();
  await testRotationMergeAndDeduplication();
  await testFourPurposesAndScopeIsolation();
  await testRejectedStatesAndExpiryBoundary();
  await testProviderSuccessFinalizerLosesToNewGeneration();
  await testProviderAbsoluteDeadline();
  await testProviderInterruptedResponsesSettle();
  await testProviderFailuresRetainClaimsAndFailClosed();
  await testWrongAttemptsLockAndCommit();
  await testConcurrentConsumeOnceAndFourWrongRace();
  await testSuccessfulConsumeRollsBackWithLaterCallerWrite();
  await testConcurrentEntryClaimsOneProviderWinner();
  await testInvalidInputsAndCorruptedRecordShapes();
  await testNoSensitiveLogsOrSourceFallbacks();
  console.log(
    'SMS_LOGIN_V2_OK purposes=4 copies=2 '
      + 'cooldown=60s window=24h attempts=5'
  );
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
