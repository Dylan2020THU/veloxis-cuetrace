const assert = require('assert');
const crypto = require('crypto');
const Module = require('module');
const path = require('path');

const root = path.resolve(__dirname, '..');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function bindingId(openid) {
  return sha256(`wechat:${openid}`);
}

function accountId(account) {
  return sha256(`account:${String(account).toLowerCase()}`);
}

function signParams(params, key) {
  const text = Object.keys(params)
    .filter((name) => name !== 'sign' && params[name] !== undefined && params[name] !== '')
    .sort()
    .map((name) => `${name}=${params[name]}`)
    .join('&') + `&key=${key}`;
  return crypto.createHash('md5').update(text, 'utf8').digest('hex').toUpperCase();
}

function signedXml(params, key = process.env.PAP_SIGN_KEY) {
  const data = Object.assign({}, params);
  data.sign = signParams(data, key);
  return Object.keys(data).map((name) => `<${name}>${data[name]}</${name}>`).join('');
}

function parseTestXml(xml) {
  const data = {};
  String(xml).replace(/<([^!?][^>\s\/]*)>([^<]*)<\/\1>/g, (match, name, value) => {
    data[name] = value;
    return match;
  });
  return data;
}

async function withoutErrorLog(callback) {
  const originalError = console.error;
  console.error = () => {};
  try {
    return await callback();
  } finally {
    console.error = originalError;
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

function identity(openid, account) {
  const userId = bindingId(openid);
  const authId = accountId(account);
  return {
    binding: { _id: userId, _openid: openid, accountId: authId, account },
    account: { _id: authId, _openid: openid, account, status: 'active' },
    user: {
      _id: userId,
      _openid: openid,
      roles: ['shop'],
      currentRole: 'shop',
      role: 'shop',
      per_role: {}
    }
  };
}

function stateFor(openid, account) {
  const auth = identity(openid, account);
  return {
    auth,
    state: {
      wechat_bindings: [auth.binding],
      accounts: [auth.account],
      users: [auth.user],
      subscriptions: [],
      account_deletion_requests: []
    }
  };
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
  const config = options || {};
  const operations = { reads: [], adds: [], updates: [], transactions: 0 };
  let nextId = 1;

  function facade(target, inTransaction) {
    function failWrite(collection, method) {
      return inTransaction && config.failTransactionWrite && config.failTransactionWrite({
        collection,
        method
      });
    }

    function collection(name) {
      if (!Object.prototype.hasOwnProperty.call(target, name)) {
        throw new Error(`collection ${name} does not exist`);
      }
      const documents = target[name];
      return {
        doc(id) {
          return {
            async get() {
              operations.reads.push({ collection: name, id, inTransaction });
              return { data: clone(documents.find((item) => item._id === id) || null) };
            },
            async update({ data }) {
              if (failWrite(name, 'update')) throw new Error(`simulated ${name} update failure`);
              const index = documents.findIndex((item) => item._id === id);
              if (index === -1) throw new Error(`${name}/${id} does not exist`);
              documents[index] = Object.assign({}, documents[index], clone(data), { _id: id });
              operations.updates.push({ collection: name, id, data: clone(data), inTransaction });
              return { stats: { updated: 1 } };
            },
            async set({ data }) {
              if (failWrite(name, 'set')) throw new Error(`simulated ${name} set failure`);
              const next = Object.assign({}, clone(data), { _id: id });
              const index = documents.findIndex((item) => item._id === id);
              if (index === -1) documents.push(next);
              else documents[index] = next;
              return { _id: id };
            },
            async delete() {
              if (failWrite(name, 'delete')) throw new Error(`simulated ${name} delete failure`);
              const index = documents.findIndex((item) => item._id === id);
              if (index !== -1) documents.splice(index, 1);
              return { stats: { removed: index === -1 ? 0 : 1 } };
            }
          };
        },
        where(query) {
          let limitValue = 100;
          let direction = 'asc';
          let orderField = '';
          const builder = {
            orderBy(field, nextDirection) {
              orderField = field;
              direction = nextDirection;
              return builder;
            },
            limit(value) {
              limitValue = value;
              return builder;
            },
            async get() {
              if (inTransaction) throw new Error('transaction query is unsupported');
              const found = documents.filter((item) => matches(item, query)).slice();
              if (orderField) {
                found.sort((left, right) => {
                  if (left[orderField] === right[orderField]) return 0;
                  const compared = left[orderField] < right[orderField] ? -1 : 1;
                  return direction === 'desc' ? -compared : compared;
                });
              }
              return { data: clone(found.slice(0, limitValue)) };
            },
            async update({ data }) {
              if (inTransaction) throw new Error('transaction query is unsupported');
              let updated = 0;
              documents.forEach((item, index) => {
                if (!matches(item, query)) return;
                documents[index] = Object.assign({}, item, clone(data));
                updated += 1;
              });
              operations.updates.push({ collection: name, query: clone(query), data: clone(data) });
              return { stats: { updated } };
            }
          };
          return builder;
        },
        async add({ data }) {
          if (failWrite(name, 'add')) throw new Error(`simulated ${name} add failure`);
          const id = `${name}-${nextId}`;
          nextId += 1;
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
    in(values) {
      return { $in: values };
    }
  };
  database.runTransaction = async (callback) => {
    operations.transactions += 1;
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

function makeHttps(responseXml, calls) {
  return {
    request(options, callback) {
      let body = '';
      let errorHandler = null;
      let timeoutMs = 0;
      return {
        on(event, handler) {
          if (event === 'error') errorHandler = handler;
          return this;
        },
        write(chunk) {
          body += String(chunk);
        },
        setTimeout(value) {
          timeoutMs = value;
          return this;
        },
        destroy(error) {
          if (errorHandler) errorHandler(error);
        },
        end() {
          calls.push({ options, body, timeoutMs });
          const responseBody = typeof responseXml === 'function' ? responseXml(body) : responseXml;
          if (responseBody instanceof Error) {
            if (errorHandler) errorHandler(responseBody);
            return;
          }
          const handlers = {};
          const response = {
            on(event, handler) {
              handlers[event] = handler;
              return response;
            }
          };
          callback(response);
          Promise.resolve().then(() => {
            if (handlers.data) handlers.data(responseBody);
            if (handlers.end) handlers.end();
          });
        }
      };
    }
  };
}

function loadCloudFunction(file, openid, state, options) {
  const config = options || {};
  const fakeDb = makeDatabase(state, config);
  const httpsCalls = [];
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
  const fakeHttps = makeHttps(
    config.httpsResponse || ((requestBody) => {
      const request = parseTestXml(requestBody);
      return signedXml({
        return_code: 'SUCCESS',
        result_code: 'SUCCESS',
        mch_id: process.env.PAP_MCH_ID,
        appid: process.env.PAP_APPID,
        contract_id: request.contract_id || 'RETURNED-CONTRACT-ID',
        plan_id: request.plan_id || '',
        contract_code: request.contract_code || ''
      });
    }),
    httpsCalls
  );
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'wx-server-sdk') return fakeCloud;
    if (request === 'https') return fakeHttps;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const fnPath = path.join(root, file);
    delete require.cache[require.resolve(fnPath)];
    return { fn: require(fnPath), fakeDb, httpsCalls };
  } finally {
    Module._load = originalLoad;
  }
}

function createEvent() {
  return { planKey: 'shop_lite', role: 'shop', period: 'month' };
}

function setPaymentEnvironment() {
  const values = {
    PAP_APPID: 'wx-test-appid',
    PAP_MCH_ID: 'test-mch',
    PAP_SIGN_KEY: 'test-sign-key',
    PAP_CONTRACT_NOTIFY_URL: 'https://example.test/contract-callback',
    PAP_PLAN_ID_MONTH: 'plan-month',
    PAP_PLAN_ID_QUARTER: 'plan-quarter',
    PAP_PLAN_ID_YEAR: 'plan-year'
  };
  const previous = {};
  Object.keys(values).forEach((key) => {
    previous[key] = process.env[key];
    process.env[key] = values[key];
  });
  return () => {
    Object.keys(values).forEach((key) => {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    });
  };
}

async function testCreateRecurringContractIsRetiredWithoutWritesOrNetwork() {
  const fixture = stateFor('retired-create-openid', 'RetiredCreateA');
  const before = clone(fixture.state);
  const { fn, fakeDb, httpsCalls } = loadCloudFunction(
    'cloudfunctions/createRecurringContract/index.js',
    fixture.auth.binding._openid,
    fixture.state
  );

  const result = await fn.main(createEvent());

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'PRODUCT_RETIRED');
  assert.deepStrictEqual(fixture.state, before);
  assert.strictEqual(fakeDb.__operations.adds.length, 0);
  assert.strictEqual(fakeDb.__operations.updates.length, 0);
  assert.strictEqual(fakeDb.__operations.transactions, 0);
  assert.strictEqual(httpsCalls.length, 0);
}

async function testDeleteRereadsSharedUserGuardInsideTransaction() {

  const deleteFixture = stateFor('delete-conflict-openid', 'DeleteConflictA');
  const deleteLoaded = loadCloudFunction(
    'cloudfunctions/deleteAccount/index.js',
    deleteFixture.auth.binding._openid,
    deleteFixture.state,
    {
      beforeTransaction({ state }) {
        const user = state.users.find((item) => item._id === deleteFixture.auth.user._id);
        user.subscriptionStatus = 'pending_contract';
        user.subscriptionId = 'concurrent-subscription';
      }
    }
  );
  const deleteResult = await deleteLoaded.fn.main({ reason: 'race' });
  assert.strictEqual(deleteResult.ok, false);
  assert.strictEqual(deleteResult.code, 'ACTIVE_SUBSCRIPTION');
  assert.strictEqual(deleteFixture.state.users[0].deletionStatus, undefined);
  assert.strictEqual(deleteFixture.state.account_deletion_requests.length, 0);
}

function subscriptionFixture(openid, status) {
  const fixture = stateFor(openid, `Account${openid}`);
  const subscription = {
    _id: `subscription-${openid}`,
    _openid: openid,
    userId: fixture.auth.user._id,
    contractCode: `CODE-${openid}`,
    contractId: `CONTRACT-${openid}`,
    planId: 'plan-month',
    status: status || 'pending_contract'
  };
  fixture.state.subscriptions.push(subscription);
  fixture.auth.user.subscriptionStatus = subscription.status;
  fixture.auth.user.subscriptionId = subscription._id;
  return Object.assign(fixture, { subscription });
}

function callbackXml(fixture, changeType, contractId, operateTime = '2026-07-11 12:00:00') {
  return signedXml({
    return_code: 'SUCCESS',
    result_code: 'SUCCESS',
    mch_id: process.env.PAP_MCH_ID,
    contract_code: fixture.subscription.contractCode,
    plan_id: fixture.subscription.planId,
    openid: fixture.subscription._openid,
    change_type: changeType,
    operate_time: operateTime,
    contract_id: contractId,
    request_serial: 1001
  });
}

async function testContractCallbackAtomicallyUpdatesSubscriptionAndUserMarker() {
  const variants = [
    {
      name: 'active',
      initialStatus: 'pending_contract',
      changeType: 'ADD',
      subscriptionStatus: 'active',
      markerStatus: 'active'
    },
    {
      name: 'canceled',
      initialStatus: 'active',
      changeType: 'DELETE',
      subscriptionStatus: 'canceled',
      markerStatus: 'canceled'
    }
  ];
  for (const variant of variants) {
    const fixture = subscriptionFixture(`callback-${variant.name}`, variant.initialStatus);
    const { fn } = loadCloudFunction(
      'cloudfunctions/recurringContractCallback/index.js',
      '',
      fixture.state
    );

    const result = await fn.main({ xml: callbackXml(fixture, variant.changeType, 'ACTIVE-ID') });

    assert(result.includes('<return_code><![CDATA[SUCCESS]]>'), variant.name);
    assert.strictEqual(fixture.state.subscriptions[0].status, variant.subscriptionStatus, variant.name);
    assert.strictEqual(fixture.state.users[0].subscriptionStatus, variant.markerStatus, variant.name);
    assert.strictEqual(fixture.state.users[0].subscriptionId, fixture.subscription._id, variant.name);
  }
}

async function testContractCallbackFailsClosedForInvalidInputAndDatabaseFailure() {
  const variants = [
    {
      name: 'missing sign',
      xml(fixture) {
        return `<return_code>SUCCESS</return_code><result_code>SUCCESS</result_code><mch_id>${process.env.PAP_MCH_ID}</mch_id><contract_code>${fixture.subscription.contractCode}</contract_code><openid>${fixture.subscription._openid}</openid><change_type>ADD</change_type><contract_id>ACTIVE-ID</contract_id>`;
      }
    },
    {
      name: 'invalid sign',
      xml(fixture) {
        return callbackXml(fixture, 'ADD', 'ACTIVE-ID').replace(/<sign>[^<]+<\/sign>/, '<sign>INVALID</sign>');
      }
    },
    {
      name: 'wrong merchant',
      xml(fixture) {
        const xml = callbackXml(fixture, 'ADD', 'ACTIVE-ID');
        return signedXml(Object.assign(parseTestXml(xml), { mch_id: 'foreign-mch' }));
      }
    },
    {
      name: 'wrong openid',
      xml(fixture) {
        const xml = callbackXml(fixture, 'ADD', 'ACTIVE-ID');
        return signedXml(Object.assign(parseTestXml(xml), { openid: 'foreign-openid' }));
      }
    },
    {
      name: 'business failure',
      xml(fixture) {
        const xml = callbackXml(fixture, 'ADD', 'ACTIVE-ID');
        return signedXml(Object.assign(parseTestXml(xml), { result_code: 'FAIL' }));
      }
    }
  ];

  for (const variant of variants) {
    const fixture = subscriptionFixture(`callback-invalid-${variant.name}`, 'pending_contract');
    const before = clone(fixture.state);
    const { fn, fakeDb } = loadCloudFunction(
      'cloudfunctions/recurringContractCallback/index.js',
      '',
      fixture.state
    );

    const result = await withoutErrorLog(() => fn.main({ xml: variant.xml(fixture) }));

    assert(result.includes('<return_code><![CDATA[FAIL]]>'), variant.name);
    assert.deepStrictEqual(fixture.state, before, variant.name);
    if (variant.name !== 'wrong openid') {
      assert.strictEqual(fakeDb.__operations.transactions, 0, variant.name);
    }
  }

  const missingKey = subscriptionFixture('callback-missing-key', 'pending_contract');
  const missingKeyXml = callbackXml(missingKey, 'ADD', 'ACTIVE-ID');
  const originalKey = process.env.PAP_SIGN_KEY;
  delete process.env.PAP_SIGN_KEY;
  try {
    const { fn, fakeDb } = loadCloudFunction(
      'cloudfunctions/recurringContractCallback/index.js',
      '',
      missingKey.state
    );
    const result = await fn.main({ xml: missingKeyXml });
    assert(result.includes('<return_code><![CDATA[FAIL]]>'));
    assert.strictEqual(fakeDb.__operations.transactions, 0);
  } finally {
    process.env.PAP_SIGN_KEY = originalKey;
  }

  const dbFailure = subscriptionFixture('callback-db-failure', 'pending_contract');
  const dbFailureBefore = clone(dbFailure.state);
  const { fn } = loadCloudFunction(
    'cloudfunctions/recurringContractCallback/index.js',
    '',
    dbFailure.state,
    {
      failTransactionWrite(operation) {
        return operation.collection === 'users' && operation.method === 'update';
      }
    }
  );
  const failed = await withoutErrorLog(() => (
    fn.main({ xml: callbackXml(dbFailure, 'ADD', 'ACTIVE-ID') })
  ));
  assert(failed.includes('<return_code><![CDATA[FAIL]]>'));
  assert.deepStrictEqual(dbFailure.state, dbFailureBefore);
}

async function testContractCallbackIsIdempotentAndLateAddRestoresBlockingGuard() {
  const duplicate = subscriptionFixture('callback-duplicate', 'pending_contract');
  const duplicateLoaded = loadCloudFunction(
    'cloudfunctions/recurringContractCallback/index.js',
    '',
    duplicate.state
  );
  const xml = callbackXml(duplicate, 'ADD', 'ACTIVE-ID');
  const first = await duplicateLoaded.fn.main({ xml });
  const updatesAfterFirst = duplicateLoaded.fakeDb.__operations.updates.length;
  const second = await duplicateLoaded.fn.main({ xml });
  assert(first.includes('<return_code><![CDATA[SUCCESS]]>'));
  assert(second.includes('<return_code><![CDATA[SUCCESS]]>'));
  assert.strictEqual(duplicateLoaded.fakeDb.__operations.updates.length, updatesAfterFirst);

  const late = subscriptionFixture('callback-late-add', 'canceled');
  late.subscription.contractId = '';
  const lateLoaded = loadCloudFunction(
    'cloudfunctions/recurringContractCallback/index.js',
    '',
    late.state
  );
  const result = await lateLoaded.fn.main({ xml: callbackXml(late, 'ADD', 'LATE-ACTIVE-ID') });
  assert(result.includes('<return_code><![CDATA[SUCCESS]]>'));
  assert.strictEqual(late.state.subscriptions[0].status, 'active');
  assert.strictEqual(late.state.subscriptions[0].contractId, 'LATE-ACTIVE-ID');
  assert.strictEqual(late.state.users[0].subscriptionStatus, 'active');
  assert.strictEqual(late.state.users[0].subscriptionId, late.subscription._id);
}

async function testDuplicateDeleteAfterUserPurgeAcknowledgesWithoutWrites() {
  const fixture = subscriptionFixture('callback-purged-user', 'canceled');
  fixture.state.users = [];
  const before = clone(fixture.state);
  const loaded = loadCloudFunction(
    'cloudfunctions/recurringContractCallback/index.js',
    '',
    fixture.state
  );

  const result = await withoutErrorLog(() => loaded.fn.main({
    xml: callbackXml(fixture, 'DELETE', fixture.subscription.contractId)
  }));

  assert(result.includes('<return_code><![CDATA[SUCCESS]]>'));
  assert.deepStrictEqual(fixture.state, before);
  assert.strictEqual(loaded.fakeDb.__operations.updates.length, 0);
}

async function testOldContractDeleteDoesNotOverwriteNewSubscriptionMarker() {
  const fixture = subscriptionFixture('callback-old-delete', 'active');
  const next = {
    _id: 'subscription-new-active',
    _openid: fixture.subscription._openid,
    userId: fixture.subscription.userId,
    contractCode: 'NEW-CONTRACT-CODE',
    contractId: 'NEW-CONTRACT-ID',
    planId: 'plan-month',
    status: 'active'
  };
  fixture.state.subscriptions.push(next);
  fixture.state.users[0].subscriptionId = next._id;
  fixture.state.users[0].subscriptionStatus = 'active';
  const loaded = loadCloudFunction(
    'cloudfunctions/recurringContractCallback/index.js',
    '',
    fixture.state
  );

  const result = await withoutErrorLog(() => loaded.fn.main({
    xml: callbackXml(fixture, 'DELETE', fixture.subscription.contractId)
  }));

  assert(result.includes('<return_code><![CDATA[SUCCESS]]>'));
  assert.strictEqual(fixture.state.subscriptions[0].status, 'canceled');
  assert.strictEqual(fixture.state.subscriptions[1].status, 'active');
  assert.strictEqual(fixture.state.users[0].subscriptionId, next._id);
  assert.strictEqual(fixture.state.users[0].subscriptionStatus, 'active');
}

async function testOldContractAddSetsConflictGuardWithoutReplacingNewSubscription() {
  const fixture = subscriptionFixture('callback-old-add', 'canceled');
  const next = {
    _id: 'subscription-new-for-conflict',
    _openid: fixture.subscription._openid,
    userId: fixture.subscription.userId,
    contractCode: 'NEW-CONFLICT-CODE',
    contractId: 'NEW-CONFLICT-ID',
    planId: 'plan-month',
    status: 'active'
  };
  fixture.state.subscriptions.push(next);
  fixture.state.users[0].subscriptionId = next._id;
  fixture.state.users[0].subscriptionStatus = 'active';
  const loaded = loadCloudFunction(
    'cloudfunctions/recurringContractCallback/index.js',
    '',
    fixture.state
  );

  const result = await withoutErrorLog(() => loaded.fn.main({
    xml: callbackXml(fixture, 'ADD', fixture.subscription.contractId)
  }));

  assert(result.includes('<return_code><![CDATA[SUCCESS]]>'));
  assert.strictEqual(fixture.state.subscriptions[0].status, 'active');
  assert.strictEqual(fixture.state.users[0].subscriptionStatus, 'cancel_required');
  assert.strictEqual(fixture.state.users[0].subscriptionId, next._id);
  assert.strictEqual(fixture.state.users[0].conflictingSubscriptionId, fixture.subscription._id);

  const deleted = await withoutErrorLog(() => loaded.fn.main({
    xml: callbackXml(fixture, 'DELETE', fixture.subscription.contractId, '2026-07-11 12:00:01')
  }));
  assert(deleted.includes('<return_code><![CDATA[SUCCESS]]>'));
  assert.strictEqual(fixture.state.subscriptions[0].status, 'canceled');
  assert.strictEqual(fixture.state.users[0].subscriptionStatus, 'active');
  assert.strictEqual(fixture.state.users[0].subscriptionId, next._id);
  assert.strictEqual(fixture.state.users[0].conflictingSubscriptionId, '');
}

async function testCurrentContractCallbacksPreserveAnotherSubscriptionConflictGuard() {
  for (const changeType of ['ADD', 'DELETE']) {
    for (const initialUserStatus of ['cancel_required', 'active']) {
      const suffix = `${changeType.toLowerCase()}-${initialUserStatus}`;
      const fixture = subscriptionFixture(`callback-current-${suffix}-with-conflict`, 'active');
      const conflict = {
        _id: `subscription-conflict-${suffix}`,
        _openid: fixture.subscription._openid,
        userId: fixture.subscription.userId,
        contractCode: `CONFLICT-${suffix}-CODE`,
        contractId: `CONFLICT-${suffix}-ID`,
        planId: 'plan-month',
        status: 'active'
      };
      fixture.state.subscriptions.push(conflict);
      fixture.state.users[0].subscriptionStatus = initialUserStatus;
      fixture.state.users[0].conflictingSubscriptionId = conflict._id;
      const loaded = loadCloudFunction(
        'cloudfunctions/recurringContractCallback/index.js',
        '',
        fixture.state
      );

      const result = await withoutErrorLog(() => loaded.fn.main({
        xml: callbackXml(fixture, changeType, fixture.subscription.contractId)
      }));

      assert(result.includes('<return_code><![CDATA[SUCCESS]]>'), suffix);
      const currentStatus = changeType === 'ADD' ? 'active' : 'canceled';
      assert.strictEqual(fixture.state.subscriptions[0].status, currentStatus, suffix);
      assert.strictEqual(fixture.state.users[0].subscriptionStatus, 'cancel_required', suffix);
      assert.strictEqual(fixture.state.users[0].subscriptionId, fixture.subscription._id, suffix);
      assert.strictEqual(fixture.state.users[0].conflictingSubscriptionId, conflict._id, suffix);

      const conflictFixture = Object.assign({}, fixture, { subscription: conflict });
      const conflictDeleted = await withoutErrorLog(() => loaded.fn.main({
        xml: callbackXml(conflictFixture, 'DELETE', conflict.contractId, '2026-07-11 12:00:01')
      }));
      assert(conflictDeleted.includes('<return_code><![CDATA[SUCCESS]]>'), suffix);
      assert.strictEqual(fixture.state.users[0].subscriptionStatus, currentStatus, suffix);
      assert.strictEqual(fixture.state.users[0].conflictingSubscriptionId, '', suffix);
    }
  }
}

async function testOlderAddAfterVerifiedDeleteIsIdempotentlyIgnored() {
  const fixture = subscriptionFixture('callback-operation-order', 'active');
  const loaded = loadCloudFunction(
    'cloudfunctions/recurringContractCallback/index.js',
    '',
    fixture.state
  );
  const deleted = await loaded.fn.main({
    xml: callbackXml(fixture, 'DELETE', fixture.subscription.contractId, '2026-07-11 12:00:00')
  });
  const updatesAfterDelete = loaded.fakeDb.__operations.updates.length;
  const olderAdd = await loaded.fn.main({
    xml: callbackXml(fixture, 'ADD', fixture.subscription.contractId, '2026-07-11 11:59:59')
  });
  const sameTimeAdd = await loaded.fn.main({
    xml: callbackXml(fixture, 'ADD', fixture.subscription.contractId, '2026-07-11 12:00:00')
  });

  assert(deleted.includes('<return_code><![CDATA[SUCCESS]]>'));
  assert(olderAdd.includes('<return_code><![CDATA[SUCCESS]]>'));
  assert(sameTimeAdd.includes('<return_code><![CDATA[SUCCESS]]>'));
  assert.strictEqual(fixture.state.subscriptions[0].status, 'canceled');
  assert.strictEqual(fixture.state.users[0].subscriptionStatus, 'canceled');
  assert.strictEqual(loaded.fakeDb.__operations.updates.length, updatesAfterDelete);
}

async function testCancelRejectsForeignContractWithoutHttpOrWrites() {
  const caller = stateFor('cancel-caller-openid', 'CancelCallerA');
  const foreign = subscriptionFixture('cancel-victim-openid', 'active');
  caller.state.subscriptions = clone(foreign.state.subscriptions);
  const before = clone(caller.state);
  const { fn, httpsCalls } = loadCloudFunction(
    'cloudfunctions/cancelRecurringContract/index.js',
    caller.auth.binding._openid,
    caller.state
  );

  const result = await fn.main({ contractId: foreign.subscription.contractId });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'SUBSCRIPTION_NOT_OWNED');
  assert.strictEqual(httpsCalls.length, 0);
  assert.deepStrictEqual(caller.state, before);
}

async function testCancelSuccessUpdatesSubscriptionAndDeterministicUserMarker() {
  const fixture = subscriptionFixture('cancel-success-openid', 'active');
  const { fn, httpsCalls } = loadCloudFunction(
    'cloudfunctions/cancelRecurringContract/index.js',
    fixture.auth.binding._openid,
    fixture.state
  );

  const result = await fn.main({ contractId: fixture.subscription.contractId });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(httpsCalls.length, 1);
  assert(httpsCalls[0].timeoutMs > 0);
  assert.strictEqual(fixture.state.subscriptions[0].status, 'canceled');
  assert.strictEqual(fixture.state.users[0].subscriptionStatus, 'canceled');
  assert.strictEqual(fixture.state.users[0].subscriptionId, fixture.subscription._id);
}

async function testCancelPendingContractUsesPlanAndContractCode() {
  const fixture = subscriptionFixture('cancel-pending-openid', 'pending_contract');
  fixture.subscription.contractId = '';
  const { fn, httpsCalls } = loadCloudFunction(
    'cloudfunctions/cancelRecurringContract/index.js',
    fixture.auth.binding._openid,
    fixture.state
  );

  const result = await fn.main({});

  assert.strictEqual(result.ok, true);
  assert.strictEqual(httpsCalls.length, 1);
  assert(httpsCalls[0].body.includes(`<plan_id>${fixture.subscription.planId}</plan_id>`));
  assert(httpsCalls[0].body.includes(`<contract_code>${fixture.subscription.contractCode}</contract_code>`));
  assert.strictEqual(httpsCalls[0].body.includes('<contract_id>'), false);
  assert.strictEqual(fixture.state.subscriptions[0].status, 'canceled');
  assert.strictEqual(fixture.state.subscriptions[0].contractId, 'RETURNED-CONTRACT-ID');
  assert.strictEqual(fixture.state.users[0].subscriptionStatus, 'canceled');
}

async function testCancelDefaultsToConflictingSubscriptionBeforeCurrentSubscription() {
  for (const initialUserStatus of ['cancel_required', 'active']) {
    const fixture = subscriptionFixture(`cancel-conflict-${initialUserStatus}-openid`, 'active');
    fixture.subscription.updatedAt = 1;
    const current = {
      _id: `subscription-current-newer-${initialUserStatus}`,
      _openid: fixture.subscription._openid,
      userId: fixture.subscription.userId,
      contractCode: `CURRENT-${initialUserStatus}-CODE`,
      contractId: `CURRENT-${initialUserStatus}-CONTRACT`,
      planId: 'plan-month',
      status: 'active',
      updatedAt: 2
    };
    fixture.state.subscriptions.push(current);
    fixture.state.users[0].subscriptionId = current._id;
    fixture.state.users[0].subscriptionStatus = initialUserStatus;
    fixture.state.users[0].conflictingSubscriptionId = fixture.subscription._id;
    const loaded = loadCloudFunction(
      'cloudfunctions/cancelRecurringContract/index.js',
      fixture.auth.binding._openid,
      fixture.state
    );

    const result = await loaded.fn.main({});

    assert.strictEqual(result.ok, true, initialUserStatus);
    assert.strictEqual(loaded.httpsCalls.length, 1, initialUserStatus);
    assert(loaded.httpsCalls[0].body.includes(`<contract_id>${fixture.subscription.contractId}</contract_id>`));
    assert.strictEqual(loaded.httpsCalls[0].body.includes(current.contractId), false);
    assert.strictEqual(fixture.state.subscriptions[0].status, 'canceled', initialUserStatus);
    assert.strictEqual(fixture.state.subscriptions[1].status, 'active', initialUserStatus);
    assert.strictEqual(fixture.state.users[0].subscriptionId, current._id, initialUserStatus);
    assert.strictEqual(fixture.state.users[0].subscriptionStatus, 'active', initialUserStatus);
    assert.strictEqual(fixture.state.users[0].conflictingSubscriptionId, '', initialUserStatus);
  }
}

async function testExplicitCurrentCancellationPreservesAnotherSubscriptionConflictGuard() {
  const fixture = subscriptionFixture('cancel-current-with-conflict-openid', 'active');
  const conflict = {
    _id: 'subscription-still-conflicting',
    _openid: fixture.subscription._openid,
    userId: fixture.subscription.userId,
    contractCode: 'STILL-CONFLICTING-CODE',
    contractId: 'STILL-CONFLICTING-ID',
    planId: 'plan-month',
    status: 'active'
  };
  fixture.state.subscriptions.push(conflict);
  fixture.state.users[0].subscriptionStatus = 'active';
  fixture.state.users[0].conflictingSubscriptionId = conflict._id;
  const loaded = loadCloudFunction(
    'cloudfunctions/cancelRecurringContract/index.js',
    fixture.auth.binding._openid,
    fixture.state
  );

  const result = await loaded.fn.main({ contractId: fixture.subscription.contractId });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(fixture.state.subscriptions[0].status, 'canceled');
  assert.strictEqual(fixture.state.subscriptions[1].status, 'active');
  assert.strictEqual(fixture.state.users[0].subscriptionStatus, 'cancel_required');
  assert.strictEqual(fixture.state.users[0].subscriptionId, fixture.subscription._id);
  assert.strictEqual(fixture.state.users[0].conflictingSubscriptionId, conflict._id);

  const conflictResult = await loaded.fn.main({ contractId: conflict.contractId });

  assert.strictEqual(conflictResult.ok, true);
  assert.strictEqual(fixture.state.subscriptions[0].status, 'canceled');
  assert.strictEqual(fixture.state.subscriptions[1].status, 'canceled');
  assert.strictEqual(fixture.state.users[0].subscriptionStatus, 'canceled');
  assert.strictEqual(fixture.state.users[0].subscriptionId, fixture.subscription._id);
  assert.strictEqual(fixture.state.users[0].conflictingSubscriptionId, '');
}

async function testCancelFailureDoesNotClearUserGuard() {
  const fixture = subscriptionFixture('cancel-failure-openid', 'active');
  const { fn } = loadCloudFunction(
    'cloudfunctions/cancelRecurringContract/index.js',
    fixture.auth.binding._openid,
    fixture.state,
    {
      httpsResponse: signedXml({
        return_code: 'SUCCESS',
        result_code: 'FAIL',
        mch_id: process.env.PAP_MCH_ID,
        appid: process.env.PAP_APPID
      })
    }
  );

  const result = await fn.main({ contractId: fixture.subscription.contractId });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(fixture.state.subscriptions[0].status, 'active');
  assert.strictEqual(fixture.state.users[0].subscriptionStatus, 'active');
  assert.strictEqual(fixture.state.users[0].subscriptionId, fixture.subscription._id);
}

async function testCancelRejectsUnsignedOrInvalidSuccessResponse() {
  const valid = signedXml({
    return_code: 'SUCCESS',
    result_code: 'SUCCESS',
    mch_id: process.env.PAP_MCH_ID,
    appid: process.env.PAP_APPID
  });
  const variants = [
    {
      name: 'missing sign',
      response: '<return_code>SUCCESS</return_code><result_code>SUCCESS</result_code>'
    },
    {
      name: 'invalid sign',
      response: valid.replace(/<sign>[^<]+<\/sign>/, '<sign>INVALID</sign>')
    }
  ];
  for (const variant of variants) {
    const fixture = subscriptionFixture(`cancel-response-${variant.name}`, 'active');
    const { fn } = loadCloudFunction(
      'cloudfunctions/cancelRecurringContract/index.js',
      fixture.auth.binding._openid,
      fixture.state,
      { httpsResponse: variant.response }
    );

    const result = await fn.main({ contractId: fixture.subscription.contractId });

    assert.strictEqual(result.ok, false, variant.name);
    assert.strictEqual(fixture.state.subscriptions[0].status, 'active', variant.name);
    assert.strictEqual(fixture.state.users[0].subscriptionStatus, 'active', variant.name);
  }
}

async function testCancelRejectsSignedResponseForDifferentContract() {
  const fixture = subscriptionFixture('cancel-mismatch-openid', 'active');
  const response = signedXml({
    return_code: 'SUCCESS',
    result_code: 'SUCCESS',
    mch_id: process.env.PAP_MCH_ID,
    appid: process.env.PAP_APPID,
    contract_id: 'DIFFERENT-CONTRACT'
  });
  const { fn } = loadCloudFunction(
    'cloudfunctions/cancelRecurringContract/index.js',
    fixture.auth.binding._openid,
    fixture.state,
    { httpsResponse: response }
  );

  const result = await fn.main({ contractId: fixture.subscription.contractId });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(fixture.state.subscriptions[0].status, 'active');
  assert.strictEqual(fixture.state.users[0].subscriptionStatus, 'active');
}

async function testCancelLocalWriteFailureRecoversFromVerifiedDeleteCallback() {
  const fixture = subscriptionFixture('cancel-recovery-openid', 'active');
  const cancelLoaded = loadCloudFunction(
    'cloudfunctions/cancelRecurringContract/index.js',
    fixture.auth.binding._openid,
    fixture.state,
    {
      failTransactionWrite(operation) {
        return operation.collection === 'users' && operation.method === 'update';
      }
    }
  );

  await assert.rejects(
    () => cancelLoaded.fn.main({ contractId: fixture.subscription.contractId }),
    /simulated users update failure/
  );
  assert.strictEqual(cancelLoaded.httpsCalls.length, 1);
  assert.strictEqual(fixture.state.subscriptions[0].status, 'active');
  assert.strictEqual(fixture.state.users[0].subscriptionStatus, 'active');

  const callbackLoaded = loadCloudFunction(
    'cloudfunctions/recurringContractCallback/index.js',
    '',
    fixture.state
  );
  const result = await callbackLoaded.fn.main({
    xml: callbackXml(fixture, 'DELETE', fixture.subscription.contractId)
  });
  assert(result.includes('<return_code><![CDATA[SUCCESS]]>'));
  assert.strictEqual(fixture.state.subscriptions[0].status, 'canceled');
  assert.strictEqual(fixture.state.users[0].subscriptionStatus, 'canceled');
}

const tests = [
  testCreateRecurringContractIsRetiredWithoutWritesOrNetwork,
  testDeleteRereadsSharedUserGuardInsideTransaction,
  testContractCallbackAtomicallyUpdatesSubscriptionAndUserMarker,
  testContractCallbackFailsClosedForInvalidInputAndDatabaseFailure,
  testContractCallbackIsIdempotentAndLateAddRestoresBlockingGuard,
  testDuplicateDeleteAfterUserPurgeAcknowledgesWithoutWrites,
  testOldContractDeleteDoesNotOverwriteNewSubscriptionMarker,
  testOldContractAddSetsConflictGuardWithoutReplacingNewSubscription,
  testCurrentContractCallbacksPreserveAnotherSubscriptionConflictGuard,
  testOlderAddAfterVerifiedDeleteIsIdempotentlyIgnored,
  testCancelRejectsForeignContractWithoutHttpOrWrites,
  testCancelSuccessUpdatesSubscriptionAndDeterministicUserMarker,
  testCancelPendingContractUsesPlanAndContractCode,
  testCancelDefaultsToConflictingSubscriptionBeforeCurrentSubscription,
  testExplicitCurrentCancellationPreservesAnotherSubscriptionConflictGuard,
  testCancelFailureDoesNotClearUserGuard,
  testCancelRejectsUnsignedOrInvalidSuccessResponse,
  testCancelRejectsSignedResponseForDifferentContract,
  testCancelLocalWriteFailureRecoversFromVerifiedDeleteCallback
];

(async () => {
  const restoreEnvironment = setPaymentEnvironment();
  const failures = [];
  try {
    for (const test of tests) {
      try {
        await test();
      } catch (error) {
        failures.push(`${test.name}: ${error.message}`);
      }
    }
  } finally {
    restoreEnvironment();
  }
  if (failures.length) {
    throw new Error(`recurring subscription guard regressions:\n- ${failures.join('\n- ')}`);
  }
  console.log('recurringSubscriptionGuard tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
