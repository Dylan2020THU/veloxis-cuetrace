const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const root = path.resolve(__dirname, '..');

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function bindingId(openid) {
  return crypto.createHash('sha256').update('wechat:' + openid).digest('hex');
}

function slotId(storeId, tableId, role) {
  return crypto.createHash('sha256')
    .update(`checkin-slot\0${storeId}\0${tableId}\0${role}`)
    .digest('hex');
}

function occupancyId(storeId, tableId) {
  return String(storeId.length) + '_' + storeId + '__' + tableId;
}

function identity(openid, roles, currentRole, status = 'active') {
  const userId = bindingId(openid);
  const accountId = 'account_' + openid;
  const account = 'login_' + openid;
  return {
    binding: { _id: userId, _openid: openid, accountId, account },
    account: { _id: accountId, _openid: openid, account, status },
    user: {
      _id: userId,
      _openid: openid,
      roles: roles.slice(),
      currentRole
    }
  };
}

function initialState() {
  const identities = [
    identity('member-a', ['member'], 'member'),
    identity('member-b', ['member'], 'member'),
    identity('coach-a', ['coach'], 'coach'),
    identity('owner-a', ['shop'], 'shop'),
    identity('owner-b', ['shop'], 'shop'),
    identity('inactive-member', ['member'], 'member', 'disabled')
  ];
  return {
    wechat_bindings: identities.map((item) => clone(item.binding)),
    accounts: identities.map((item) => clone(item.account)),
    users: identities.map((item) => clone(item.user)),
    stores: [
      {
        _id: 'store-a',
        _openid: 'owner-a',
        name: 'Alpha Hall',
        tableTypes: [
          { tableId: 'table-a', name: 'Table A' },
          { tableId: 'table-b', name: 'Table B' }
        ]
      },
      {
        _id: 'store-b',
        _openid: 'owner-b',
        name: 'Beta Hall',
        tableTypes: [{ tableId: 'table-c', name: 'Table C' }]
      }
    ],
    checkin_requests: [],
    table_checkin_slots: [],
    table_occupancies: []
  };
}

function replaceState(target, source) {
  for (const key of Object.keys(target)) {
    if (Array.isArray(target[key])) target[key] = clone(source[key] || []);
  }
}

function makeDatabase(state) {
  let transactionTail = Promise.resolve();
  let throwOnNotFound = true;
  const operations = { reads: [], writes: [], transactions: [] };

  function facade(target, inTransaction) {
    return {
      collection(name) {
        if (!Object.prototype.hasOwnProperty.call(target, name)) {
          throw new Error('Unexpected collection: ' + name);
        }
        const documents = target[name];
        return {
          doc(id) {
            if (typeof id !== 'string' || !id || id.includes('/')) {
              throw new Error('Invalid document id: ' + id);
            }
            return {
              async get() {
                operations.reads.push({ name, id, inTransaction });
                const found = documents.find((item) => item._id === id) || null;
                if (!found && throwOnNotFound) {
                  const error = new Error(`${name}/${id} not found`);
                  error.code = 'DATABASE_DOCUMENT_NOT_FOUND';
                  throw error;
                }
                return { data: clone(found) };
              },
              async set({ data }) {
                operations.writes.push({ name, id, method: 'set', inTransaction });
                const next = Object.assign({}, clone(data), { _id: id });
                const index = documents.findIndex((item) => item._id === id);
                if (index === -1) documents.push(next);
                else documents[index] = next;
                return { _id: id };
              },
              async update({ data }) {
                operations.writes.push({ name, id, method: 'update', inTransaction });
                const index = documents.findIndex((item) => item._id === id);
                if (index === -1) throw new Error(`${name}/${id} not found`);
                documents[index] = Object.assign({}, documents[index], clone(data), { _id: id });
                return { stats: { updated: 1 } };
              }
            };
          }
        };
      }
    };
  }

  const db = facade(state, false);
  db.serverDate = () => 'SERVER_DATE';
  db.__configure = (settings) => {
    throwOnNotFound = !(settings && settings.throwOnNotFound === false);
  };
  db.runTransaction = (work) => {
    const execute = async () => {
      const draft = clone(state);
      const record = { committed: false };
      operations.transactions.push(record);
      try {
        const result = await work(facade(draft, true));
        replaceState(state, draft);
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
  db.__operations = operations;
  return db;
}

function makeHarness(state, initialOpenid) {
  let openid = initialOpenid;
  const db = makeDatabase(state);
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database(settings) {
      db.__configure(settings);
      return db;
    },
    getWXContext() {
      return { OPENID: openid };
    }
  };
  return {
    db,
    setOpenid(value) { openid = value; },
    load(relativePath) {
      const originalLoad = Module._load;
      Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'wx-server-sdk') return cloud;
        return originalLoad.call(this, request, parent, isMain);
      };
      try {
        const modulePath = path.join(root, relativePath);
        delete require.cache[require.resolve(modulePath)];
        return require(modulePath);
      } finally {
        Module._load = originalLoad;
      }
    }
  };
}

async function atTime(value, work) {
  const originalNow = Date.now;
  Date.now = () => value;
  try {
    return await work();
  } finally {
    Date.now = originalNow;
  }
}

function requestInput(overrides = {}) {
  return Object.assign({
    storeId: 'store-a',
    tableId: 'table-a',
    nickname: 'Alice',
    avatar: 'https://example.test/alice.png',
    role: 'member',
    ready: false
  }, overrides);
}

async function testMemberCoachAccessAndMinimalProjection() {
  const state = initialState();
  const harness = makeHarness(state, 'member-a');
  const requestCheckin = harness.load('cloudfunctions/requestCheckin/index.js');

  assert.deepStrictEqual(
    await atTime(1_000_000, () => requestCheckin.main(requestInput())),
    { ok: true, status: 'pending' }
  );
  const memberSlotId = slotId('store-a', 'table-a', 'member');
  const memberSlot = state.table_checkin_slots.find((item) => item._id === memberSlotId);
  assert.deepStrictEqual(memberSlot, {
    _id: memberSlotId,
    schemaVersion: 1,
    storeId: 'store-a',
    tableId: 'table-a',
    role: 'member',
    currentRequestId: memberSlot.currentRequestId,
    memberOpenid: 'member-a',
    status: 'pending',
    sessionId: '',
    boundAt: null,
    updatedAt: 'SERVER_DATE'
  });
  assert(/^ci_[0-9a-f]{32}$/.test(memberSlot.currentRequestId));
  const memberRequest = state.checkin_requests.find(
    (item) => item._id === memberSlot.currentRequestId
  );
  assert.strictEqual(memberRequest.slotId, memberSlotId);
  assert.strictEqual(memberRequest.joinedAt, 1_000_000);
  assert.strictEqual(memberRequest.readyAt, null);

  harness.setOpenid('coach-a');
  assert.deepStrictEqual(
    await atTime(1_000_010, () => requestCheckin.main(requestInput({
      nickname: 'Coach',
      avatar: '',
      role: 'coach',
      ready: true
    }))),
    { ok: true, status: 'pending' }
  );

  const participants = harness.load('cloudfunctions/getTableParticipants/index.js');
  const coachView = await participants.main({ storeId: 'store-a', tableId: 'table-a' });
  assert.deepStrictEqual(coachView, {
    ok: true,
    participants: [
      { nickname: 'Alice', avatar: 'https://example.test/alice.png', role: 'member', ready: false },
      { nickname: 'Coach', avatar: '', role: 'coach', ready: true }
    ]
  });
  for (const participant of coachView.participants) {
    assert.deepStrictEqual(
      Object.keys(participant).sort(),
      ['avatar', 'nickname', 'ready', 'role']
    );
  }

  harness.setOpenid('owner-a');
  assert.deepStrictEqual(
    await participants.main({ storeId: 'store-a', tableId: 'table-a' }),
    coachView
  );
}

async function testIdentityRoleStoreAndTableValidation() {
  const state = initialState();
  const harness = makeHarness(state, 'unbound');
  const requestCheckin = harness.load('cloudfunctions/requestCheckin/index.js');
  assert.strictEqual((await requestCheckin.main(requestInput())).code, 'ACCOUNT_NOT_BOUND');

  harness.setOpenid('inactive-member');
  assert.strictEqual((await requestCheckin.main(requestInput())).code, 'ACCOUNT_NOT_BOUND');

  harness.setOpenid('member-a');
  assert.strictEqual(
    (await requestCheckin.main(requestInput({ role: 'coach' }))).code,
    'ROLE_MISMATCH'
  );
  assert.strictEqual(
    (await requestCheckin.main(requestInput({ tableId: 'missing-table' }))).code,
    'TABLE_NOT_FOUND'
  );
  assert.strictEqual(
    (await requestCheckin.main(Object.assign(requestInput(), { readyAt: 123 }))).code,
    'INVALID_INPUT'
  );
  assert.strictEqual(state.checkin_requests.length, 0);
  assert.strictEqual(state.table_checkin_slots.length, 0);
}

async function testAccessDoesNotCrossStoresOrTables() {
  const state = initialState();
  const harness = makeHarness(state, 'member-a');
  const requestCheckin = harness.load('cloudfunctions/requestCheckin/index.js');
  await requestCheckin.main(requestInput());
  const participants = harness.load('cloudfunctions/getTableParticipants/index.js');

  assert.strictEqual(
    (await participants.main({ storeId: 'store-a', tableId: 'table-b' })).code,
    'ACCESS_DENIED'
  );
  harness.setOpenid('owner-a');
  assert.strictEqual(
    (await participants.main({ storeId: 'store-b', tableId: 'table-c' })).code,
    'ACCESS_DENIED'
  );
  assert.strictEqual(
    (await participants.main({ storeId: 'store-a', tableId: 'missing-table' })).code,
    'TABLE_NOT_FOUND'
  );
}

async function testSlotCompetitionAndSameAccountIdempotency() {
  const state = initialState();
  const harness = makeHarness(state, 'member-a');
  const requestCheckin = harness.load('cloudfunctions/requestCheckin/index.js');
  await atTime(2_000_000, () => requestCheckin.main(requestInput()));
  const slot = state.table_checkin_slots[0];
  const firstRequestId = slot.currentRequestId;

  harness.setOpenid('member-b');
  assert.strictEqual(
    (await requestCheckin.main(requestInput({ nickname: 'Bob' }))).code,
    'TABLE_CHECKIN_SLOT_OCCUPIED'
  );
  assert.strictEqual(state.checkin_requests.length, 1);

  harness.setOpenid('member-a');
  assert.deepStrictEqual(
    await atTime(2_000_100, () => requestCheckin.main(requestInput({
      nickname: 'Alice Updated',
      ready: true
    }))),
    { ok: true, status: 'pending' }
  );
  assert.strictEqual(state.checkin_requests.length, 1);
  assert.strictEqual(state.table_checkin_slots[0].currentRequestId, firstRequestId);
  const updated = state.checkin_requests[0];
  assert.strictEqual(updated.nickname, 'Alice Updated');
  assert.strictEqual(updated.joinedAt, 2_000_000);
  assert.strictEqual(updated.ready, true);
  assert.strictEqual(updated.readyAt, 2_000_100);

  await atTime(2_000_200, () => requestCheckin.main(requestInput({ ready: false })));
  assert.strictEqual(state.checkin_requests[0].ready, true, 'ready state cannot regress');
  assert.strictEqual(state.checkin_requests[0].readyAt, 2_000_100);
}

async function testOccupiedTableRejectsBeforeSlotMutation() {
  const state = initialState();
  state.table_occupancies.push({
    _id: occupancyId('store-a', 'table-a'),
    storeId: 'store-a',
    tableId: 'table-a',
    sessionId: 'session-active',
    status: 'active'
  });
  const harness = makeHarness(state, 'member-a');
  const requestCheckin = harness.load('cloudfunctions/requestCheckin/index.js');
  assert.strictEqual(
    (await requestCheckin.main(requestInput())).code,
    'TABLE_OCCUPIED'
  );
  assert.strictEqual(state.checkin_requests.length, 0);
  assert.strictEqual(state.table_checkin_slots.length, 0);
}

async function testConfirmedEvidenceIsPreservedWhenSlotIsReused() {
  const state = initialState();
  const harness = makeHarness(state, 'member-a');
  const requestCheckin = harness.load('cloudfunctions/requestCheckin/index.js');
  await atTime(3_000_000, () => requestCheckin.main(requestInput({ ready: true })));
  const oldRequest = state.checkin_requests[0];
  const oldRequestId = oldRequest._id;
  Object.assign(oldRequest, {
    status: 'confirmed',
    sessionId: 'session-old',
    boundAt: 3_000_100,
    resolvedAt: 3_000_100
  });
  Object.assign(state.table_checkin_slots[0], {
    status: 'confirmed',
    sessionId: 'session-old',
    boundAt: 3_000_100
  });
  const evidenceSnapshot = clone(oldRequest);

  await atTime(4_000_000, () => requestCheckin.main(requestInput({ ready: false })));
  assert.strictEqual(state.checkin_requests.length, 2);
  assert.deepStrictEqual(
    state.checkin_requests.find((item) => item._id === oldRequestId),
    evidenceSnapshot
  );
  assert.notStrictEqual(state.table_checkin_slots[0].currentRequestId, oldRequestId);
  assert.strictEqual(state.table_checkin_slots[0].status, 'pending');
}

async function testActiveBoundParticipantCanReadCurrentTableOnly() {
  const state = initialState();
  const harness = makeHarness(state, 'member-a');
  const requestCheckin = harness.load('cloudfunctions/requestCheckin/index.js');
  await requestCheckin.main(requestInput({ ready: true }));
  const request = state.checkin_requests[0];
  const slot = state.table_checkin_slots[0];
  Object.assign(request, {
    status: 'confirmed',
    sessionId: 'session-active',
    boundAt: 5_000_000
  });
  Object.assign(slot, {
    status: 'confirmed',
    sessionId: 'session-active',
    boundAt: 5_000_000
  });
  state.table_occupancies.push({
    _id: occupancyId('store-a', 'table-a'),
    storeId: 'store-a',
    tableId: 'table-a',
    sessionId: 'session-active',
    status: 'active'
  });
  const participants = harness.load('cloudfunctions/getTableParticipants/index.js');
  assert.strictEqual(
    (await participants.main({ storeId: 'store-a', tableId: 'table-a' })).ok,
    true
  );
  assert.strictEqual(
    (await participants.main({ storeId: 'store-a', tableId: 'table-b' })).code,
    'ACCESS_DENIED'
  );
}

function testClientUsesTheParticipantProjectionEndpoint() {
  const dataJs = fs.readFileSync(path.join(root, 'miniprogram/services/data.js'), 'utf8');
  const pageJs = fs.readFileSync(
    path.join(root, 'miniprogram/pages/table/checkin/index.js'),
    'utf8'
  );
  assert(dataJs.includes('function getTableParticipants(storeId, tableId)'));
  assert(dataJs.includes("callCloud('getTableParticipants', { storeId, tableId })"));
  assert(pageJs.includes('data.getTableParticipants(this.data.storeId, this.data.tableId)'));
  assert(!pageJs.includes('data.getPendingCheckins(this.data.storeId)'));
}

const tests = [
  ['member and coach access returns only the participant projection', testMemberCoachAccessAndMinimalProjection],
  ['identity role store and table validation fails closed', testIdentityRoleStoreAndTableValidation],
  ['participant access cannot cross stores or tables', testAccessDoesNotCrossStoresOrTables],
  ['slot competition is exclusive and same-account requests are idempotent', testSlotCompetitionAndSameAccountIdempotency],
  ['occupied tables reject check-ins before any slot mutation', testOccupiedTableRejectsBeforeSlotMutation],
  ['confirmed evidence is preserved when a slot is reused', testConfirmedEvidenceIsPreservedWhenSlotIsReused],
  ['active-bound participants can read only their current table', testActiveBoundParticipantCanReadCurrentTableOnly],
  ['the table page uses the minimum participant endpoint', testClientUsesTheParticipantProjectionEndpoint]
];

(async () => {
  for (const [name, test] of tests) {
    await test();
    console.log('ok - ' + name);
  }
  console.log('table checkin access ok');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
