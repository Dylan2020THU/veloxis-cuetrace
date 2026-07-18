const assert = require('assert');
const crypto = require('crypto');
const Module = require('module');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tokenLib = require(path.join(
  root,
  'cloudfunctions/_shared/table-payment/checkout-token'
));
const stateLib = require(path.join(root, 'cloudfunctions/_shared/table-finance/state'));

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function bindingId(openid) {
  return crypto.createHash('sha256').update('wechat:' + openid).digest('hex');
}

function identity(openid) {
  const userId = bindingId(openid);
  return {
    binding: {
      _id: userId,
      _openid: openid,
      accountId: 'account_' + openid,
      account: 'login_' + openid
    },
    account: {
      _id: 'account_' + openid,
      _openid: openid,
      account: 'login_' + openid,
      status: 'active'
    },
    user: {
      _id: userId,
      _openid: openid,
      roles: ['shop'],
      currentRole: 'shop'
    }
  };
}

function occupancyId(storeId, tableId) {
  return String(storeId.length) + '_' + storeId + '__' + tableId;
}

function makeState() {
  const owner = identity('owner-openid');
  const foreign = identity('foreign-openid');
  const tableId = 'table_main';
  const storeId = 'store_main';
  const sessionId = 'session_active';
  const snapshot = {
    tableId,
    name: '一号桌',
    pricePerHourFen: 10000,
    pricePerHour: 100,
    pricingRuleVersion: 'hourly_exact_v1',
    minimumDurationMs: 0,
    billingStepMs: 1,
    roundingMode: 'nearest_fen'
  };
  return {
    wechat_bindings: [owner.binding, foreign.binding],
    accounts: [owner.account, foreign.account],
    users: [owner.user, foreign.user],
    stores: [{
      _id: storeId,
      _openid: 'owner-openid',
      name: '测试球厅',
      tableTypes: [clone(snapshot)]
    }],
    sessions: [{
      _id: sessionId,
      _openid: 'owner-openid',
      schemaVersion: 2,
      shopId: 'owner-openid',
      storeId,
      tableId,
      status: 'active',
      startedAt: 1000,
      checkoutAt: null,
      closedAt: null,
      orderId: '',
      checkoutBy: '',
      pricingSnapshot: snapshot
    }],
    table_occupancies: [{
      _id: occupancyId(storeId, tableId),
      shopId: 'owner-openid',
      storeId,
      tableId,
      sessionId,
      status: 'active'
    }],
    shop_orders: [],
    financial_events: [],
    shop_payment_profiles: []
  };
}

function matches(document, query) {
  return Object.keys(query || {}).every((key) => document[key] === query[key]);
}

function replaceState(target, source) {
  for (const key of Object.keys(target)) {
    if (Array.isArray(target[key])) target[key] = clone(source[key] || []);
  }
}

function makeDatabase(state) {
  const operations = { reads: [], writes: [], transactions: 0 };

  function facade(target, inTransaction) {
    return {
      collection(name) {
        if (!Array.isArray(target[name])) throw new Error('Unexpected collection: ' + name);
        const documents = target[name];

        function doc(id) {
          if (typeof id !== 'string' || !id || id.includes('/')) {
            throw new Error('Invalid document id');
          }
          return {
            async get() {
              operations.reads.push({ name, id, inTransaction });
              return { data: clone(documents.find((item) => item._id === id) || null) };
            },
            async set(payload) {
              operations.writes.push({ name, id, method: 'set', inTransaction });
              const next = Object.assign({}, clone(payload.data), { _id: id });
              const index = documents.findIndex((item) => item._id === id);
              if (index === -1) documents.push(next);
              else documents[index] = next;
              return { _id: id };
            },
            async update(payload) {
              operations.writes.push({ name, id, method: 'update', inTransaction });
              const index = documents.findIndex((item) => item._id === id);
              if (index === -1) throw new Error('Document not found');
              documents[index] = Object.assign({}, documents[index], clone(payload.data));
              return { stats: { updated: 1 } };
            },
            async remove() {
              operations.writes.push({ name, id, method: 'remove', inTransaction });
              const index = documents.findIndex((item) => item._id === id);
              if (index !== -1) documents.splice(index, 1);
              return { stats: { removed: index === -1 ? 0 : 1 } };
            }
          };
        }

        return {
          doc,
          where(query) {
            let maximum = Number.POSITIVE_INFINITY;
            const result = {
              limit(value) {
                maximum = value;
                return result;
              },
              async get() {
                operations.reads.push({ name, query: clone(query), limit: maximum, inTransaction });
                return {
                  data: clone(documents.filter((item) => matches(item, query)).slice(0, maximum))
                };
              }
            };
            return result;
          }
        };
      }
    };
  }

  const db = facade(state, false);
  db.serverDate = () => 'SERVER_DATE';
  db.runTransaction = async (callback) => {
    operations.transactions += 1;
    const working = clone(state);
    const result = await callback(facade(working, true));
    replaceState(state, working);
    return result;
  };
  db.__operations = operations;
  return db;
}

function makeHarness(state, initialOpenid) {
  let openid = initialOpenid;
  let qrBuffer = Buffer.from('PNG_BYTES');
  const qrCalls = [];
  const db = makeDatabase(state);
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database() {
      return db;
    },
    getWXContext() {
      return { OPENID: openid, APPID: 'wx1234567890abcdef' };
    },
    openapi: {
      wxacode: {
        async getUnlimited(input) {
          qrCalls.push(clone(input));
          return { buffer: Buffer.from(qrBuffer) };
        }
      }
    }
  };

  return {
    db,
    qrCalls,
    setOpenid(value) {
      openid = value;
    },
    setQrBuffer(value) {
      qrBuffer = Buffer.from(value);
    },
    load(relativeFile) {
      const originalLoad = Module._load;
      Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'wx-server-sdk') return cloud;
        return originalLoad.call(this, request, parent, isMain);
      };
      try {
        const filename = path.join(root, relativeFile);
        delete require.cache[require.resolve(filename)];
        return require(filename);
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

async function createOrder(state, harness) {
  const fn = harness.load('cloudfunctions/createTableOrder/index.js');
  return atTime(3601000, () => fn.main({ sessionId: 'session_active' }));
}

function orderFor(state) {
  const orderId = stateLib.orderIdForSession('session_active');
  return state.shop_orders.find((item) => item._id === orderId);
}

async function testCanonicalTokenAndHashOnlyOrderStorage() {
  for (let index = 0; index < 32; index += 1) {
    const token = tokenLib.generateCheckoutToken();
    assert(/^[A-Za-z0-9_-]{22}$/.test(token));
    assert.strictEqual(tokenLib.decodeCheckoutToken(token).length, 16);
    assert.strictEqual(tokenLib.hashCheckoutToken(token).length, 64);
  }
  for (const invalid of [
    '',
    'A'.repeat(21),
    'A'.repeat(21) + 'B',
    'A'.repeat(21) + '+',
    'A'.repeat(22) + '=',
    '中文'.repeat(11)
  ]) {
    assert.throws(() => tokenLib.decodeCheckoutToken(invalid), /checkout token/i);
  }

  const state = makeState();
  const harness = makeHarness(state, 'owner-openid');
  const created = await createOrder(state, harness);
  assert.strictEqual(created.ok, true);
  assert(/^[A-Za-z0-9_-]{22}$/.test(created.checkoutToken));
  assert(!Object.prototype.hasOwnProperty.call(created.quote, 'checkoutToken'));

  const order = orderFor(state);
  assert(order);
  assert.strictEqual(order.checkoutTokenHash, tokenLib.hashCheckoutToken(created.checkoutToken));
  assert(/^[0-9a-f]{64}$/.test(order.checkoutTokenHash));
  assert.strictEqual(order.quotedTableFeeFen, 10000);
  assert.strictEqual(order.paymentProfileSnapshot, null);
  assert.strictEqual(order.paymentClaim, null);
  assert.strictEqual(order.prepayId, '');
  assert.strictEqual(order.prepayExpiresAt, null);
  assert.strictEqual(order.paymentBillFeeEvidence, null);
  assert.strictEqual(order.paymentBillDiscoveryCompletedAt, null);
  assert(!JSON.stringify(order).includes(created.checkoutToken));

  const firstHash = order.checkoutTokenHash;
  const repeat = await createOrder(state, harness);
  assert.strictEqual(repeat.ok, true);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(repeat, 'checkoutToken'), false);
  assert.strictEqual(orderFor(state).checkoutTokenHash, firstHash);
}

async function testZeroFenQuoteDoesNotCreateOrLockAnOrder() {
  const state = makeState();
  state.sessions[0].pricingSnapshot.pricePerHourFen = 1;
  state.sessions[0].pricingSnapshot.pricePerHour = 0.01;
  const before = clone(state);
  const harness = makeHarness(state, 'owner-openid');
  const fn = harness.load('cloudfunctions/createTableOrder/index.js');
  const result = await atTime(1001, () => fn.main({ sessionId: 'session_active' }));

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'SESSION_SNAPSHOT_INVALID');
  assert.deepStrictEqual(state, before);
  assert.strictEqual(harness.db.__operations.writes.length, 0);
  assert.strictEqual(state.shop_orders.length, 0);
  assert.strictEqual(state.sessions[0].status, 'active');
  assert.strictEqual(state.table_occupancies.length, 1);
}

async function testPublicLookupIsPrivateCollisionSafeAndAllowlisted() {
  const state = makeState();
  const harness = makeHarness(state, 'owner-openid');
  const created = await createOrder(state, harness);
  const publicFn = harness.load('cloudfunctions/getTableCheckoutOrder/index.js');
  const result = await publicFn.main({ token: created.checkoutToken });

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(Object.keys(result.order), [
    'storeName',
    'tableName',
    'startedAt',
    'checkoutAt',
    'billedDurationMs',
    'pricePerHourFen',
    'tableGrossFen',
    'tableDiscountFen',
    'quotedTableFeeFen',
    'orderStatus',
    'paymentStatus',
    'canPay'
  ]);
  assert.strictEqual(result.order.storeName, '测试球厅');
  assert.strictEqual(result.order.tableName, '一号桌');
  assert.strictEqual(result.order.quotedTableFeeFen, 10000);
  assert.strictEqual(result.order.canPay, true);
  for (const secret of [
    'owner-openid',
    orderFor(state).outTradeNo,
    orderFor(state).checkoutTokenHash
  ]) {
    assert(!JSON.stringify(result).includes(secret));
  }

  orderFor(state).orderStatus = 'complete';
  orderFor(state).paymentStatus = 'paid';
  const terminal = await publicFn.main({ token: created.checkoutToken });
  assert.strictEqual(terminal.ok, true);
  assert.strictEqual(terminal.order.canPay, false);

  const readsBeforeMalformed = harness.db.__operations.reads.length;
  const malformed = await publicFn.main({ token: 'A'.repeat(21) + 'B' });
  assert.deepStrictEqual(malformed, {
    ok: false,
    code: 'CHECKOUT_NOT_FOUND',
    msg: 'Checkout order was not found'
  });
  assert.strictEqual(harness.db.__operations.reads.length, readsBeforeMalformed);

  const validUnknown = tokenLib.generateCheckoutToken();
  const unknown = await publicFn.main({ token: validUnknown });
  assert.strictEqual(unknown.code, 'CHECKOUT_NOT_FOUND');

  const duplicate = clone(orderFor(state));
  duplicate._id = 'duplicate_order';
  duplicate.orderId = 'duplicate_order';
  state.shop_orders.push(duplicate);
  const collision = await publicFn.main({ token: created.checkoutToken });
  assert.deepStrictEqual(collision, unknown);
}

async function testOwnerQrAndExplicitSafeRotation() {
  const state = makeState();
  const harness = makeHarness(state, 'owner-openid');
  const created = await createOrder(state, harness);
  const order = orderFor(state);
  const qrFn = harness.load('cloudfunctions/genTableCheckoutCode/index.js');

  const direct = await qrFn.main({
    orderId: order.orderId,
    token: created.checkoutToken
  });
  assert.deepStrictEqual(direct, {
    ok: true,
    imageBase64: Buffer.from('PNG_BYTES').toString('base64'),
    contentType: 'image/png'
  });
  assert.strictEqual(harness.qrCalls.length, 1);
  assert.deepStrictEqual(harness.qrCalls[0], {
    scene: 't=' + created.checkoutToken,
    page: 'pages/table-checkout/index',
    width: 430,
    checkPath: false,
    envVersion: 'release'
  });
  assert(harness.qrCalls[0].scene.length <= 32);

  harness.setOpenid('foreign-openid');
  const denied = await qrFn.main({
    orderId: order.orderId,
    token: created.checkoutToken
  });
  assert.strictEqual(denied.ok, false);
  assert.strictEqual(denied.code, 'ORDER_NOT_OWNED');
  assert.strictEqual(harness.qrCalls.length, 1);

  harness.setOpenid('owner-openid');
  const oldHash = order.checkoutTokenHash;
  const rotated = await qrFn.main({ orderId: order.orderId, rotate: true });
  assert.strictEqual(rotated.ok, true);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(rotated, 'token'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(rotated, 'checkoutToken'), false);
  assert.notStrictEqual(orderFor(state).checkoutTokenHash, oldHash);
  const rotatedScene = harness.qrCalls[1].scene;
  const rotatedToken = rotatedScene.slice(2);
  assert.strictEqual(tokenLib.hashCheckoutToken(rotatedToken), orderFor(state).checkoutTokenHash);

  const publicFn = harness.load('cloudfunctions/getTableCheckoutOrder/index.js');
  assert.strictEqual((await publicFn.main({ token: created.checkoutToken })).ok, false);
  assert.strictEqual((await publicFn.main({ token: rotatedToken })).ok, true);

  orderFor(state).payerOpenid = 'payer-openid';
  const bound = await qrFn.main({ orderId: order.orderId, rotate: true });
  assert.strictEqual(bound.ok, false);
  assert.strictEqual(bound.code, 'TOKEN_ROTATION_NOT_ALLOWED');

  orderFor(state).payerOpenid = '';
  orderFor(state).paymentClaim = { attemptId: 'attempt-one', status: 'uncertain' };
  const claimed = await qrFn.main({ orderId: order.orderId, rotate: true });
  assert.strictEqual(claimed.ok, false);
  assert.strictEqual(claimed.code, 'TOKEN_ROTATION_NOT_ALLOWED');

  const readsBeforeMalformed = harness.db.__operations.reads.length;
  const malformed = await qrFn.main({ orderId: order.orderId, token: 'x' });
  assert.strictEqual(malformed.code, 'CHECKOUT_NOT_FOUND');
  assert.strictEqual(harness.db.__operations.reads.length, readsBeforeMalformed);

  harness.setQrBuffer(Buffer.alloc(1024 * 1024 + 1));
  delete orderFor(state).paymentClaim;
  const oversized = await qrFn.main({ orderId: order.orderId, token: rotatedToken });
  assert.strictEqual(oversized.ok, false);
  assert.strictEqual(oversized.code, 'CHECKOUT_CODE_FAILED');
}

async function testExternalPaymentRejectsEveryPlatformAttemptMarker() {
  const markers = [
    { paymentClaim: { attemptId: 'attempt-one', status: 'creating' } },
    { paymentAttemptStatus: 'uncertain' },
    { prepayId: 'wx-prepay-id' },
    { paymentProfileSnapshot: { subMchid: '12345678' } },
    { payerOpenid: 'payer-openid' }
  ];
  for (const marker of markers) {
    const state = makeState();
    const harness = makeHarness(state, 'owner-openid');
    const created = await createOrder(state, harness);
    assert.strictEqual(created.ok, true);
    Object.assign(orderFor(state), marker);
    const beforeSession = clone(state.sessions[0]);
    const beforeOccupancy = clone(state.table_occupancies);
    const fn = harness.load('cloudfunctions/markTableOrderExternalPaid/index.js');
    const result = await atTime(3602000, () => fn.main({
      orderId: orderFor(state).orderId,
      reason: '线下收款'
    }));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'PLATFORM_PAYMENT_STARTED');
    assert.strictEqual(orderFor(state).orderStatus, 'awaiting_payment');
    assert.deepStrictEqual(state.sessions[0], beforeSession);
    assert.deepStrictEqual(state.table_occupancies, beforeOccupancy);
  }
}

function testDeployableTokenCopiesMatchCanonicalSource() {
  const fs = require('fs');
  const source = fs.readFileSync(path.join(
    root,
    'cloudfunctions/_shared/table-payment/checkout-token.js'
  ));
  for (const relative of [
    'cloudfunctions/createTableOrder/lib/checkout-token.js',
    'cloudfunctions/genTableCheckoutCode/lib/checkout-token.js',
    'cloudfunctions/getTableCheckoutOrder/lib/checkout-token.js'
  ]) {
    assert.deepStrictEqual(fs.readFileSync(path.join(root, relative)), source, relative);
  }
}

async function main() {
  const tests = [
    testCanonicalTokenAndHashOnlyOrderStorage,
    testZeroFenQuoteDoesNotCreateOrLockAnOrder,
    testPublicLookupIsPrivateCollisionSafeAndAllowlisted,
    testOwnerQrAndExplicitSafeRotation,
    testExternalPaymentRejectsEveryPlatformAttemptMarker,
    testDeployableTokenCopiesMatchCanonicalSource
  ];
  for (const test of tests) await test();
  console.log('table checkout token ok (' + tests.length + ' tests)');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
