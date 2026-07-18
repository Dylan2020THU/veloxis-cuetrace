const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const root = path.resolve(__dirname, '..');
const SHOP_OPENID = 'shop-openid';
const COACH_OPENID = 'coach-openid';
const STORE_ID = 'store-id';

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function freshRequire(file) {
  const resolved = require.resolve(path.join(root, file));
  delete require.cache[resolved];
  return require(resolved);
}

function conditionMatches(actual, expected) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return actual === expected;
  if (expected.$op === 'in') return expected.values.indexOf(actual) !== -1;
  if (expected.$op === 'range') return actual >= expected.from && actual <= expected.to;
  return actual === expected;
}

function makeDatabase(initialState) {
  const state = clone(initialState);
  const operations = { adds: [], updates: [] };
  let nextId = 1;

  function collection(name) {
    if (!state[name]) state[name] = [];
    const records = state[name];
    return {
      where(query) {
        let skipValue = 0;
        let limitValue = 100;
        const builder = {
          skip(value) { skipValue = value; return builder; },
          limit(value) { limitValue = value; return builder; },
          orderBy() { return builder; },
          async get() {
            const found = records.filter((record) => Object.keys(query || {}).every((key) => (
              conditionMatches(record[key], query[key])
            )));
            return { data: clone(found.slice(skipValue, skipValue + limitValue)) };
          }
        };
        return builder;
      },
      doc(id) {
        return {
          async update({ data }) {
            const record = records.find((item) => item._id === id);
            if (!record) throw new Error(`${name}/${id} missing`);
            Object.assign(record, clone(data));
            operations.updates.push({ collection: name, id, data: clone(data) });
            return { stats: { updated: 1 } };
          }
        };
      },
      async add({ data }) {
        const id = `${name}-${nextId++}`;
        const saved = Object.assign({ _id: id }, clone(data));
        records.push(saved);
        operations.adds.push({ collection: name, data: clone(saved) });
        return { _id: id };
      }
    };
  }

  return {
    state,
    operations,
    db: {
      command: {
        in(values) { return { $op: 'in', values: values.slice() }; },
        gte(value) {
          return {
            and(other) { return { $op: 'range', from: value, to: other.value }; }
          };
        },
        lte(value) { return { value }; }
      },
      serverDate() { return 123456789; },
      collection
    }
  };
}

function loadCloudFunction(file, initialState, openid = SHOP_OPENID) {
  const fixture = makeDatabase(initialState);
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'test',
    init() {},
    database() { return fixture.db; },
    getWXContext() { return { OPENID: openid }; }
  };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'wx-server-sdk') return cloud;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const resolved = require.resolve(path.join(root, file));
    delete require.cache[resolved];
    return Object.assign(fixture, { fn: require(resolved) });
  } finally {
    Module._load = originalLoad;
  }
}

function settlementState() {
  return {
    shop_coach_links: [{ shopOpenid: SHOP_OPENID, coachOpenid: COACH_OPENID, status: 'active' }],
    stores: [{ _id: STORE_ID, _openid: SHOP_OPENID }],
    coaches: [{ _id: 'coach-profile', _openid: COACH_OPENID, nickname: '零佣教练', avatar: '' }],
    coach_lessons: [
      { _id: 'pending-lesson', coachOpenid: COACH_OPENID, hallId: STORE_ID, date: '2026-07-14', amount: 100, settled: false },
      { _id: 'settled-lesson', coachOpenid: COACH_OPENID, hallId: STORE_ID, date: '2026-07-13', amount: 200, settled: true, settlementId: 'historical-settlement' }
    ],
    coach_settlements: [{
      _id: 'historical-settlement',
      shopOpenid: SHOP_OPENID,
      coachOpenid: COACH_OPENID,
      grossAmount: 200,
      commission: 50,
      netAmount: 150,
      periodFrom: '2026-07-13',
      periodTo: '2026-07-13'
    }],
    bookings: [],
    training_sessions: []
  };
}

function assertHistoricalSnapshot(snapshot) {
  assert.strictEqual(snapshot.commission, 50, 'Historical settled commission must remain authoritative.');
  assert.strictEqual(snapshot.netAmount, 150, 'Historical settled net amount must remain authoritative.');
}

async function testCompatibilityCommissionMathIsZero() {
  global.getApp = () => ({ globalData: {} });
  const billing = freshRequire('miniprogram/utils/billing.js');
  assert.strictEqual(billing.COACH_COMMISSION_RATE, 0);
  assert.strictEqual(billing.calcCoachCommission(100), 0);
  assert.strictEqual(billing.calcCoachCommission(123.45), 0);
}

async function testCloudBookingOmitsCommissionRate() {
  const loaded = loadCloudFunction('cloudfunctions/createBooking/index.js', settlementState(), 'member-openid');
  const result = await loaded.fn.main({ type: 'coach', targetId: COACH_OPENID, price: 88 });
  assert.strictEqual(result.ok, true);
  const booking = loaded.state.bookings[0];
  assert(booking);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(booking, 'commissionRate'), false);
}

async function testCloudUnsettledValuesAndHistoricalSnapshots() {
  const overviewLoaded = loadCloudFunction('cloudfunctions/getShopCoachSettlement/index.js', settlementState());
  const overview = await overviewLoaded.fn.main({ period: 'all' });
  assert.strictEqual(overview.totalPendingNet, 100);
  assert.strictEqual(overview.coaches[0].pendingGross, 100);
  assert.strictEqual(overview.coaches[0].pendingCommission, 0);
  assert.strictEqual(overview.coaches[0].pendingNet, 100);
  assert.strictEqual(overview.coaches[0].settledNet, 150, 'Overview must total saved historical netAmount snapshots.');

  const detailLoaded = loadCloudFunction('cloudfunctions/getCoachSettlementDetail/index.js', settlementState());
  const detail = await detailLoaded.fn.main({ coachOpenid: COACH_OPENID, period: 'all' });
  assert.deepStrictEqual(detail.summary, { gross: 100, commission: 0, net: 100 });

  const settleLoaded = loadCloudFunction('cloudfunctions/settleCoach/index.js', settlementState());
  const historicalBefore = clone(settleLoaded.state.coach_settlements[0]);
  const settled = await settleLoaded.fn.main({ coachOpenid: COACH_OPENID, period: 'all' });
  assert.strictEqual(settled.ok, true);
  assert.strictEqual(settled.netAmount, 100);
  assert.deepStrictEqual(settleLoaded.state.coach_settlements[0], historicalBefore);
  assertHistoricalSnapshot(settleLoaded.state.coach_settlements[0]);
  const created = settleLoaded.state.coach_settlements[1];
  assert.strictEqual(created.grossAmount, 100);
  assert.strictEqual(created.commission, 0);
  assert.strictEqual(created.netAmount, 100);
}

async function testLegacyCloudTrainingEntryIsRetiredBeforeWrites() {
  const loaded = loadCloudFunction('cloudfunctions/recordVerifiedTraining/index.js', settlementState());
  const before = clone(loaded.state);
  const result = await loaded.fn.main({
    memberOpenid: 'member-openid',
    coachOpenid: COACH_OPENID,
    hallId: STORE_ID,
    durationMinutes: 60,
    amount: 88
  });
  assert.deepStrictEqual(result, { ok: false, code: 'PRODUCT_RETIRED' });
  assert.deepStrictEqual(loaded.state, before);
  assert.deepStrictEqual(loaded.operations, { adds: [], updates: [] });
}

async function testMockPathsOmitCommissionAndUseZeroSettlement() {
  const storage = new Map();
  global.wx = {
    getStorageSync(key) { return storage.has(key) ? clone(storage.get(key)) : ''; },
    setStorageSync(key, value) { storage.set(key, clone(value)); },
    removeStorageSync(key) { storage.delete(key); }
  };
  const app = {
    globalData: {
      cloudReady: false,
      role: 'shop',
      openid: SHOP_OPENID,
      userProfile: { nickname: '测试用户', avatar: '' }
    }
  };
  global.getApp = () => app;
  const mock = freshRequire('miniprogram/utils/mock.js');
  mock.writeArray(mock.KEY_BOOKINGS, []);
  mock.writeObject(mock.KEY_SHOP, { storeId: STORE_ID });
  mock.writeArray(mock.KEY_STORES, [{ _id: STORE_ID, _openid: SHOP_OPENID }]);
  mock.writeArray(mock.KEY_SHOP_COACHES, [{ shopOpenid: SHOP_OPENID, coachOpenid: COACH_OPENID, status: 'active' }]);
  mock.writeArray(mock.KEY_ALL_COACHES, [{ openid: COACH_OPENID, nickname: '零佣教练', avatar: '' }]);
  mock.writeArray(mock.KEY_COACH_LESSONS, settlementState().coach_lessons);
  mock.writeArray(mock.KEY_COACH_SETTLEMENTS, settlementState().coach_settlements);
  const data = freshRequire('miniprogram/services/data.js');

  await data.createBooking({ type: 'coach', targetId: COACH_OPENID, price: 88 });
  const booking = mock.readArray(mock.KEY_BOOKINGS)[0];
  assert.strictEqual(Object.prototype.hasOwnProperty.call(booking, 'commissionRate'), false);

  const overview = await data.getShopCoachSettlement('all');
  assert.strictEqual(overview.totalPendingNet, 100);
  assert.strictEqual(overview.coaches[0].pendingCommission, 0);
  assert.strictEqual(overview.coaches[0].pendingNet, 100);
  assert.strictEqual(overview.coaches[0].settledNet, 150);

  const detail = await data.getCoachSettlementDetail(COACH_OPENID, 'all');
  assert.deepStrictEqual(detail.summary, { gross: 100, commission: 0, net: 100 });

  const trainingBefore = clone(mock.readArray(mock.KEY_SESSIONS));
  const lessonsBefore = clone(mock.readArray(mock.KEY_COACH_LESSONS));
  const legacyTraining = await data.recordVerifiedTraining({
    memberOpenid: 'member-openid',
    coachOpenid: COACH_OPENID,
    hallId: STORE_ID,
    durationMinutes: 60,
    amount: 88
  });
  assert.deepStrictEqual(legacyTraining, { ok: false, code: 'PRODUCT_RETIRED' });
  assert.deepStrictEqual(mock.readArray(mock.KEY_SESSIONS), trainingBefore);
  assert.deepStrictEqual(mock.readArray(mock.KEY_COACH_LESSONS), lessonsBefore);

  const historicalBefore = clone(mock.readArray(mock.KEY_COACH_SETTLEMENTS)[0]);
  const result = await data.settleCoach(COACH_OPENID, 'all');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.netAmount, 100);
  const settlements = mock.readArray(mock.KEY_COACH_SETTLEMENTS);
  assert.deepStrictEqual(settlements[0], historicalBefore);
  assertHistoricalSnapshot(settlements[0]);
  assert.strictEqual(settlements[1].commission, 0);
  assert.strictEqual(settlements[1].netAmount, 100);
}

function testCoachUiAndLegalCopyIsRetired() {
  const uiAndLegal = [
    'miniprogram/pages/coach/bookings/index.js',
    'miniprogram/pages/coach/bookings/index.wxml',
    'miniprogram/pages/shop/coach-settlement/index.wxml',
    'miniprogram/pages/legal/index.js'
  ].map(read).join('\n');
  ['抽佣5%', '平台服务费', '成交额的 5%', 'commissionText'].forEach((copy) => {
    assert(!uiAndLegal.includes(copy), `Coach UI/legal copy must not advertise ${copy}.`);
  });
  assert(!read('miniprogram/pages/shop/coach-settlement/index.wxml').includes('平台佣金'));
}

(async () => {
  await testCompatibilityCommissionMathIsZero();
  await testCloudBookingOmitsCommissionRate();
  await testCloudUnsettledValuesAndHistoricalSnapshots();
  await testLegacyCloudTrainingEntryIsRetiredBeforeWrites();
  await testMockPathsOmitCommissionAndUseZeroSettlement();
  testCoachUiAndLegalCopyIsRetired();
  console.log('coachCommissionRetirement tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
