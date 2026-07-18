'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const {
  buildPartnerJsapiBody,
  signClientPayment,
  snapshotReadyPaymentProfile
} = require(path.join(
  root,
  'cloudfunctions/createTablePayOrder/lib/table-payment.js'
));
const {
  createHandler: createPayOrderHandler
} = require(path.join(root, 'cloudfunctions/createTablePayOrder/index.js'));
const {
  applyVerifiedTransaction,
  officialSuccessTime
} = require(path.join(
  root,
  'cloudfunctions/createTablePayOrder/lib/payment-transition.js'
));
const {
  createCloudbasePaymentStore
} = require(path.join(
  root,
  'cloudfunctions/createTablePayOrder/lib/cloudbase-payment-store.js'
));
const {
  createNotifyHandler
} = require(path.join(root, 'cloudfunctions/tablePayNotifyV3/index.js'));
const {
  createReconcileHandler
} = require(path.join(root, 'cloudfunctions/reconcileTablePayments/index.js'));
const {
  assessSettlement
} = require(path.join(
  root,
  'cloudfunctions/_shared/table-profit-sharing/table-profit-sharing.js'
));
const {
  financialEventId,
  outTradeNoForOrderAttempt,
  splitNoForOrder
} = require(path.join(root, 'cloudfunctions/_shared/table-finance/state.js'));

const SP_APPID = 'wx1234567890abcdef';
const SUB_APPID = 'wxabcdef1234567890';
const SP_MCHID = '1234567890';
const SUB_MCHID = '1900000109';
const CHECKOUT_TOKEN = Buffer.from('0123456789abcdef').toString('base64url');

function readyProfile(overrides = {}) {
  return Object.assign({
    _id: 'shop-a',
    shopId: 'shop-a',
    schemaVersion: 1,
    status: 'ready',
    onboardingStatus: 'approved',
    contractStatus: 'signed',
    profitSharingAuthorizationStatus: 'authorized',
    paymentEnabled: true,
    profitSharingEnabled: true,
    tradeBillModeVerified: true,
    policyVersion: 'table_commission_v1',
    subMchid: SUB_MCHID,
    openidMode: 'sp_openid',
    subAppid: ''
  }, overrides);
}

function awaitingOrder(overrides = {}) {
  return Object.assign({
    _id: 'ord-a',
    orderId: 'ord-a',
    shopId: 'shop-a',
    policyVersion: 'table_commission_v1',
    quotedTableFeeFen: 12345,
    outTradeNo: 'pay_1234567890123456789012345678'
  }, overrides);
}

function serverConfig() {
  return {
    spAppId: SP_APPID,
    spMchid: SP_MCHID,
    tableNotifyUrl: 'https://pay.example.test/table/notify',
    merchantPrivateKey: 'SERVER_ONLY_PRIVATE_KEY'
  };
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function tokenHash(token) {
  return require('crypto').createHash('sha256').update(token, 'utf8').digest('hex');
}

function paymentState(overrides = {}) {
  const order = Object.assign({
    _id: 'ord-a',
    orderId: 'ord-a',
    schemaVersion: 2,
    _openid: 'shop-a',
    shopId: 'shop-a',
    storeId: 'store-a',
    tableId: 'table-a',
    sessionId: 'session-a',
    checkoutTokenHash: tokenHash(CHECKOUT_TOKEN),
    outTradeNo: 'pay_1234567890123456789012345678',
    splitNo: splitNoForOrder('ord-a'),
    tableGrossFen: 12345,
    tableDiscountFen: 0,
    quotedTableFeeFen: 12345,
    paidTableFeeFen: 12345,
    policyVersion: 'table_commission_v1',
    billingMode: 'table_commission',
    commissionRateBps: 500,
    includesChannelFee: true,
    splitCycle: 'T_PLUS_1',
    orderStatus: 'awaiting_payment',
    paymentStatus: 'unpaid',
    splitStatus: 'pending',
    payerOpenid: '',
    paymentProfileSnapshot: null,
    paymentClaim: null,
    prepayId: '',
    prepayExpiresAt: null,
    tableName: '一号桌',
    startedAt: 0,
    checkoutAt: 1_000,
    actualDurationMs: 1_000,
    refundedTableFeeFen: 0
  }, overrides);
  return {
    shop_orders: [order],
    sessions: [{
      _id: 'session-a',
      schemaVersion: 2,
      _openid: 'shop-a',
      shopId: 'shop-a',
      storeId: 'store-a',
      tableId: 'table-a',
      orderId: 'ord-a',
      status: 'awaiting_payment',
      startedAt: 0,
      checkoutAt: 1_000,
      closedAt: null,
      memberOpenid: 'member-a',
      memberCheckinId: 'checkin-a',
      memberCheckinJoinedAt: 0,
      memberReadyAt: 0,
      coachOpenid: 'coach-a',
      coachCheckinId: 'coach-checkin-a',
      coachCheckinJoinedAt: 0,
      coachReadyAt: 0,
      coachLinkId: 'coach-link-a',
      coachJoinedAt: 500
    }],
    stores: [{
      _id: 'store-a',
      _openid: 'shop-a',
      name: '甲球厅'
    }],
    checkin_requests: [{
      _id: 'checkin-a',
      memberOpenid: 'member-a',
      storeId: 'store-a',
      tableId: 'table-a',
      role: 'member',
      ready: true,
      joinedAt: 0,
      readyAt: 0,
      status: 'confirmed',
      sessionId: 'session-a',
      boundAt: 0
    }, {
      _id: 'coach-checkin-a',
      memberOpenid: 'coach-a',
      storeId: 'store-a',
      tableId: 'table-a',
      role: 'coach',
      ready: true,
      joinedAt: 0,
      readyAt: 0,
      status: 'confirmed',
      sessionId: 'session-a',
      boundAt: 0
    }],
    shop_coach_links: [{
      _id: 'coach-link-a',
      shopOpenid: 'shop-a',
      coachOpenid: 'coach-a',
      status: 'active'
    }],
    shop_payment_profiles: [readyProfile()],
    financial_events: [],
    table_occupancies: [],
    training_sessions: [],
    coach_lessons: []
  };
}

class MemoryStore {
  constructor(state) {
    this.state = state;
    this.inTransaction = false;
    this.transactions = 0;
    this.writes = 0;
  }

  async findOrdersByTokenHash(hash, limit) {
    return clone(this.state.shop_orders.filter(
      (order) => order.checkoutTokenHash === hash
    ).slice(0, limit));
  }

  async findOrdersByOutTradeNo(outTradeNo, limit) {
    return clone(this.state.shop_orders.filter(
      (order) => order.outTradeNo === outTradeNo
        || (
          Array.isArray(order.previousOutTradeNos)
          && order.previousOutTradeNos.includes(outTradeNo)
        )
    ).slice(0, limit));
  }

  async listReconcileCandidates(now, limit) {
    this.lastReconcileNow = now;
    this.lastReconcileLimit = limit;
    return clone(this.state.shop_orders.filter((order) => (
      order.schemaVersion === 2
      && order.orderStatus === 'awaiting_payment'
      && order.paymentStatus === 'unpaid'
      && Number.isSafeInteger(order.paymentClaim.nextReconcileAt)
      && order.paymentClaim.nextReconcileAt <= now
      && (
        order.paymentClaim.status === 'uncertain'
        || (
          order.paymentClaim.status === 'creating'
          && order.paymentClaim.leaseExpiresAt <= now
        )
        || (
          order.paymentClaim.status === 'prepay_ready'
          && order.prepayExpiresAt <= now
        )
      )
    )).sort((left, right) => (
      left.paymentClaim.nextReconcileAt - right.paymentClaim.nextReconcileAt
      || left.paymentClaim.claimedAt - right.paymentClaim.claimedAt
      || left._id.localeCompare(right._id)
    )).slice(0, limit));
  }

  async runTransaction(work) {
    assert.strictEqual(this.inTransaction, false, 'transactions must not nest');
    const draft = clone(this.state);
    this.inTransaction = true;
    this.transactions += 1;
    const find = (collection, id) => (
      draft[collection].find((item) => item._id === id) || null
    );
    const tx = {
      getOrder: async (id) => clone(find('shop_orders', id)),
      getSession: async (id) => clone(find('sessions', id)),
      getStore: async (id) => clone(find('stores', id)),
      getPaymentProfile: async (id) => clone(find('shop_payment_profiles', id)),
      getFinancialEvent: async (id) => clone(find('financial_events', id)),
      getOccupancy: async (id) => clone(find('table_occupancies', id)),
      getVerifiedTraining: async (id) => clone(find('training_sessions', id)),
      getVerifiedCoachLesson: async (id) => clone(find('coach_lessons', id)),
      getEntitlementCheckin: async (id) => clone(find('checkin_requests', id)),
      getCoachLink: async (id) => clone(find('shop_coach_links', id)),
      updateOrder: async (id, patch) => {
        const target = find('shop_orders', id);
        if (!target) throw new Error('order missing');
        Object.assign(target, clone(patch));
        this.writes += 1;
      },
      updateSession: async (id, patch) => {
        const target = find('sessions', id);
        if (!target) throw new Error('session missing');
        Object.assign(target, clone(patch));
        this.writes += 1;
      },
      setFinancialEvent: async (id, document) => {
        if (find('financial_events', id)) throw new Error('event exists');
        draft.financial_events.push(Object.assign({ _id: id }, clone(document)));
        this.writes += 1;
      },
      setVerifiedTraining: async (id, document) => {
        if (find('training_sessions', id)) throw new Error('training exists');
        draft.training_sessions.push(Object.assign({ _id: id }, clone(document)));
        this.writes += 1;
      },
      setVerifiedCoachLesson: async (id, document) => {
        if (find('coach_lessons', id)) throw new Error('coach lesson exists');
        draft.coach_lessons.push(Object.assign({ _id: id }, clone(document)));
        this.writes += 1;
      },
      removeOccupancy: async (id) => {
        const index = draft.table_occupancies.findIndex((item) => item._id === id);
        if (index >= 0) draft.table_occupancies.splice(index, 1);
        this.writes += 1;
      }
    };
    try {
      const result = await work(tx);
      Object.keys(this.state).forEach((key) => {
        this.state[key].splice(0, this.state[key].length, ...draft[key]);
      });
      return result;
    } finally {
      this.inTransaction = false;
    }
  }

  serverDate() {
    return 'SERVER_DATE';
  }
}

function paymentProfileSnapshot() {
  return {
    spAppid: SP_APPID,
    spMchid: SP_MCHID,
    subAppid: null,
    subMchid: SUB_MCHID,
    openidMode: 'sp_openid',
    profileSchemaVersion: 1,
    policyVersion: 'table_commission_v1'
  };
}

function occupancyIdFor(storeId, tableId) {
  return `${storeId.length}_${storeId}__${tableId}`;
}

function claimedPaymentState() {
  const state = paymentState({
    payerOpenid: 'payer-a',
    paymentProfileSnapshot: paymentProfileSnapshot(),
    paymentClaim: {
      attemptId: 'attempt-existing',
      status: 'uncertain',
      claimedAt: 1_783_958_300_000,
      leaseExpiresAt: 1_783_958_420_000,
      nextReconcileAt: 1_783_958_420_000
    }
  });
  state.table_occupancies.push({
    _id: occupancyIdFor('store-a', 'table-a'),
    shopId: 'shop-a',
    storeId: 'store-a',
    tableId: 'table-a',
    sessionId: 'session-a',
    status: 'awaiting_payment'
  });
  state.table_occupancies.push({
    _id: occupancyIdFor('store-new', 'table-new'),
    shopId: 'shop-a',
    storeId: 'store-new',
    tableId: 'table-new',
    sessionId: 'session-new',
    status: 'active'
  });
  return state;
}

function verifiedTransaction(overrides = {}) {
  const base = {
    sp_appid: SP_APPID,
    sp_mchid: SP_MCHID,
    sub_mchid: SUB_MCHID,
    out_trade_no: 'pay_1234567890123456789012345678',
    transaction_id: '4200001234567890',
    trade_type: 'JSAPI',
    trade_state: 'SUCCESS',
    success_time: '2026-07-14T16:00:00+08:00',
    payer: { sp_openid: 'payer-a' },
    amount: {
      total: 12345,
      payer_total: 12000,
      currency: 'CNY',
      payer_currency: 'CNY'
    },
    promotion_detail: [{
      coupon_id: 'coupon-a',
      name: 'Discount',
      amount: 345,
      currency: 'CNY'
    }]
  };
  return Object.assign(base, clone(overrides));
}

function signedFields(input) {
  return {
    timeStamp: input.timeStamp,
    nonceStr: input.nonceStr,
    package: `prepay_id=${input.prepayId}`,
    signType: 'RSA',
    paySign: 'signed-value'
  };
}

function createPayHarness(options = {}) {
  const state = options.state || paymentState();
  const store = options.store || new MemoryStore(state);
  const calls = { create: [], query: [], sign: [] };
  let now = options.now === undefined ? 1_783_958_400_000 : options.now;
  let randomByte = 1;
  const client = options.client || {
    async createJsapi(body) {
      assert.strictEqual(store.inTransaction, false, 'network call ran inside transaction');
      assert.strictEqual(
        state.shop_orders[0].paymentClaim.nextReconcileAt,
        state.shop_orders[0].paymentClaim.leaseExpiresAt,
        'the initial claim must schedule its first stale reconciliation'
      );
      calls.create.push(clone(body));
      return { prepay_id: 'wx-prepay-id' };
    },
    async queryByOutTradeNo(outTradeNo, query) {
      assert.strictEqual(store.inTransaction, false, 'query ran inside transaction');
      calls.query.push({ outTradeNo, query: clone(query) });
      return { trade_state: 'NOTPAY' };
    }
  };
  const context = Object.assign({
    OPENID: 'payer-a',
    APPID: SP_APPID
  }, options.context);
  const handler = createPayOrderHandler({
    store,
    getContext: () => clone(context),
    loadConfig: () => serverConfig(),
    createWechatPayClient: () => client,
    signMiniProgramPayment(input) {
      calls.sign.push(clone(input));
      return signedFields(input);
    },
    randomBytes(length) {
      return Buffer.alloc(length, randomByte++);
    },
    nowMs: () => now,
    applyVerifiedTransaction: options.applyVerifiedTransaction || (async () => ({ status: 'success' }))
  });
  return {
    state,
    store,
    calls,
    context,
    handler,
    setNow(value) { now = value; }
  };
}

function testReadyPaymentProfileValidation() {
  const order = awaitingOrder();
  const config = serverConfig();
  const snapshot = snapshotReadyPaymentProfile(readyProfile(), order, config);
  assert.deepStrictEqual(snapshot, {
    spAppid: SP_APPID,
    spMchid: SP_MCHID,
    subAppid: null,
    subMchid: SUB_MCHID,
    openidMode: 'sp_openid',
    profileSchemaVersion: 1,
    policyVersion: 'table_commission_v1'
  });
  assert.strictEqual(JSON.stringify(snapshot).includes('PRIVATE_KEY'), false);

  const invalidProfiles = [
    { status: 'pending' },
    { onboardingStatus: 'pending' },
    { contractStatus: 'unsigned' },
    { profitSharingAuthorizationStatus: 'pending' },
    { paymentEnabled: false },
    { profitSharingEnabled: false },
    { tradeBillModeVerified: false },
    { policyVersion: 'other_policy' },
    { subMchid: 'abc' },
    { openidMode: 'sp_openid', subAppid: SUB_APPID },
    { openidMode: 'sub_openid', subAppid: '' },
    { openidMode: 'sub_openid', subAppid: 'not-an-appid' }
  ];
  for (const override of invalidProfiles) {
    assert.throws(
      () => snapshotReadyPaymentProfile(readyProfile(override), order, config),
      /payment profile/i
    );
  }

  assert.deepStrictEqual(
    snapshotReadyPaymentProfile(
      readyProfile({ openidMode: 'sub_openid', subAppid: SUB_APPID }),
      order,
      config
    ),
    {
      spAppid: SP_APPID,
      spMchid: SP_MCHID,
      subAppid: SUB_APPID,
      subMchid: SUB_MCHID,
      openidMode: 'sub_openid',
      profileSchemaVersion: 1,
      policyVersion: 'table_commission_v1'
    }
  );
}

function testExactPartnerJsapiBody() {
  const order = awaitingOrder();
  const config = serverConfig();
  const spSnapshot = snapshotReadyPaymentProfile(readyProfile(), order, config);
  assert.deepStrictEqual(
    buildPartnerJsapiBody({
      order,
      paymentProfileSnapshot: spSnapshot,
      payerOpenid: 'payer-openid',
      config
    }),
    {
      sp_appid: SP_APPID,
      sp_mchid: SP_MCHID,
      sub_mchid: SUB_MCHID,
      description: 'CueTrace球桌费',
      out_trade_no: order.outTradeNo,
      notify_url: config.tableNotifyUrl,
      amount: { total: 12345, currency: 'CNY' },
      payer: { sp_openid: 'payer-openid' },
      settle_info: { profit_sharing: true }
    }
  );

  const subSnapshot = snapshotReadyPaymentProfile(
    readyProfile({ openidMode: 'sub_openid', subAppid: SUB_APPID }),
    order,
    config
  );
  assert.deepStrictEqual(
    buildPartnerJsapiBody({
      order,
      paymentProfileSnapshot: subSnapshot,
      payerOpenid: 'sub-payer-openid',
      config
    }),
    {
      sp_appid: SP_APPID,
      sp_mchid: SP_MCHID,
      sub_appid: SUB_APPID,
      sub_mchid: SUB_MCHID,
      description: 'CueTrace球桌费',
      out_trade_no: order.outTradeNo,
      notify_url: config.tableNotifyUrl,
      amount: { total: 12345, currency: 'CNY' },
      payer: { sub_openid: 'sub-payer-openid' },
      settle_info: { profit_sharing: true }
    }
  );
}

function testFiveFieldClientSigner() {
  const calls = [];
  const signed = signClientPayment({
    paymentProfileSnapshot: {
      spAppid: SP_APPID,
      spMchid: SP_MCHID,
      subAppid: null,
      subMchid: SUB_MCHID,
      openidMode: 'sp_openid',
      profileSchemaVersion: 1,
      policyVersion: 'table_commission_v1'
    },
    prepayId: 'wx-prepay-id',
    timeStamp: '1783958400',
    nonceStr: '0123456789abcdef0123456789abcdef',
    merchantPrivateKey: 'SERVER_ONLY_PRIVATE_KEY',
    signMiniProgramPayment(input) {
      calls.push(input);
      return {
        timeStamp: input.timeStamp,
        nonceStr: input.nonceStr,
        package: 'prepay_id=' + input.prepayId,
        signType: 'RSA',
        paySign: 'signed-value',
        prepay_id: input.prepayId,
        sp_mchid: SP_MCHID
      };
    }
  });

  assert.deepStrictEqual(calls, [{
    appId: SP_APPID,
    timeStamp: '1783958400',
    nonceStr: '0123456789abcdef0123456789abcdef',
    prepayId: 'wx-prepay-id',
    privateKey: 'SERVER_ONLY_PRIVATE_KEY'
  }]);
  assert.deepStrictEqual(Object.keys(signed), [
    'timeStamp',
    'nonceStr',
    'package',
    'signType',
    'paySign'
  ]);
  assert.deepStrictEqual(signed, {
    timeStamp: '1783958400',
    nonceStr: '0123456789abcdef0123456789abcdef',
    package: 'prepay_id=wx-prepay-id',
    signType: 'RSA',
    paySign: 'signed-value'
  });
}

function testOfficialSuccessTimeRejectsNormalizedCalendarValues() {
  assert.strictEqual(
    officialSuccessTime('2028-02-29T23:59:59.123+08:00'),
    Date.parse('2028-02-29T23:59:59.123+08:00')
  );
  for (const value of [
    '2026-02-29T16:00:00+08:00',
    '2026-02-30T16:00:00+08:00',
    '2026-04-31T16:00:00+08:00',
    '2026-07-14T24:00:00+08:00',
    '2026-07-14T16:60:00+08:00',
    '2026-07-14T16:00:60+08:00',
    '2026-07-14T16:00:00+24:00',
    '2026-07-14T16:00:00+08:60'
  ]) {
    assert.strictEqual(officialSuccessTime(value), null, value);
  }
}

async function testCreateClaimNetworkFinalizeAndIdempotency() {
  const harness = createPayHarness();
  const result = await harness.handler({ token: CHECKOUT_TOKEN });
  assert.deepStrictEqual(Object.keys(result), [
    'timeStamp', 'nonceStr', 'package', 'signType', 'paySign'
  ]);
  assert.strictEqual(result.package, 'prepay_id=wx-prepay-id');
  assert.strictEqual(harness.calls.create.length, 1);
  assert.deepStrictEqual(harness.calls.create[0], {
    sp_appid: SP_APPID,
    sp_mchid: SP_MCHID,
    sub_mchid: SUB_MCHID,
    description: 'CueTrace球桌费',
    out_trade_no: 'pay_1234567890123456789012345678',
    notify_url: 'https://pay.example.test/table/notify',
    amount: { total: 12345, currency: 'CNY' },
    payer: { sp_openid: 'payer-a' },
    settle_info: { profit_sharing: true }
  });
  const order = harness.state.shop_orders[0];
  assert.strictEqual(order.payerOpenid, 'payer-a');
  assert.strictEqual(order.paymentClaim.status, 'prepay_ready');
  assert.strictEqual(typeof order.paymentClaim.attemptId, 'string');
  assert.strictEqual(order.paymentClaim.claimedAt, 1_783_958_400_000);
  assert.strictEqual(order.paymentClaim.leaseExpiresAt, 1_783_958_520_000);
  assert.strictEqual(order.paymentClaim.nextReconcileAt, 1_783_965_600_000);
  assert.strictEqual(order.prepayId, 'wx-prepay-id');
  assert.strictEqual(order.prepayExpiresAt, 1_783_965_600_000);
  assert.strictEqual(order.paymentAttemptNo, 0);
  assert.deepStrictEqual(order.previousOutTradeNos, []);
  assert.deepStrictEqual(order.paymentRequestBody, harness.calls.create[0]);
  assert.deepStrictEqual(order.paymentProfileSnapshot, {
    spAppid: SP_APPID,
    spMchid: SP_MCHID,
    subAppid: null,
    subMchid: SUB_MCHID,
    openidMode: 'sp_openid',
    profileSchemaVersion: 1,
    policyVersion: 'table_commission_v1'
  });

  harness.setNow(1_783_958_401_000);
  const repeated = await harness.handler({ token: CHECKOUT_TOKEN });
  assert.deepStrictEqual(Object.keys(repeated), [
    'timeStamp', 'nonceStr', 'package', 'signType', 'paySign'
  ]);
  assert.strictEqual(harness.calls.create.length, 1, 'valid prepay must be re-signed');

  harness.context.OPENID = 'payer-b';
  const foreign = await harness.handler({ token: CHECKOUT_TOKEN });
  assert.deepStrictEqual(foreign, {
    ok: false,
    code: 'PAYER_MISMATCH',
    retryable: false
  });
  assert.strictEqual(harness.calls.create.length, 1);
}

async function testCreateGuardsAndSameAttemptFinalize() {
  for (const invalidToken of ['A'.repeat(22), CHECKOUT_TOKEN + '=', ' short ']) {
    const harness = createPayHarness();
    const before = clone(harness.state);
    const result = await harness.handler({ token: invalidToken });
    assert.deepStrictEqual(result, {
      ok: false,
      code: 'ORDER_NOT_FOUND',
      retryable: false
    });
    assert.deepStrictEqual(harness.state, before);
    assert.strictEqual(harness.calls.create.length, 0);
  }

  const collisionState = paymentState();
  collisionState.shop_orders.push(clone(collisionState.shop_orders[0]));
  collisionState.shop_orders[1]._id = 'ord-b';
  collisionState.shop_orders[1].orderId = 'ord-b';
  const collision = createPayHarness({ state: collisionState });
  assert.strictEqual((await collision.handler({ token: CHECKOUT_TOKEN })).code, 'ORDER_NOT_FOUND');
  assert.strictEqual(collision.store.transactions, 0);

  const wrongApp = createPayHarness({ context: { APPID: SUB_APPID } });
  const beforeWrongApp = clone(wrongApp.state);
  assert.strictEqual((await wrongApp.handler({ token: CHECKOUT_TOKEN })).code, 'APPID_MISMATCH');
  assert.deepStrictEqual(wrongApp.state, beforeWrongApp);
  assert.strictEqual(wrongApp.calls.create.length, 0);

  const disabledState = paymentState();
  disabledState.shop_payment_profiles[0].paymentEnabled = false;
  const disabled = createPayHarness({ state: disabledState });
  assert.strictEqual((await disabled.handler({ token: CHECKOUT_TOKEN })).code, 'PAYMENT_PROFILE_NOT_READY');
  assert.strictEqual(disabled.calls.create.length, 0);

  const creatingState = paymentState({
    payerOpenid: 'payer-a',
    paymentProfileSnapshot: {
      spAppid: SP_APPID,
      spMchid: SP_MCHID,
      subAppid: null,
      subMchid: SUB_MCHID,
      openidMode: 'sp_openid',
      profileSchemaVersion: 1,
      policyVersion: 'table_commission_v1'
    },
    paymentClaim: {
      attemptId: 'attempt-active',
      status: 'creating',
      claimedAt: 1_783_958_399_000,
      leaseExpiresAt: 1_783_958_500_000,
      nextReconcileAt: 1_783_958_500_000
    }
  });
  const creating = createPayHarness({ state: creatingState });
  assert.deepStrictEqual(await creating.handler({ token: CHECKOUT_TOKEN }), {
    ok: false,
    code: 'PAYMENT_CREATING',
    retryable: true
  });
  assert.strictEqual(creating.calls.create.length, 0);

  const raced = createPayHarness();
  raced.handler = createPayOrderHandler({
    store: raced.store,
    getContext: () => ({ OPENID: 'payer-a', APPID: SP_APPID }),
    loadConfig: () => serverConfig(),
    createWechatPayClient: () => ({
      async createJsapi() {
        assert.strictEqual(raced.store.inTransaction, false);
        raced.state.shop_orders[0].paymentClaim.attemptId = 'another-attempt';
        return { prepay_id: 'wx-prepay-id' };
      },
      async queryByOutTradeNo() { throw new Error('unexpected query'); }
    }),
    signMiniProgramPayment: signedFields,
    randomBytes: (length) => Buffer.alloc(length, 9),
    nowMs: () => 1_783_958_400_000,
    applyVerifiedTransaction: async () => ({ status: 'success' })
  });
  assert.deepStrictEqual(await raced.handler({ token: CHECKOUT_TOKEN }), {
    ok: false,
    code: 'PAYMENT_STATE_CHANGED',
    retryable: true
  });
  assert.strictEqual(raced.state.shop_orders[0].prepayId, '');
}

async function testAmbiguousCreateFailsClosedAndQueriesBeforeRetry() {
  const state = paymentState();
  const store = new MemoryStore(state);
  const calls = { createBodies: [], query: 0 };
  const handler = createPayOrderHandler({
    store,
    getContext: () => ({ OPENID: 'payer-a', APPID: SP_APPID }),
    loadConfig: () => serverConfig(),
    createWechatPayClient: () => ({
      async createJsapi(body) {
        assert.strictEqual(store.inTransaction, false);
        calls.createBodies.push(clone(body));
        throw new Error('transport failed');
      },
      async queryByOutTradeNo(outTradeNo, query) {
        assert.strictEqual(store.inTransaction, false);
        calls.query += 1;
        assert.strictEqual(outTradeNo, state.shop_orders[0].outTradeNo);
        assert.deepStrictEqual(query, { sp_mchid: SP_MCHID, sub_mchid: SUB_MCHID });
        return { trade_state: 'NOTPAY' };
      }
    }),
    signMiniProgramPayment: signedFields,
    randomBytes: (length) => Buffer.alloc(length, 7),
    nowMs: () => 1_783_958_400_000,
    applyVerifiedTransaction: async () => { throw new Error('must not settle NOTPAY'); }
  });

  assert.deepStrictEqual(await handler({ token: CHECKOUT_TOKEN }), {
    ok: false,
    code: 'PAYMENT_RECONCILIATION_REQUIRED',
    retryable: true
  });
  assert.strictEqual(state.shop_orders[0].paymentClaim.status, 'uncertain');
  assert.strictEqual(
    state.shop_orders[0].paymentClaim.nextReconcileAt,
    1_783_958_400_000
  );
  assert.strictEqual(calls.createBodies.length, 1);
  assert.strictEqual(calls.query, 0);

  assert.deepStrictEqual(await handler({ token: CHECKOUT_TOKEN }), {
    ok: false,
    code: 'PAYMENT_RECONCILIATION_REQUIRED',
    retryable: true
  });
  assert.strictEqual(calls.createBodies.length, 2);
  assert.strictEqual(calls.query, 1);
  assert.deepStrictEqual(
    calls.createBodies[1],
    calls.createBodies[0],
    'signed NOTPAY must retry the same out_trade_no with byte-equivalent business fields'
  );
}

async function testExpiredPrepayNotPayRecreatesSameOrderAndSignsFreshId() {
  const createBodies = [];
  const queries = [];
  const harness = createPayHarness({
    client: {
      async createJsapi(body) {
        createBodies.push(clone(body));
        return {
          prepay_id: createBodies.length === 1
            ? 'wx-prepay-first'
            : 'wx-prepay-fresh'
        };
      },
      async queryByOutTradeNo(outTradeNo, query) {
        queries.push({ outTradeNo, query: clone(query) });
        return { trade_state: 'NOTPAY' };
      }
    }
  });

  const first = await harness.handler({ token: CHECKOUT_TOKEN });
  assert.strictEqual(first.package, 'prepay_id=wx-prepay-first');
  const originalOutTradeNo = harness.state.shop_orders[0].outTradeNo;
  harness.setNow(1_783_958_400_000 + (2 * 60 * 60 * 1000));

  const recovered = await harness.handler({ token: CHECKOUT_TOKEN });
  assert.strictEqual(recovered.package, 'prepay_id=wx-prepay-fresh');
  assert.deepStrictEqual(queries, [{
    outTradeNo: originalOutTradeNo,
    query: { sp_mchid: SP_MCHID, sub_mchid: SUB_MCHID }
  }]);
  assert.strictEqual(createBodies.length, 2);
  assert.deepStrictEqual(createBodies[1], createBodies[0]);
  assert.strictEqual(harness.state.shop_orders[0].outTradeNo, originalOutTradeNo);
  assert.strictEqual(harness.state.shop_orders[0].paymentAttemptNo, 0);
  assert.deepStrictEqual(harness.state.shop_orders[0].previousOutTradeNos, []);
}

async function testClosedPaymentRotatesDeterministicOutTradeNoAndKeepsHistory() {
  const createBodies = [];
  const harness = createPayHarness({
    client: {
      async createJsapi(body) {
        createBodies.push(clone(body));
        return { prepay_id: `wx-prepay-${createBodies.length}` };
      },
      async queryByOutTradeNo() {
        return { trade_state: 'CLOSED' };
      }
    }
  });
  await harness.handler({ token: CHECKOUT_TOKEN });
  const originalOutTradeNo = harness.state.shop_orders[0].outTradeNo;
  harness.setNow(1_783_958_400_000 + (2 * 60 * 60 * 1000));

  const recovered = await harness.handler({ token: CHECKOUT_TOKEN });
  assert.strictEqual(recovered.package, 'prepay_id=wx-prepay-2');
  const order = harness.state.shop_orders[0];
  const rotatedOutTradeNo = outTradeNoForOrderAttempt(order.orderId, 1);
  assert.strictEqual(order.outTradeNo, rotatedOutTradeNo);
  assert.strictEqual(order.paymentAttemptNo, 1);
  assert.deepStrictEqual(order.previousOutTradeNos, [originalOutTradeNo]);
  assert.strictEqual(createBodies[0].out_trade_no, originalOutTradeNo);
  assert.strictEqual(createBodies[1].out_trade_no, rotatedOutTradeNo);
  const originalBusinessFields = clone(createBodies[0]);
  const rotatedBusinessFields = clone(createBodies[1]);
  delete originalBusinessFields.out_trade_no;
  delete rotatedBusinessFields.out_trade_no;
  assert.deepStrictEqual(rotatedBusinessFields, originalBusinessFields);
  assert.deepStrictEqual(
    (await harness.store.findOrdersByOutTradeNo(originalOutTradeNo, 2)).map((item) => item._id),
    ['ord-a']
  );
  assert.deepStrictEqual(
    (await harness.store.findOrdersByOutTradeNo(rotatedOutTradeNo, 2)).map((item) => item._id),
    ['ord-a']
  );
}

async function testConcurrentExpiredRecoveryCreatesOnlyOneFreshPrepay() {
  let createCalls = 0;
  let queryCalls = 0;
  let releaseFirstQuery;
  let signalFirstQuery;
  const firstQueryStarted = new Promise((resolve) => { signalFirstQuery = resolve; });
  const firstQueryGate = new Promise((resolve) => { releaseFirstQuery = resolve; });
  const harness = createPayHarness({
    client: {
      async createJsapi() {
        createCalls += 1;
        return {
          prepay_id: createCalls === 1
            ? 'wx-prepay-first'
            : 'wx-prepay-concurrent'
        };
      },
      async queryByOutTradeNo() {
        queryCalls += 1;
        if (queryCalls === 1) {
          signalFirstQuery();
          await firstQueryGate;
        }
        return { trade_state: 'NOTPAY' };
      }
    }
  });
  await harness.handler({ token: CHECKOUT_TOKEN });
  harness.setNow(1_783_958_400_000 + (2 * 60 * 60 * 1000));

  const firstRecovery = harness.handler({ token: CHECKOUT_TOKEN });
  await firstQueryStarted;
  const secondRecovery = await harness.handler({ token: CHECKOUT_TOKEN });
  releaseFirstQuery();
  const firstResult = await firstRecovery;

  assert.strictEqual(createCalls, 2, 'one initial and one recovery create are allowed');
  assert.strictEqual(queryCalls, 2);
  assert.strictEqual(firstResult.package, 'prepay_id=wx-prepay-concurrent');
  assert.strictEqual(secondRecovery.package, 'prepay_id=wx-prepay-concurrent');
}

async function testLateSuccessFromHistoricalAttemptIsIdempotentAndConflictsFailClosed() {
  const state = claimedPaymentState();
  const order = state.shop_orders[0];
  const originalOutTradeNo = order.outTradeNo;
  const rotatedOutTradeNo = outTradeNoForOrderAttempt(order.orderId, 1);
  order.paymentAttemptNo = 1;
  order.previousOutTradeNos = [originalOutTradeNo];
  order.outTradeNo = rotatedOutTradeNo;
  const store = new MemoryStore(state);
  const lateOriginalSuccess = verifiedTransaction({
    out_trade_no: originalOutTradeNo
  });

  assert.deepStrictEqual(
    await applyVerifiedTransaction({ store, transaction: lateOriginalSuccess }),
    { status: 'success', orderId: 'ord-a' }
  );
  assert.strictEqual(state.shop_orders[0].paidOutTradeNo, originalOutTradeNo);
  assert.deepStrictEqual(
    await applyVerifiedTransaction({ store, transaction: lateOriginalSuccess }),
    { status: 'duplicate', orderId: 'ord-a' }
  );

  const conflictingSuccess = verifiedTransaction({
    out_trade_no: rotatedOutTradeNo,
    transaction_id: '4200001234567891'
  });
  assert.deepStrictEqual(
    await applyVerifiedTransaction({ store, transaction: conflictingSuccess }),
    { status: 'mismatch', orderId: 'ord-a' }
  );
  assert.strictEqual(state.shop_orders[0].orderStatus, 'manual_review');
  assert.strictEqual(state.shop_orders[0].paymentStatus, 'paid');
  assert.strictEqual(
    state.financial_events.filter((event) => event.eventType === 'payment_succeeded').length,
    1,
    'a second successful attempt must never be counted twice'
  );
}

async function testDelayedTimerCannotOverwriteRecoveryClaim() {
  let createCalls = 0;
  let releaseRecoveryCreate;
  let signalRecoveryCreate;
  const recoveryCreateStarted = new Promise((resolve) => { signalRecoveryCreate = resolve; });
  const recoveryCreateGate = new Promise((resolve) => { releaseRecoveryCreate = resolve; });
  const harness = createPayHarness({
    client: {
      async createJsapi() {
        createCalls += 1;
        if (createCalls === 2) {
          signalRecoveryCreate();
          await recoveryCreateGate;
        }
        return { prepay_id: `wx-prepay-${createCalls}` };
      },
      async queryByOutTradeNo() {
        return { trade_state: 'NOTPAY' };
      }
    }
  });
  await harness.handler({ token: CHECKOUT_TOKEN });
  const now = 1_783_958_400_000 + (2 * 60 * 60 * 1000);
  harness.setNow(now);

  let releaseTimerQuery;
  let signalTimerQuery;
  const timerQueryStarted = new Promise((resolve) => { signalTimerQuery = resolve; });
  const timerQueryGate = new Promise((resolve) => { releaseTimerQuery = resolve; });
  const reconcile = createReconcileHandler({
    store: harness.store,
    getContext: () => ({}),
    loadConfig: () => serverConfig(),
    createWechatPayClient: () => ({
      async queryByOutTradeNo() {
        signalTimerQuery();
        await timerQueryGate;
        return { trade_state: 'NOTPAY' };
      }
    }),
    nowMs: () => now,
    applyVerifiedTransaction
  });
  const timerRun = reconcile({
    Type: 'Timer',
    TriggerName: 'reconcileTablePaymentsTimer'
  }, {});
  await timerQueryStarted;

  const recoveryRun = harness.handler({ token: CHECKOUT_TOKEN });
  await recoveryCreateStarted;
  const recoveryClaim = clone(harness.state.shop_orders[0].paymentClaim);
  assert.strictEqual(recoveryClaim.status, 'creating');
  releaseTimerQuery();
  assert.deepStrictEqual(await timerRun, { ok: true, scanned: 1, settled: 0 });
  assert.deepStrictEqual(
    harness.state.shop_orders[0].paymentClaim,
    recoveryClaim,
    'the stale timer snapshot must not mutate the newer creating claim'
  );
  releaseRecoveryCreate();
  assert.strictEqual(
    (await recoveryRun).package,
    'prepay_id=wx-prepay-2'
  );
}

async function testCreateTimeQueryReturnsTheTransitionOutcome() {
  const expectations = [
    ['success', { ok: false, code: 'PAYMENT_ALREADY_CONFIRMED', retryable: false }],
    ['duplicate', { ok: false, code: 'PAYMENT_ALREADY_CONFIRMED', retryable: false }],
    ['mismatch', { ok: false, code: 'PAYMENT_MANUAL_REVIEW', retryable: false }],
    ['unknown', { ok: false, code: 'PAYMENT_RECONCILIATION_REQUIRED', retryable: true }]
  ];
  for (const [status, expected] of expectations) {
    const state = claimedPaymentState();
    let transitionCalls = 0;
    const harness = createPayHarness({
      state,
      client: {
        async createJsapi() { throw new Error('must not recreate uncertain payment'); },
        async queryByOutTradeNo() { return verifiedTransaction(); }
      },
      applyVerifiedTransaction: async () => {
        transitionCalls += 1;
        return { status, orderId: 'ord-a' };
      }
    });
    assert.deepStrictEqual(await harness.handler({ token: CHECKOUT_TOKEN }), expected);
    assert.strictEqual(transitionCalls, 1);
    assert.strictEqual(harness.calls.create.length, 0);
  }
}

async function testVerifiedSuccessCouponAccountingAndIdempotency() {
  const state = claimedPaymentState();
  const store = new MemoryStore(state);
  const transaction = verifiedTransaction();
  const paidAt = Date.parse(transaction.success_time);
  const first = await applyVerifiedTransaction({ store, transaction });
  assert.deepStrictEqual(first, { status: 'success', orderId: 'ord-a' });
  const order = state.shop_orders[0];
  assert.strictEqual(order.orderStatus, 'complete');
  assert.strictEqual(order.paymentStatus, 'paid');
  assert.strictEqual(order.splitStatus, 'pending');
  assert.strictEqual(order.wechatTransactionId, transaction.transaction_id);
  assert.strictEqual(order.wechatSuccessTime, transaction.success_time);
  assert.strictEqual(order.paidAt, paidAt);
  assert.strictEqual(order.wechatOrderTotalFen, 12345);
  assert.strictEqual(order.wechatPayerTotalFen, 12000);
  assert.strictEqual(order.couponSubsidyFen, 345);
  assert.strictEqual(order.retainedCouponSubsidyFen, 345);
  assert.strictEqual(order.grossRefundedFen, 0);
  assert.strictEqual(order.couponRefundedFen, 0);
  assert.strictEqual(order.requestedRefundFen, 0);
  assert.strictEqual(order.splitReturnedFen, 0);
  assert.strictEqual(order.paidTableFeeFen, 12000);
  assert.strictEqual(order.totalCostFen, 600);
  assert.strictEqual(order.shopNetFen, 11400);
  assert.strictEqual(order.shopSettlementFen, 11745);
  assert.strictEqual(order.channelFeeFen, null);
  assert.strictEqual(order.platformNetFen, null);
  assert.strictEqual(state.sessions[0].status, 'closed');
  assert.strictEqual(state.sessions[0].closedAt, paidAt);
  assert.strictEqual(state.table_occupancies.length, 1);
  assert.strictEqual(state.table_occupancies[0].sessionId, 'session-new');
  assert.strictEqual(state.financial_events.length, 1);
  assert.strictEqual(state.financial_events[0].eventType, 'payment_succeeded');
  assert.strictEqual(state.training_sessions.length, 1);
  assert.deepStrictEqual(
    Object.fromEntries([
      '_id',
      '_openid',
      'memberOpenid',
      'shopId',
      'storeId',
      'tableId',
      'sessionId',
      'orderId',
      'hallId',
      'hallName',
      'verified',
      'verificationSource',
      'durationMinutes',
      'verifiedAt'
    ].map((key) => [key, state.training_sessions[0][key]])),
    {
      _id: 'verified_training_ord-a',
      _openid: 'member-a',
      memberOpenid: 'member-a',
      shopId: 'shop-a',
      storeId: 'store-a',
      tableId: 'table-a',
      sessionId: 'session-a',
      orderId: 'ord-a',
      hallId: 'store-a',
      hallName: '甲球厅',
      verified: true,
      verificationSource: 'platform_payment',
      durationMinutes: 1,
      verifiedAt: paidAt
    }
  );
  assert.strictEqual(state.coach_lessons.length, 1);
  assert.deepStrictEqual(
    Object.fromEntries([
      '_id',
      '_openid',
      'coachOpenid',
      'memberOpenid',
      'shopId',
      'storeId',
      'tableId',
      'sessionId',
      'orderId',
      'hallId',
      'hallName',
      'verified',
      'verificationSource',
      'durationMinutes',
      'amount',
      'settled',
      'verifiedAt'
    ].map((key) => [key, state.coach_lessons[0][key]])),
    {
      _id: 'verified_coach_lesson_ord-a',
      _openid: 'coach-a',
      coachOpenid: 'coach-a',
      memberOpenid: 'member-a',
      shopId: 'shop-a',
      storeId: 'store-a',
      tableId: 'table-a',
      sessionId: 'session-a',
      orderId: 'ord-a',
      hallId: 'store-a',
      hallName: '甲球厅',
      verified: true,
      verificationSource: 'platform_payment',
      durationMinutes: 1,
      amount: 0,
      settled: false,
      verifiedAt: paidAt
    }
  );

  const settlementOrder = clone(order);
  settlementOrder.channelFeeFen = 36;
  settlementOrder.platformNetFen = 564;
  settlementOrder.channelFeeEvidenceHash = 'a'.repeat(64);
  const settlementNow = Date.parse('2026-07-16T10:00:00+08:00');
  const feeEvent = {
    _id: financialEventId(
      'channel_fee_confirmed',
      `${settlementOrder.orderId}:${settlementOrder.channelFeeEvidenceHash}`
    ),
    eventType: 'channel_fee_confirmed',
    businessType: 'table_order',
    businessId: settlementOrder.orderId,
    orderId: settlementOrder.orderId,
    transactionId: settlementOrder.wechatTransactionId,
    channelFeeFen: settlementOrder.channelFeeFen,
    platformNetFen: settlementOrder.platformNetFen,
    evidenceHash: settlementOrder.channelFeeEvidenceHash,
    source: 'wechat_trade_bill',
    paymentBillDate: '2026-07-14',
    confirmedAtMs: Date.parse('2026-07-15T10:00:00+08:00'),
    artifacts: [{
      billDate: '2026-07-14',
      artifactId: 'trade-bill-20260714',
      sha1: 'b'.repeat(40)
    }],
    rows: [{
      kind: 'payment',
      billDate: '2026-07-14',
      artifactId: 'trade-bill-20260714',
      rowIdentityHash: 'c'.repeat(64),
      feeFen: 36,
      outTradeNo: settlementOrder.outTradeNo,
      transactionId: settlementOrder.wechatTransactionId,
      subMchid: settlementOrder.paymentProfileSnapshot.subMchid
    }]
  };
  assert.strictEqual(
    assessSettlement(
      settlementOrder,
      state.financial_events[0],
      feeEvent,
      { spAppId: SP_APPID, spMchid: SP_MCHID },
      settlementNow
    ).status,
    'eligible',
    'the verified payment output must enter profit sharing once fee evidence arrives'
  );

  const afterFirst = clone(state);
  const writesAfterFirst = store.writes;
  const duplicate = await applyVerifiedTransaction({ store, transaction });
  assert.deepStrictEqual(duplicate, { status: 'duplicate', orderId: 'ord-a' });
  assert.deepStrictEqual(state, afterFirst);
  assert.strictEqual(store.writes, writesAfterFirst);

  const inconsistentTerminalState = clone(afterFirst);
  inconsistentTerminalState.shop_orders[0].grossRefundedFen = 1;
  const inconsistentReplay = await applyVerifiedTransaction({
    store: new MemoryStore(inconsistentTerminalState),
    transaction
  });
  assert.strictEqual(inconsistentReplay.status, 'mismatch');
  assert.deepStrictEqual(
    inconsistentTerminalState.shop_orders[0].manualReviewReasonCodes,
    ['EXISTING_SUCCESS_CONFLICT']
  );

  state.stores[0].name = '乙球厅';
  const afterStoreRename = clone(state);
  const writesBeforeRenamedReplay = store.writes;
  const renamedReplay = await applyVerifiedTransaction({ store, transaction });
  assert.deepStrictEqual(renamedReplay, { status: 'duplicate', orderId: 'ord-a' });
  assert.deepStrictEqual(state, afterStoreRename);
  assert.strictEqual(store.writes, writesBeforeRenamedReplay);

  state.sessions[0].coachJoinedAt = 600;
  const afterCoachMetadataChange = clone(state);
  const writesBeforeCoachMetadataReplay = store.writes;
  const coachMetadataReplay = await applyVerifiedTransaction({ store, transaction });
  assert.deepStrictEqual(coachMetadataReplay, { status: 'duplicate', orderId: 'ord-a' });
  assert.deepStrictEqual(state, afterCoachMetadataChange);
  assert.strictEqual(store.writes, writesBeforeCoachMetadataReplay);

  const conflictingEntitlementState = claimedPaymentState();
  conflictingEntitlementState.training_sessions.push({
    _id: 'verified_training_ord-a',
    orderId: 'different-order',
    verified: false
  });
  conflictingEntitlementState.coach_lessons.push({
    _id: 'verified_coach_lesson_ord-a',
    orderId: 'different-order',
    amount: 99,
    verified: false
  });
  const conflictingEntitlementsBefore = clone({
    training_sessions: conflictingEntitlementState.training_sessions,
    coach_lessons: conflictingEntitlementState.coach_lessons
  });
  const conflictingStore = new MemoryStore(conflictingEntitlementState);
  assert.strictEqual((await applyVerifiedTransaction({
    store: conflictingStore,
    transaction: verifiedTransaction()
  })).status, 'success');
  assert.strictEqual(conflictingEntitlementState.shop_orders[0].orderStatus, 'manual_review');
  assert.strictEqual(conflictingEntitlementState.shop_orders[0].paymentStatus, 'paid');
  assert.strictEqual(
    conflictingEntitlementState.shop_orders[0].manualReviewReason,
    'entitlement_snapshot_conflict'
  );
  assert.deepStrictEqual(
    conflictingEntitlementState.shop_orders[0].manualReviewReasonCodes,
    ['COACH_LESSON_SNAPSHOT_CONFLICT', 'TRAINING_SNAPSHOT_CONFLICT']
  );
  assert.strictEqual(conflictingEntitlementState.sessions[0].status, 'closed');
  assert.strictEqual(conflictingEntitlementState.table_occupancies.length, 1);
  assert.deepStrictEqual(
    {
      training_sessions: conflictingEntitlementState.training_sessions,
      coach_lessons: conflictingEntitlementState.coach_lessons
    },
    conflictingEntitlementsBefore
  );
  assert.deepStrictEqual(
    conflictingEntitlementState.financial_events.find(
      (event) => event.eventType === 'entitlement_snapshot_conflict'
    ),
    {
      _id: financialEventId('entitlement_snapshot_conflict', 'ord-a'),
      eventType: 'entitlement_snapshot_conflict',
      businessType: 'table_order',
      businessId: 'ord-a',
      orderId: 'ord-a',
      reasonCodes: [
        'COACH_LESSON_SNAPSHOT_CONFLICT',
        'TRAINING_SNAPSHOT_CONFLICT'
      ],
      blocking: true,
      redacted: true,
      createdAt: 'SERVER_DATE'
    }
  );
  const afterEntitlementConflict = clone(conflictingEntitlementState);
  const writesAfterEntitlementConflict = conflictingStore.writes;
  assert.deepStrictEqual(
    await applyVerifiedTransaction({
      store: conflictingStore,
      transaction: verifiedTransaction()
    }),
    { status: 'duplicate', orderId: 'ord-a' }
  );
  assert.deepStrictEqual(conflictingEntitlementState, afterEntitlementConflict);
  assert.strictEqual(conflictingStore.writes, writesAfterEntitlementConflict);

  const uncoachedState = claimedPaymentState();
  uncoachedState.sessions[0].coachOpenid = '';
  uncoachedState.sessions[0].coachJoinedAt = null;
  assert.strictEqual((await applyVerifiedTransaction({
    store: new MemoryStore(uncoachedState),
    transaction: transaction
  })).status, 'success');
  assert.strictEqual(uncoachedState.training_sessions.length, 1);
  assert.strictEqual(uncoachedState.coach_lessons.length, 0);

  const untrustedMemberState = claimedPaymentState();
  untrustedMemberState.checkin_requests = [];
  assert.strictEqual((await applyVerifiedTransaction({
    store: new MemoryStore(untrustedMemberState),
    transaction: verifiedTransaction()
  })).status, 'success');
  assert.strictEqual(untrustedMemberState.shop_orders[0].paymentStatus, 'paid');
  assert.strictEqual(untrustedMemberState.training_sessions.length, 0);
  assert.strictEqual(untrustedMemberState.coach_lessons.length, 0);

  const unlinkedCoachState = claimedPaymentState();
  unlinkedCoachState.shop_coach_links = [];
  assert.strictEqual((await applyVerifiedTransaction({
    store: new MemoryStore(unlinkedCoachState),
    transaction: verifiedTransaction()
  })).status, 'success');
  assert.strictEqual(unlinkedCoachState.training_sessions.length, 1);
  assert.strictEqual(unlinkedCoachState.coach_lessons.length, 0);

  for (const mutate of [
    (state) => { state.sessions[0].coachCheckinId = 'other-checkin'; },
    (state) => { state.checkin_requests[1].role = 'member'; },
    (state) => { state.checkin_requests[1].memberOpenid = 'other-coach'; },
    (state) => { state.checkin_requests[1].storeId = 'other-store'; },
    (state) => { state.checkin_requests[1].tableId = 'other-table'; },
    (state) => { state.checkin_requests[1].status = 'pending'; },
    (state) => { state.checkin_requests[1].sessionId = 'historical-session'; },
    (state) => { state.checkin_requests[1].boundAt = 1; },
    (state) => { state.checkin_requests[1].joinedAt = 1; },
    (state) => { state.checkin_requests[1].readyAt = 1; }
  ]) {
    const untrustedCoachState = claimedPaymentState();
    mutate(untrustedCoachState);
    assert.strictEqual((await applyVerifiedTransaction({
      store: new MemoryStore(untrustedCoachState),
      transaction: verifiedTransaction()
    })).status, 'success');
    assert.strictEqual(untrustedCoachState.shop_orders[0].paymentStatus, 'paid');
    assert.strictEqual(untrustedCoachState.training_sessions.length, 1);
    assert.strictEqual(untrustedCoachState.coach_lessons.length, 0);
  }

  const staleCheckinsState = claimedPaymentState();
  staleCheckinsState.checkin_requests = [
    Object.assign({}, staleCheckinsState.checkin_requests[0], {
      _id: 'rejected-checkin',
      status: 'rejected'
    }),
    Object.assign({}, staleCheckinsState.checkin_requests[0], {
      _id: 'superseded-checkin',
      status: 'superseded'
    }),
    staleCheckinsState.checkin_requests[0],
    staleCheckinsState.checkin_requests[1]
  ];
  assert.strictEqual((await applyVerifiedTransaction({
    store: new MemoryStore(staleCheckinsState),
    transaction: verifiedTransaction()
  })).status, 'success');
  assert.strictEqual(staleCheckinsState.training_sessions.length, 1);
  assert.strictEqual(staleCheckinsState.coach_lessons.length, 1);

  for (const mutate of [
    (state) => { state.checkin_requests[0].sessionId = 'historical-session'; },
    (state) => { state.checkin_requests[0].boundAt = 1; },
    (state) => {
      state.shop_orders[0].startedAt = 2000000;
      state.shop_orders[0].checkoutAt = 2001000;
      state.shop_orders[0].actualDurationMs = 1000;
      state.sessions[0].startedAt = 2000000;
      state.sessions[0].checkoutAt = 2001000;
      state.sessions[0].memberReadyAt = 0;
      state.sessions[0].memberCheckinJoinedAt = 0;
      state.checkin_requests[0].readyAt = 0;
      state.checkin_requests[0].joinedAt = 0;
      state.checkin_requests[0].boundAt = 2000000;
    }
  ]) {
    const reusedCheckinState = claimedPaymentState();
    mutate(reusedCheckinState);
    const outcome = await applyVerifiedTransaction({
      store: new MemoryStore(reusedCheckinState),
      transaction: verifiedTransaction()
    });
    assert.strictEqual(outcome.status, 'success');
    assert.strictEqual(reusedCheckinState.shop_orders[0].paymentStatus, 'paid');
    assert.strictEqual(reusedCheckinState.training_sessions.length, 0);
    assert.strictEqual(reusedCheckinState.coach_lessons.length, 0);
  }

  const malformedOptionalMetadata = [
    {
      mutate(session) { session.memberOpenid = '   '; },
      trainingCount: 0
    },
    {
      mutate(session) { session.memberOpenid = 'm'.repeat(129); },
      trainingCount: 0
    },
    {
      mutate(session) { session.memberOpenid = 'member\u0000bad'; },
      trainingCount: 0
    },
    {
      mutate(session) { session.coachOpenid = '   '; },
      trainingCount: 1
    },
    {
      mutate(session) { session.coachJoinedAt = -1; },
      trainingCount: 1
    },
    {
      mutate(session) { session.coachJoinedAt = session.checkoutAt + 1; },
      trainingCount: 1
    }
  ];
  for (const testCase of malformedOptionalMetadata) {
    const malformedState = claimedPaymentState();
    testCase.mutate(malformedState.sessions[0]);
    const outcome = await applyVerifiedTransaction({
      store: new MemoryStore(malformedState),
      transaction: verifiedTransaction()
    });
    assert.strictEqual(outcome.status, 'success');
    assert.strictEqual(malformedState.shop_orders[0].orderStatus, 'complete');
    assert.strictEqual(malformedState.shop_orders[0].paymentStatus, 'paid');
    assert.strictEqual(malformedState.training_sessions.length, testCase.trainingCount);
    assert.strictEqual(malformedState.coach_lessons.length, 0);
  }

  const withoutPromotion = claimedPaymentState();
  const noPromotionTx = verifiedTransaction();
  delete noPromotionTx.promotion_detail;
  assert.strictEqual(
    (await applyVerifiedTransaction({
      store: new MemoryStore(withoutPromotion),
      transaction: noPromotionTx
    })).status,
    'success',
    'signed payer_total difference remains authoritative without optional detail'
  );

  const unicodeNameState = claimedPaymentState();
  const unicodeNameTx = verifiedTransaction();
  unicodeNameTx.promotion_detail[0].name = '中'.repeat(64);
  assert.strictEqual(
    (await applyVerifiedTransaction({
      store: new MemoryStore(unicodeNameState),
      transaction: unicodeNameTx
    })).status,
    'success',
    'a legal 64-character query coupon name must not be rejected by UTF-8 byte length'
  );
}

async function testVerifiedMismatchesEnterRedactedManualReview() {
  const mismatches = [
    (tx) => { tx.sp_appid = SUB_APPID; },
    (tx) => { tx.sp_mchid = '99999999'; },
    (tx) => { tx.sub_mchid = '88888888'; },
    (tx) => { tx.sub_appid = SUB_APPID; },
    (tx) => { tx.trade_type = 'APP'; },
    (tx) => { tx.trade_state = 'NOTPAY'; },
    (tx) => { tx.payer.sp_openid = 'payer-b'; },
    (tx) => { tx.amount.currency = 'USD'; },
    (tx) => { tx.amount.payer_currency = 'USD'; },
    (tx) => { tx.amount.total = 12344; },
    (tx) => { tx.amount.payer_total = 12346; },
    (tx) => { tx.transaction_id = ''; },
    (tx) => { tx.success_time = 'not-a-time'; },
    (tx) => { tx.promotion_detail[0].amount = 344; },
    (tx) => { tx.promotion_detail[0].name = '中'.repeat(65); },
    (tx) => { tx.promotion_detail[0].name = '优惠\u0085名称'; },
    (tx) => { tx.promotion_detail = { amount: 345 }; }
  ];
  for (const mutate of mismatches) {
    const state = claimedPaymentState();
    const store = new MemoryStore(state);
    const tx = verifiedTransaction();
    mutate(tx);
    const outcome = await applyVerifiedTransaction({ store, transaction: tx });
    assert.strictEqual(outcome.status, 'mismatch');
    assert.strictEqual(state.shop_orders[0].orderStatus, 'manual_review');
    assert.strictEqual(state.shop_orders[0].paymentStatus, 'unpaid');
    assert.strictEqual(state.sessions[0].status, 'awaiting_payment');
    assert.strictEqual(state.table_occupancies.length, 2);
    assert.strictEqual(state.training_sessions.length, 0);
    assert.strictEqual(state.coach_lessons.length, 0);
    assert.strictEqual(state.financial_events.length, 1);
    assert.strictEqual(state.financial_events[0].eventType, 'payment_mismatch');
    const serialized = JSON.stringify(state.financial_events[0]);
    assert.strictEqual(serialized.includes('4200001234567890'), false);
    assert.strictEqual(serialized.includes('payer-a'), false);
  }

  const wrongOrder = claimedPaymentState();
  const wrongOrderTx = verifiedTransaction({ out_trade_no: 'pay_wrong_order' });
  const wrongOrderResult = await applyVerifiedTransaction({
    store: new MemoryStore(wrongOrder),
    transaction: wrongOrderTx,
    expectedOrderId: 'ord-a'
  });
  assert.strictEqual(wrongOrderResult.status, 'mismatch');
  assert.strictEqual(wrongOrder.shop_orders[0].orderStatus, 'manual_review');

  const unknown = claimedPaymentState();
  const beforeUnknown = clone(unknown);
  const unknownResult = await applyVerifiedTransaction({
    store: new MemoryStore(unknown),
    transaction: verifiedTransaction({ out_trade_no: 'pay_unknown_order' })
  });
  assert.strictEqual(unknownResult.status, 'unknown');
  assert.deepStrictEqual(unknown, beforeUnknown);

  const corruptSnapshot = claimedPaymentState();
  corruptSnapshot.shop_orders[0].paymentProfileSnapshot = null;
  const corruptResult = await applyVerifiedTransaction({
    store: new MemoryStore(corruptSnapshot),
    transaction: verifiedTransaction()
  });
  assert.strictEqual(corruptResult.status, 'mismatch');
  assert.strictEqual(corruptSnapshot.shop_orders[0].orderStatus, 'manual_review');
}

async function testSuccessClosesOnlyMatchingOccupancy() {
  const state = claimedPaymentState();
  state.table_occupancies[0].sessionId = 'newer-session';
  const result = await applyVerifiedTransaction({
    store: new MemoryStore(state),
    transaction: verifiedTransaction()
  });
  assert.strictEqual(result.status, 'success');
  assert.strictEqual(state.sessions[0].status, 'closed');
  assert.strictEqual(state.table_occupancies.length, 2);
  assert.strictEqual(state.table_occupancies[0].sessionId, 'newer-session');
}

async function testExistingFinancialEventSnapshotsAreImmutable() {
  const successState = claimedPaymentState();
  await applyVerifiedTransaction({
    store: new MemoryStore(successState),
    transaction: verifiedTransaction()
  });
  const successTemplate = clone(successState);
  const successEventMutations = [
    (event) => { event.eventType = 'other'; },
    (event) => { event.businessType = 'other'; },
    (event) => { event.businessId = 'other'; },
    (event) => { event.orderId = 'other'; },
    (event) => { event.transactionId = 'other'; },
    (event) => { event.successTime = '2026-07-14T16:00:01+08:00'; },
    (event) => { event.totalFen += 1; },
    (event) => { event.payerTotalFen += 1; },
    (event) => { event.couponSubsidyFen += 1; }
  ];
  for (const mutate of successEventMutations) {
    const state = clone(successTemplate);
    mutate(state.financial_events[0]);
    const outcome = await applyVerifiedTransaction({
      store: new MemoryStore(state),
      transaction: verifiedTransaction()
    });
    assert.strictEqual(outcome.status, 'mismatch');
    assert.strictEqual(state.shop_orders[0].orderStatus, 'manual_review');
    assert.deepStrictEqual(
      state.shop_orders[0].manualReviewReasonCodes,
      ['EXISTING_SUCCESS_CONFLICT']
    );
    assert.strictEqual(state.financial_events.length, 2);
    assert.strictEqual(state.financial_events[1].eventType, 'payment_mismatch');
  }

  const mismatchState = claimedPaymentState();
  const mismatchTransaction = verifiedTransaction();
  mismatchTransaction.amount.total -= 1;
  const mismatchStore = new MemoryStore(mismatchState);
  assert.strictEqual((await applyVerifiedTransaction({
    store: mismatchStore,
    transaction: mismatchTransaction
  })).status, 'mismatch');
  const exactReplayState = clone(mismatchState);
  const exactReplayStore = new MemoryStore(exactReplayState);
  assert.strictEqual((await applyVerifiedTransaction({
    store: exactReplayStore,
    transaction: mismatchTransaction
  })).status, 'mismatch');
  assert.deepStrictEqual(exactReplayState, mismatchState);
  assert.strictEqual(exactReplayStore.writes, 0);

  const conflictingMismatch = clone(mismatchState);
  conflictingMismatch.financial_events[0].reasonCodes = ['DIFFERENT_REASON'];
  const conflictOutcome = await applyVerifiedTransaction({
    store: new MemoryStore(conflictingMismatch),
    transaction: mismatchTransaction
  });
  assert.strictEqual(conflictOutcome.status, 'mismatch');
  assert.strictEqual(conflictingMismatch.shop_orders[0].orderStatus, 'manual_review');
  assert.deepStrictEqual(
    conflictingMismatch.shop_orders[0].manualReviewReasonCodes,
    ['EXISTING_MISMATCH_CONFLICT']
  );
  assert.strictEqual(conflictingMismatch.financial_events.length, 1);
}

async function testNotificationVerifiesRawBytesBeforeParsing() {
  const state = claimedPaymentState();
  const before = clone(state);
  const store = new MemoryStore(state);
  const rawBody = Buffer.from('{not-json', 'utf8');
  let verified = false;
  let decrypted = false;
  const handler = createNotifyHandler({
    store,
    loadConfig: () => ({
      apiV3Key: Buffer.alloc(32, 1),
      platformCertificates: new Map()
    }),
    extractWechatPayEvent(event) {
      assert.strictEqual(event.marker, 'raw-event');
      return {
        headers: { timestamp: '1', nonce: 'n', signature: 's', serial: 'x' },
        rawBody
      };
    },
    verifyWechatPaySignature(input) {
      verified = true;
      assert.strictEqual(input.rawBody, rawBody);
      throw new Error('forged');
    },
    decryptResource() {
      decrypted = true;
      throw new Error('must not decrypt');
    },
    nowSeconds: () => 1,
    applyVerifiedTransaction
  });
  const response = await handler({ marker: 'raw-event' });
  assert.deepStrictEqual(response, { statusCode: 400, body: '' });
  assert.strictEqual(verified, true);
  assert.strictEqual(decrypted, false);
  assert.deepStrictEqual(state, before);
  assert.strictEqual(store.transactions, 0);
}

async function testNotificationDecryptsStrictEnvelopeAndReturnsEmptySuccess() {
  const state = claimedPaymentState();
  const store = new MemoryStore(state);
  const transaction = verifiedTransaction();
  const outer = {
    id: 'notification-id',
    create_time: '2026-07-14T16:00:01+08:00',
    event_type: 'TRANSACTION.SUCCESS',
    resource_type: 'encrypt-resource',
    resource: {
      original_type: 'transaction',
      algorithm: 'AEAD_AES_256_GCM',
      ciphertext: 'ciphertext',
      associated_data: 'associated',
      nonce: '123456789012'
    },
    summary: '支付成功'
  };
  const rawBody = Buffer.from(JSON.stringify(outer), 'utf8');
  const calls = [];
  const handler = createNotifyHandler({
    store,
    loadConfig: () => ({
      apiV3Key: Buffer.alloc(32, 2),
      platformCertificates: new Map([['SERIAL', 'PUBLIC_KEY']])
    }),
    extractWechatPayEvent: () => ({
      headers: { timestamp: '10', nonce: 'nonce', signature: 'sig', serial: 'SERIAL' },
      rawBody
    }),
    verifyWechatPaySignature(input) {
      calls.push('verify');
      assert.strictEqual(input.rawBody, rawBody);
      return true;
    },
    decryptResource(input) {
      calls.push('decrypt');
      assert.deepStrictEqual(input.resource, outer.resource);
      return Buffer.from(JSON.stringify(transaction), 'utf8');
    },
    nowSeconds: () => 10,
    applyVerifiedTransaction: async (input) => {
      calls.push('transition');
      return applyVerifiedTransaction(input);
    }
  });
  assert.deepStrictEqual(await handler({}), { statusCode: 204, body: '' });
  assert.deepStrictEqual(calls, ['verify', 'decrypt', 'transition']);
  assert.strictEqual(state.shop_orders[0].paymentStatus, 'paid');

  const afterFirst = clone(state);
  assert.deepStrictEqual(await handler({}), { statusCode: 204, body: '' });
  assert.deepStrictEqual(state, afterFirst);

  for (const mutate of [
    (value) => { value.event_type = 'REFUND.SUCCESS'; },
    (value) => { value.resource_type = 'plain-resource'; },
    (value) => { value.resource.original_type = 'refund'; }
  ]) {
    const malformedOuter = clone(outer);
    mutate(malformedOuter);
    const malformedRaw = Buffer.from(JSON.stringify(malformedOuter), 'utf8');
    const untouched = claimedPaymentState();
    const malformedHandler = createNotifyHandler({
      store: new MemoryStore(untouched),
      loadConfig: () => ({ apiV3Key: Buffer.alloc(32), platformCertificates: new Map() }),
      extractWechatPayEvent: () => ({ headers: {}, rawBody: malformedRaw }),
      verifyWechatPaySignature: () => true,
      decryptResource: () => { throw new Error('envelope must be rejected first'); },
      nowSeconds: () => 10,
      applyVerifiedTransaction
    });
    assert.deepStrictEqual(await malformedHandler({}), { statusCode: 400, body: '' });
    assert.strictEqual(untouched.shop_orders[0].paymentStatus, 'unpaid');
  }
}

async function testReconcileTimerGuardAndAuthoritativeSuccessOnly() {
  const deniedState = claimedPaymentState();
  const deniedStore = new MemoryStore(deniedState);
  let deniedQueries = 0;
  const denied = createReconcileHandler({
    store: deniedStore,
    getContext: () => ({ OPENID: 'user-context' }),
    loadConfig: () => serverConfig(),
    createWechatPayClient: () => ({
      async queryByOutTradeNo() { deniedQueries += 1; }
    }),
    nowMs: () => 1_783_958_500_000,
    applyVerifiedTransaction
  });
  for (const event of [
    { Type: 'Timer', TriggerName: 'reconcileTablePaymentsTimer' },
    { Type: 'Timer', TriggerName: 'wrong' },
    { Type: 'Timer', TriggerName: 'reconcileTablePaymentsTimer', extra: true }
  ]) {
    assert.deepStrictEqual(await denied(event, {}), {
      ok: false,
      code: 'ACCESS_DENIED'
    });
  }
  assert.strictEqual(deniedQueries, 0);
  assert.strictEqual(deniedStore.transactions, 0);

  const notPaidState = claimedPaymentState();
  const notPaidStore = new MemoryStore(notPaidState);
  const queryCalls = [];
  const notPaid = createReconcileHandler({
    store: notPaidStore,
    getContext: () => ({}),
    loadConfig: () => serverConfig(),
    createWechatPayClient: () => ({
      async queryByOutTradeNo(outTradeNo, query) {
        assert.strictEqual(notPaidStore.inTransaction, false);
        queryCalls.push({ outTradeNo, query: clone(query) });
        return { trade_state: 'NOTPAY' };
      }
    }),
    nowMs: () => 1_783_958_500_000,
    applyVerifiedTransaction
  });
  assert.deepStrictEqual(await notPaid({
    Type: 'Timer',
    TriggerName: 'reconcileTablePaymentsTimer'
  }, {}), { ok: true, scanned: 1, settled: 0 });
  assert.deepStrictEqual(queryCalls, [{
    outTradeNo: 'pay_1234567890123456789012345678',
    query: { sp_mchid: SP_MCHID, sub_mchid: SUB_MCHID }
  }]);
  assert.strictEqual(notPaidStore.lastReconcileLimit, 20);
  assert.strictEqual(notPaidStore.lastReconcileNow, 1_783_958_500_000);
  assert.strictEqual(notPaidState.sessions[0].status, 'awaiting_payment');
  assert.strictEqual(notPaidState.table_occupancies.length, 2);

  const paidState = claimedPaymentState();
  const paidStore = new MemoryStore(paidState);
  const paid = createReconcileHandler({
    store: paidStore,
    getContext: () => ({}),
    loadConfig: () => serverConfig(),
    createWechatPayClient: () => ({
      async queryByOutTradeNo() { return verifiedTransaction(); }
    }),
    nowMs: () => 1_783_958_500_000,
    applyVerifiedTransaction
  });
  assert.deepStrictEqual(await paid({
    Type: 'Timer',
    TriggerName: 'reconcileTablePaymentsTimer'
  }, {}), { ok: true, scanned: 1, settled: 1 });
  assert.strictEqual(paidState.shop_orders[0].paymentStatus, 'paid');
  assert.strictEqual(paidState.sessions[0].status, 'closed');
}

async function testReconcileRotatesPastAStaleNotPayBatch() {
  const state = claimedPaymentState();
  const template = state.shop_orders[0];
  state.shop_orders = Array.from({ length: 25 }, (_unused, index) => {
    const suffix = String(index).padStart(2, '0');
    return Object.assign(clone(template), {
      _id: `ord-${suffix}`,
      orderId: `ord-${suffix}`,
      outTradeNo: `pay_rotate_${suffix}`,
      paymentClaim: Object.assign(clone(template.paymentClaim), {
        claimedAt: template.paymentClaim.claimedAt + index
      })
    });
  });
  const queried = [];
  let now = 1_783_958_500_000;
  const handler = createReconcileHandler({
    store: new MemoryStore(state),
    getContext: () => ({}),
    loadConfig: () => serverConfig(),
    createWechatPayClient: () => ({
      async queryByOutTradeNo(outTradeNo) {
        queried.push(outTradeNo);
        return { trade_state: 'NOTPAY' };
      }
    }),
    nowMs: () => now,
    applyVerifiedTransaction
  });
  const timer = {
    Type: 'Timer',
    TriggerName: 'reconcileTablePaymentsTimer'
  };

  assert.deepStrictEqual(await handler(timer, {}), {
    ok: true,
    scanned: 20,
    settled: 0
  });
  assert.deepStrictEqual(queried, Array.from(
    { length: 20 },
    (_unused, index) => `pay_rotate_${String(index).padStart(2, '0')}`
  ));

  queried.length = 0;
  now += 5 * 60 * 1000;
  assert.deepStrictEqual(await handler(timer, {}), {
    ok: true,
    scanned: 20,
    settled: 0
  });
  assert.deepStrictEqual(
    queried.slice(0, 5),
    Array.from(
      { length: 5 },
      (_unused, index) => `pay_rotate_${String(index + 20).padStart(2, '0')}`
    ),
    'a persistent retry schedule must rotate past the first stale batch'
  );
}

async function testReconcileDeferralDoesNotRegressANewerClaimSchedule() {
  const state = claimedPaymentState();
  const now = 1_783_958_500_000;
  const newerSchedule = now + 10 * 60 * 1000;
  const handler = createReconcileHandler({
    store: new MemoryStore(state),
    getContext: () => ({}),
    loadConfig: () => serverConfig(),
    createWechatPayClient: () => ({
      async queryByOutTradeNo() {
        state.shop_orders[0].paymentClaim.nextReconcileAt = newerSchedule;
        return { trade_state: 'NOTPAY' };
      }
    }),
    nowMs: () => now,
    applyVerifiedTransaction
  });

  assert.deepStrictEqual(await handler({
    Type: 'Timer',
    TriggerName: 'reconcileTablePaymentsTimer'
  }, {}), { ok: true, scanned: 1, settled: 0 });
  assert.strictEqual(
    state.shop_orders[0].paymentClaim.nextReconcileAt,
    newerSchedule,
    'a delayed timer must not overwrite a newer schedule for the same claim'
  );
}

async function testReconcileRotatesPastInvalidDatabaseCandidates() {
  const state = claimedPaymentState();
  const template = state.shop_orders[0];
  const invalidOrders = Array.from({ length: 20 }, (_unused, index) => {
    const suffix = String(index).padStart(2, '0');
    return Object.assign(clone(template), {
      _id: `dirty-${suffix}`,
      orderId: `dirty-${suffix}`,
      payerOpenid: '',
      outTradeNo: `pay_dirty_${suffix}`,
      paymentClaim: Object.assign(clone(template.paymentClaim), {
        claimedAt: template.paymentClaim.claimedAt + index
      })
    });
  });
  const validOrder = Object.assign(clone(template), {
    _id: 'valid-20',
    orderId: 'valid-20',
    outTradeNo: 'pay_valid_20',
    paymentClaim: Object.assign(clone(template.paymentClaim), {
      claimedAt: template.paymentClaim.claimedAt + 20
    })
  });
  state.shop_orders = invalidOrders.concat(validOrder);

  const queried = [];
  let now = 1_783_958_500_000;
  const handler = createReconcileHandler({
    store: new MemoryStore(state),
    getContext: () => ({}),
    loadConfig: () => serverConfig(),
    createWechatPayClient: () => ({
      async queryByOutTradeNo(outTradeNo) {
        queried.push(outTradeNo);
        return { trade_state: 'NOTPAY' };
      }
    }),
    nowMs: () => now,
    applyVerifiedTransaction
  });
  const timer = {
    Type: 'Timer',
    TriggerName: 'reconcileTablePaymentsTimer'
  };

  assert.deepStrictEqual(await handler(timer, {}), {
    ok: true,
    scanned: 0,
    settled: 0
  });
  assert.deepStrictEqual(queried, []);

  now += 5 * 60 * 1000;
  assert.deepStrictEqual(await handler(timer, {}), {
    ok: true,
    scanned: 1,
    settled: 0
  });
  assert.deepStrictEqual(
    queried,
    ['pay_valid_20'],
    'invalid database candidates must not permanently block a later valid order'
  );
}

async function testProductionStoreFiltersAndOrdersStaleCandidatesInDatabase() {
  const queries = [];
  const responses = {
    uncertain: [
      { _id: 'ord-c', paymentClaim: { nextReconcileAt: 30, claimedAt: 30 } },
      { _id: 'ord-a', paymentClaim: { nextReconcileAt: 20, claimedAt: 20 } }
    ],
    creating: [
      { _id: 'ord-b', paymentClaim: { nextReconcileAt: 10, claimedAt: 10 } },
      { _id: 'ord-a', paymentClaim: { nextReconcileAt: 20, claimedAt: 20 } }
    ],
    prepay_ready: [
      { _id: 'ord-d', paymentClaim: { nextReconcileAt: 10, claimedAt: 10 } }
    ]
  };
  const db = {
    command: {
      lte(value) { return { operator: 'lte', value }; },
      in(values) { return { operator: 'in', values: clone(values) }; }
    },
    collection(name) {
      assert.strictEqual(name, 'shop_orders');
      const record = { where: null, orderBy: [], limit: null };
      queries.push(record);
      return {
        where(value) { record.where = value; return this; },
        orderBy(field, direction) {
          record.orderBy.push([field, direction]);
          return this;
        },
        limit(value) { record.limit = value; return this; },
        async get() {
          const status = record.where['paymentClaim.status'];
          return { data: clone(responses[status] || []) };
        }
      };
    },
    runTransaction() { throw new Error('not used'); },
    serverDate() { return 'SERVER_DATE'; }
  };
  const store = createCloudbasePaymentStore(db);
  const candidates = await store.listReconcileCandidates(500, 3);
  assert.deepStrictEqual(candidates.map((item) => item._id), [
    'ord-b',
    'ord-d',
    'ord-a'
  ]);
  assert.strictEqual(queries.length, 3);
  assert.deepStrictEqual(
    queries.map((query) => query.where['paymentClaim.status']),
    ['uncertain', 'creating', 'prepay_ready']
  );
  for (const query of queries) {
    assert.deepStrictEqual(query.orderBy, [
      ['paymentClaim.nextReconcileAt', 'asc'],
      ['paymentClaim.claimedAt', 'asc'],
      ['_id', 'asc']
    ]);
    assert.strictEqual(query.limit, 3);
    assert.strictEqual(query.where.schemaVersion, 2);
    assert.strictEqual(query.where.orderStatus, 'awaiting_payment');
    assert.strictEqual(query.where.paymentStatus, 'unpaid');
    assert.deepStrictEqual(
      query.where['paymentClaim.nextReconcileAt'],
      { operator: 'lte', value: 500 }
    );
  }
  assert.deepStrictEqual(
    queries[1].where['paymentClaim.leaseExpiresAt'],
    { operator: 'lte', value: 500 }
  );
  assert.deepStrictEqual(
    queries[2].where.prepayExpiresAt,
    { operator: 'lte', value: 500 }
  );
}

async function testProductionStoreResolvesCurrentAndHistoricalOutTradeNos() {
  const queries = [];
  const db = {
    command: {
      lte(value) { return value; },
      in(values) { return { operator: 'in', values: clone(values) }; }
    },
    collection(name) {
      assert.strictEqual(name, 'shop_orders');
      const record = { where: null, limit: null };
      queries.push(record);
      return {
        where(value) { record.where = clone(value); return this; },
        limit(value) { record.limit = value; return this; },
        async get() {
          if (record.where.outTradeNo === 'pay-current') {
            return { data: [{ _id: 'ord-a', outTradeNo: 'pay-current' }] };
          }
          if (
            record.where.previousOutTradeNos
            && record.where.previousOutTradeNos.operator === 'in'
            && record.where.previousOutTradeNos.values[0] === 'pay-original'
          ) {
            return {
              data: [{
                _id: 'ord-a',
                outTradeNo: 'pay-current',
                previousOutTradeNos: ['pay-original']
              }]
            };
          }
          return { data: [] };
        }
      };
    },
    runTransaction() { throw new Error('not used'); },
    serverDate() { return 'SERVER_DATE'; }
  };
  const store = createCloudbasePaymentStore(db);
  assert.deepStrictEqual(
    (await store.findOrdersByOutTradeNo('pay-current', 2)).map((item) => item._id),
    ['ord-a']
  );
  assert.deepStrictEqual(
    (await store.findOrdersByOutTradeNo('pay-original', 2)).map((item) => item._id),
    ['ord-a']
  );
  assert.deepStrictEqual(
    queries.map((query) => query.where),
    [
      { outTradeNo: 'pay-current' },
      {
        previousOutTradeNos: {
          operator: 'in',
          values: ['pay-current']
        }
      },
      { outTradeNo: 'pay-original' },
      {
        previousOutTradeNos: {
          operator: 'in',
          values: ['pay-original']
        }
      }
    ]
  );
  assert(queries.every((query) => query.limit === 2));
}

async function testProductionStoreMapsVerifiedTrainingIntoThePaymentTransaction() {
  const records = new Map();
  const queryRecords = {
    stores: [{ _id: 'store-a', _openid: 'shop-a', name: '甲球厅' }],
    checkin_requests: [{
      _id: 'checkin-a',
      memberOpenid: 'member-a',
      storeId: 'store-a',
      tableId: 'table-a',
      role: 'member',
      ready: true,
      joinedAt: 0,
      readyAt: 0,
      status: 'confirmed',
      sessionId: 'session-a',
      boundAt: 0
    }],
    shop_coach_links: [{
      _id: 'link-a',
      shopOpenid: 'shop-a',
      coachOpenid: 'coach-a',
      status: 'active'
    }]
  };
  const writes = [];
  const transaction = {
    collection(name) {
      assert([
        'training_sessions',
        'coach_lessons',
        'stores',
        'checkin_requests',
        'shop_coach_links'
      ].includes(name));
      return {
        doc(id) {
          return {
            async get() {
              const saved = records.get(`${name}/${id}`);
              const fixture = (queryRecords[name] || []).find((item) => item._id === id);
              return { data: clone(saved || fixture || null) };
            },
            async set({ data }) {
              records.set(`${name}/${id}`, clone(data));
              writes.push({ name, id, data: clone(data) });
            }
          };
        }
      };
    }
  };
  const db = {
    command: {
      lte(value) { return value; },
      in(values) { return values; }
    },
    collection() { throw new Error('not used outside transaction'); },
    async runTransaction(work) { return work(transaction); },
    serverDate() { return 'SERVER_DATE'; }
  };
  const store = createCloudbasePaymentStore(db);
  await store.runTransaction(async (tx) => {
    assert.deepStrictEqual(await tx.getStore('store-a'), queryRecords.stores[0]);
    assert.deepStrictEqual(
      await tx.getEntitlementCheckin('checkin-a'),
      queryRecords.checkin_requests[0]
    );
    assert.deepStrictEqual(
      await tx.getCoachLink('link-a'),
      queryRecords.shop_coach_links[0]
    );
    assert.strictEqual(await tx.getVerifiedTraining('verified_training_ord-a'), null);
    await tx.setVerifiedTraining('verified_training_ord-a', {
      orderId: 'ord-a',
      verified: true
    });
    assert.deepStrictEqual(
      await tx.getVerifiedTraining('verified_training_ord-a'),
      {
        _id: 'verified_training_ord-a',
        orderId: 'ord-a',
        verified: true
      }
    );
    assert.strictEqual(await tx.getVerifiedCoachLesson('verified_coach_lesson_ord-a'), null);
    await tx.setVerifiedCoachLesson('verified_coach_lesson_ord-a', {
      orderId: 'ord-a',
      amount: 0,
      verified: true
    });
    assert.deepStrictEqual(
      await tx.getVerifiedCoachLesson('verified_coach_lesson_ord-a'),
      {
        _id: 'verified_coach_lesson_ord-a',
        orderId: 'ord-a',
        amount: 0,
        verified: true
      }
    );
  });
  assert.deepStrictEqual(writes, [
    {
      name: 'training_sessions',
      id: 'verified_training_ord-a',
      data: {
        _id: 'verified_training_ord-a',
        orderId: 'ord-a',
        verified: true
      }
    },
    {
      name: 'coach_lessons',
      id: 'verified_coach_lesson_ord-a',
      data: {
        _id: 'verified_coach_lesson_ord-a',
        orderId: 'ord-a',
        amount: 0,
        verified: true
      }
    }
  ]);
}

function testBackendFunctionsAreIndependentlyDeployable() {
  const functions = [
    'createTablePayOrder',
    'tablePayNotifyV3',
    'reconcileTablePayments'
  ];
  const adapterFiles = ['client.js', 'config.js', 'http-event.js', 'bill-parser.js'];
  const financeFiles = ['money.js', 'state.js'];
  for (const functionName of functions) {
    const functionRoot = path.join(root, 'cloudfunctions', functionName);
    const packageJson = JSON.parse(fs.readFileSync(
      path.join(functionRoot, 'package.json'),
      'utf8'
    ));
    assert.strictEqual(packageJson.main, 'index.js');
    assert.strictEqual(packageJson.dependencies['wx-server-sdk'], '~2.6.3');
    const indexText = fs.readFileSync(path.join(functionRoot, 'index.js'), 'utf8');
    assert.strictEqual(indexText.includes('../_shared'), false);
    for (const file of adapterFiles) {
      assert.deepStrictEqual(
        fs.readFileSync(path.join(functionRoot, 'lib/wechatpay-v3', file)),
        fs.readFileSync(path.join(root, 'cloudfunctions/_shared/wechatpay-v3', file))
      );
    }
    for (const file of financeFiles) {
      assert.deepStrictEqual(
        fs.readFileSync(path.join(functionRoot, 'lib/table-finance', file)),
        fs.readFileSync(path.join(root, 'cloudfunctions/_shared/table-finance', file))
      );
    }
    for (const file of [
      'table-payment.js',
      'payment-transition.js',
      'cloudbase-payment-store.js'
    ]) {
      assert.deepStrictEqual(
        fs.readFileSync(path.join(functionRoot, 'lib', file)),
        fs.readFileSync(path.join(root, 'cloudfunctions/_shared/table-payment', file))
      );
    }
  }
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(
      path.join(root, 'cloudfunctions/reconcileTablePayments/config.json'),
      'utf8'
    )),
    {
      triggers: [{
        name: 'reconcileTablePaymentsTimer',
        type: 'timer',
        config: '0 */5 * * * * *'
      }]
    }
  );
  assert.strictEqual(
    fs.existsSync(path.join(root, 'cloudfunctions/tablePaymentNotifyV3')),
    false
  );
}

const tests = [
  ['ready payment profile is strict and snapshots only non-secrets', testReadyPaymentProfileValidation],
  ['partner JSAPI body contains exactly the approved fields', testExactPartnerJsapiBody],
  ['client signer returns exactly five requestPayment fields', testFiveFieldClientSigner],
  ['official success time rejects normalized calendar and timezone values', testOfficialSuccessTimeRejectsNormalizedCalendarValues],
  ['create-pay claims, calls outside transactions, finalizes, and re-signs', testCreateClaimNetworkFinalizeAndIdempotency],
  ['create-pay guards identity/profile/concurrency and finalizes only its attempt', testCreateGuardsAndSameAttemptFinalize],
  ['ambiguous create fails closed and queries before retry', testAmbiguousCreateFailsClosedAndQueriesBeforeRetry],
  ['expired NOTPAY recreates the same order and returns a fresh signature', testExpiredPrepayNotPayRecreatesSameOrderAndSignsFreshId],
  ['CLOSED rotates a deterministic out-trade number and keeps history', testClosedPaymentRotatesDeterministicOutTradeNoAndKeepsHistory],
  ['concurrent expired recovery creates only one fresh prepay', testConcurrentExpiredRecoveryCreatesOnlyOneFreshPrepay],
  ['late historical success is idempotent and conflicting attempts fail closed', testLateSuccessFromHistoricalAttemptIsIdempotentAndConflictsFailClosed],
  ['delayed timer cannot overwrite a newer recovery claim', testDelayedTimerCannotOverwriteRecoveryClaim],
  ['create-time query returns the verified transition outcome', testCreateTimeQueryReturnsTheTransitionOutcome],
  ['verified success applies coupon accounting once', testVerifiedSuccessCouponAccountingAndIdempotency],
  ['verified mismatches enter redacted manual review', testVerifiedMismatchesEnterRedactedManualReview],
  ['verified success closes only matching occupancy', testSuccessClosesOnlyMatchingOccupancy],
  ['existing success and mismatch financial events are immutable', testExistingFinancialEventSnapshotsAreImmutable],
  ['notification verifies raw bytes before parsing', testNotificationVerifiesRawBytesBeforeParsing],
  ['notification decrypts a strict success envelope and returns an empty success', testNotificationDecryptsStrictEnvelopeAndReturnsEmptySuccess],
  ['reconciliation is timer-only and settles only authoritative success', testReconcileTimerGuardAndAuthoritativeSuccessOnly],
  ['reconciliation rotates past a stale NOTPAY batch', testReconcileRotatesPastAStaleNotPayBatch],
  ['reconciliation deferral cannot regress a newer claim schedule', testReconcileDeferralDoesNotRegressANewerClaimSchedule],
  ['reconciliation rotates past invalid database candidates', testReconcileRotatesPastInvalidDatabaseCandidates],
  ['production reconciliation query filters and orders stale candidates in the database', testProductionStoreFiltersAndOrdersStaleCandidatesInDatabase],
  ['production store resolves current and historical out-trade numbers', testProductionStoreResolvesCurrentAndHistoricalOutTradeNos],
  ['production payment store maps verified training in the same transaction', testProductionStoreMapsVerifiedTrainingIntoThePaymentTransaction],
  ['payment backends carry byte-identical local dependencies and metadata', testBackendFunctionsAreIndependentlyDeployable]
];

(async () => {
  for (const [name, test] of tests) {
    await test();
    console.log('ok - ' + name);
  }
  console.log(`table payment backend ok (${tests.length} tests)`);
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
