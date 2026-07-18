const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const root = path.resolve(__dirname, '..');
const deployedState = require(path.join(root, 'cloudfunctions/createTableOrder/lib/state'));
const EXTERNAL_ORDER_ID = deployedState.orderIdForSession('session-active');

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function bindingId(openid) {
  return crypto.createHash('sha256').update('wechat:' + openid).digest('hex');
}

function identity(openid, roles, status) {
  const userId = bindingId(openid);
  const accountId = 'account_' + openid;
  const account = 'login_' + openid;
  return {
    binding: { _id: userId, _openid: openid, accountId, account },
    account: {
      _id: accountId,
      _openid: openid,
      account,
      status: status || 'active'
    },
    user: {
      _id: userId,
      _openid: openid,
      roles: roles || ['shop'],
      currentRole: (roles && roles[0]) || 'shop'
    }
  };
}

function emptyState(identities) {
  const auth = identities || [];
  return {
    wechat_bindings: auth.map((item) => clone(item.binding)),
    accounts: auth.map((item) => clone(item.account)),
    users: auth.map((item) => clone(item.user)),
    stores: [],
    checkin_requests: [],
    table_checkin_slots: [],
    shop_coach_links: [],
    sessions: [],
    table_occupancies: [],
    shop_orders: [],
    financial_events: [],
    training_sessions: [],
    coach_lessons: [],
    verified_trainings: [],
    payments: [],
    profit_sharing_orders: []
  };
}

function matches(document, query) {
  return Object.keys(query || {}).every((key) => document[key] === query[key]);
}

function isBusinessId(value) {
  return typeof value === 'string'
    && /^[0-9A-Za-z_-]{1,64}$/.test(value)
    && !value.includes('__');
}

function occupancyId(storeId, tableId) {
  return String(storeId.length) + '_' + storeId + '__' + tableId;
}

function checkinSlotId(storeId, tableId, role) {
  return crypto.createHash('sha256')
    .update(`checkin-slot\0${storeId}\0${tableId}\0${role}`)
    .digest('hex');
}

function parseOccupancyId(id) {
  const prefixEnd = id.indexOf('_');
  const lengthText = id.slice(0, prefixEnd);
  if (!/^[1-9][0-9]?$/.test(lengthText)) return null;
  const storeLength = Number(lengthText);
  if (storeLength > 64) return null;
  const storeStart = prefixEnd + 1;
  const storeEnd = storeStart + storeLength;
  if (id.slice(storeEnd, storeEnd + 2) !== '__') return null;
  const storeId = id.slice(storeStart, storeEnd);
  const tableId = id.slice(storeEnd + 2);
  if (!isBusinessId(storeId) || !isBusinessId(tableId)) return null;
  return { storeId, tableId };
}

function assertFakeDocumentId(collection, id) {
  if (typeof id !== 'string' || !id || id.length > 1024 || id.includes('/')) {
    const error = new Error('Invalid document id: ' + id);
    error.code = 'INVALID_DOCUMENT_ID';
    throw error;
  }
  if (collection === 'stores' && !isBusinessId(id)) {
    const error = new Error('Invalid store document id: ' + id);
    error.code = 'INVALID_DOCUMENT_ID';
    throw error;
  }
  if (collection === 'table_occupancies') {
    const parsed = parseOccupancyId(id);
    if (!parsed || occupancyId(parsed.storeId, parsed.tableId) !== id) {
      const error = new Error('Ambiguous table occupancy document id: ' + id);
      error.code = 'INVALID_DOCUMENT_ID';
      throw error;
    }
  }
}

function applyUpdate(document, data) {
  return Object.assign({}, document, clone(data));
}

function replaceState(target, source) {
  Object.keys(target).forEach((key) => {
    if (Array.isArray(target[key])) target[key] = clone(source[key] || []);
  });
  Object.keys(source).forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(target, key)) {
      target[key] = clone(source[key]);
    }
  });
}

function makeDatabase(state, options) {
  const config = options || {};
  let nextId = 1;
  let transactionCount = 0;
  let transactionTail = Promise.resolve();
  let throwOnNotFound = true;
  const operations = { reads: [], writes: [], transactions: [] };

  function shouldFail(operation) {
    return !!(config.failWrite && config.failWrite(clone(operation)));
  }

  function facade(target, inTransaction) {
    function collection(name) {
      if (!Object.prototype.hasOwnProperty.call(target, name)) {
        throw new Error('Unexpected collection: ' + name);
      }
      const documents = target[name];

      function documentRef(id) {
        return {
          async get() {
            operations.reads.push({ collection: name, id, inTransaction });
            const found = documents.find((item) => item._id === id) || null;
            if (!found && throwOnNotFound) {
              const error = new Error(name + '/' + id + ' does not exist');
              error.code = 'DATABASE_DOCUMENT_NOT_FOUND';
              throw error;
            }
            return { data: clone(found) };
          },
          async set(payload) {
            const operation = {
              collection: name,
              method: 'set',
              id,
              data: clone(payload && payload.data),
              inTransaction
            };
            operations.writes.push(operation);
            if (shouldFail(operation)) throw new Error('simulated write failure');
            const next = Object.assign({}, clone(payload.data), { _id: id });
            const index = documents.findIndex((item) => item._id === id);
            if (index === -1) documents.push(next);
            else documents[index] = next;
            return { _id: id };
          },
          async update(payload) {
            const operation = {
              collection: name,
              method: 'update',
              id,
              data: clone(payload && payload.data),
              inTransaction
            };
            operations.writes.push(operation);
            if (shouldFail(operation)) throw new Error('simulated write failure');
            const index = documents.findIndex((item) => item._id === id);
            if (index === -1) throw new Error(name + '/' + id + ' does not exist');
            documents[index] = Object.assign(applyUpdate(documents[index], payload.data), { _id: id });
            return { stats: { updated: 1 } };
          },
          async remove() {
            const operation = { collection: name, method: 'remove', id, inTransaction };
            operations.writes.push(operation);
            if (shouldFail(operation)) throw new Error('simulated write failure');
            const index = documents.findIndex((item) => item._id === id);
            if (index !== -1) documents.splice(index, 1);
            return { stats: { removed: index === -1 ? 0 : 1 } };
          },
          async delete() {
            return this.remove();
          }
        };
      }

      return {
        doc(id) {
          assertFakeDocumentId(name, id);
          return documentRef(id);
        },
        where(query) {
          let maximum = Number.MAX_SAFE_INTEGER;
          const orderings = [];
          const builder = {
            orderBy(field, direction) {
              orderings.push({ field, direction });
              return builder;
            },
            limit(value) { maximum = value; return builder; },
            async get() {
              operations.reads.push({ collection: name, query: clone(query), inTransaction });
              const found = documents.filter((item) => matches(item, query));
              found.sort((left, right) => {
                for (const ordering of orderings) {
                  if (left[ordering.field] === right[ordering.field]) continue;
                  const compared = left[ordering.field] < right[ordering.field] ? -1 : 1;
                  return ordering.direction === 'desc' ? -compared : compared;
                }
                return 0;
              });
              return {
                data: clone(found.slice(0, maximum))
              };
            }
          };
          return builder;
        },
        async add(payload) {
          const id = name + '_' + nextId;
          nextId += 1;
          const operation = {
            collection: name,
            method: 'add',
            id,
            data: clone(payload && payload.data),
            inTransaction
          };
          operations.writes.push(operation);
          if (shouldFail(operation)) throw new Error('simulated write failure');
          documents.push(Object.assign({}, clone(payload.data), { _id: id }));
          return { _id: id };
        }
      };
    }

    return { collection };
  }

  const database = facade(state, false);
  database.serverDate = () => 'SERVER_DATE';
  database.__configure = (settings) => {
    throwOnNotFound = !(settings && settings.throwOnNotFound === false);
  };
  database.runTransaction = (callback) => {
    const execute = async () => {
      transactionCount += 1;
      const working = clone(state);
      const record = { number: transactionCount, committed: false };
      operations.transactions.push(record);
      try {
        const result = await callback(facade(working, true));
        replaceState(state, working);
        record.committed = true;
        return result;
      } catch (error) {
        record.error = error.message;
        throw error;
      }
    };
    const result = transactionTail.then(execute, execute);
    transactionTail = result.then(() => undefined, () => undefined);
    return result;
  };
  database.__operations = operations;
  return database;
}

function makeHarness(state, openid, options) {
  let currentOpenid = openid;
  let databaseCalls = 0;
  const fakeDb = makeDatabase(state, options);
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database(settings) {
      databaseCalls += 1;
      fakeDb.__configure(settings);
      return fakeDb;
    },
    getWXContext() {
      return { OPENID: currentOpenid };
    }
  };

  return {
    fakeDb,
    setOpenid(value) {
      currentOpenid = value;
    },
    databaseCalls() {
      return databaseCalls;
    },
    load(file) {
      const originalLoad = Module._load;
      Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'wx-server-sdk') return fakeCloud;
        return originalLoad.call(this, request, parent, isMain);
      };
      try {
        const modulePath = path.join(root, file);
        delete require.cache[require.resolve(modulePath)];
        return require(modulePath);
      } finally {
        Module._load = originalLoad;
      }
    }
  };
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

function makeStore(owner, tableTypes) {
  return {
    _id: 'store_main',
    _openid: owner,
    name: 'Main Hall',
    address: 'Test Road',
    tableTypes: clone(tableTypes)
  };
}

function normalizedTable(tableId, name, pricePerHourFen) {
  return {
    tableId,
    name,
    pricePerHourFen,
    pricePerHour: pricePerHourFen / 100,
    image: '',
    bgColor: '#067ef9',
    pricingRuleVersion: 'hourly_exact_v1'
  };
}

function pricingSnapshot(table) {
  return {
    tableId: table.tableId,
    name: table.name,
    pricePerHourFen: table.pricePerHourFen,
    pricePerHour: table.pricePerHour,
    pricingRuleVersion: 'hourly_exact_v1',
    minimumDurationMs: 0,
    billingStepMs: 1,
    roundingMode: 'nearest_fen'
  };
}

async function testStoreConfigurationIsOwnedStableAndNormalized() {
  const owner = identity('owner-a');
  const foreign = identity('owner-b');
  const state = emptyState([owner, foreign]);
  state.stores.push(makeStore('owner-a', [
    normalizedTable('keep_table_id', 'Classic', 6000),
    normalizedTable('legacy_match_id', 'Legacy Match', 6600)
  ]));
  const harness = makeHarness(state, 'owner-a');
  const fn = harness.load('cloudfunctions/saveShopStore/index.js');

  const result = await fn.main({
    store: {
      _id: 'store_main',
      name: 'Main Hall',
      tableTypes: [
        { tableId: 'keep_table_id', name: 'Premium', pricePerHour: '88.50', image: 'a.png', bgColor: '#111111' },
        { name: 'Legacy Match', pricePerHour: '66.6', image: '', bgColor: '#222222' },
        { name: 'Brand New', pricePerHour: 72, image: '', bgColor: '#333333' }
      ]
    }
  });

  assert.strictEqual(result.ok, true);
  assert(Array.isArray(result.tableTypes), 'saveShopStore should return normalized tableTypes');
  assert.strictEqual(result.tableTypes.length, 3);
  assert.deepStrictEqual(Object.keys(result.tableTypes[0]), [
    'tableId', 'name', 'pricePerHourFen', 'pricePerHour', 'image', 'bgColor', 'pricingRuleVersion'
  ]);
  assert.deepStrictEqual(result.tableTypes[0], {
    tableId: 'keep_table_id',
    name: 'Premium',
    pricePerHourFen: 8850,
    pricePerHour: 88.5,
    image: 'a.png',
    bgColor: '#111111',
    pricingRuleVersion: 'hourly_exact_v1'
  });
  assert.strictEqual(result.tableTypes[1].tableId, 'legacy_match_id');
  assert.strictEqual(result.tableTypes[1].pricePerHourFen, 6660);
  assert(/^[0-9a-f]{20}$/.test(result.tableTypes[2].tableId));
  assert.strictEqual(new Set(result.tableTypes.map((item) => item.tableId)).size, 3);

  const generatedId = result.tableTypes[2].tableId;
  const repeat = await fn.main({
    store: {
      _id: 'store_main',
      name: 'Main Hall',
      tableTypes: result.tableTypes
    }
  });
  assert.strictEqual(repeat.tableTypes[2].tableId, generatedId);

  const invalidTables = [
    [{ name: '', pricePerHour: 10 }],
    [{ name: 'Zero', pricePerHour: 0 }],
    [{ name: 'Fractional Fen', pricePerHour: '1.234' }],
    [{ tableId: 'b__c', name: 'Ambiguous', pricePerHour: 10 }],
    [{ tableId: 'bad/slash', name: 'Illegal', pricePerHour: 10 }],
    [{ tableId: 'x'.repeat(65), name: 'Oversize', pricePerHour: 10 }],
    [
      { tableId: 'duplicate', name: 'One', pricePerHour: 10 },
      { tableId: 'duplicate', name: 'Two', pricePerHour: 20 }
    ]
  ];
  for (const tableTypes of invalidTables) {
    const before = clone(state.stores);
    const invalid = await fn.main({ store: { _id: 'store_main', name: 'Main Hall', tableTypes } });
    assert.strictEqual(invalid.ok, false);
    assert.strictEqual(invalid.code, 'INVALID_TABLE_CONFIG');
    assert.deepStrictEqual(state.stores, before);
  }

  harness.setOpenid('owner-b');
  const beforeForeign = clone(state.stores);
  const denied = await fn.main({
    store: { _id: 'store_main', name: 'Hijacked', tableTypes: [normalizedTable('x', 'X', 100)] }
  });
  assert.strictEqual(denied.ok, false);
  assert.strictEqual(denied.code, 'STORE_NOT_OWNED');
  assert.deepStrictEqual(state.stores, beforeForeign);

  harness.setOpenid('owner-a');
  const writesBeforeUnknown = harness.fakeDb.__operations.writes.length;
  const unknown = await fn.main({
    store: { _id: 'store_new', name: 'New Hall', tableTypes: [{ name: 'Pool', pricePerHour: 50 }] }
  });
  assert.strictEqual(unknown.ok, false);
  assert.strictEqual(unknown.code, 'STORE_NOT_OWNED');
  assert.strictEqual(harness.fakeDb.__operations.writes.length, writesBeforeUnknown);
  assert.strictEqual(state.stores.some((store) => store._id === 'store_new'), false);

  const created = await fn.main({
    store: { name: 'New Hall', tableTypes: [{ name: 'Pool', pricePerHour: 50 }] }
  });
  assert.strictEqual(created.ok, true);
  assert(isBusinessId(created.storeId));
  assert.notStrictEqual(created.storeId, 'store_new');
  assert.strictEqual(created.tableTypes.length, 1);
  assert.strictEqual(created.tableTypes[0].pricePerHourFen, 5000);
  assert.strictEqual(state.stores.find((store) => store._id === created.storeId)._openid, 'owner-a');
  const createWrites = harness.fakeDb.__operations.writes.slice(writesBeforeUnknown);
  assert.strictEqual(createWrites.filter((write) => write.collection === 'stores' && write.method === 'add').length, 1);
  assert.strictEqual(createWrites.some((write) => write.collection === 'stores' && write.method === 'set'), false);

  harness.setOpenid('owner-b');
  const storesBeforeTakeover = clone(state.stores);
  const writesBeforeTakeover = harness.fakeDb.__operations.writes.length;
  const takeover = await fn.main({
    store: { _id: created.storeId, name: 'Taken Over', tableTypes: created.tableTypes }
  });
  assert.strictEqual(takeover.ok, false);
  assert.strictEqual(takeover.code, 'STORE_NOT_OWNED');
  assert.deepStrictEqual(state.stores, storesBeforeTakeover);
  assert.strictEqual(harness.fakeDb.__operations.writes.length, writesBeforeTakeover);
}

function loadPage(file, dataStub) {
  let definition;
  const originalPage = global.Page;
  const originalLoad = Module._load;
  global.Page = (value) => { definition = value; };
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../../../services/data') return dataStub || {};
    if (request === '../../../utils/themeBehavior') return {};
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const modulePath = path.join(root, file);
    delete require.cache[require.resolve(modulePath)];
    require(modulePath);
    return definition;
  } finally {
    Module._load = originalLoad;
    global.Page = originalPage;
  }
}

function pageInstance(definition, data) {
  return {
    data: Object.assign({}, clone(definition.data), clone(data)),
    setData(update) {
      Object.assign(this.data, clone(update));
    }
  };
}

async function testTableEditorsRetainExistingIds() {
  const existing = normalizedTable('stable_edit_id', 'Old Name', 5500);
  const tablePage = loadPage('miniprogram/pages/shop/table-types/index.js', {});
  const tableInstance = pageInstance(tablePage, {
    tableTypes: [existing],
    editingIdx: 0,
    formName: 'Renamed',
    formPrice: '60',
    formImage: 'new.png',
    formBgColor: '#123456'
  });
  tablePage.addOrUpdateType.call(tableInstance);
  assert.strictEqual(tableInstance.data.tableTypes[0].tableId, 'stable_edit_id');

  const brandPage = loadPage('miniprogram/pages/shop/brand-add/index.js', {});
  const brandInstance = pageInstance(brandPage, {
    tableTypes: [existing],
    editingIdx: 0,
    formName: 'Renamed Again',
    formPrice: '61',
    formImage: 'again.png',
    formBgColor: '#654321'
  });
  brandPage.addOrUpdateType.call(brandInstance);
  assert.strictEqual(brandInstance.data.tableTypes[0].tableId, 'stable_edit_id');

  const calls = {};
  const submitPage = loadPage('miniprogram/pages/shop/brand-add/index.js', {
    saveShopBrand(payload) {
      calls.brand = clone(payload);
      return Promise.resolve({ ok: true });
    },
    saveShopStore(payload) {
      calls.store = clone(payload);
      return Promise.resolve({ ok: true, storeId: 'server_store_1', tableTypes: [existing] });
    },
    saveShopProfile(payload) {
      calls.profile = clone(payload);
      return Promise.resolve({ ok: true });
    }
  });
  const submitInstance = pageInstance(submitPage, {
    brandName: 'Server ID Brand',
    brandLogo: '',
    storeName: 'Server ID Store',
    storeAddress: 'Test Road',
    storeLat: 0,
    storeLng: 0,
    checkinEnabled: true,
    tableTypes: [existing],
    submitting: false
  });
  const originalWx = global.wx;
  const originalSetTimeout = global.setTimeout;
  global.wx = { showToast() {}, navigateBack() {} };
  global.setTimeout = (callback) => {
    callback();
    return 1;
  };
  try {
    submitPage.submit.call(submitInstance);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    global.wx = originalWx;
    global.setTimeout = originalSetTimeout;
  }
  assert.strictEqual(Object.prototype.hasOwnProperty.call(calls.store, '_id'), false);
  assert.strictEqual(calls.profile.storeId, 'server_store_1');
}

function sessionFixture() {
  const owner = identity('owner-a');
  const foreign = identity('owner-b');
  const member = identity('member-only', ['member']);
  const state = emptyState([owner, foreign, member]);
  const table = normalizedTable('table-a', 'Pool Table', 12345);
  const secondTable = normalizedTable('table-b', 'Snooker Table', 8000);
  state.stores.push(makeStore('owner-a', [table, secondTable]));
  return { state, table, owner, foreign, member };
}

async function testSessionAuthorizationSnapshotConcurrencyAndRollback() {
  const fixture = sessionFixture();
  const harness = makeHarness(fixture.state, 'unbound');
  const fn = harness.load('cloudfunctions/createSession/index.js');
  assert.throws(
    () => harness.fakeDb.collection('table_occupancies').doc('a__b__c'),
    (error) => error && error.code === 'INVALID_DOCUMENT_ID'
  );
  assert.throws(
    () => harness.fakeDb.collection('stores').doc('bad/slash'),
    (error) => error && error.code === 'INVALID_DOCUMENT_ID'
  );
  assert.notStrictEqual(occupancyId('a_', 'b'), occupancyId('a', '_b'));
  assert.doesNotThrow(() => (
    harness.fakeDb.collection('table_occupancies').doc(occupancyId('a_', 'b'))
  ));
  assert.doesNotThrow(() => (
    harness.fakeDb.collection('table_occupancies').doc(occupancyId('a', '_b'))
  ));

  const unbound = await fn.main({ storeId: 'store_main', tableId: 'table-a' });
  assert.strictEqual(unbound.code, 'ACCOUNT_NOT_BOUND');
  harness.setOpenid('member-only');
  const nonShop = await fn.main({ storeId: 'store_main', tableId: 'table-a' });
  assert.strictEqual(nonShop.code, 'SHOP_ROLE_REQUIRED');
  harness.setOpenid('owner-b');
  const foreign = await fn.main({ storeId: 'store_main', tableId: 'table-a' });
  assert.strictEqual(foreign.code, 'STORE_NOT_OWNED');

  harness.setOpenid('owner-a');
  const invalidIdentifiers = [
    { storeId: 'a', tableId: 'b__c' },
    { storeId: 'a__b', tableId: 'c' },
    { storeId: 'bad/slash', tableId: 'table-a' },
    { storeId: 'store_main', tableId: 'x'.repeat(65) }
  ];
  for (const input of invalidIdentifiers) {
    const before = clone(fixture.state);
    const writesBefore = harness.fakeDb.__operations.writes.length;
    const invalidIdentifier = await fn.main(input);
    assert.strictEqual(invalidIdentifier.ok, false);
    assert.strictEqual(invalidIdentifier.code, 'INVALID_INPUT');
    assert.deepStrictEqual(fixture.state, before);
    assert.strictEqual(harness.fakeDb.__operations.writes.length, writesBefore);
  }

  const pricedByClient = await fn.main({
    storeId: 'store_main', tableId: 'table-a', pricePerHourFen: 1
  });
  assert.strictEqual(pricedByClient.code, 'INVALID_INPUT');
  assert.strictEqual(fixture.state.sessions.length, 0);

  const missingCheckinId = await fn.main({
    storeId: 'store_main',
    tableId: 'table-a',
    memberOpenid: 'member-x'
  });
  assert.strictEqual(missingCheckinId.code, 'MEMBER_CHECKIN_REQUIRED');
  assert.strictEqual(fixture.state.sessions.length, 0);

  fixture.state.checkin_requests.push({
    _id: 'checkin-current',
    slotId: checkinSlotId('store_main', 'table-a', 'member'),
    memberOpenid: 'member-x',
    storeId: 'store_main',
    tableId: 'table-a',
    role: 'member',
    ready: true,
    joinedAt: 998000,
    readyAt: 999000,
    status: 'pending'
  }, {
    _id: 'coach-checkin-current',
    slotId: checkinSlotId('store_main', 'table-a', 'coach'),
    memberOpenid: 'coach-x',
    storeId: 'store_main',
    tableId: 'table-a',
    role: 'coach',
    ready: true,
    joinedAt: 998500,
    readyAt: 999500,
    status: 'pending'
  });
  fixture.state.table_checkin_slots.push({
    _id: checkinSlotId('store_main', 'table-a', 'member'),
    schemaVersion: 1,
    storeId: 'store_main',
    tableId: 'table-a',
    role: 'member',
    currentRequestId: 'checkin-current',
    memberOpenid: 'member-x',
    status: 'pending',
    sessionId: '',
    boundAt: null
  }, {
    _id: checkinSlotId('store_main', 'table-a', 'coach'),
    schemaVersion: 1,
    storeId: 'store_main',
    tableId: 'table-a',
    role: 'coach',
    currentRequestId: 'coach-checkin-current',
    memberOpenid: 'coach-x',
    status: 'pending',
    sessionId: '',
    boundAt: null
  });
  fixture.state.shop_coach_links.push({
    _id: 'coach-link-current',
    shopOpenid: 'owner-a',
    coachOpenid: 'coach-x',
    storeId: 'store_main',
    status: 'active'
  });

  const opened = await atTime(1000000, () => fn.main({
    storeId: 'store_main',
    tableId: 'table-a',
    memberOpenid: 'member-x',
    memberCheckinId: 'checkin-current',
    coachOpenid: 'coach-x',
    coachCheckinId: 'coach-checkin-current',
    coachLinkId: 'coach-link-current',
    verified: true
  }));
  assert.strictEqual(opened.ok, true);
  const session = fixture.state.sessions.find((item) => item._id === opened.sessionId);
  assert.deepStrictEqual(session, {
    schemaVersion: 2,
    _openid: 'owner-a',
    shopId: 'owner-a',
    storeId: 'store_main',
    tableId: 'table-a',
    pricingSnapshot: pricingSnapshot(fixture.table),
    status: 'active',
    startedAt: 1000000,
    checkoutAt: null,
    closedAt: null,
    orderId: '',
    openedBy: 'owner-a',
    checkoutBy: '',
    memberOpenid: 'member-x',
    memberCheckinId: 'checkin-current',
    memberCheckinJoinedAt: 998000,
    memberReadyAt: 999000,
    coachOpenid: 'coach-x',
    coachCheckinId: 'coach-checkin-current',
    coachCheckinJoinedAt: 998500,
    coachReadyAt: 999500,
    coachLinkId: 'coach-link-current',
    coachJoinedAt: 1000000,
    verified: true,
    createdAt: 'SERVER_DATE',
    updatedAt: 'SERVER_DATE',
    _id: opened.sessionId
  });
  assert.deepStrictEqual(fixture.state.table_occupancies[0], {
    _id: occupancyId('store_main', 'table-a'),
    shopId: 'owner-a',
    storeId: 'store_main',
    tableId: 'table-a',
    sessionId: opened.sessionId,
    status: 'active',
    createdAt: 'SERVER_DATE',
    updatedAt: 'SERVER_DATE'
  });
  assert.deepStrictEqual(fixture.state.checkin_requests[0], {
    _id: 'checkin-current',
    slotId: checkinSlotId('store_main', 'table-a', 'member'),
    memberOpenid: 'member-x',
    storeId: 'store_main',
    tableId: 'table-a',
    role: 'member',
    ready: true,
    joinedAt: 998000,
    readyAt: 999000,
    status: 'confirmed',
    sessionId: opened.sessionId,
    boundAt: 1000000,
    resolvedAt: 1000000
  });
  assert.deepStrictEqual(fixture.state.checkin_requests[1], {
    _id: 'coach-checkin-current',
    slotId: checkinSlotId('store_main', 'table-a', 'coach'),
    memberOpenid: 'coach-x',
    storeId: 'store_main',
    tableId: 'table-a',
    role: 'coach',
    ready: true,
    joinedAt: 998500,
    readyAt: 999500,
    status: 'confirmed',
    sessionId: opened.sessionId,
    boundAt: 1000000,
    resolvedAt: 1000000
  });
  assert.deepStrictEqual(
    fixture.state.table_checkin_slots.map((slot) => ({
      id: slot._id,
      status: slot.status,
      sessionId: slot.sessionId,
      boundAt: slot.boundAt
    })),
    [
      {
        id: checkinSlotId('store_main', 'table-a', 'member'),
        status: 'confirmed',
        sessionId: opened.sessionId,
        boundAt: 1000000
      },
      {
        id: checkinSlotId('store_main', 'table-a', 'coach'),
        status: 'confirmed',
        sessionId: opened.sessionId,
        boundAt: 1000000
      }
    ]
  );

  const occupied = await fn.main({ storeId: 'store_main', tableId: 'table-a' });
  assert.strictEqual(occupied.ok, false);
  assert.strictEqual(occupied.code, 'TABLE_OCCUPIED');
  assert.strictEqual(fixture.state.sessions.length, 1);
  assert(harness.fakeDb.__operations.writes.every((item) => item.inTransaction));

  const concurrentFixture = sessionFixture();
  const concurrentHarness = makeHarness(concurrentFixture.state, 'owner-a');
  const concurrentFn = concurrentHarness.load('cloudfunctions/createSession/index.js');
  const concurrent = await atTime(2000000, () => Promise.all([
    concurrentFn.main({ storeId: 'store_main', tableId: 'table-a' }),
    concurrentFn.main({ storeId: 'store_main', tableId: 'table-a' })
  ]));
  assert.strictEqual(concurrent.filter((item) => item.ok).length, 1);
  assert.strictEqual(concurrent.filter((item) => item.code === 'TABLE_OCCUPIED').length, 1);
  assert.strictEqual(concurrentFixture.state.sessions.length, 1);
  assert.strictEqual(concurrentFixture.state.table_occupancies.length, 1);

  for (const mutate of [
    (checkin) => { checkin.status = 'confirmed'; },
    (checkin) => { checkin.readyAt = 199999; },
    (checkin) => { checkin.storeId = 'other-store'; },
    (checkin) => { checkin.tableId = 'table-b'; },
    (checkin) => { checkin.memberOpenid = 'other-member'; },
    (checkin) => { checkin.sessionId = 'historical-session'; }
  ]) {
    const invalidFixture = sessionFixture();
    const checkin = {
      _id: 'checkin-current',
      memberOpenid: 'member-x',
      storeId: 'store_main',
      tableId: 'table-a',
      role: 'member',
      ready: true,
      joinedAt: 1999000,
      readyAt: 1999000,
      status: 'pending'
    };
    mutate(checkin);
    invalidFixture.state.checkin_requests.push(checkin);
    const invalidHarness = makeHarness(invalidFixture.state, 'owner-a');
    const invalidFn = invalidHarness.load('cloudfunctions/createSession/index.js');
    const before = clone(invalidFixture.state);
    const result = await atTime(2000000, () => invalidFn.main({
      storeId: 'store_main',
      tableId: 'table-a',
      memberOpenid: 'member-x',
      memberCheckinId: 'checkin-current'
    }));
    assert.strictEqual(result.code, 'MEMBER_CHECKIN_INVALID');
    assert.deepStrictEqual(invalidFixture.state, before);
  }

  const missingCoachLink = await fn.main({
    storeId: 'store_main',
    tableId: 'table-b',
    coachOpenid: 'coach-x'
  });
  assert.strictEqual(missingCoachLink.code, 'COACH_LINK_REQUIRED');

  const missingCoachCheckin = await fn.main({
    storeId: 'store_main',
    tableId: 'table-b',
    coachOpenid: 'coach-x',
    coachLinkId: 'coach-link-current'
  });
  assert.strictEqual(missingCoachCheckin.code, 'COACH_CHECKIN_REQUIRED');

  const collisionState = emptyState([fixture.owner]);
  collisionState.stores.push(
    {
      _id: 'a_',
      _openid: 'owner-a',
      name: 'Boundary Left',
      tableTypes: [normalizedTable('b', 'Left Table', 5000)]
    },
    {
      _id: 'a',
      _openid: 'owner-a',
      name: 'Boundary Right',
      tableTypes: [normalizedTable('_b', 'Right Table', 5000)]
    }
  );
  const collisionHarness = makeHarness(collisionState, 'owner-a');
  const collisionFn = collisionHarness.load('cloudfunctions/createSession/index.js');
  const left = await collisionFn.main({ storeId: 'a_', tableId: 'b' });
  const right = await collisionFn.main({ storeId: 'a', tableId: '_b' });
  assert.strictEqual(left.ok, true);
  assert.strictEqual(right.ok, true);
  assert.deepStrictEqual(
    collisionState.table_occupancies.map((item) => item._id).sort(),
    [occupancyId('a_', 'b'), occupancyId('a', '_b')].sort()
  );

  for (const failedCollection of ['sessions', 'table_occupancies']) {
    const rollbackFixture = sessionFixture();
    const before = clone(rollbackFixture.state);
    const rollbackHarness = makeHarness(rollbackFixture.state, 'owner-a', {
      failWrite(operation) {
        return operation.inTransaction && operation.collection === failedCollection;
      }
    });
    const rollbackFn = rollbackHarness.load('cloudfunctions/createSession/index.js');
    const failed = await rollbackFn.main({ storeId: 'store_main', tableId: 'table-a' });
    assert.strictEqual(failed.ok, false);
    assert.deepStrictEqual(rollbackFixture.state, before);
    assert.strictEqual(rollbackHarness.fakeDb.__operations.transactions[0].committed, false);
  }

  const checkinRollbackFixture = sessionFixture();
  checkinRollbackFixture.state.checkin_requests.push({
    _id: 'checkin-current',
    slotId: checkinSlotId('store_main', 'table-a', 'member'),
    memberOpenid: 'member-x',
    storeId: 'store_main',
    tableId: 'table-a',
    role: 'member',
    ready: true,
    joinedAt: 999000,
    readyAt: 999000,
    status: 'pending'
  });
  checkinRollbackFixture.state.table_checkin_slots.push({
    _id: checkinSlotId('store_main', 'table-a', 'member'),
    schemaVersion: 1,
    storeId: 'store_main',
    tableId: 'table-a',
    role: 'member',
    currentRequestId: 'checkin-current',
    memberOpenid: 'member-x',
    status: 'pending',
    sessionId: '',
    boundAt: null
  });
  const checkinRollbackBefore = clone(checkinRollbackFixture.state);
  const checkinRollbackHarness = makeHarness(checkinRollbackFixture.state, 'owner-a', {
    failWrite(operation) {
      return operation.inTransaction && operation.collection === 'checkin_requests';
    }
  });
  const checkinRollbackFn = checkinRollbackHarness.load('cloudfunctions/createSession/index.js');
  const checkinRollback = await atTime(1000000, () => checkinRollbackFn.main({
    storeId: 'store_main',
    tableId: 'table-a',
    memberOpenid: 'member-x',
    memberCheckinId: 'checkin-current'
  }));
  assert.strictEqual(checkinRollback.ok, false);
  assert.deepStrictEqual(checkinRollbackFixture.state, checkinRollbackBefore);
}

async function testCheckinQueueIsOwnerScopedAndTerminal() {
  const fixture = sessionFixture();
  fixture.state.stores.push({
    _id: 'foreign_store',
    _openid: 'owner-b',
    name: 'Foreign Hall',
    tableTypes: []
  });
  fixture.state.checkin_requests.push(
    {
      _id: 'checkin-pending',
      slotId: checkinSlotId('store_main', 'table-a', 'member'),
      memberOpenid: 'member-a',
      storeId: 'store_main',
      tableId: 'table-a',
      role: 'member',
      ready: true,
      joinedAt: 999000,
      readyAt: 999000,
      status: 'pending',
      createdAt: 999000
    },
    {
      _id: 'checkin-confirmed',
      memberOpenid: 'member-b',
      storeId: 'store_main',
      tableId: 'table-a',
      role: 'member',
      ready: true,
      joinedAt: 998000,
      readyAt: 998000,
      status: 'confirmed',
      sessionId: 'session-existing',
      boundAt: 999000,
      resolvedAt: 999000,
      createdAt: 998000
    },
    {
      _id: 'checkin-bound-pending',
      memberOpenid: 'member-c',
      storeId: 'store_main',
      tableId: 'table-a',
      role: 'member',
      ready: true,
      joinedAt: 997000,
      readyAt: 997000,
      status: 'pending',
      sessionId: 'session-existing',
      boundAt: 999000,
      createdAt: 997000
    },
    {
      _id: 'checkin-foreign',
      memberOpenid: 'member-d',
      storeId: 'foreign_store',
      tableId: 'table-z',
      role: 'member',
      ready: true,
      joinedAt: 996000,
      readyAt: 996000,
      status: 'pending',
      createdAt: 996000
    }
  );
  fixture.state.table_checkin_slots.push({
    _id: checkinSlotId('store_main', 'table-a', 'member'),
    schemaVersion: 1,
    storeId: 'store_main',
    tableId: 'table-a',
    role: 'member',
    currentRequestId: 'checkin-pending',
    memberOpenid: 'member-a',
    status: 'pending',
    sessionId: '',
    boundAt: null
  });
  const harness = makeHarness(fixture.state, 'owner-a');
  const getPending = harness.load('cloudfunctions/getPendingCheckins/index.js');
  const resolve = harness.load('cloudfunctions/resolveCheckin/index.js');

  const own = await getPending.main({ storeId: 'store_main' });
  assert.strictEqual(own.ok, true);
  assert.deepStrictEqual(
    own.requests.map((item) => item._id),
    ['checkin-pending']
  );

  const readsBeforeForeign = harness.fakeDb.__operations.reads.length;
  const foreign = await getPending.main({ storeId: 'foreign_store' });
  assert.strictEqual(foreign.code, 'STORE_NOT_OWNED');
  assert.strictEqual(
    harness.fakeDb.__operations.reads.slice(readsBeforeForeign)
      .filter((item) => item.collection === 'checkin_requests').length,
    0
  );

  harness.setOpenid('member-only');
  assert.strictEqual(
    (await getPending.main({ storeId: 'store_main' })).code,
    'SHOP_ROLE_REQUIRED'
  );
  harness.setOpenid('unbound');
  assert.strictEqual(
    (await getPending.main({ storeId: 'store_main' })).code,
    'ACCOUNT_NOT_BOUND'
  );
  harness.setOpenid('owner-a');

  const pendingBeforeConfirm = clone(fixture.state.checkin_requests.find(
    (item) => item._id === 'checkin-pending'
  ));
  const slotBeforeConfirm = clone(fixture.state.table_checkin_slots[0]);
  const writesBeforeConfirm = harness.fakeDb.__operations.writes.length;
  const retiredConfirm = await resolve.main({
    requestId: 'checkin-pending',
    action: 'confirm'
  });
  assert.strictEqual(retiredConfirm.ok, false);
  assert.strictEqual(retiredConfirm.code, 'PRODUCT_RETIRED');
  assert.deepStrictEqual(
    fixture.state.checkin_requests.find((item) => item._id === 'checkin-pending'),
    pendingBeforeConfirm
  );
  assert.deepStrictEqual(fixture.state.table_checkin_slots[0], slotBeforeConfirm);
  assert.strictEqual(harness.fakeDb.__operations.writes.length, writesBeforeConfirm);

  const writesBeforeInvalid = harness.fakeDb.__operations.writes.length;
  assert.strictEqual(
    (await resolve.main({ requestId: 'checkin-pending', action: 'approve' })).code,
    'INVALID_INPUT'
  );
  assert.strictEqual(harness.fakeDb.__operations.writes.length, writesBeforeInvalid);

  const rejected = await atTime(1000000, () => resolve.main({
    requestId: 'checkin-pending',
    action: 'reject'
  }));
  assert.deepStrictEqual(rejected, { ok: true, status: 'rejected' });
  const rejectedRecord = fixture.state.checkin_requests.find(
    (item) => item._id === 'checkin-pending'
  );
  assert.strictEqual(rejectedRecord.status, 'rejected');
  assert.strictEqual(rejectedRecord.resolvedAt, 1000000);
  assert.strictEqual(fixture.state.table_checkin_slots[0].status, 'rejected');

  const rejectedSnapshot = clone(rejectedRecord);
  const terminalRewrite = await resolve.main({
    requestId: 'checkin-pending',
    action: 'confirm'
  });
  assert.strictEqual(terminalRewrite.code, 'PRODUCT_RETIRED');
  assert.deepStrictEqual(rejectedRecord, rejectedSnapshot);

  const confirmedBefore = clone(fixture.state.checkin_requests.find(
    (item) => item._id === 'checkin-confirmed'
  ));
  const confirmedRewrite = await resolve.main({
    requestId: 'checkin-confirmed',
    action: 'reject'
  });
  assert.strictEqual(confirmedRewrite.code, 'CHECKIN_NOT_PENDING');
  assert.deepStrictEqual(
    fixture.state.checkin_requests.find((item) => item._id === 'checkin-confirmed'),
    confirmedBefore
  );

  const boundBefore = clone(fixture.state.checkin_requests.find(
    (item) => item._id === 'checkin-bound-pending'
  ));
  const boundRewrite = await resolve.main({
    requestId: 'checkin-bound-pending',
    action: 'reject'
  });
  assert.strictEqual(boundRewrite.code, 'CHECKIN_ALREADY_BOUND');
  assert.deepStrictEqual(
    fixture.state.checkin_requests.find((item) => item._id === 'checkin-bound-pending'),
    boundBefore
  );

  const foreignBefore = clone(fixture.state.checkin_requests.find(
    (item) => item._id === 'checkin-foreign'
  ));
  const foreignRewrite = await resolve.main({
    requestId: 'checkin-foreign',
    action: 'reject'
  });
  assert.strictEqual(foreignRewrite.code, 'STORE_NOT_OWNED');
  assert.deepStrictEqual(
    fixture.state.checkin_requests.find((item) => item._id === 'checkin-foreign'),
    foreignBefore
  );
  assert(
    harness.fakeDb.__operations.writes
      .filter((item) => item.collection === 'checkin_requests')
      .every((item) => item.inTransaction)
  );
}

async function testVersionTwoSessionReadsAreOwnerScoped() {
  const owner = identity('owner-a');
  const foreign = identity('owner-b');
  const member = identity('member-only', ['member']);
  const state = emptyState([owner, foreign, member]);
  state.sessions.push(
    { _id: 'legacy-own', _openid: 'owner-a', status: 'closed' },
    { _id: 'v2-own', schemaVersion: 2, _openid: 'owner-a', shopId: 'owner-a', status: 'active' },
    { _id: 'v2-forged', schemaVersion: 2, _openid: 'owner-a', shopId: 'owner-b', status: 'active' },
    { _id: 'v2-foreign', schemaVersion: 2, _openid: 'owner-b', shopId: 'owner-b', status: 'active' }
  );
  const harness = makeHarness(state, 'owner-a');
  const fn = harness.load('cloudfunctions/getSessions/index.js');
  const result = await fn.main({});
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.sessions.map((item) => item._id), ['legacy-own', 'v2-own']);

  harness.setOpenid('member-only');
  const denied = await fn.main({});
  assert.strictEqual(denied.code, 'SHOP_ROLE_REQUIRED');
}

function activeOrderFixture() {
  const fixture = sessionFixture();
  const session = {
    _id: 'session-active',
    schemaVersion: 2,
    _openid: 'owner-a',
    shopId: 'owner-a',
    storeId: 'store_main',
    tableId: 'table-a',
    pricingSnapshot: pricingSnapshot(fixture.table),
    status: 'active',
    startedAt: 1000,
    checkoutAt: null,
    closedAt: null,
    orderId: '',
    openedBy: 'owner-a',
    checkoutBy: '',
    createdAt: 'SERVER_DATE',
    updatedAt: 'SERVER_DATE'
  };
  fixture.state.sessions.push(session);
  fixture.state.table_occupancies.push({
    _id: occupancyId('store_main', 'table-a'),
    shopId: 'owner-a',
    storeId: 'store_main',
    tableId: 'table-a',
    sessionId: session._id,
    status: 'active'
  });
  return fixture;
}

function assertRequiredOrder(order, expected) {
  assert.strictEqual(order.schemaVersion, 2);
  assert.strictEqual(order._openid, 'owner-a');
  assert.strictEqual(order.shopId, 'owner-a');
  assert.strictEqual(order.storeId, 'store_main');
  assert.strictEqual(order.tableId, 'table-a');
  assert.strictEqual(order.sessionId, 'session-active');
  assert.strictEqual(order.payerOpenid, '');
  assert.strictEqual(order.tableName, 'Pool Table');
  assert.strictEqual(order.startedAt, 1000);
  assert.strictEqual(order.checkoutAt, expected.checkoutAt);
  assert.strictEqual(order.actualDurationMs, expected.elapsedMs);
  assert.strictEqual(order.billedDurationMs, expected.elapsedMs);
  assert.strictEqual(order.tableGrossFen, expected.grossFen);
  assert.strictEqual(order.tableDiscountFen, 0);
  assert.strictEqual(order.quotedTableFeeFen, expected.grossFen);
  assert.strictEqual(order.paidTableFeeFen, expected.grossFen);
  assert(/^[0-9a-f]{64}$/.test(order.checkoutTokenHash));
  assert.strictEqual(order.billingMode, 'table_commission');
  assert.strictEqual(order.commissionRateBps, 500);
  assert.strictEqual(order.includesChannelFee, true);
  assert.strictEqual(order.policyVersion, 'table_commission_v1');
  assert.strictEqual(order.splitCycle, 'T_PLUS_1');
  assert.strictEqual(order.totalCostFen, expected.costFen);
  assert.strictEqual(order.channelFeeFen, null);
  assert.strictEqual(order.platformNetFen, null);
  assert.strictEqual(order.shopNetFen, expected.grossFen - expected.costFen);
  assert.strictEqual(order.wechatTransactionId, '');
  assert.strictEqual(order.paidAt, null);
  assert.strictEqual(order.splitStatus, 'pending');
  assert.strictEqual(order.splitCompletedAt, null);
  assert.strictEqual(order.refundedTableFeeFen, 0);
  assert.strictEqual(order.reversedTotalCostFen, 0);
  assert.strictEqual(order.orderStatus, 'awaiting_payment');
  assert.strictEqual(order.paymentStatus, 'unpaid');
  assert.strictEqual(order.createdAt, 'SERVER_DATE');
  assert.strictEqual(order.updatedAt, 'SERVER_DATE');
  assert(/^[0-9A-Za-z_@*-]+$/.test(order.orderId));
  assert(order.orderId.length <= 32);
  assert(order.outTradeNo.length <= 32);
  assert(order.splitNo.length <= 64);
}

async function testCheckoutIsTrustedAtomicAndIdempotent() {
  const fixture = activeOrderFixture();
  const harness = makeHarness(fixture.state, 'owner-a');
  const fn = harness.load('cloudfunctions/createTableOrder/index.js');
  const initial = clone(fixture.state);

  for (const event of [
    {},
    { sessionId: 'session-active', amount: 1 },
    { sessionId: 'session-active', durationMin: 1 },
    { sessionId: 'session-active', storeId: 'store_main' },
    { sessionId: 'session-active', pricePerHourFen: 1 }
  ]) {
    const retired = await fn.main(event);
    assert.strictEqual(retired.ok, false);
    assert.strictEqual(retired.code, 'VERSION_RETIRED');
    assert.deepStrictEqual(fixture.state, initial);
  }
  const unknown = await fn.main({ sessionId: 'session-active', checkoutAt: 1 });
  assert.strictEqual(unknown.code, 'INVALID_INPUT');
  assert.deepStrictEqual(fixture.state, initial);

  const invalidSessionIdentifiers = [
    (session) => { session.storeId = 'a__b'; session.tableId = 'c'; },
    (session) => { session.storeId = 'a'; session.tableId = 'b__c'; },
    (session) => { session.storeId = 'bad/slash'; },
    (session) => { session.tableId = 'x'.repeat(65); }
  ];
  for (const corruptIdentifiers of invalidSessionIdentifiers) {
    const invalidFixture = activeOrderFixture();
    corruptIdentifiers(invalidFixture.state.sessions[0]);
    const before = clone(invalidFixture.state);
    const invalidHarness = makeHarness(invalidFixture.state, 'owner-a');
    const invalidFn = invalidHarness.load('cloudfunctions/createTableOrder/index.js');
    const invalidResult = await invalidFn.main({ sessionId: 'session-active' });
    assert.strictEqual(invalidResult.ok, false);
    assert.strictEqual(invalidResult.code, 'SESSION_SNAPSHOT_INVALID');
    assert.deepStrictEqual(invalidFixture.state, before);
    assert.strictEqual(invalidHarness.fakeDb.__operations.writes.length, 0);
  }

  const invalidActiveSessionStates = [
    (session) => { session.checkoutAt = 1000; },
    (session) => { session.closedAt = 1000; },
    (session) => { session.orderId = 'stale_order'; },
    (session) => { session.checkoutBy = 'owner-a'; }
  ];
  for (const corruptInitialState of invalidActiveSessionStates) {
    const invalidFixture = activeOrderFixture();
    corruptInitialState(invalidFixture.state.sessions[0]);
    const before = clone(invalidFixture.state);
    const invalidHarness = makeHarness(invalidFixture.state, 'owner-a');
    const invalidFn = invalidHarness.load('cloudfunctions/createTableOrder/index.js');
    const invalidResult = await atTime(3601123, () => (
      invalidFn.main({ sessionId: 'session-active' })
    ));
    assert.strictEqual(invalidResult.ok, false);
    assert.strictEqual(invalidResult.code, 'SESSION_STATE_INVALID');
    assert.deepStrictEqual(invalidFixture.state, before);
    assert.strictEqual(invalidHarness.fakeDb.__operations.writes.length, 0);
  }

  const guardVariants = [
    (state) => { state.table_occupancies = []; },
    (state) => { state.table_occupancies[0].sessionId = 'different-session'; }
  ];
  for (const changeGuard of guardVariants) {
    const guarded = activeOrderFixture();
    changeGuard(guarded.state);
    const before = clone(guarded.state);
    const guardedHarness = makeHarness(guarded.state, 'owner-a');
    const guardedFn = guardedHarness.load('cloudfunctions/createTableOrder/index.js');
    const denied = await guardedFn.main({ sessionId: 'session-active' });
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.code, 'OCCUPANCY_MISMATCH');
    assert.deepStrictEqual(guarded.state, before);
  }

  const checkoutAt = 3601123;
  const elapsedMs = checkoutAt - 1000;
  const grossFen = Math.round(elapsedMs * fixture.table.pricePerHourFen / 3600000);
  const costFen = Math.round(grossFen * 500 / 10000);
  const result = await atTime(checkoutAt, () => fn.main({ sessionId: 'session-active' }));
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.quote, {
    orderId: result.quote.orderId,
    sessionId: 'session-active',
    paidTableFeeFen: grossFen,
    quotedTableFeeFen: grossFen,
    tableGrossFen: grossFen,
    tableDiscountFen: 0,
    actualDurationMs: elapsedMs,
    pricePerHourFen: 12345,
    orderStatus: 'awaiting_payment',
    paymentStatus: 'unpaid',
    splitStatus: 'pending'
  });
  const order = fixture.state.shop_orders[0];
  assert(/^[A-Za-z0-9_-]{22}$/.test(result.checkoutToken));
  assert(!JSON.stringify(order).includes(result.checkoutToken));
  assertRequiredOrder(order, { checkoutAt, elapsedMs, grossFen, costFen });
  assert.deepStrictEqual(order.pricingSnapshot, pricingSnapshot(fixture.table));
  assert.strictEqual(order.orderId, result.quote.orderId);
  const session = fixture.state.sessions[0];
  assert.strictEqual(session.status, 'awaiting_payment');
  assert.strictEqual(session.checkoutAt, checkoutAt);
  assert.strictEqual(session.checkoutBy, 'owner-a');
  assert.strictEqual(session.orderId, order.orderId);
  assert.strictEqual(fixture.state.table_occupancies.length, 1);

  const stateAfterFirst = clone(fixture.state);
  const writeCount = harness.fakeDb.__operations.writes.length;
  const repeated = await atTime(checkoutAt + 999999, () => fn.main({ sessionId: 'session-active' }));
  assert.deepStrictEqual(repeated.quote, result.quote);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(repeated, 'checkoutToken'), false);
  assert.deepStrictEqual(fixture.state, stateAfterFirst);
  assert.strictEqual(harness.fakeDb.__operations.writes.length, writeCount);

  const malformedExistingOrders = [
    (state) => { state.shop_orders[0].storeId = 'other_store'; },
    (state) => { state.shop_orders[0].pricingSnapshot.pricePerHourFen += 1; },
    (state) => { state.shop_orders[0].paidTableFeeFen += 1; },
    (state) => { delete state.shop_orders[0].paymentBillFeeEvidence; },
    (state) => { delete state.shop_orders[0].paymentBillDiscoveryCompletedAt; },
    (state) => {
      state.sessions[0].checkoutAt = 999;
      state.shop_orders[0].checkoutAt = 999;
      state.shop_orders[0].actualDurationMs = 0;
      state.shop_orders[0].billedDurationMs = 0;
      state.shop_orders[0].tableGrossFen = 0;
      state.shop_orders[0].paidTableFeeFen = 0;
      state.shop_orders[0].totalCostFen = 0;
      state.shop_orders[0].shopNetFen = 0;
    },
    (state) => { state.shop_orders[0].orderStatus = 'complete'; }
  ];
  for (const corruptOrder of malformedExistingOrders) {
    const malformedState = clone(stateAfterFirst);
    corruptOrder(malformedState);
    const beforeMalformed = clone(malformedState);
    const malformedHarness = makeHarness(malformedState, 'owner-a');
    const malformedFn = malformedHarness.load('cloudfunctions/createTableOrder/index.js');
    const malformed = await malformedFn.main({ sessionId: 'session-active' });
    assert.strictEqual(malformed.ok, false);
    assert.strictEqual(malformed.code, 'ORDER_STATE_INVALID');
    assert.deepStrictEqual(malformedState, beforeMalformed);
    assert.strictEqual(malformedHarness.fakeDb.__operations.writes.length, 0);
  }

  fixture.state.shop_orders[0].orderStatus = 'external_paid';
  fixture.state.shop_orders[0].paymentStatus = 'not_applicable';
  fixture.state.shop_orders[0].splitStatus = 'not_applicable';
  fixture.state.shop_orders[0].totalCostFen = 0;
  fixture.state.shop_orders[0].channelFeeFen = 0;
  fixture.state.shop_orders[0].platformNetFen = 0;
  fixture.state.shop_orders[0].shopNetFen = fixture.state.shop_orders[0].paidTableFeeFen;
  fixture.state.shop_orders[0].externalPaidReason = 'cash register';
  fixture.state.shop_orders[0].externalPaidBy = 'owner-a';
  fixture.state.shop_orders[0].externalPaidAt = checkoutAt + 1;
  fixture.state.sessions[0].status = 'closed';
  fixture.state.sessions[0].closedAt = checkoutAt + 1;
  fixture.state.table_occupancies = [];
  const terminalState = clone(fixture.state);
  const terminalWriteCount = harness.fakeDb.__operations.writes.length;
  const terminalRepeat = await atTime(checkoutAt + 2000000, () => (
    fn.main({ sessionId: 'session-active' })
  ));
  assert.strictEqual(terminalRepeat.ok, true);
  assert.strictEqual(terminalRepeat.quote.orderStatus, 'external_paid');
  assert.strictEqual(terminalRepeat.quote.paymentStatus, 'not_applicable');
  assert.strictEqual(terminalRepeat.quote.splitStatus, 'not_applicable');
  assert.deepStrictEqual(fixture.state, terminalState);
  assert.strictEqual(harness.fakeDb.__operations.writes.length, terminalWriteCount);

  const boundary = activeOrderFixture();
  const maximumPriceTable = normalizedTable(
    'table-a',
    'Pool Table',
    Number.MAX_SAFE_INTEGER
  );
  boundary.state.stores[0].tableTypes[0] = maximumPriceTable;
  boundary.state.sessions[0].pricingSnapshot = pricingSnapshot(maximumPriceTable);
  const boundaryHarness = makeHarness(boundary.state, 'owner-a');
  const boundaryFn = boundaryHarness.load('cloudfunctions/createTableOrder/index.js');
  const boundaryResult = await atTime(4630, () => (
    boundaryFn.main({ sessionId: 'session-active' })
  ));
  const exactBoundaryFen = Number(
    (3630n * BigInt(Number.MAX_SAFE_INTEGER) + 1800000n) / 3600000n
  );
  assert.strictEqual(boundaryResult.ok, true);
  assert.strictEqual(boundaryResult.quote.tableGrossFen, exactBoundaryFen);

  const foreignHarness = makeHarness(clone(activeOrderFixture().state), 'owner-b');
  const foreignFn = foreignHarness.load('cloudfunctions/createTableOrder/index.js');
  const foreign = await foreignFn.main({ sessionId: 'session-active' });
  assert.strictEqual(foreign.ok, false);
  assert.strictEqual(foreign.code, 'SESSION_NOT_OWNED');

  for (const failedCollection of ['shop_orders', 'sessions']) {
    const rollback = activeOrderFixture();
    const before = clone(rollback.state);
    const rollbackHarness = makeHarness(rollback.state, 'owner-a', {
      failWrite(operation) {
        return operation.inTransaction && operation.collection === failedCollection;
      }
    });
    const rollbackFn = rollbackHarness.load('cloudfunctions/createTableOrder/index.js');
    const failed = await atTime(checkoutAt, () => rollbackFn.main({ sessionId: 'session-active' }));
    assert.strictEqual(failed.ok, false);
    assert.deepStrictEqual(rollback.state, before);
    assert.strictEqual(rollbackHarness.fakeDb.__operations.transactions[0].committed, false);
  }
}

async function testDirectCloseIsRetiredWithoutDatabaseAccess() {
  const fixture = activeOrderFixture();
  const before = clone(fixture.state);
  const harness = makeHarness(fixture.state, 'owner-a');
  const fn = harness.load('cloudfunctions/closeSession/index.js');
  const result = await fn.main({ sessionId: 'session-active' });
  assert.deepStrictEqual(result, { ok: false, code: 'PRODUCT_RETIRED' });
  assert.strictEqual(harness.databaseCalls(), 0);
  assert.deepStrictEqual(fixture.state, before);
  assert.strictEqual(harness.fakeDb.__operations.reads.length, 0);
  assert.strictEqual(harness.fakeDb.__operations.writes.length, 0);
}

function externalPaidFixture() {
  const fixture = activeOrderFixture();
  fixture.state.sessions[0].status = 'awaiting_payment';
  fixture.state.sessions[0].checkoutAt = 3601123;
  fixture.state.sessions[0].checkoutBy = 'owner-a';
  fixture.state.sessions[0].orderId = EXTERNAL_ORDER_ID;
  fixture.state.shop_orders.push({
    _id: EXTERNAL_ORDER_ID,
    schemaVersion: 2,
    _openid: 'owner-a',
    shopId: 'owner-a',
    storeId: 'store_main',
    tableId: 'table-a',
    sessionId: 'session-active',
    orderId: EXTERNAL_ORDER_ID,
    payerOpenid: '',
    outTradeNo: deployedState.outTradeNoForOrder(EXTERNAL_ORDER_ID),
    splitNo: deployedState.splitNoForOrder(EXTERNAL_ORDER_ID),
    tableName: 'Pool Table',
    pricingSnapshot: pricingSnapshot(fixture.table),
    startedAt: 1000,
    checkoutAt: 3601123,
    actualDurationMs: 3600123,
    billedDurationMs: 3600123,
    tableGrossFen: 12345,
    tableDiscountFen: 0,
    paidTableFeeFen: 12345,
    billingMode: 'table_commission',
    commissionRateBps: 500,
    includesChannelFee: true,
    policyVersion: 'table_commission_v1',
    splitCycle: 'T_PLUS_1',
    totalCostFen: 617,
    channelFeeFen: null,
    platformNetFen: null,
    shopNetFen: 11728,
    wechatTransactionId: '',
    paidAt: null,
    orderStatus: 'awaiting_payment',
    paymentStatus: 'unpaid',
    splitStatus: 'pending',
    splitCompletedAt: null,
    refundedTableFeeFen: 0,
    reversedTotalCostFen: 0,
    createdAt: 'SERVER_DATE',
    updatedAt: 'SERVER_DATE'
  });
  return fixture;
}

function assertExternalPaidTransition(before, after, externalPaidAt, reason) {
  assert.deepStrictEqual(after.shop_orders[0], Object.assign({}, before.shop_orders[0], {
    orderStatus: 'external_paid',
    paymentStatus: 'not_applicable',
    splitStatus: 'not_applicable',
    totalCostFen: 0,
    channelFeeFen: 0,
    platformNetFen: 0,
    shopNetFen: before.shop_orders[0].paidTableFeeFen,
    externalPaidReason: reason,
    externalPaidBy: 'owner-a',
    externalPaidAt,
    updatedAt: 'SERVER_DATE'
  }));
  assert.deepStrictEqual(after.sessions[0], Object.assign({}, before.sessions[0], {
    status: 'closed',
    closedAt: externalPaidAt,
    updatedAt: 'SERVER_DATE'
  }));
}

async function testExternalPaidIsOwnerOnlyAtomicAndIdempotent() {
  const fixture = externalPaidFixture();
  const harness = makeHarness(fixture.state, 'owner-a');
  const fn = harness.load('cloudfunctions/markTableOrderExternalPaid/index.js');
  const beforeInvalid = clone(fixture.state);
  for (const event of [
    { orderId: EXTERNAL_ORDER_ID, reason: '' },
    { orderId: EXTERNAL_ORDER_ID, reason: '   ' },
    { orderId: EXTERNAL_ORDER_ID, reason: 'x'.repeat(201) }
  ]) {
    const invalid = await fn.main(event);
    assert.strictEqual(invalid.ok, false);
    assert.strictEqual(invalid.code, 'INVALID_INPUT');
    assert.deepStrictEqual(fixture.state, beforeInvalid);
  }

  harness.setOpenid('owner-b');
  const foreign = await fn.main({ orderId: EXTERNAL_ORDER_ID, reason: 'cash' });
  assert.strictEqual(foreign.ok, false);
  assert.strictEqual(foreign.code, 'ORDER_NOT_OWNED');
  assert.deepStrictEqual(fixture.state, beforeInvalid);

  const invalidOrderIdentifiers = [
    {
      mutate(state) {
        const arbitraryOrderId = 'ord_arbitrary';
        const order = state.shop_orders[0];
        order._id = arbitraryOrderId;
        order.orderId = arbitraryOrderId;
        order.outTradeNo = deployedState.outTradeNoForOrder(arbitraryOrderId);
        order.splitNo = deployedState.splitNoForOrder(arbitraryOrderId);
        state.sessions[0].orderId = arbitraryOrderId;
        return arbitraryOrderId;
      }
    },
    {
      mutate(state) {
        state.shop_orders[0].outTradeNo = 'pay_wrong';
        return EXTERNAL_ORDER_ID;
      }
    },
    {
      mutate(state) {
        state.shop_orders[0].splitNo = 'split_wrong';
        return EXTERNAL_ORDER_ID;
      }
    }
  ];
  for (const invalidIdentifier of invalidOrderIdentifiers) {
    const invalidFixture = externalPaidFixture();
    const eventOrderId = invalidIdentifier.mutate(invalidFixture.state);
    const before = clone(invalidFixture.state);
    const invalidHarness = makeHarness(invalidFixture.state, 'owner-a');
    const invalidFn = invalidHarness.load('cloudfunctions/markTableOrderExternalPaid/index.js');
    const denied = await atTime(4000000, () => (
      invalidFn.main({ orderId: eventOrderId, reason: 'cash' })
    ));
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.code, 'ORDER_STATE_INVALID');
    assert.deepStrictEqual(invalidFixture.state, before);
    assert.strictEqual(invalidHarness.fakeDb.__operations.writes.length, 0);
  }

  for (const invalidExternalPaidAt of [3601122, Number.MAX_SAFE_INTEGER + 1]) {
    const invalidFixture = externalPaidFixture();
    const before = clone(invalidFixture.state);
    const invalidHarness = makeHarness(invalidFixture.state, 'owner-a');
    const invalidFn = invalidHarness.load('cloudfunctions/markTableOrderExternalPaid/index.js');
    const denied = await atTime(invalidExternalPaidAt, () => (
      invalidFn.main({ orderId: EXTERNAL_ORDER_ID, reason: 'cash' })
    ));
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.code, 'ORDER_STATE_INVALID');
    assert.deepStrictEqual(invalidFixture.state, before);
    assert.strictEqual(invalidHarness.fakeDb.__operations.writes.length, 0);
  }

  harness.setOpenid('owner-a');
  const result = await atTime(4000000, () => fn.main({ orderId: EXTERNAL_ORDER_ID, reason: '  cash register  ' }));
  assert.strictEqual(result.ok, true);
  assertExternalPaidTransition(beforeInvalid, fixture.state, 4000000, 'cash register');
  const order = fixture.state.shop_orders[0];
  assert.strictEqual(order.orderStatus, 'external_paid');
  assert.strictEqual(order.paymentStatus, 'not_applicable');
  assert.strictEqual(order.splitStatus, 'not_applicable');
  assert.strictEqual(order.totalCostFen, 0);
  assert.strictEqual(order.channelFeeFen, 0);
  assert.strictEqual(order.platformNetFen, 0);
  assert.strictEqual(order.shopNetFen, 12345);
  assert.strictEqual(order.externalPaidReason, 'cash register');
  assert.strictEqual(order.externalPaidBy, 'owner-a');
  assert.strictEqual(order.externalPaidAt, 4000000);
  assert.strictEqual(fixture.state.sessions[0].status, 'closed');
  assert.strictEqual(fixture.state.sessions[0].closedAt, 4000000);
  assert.strictEqual(fixture.state.table_occupancies.length, 0);
  for (const name of ['financial_events', 'training_sessions', 'coach_lessons', 'verified_trainings', 'payments', 'profit_sharing_orders']) {
    assert.strictEqual(fixture.state[name].length, 0, name + ' must remain empty');
  }

  const completedState = clone(fixture.state);
  const writeCount = harness.fakeDb.__operations.writes.length;
  const repeated = await atTime(5000000, () => fn.main({ orderId: EXTERNAL_ORDER_ID, reason: 'repeat' }));
  assert.strictEqual(repeated.ok, true);
  assert.strictEqual(repeated.orderStatus, 'external_paid');
  assert.deepStrictEqual(fixture.state, completedState);
  assert.strictEqual(harness.fakeDb.__operations.writes.length, writeCount);

  const malformedTerminalStates = [
    (state) => { state.shop_orders[0].paymentStatus = 'unpaid'; },
    (state) => { state.shop_orders[0].totalCostFen = 1; },
    (state) => { state.shop_orders[0].externalPaidReason = ''; },
    (state) => { state.shop_orders[0].externalPaidBy = ''; },
    (state) => {
      state.shop_orders[0].externalPaidAt = Number.MAX_SAFE_INTEGER + 1;
      state.sessions[0].closedAt = Number.MAX_SAFE_INTEGER + 1;
    },
    (state) => {
      state.shop_orders[0].tableGrossFen = 999;
      state.shop_orders[0].paidTableFeeFen = 999;
      state.shop_orders[0].shopNetFen = 999;
    },
    (state) => { state.shop_orders[0].pricingSnapshot.pricePerHourFen += 1; },
    (state) => { state.sessions[0].status = 'awaiting_payment'; },
    (state) => { state.shop_orders[0].storeId = 'other_store'; }
  ];
  for (const corruptTerminalState of malformedTerminalStates) {
    const malformedState = clone(completedState);
    corruptTerminalState(malformedState);
    const beforeMalformed = clone(malformedState);
    const malformedHarness = makeHarness(malformedState, 'owner-a');
    const malformedFn = malformedHarness.load('cloudfunctions/markTableOrderExternalPaid/index.js');
    const malformed = await malformedFn.main({ orderId: EXTERNAL_ORDER_ID, reason: 'repeat' });
    assert.strictEqual(malformed.ok, false);
    assert.strictEqual(malformed.code, 'ORDER_STATE_INVALID');
    assert.deepStrictEqual(malformedState, beforeMalformed);
    assert.strictEqual(malformedHarness.fakeDb.__operations.writes.length, 0);
  }

  const incompatibleInitialStates = [
    ['paid', 'paid', 'pending'],
    ['complete', 'paid', 'not_applicable'],
    ['canceled', 'closed', 'not_applicable'],
    ['manual_review', 'unpaid', 'pending']
  ];
  for (const [orderStatus, paymentStatus, splitStatus] of incompatibleInitialStates) {
    const incompatible = externalPaidFixture();
    incompatible.state.shop_orders[0].orderStatus = orderStatus;
    incompatible.state.shop_orders[0].paymentStatus = paymentStatus;
    incompatible.state.shop_orders[0].splitStatus = splitStatus;
    const beforeIncompatible = clone(incompatible.state);
    const incompatibleHarness = makeHarness(incompatible.state, 'owner-a');
    const incompatibleFn = incompatibleHarness.load('cloudfunctions/markTableOrderExternalPaid/index.js');
    const denied = await incompatibleFn.main({ orderId: EXTERNAL_ORDER_ID, reason: 'cash' });
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.code, 'ORDER_STATE_INVALID');
    assert.deepStrictEqual(incompatible.state, beforeIncompatible);
    assert.strictEqual(incompatibleHarness.fakeDb.__operations.writes.length, 0);
  }

  const invalidRelationshipIds = [
    (state) => { state.shop_orders[0].storeId = 'a__b'; state.sessions[0].storeId = 'a__b'; },
    (state) => { state.shop_orders[0].tableId = 'b__c'; state.sessions[0].tableId = 'b__c'; }
  ];
  for (const corruptIds of invalidRelationshipIds) {
    const invalidIds = externalPaidFixture();
    corruptIds(invalidIds.state);
    const beforeInvalidIds = clone(invalidIds.state);
    const invalidIdsHarness = makeHarness(invalidIds.state, 'owner-a');
    const invalidIdsFn = invalidIdsHarness.load('cloudfunctions/markTableOrderExternalPaid/index.js');
    const denied = await invalidIdsFn.main({ orderId: EXTERNAL_ORDER_ID, reason: 'cash' });
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.code, 'ORDER_STATE_INVALID');
    assert.deepStrictEqual(invalidIds.state, beforeInvalidIds);
    assert.strictEqual(invalidIdsHarness.fakeDb.__operations.writes.length, 0);
  }

  const missing = externalPaidFixture();
  missing.state.table_occupancies = [];
  const beforeMissing = clone(missing.state);
  const missingHarness = makeHarness(missing.state, 'owner-a');
  const missingFn = missingHarness.load('cloudfunctions/markTableOrderExternalPaid/index.js');
  const missingResult = await atTime(4100000, () => (
    missingFn.main({ orderId: EXTERNAL_ORDER_ID, reason: 'cash' })
  ));
  assert.strictEqual(missingResult.ok, true);
  assertExternalPaidTransition(beforeMissing, missing.state, 4100000, 'cash');
  assert.strictEqual(missing.state.table_occupancies.length, 0);
  assert.strictEqual(
    missingHarness.fakeDb.__operations.writes.some((write) => write.collection === 'table_occupancies'),
    false
  );

  const mismatched = externalPaidFixture();
  mismatched.state.table_occupancies[0].sessionId = 'another-session';
  const beforeMismatched = clone(mismatched.state);
  const mismatchedHarness = makeHarness(mismatched.state, 'owner-a');
  const mismatchedFn = mismatchedHarness.load('cloudfunctions/markTableOrderExternalPaid/index.js');
  const mismatchedResult = await atTime(4200000, () => (
    mismatchedFn.main({ orderId: EXTERNAL_ORDER_ID, reason: 'cash' })
  ));
  assert.strictEqual(mismatchedResult.ok, true);
  assertExternalPaidTransition(beforeMismatched, mismatched.state, 4200000, 'cash');
  assert.strictEqual(mismatched.state.table_occupancies[0].sessionId, 'another-session');

  for (const failedCollection of ['shop_orders', 'sessions', 'table_occupancies']) {
    const rollback = externalPaidFixture();
    const before = clone(rollback.state);
    const rollbackHarness = makeHarness(rollback.state, 'owner-a', {
      failWrite(operation) {
        return operation.inTransaction && operation.collection === failedCollection;
      }
    });
    const rollbackFn = rollbackHarness.load('cloudfunctions/markTableOrderExternalPaid/index.js');
    const failed = await rollbackFn.main({ orderId: EXTERNAL_ORDER_ID, reason: 'cash' });
    assert.strictEqual(failed.ok, false);
    assert.deepStrictEqual(rollback.state, before);
    assert.strictEqual(rollbackHarness.fakeDb.__operations.transactions[0].committed, false);
  }
}

function freshRequire(file) {
  const modulePath = path.join(root, file);
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

async function testClientMockStoreCreationUsesGeneratedId() {
  const storage = new Map();
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  global.getApp = () => ({ globalData: { cloudReady: false, openid: 'owner-a', role: 'shop' } });
  global.wx = {
    getStorageSync(key) { return storage.has(key) ? clone(storage.get(key)) : ''; },
    setStorageSync(key, value) { storage.set(key, clone(value)); },
    removeStorageSync(key) { storage.delete(key); }
  };
  try {
    const data = freshRequire('miniprogram/services/data.js');
    const created = await atTime(6000000, () => data.saveShopStore({
      name: 'Local Demo Store',
      tableTypes: []
    }));
    assert.strictEqual(created.ok, true);
    assert(isBusinessId(created.storeId));
    assert.deepStrictEqual(created.tableTypes, []);
    const stores = clone(storage.get('dc_stores'));
    assert.strictEqual(stores.length, 1);
    assert.strictEqual(stores[0]._id, created.storeId);

    const beforeUnknown = clone(stores);
    await assert.rejects(
      () => data.saveShopStore({
        _id: 'client_supplied_unknown',
        name: 'Client Controlled',
        tableTypes: []
      }),
      (error) => error && error.code === 'STORE_NOT_OWNED'
    );
    assert.deepStrictEqual(storage.get('dc_stores'), beforeUnknown);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
}

async function testClientFinanceMutationsFailClosedAndUseCheckedCloud() {
  const storage = new Map();
  const cloudCalls = [];
  const app = { globalData: { cloudReady: false, openid: 'owner-a', role: 'shop' } };
  global.getApp = () => app;
  global.wx = {
    getStorageSync(key) { return storage.has(key) ? clone(storage.get(key)) : ''; },
    setStorageSync(key, value) { storage.set(key, clone(value)); },
    removeStorageSync(key) { storage.delete(key); },
    cloud: {
      callFunction(request) {
        cloudCalls.push(clone(request));
        return Promise.resolve({ result: { ok: false, code: 'DENIED', msg: 'denied' } });
      }
    }
  };
  const data = freshRequire('miniprogram/services/data.js');
  const calls = [
    () => data.createSession({ storeId: 'store_main', tableId: 'table-a' }),
    () => data.closeSession({ sessionId: 'session-active' }),
    () => data.addTableOrder({ sessionId: 'session-active' }),
    () => data.markTableOrderExternalPaid({ orderId: 'ord_external', reason: 'cash' })
  ];
  for (const invoke of calls) {
    await assert.rejects(invoke, (error) => error && error.code === 'CLOUD_NOT_READY');
  }
  assert.strictEqual(storage.size, 0);
  assert.strictEqual(cloudCalls.length, 0);

  app.globalData.cloudReady = true;
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(
      () => data.saveShopStore({ _id: 'store_main', name: 'Main Hall', tableTypes: [] }),
      (error) => error && error.code === 'DENIED'
    );
    for (const invoke of calls) {
      await assert.rejects(invoke, (error) => error && error.code === 'DENIED');
    }
  } finally {
    console.warn = originalWarn;
  }
  assert.deepStrictEqual(cloudCalls.map((item) => item.name), [
    'saveShopStore',
    'createSession',
    'closeSession',
    'createTableOrder',
    'markTableOrderExternalPaid'
  ]);
  assert.deepStrictEqual(cloudCalls[3].data, { sessionId: 'session-active' });
}

function testDeployableFinanceLibrariesMatchSharedSources() {
  for (const name of ['money.js', 'state.js']) {
    const shared = fs.readFileSync(path.join(root, 'cloudfunctions/_shared/table-finance', name));
    const destinations = ['createSession', 'createTableOrder'];
    if (name === 'state.js') destinations.push('markTableOrderExternalPaid');
    for (const destination of destinations) {
      const deployedPath = path.join(root, 'cloudfunctions', destination, 'lib', name);
      assert(fs.existsSync(deployedPath), deployedPath + ' should exist');
      assert.deepStrictEqual(fs.readFileSync(deployedPath), shared);
    }
  }
  const packagePath = path.join(root, 'cloudfunctions/markTableOrderExternalPaid/package.json');
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(packagePath, 'utf8')));
}

const tests = [
  ['store configuration is owned, stable, and normalized', testStoreConfigurationIsOwnedStableAndNormalized],
  ['table editors retain existing IDs', testTableEditorsRetainExistingIds],
  ['sessions enforce authorization, snapshots, concurrency, and rollback', testSessionAuthorizationSnapshotConcurrencyAndRollback],
  ['checkin queue is owner scoped and terminal', testCheckinQueueIsOwnerScopedAndTerminal],
  ['version-two session reads are owner scoped', testVersionTwoSessionReadsAreOwnerScoped],
  ['checkout is trusted, atomic, and idempotent', testCheckoutIsTrustedAtomicAndIdempotent],
  ['direct close is retired without database access', testDirectCloseIsRetiredWithoutDatabaseAccess],
  ['external paid is owner-only, atomic, and idempotent', testExternalPaidIsOwnerOnlyAtomicAndIdempotent],
  ['client mock store creation uses generated IDs', testClientMockStoreCreationUsesGeneratedId],
  ['client finance mutations fail closed and use checked cloud', testClientFinanceMutationsFailClosedAndUseCheckedCloud],
  ['deployable finance libraries match shared sources', testDeployableFinanceLibrariesMatchSharedSources]
];

(async () => {
  for (const [name, test] of tests) {
    await test();
    console.log('ok - ' + name);
  }
  console.log('table session order flow ok');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
