'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const {
  createSettleHandler,
  createCloudbaseProfitSharingStore
} = require(path.join(
  root,
  'cloudfunctions/settleTableProfitSharing/index.js'
));
const {
  assessSettlement,
  unfreezeNoForOrder
} = require(path.join(
  root,
  'cloudfunctions/_shared/table-profit-sharing/table-profit-sharing.js'
));
const {
  financialEventId,
  splitNoForOrder
} = require(path.join(
  root,
  'cloudfunctions/_shared/table-finance/state.js'
));

const SP_APPID = 'wx1234567890abcdef';
const SP_MCHID = '1234567890';
const SUB_MCHID = '1900000109';
const TRANSACTION_ID = '42000000000000000000000000000001';
const OUT_TRADE_NO = 'pay_1234567890123456789012345678';
const ORDER_ID = 'ord-profit-sharing-a';
const EVIDENCE_HASH = 'a'.repeat(64);
const NOW = 1_784_044_800_000;
const LEASE_MS = 5 * 60 * 1000;
const PENDING_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const PAYMENT_BILL_DATE = '2026-07-13';
const ARTIFACT_ID = 'trade-bill-20260713';
const ARTIFACT_SHA1 = 'b'.repeat(40);
const PAYMENT_ROW_HASH = 'c'.repeat(64);
const CONFIRMED_AT_MS = Date.parse('2026-07-14T10:00:00+08:00');
const SPLIT_DESCRIPTION = 'CueTrace球桌服务费';
const UNFREEZE_DESCRIPTION = '解冻球厅剩余资金';

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
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

function settlementOrder(overrides = {}) {
  return Object.assign({
    _id: ORDER_ID,
    orderId: ORDER_ID,
    schemaVersion: 2,
    orderStatus: 'complete',
    paymentStatus: 'paid',
    splitStatus: 'pending',
    splitClaim: null,
    splitNo: splitNoForOrder(ORDER_ID),
    paymentProfileSnapshot: paymentProfileSnapshot(),
    policyVersion: 'table_commission_v1',
    billingMode: 'table_commission',
    commissionRateBps: 500,
    includesChannelFee: true,
    splitCycle: 'T_PLUS_1',
    outTradeNo: OUT_TRADE_NO,
    wechatTransactionId: TRANSACTION_ID,
    wechatSuccessTime: '2026-07-13T12:00:00+08:00',
    paidAt: NOW - 24 * 60 * 60 * 1000,
    wechatOrderTotalFen: 10200,
    wechatPayerTotalFen: 10000,
    couponSubsidyFen: 200,
    retainedCouponSubsidyFen: 200,
    paidTableFeeFen: 10000,
    totalCostFen: 500,
    channelFeeFen: 30,
    platformNetFen: 470,
    shopNetFen: 9500,
    shopSettlementFen: 9700,
    channelFeeEvidenceHash: EVIDENCE_HASH,
    financeAutomationBlocked: false,
    refundedTableFeeFen: 0,
    grossRefundedFen: 0,
    couponRefundedFen: 0,
    refundClaim: null
  }, overrides);
}

function paymentEvent(order = settlementOrder()) {
  return {
    _id: financialEventId('payment_succeeded', order.orderId),
    eventType: 'payment_succeeded',
    businessType: 'table_order',
    businessId: order.orderId,
    orderId: order.orderId,
    transactionId: order.wechatTransactionId,
    successTime: order.wechatSuccessTime,
    totalFen: order.wechatOrderTotalFen,
    payerTotalFen: order.wechatPayerTotalFen,
    couponSubsidyFen: order.couponSubsidyFen
  };
}

function feeEvent(order = settlementOrder()) {
  const refundFeeFen = order.paymentStatus === 'partially_refunded'
    ? -10
    : (order.paymentStatus === 'refunded' ? -30 : null);
  const rows = [{
    kind: 'payment',
    billDate: PAYMENT_BILL_DATE,
    artifactId: ARTIFACT_ID,
    rowIdentityHash: PAYMENT_ROW_HASH,
    feeFen: order.channelFeeFen - (refundFeeFen || 0),
    outTradeNo: order.outTradeNo,
    transactionId: order.wechatTransactionId,
    subMchid: order.paymentProfileSnapshot.subMchid
  }];
  if (refundFeeFen !== null) {
    rows.push({
      kind: 'refund',
      billDate: PAYMENT_BILL_DATE,
      artifactId: ARTIFACT_ID,
      rowIdentityHash: 'd'.repeat(64),
      feeFen: refundFeeFen,
      outTradeNo: order.outTradeNo,
      transactionId: order.wechatTransactionId,
      subMchid: order.paymentProfileSnapshot.subMchid,
      refundNo: 'refund_123456789012345678901234',
      wechatRefundId: '50300000000000000000000000000001'
    });
  }
  return {
    _id: financialEventId(
      'channel_fee_confirmed',
      `${order.orderId}:${order.channelFeeEvidenceHash}`
    ),
    eventType: 'channel_fee_confirmed',
    businessType: 'table_order',
    businessId: order.orderId,
    orderId: order.orderId,
    transactionId: order.wechatTransactionId,
    channelFeeFen: order.channelFeeFen,
    platformNetFen: order.platformNetFen,
    evidenceHash: order.channelFeeEvidenceHash,
    source: 'wechat_trade_bill',
    paymentBillDate: PAYMENT_BILL_DATE,
    confirmedAtMs: CONFIRMED_AT_MS,
    artifacts: [{
      billDate: PAYMENT_BILL_DATE,
      artifactId: ARTIFACT_ID,
      sha1: ARTIFACT_SHA1
    }],
    rows
  };
}

function settlementState(order = settlementOrder()) {
  return {
    shop_orders: [order],
    financial_events: [paymentEvent(order), feeEvent(order)],
    finance_anomalies: []
  };
}

class MemoryStore {
  constructor(state) {
    this.state = state;
    if (!Array.isArray(this.state.finance_anomalies)) {
      this.state.finance_anomalies = [];
    }
    this.inTransaction = false;
    this.transactions = 0;
    this.lastListNow = null;
    this.lastListLimit = null;
  }

  async listSettlementCandidates(now, limit) {
    this.lastListNow = now;
    this.lastListLimit = limit;
    return clone(this.state.shop_orders.filter((order) => {
      if (
        order.schemaVersion !== 2
        || order.orderStatus !== 'complete'
        || !['paid', 'partially_refunded', 'refunded'].includes(order.paymentStatus)
      ) return false;
      if (Object.prototype.hasOwnProperty.call(order, 'splitNextAttemptAt')) {
        if (
          !Number.isSafeInteger(order.splitNextAttemptAt)
          || order.splitNextAttemptAt < 0
          || order.splitNextAttemptAt > now
        ) return false;
      }
      if (['pending', 'failed'].includes(order.splitStatus)) return true;
      return order.splitStatus === 'processing'
        && order.splitClaim
        && Number.isSafeInteger(order.splitClaim.leaseExpiresAt)
        && order.splitClaim.leaseExpiresAt <= now;
    }).sort((left, right) => {
      const leftDue = Number.isSafeInteger(left.splitNextAttemptAt)
        ? left.splitNextAttemptAt
        : Number.MIN_SAFE_INTEGER;
      const rightDue = Number.isSafeInteger(right.splitNextAttemptAt)
        ? right.splitNextAttemptAt
        : Number.MIN_SAFE_INTEGER;
      return leftDue - rightDue
        || left.paidAt - right.paidAt
        || left._id.localeCompare(right._id);
    }).slice(0, limit));
  }

  async runTransaction(work) {
    assert.strictEqual(this.inTransaction, false, 'transactions must not nest');
    const draft = clone(this.state);
    const find = (collection, id) => (
      draft[collection].find((item) => item._id === id) || null
    );
    this.inTransaction = true;
    this.transactions += 1;
    try {
      const result = await work({
        getOrder: async (id) => clone(find('shop_orders', id)),
        getFinancialEvent: async (id) => clone(find('financial_events', id)),
        getFinanceAnomaly: async (id) => clone(find('finance_anomalies', id)),
        updateOrder: async (id, patch) => {
          const order = find('shop_orders', id);
          if (!order) throw new Error('order missing');
          Object.assign(order, clone(patch));
        },
        setFinancialEvent: async (id, document) => {
          if (find('financial_events', id)) throw new Error('event exists');
          draft.financial_events.push(Object.assign({ _id: id }, clone(document)));
        },
        setFinanceAnomaly: async (id, document) => {
          if (find('finance_anomalies', id)) throw new Error('anomaly exists');
          draft.finance_anomalies.push(Object.assign({ _id: id }, clone(document)));
        },
        updateFinanceAnomaly: async (id, patch) => {
          const anomaly = find('finance_anomalies', id);
          if (!anomaly) throw new Error('anomaly missing');
          Object.assign(anomaly, clone(patch));
        }
      });
      for (const collection of Object.keys(this.state)) {
        this.state[collection].splice(
          0,
          this.state[collection].length,
          ...draft[collection]
        );
      }
      return result;
    } finally {
      this.inTransaction = false;
    }
  }

  serverDate() {
    return 'SERVER_DATE';
  }
}

function serverConfig() {
  return {
    spAppId: SP_APPID,
    spMchid: SP_MCHID,
    platformReceiverName: '测试平台商户',
    encryptionKeyId: 'FACE1234',
    encryptionPublicKey: 'TRUSTED_PUBLIC_KEY'
  };
}

function splitFinished(order, overrides = {}) {
  return Object.assign({
    sub_mchid: SUB_MCHID,
    transaction_id: TRANSACTION_ID,
    out_order_no: order.splitNo,
    order_id: 'wechat-split-order',
    state: 'FINISHED',
    receivers: [{
      type: 'MERCHANT_ID',
      account: SP_MCHID,
      amount: order.platformNetFen,
      description: SPLIT_DESCRIPTION,
      result: 'SUCCESS',
      detail_id: 'wechat-split-detail'
    }]
  }, overrides);
}

function unfreezeFinished(order, overrides = {}) {
  return Object.assign({
    sub_mchid: SUB_MCHID,
    transaction_id: TRANSACTION_ID,
    out_order_no: unfreezeNoForOrder(order.orderId),
    order_id: 'wechat-unfreeze-order',
    state: 'FINISHED',
    receivers: [{
      type: 'MERCHANT_ID',
      account: SUB_MCHID,
      amount: order.shopSettlementFen,
      description: UNFREEZE_DESCRIPTION,
      result: 'SUCCESS',
      detail_id: 'wechat-unfreeze-detail'
    }]
  }, overrides);
}

function makeHandler(store, client, overrides = {}) {
  let attempt = 0;
  return createSettleHandler(Object.assign({
    store,
    getContext: () => ({}),
    loadConfig: () => serverConfig(),
    createWechatPayClient: () => client,
    encryptSensitiveField: (name, key) => {
      assert.strictEqual(name, '测试平台商户');
      assert.strictEqual(key, 'TRUSTED_PUBLIC_KEY');
      return 'ENCRYPTED_LEGAL_NAME';
    },
    nowMs: () => NOW,
    makeAttemptId: () => `attempt-${++attempt}`
  }, overrides));
}

const timer = Object.freeze({
  Type: 'Timer',
  TriggerName: 'settleTableProfitSharingTimer'
});

async function testTimerGuardIsExact() {
  const store = new MemoryStore(settlementState());
  let networkCalls = 0;
  const client = new Proxy({}, {
    get() {
      return async () => { networkCalls += 1; };
    }
  });
  for (const [event, context, runtimeContext] of [
    [{ Type: 'Timer', TriggerName: 'wrong' }, {}, {}],
    [{ ...timer, extra: true }, {}, {}],
    [timer, { OPENID: 'caller' }, {}],
    [timer, {}, { OPENID: 'caller' }]
  ]) {
    const handler = makeHandler(store, client, {
      getContext: () => runtimeContext
    });
    assert.deepStrictEqual(await handler(event, context), {
      ok: false,
      code: 'ACCESS_DENIED'
    });
  }
  assert.strictEqual(networkCalls, 0);
  assert.strictEqual(store.transactions, 0);
}

async function testEvidenceEligibilityAndRefundAwareRetainedAmounts() {
  const base = settlementOrder();
  const payment = paymentEvent(base);
  const fee = feeEvent(base);
  assert.strictEqual(
    assessSettlement(base, payment, fee, serverConfig(), NOW).status,
    'eligible'
  );
  assert.notStrictEqual(
    assessSettlement(base, payment, {
      ...fee,
      _id: financialEventId('channel_fee_confirmed', base.orderId)
    }, serverConfig(), NOW).status,
    'eligible',
    'an order-only fee event cannot authorize a newer evidence snapshot'
  );

  const malformedEvidence = [
    { ...fee, source: 'manual_import' },
    { ...fee, paymentBillDate: '2026-07-12' },
    { ...fee, confirmedAtMs: Date.parse('2026-07-14T09:59:59+08:00') },
    { ...fee, confirmedAtMs: NOW + 1 },
    {
      ...fee,
      artifacts: [{ ...fee.artifacts[0], sha1: 'e'.repeat(64) }]
    },
    {
      ...fee,
      rows: [{ ...fee.rows[0], feeFen: fee.rows[0].feeFen + 1 }]
    },
    {
      ...fee,
      rows: [{ ...fee.rows[0], outTradeNo: 'pay_wrong_1234567890123456789012' }]
    }
  ];
  for (const invalidFee of malformedEvidence) {
    assert.strictEqual(
      assessSettlement(base, payment, invalidFee, serverConfig(), NOW).status,
      'manual_review'
    );
  }

  const impossibleDate = settlementOrder({
    wechatSuccessTime: '2026-02-31T12:00:00+08:00'
  });
  const impossibleFee = feeEvent(impossibleDate);
  impossibleFee.paymentBillDate = '2026-02-31';
  impossibleFee.artifacts[0].billDate = '2026-02-31';
  impossibleFee.rows[0].billDate = '2026-02-31';
  assert.strictEqual(
    assessSettlement(
      impossibleDate,
      paymentEvent(impossibleDate),
      impossibleFee,
      serverConfig(),
      NOW
    ).status,
    'manual_review',
    'calendar-invalid official dates must not be normalized by Date.parse'
  );

  const partial = settlementOrder({
    paymentStatus: 'partially_refunded',
    paidTableFeeFen: 6000,
    totalCostFen: 300,
    channelFeeFen: 20,
    platformNetFen: 280,
    shopNetFen: 5700,
    retainedCouponSubsidyFen: 100,
    shopSettlementFen: 5800,
    refundedTableFeeFen: 4000,
    grossRefundedFen: 4100,
    couponRefundedFen: 100,
    refundClaim: { status: 'succeeded' },
    channelFeeEvidenceHash: 'b'.repeat(64)
  });
  assert.strictEqual(
    assessSettlement(
      partial,
      paymentEvent(partial),
      feeEvent(partial),
      serverConfig(),
      NOW
    ).status,
    'eligible'
  );

  const fullyRefunded = settlementOrder({
    paymentStatus: 'refunded',
    paidTableFeeFen: 0,
    totalCostFen: 0,
    channelFeeFen: 0,
    platformNetFen: 0,
    shopNetFen: 0,
    retainedCouponSubsidyFen: 0,
    shopSettlementFen: 0,
    refundedTableFeeFen: 10000,
    grossRefundedFen: 10200,
    couponRefundedFen: 200,
    refundClaim: { status: 'succeeded' },
    channelFeeEvidenceHash: 'c'.repeat(64)
  });
  assert.strictEqual(
    assessSettlement(
      fullyRefunded,
      paymentEvent(fullyRefunded),
      feeEvent(fullyRefunded),
      serverConfig(),
      NOW
    ).status,
    'eligible'
  );

  const incompleteCouponRefund = {
    ...fullyRefunded,
    retainedCouponSubsidyFen: 100,
    couponRefundedFen: 100,
    grossRefundedFen: 10100,
    shopSettlementFen: 100
  };
  assert.strictEqual(
    assessSettlement(
      incompleteCouponRefund,
      paymentEvent(incompleteCouponRefund),
      feeEvent(incompleteCouponRefund),
      serverConfig(),
      NOW
    ).status,
    'manual_review',
    'refunded status requires every payer and coupon fen to be refunded'
  );

  for (const invalid of [
    settlementOrder({ refundedTableFeeFen: 1 }),
    settlementOrder({ couponRefundedFen: 1 }),
    settlementOrder({ grossRefundedFen: 1 }),
    { ...partial, refundedTableFeeFen: 3999 },
    { ...partial, couponRefundedFen: 99 },
    { ...partial, grossRefundedFen: 4000 },
    { ...fullyRefunded, refundedTableFeeFen: 9999 },
    { ...fullyRefunded, grossRefundedFen: Number.MAX_SAFE_INTEGER + 1 }
  ]) {
    assert.strictEqual(
      assessSettlement(
        invalid,
        paymentEvent(invalid),
        feeEvent(invalid),
        serverConfig(),
        NOW
      ).status,
      'manual_review'
    );
  }

  for (const [order, event, expected] of [
    [settlementOrder({ channelFeeFen: null, platformNetFen: null }), null, 'pending'],
    [settlementOrder({ financeAutomationBlocked: true }), fee, 'pending'],
    [settlementOrder({ refundClaim: { status: 'processing' } }), fee, 'pending'],
    [settlementOrder({ platformNetFen: 469 }), fee, 'manual_review'],
    [settlementOrder(), { ...fee, evidenceHash: 'd'.repeat(64) }, 'manual_review']
  ]) {
    assert.strictEqual(
      assessSettlement(order, paymentEvent(order), event, serverConfig(), NOW).status,
      expected
    );
  }
}

async function testPositiveSplitQueriesTerminalThenVerifiedUnfreeze() {
  const order = settlementOrder();
  const state = settlementState(order);
  const store = new MemoryStore(state);
  const calls = [];
  const client = {
    async addReceiver(body) {
      assert.strictEqual(store.inTransaction, false);
      calls.push(['addReceiver', clone(body)]);
      return {
        sub_mchid: SUB_MCHID,
        type: 'MERCHANT_ID',
        account: SP_MCHID,
        relation_type: 'SERVICE_PROVIDER'
      };
    },
    async split(body) {
      assert.strictEqual(store.inTransaction, false);
      calls.push(['split', clone(body)]);
      return { state: 'PROCESSING' };
    },
    async querySplit(outOrderNo, query) {
      assert.strictEqual(store.inTransaction, false);
      calls.push(['querySplit', outOrderNo, clone(query)]);
      return outOrderNo === order.splitNo
        ? splitFinished(order)
        : unfreezeFinished(order);
    },
    async unfreeze(body) {
      assert.strictEqual(store.inTransaction, false);
      calls.push(['unfreeze', clone(body)]);
      return { state: 'PROCESSING' };
    }
  };
  const result = await makeHandler(store, client)(timer, {});

  assert.deepStrictEqual(result, {
    ok: true,
    scanned: 1,
    claimed: 1,
    succeeded: 1,
    pending: 0,
    manualReview: 0,
    conflicts: 0
  });
  assert.strictEqual(store.lastListNow, NOW);
  assert.strictEqual(store.lastListLimit, 20);
  assert.deepStrictEqual(calls, [
    ['addReceiver', {
      sub_mchid: SUB_MCHID,
      appid: SP_APPID,
      type: 'MERCHANT_ID',
      account: SP_MCHID,
      name: 'ENCRYPTED_LEGAL_NAME',
      relation_type: 'SERVICE_PROVIDER'
    }],
    ['split', {
      sub_mchid: SUB_MCHID,
      transaction_id: TRANSACTION_ID,
      out_order_no: order.splitNo,
      receivers: [{
        type: 'MERCHANT_ID',
        account: SP_MCHID,
        name: 'ENCRYPTED_LEGAL_NAME',
        amount: 470,
        description: SPLIT_DESCRIPTION
      }],
      unfreeze_unsplit: false
    }],
    ['querySplit', order.splitNo, {
      sub_mchid: SUB_MCHID,
      transaction_id: TRANSACTION_ID
    }],
    ['unfreeze', {
      sub_mchid: SUB_MCHID,
      transaction_id: TRANSACTION_ID,
      out_order_no: unfreezeNoForOrder(ORDER_ID),
      description: UNFREEZE_DESCRIPTION
    }],
    ['querySplit', unfreezeNoForOrder(ORDER_ID), {
      sub_mchid: SUB_MCHID,
      transaction_id: TRANSACTION_ID
    }]
  ]);

  const settled = state.shop_orders[0];
  assert.strictEqual(settled.splitStatus, 'succeeded');
  assert.strictEqual(settled.splitClaim.status, 'succeeded');
  assert.strictEqual(settled.wechatSplitOrderId, 'wechat-split-order');
  assert.strictEqual(settled.wechatSplitDetailId, 'wechat-split-detail');
  assert.strictEqual(settled.wechatUnfreezeOrderId, 'wechat-unfreeze-order');
  assert.strictEqual(settled.unfreezeNo, unfreezeNoForOrder(ORDER_ID));
  assert.strictEqual(settled.splitCompletedAt, 'SERVER_DATE');
  const successEvents = state.financial_events.filter(
    (event) => event.eventType === 'profit_sharing_succeeded'
  );
  assert.strictEqual(successEvents.length, 1);
  assert.strictEqual(successEvents[0]._id, financialEventId(
    'profit_sharing_succeeded', ORDER_ID
  ));
  assert.strictEqual(successEvents[0].platformNetFen, 470);
  assert.strictEqual(successEvents[0].evidenceHash, EVIDENCE_HASH);
  assert(!JSON.stringify(state).includes('测试平台商户'));
}

async function testNonTerminalQueriesSameIdsWithoutRepeatingSideEffects() {
  const order = settlementOrder();
  const state = settlementState(order);
  const store = new MemoryStore(state);
  let now = NOW;
  let round = 0;
  let receiverCalls = 0;
  const splitNumbers = [];
  const queryNumbers = [];
  const handler = makeHandler(store, {
    async addReceiver() {
      receiverCalls += 1;
      return {
        sub_mchid: SUB_MCHID,
        type: 'MERCHANT_ID',
        account: SP_MCHID,
        relation_type: 'SERVICE_PROVIDER'
      };
    },
    async split(body) {
      splitNumbers.push(body.out_order_no);
      return { state: 'PROCESSING' };
    },
    async querySplit(outOrderNo) {
      queryNumbers.push(outOrderNo);
      if (outOrderNo !== order.splitNo) return unfreezeFinished(order);
      return round === 0
        ? { ...splitFinished(order), state: 'PROCESSING', receivers: [] }
        : splitFinished(order);
    },
    async unfreeze() { return { state: 'PROCESSING' }; }
  }, { nowMs: () => now });

  assert.deepStrictEqual(await handler(timer, {}), {
    ok: true,
    scanned: 1,
    claimed: 1,
    succeeded: 0,
    pending: 1,
    manualReview: 0,
    conflicts: 0
  });
  assert.strictEqual(state.shop_orders[0].splitStatus, 'processing');
  assert.strictEqual(state.financial_events.filter(
    (event) => event.eventType === 'profit_sharing_succeeded'
  ).length, 0);
  assert.deepStrictEqual(state.shop_orders[0].splitRecovery, {
    firstUncertainAtMs: NOW,
    stage: 'split_query',
    attemptEvidence: [{
      attemptId: 'attempt-1',
      attemptedAtMs: NOW,
      stage: 'split_query',
      outOrderNo: order.splitNo,
      outcomeCode: 'SPLIT_REMOTE_PROCESSING',
      recordedAtMs: NOW
    }]
  });

  round = 1;
  now += PENDING_TIMEOUT_MS - 1;
  assert.strictEqual((await handler(timer, {})).succeeded, 1);
  assert.strictEqual(receiverCalls, 1);
  assert.deepStrictEqual(splitNumbers, [order.splitNo]);
  assert.deepStrictEqual(queryNumbers, [
    order.splitNo,
    order.splitNo,
    unfreezeNoForOrder(ORDER_ID)
  ]);
  assert.strictEqual(
    state.shop_orders[0].splitRecovery.firstUncertainAtMs,
    NOW
  );
  assert.strictEqual(state.financial_events.filter(
    (event) => event.eventType === 'profit_sharing_succeeded'
  ).length, 1);
}

async function testPendingSplitAtTwentyFourHoursEntersManualQueueOnce() {
  const order = settlementOrder();
  const state = settlementState(order);
  const store = new MemoryStore(state);
  let now = NOW;
  const sideEffects = [];
  const queries = [];
  const handler = makeHandler(store, {
    async addReceiver() {
      sideEffects.push('addReceiver');
      return {
        sub_mchid: SUB_MCHID,
        type: 'MERCHANT_ID',
        account: SP_MCHID,
        relation_type: 'SERVICE_PROVIDER'
      };
    },
    async split(body) {
      sideEffects.push(`split:${body.out_order_no}`);
      return { state: 'PROCESSING' };
    },
    async querySplit(outOrderNo) {
      queries.push(outOrderNo);
      throw new Error('remote state is unavailable');
    },
    async unfreeze() {
      sideEffects.push('unfreeze');
    }
  }, { nowMs: () => now });

  const first = await handler(timer, {});
  assert.strictEqual(first.pending, 1);
  assert.strictEqual(first.manualReview, 0);
  assert.strictEqual(
    state.shop_orders[0].splitRecovery.firstUncertainAtMs,
    NOW
  );
  assert.strictEqual(
    state.shop_orders[0].splitRecovery.attemptEvidence[0].outcomeCode,
    'SPLIT_QUERY_UNAVAILABLE'
  );
  const staleCandidate = clone(state.shop_orders[0]);
  const remoteSnapshot = clone({ sideEffects, queries });

  store.listSettlementCandidates = async () => [clone(staleCandidate)];
  now = NOW + PENDING_TIMEOUT_MS;
  assert.deepStrictEqual(await handler(timer, {}), {
    ok: true,
    scanned: 1,
    claimed: 0,
    succeeded: 0,
    pending: 0,
    manualReview: 1,
    conflicts: 0
  });

  const timedOut = state.shop_orders[0];
  assert.strictEqual(timedOut.orderStatus, 'manual_review');
  assert.strictEqual(timedOut.splitStatus, 'failed');
  assert.strictEqual(timedOut.financeAutomationBlocked, true);
  assert.deepStrictEqual(
    timedOut.manualReviewReasonCodes,
    ['PROFIT_SHARING_UNRESOLVED_24H']
  );
  assert.strictEqual(timedOut.splitRecovery.attemptEvidence.length, 1);
  assert.deepStrictEqual({ sideEffects, queries }, remoteSnapshot);

  assert.strictEqual(state.finance_anomalies.length, 1);
  const anomaly = state.finance_anomalies[0];
  assert.strictEqual(timedOut.manualReviewAnomalyId, anomaly._id);
  assert.deepStrictEqual({
    reasonCodes: anomaly.reasonCodes,
    billDate: anomaly.billDate,
    subMchid: anomaly.subMchid,
    orderId: anomaly.orderId,
    refundNo: anomaly.refundNo,
    artifactId: anomaly.artifactId,
    source: anomaly.source,
    status: anomaly.status,
    severity: anomaly.severity,
    operation: anomaly.operation,
    splitNo: anomaly.splitNo,
    unfreezeNo: anomaly.unfreezeNo,
    firstUncertainAtMs: anomaly.firstUncertainAtMs,
    deadlineAtMs: anomaly.deadlineAtMs,
    attemptCount: anomaly.attemptCount,
    lastOutcomeCode: anomaly.lastOutcomeCode
  }, {
    reasonCodes: ['PROFIT_SHARING_UNRESOLVED_24H'],
    billDate: null,
    subMchid: SUB_MCHID,
    orderId: ORDER_ID,
    refundNo: null,
    artifactId: null,
    source: 'profit_sharing',
    status: 'open',
    severity: 'blocking',
    operation: 'table_profit_sharing',
    splitNo: order.splitNo,
    unfreezeNo: unfreezeNoForOrder(ORDER_ID),
    firstUncertainAtMs: NOW,
    deadlineAtMs: NOW + PENDING_TIMEOUT_MS,
    attemptCount: 1,
    lastOutcomeCode: 'SPLIT_QUERY_UNAVAILABLE'
  });

  const replay = await handler(timer, {});
  assert.strictEqual(replay.conflicts, 1);
  assert.strictEqual(replay.manualReview, 0);
  assert.strictEqual(state.finance_anomalies.length, 1);
  assert.deepStrictEqual({ sideEffects, queries }, remoteSnapshot);
}

async function testExistingTimeoutAnomalyIsReopened() {
  const firstUncertainAtMs = NOW - PENDING_TIMEOUT_MS;
  const timedOutOrder = settlementOrder({
    splitStatus: 'processing',
    splitNextAttemptAt: NOW,
    splitClaim: {
      attemptId: 'timed-out-attempt',
      status: 'pending',
      claimedAt: firstUncertainAtMs,
      leaseExpiresAt: NOW
    },
    splitRecovery: {
      firstUncertainAtMs,
      stage: 'split_query',
      attemptEvidence: [{
        attemptId: 'timed-out-attempt',
        attemptedAtMs: firstUncertainAtMs,
        recordedAtMs: firstUncertainAtMs,
        stage: 'split_query',
        outOrderNo: splitNoForOrder(ORDER_ID),
        outcomeCode: 'SPLIT_REMOTE_PROCESSING'
      }]
    }
  });
  const state = settlementState(timedOutOrder);
  let remoteCalls = 0;
  const handler = makeHandler(new MemoryStore(state), new Proxy({}, {
    get() {
      return async () => { remoteCalls += 1; };
    }
  }));

  assert.strictEqual((await handler(timer, {})).manualReview, 1);
  assert.strictEqual(state.finance_anomalies.length, 1);
  const anomalyId = state.finance_anomalies[0]._id;
  state.finance_anomalies[0].status = 'closed';
  state.finance_anomalies[0].severity = 'warning';
  state.shop_orders.splice(0, 1, clone(timedOutOrder));

  assert.strictEqual((await handler(timer, {})).manualReview, 1);
  assert.strictEqual(state.finance_anomalies.length, 1);
  assert.strictEqual(state.finance_anomalies[0]._id, anomalyId);
  assert.strictEqual(state.finance_anomalies[0].status, 'open');
  assert.strictEqual(state.finance_anomalies[0].severity, 'blocking');
  assert.strictEqual(remoteCalls, 0);
}

async function testTimeoutAnomalyIdentityConflictCreatesBlockingRecord() {
  const firstUncertainAtMs = NOW - PENDING_TIMEOUT_MS;
  const timedOutOrder = settlementOrder({
    splitStatus: 'processing',
    splitNextAttemptAt: NOW,
    splitClaim: {
      attemptId: 'timed-out-conflict-attempt',
      status: 'pending',
      claimedAt: firstUncertainAtMs,
      leaseExpiresAt: NOW
    },
    splitRecovery: {
      firstUncertainAtMs,
      stage: 'split_query',
      attemptEvidence: [{
        attemptId: 'timed-out-conflict-attempt',
        attemptedAtMs: firstUncertainAtMs,
        recordedAtMs: firstUncertainAtMs,
        stage: 'split_query',
        outOrderNo: splitNoForOrder(ORDER_ID),
        outcomeCode: 'SPLIT_REMOTE_PROCESSING'
      }]
    }
  });
  const state = settlementState(timedOutOrder);
  let remoteCalls = 0;
  const handler = makeHandler(new MemoryStore(state), new Proxy({}, {
    get() {
      return async () => { remoteCalls += 1; };
    }
  }));

  assert.strictEqual((await handler(timer, {})).manualReview, 1);
  const occupied = state.finance_anomalies[0];
  const occupiedId = occupied._id;
  occupied.source = 'wechat_trade_bill';
  occupied.orderId = 'different-order';
  occupied.status = 'closed';
  occupied.severity = 'warning';
  state.shop_orders.splice(0, 1, clone(timedOutOrder));

  assert.strictEqual((await handler(timer, {})).manualReview, 1);
  assert.strictEqual(state.finance_anomalies.length, 2);
  const persistedOccupied = state.finance_anomalies.find(
    (anomaly) => anomaly._id === occupiedId
  );
  assert.strictEqual(persistedOccupied.source, 'wechat_trade_bill');
  assert.strictEqual(persistedOccupied.orderId, 'different-order');
  assert.strictEqual(persistedOccupied.status, 'closed');
  assert.strictEqual(persistedOccupied.severity, 'warning');
  const conflict = state.finance_anomalies.find(
    (anomaly) => anomaly._id !== occupiedId
  );
  assert.ok(conflict);
  const conflictId = conflict._id;
  assert.strictEqual(conflict.source, 'profit_sharing');
  assert.strictEqual(conflict.status, 'open');
  assert.strictEqual(conflict.severity, 'blocking');
  assert.strictEqual(conflict.conflictingAnomalyId, occupiedId);
  assert.deepStrictEqual(conflict.reasonCodes, [
    'PROFIT_SHARING_ANOMALY_ID_CONFLICT',
    'PROFIT_SHARING_UNRESOLVED_24H'
  ]);
  assert.strictEqual(
    state.shop_orders[0].manualReviewAnomalyId,
    conflict._id
  );
  assert.deepStrictEqual(state.shop_orders[0].manualReviewReasonCodes, [
    'PROFIT_SHARING_ANOMALY_ID_CONFLICT',
    'PROFIT_SHARING_UNRESOLVED_24H'
  ]);

  conflict.status = 'closed';
  conflict.severity = 'warning';
  state.shop_orders.splice(0, 1, clone(timedOutOrder));
  assert.strictEqual((await handler(timer, {})).manualReview, 1);
  assert.strictEqual(state.finance_anomalies.length, 2);
  const reopenedConflict = state.finance_anomalies.find(
    (anomaly) => anomaly._id === conflictId
  );
  assert.strictEqual(reopenedConflict.status, 'open');
  assert.strictEqual(reopenedConflict.severity, 'blocking');
  assert.strictEqual(
    state.shop_orders[0].manualReviewAnomalyId,
    conflictId
  );
  assert.strictEqual(remoteCalls, 0);
}

async function testDeadlineIsRecheckedAfterCandidateListing() {
  const firstUncertainAtMs = NOW - PENDING_TIMEOUT_MS;
  const order = settlementOrder({
    splitStatus: 'processing',
    splitNextAttemptAt: NOW - 1,
    splitClaim: {
      attemptId: 'previous-attempt',
      status: 'pending',
      claimedAt: firstUncertainAtMs,
      leaseExpiresAt: NOW - 1
    },
    splitRecovery: {
      firstUncertainAtMs,
      stage: 'split_query',
      attemptEvidence: [{
        attemptId: 'previous-attempt',
        attemptedAtMs: firstUncertainAtMs,
        recordedAtMs: firstUncertainAtMs,
        stage: 'split_query',
        outOrderNo: splitNoForOrder(ORDER_ID),
        outcomeCode: 'SPLIT_REMOTE_PROCESSING'
      }]
    }
  });
  const state = settlementState(order);
  const store = new MemoryStore(state);
  let clockReads = 0;
  let remoteCalls = 0;
  const handler = makeHandler(store, new Proxy({}, {
    get() {
      return async () => {
        remoteCalls += 1;
        throw new Error('remote calls are forbidden at the deadline');
      };
    }
  }), {
    nowMs: () => (clockReads++ === 0 ? NOW - 1 : NOW)
  });

  const result = await handler(timer, {});
  assert.strictEqual(result.claimed, 0);
  assert.strictEqual(result.manualReview, 1);
  assert.strictEqual(remoteCalls, 0);
  assert.strictEqual(state.finance_anomalies.length, 1);
  assert.strictEqual(state.shop_orders[0].orderStatus, 'manual_review');
}

async function testDeadlineIsRecheckedAfterClaimBeforeRemote() {
  const firstUncertainAtMs = NOW - PENDING_TIMEOUT_MS;
  const order = settlementOrder({
    splitStatus: 'processing',
    splitNextAttemptAt: NOW - 1,
    splitClaim: {
      attemptId: 'previous-attempt',
      status: 'pending',
      claimedAt: firstUncertainAtMs,
      leaseExpiresAt: NOW - 1
    },
    splitRecovery: {
      firstUncertainAtMs,
      stage: 'split_query',
      attemptEvidence: [{
        attemptId: 'previous-attempt',
        attemptedAtMs: firstUncertainAtMs,
        recordedAtMs: firstUncertainAtMs,
        stage: 'split_query',
        outOrderNo: splitNoForOrder(ORDER_ID),
        outcomeCode: 'SPLIT_REMOTE_PROCESSING'
      }]
    }
  });
  const state = settlementState(order);
  let clockReads = 0;
  let remoteCalls = 0;
  const result = await makeHandler(new MemoryStore(state), {
    async querySplit() {
      remoteCalls += 1;
      return { ...splitFinished(order), state: 'PROCESSING', receivers: [] };
    }
  }, {
    nowMs: () => (clockReads++ < 2 ? NOW - 1 : NOW)
  })(timer, {});

  assert.strictEqual(result.claimed, 1);
  assert.strictEqual(result.manualReview, 1);
  assert.strictEqual(result.pending, 0);
  assert.strictEqual(remoteCalls, 0);
  assert.strictEqual(state.shop_orders[0].orderStatus, 'manual_review');
  assert.strictEqual(state.finance_anomalies.length, 1);
}

async function testTimeoutCannotBeDeferredByAnotherAutomationBlock() {
  const firstUncertainAtMs = NOW - PENDING_TIMEOUT_MS + 1;
  const order = settlementOrder({
    financeAutomationBlocked: true,
    splitStatus: 'processing',
    splitNextAttemptAt: NOW,
    splitClaim: {
      attemptId: 'blocked-attempt',
      status: 'pending',
      claimedAt: firstUncertainAtMs,
      leaseExpiresAt: NOW
    },
    splitRecovery: {
      firstUncertainAtMs,
      stage: 'split_query',
      attemptEvidence: [{
        attemptId: 'blocked-attempt',
        attemptedAtMs: firstUncertainAtMs,
        recordedAtMs: firstUncertainAtMs,
        stage: 'split_query',
        outOrderNo: splitNoForOrder(ORDER_ID),
        outcomeCode: 'SPLIT_REMOTE_PROCESSING'
      }]
    }
  });
  const state = settlementState(order);
  let now = NOW;
  let remoteCalls = 0;
  const handler = makeHandler(new MemoryStore(state), new Proxy({}, {
    get() {
      return async () => { remoteCalls += 1; };
    }
  }), { nowMs: () => now });

  const beforeDeadline = await handler(timer, {});
  assert.strictEqual(beforeDeadline.pending, 1);
  assert.strictEqual(beforeDeadline.manualReview, 0);
  assert.strictEqual(state.shop_orders[0].splitNextAttemptAt, NOW + 1);
  assert.strictEqual(remoteCalls, 0);

  now += 1;
  const atDeadline = await handler(timer, {});
  assert.strictEqual(atDeadline.manualReview, 1);
  assert.strictEqual(atDeadline.pending, 0);
  assert.strictEqual(remoteCalls, 0);
  assert.strictEqual(state.shop_orders[0].orderStatus, 'manual_review');
  assert.strictEqual(state.finance_anomalies.length, 1);
}

async function testUnfreezeRecoveryNeverRegressesOrRepeatsSideEffect() {
  const order = settlementOrder();
  const state = settlementState(order);
  const store = new MemoryStore(state);
  let now = NOW;
  let round = 0;
  const sideEffects = [];
  const queries = [];
  const handler = makeHandler(store, {
    async addReceiver() {
      sideEffects.push('addReceiver');
      return {
        sub_mchid: SUB_MCHID,
        type: 'MERCHANT_ID',
        account: SP_MCHID,
        relation_type: 'SERVICE_PROVIDER'
      };
    },
    async split(body) {
      sideEffects.push(`split:${body.out_order_no}`);
      return { state: 'PROCESSING' };
    },
    async unfreeze(body) {
      sideEffects.push(`unfreeze:${body.out_order_no}`);
      return { state: 'PROCESSING' };
    },
    async querySplit(outOrderNo) {
      queries.push(outOrderNo);
      if (outOrderNo === order.splitNo) {
        if (round === 1) throw new Error('split query temporarily unavailable');
        return splitFinished(order);
      }
      return round === 2
        ? unfreezeFinished(order)
        : { ...unfreezeFinished(order), state: 'PROCESSING', receivers: [] };
    }
  }, { nowMs: () => now });

  assert.strictEqual((await handler(timer, {})).pending, 1);
  assert.strictEqual(state.shop_orders[0].splitRecovery.stage, 'unfreeze_query');
  assert.deepStrictEqual(sideEffects, [
    'addReceiver',
    `split:${order.splitNo}`,
    `unfreeze:${unfreezeNoForOrder(ORDER_ID)}`
  ]);

  round = 1;
  now += LEASE_MS + 1;
  assert.strictEqual((await handler(timer, {})).pending, 1);
  assert.strictEqual(state.shop_orders[0].splitRecovery.stage, 'unfreeze_query');
  assert.strictEqual(
    state.shop_orders[0].splitRecovery.attemptEvidence.slice(-1)[0].outcomeCode,
    'SPLIT_QUERY_UNAVAILABLE_DURING_UNFREEZE'
  );

  round = 2;
  now += LEASE_MS + 1;
  assert.strictEqual((await handler(timer, {})).succeeded, 1);
  assert.deepStrictEqual(sideEffects, [
    'addReceiver',
    `split:${order.splitNo}`,
    `unfreeze:${unfreezeNoForOrder(ORDER_ID)}`
  ]);
  assert.deepStrictEqual(queries, [
    order.splitNo,
    unfreezeNoForOrder(ORDER_ID),
    order.splitNo,
    order.splitNo,
    unfreezeNoForOrder(ORDER_ID)
  ]);
}

async function testReceiverSetupUncertaintyBecomesQueryOnly() {
  const order = settlementOrder();
  const state = settlementState(order);
  const store = new MemoryStore(state);
  let now = NOW;
  let receiverCalls = 0;
  let splitCalls = 0;
  const queries = [];
  const handler = makeHandler(store, {
    async addReceiver() {
      receiverCalls += 1;
      throw new Error('receiver relation response was lost');
    },
    async split() { splitCalls += 1; },
    async unfreeze() { throw new Error('unfreeze must not be submitted'); },
    async querySplit(outOrderNo) {
      queries.push(outOrderNo);
      throw new Error('same-number split state is not yet available');
    }
  }, { nowMs: () => now });

  assert.strictEqual((await handler(timer, {})).pending, 1);
  assert.strictEqual(state.shop_orders[0].splitRecovery.stage, 'receiver_setup');
  assert.strictEqual(receiverCalls, 1);
  assert.strictEqual(splitCalls, 0);
  assert.deepStrictEqual(queries, []);

  now += LEASE_MS + 1;
  assert.strictEqual((await handler(timer, {})).pending, 1);
  assert.strictEqual(receiverCalls, 1);
  assert.strictEqual(splitCalls, 0);
  assert.deepStrictEqual(queries, [order.splitNo]);
  assert.strictEqual(state.shop_orders[0].splitRecovery.stage, 'split_query');
  assert.strictEqual(
    state.shop_orders[0].splitRecovery.attemptEvidence[1].outcomeCode,
    'SPLIT_QUERY_UNAVAILABLE'
  );
}

async function testUnfreezeIntentSurvivesCrashBeforePendingFinalize() {
  const firstUncertainAtMs = NOW - LEASE_MS;
  const order = settlementOrder({
    splitStatus: 'processing',
    splitNextAttemptAt: NOW,
    splitClaim: {
      attemptId: 'prior-split-query',
      status: 'pending',
      claimedAt: firstUncertainAtMs,
      leaseExpiresAt: NOW
    },
    splitRecovery: {
      firstUncertainAtMs,
      stage: 'split_query',
      attemptEvidence: [{
        attemptId: 'prior-split-query',
        attemptedAtMs: firstUncertainAtMs,
        recordedAtMs: firstUncertainAtMs,
        stage: 'split_query',
        outOrderNo: splitNoForOrder(ORDER_ID),
        outcomeCode: 'SPLIT_REMOTE_PROCESSING'
      }]
    }
  });
  const state = settlementState(order);
  const store = new MemoryStore(state);
  let now = NOW;
  let unfreezeCalls = 0;
  let crashSnapshot = null;
  const handler = makeHandler(store, {
    async addReceiver() { throw new Error('receiver must not repeat'); },
    async split() { throw new Error('split must not repeat'); },
    async unfreeze() {
      unfreezeCalls += 1;
      if (!crashSnapshot) crashSnapshot = clone(state);
      return { state: 'PROCESSING' };
    },
    async querySplit(outOrderNo) {
      return outOrderNo === order.splitNo
        ? splitFinished(order)
        : { ...unfreezeFinished(order), state: 'PROCESSING', receivers: [] };
    }
  }, { nowMs: () => now });

  assert.strictEqual((await handler(timer, {})).pending, 1);
  assert.strictEqual(unfreezeCalls, 1);
  assert(crashSnapshot, 'the crash snapshot must be captured at unfreeze call');
  assert.strictEqual(
    crashSnapshot.shop_orders[0].splitRecovery.stage,
    'unfreeze_query'
  );
  assert.strictEqual(
    crashSnapshot.shop_orders[0].splitRecovery.attemptEvidence.slice(-1)[0]
      .outcomeCode,
    'UNFREEZE_SUBMISSION_INTENT_RECORDED'
  );

  for (const collection of Object.keys(state)) {
    state[collection].splice(
      0,
      state[collection].length,
      ...clone(crashSnapshot[collection])
    );
  }
  now += LEASE_MS + 1;
  assert.strictEqual((await handler(timer, {})).pending, 1);
  assert.strictEqual(unfreezeCalls, 1);
}

async function testLegacyProcessingRecoveryIsQueryOnly() {
  for (const splitStatus of ['processing', 'failed']) {
    const order = settlementOrder({
      splitStatus,
      splitClaim: {
        attemptId: `legacy-${splitStatus}`,
        status: splitStatus,
        claimedAt: NOW - LEASE_MS - 1,
        leaseExpiresAt: NOW - 1
      }
    });
    const state = settlementState(order);
    let sideEffects = 0;
    const queries = [];
    const result = await makeHandler(new MemoryStore(state), {
      async addReceiver() { sideEffects += 1; },
      async split() { sideEffects += 1; },
      async unfreeze() { sideEffects += 1; },
      async querySplit(outOrderNo) {
        queries.push(outOrderNo);
        return outOrderNo === order.splitNo
          ? splitFinished(order)
          : { ...unfreezeFinished(order), state: 'PROCESSING', receivers: [] };
      }
    })(timer, {});

    assert.strictEqual(result.pending, 1);
    assert.strictEqual(sideEffects, 0);
    assert.deepStrictEqual(queries, [
      order.splitNo,
      unfreezeNoForOrder(ORDER_ID)
    ]);
    assert.strictEqual(state.shop_orders[0].splitRecovery.stage, 'unfreeze_query');
    assert.strictEqual(
      state.shop_orders[0].splitRecovery.attemptEvidence.slice(-1)[0].outcomeCode,
      'UNFREEZE_REMOTE_PROCESSING'
    );
  }
}

async function testLegacyClaimAtTimeoutQueuesBeforeQuery() {
  const claimedAt = NOW - PENDING_TIMEOUT_MS;
  const order = settlementOrder({
    splitStatus: 'processing',
    splitClaim: {
      attemptId: 'legacy-timeout',
      status: 'processing',
      claimedAt,
      leaseExpiresAt: NOW
    }
  });
  const state = settlementState(order);
  let remoteCalls = 0;
  const result = await makeHandler(new MemoryStore(state), new Proxy({}, {
    get() {
      return async () => { remoteCalls += 1; };
    }
  }))(timer, {});

  assert.strictEqual(result.manualReview, 1);
  assert.strictEqual(result.claimed, 0);
  assert.strictEqual(remoteCalls, 0);
  assert.strictEqual(state.shop_orders[0].orderStatus, 'manual_review');
  assert.strictEqual(
    state.shop_orders[0].splitRecovery.firstUncertainAtMs,
    claimedAt
  );
  assert.strictEqual(
    state.shop_orders[0].splitRecovery.attemptEvidence[0].outcomeCode,
    'LEGACY_ATTEMPT_STATE_UNKNOWN'
  );
  assert.strictEqual(state.finance_anomalies.length, 1);
}

async function testZeroPlatformNetSkipsReceiverAndSplit() {
  const order = settlementOrder({
    channelFeeFen: 500,
    platformNetFen: 0
  });
  const state = settlementState(order);
  const store = new MemoryStore(state);
  const calls = [];
  const result = await makeHandler(store, {
    async addReceiver() { calls.push('addReceiver'); },
    async split() { calls.push('split'); },
    async unfreeze() {
      calls.push('unfreeze');
      return { state: 'PROCESSING' };
    },
    async querySplit(outOrderNo) {
      calls.push(`query:${outOrderNo}`);
      return unfreezeFinished(order);
    }
  })(timer, {});

  assert.strictEqual(result.succeeded, 1);
  assert.deepStrictEqual(calls, [
    'unfreeze',
    `query:${unfreezeNoForOrder(ORDER_ID)}`
  ]);
  assert.strictEqual(state.shop_orders[0].wechatSplitOrderId, null);
  assert.strictEqual(state.shop_orders[0].wechatSplitDetailId, null);
}

async function testFeeOverCostAndTerminalMismatchesFailClosed() {
  const feeOverCost = settlementOrder({
    channelFeeFen: 501,
    platformNetFen: 0
  });
  const feeState = settlementState(feeOverCost);
  let feeNetwork = 0;
  const feeResult = await makeHandler(new MemoryStore(feeState), new Proxy({}, {
    get() { return async () => { feeNetwork += 1; }; }
  }))(timer, {});
  assert.strictEqual(feeResult.manualReview, 1);
  assert.strictEqual(feeNetwork, 0);
  assert.strictEqual(feeState.shop_orders[0].orderStatus, 'manual_review');
  assert.deepStrictEqual(
    feeState.shop_orders[0].manualReviewReasonCodes,
    ['CHANNEL_FEE_EXCEEDS_TOTAL_COST']
  );

  for (const [remote, reason] of [
    [splitFinished(settlementOrder(), {
      receivers: [{
        type: 'MERCHANT_ID',
        account: SP_MCHID,
        amount: 471,
        description: SPLIT_DESCRIPTION,
        result: 'SUCCESS',
        detail_id: 'wrong-detail'
      }]
    }), 'SPLIT_RECEIVER_MISMATCH'],
    [{ ...splitFinished(settlementOrder()), state: 'UNKNOWN' }, 'SPLIT_STATE_UNKNOWN'],
    [splitFinished(settlementOrder(), {
      receivers: [{
        type: 'MERCHANT_ID',
        account: SP_MCHID,
        amount: 470,
        description: SPLIT_DESCRIPTION,
        result: 'CLOSED',
        detail_id: 'closed-detail'
      }]
    }), 'SPLIT_RECEIVER_FAILED']
  ]) {
    const state = settlementState();
    let unfreezeCalls = 0;
    const result = await makeHandler(new MemoryStore(state), {
      async addReceiver() {
        return {
          sub_mchid: SUB_MCHID,
          type: 'MERCHANT_ID',
          account: SP_MCHID,
          relation_type: 'SERVICE_PROVIDER'
        };
      },
      async split() { return { state: 'PROCESSING' }; },
      async querySplit() { return remote; },
      async unfreeze() { unfreezeCalls += 1; }
    })(timer, {});
    assert.strictEqual(result.manualReview, 1);
    assert.strictEqual(unfreezeCalls, 0);
    assert.deepStrictEqual(state.shop_orders[0].manualReviewReasonCodes, [reason]);
    assert.strictEqual(state.shop_orders[0].splitStatus, 'failed');
  }
}

async function testOnlyTheClaimingAttemptCanFinalize() {
  const order = settlementOrder();
  const state = settlementState(order);
  const store = new MemoryStore(state);
  const handler = makeHandler(store, {
    async addReceiver() {
      return {
        sub_mchid: SUB_MCHID,
        type: 'MERCHANT_ID',
        account: SP_MCHID,
        relation_type: 'SERVICE_PROVIDER'
      };
    },
    async split() { return { state: 'PROCESSING' }; },
    async querySplit(outOrderNo) {
      if (outOrderNo === order.splitNo) return splitFinished(order);
      state.shop_orders[0].splitClaim.attemptId = 'newer-attempt';
      return unfreezeFinished(order);
    },
    async unfreeze() { return { state: 'PROCESSING' }; }
  });

  const result = await handler(timer, {});
  assert.strictEqual(result.conflicts, 1);
  assert.strictEqual(result.succeeded, 0);
  assert.notStrictEqual(state.shop_orders[0].splitStatus, 'succeeded');
  assert.strictEqual(state.financial_events.filter(
    (event) => event.eventType === 'profit_sharing_succeeded'
  ).length, 0);
}

async function testStaleCandidateCannotDowngradeTerminalOrder() {
  const staleCandidate = settlementOrder();
  const state = settlementState(staleCandidate);
  const store = new MemoryStore(state);
  store.listSettlementCandidates = async () => [clone(staleCandidate)];
  const first = makeHandler(store, {
    async addReceiver() {
      return {
        sub_mchid: SUB_MCHID,
        type: 'MERCHANT_ID',
        account: SP_MCHID,
        relation_type: 'SERVICE_PROVIDER'
      };
    },
    async split() { return { state: 'PROCESSING' }; },
    async querySplit(outOrderNo) {
      return outOrderNo === staleCandidate.splitNo
        ? splitFinished(staleCandidate)
        : unfreezeFinished(staleCandidate);
    },
    async unfreeze() { return { state: 'PROCESSING' }; }
  });
  assert.strictEqual((await first(timer, {})).succeeded, 1);
  const terminalState = clone(state);

  let networkCalls = 0;
  const second = makeHandler(store, new Proxy({}, {
    get() {
      return async () => { networkCalls += 1; };
    }
  }));
  const result = await second(timer, {});
  assert.strictEqual(result.conflicts, 1);
  assert.strictEqual(result.manualReview, 0);
  assert.strictEqual(networkCalls, 0);
  assert.deepStrictEqual(state, terminalState);
}

async function testPendingAssessmentSchedulesDueWithoutRegression() {
  const order = settlementOrder();
  const state = settlementState(order);
  state.financial_events = [paymentEvent(order)];
  const staleCandidate = clone(order);
  const store = new MemoryStore(state);
  store.listSettlementCandidates = async () => [clone(staleCandidate)];
  let networkCalls = 0;
  const handler = makeHandler(store, new Proxy({}, {
    get() {
      return async () => { networkCalls += 1; };
    }
  }));

  const first = await handler(timer, {});
  assert.strictEqual(first.pending, 1);
  assert.strictEqual(state.shop_orders[0].splitNextAttemptAt, NOW + LEASE_MS);
  state.shop_orders[0].splitNextAttemptAt = NOW + 2 * LEASE_MS;

  const second = await handler(timer, {});
  assert.strictEqual(second.conflicts, 1);
  assert.strictEqual(second.pending, 0);
  assert.strictEqual(state.shop_orders[0].splitNextAttemptAt, NOW + 2 * LEASE_MS);
  assert.strictEqual(networkCalls, 0);
}

async function testPendingEvidenceBatchRotatesToTwentyFirstEligibleOrder() {
  const orders = Array.from({ length: 25 }, (_unused, index) => {
    const suffix = String(index).padStart(2, '0');
    const orderId = `ord-profit-sharing-${suffix}`;
    return settlementOrder({
      _id: orderId,
      orderId,
      splitNo: splitNoForOrder(orderId),
      outTradeNo: `pay_profit_${suffix}`,
      wechatTransactionId: `42${String(index).padStart(30, '0')}`,
      paidAt: NOW - 24 * 60 * 60 * 1000 + index,
      channelFeeEvidenceHash: index.toString(16).padStart(64, '0')
    });
  });
  const eligible = orders[20];
  const state = {
    shop_orders: orders,
    financial_events: orders.map((order) => paymentEvent(order))
  };
  state.financial_events.push(feeEvent(eligible));
  const store = new MemoryStore(state);
  const handler = makeHandler(store, {
    async addReceiver() {
      return {
        sub_mchid: SUB_MCHID,
        type: 'MERCHANT_ID',
        account: SP_MCHID,
        relation_type: 'SERVICE_PROVIDER'
      };
    },
    async split() { return { state: 'PROCESSING' }; },
    async querySplit(outOrderNo) {
      return outOrderNo === eligible.splitNo
        ? splitFinished(eligible, {
            transaction_id: eligible.wechatTransactionId
          })
        : unfreezeFinished(eligible, {
            transaction_id: eligible.wechatTransactionId
          });
    },
    async unfreeze() { return { state: 'PROCESSING' }; }
  });

  const first = await handler(timer, {});
  assert.strictEqual(first.scanned, 20);
  assert.strictEqual(first.pending, 20);
  assert.strictEqual(first.succeeded, 0);
  for (const order of state.shop_orders.slice(0, 20)) {
    assert.strictEqual(order.splitNextAttemptAt, NOW + LEASE_MS);
  }

  const second = await handler(timer, {});
  assert.strictEqual(second.scanned, 5);
  assert.strictEqual(second.pending, 4);
  assert.strictEqual(second.succeeded, 1);
  assert.strictEqual(state.shop_orders[20].splitStatus, 'succeeded');
}

async function testProductionQuerySeparatesDueAndVirginCandidates() {
  const queries = [];
  const command = {
    in: (value) => ({ operator: 'in', value }),
    lte: (value) => ({ operator: 'lte', value }),
    exists: (value) => ({ operator: 'exists', value })
  };
  const db = {
    command,
    collection(name) {
      assert.strictEqual(name, 'shop_orders');
      return {
        where(filter) {
          const entry = { filter, orderBy: [], limit: null };
          queries.push(entry);
          const builder = {
            orderBy(field, direction) {
              entry.orderBy.push([field, direction]);
              return builder;
            },
            limit(value) {
              entry.limit = value;
              return builder;
            },
            async get() { return { data: [] }; }
          };
          return builder;
        }
      };
    },
    async runTransaction() { throw new Error('not used'); },
    serverDate() { return 'SERVER_DATE'; }
  };
  const store = createCloudbaseProfitSharingStore(db);
  assert.deepStrictEqual(await store.listSettlementCandidates(NOW, 20), []);
  assert.strictEqual(queries.length, 6);
  const virgin = queries.filter(
    (query) => query.filter.splitNextAttemptAt.operator === 'exists'
  );
  const due = queries.filter(
    (query) => query.filter.splitNextAttemptAt.operator === 'lte'
  );
  assert.strictEqual(virgin.length, 3);
  assert.strictEqual(due.length, 3);
  assert(virgin.every((query) => query.filter.splitNextAttemptAt.value === false));
  assert(due.every((query) => query.filter.splitNextAttemptAt.value === NOW));
  assert(due.every((query) => query.orderBy[0][0] === 'splitNextAttemptAt'));
  assert(queries.every((query) => query.limit === 20));
}

async function testProductionQueryFairlyBalancesDueAndVirginPressure() {
  const runSelection = async (records) => {
    const command = {
      in: (value) => ({ operator: 'in', value }),
      lte: (value) => ({ operator: 'lte', value }),
      exists: (value) => ({ operator: 'exists', value })
    };
    const db = {
      command,
      collection(name) {
        assert.strictEqual(name, 'shop_orders');
        return {
          where(filter) {
            let selectedLimit = null;
            const builder = {
              orderBy() { return builder; },
              limit(value) {
                selectedLimit = value;
                return builder;
              },
              async get() {
                const virgin = filter.splitNextAttemptAt.operator === 'exists';
                const rows = records.filter((order) => (
                  order.splitStatus === filter.splitStatus
                  && virgin === !Object.prototype.hasOwnProperty.call(
                    order,
                    'splitNextAttemptAt'
                  )
                )).sort((left, right) => {
                  if (!virgin) {
                    const due = left.splitNextAttemptAt - right.splitNextAttemptAt;
                    if (due !== 0) return due;
                  }
                  return left.paidAt - right.paidAt
                    || left._id.localeCompare(right._id);
                });
                return { data: rows.slice(0, selectedLimit) };
              }
            };
            return builder;
          }
        };
      },
      async runTransaction() { throw new Error('not used'); },
      serverDate() { return 'SERVER_DATE'; }
    };
    return createCloudbaseProfitSharingStore(db)
      .listSettlementCandidates(NOW, 20);
  };
  const makeCandidate = (id, splitStatus, paidAt, splitNextAttemptAt) => ({
    _id: id,
    splitStatus,
    paidAt,
    ...(splitNextAttemptAt === undefined ? {} : { splitNextAttemptAt })
  });

  const virgins = Array.from({ length: 20 }, (_unused, index) => (
    makeCandidate(`virgin-${String(index).padStart(2, '0')}`, 'pending', index)
  ));
  const dueRetry = makeCandidate('due-retry', 'failed', 100, NOW - 1);
  const virginPressure = await runSelection(virgins.concat(dueRetry));
  assert.deepStrictEqual(
    virginPressure.map((order) => order._id),
    ['due-retry'].concat(virgins.slice(0, 19).map((order) => order._id))
  );

  const due = Array.from({ length: 20 }, (_unused, index) => (
    makeCandidate(
      `due-${String(index).padStart(2, '0')}`,
      'pending',
      index,
      NOW - 100 + index
    )
  ));
  const virginRetry = makeCandidate('virgin-retry', 'failed', 100);
  const duePressure = await runSelection(due.concat(virginRetry));
  assert.deepStrictEqual(
    duePressure.map((order) => order._id),
    [due[0]._id, 'virgin-retry'].concat(
      due.slice(1, 19).map((order) => order._id)
    )
  );
}

async function testFunctionIsIndependentlyDeployable() {
  const functionRoot = path.join(root, 'cloudfunctions/settleTableProfitSharing');
  const indexSource = fs.readFileSync(path.join(functionRoot, 'index.js'), 'utf8');
  assert(!indexSource.includes('../_shared'));
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(path.join(functionRoot, 'package.json'), 'utf8')),
    {
      name: 'settleTableProfitSharing',
      version: '1.0.0',
      description: 'Settle verified T+1 table profit sharing',
      main: 'index.js',
      dependencies: { 'wx-server-sdk': '~2.6.3' }
    }
  );
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(path.join(functionRoot, 'config.json'), 'utf8')),
    {
      triggers: [{
        name: 'settleTableProfitSharingTimer',
        type: 'timer',
        config: '0 */5 * * * * *'
      }]
    }
  );
  for (const file of ['money.js', 'state.js']) {
    assert.deepStrictEqual(
      fs.readFileSync(path.join(functionRoot, 'lib/table-finance', file)),
      fs.readFileSync(path.join(root, 'cloudfunctions/_shared/table-finance', file))
    );
  }
  for (const file of ['client.js', 'config.js', 'http-event.js', 'bill-parser.js']) {
    assert.deepStrictEqual(
      fs.readFileSync(path.join(functionRoot, 'lib/wechatpay-v3', file)),
      fs.readFileSync(path.join(root, 'cloudfunctions/_shared/wechatpay-v3', file))
    );
  }
  assert.deepStrictEqual(
    fs.readFileSync(path.join(
      functionRoot,
      'lib/table-profit-sharing/table-profit-sharing.js'
    )),
    fs.readFileSync(path.join(
      root,
      'cloudfunctions/_shared/table-profit-sharing/table-profit-sharing.js'
    ))
  );
}

const tests = [
  ['settlement timer guard is exact', testTimerGuardIsExact],
  ['eligibility requires official evidence and retained refund amounts', testEvidenceEligibilityAndRefundAwareRetainedAmounts],
  ['positive split queries terminal success before verified unfreeze', testPositiveSplitQueriesTerminalThenVerifiedUnfreeze],
  ['non-terminal split queries deterministic IDs without repeated side effects', testNonTerminalQueriesSameIdsWithoutRepeatingSideEffects],
  ['pending split reaches one blocking manual queue at exactly twenty-four hours', testPendingSplitAtTwentyFourHoursEntersManualQueueOnce],
  ['existing timeout anomaly is reopened as blocking', testExistingTimeoutAnomalyIsReopened],
  ['timeout anomaly identity conflicts create a separate blocking record', testTimeoutAnomalyIdentityConflictCreatesBlockingRecord],
  ['deadline is rechecked after candidate listing and before remote calls', testDeadlineIsRecheckedAfterCandidateListing],
  ['deadline is rechecked after claim and before remote calls', testDeadlineIsRecheckedAfterClaimBeforeRemote],
  ['another automation block cannot defer the twenty-four-hour manual queue', testTimeoutCannotBeDeferredByAnotherAutomationBlock],
  ['unfreeze recovery never regresses or repeats remote side effects', testUnfreezeRecoveryNeverRegressesOrRepeatsSideEffect],
  ['receiver setup uncertainty becomes same-number query-only recovery', testReceiverSetupUncertaintyBecomesQueryOnly],
  ['unfreeze submission intent survives a crash before pending finalization', testUnfreezeIntentSurvivesCrashBeforePendingFinalize],
  ['legacy processing recovery is query-only and creates no remote side effects', testLegacyProcessingRecoveryIsQueryOnly],
  ['legacy claim already at twenty-four hours queues before any query', testLegacyClaimAtTimeoutQueuesBeforeQuery],
  ['zero platform net skips receiver and split', testZeroPlatformNetSkipsReceiverAndSplit],
  ['fee-over-cost and terminal mismatches fail closed', testFeeOverCostAndTerminalMismatchesFailClosed],
  ['only the claiming attempt can finalize', testOnlyTheClaimingAttemptCanFinalize],
  ['stale candidates cannot downgrade terminal orders', testStaleCandidateCannotDowngradeTerminalOrder],
  ['pending assessment due CAS never regresses', testPendingAssessmentSchedulesDueWithoutRegression],
  ['pending evidence batches rotate to the twenty-first eligible order', testPendingEvidenceBatchRotatesToTwentyFirstEligibleOrder],
  ['production query separates due and virgin candidates', testProductionQuerySeparatesDueAndVirginCandidates],
  ['production query fairly balances due and virgin pressure', testProductionQueryFairlyBalancesDueAndVirginPressure],
  ['settlement function is independently deployable', testFunctionIsIndependentlyDeployable]
];

(async () => {
  for (const [name, test] of tests) {
    await test();
    console.log(`ok - ${name}`);
  }
  console.log(`table profit sharing ok (${tests.length} tests)`);
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
