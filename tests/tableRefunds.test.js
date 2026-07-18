'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  officialTime,
  refundCounters,
  splitReturnNoForRefund,
  validateQueryRefund,
  validRefundOrder
} = require('../cloudfunctions/_shared/table-refund/table-refund');
const {
  refundNoForOrder
} = require('../cloudfunctions/_shared/table-finance/state');
const {
  createHandler
} = require('../cloudfunctions/requestTableRefund/index');
const {
  createCloudbaseRefundStore
} = require('../cloudfunctions/_shared/table-refund/cloudbase-refund-store');
const {
  createNotifyHandler
} = require('../cloudfunctions/tableRefundNotifyV3/index');

const OWNER = 'owner_openid';
const OTHER_OWNER = 'other_owner';
const SP_MCHID = '1900000100';
const SUB_MCHID = '1900000109';
const ORDER_ID = 'ord_refund_contract_001';
const OUT_TRADE_NO = 'pay_refund_contract_001';
const TRANSACTION_ID = '4200000000000000000000000001';
const SPLIT_NO = 'split_refund_contract_001';
const REFUND_URL = 'https://example.com/wechat/table-refund';
const IDEMPOTENCY_KEY = 'refund-case-0001';
const REASON = 'customer requested refund';
const NOW = 1_800_000_000_000;
const REFUND_LEASE_MS = 120_000;
const refundTimer = Object.freeze({
  Type: 'Timer',
  TriggerName: 'reconcileTableRefundsTimer'
});

function bindingId(openid) {
  return crypto.createHash('sha256').update(`wechat:${openid}`).digest('hex');
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function paymentSnapshot() {
  return {
    spAppid: 'wx1234567890abcdef',
    spMchid: SP_MCHID,
    subAppid: null,
    subMchid: SUB_MCHID,
    openidMode: 'sp_openid',
    profileSchemaVersion: 1,
    policyVersion: 'table_commission_v1'
  };
}

function baseOrder(overrides = {}) {
  return {
    _id: ORDER_ID,
    orderId: ORDER_ID,
    schemaVersion: 2,
    _openid: OWNER,
    shopId: OWNER,
    orderStatus: 'complete',
    paymentStatus: 'paid',
    splitStatus: 'pending',
    outTradeNo: OUT_TRADE_NO,
    wechatTransactionId: TRANSACTION_ID,
    paymentProfileSnapshot: paymentSnapshot(),
    wechatOrderTotalFen: 10000,
    wechatPayerTotalFen: 8000,
    couponSubsidyFen: 2000,
    paidTableFeeFen: 8000,
    totalCostFen: 400,
    shopNetFen: 7600,
    shopSettlementFen: 9600,
    refundedTableFeeFen: 0,
    reversedTotalCostFen: 0,
    grossRefundedFen: 0,
    couponRefundedFen: 0,
    requestedRefundFen: 0,
    refundClaim: null,
    splitNo: SPLIT_NO,
    unfreezeNo: 'unfreeze_refund_contract_001',
    splitClaim: null,
    splitCompletedAt: null,
    wechatSplitOrderId: null,
    wechatSplitDetailId: null,
    wechatUnfreezeOrderId: null,
    channelFeeFen: null,
    platformNetFen: null,
    channelFeeEvidenceHash: null,
    splitReturnedFen: 0,
    ...clone(overrides)
  };
}

function splitOrder(overrides = {}) {
  return baseOrder({
    wechatOrderTotalFen: 10000,
    wechatPayerTotalFen: 10000,
    couponSubsidyFen: 0,
    paidTableFeeFen: 10000,
    totalCostFen: 500,
    shopNetFen: 9500,
    shopSettlementFen: 9500,
    splitStatus: 'succeeded',
    splitClaim: {
      attemptId: 'split_attempt_001',
      status: 'succeeded',
      claimedAt: NOW - 10000,
      leaseExpiresAt: NOW - 5000,
      completedAt: NOW - 8000
    },
    splitCompletedAt: NOW - 8000,
    wechatSplitOrderId: '3008450740201411110007820472',
    wechatSplitDetailId: '3601111111111111111111111111',
    wechatUnfreezeOrderId: '3008450740201411110007820473',
    channelFeeFen: 100,
    platformNetFen: 400,
    channelFeeEvidenceHash: 'a'.repeat(64),
    ...clone(overrides)
  });
}

function createMemoryStore(order = baseOrder()) {
  const ownerUserId = bindingId(OWNER);
  const ownerAccountId = 'account_refund_owner';
  const otherUserId = bindingId(OTHER_OWNER);
  const otherAccountId = 'account_refund_other';
  const state = {
    orders: new Map([[order._id, clone(order)]]),
    refunds: new Map(),
    events: new Map(),
    bindings: new Map([
      [ownerUserId, {
        _id: ownerUserId,
        _openid: OWNER,
        accountId: ownerAccountId,
        account: 'refund-owner'
      }],
      [otherUserId, {
        _id: otherUserId,
        _openid: OTHER_OWNER,
        accountId: otherAccountId,
        account: 'refund-other'
      }]
    ]),
    accounts: new Map([
      [ownerAccountId, {
        _id: ownerAccountId,
        _openid: OWNER,
        account: 'refund-owner',
        status: 'active'
      }],
      [otherAccountId, {
        _id: otherAccountId,
        _openid: OTHER_OWNER,
        account: 'refund-other',
        status: 'active'
      }]
    ]),
    users: new Map([
      [ownerUserId, {
        _id: ownerUserId,
        _openid: OWNER,
        roles: ['shop']
      }],
      [otherUserId, {
        _id: otherUserId,
        _openid: OTHER_OWNER,
        roles: ['shop']
      }]
    ])
  };
  let transactionTail = Promise.resolve();
  const metrics = { transactions: 0, lists: 0 };

  const transactionStore = {
    async getWechatBinding(id) {
      return state.bindings.get(id) || null;
    },
    async getAccount(id) {
      return state.accounts.get(id) || null;
    },
    async getUser(id) {
      return state.users.get(id) || null;
    },
    async getOrder(id) {
      return state.orders.get(id) || null;
    },
    async getRefund(id) {
      return state.refunds.get(id) || null;
    },
    async getFinancialEvent(id) {
      return state.events.get(id) || null;
    },
    async updateOrder(id, data) {
      const orderValue = state.orders.get(id);
      if (!orderValue) throw new Error('missing order');
      Object.assign(orderValue, clone(data));
    },
    async setRefund(id, document) {
      if (state.refunds.has(id)) throw new Error('refund already exists');
      state.refunds.set(id, { _id: id, ...clone(document) });
    },
    async updateRefund(id, data) {
      const refund = state.refunds.get(id);
      if (!refund) throw new Error('missing refund');
      Object.assign(refund, clone(data));
    },
    async setFinancialEvent(id, document) {
      state.events.set(id, { _id: id, ...clone(document) });
    }
  };

  return {
    state,
    metrics,
    async listDueRefunds(now, limit) {
      metrics.lists += 1;
      return [...state.refunds.values()]
        .filter((refund) => {
          if (!['returning', 'processing'].includes(refund.status)) return false;
          if (Object.prototype.hasOwnProperty.call(refund, 'refundNextAttemptAt')) {
            return Number.isSafeInteger(refund.refundNextAttemptAt)
              && refund.refundNextAttemptAt >= 0
              && refund.refundNextAttemptAt <= now;
          }
          return refund.refundClaim
            && Number.isSafeInteger(refund.refundClaim.leaseExpiresAt)
            && refund.refundClaim.leaseExpiresAt <= now;
        })
        .sort((left, right) => {
          const leftDue = Number.isSafeInteger(left.refundNextAttemptAt)
            ? left.refundNextAttemptAt
            : left.refundClaim.leaseExpiresAt;
          const rightDue = Number.isSafeInteger(right.refundNextAttemptAt)
            ? right.refundNextAttemptAt
            : right.refundClaim.leaseExpiresAt;
          return leftDue - rightDue
            || left.requestedAt - right.requestedAt
            || left._id.localeCompare(right._id);
        })
        .slice(0, limit)
        .map(clone);
    },
    runTransaction(work) {
      metrics.transactions += 1;
      const run = transactionTail.then(() => work(transactionStore));
      transactionTail = run.catch(() => undefined);
      return run;
    },
    serverDate() {
      return { $date: 'server' };
    }
  };
}

function config() {
  return {
    spMchid: SP_MCHID,
    tableRefundNotifyUrl: REFUND_URL,
    platformCertificates: new Map(),
    apiV3Key: Buffer.alloc(32, 1)
  };
}

function refundResponse({
  refundFen,
  payerTotalFen,
  payerRefundFen,
  status = 'PROCESSING',
  refundNo = refundNoForOrder(ORDER_ID, IDEMPOTENCY_KEY),
  transactionId = TRANSACTION_ID,
  outTradeNo = OUT_TRADE_NO,
  totalFen = 10000,
  currency = 'CNY'
}) {
  const success = status === 'SUCCESS';
  return {
    refund_id: '50000000382019052709732678859',
    out_refund_no: refundNo,
    transaction_id: transactionId,
    out_trade_no: outTradeNo,
    channel: 'ORIGINAL',
    user_received_account: 'payment user account',
    ...(success ? { success_time: '2026-07-14T18:00:00+08:00' } : {}),
    create_time: '2026-07-14T17:59:00+08:00',
    status,
    funds_account: 'UNSETTLED',
    amount: {
      total: totalFen,
      refund: refundFen,
      payer_total: payerTotalFen,
      payer_refund: payerRefundFen,
      settlement_refund: refundFen,
      settlement_total: totalFen,
      discount_refund: refundFen - payerRefundFen,
      currency,
      refund_fee: 0
    },
    refund_account: 'REFUND_SOURCE_SUB_MERCHANT'
  };
}

function splitReturnResponse({
  refundNo,
  outReturnNo,
  amount,
  result = 'SUCCESS',
  order = splitOrder()
}) {
  return {
    sub_mchid: SUB_MCHID,
    order_id: order.wechatSplitOrderId,
    out_order_no: order.splitNo,
    out_return_no: outReturnNo || splitReturnNoForRefund(refundNo),
    return_id: '3008450740201411110007820999',
    return_mchid: SP_MCHID,
    amount,
    description: 'CueTrace table refund',
    result,
    ...(result === 'FAILED' ? { fail_reason: 'BALANCE_NOT_ENOUGH' } : {}),
    create_time: '2026-07-14T17:58:00+08:00',
    finish_time: '2026-07-14T17:58:01+08:00'
  };
}

function command(overrides = {}) {
  return {
    orderId: ORDER_ID,
    refundFen: 5000,
    reason: REASON,
    idempotencyKey: IDEMPOTENCY_KEY,
    ...overrides
  };
}

function verifiedApiError(statusCode, code) {
  const error = new Error(`verified WeChat Pay error ${statusCode}`);
  error.name = 'WechatPayApiError';
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function createRequestFixture({ order, client, context, nowMs } = {}) {
  const store = createMemoryStore(order || baseOrder());
  const calls = [];
  const wechatClient = client || {
    async refund(body) {
      calls.push({ method: 'refund', body: clone(body) });
      const currentOrder = store.state.orders.get(ORDER_ID);
      return refundResponse({
        refundFen: body.amount.refund,
        payerTotalFen: currentOrder.wechatPayerTotalFen,
        payerRefundFen: Math.round(
          body.amount.refund
            * currentOrder.wechatPayerTotalFen
            / currentOrder.wechatOrderTotalFen
        ),
        refundNo: body.out_refund_no
      });
    },
    async queryRefund(outRefundNo, query) {
      calls.push({ method: 'queryRefund', outRefundNo, query: clone(query) });
      const currentOrder = store.state.orders.get(ORDER_ID);
      const currentRefund = store.state.refunds.get(outRefundNo);
      return refundResponse({
        refundFen: currentRefund.refundFen,
        payerTotalFen: currentOrder.wechatPayerTotalFen,
        payerRefundFen: Math.round(
          currentRefund.refundFen
            * currentOrder.wechatPayerTotalFen
            / currentOrder.wechatOrderTotalFen
        ),
        status: 'SUCCESS',
        refundNo: outRefundNo
      });
    },
    async splitReturn(body) {
      calls.push({ method: 'splitReturn', body: clone(body) });
      return splitReturnResponse({ outReturnNo: body.out_return_no, amount: body.amount });
    },
    async querySplitReturn(outReturnNo, query) {
      calls.push({ method: 'querySplitReturn', outReturnNo, query: clone(query) });
      const refund = [...store.state.refunds.values()].find(
        (item) => item.splitReturnNo === outReturnNo
      );
      return splitReturnResponse({
        refundNo: refund.refundNo,
        amount: refund.splitReturnFen,
        order: store.state.orders.get(ORDER_ID)
      });
    }
  };
  const handler = createHandler({
    store,
    getContext: () => (
      typeof context === 'function'
        ? context()
        : (context || { OPENID: OWNER })
    ),
    loadConfig: config,
    createWechatPayClient: () => wechatClient,
    nowMs: nowMs || (() => NOW)
  });
  return { store, calls, client: wechatClient, handler };
}

async function testExactOwnerCommandAndCumulativeGrossBound() {
  const fixture = createRequestFixture();
  assert.deepStrictEqual(
    await fixture.handler({ ...command(), subMchid: SUB_MCHID }),
    { ok: false, code: 'INVALID_ARGUMENT', retryable: false }
  );
  assert.deepStrictEqual(
    await fixture.handler(command({ refundFen: 0 })),
    { ok: false, code: 'INVALID_ARGUMENT', retryable: false }
  );
  assert.deepStrictEqual(
    await fixture.handler(command({ idempotencyKey: 'not canonical!' })),
    { ok: false, code: 'INVALID_ARGUMENT', retryable: false }
  );

  const foreign = createRequestFixture({ context: { OPENID: OTHER_OWNER } });
  assert.deepStrictEqual(
    await foreign.handler(command()),
    { ok: false, code: 'ORDER_NOT_FOUND', retryable: false }
  );
  assert.strictEqual(foreign.store.state.refunds.size, 0);

  const exceeded = createRequestFixture({
    order: baseOrder({ requestedRefundFen: 9000 })
  });
  assert.deepStrictEqual(
    await exceeded.handler(command({ refundFen: 1001 })),
    { ok: false, code: 'REFUND_AMOUNT_EXCEEDED', retryable: false }
  );
  assert.strictEqual(exceeded.store.state.refunds.size, 0);
}

async function testRefundRequiresActiveBoundShopOwnerBeforeSideEffects() {
  const cases = [
    {
      code: 'ACCOUNT_NOT_BOUND',
      mutate(state) {
        state.accounts.get('account_refund_owner').status = 'disabled';
      }
    },
    {
      code: 'SHOP_ROLE_REQUIRED',
      mutate(state) {
        state.users.get(bindingId(OWNER)).roles = ['member'];
      }
    },
    {
      code: 'ACCOUNT_NOT_BOUND',
      mutate(state) {
        state.bindings.get(bindingId(OWNER)).account = 'wrong-account';
      }
    }
  ];
  for (const testCase of cases) {
    const fixture = createRequestFixture();
    testCase.mutate(fixture.store.state);
    const beforeOrder = clone(fixture.store.state.orders.get(ORDER_ID));
    assert.deepStrictEqual(await fixture.handler(command()), {
      ok: false,
      code: testCase.code,
      retryable: false
    });
    assert.strictEqual(fixture.calls.length, 0);
    assert.strictEqual(fixture.store.state.refunds.size, 0);
    assert.strictEqual(fixture.store.state.events.size, 0);
    assert.deepStrictEqual(fixture.store.state.orders.get(ORDER_ID), beforeOrder);
  }
}

async function testRefundCounterIdentityFailsBeforeSideEffects() {
  const correct = baseOrder({
    paymentStatus: 'partially_refunded',
    paidTableFeeFen: 7000,
    totalCostFen: 350,
    shopNetFen: 6650,
    shopSettlementFen: 8150,
    refundedTableFeeFen: 1000,
    reversedTotalCostFen: 50,
    grossRefundedFen: 1500,
    couponRefundedFen: 500,
    retainedCouponSubsidyFen: 1500,
    requestedRefundFen: 2000
  });
  assert.deepStrictEqual(refundCounters(correct), {
    grossRefundedFen: 1500,
    payerRefundedFen: 1000,
    couponRefundedFen: 500,
    requestedRefundFen: 2000,
    splitReturnedFen: 0
  });
  assert.strictEqual(validRefundOrder(correct, OWNER), true);

  for (const grossRefundedFen of [1499, 1501]) {
    const corrupt = baseOrder({
      ...correct,
      grossRefundedFen
    });
    assert.strictEqual(refundCounters(corrupt), null);
    assert.strictEqual(validRefundOrder(corrupt, OWNER), false);
    const fixture = createRequestFixture({ order: corrupt });
    const before = clone(fixture.store.state.orders.get(ORDER_ID));
    assert.deepStrictEqual(await fixture.handler(command({ refundFen: 100 })), {
      ok: false,
      code: 'ORDER_STATE_INVALID',
      retryable: false
    });
    assert.strictEqual(fixture.calls.length, 0);
    assert.strictEqual(fixture.store.state.refunds.size, 0);
    assert.deepStrictEqual(fixture.store.state.orders.get(ORDER_ID), before);
  }

  const replayFixture = createRequestFixture();
  assert.strictEqual((await replayFixture.handler(command())).status, 'processing');
  replayFixture.store.state.orders.get(ORDER_ID).grossRefundedFen = 1;
  const replayOrderBefore = clone(replayFixture.store.state.orders.get(ORDER_ID));
  const replayRefundBefore = clone(
    replayFixture.store.state.refunds.get(
      refundNoForOrder(ORDER_ID, IDEMPOTENCY_KEY)
    )
  );
  assert.deepStrictEqual(await replayFixture.handler(command()), {
    ok: false,
    code: 'ORDER_STATE_INVALID',
    retryable: false
  });
  assert.strictEqual(replayFixture.calls.length, 1);
  assert.deepStrictEqual(
    replayFixture.store.state.orders.get(ORDER_ID),
    replayOrderBefore
  );
  assert.deepStrictEqual(
    replayFixture.store.state.refunds.get(replayRefundBefore.refundNo),
    replayRefundBefore
  );

  const recoveryFixture = createRequestFixture();
  assert.strictEqual((await recoveryFixture.handler(command())).status, 'processing');
  recoveryFixture.store.state.orders.get(ORDER_ID).grossRefundedFen = 1;
  const recoveryOrderBefore = clone(recoveryFixture.store.state.orders.get(ORDER_ID));
  const recoveryRefund = recoveryFixture.store.state.refunds.get(
    refundNoForOrder(ORDER_ID, IDEMPOTENCY_KEY)
  );
  const recoveryRefundBefore = clone(recoveryRefund);
  const timerHandler = createRecoveryHandler(
    recoveryFixture.store,
    recoveryFixture.client
  );
  assert.deepStrictEqual(await timerHandler(refundTimer), {
    ok: true,
    scanned: 1,
    claimed: 0,
    succeeded: 0,
    pending: 0,
    manualReview: 0,
    conflicts: 1
  });
  assert.strictEqual(recoveryFixture.calls.length, 1);
  assert.strictEqual(recoveryFixture.store.state.events.size, 0);
  assert.deepStrictEqual(
    recoveryFixture.store.state.orders.get(ORDER_ID),
    recoveryOrderBefore
  );
  assert.deepStrictEqual(
    recoveryFixture.store.state.refunds.get(recoveryRefund.refundNo),
    recoveryRefundBefore
  );
}

async function testTerminalReplayValidatesRefundCounterIdentity() {
  for (const terminalStatus of ['succeeded', 'manual_review']) {
    const fixture = createRequestFixture();
    const refundNo = refundNoForOrder(ORDER_ID, IDEMPOTENCY_KEY);
    assert.strictEqual((await fixture.handler(command())).status, 'processing');
    fixture.store.state.orders.get(ORDER_ID).grossRefundedFen = 1;
    fixture.store.state.refunds.get(refundNo).status = terminalStatus;
    const orderBefore = clone(fixture.store.state.orders.get(ORDER_ID));
    const refundBefore = clone(fixture.store.state.refunds.get(refundNo));
    const callCountBefore = fixture.calls.length;

    assert.deepStrictEqual(await fixture.handler(command()), {
      ok: false,
      code: 'ORDER_STATE_INVALID',
      retryable: false
    });
    assert.strictEqual(fixture.calls.length, callCountBefore);
    assert.deepStrictEqual(
      fixture.store.state.orders.get(ORDER_ID),
      orderBefore
    );
    assert.deepStrictEqual(
      fixture.store.state.refunds.get(refundNo),
      refundBefore
    );
  }
}

async function testPendingSplitSubmitsExactPartnerRefundAndOnlyProcesses() {
  const fixture = createRequestFixture();
  const refundNo = refundNoForOrder(ORDER_ID, IDEMPOTENCY_KEY);
  const outcome = await fixture.handler(command());

  assert.deepStrictEqual(outcome, { ok: true, refundNo, status: 'processing' });
  assert.deepStrictEqual(fixture.calls, [{
    method: 'refund',
    body: {
      sub_mchid: SUB_MCHID,
      transaction_id: TRANSACTION_ID,
      out_refund_no: refundNo,
      reason: REASON,
      notify_url: REFUND_URL,
      amount: { refund: 5000, total: 10000, currency: 'CNY' }
    }
  }]);
  const refund = fixture.store.state.refunds.get(refundNo);
  assert.strictEqual(refund._id, refundNo);
  assert.strictEqual(refund.refundNo, refundNo);
  assert.strictEqual(refund.subMchid, SUB_MCHID);
  assert.strictEqual(refund.status, 'processing');
  assert.strictEqual(refund.splitReturnStatus, 'not_required');
  assert.strictEqual(refund.requestedAt, NOW);
  assert.strictEqual(refund.refundClaim.requestedAt, NOW);
  assert.strictEqual(refund.refundCreateTime, '2026-07-14T17:59:00+08:00');
  assert.strictEqual(
    refund.refundCreatedAt,
    Date.parse('2026-07-14T17:59:00+08:00')
  );
  assert.strictEqual(fixture.store.state.orders.get(ORDER_ID).refundClaim.status, 'processing');
  assert.strictEqual(fixture.store.state.orders.get(ORDER_ID).refundedTableFeeFen, 0);
  assert.strictEqual(fixture.store.state.events.size, 0);
}

async function testRefundSubMchidIsImmutable() {
  const fixture = createRequestFixture();
  const refundNo = refundNoForOrder(ORDER_ID, IDEMPOTENCY_KEY);
  assert.strictEqual((await fixture.handler(command())).status, 'processing');
  fixture.store.state.refunds.get(refundNo).subMchid = '1900000999';
  assert.deepStrictEqual(await fixture.handler(command()), {
    ok: false,
    code: 'IDEMPOTENCY_CONFLICT',
    retryable: false
  });
  assert.strictEqual(fixture.calls.length, 1);
  const notify = createNotifyFixture(
    fixture.store,
    notificationResource(refundNo)
  );
  assert.deepStrictEqual(await notify.handler(notify.rawBody), {
    statusCode: 204,
    body: ''
  });
  assert.strictEqual(
    fixture.store.state.refunds.get(refundNo).status,
    'manual_review'
  );
}

async function testCompletedSplitReturnsAndQueriesBeforeRefund() {
  const order = splitOrder();
  const fixture = createRequestFixture({ order });
  const refundNo = refundNoForOrder(ORDER_ID, IDEMPOTENCY_KEY);
  const outcome = await fixture.handler(command({ refundFen: 2000 }));

  assert.deepStrictEqual(outcome, { ok: true, refundNo, status: 'processing' });
  assert.deepStrictEqual(
    fixture.calls.map((call) => call.method),
    ['splitReturn', 'querySplitReturn', 'refund']
  );
  assert.deepStrictEqual(fixture.calls[0].body, {
    sub_mchid: SUB_MCHID,
    out_order_no: SPLIT_NO,
    out_return_no: splitReturnNoForRefund(refundNo),
    return_mchid: SP_MCHID,
    amount: 100,
    description: 'CueTrace table refund'
  });
  assert.deepStrictEqual(fixture.calls[1], {
    method: 'querySplitReturn',
    outReturnNo: splitReturnNoForRefund(refundNo),
    query: { sub_mchid: SUB_MCHID, out_order_no: SPLIT_NO }
  });
  assert.strictEqual(
    fixture.store.state.refunds.get(refundNo).splitReturnStatus,
    'succeeded'
  );
  assert.strictEqual(
    fixture.store.state.refunds.get(refundNo).splitReturnBasis,
    'provisional_cumulative_requested_gross'
  );
  assert.strictEqual(
    fixture.store.state.refunds.get(refundNo).splitReturnAdjustmentStatus,
    'pending'
  );
  assert.strictEqual(fixture.store.state.orders.get(ORDER_ID).splitReturnedFen, 100);
}

async function testCompletedSplitTracksZeroRoundedProvisionalAdjustment() {
  const fixture = createRequestFixture({ order: splitOrder() });
  const refundNo = refundNoForOrder(ORDER_ID, IDEMPOTENCY_KEY);
  const outcome = await fixture.handler(command({ refundFen: 1 }));

  assert.deepStrictEqual(outcome, { ok: true, refundNo, status: 'processing' });
  assert.deepStrictEqual(
    fixture.calls.map((call) => call.method),
    ['refund']
  );
  const refund = fixture.store.state.refunds.get(refundNo);
  assert.strictEqual(refund.splitReturnFen, 0);
  assert.strictEqual(refund.splitReturnStatus, 'not_required');
  assert.strictEqual(
    refund.splitReturnBasis,
    'provisional_cumulative_requested_gross'
  );
  assert.strictEqual(refund.splitReturnAdjustmentStatus, 'pending');
  assert.strictEqual(fixture.store.state.orders.get(ORDER_ID).splitReturnedFen, 0);
}

async function testCompletedSplitRequiresCanonicalTask6ASnapshot() {
  const fixture = createRequestFixture({
    order: splitOrder({ splitClaim: null })
  });
  assert.deepStrictEqual(await fixture.handler(command({ refundFen: 2000 })), {
    ok: false,
    code: 'ORDER_STATE_INVALID',
    retryable: false
  });
  assert.strictEqual(fixture.calls.length, 0);
  assert.strictEqual(fixture.store.state.refunds.size, 0);
}

async function testPostSplitCouponRefundReturnsShareAndRecomputesRetainedCash() {
  const couponSplit = splitOrder({
    wechatOrderTotalFen: 10000,
    wechatPayerTotalFen: 8000,
    couponSubsidyFen: 2000,
    paidTableFeeFen: 8000,
    totalCostFen: 400,
    shopNetFen: 7600,
    shopSettlementFen: 9600,
    channelFeeFen: 80,
    platformNetFen: 320
  });
  assert.strictEqual(validRefundOrder(couponSplit, OWNER), true);
  const fixture = createRequestFixture({ order: couponSplit });
  const refundNo = refundNoForOrder(ORDER_ID, IDEMPOTENCY_KEY);

  assert.deepStrictEqual(await fixture.handler(command({ refundFen: 2000 })), {
    ok: true,
    refundNo,
    status: 'processing'
  });
  assert.deepStrictEqual(
    fixture.calls.map((call) => call.method),
    ['splitReturn', 'querySplitReturn', 'refund']
  );
  assert.strictEqual(fixture.calls[0].body.amount, 100);
  assert.deepStrictEqual(fixture.calls[2].body.amount, {
    refund: 2000,
    total: 10000,
    currency: 'CNY'
  });

  assert.deepStrictEqual(await fixture.handler(command({ refundFen: 2000 })), {
    ok: true,
    refundNo,
    status: 'succeeded'
  });
  assert.deepStrictEqual(
    fixture.calls.map((call) => call.method),
    ['splitReturn', 'querySplitReturn', 'refund', 'queryRefund']
  );
  const updated = fixture.store.state.orders.get(ORDER_ID);
  assert.strictEqual(updated.grossRefundedFen, 2000);
  assert.strictEqual(updated.refundedTableFeeFen, 1600);
  assert.strictEqual(updated.couponRefundedFen, 400);
  assert.strictEqual(
    updated.grossRefundedFen,
    updated.refundedTableFeeFen + updated.couponRefundedFen
  );
  assert.strictEqual(updated.paidTableFeeFen, 6400);
  assert.strictEqual(updated.retainedCouponSubsidyFen, 1600);
  assert.strictEqual(updated.totalCostFen, 320);
  assert.strictEqual(updated.shopNetFen, 6080);
  assert.strictEqual(updated.shopSettlementFen, 7680);
  assert.strictEqual(
    updated.shopSettlementFen,
    updated.shopNetFen + updated.retainedCouponSubsidyFen
  );
  assert.strictEqual(updated.reversedTotalCostFen, 80);
  assert.strictEqual(updated.splitReturnedFen, 100);
}

async function testReversedCouponSplitRefundSkipsDuplicateShareReturn() {
  const reversedCouponSplit = splitOrder({
      wechatOrderTotalFen: 10000,
      wechatPayerTotalFen: 8000,
      couponSubsidyFen: 2000,
      paidTableFeeFen: 8000,
      totalCostFen: 400,
      shopNetFen: 7600,
      shopSettlementFen: 9600,
      channelFeeFen: 80,
      platformNetFen: 320,
      splitStatus: 'reversed',
      splitReturnedFen: 320
  });
  assert.strictEqual(validRefundOrder(reversedCouponSplit, OWNER), true);
  const fixture = createRequestFixture({ order: reversedCouponSplit });
  const refundNo = refundNoForOrder(ORDER_ID, IDEMPOTENCY_KEY);

  assert.deepStrictEqual(await fixture.handler(command({ refundFen: 2000 })), {
    ok: true,
    refundNo,
    status: 'processing'
  });
  assert.deepStrictEqual(fixture.calls.map((call) => call.method), ['refund']);
  assert.deepStrictEqual(fixture.calls[0].body.amount, {
    refund: 2000,
    total: 10000,
    currency: 'CNY'
  });
}

function testCompletedSplitAcceptsPersistedTimeRepresentations() {
  const completedAt = NOW - 8000;
  const dateOrder = splitOrder();
  dateOrder.splitClaim.completedAt = new Date(completedAt);
  dateOrder.splitCompletedAt = new Date(completedAt);
  assert.strictEqual(validRefundOrder(dateOrder, OWNER), true);

  const isoOrder = splitOrder();
  isoOrder.splitClaim.completedAt = new Date(completedAt).toISOString();
  isoOrder.splitCompletedAt = new Date(completedAt).toISOString();
  assert.strictEqual(validRefundOrder(isoOrder, OWNER), true);

  for (const invalid of [
    (() => {
      const order = splitOrder();
      order.splitClaim.completedAt = new Date(completedAt);
      order.splitCompletedAt = new Date(completedAt + 1);
      return order;
    })(),
    (() => {
      const order = splitOrder();
      order.splitClaim.completedAt = '2026-02-31T12:00:00+08:00';
      order.splitCompletedAt = '2026-02-31T12:00:00+08:00';
      return order;
    })(),
    (() => {
      const order = splitOrder();
      order.splitClaim.completedAt = new Date(Number.NaN);
      order.splitCompletedAt = new Date(Number.NaN);
      return order;
    })(),
    (() => {
      const order = splitOrder();
      order.splitClaim.completedAt = { seconds: completedAt / 1000 };
      order.splitCompletedAt = { seconds: completedAt / 1000 };
      return order;
    })()
  ]) {
    assert.strictEqual(validRefundOrder(invalid, OWNER), false);
  }
}

async function testNonterminalReturnBlocksRefundAndRecoversWithSameNumber() {
  const order = splitOrder();
  const calls = [];
  let queryResult = 'PROCESSING';
  let store;
  const client = {
    async splitReturn(body) {
      calls.push({ method: 'splitReturn', body: clone(body) });
      return splitReturnResponse({ outReturnNo: body.out_return_no, amount: body.amount, result: 'PROCESSING', order });
    },
    async querySplitReturn(outReturnNo, query) {
      calls.push({ method: 'querySplitReturn', outReturnNo, query: clone(query) });
      const refund = [...store.state.refunds.values()][0];
      return splitReturnResponse({ refundNo: refund.refundNo, amount: refund.splitReturnFen, result: queryResult, order });
    },
    async refund(body) {
      calls.push({ method: 'refund', body: clone(body) });
      return refundResponse({ refundFen: body.amount.refund, payerTotalFen: 10000, payerRefundFen: body.amount.refund });
    },
    async queryRefund() {
      throw new Error('not expected');
    }
  };
  const fixture = createRequestFixture({ order, client });
  store = fixture.store;

  assert.deepStrictEqual(await fixture.handler(command({ refundFen: 2000 })), {
    ok: false,
    code: 'SPLIT_RETURN_PROCESSING',
    retryable: true
  });
  assert.strictEqual(calls.some((call) => call.method === 'refund'), false);
  const originalReturnNo = [...store.state.refunds.values()][0].splitReturnNo;

  queryResult = 'SUCCESS';
  assert.deepStrictEqual(await fixture.handler(command({ refundFen: 2000 })), {
    ok: true,
    refundNo: refundNoForOrder(ORDER_ID, IDEMPOTENCY_KEY),
    status: 'processing'
  });
  assert.strictEqual(calls.filter((call) => call.method === 'splitReturn').length, 1);
  assert.strictEqual(calls.filter((call) => call.method === 'refund').length, 1);
  assert.strictEqual([...store.state.refunds.values()][0].splitReturnNo, originalReturnNo);
}

async function testMissingSplitReturnResubmitsExactRequestThenRequeries() {
  const order = splitOrder();
  const calls = [];
  let queryMode = 'processing';
  let missingQueries = 2;
  let store;
  const client = {
    async splitReturn(body) {
      calls.push({ method: 'splitReturn', body: clone(body) });
      return splitReturnResponse({
        outReturnNo: body.out_return_no,
        amount: body.amount,
        result: 'PROCESSING',
        order
      });
    },
    async querySplitReturn(outReturnNo, query) {
      calls.push({ method: 'querySplitReturn', outReturnNo, query: clone(query) });
      if (missingQueries > 0) {
        missingQueries -= 1;
        throw verifiedApiError(404, 'RESOURCE_NOT_EXISTS');
      }
      const refund = [...store.state.refunds.values()][0];
      return splitReturnResponse({
        refundNo: refund.refundNo,
        amount: refund.splitReturnFen,
        result: queryMode === 'success' ? 'SUCCESS' : 'PROCESSING',
        order
      });
    },
    async refund(body) {
      calls.push({ method: 'refund', body: clone(body) });
      return refundResponse({
        refundFen: body.amount.refund,
        payerTotalFen: 10000,
        payerRefundFen: body.amount.refund,
        refundNo: body.out_refund_no
      });
    },
    async queryRefund() {
      throw new Error('not expected');
    }
  };
  const fixture = createRequestFixture({ order, client });
  store = fixture.store;

  assert.deepStrictEqual(await fixture.handler(command({ refundFen: 2000 })), {
    ok: false,
    code: 'SPLIT_RETURN_RECONCILIATION_REQUIRED',
    retryable: true
  });
  const refund = [...store.state.refunds.values()][0];
  const originalReturnNo = refund.splitReturnNo;
  const originalReturnBody = clone(calls[0].body);

  const beforeRecovery = calls.length;
  assert.deepStrictEqual(await fixture.handler(command({ refundFen: 2000 })), {
    ok: false,
    code: 'SPLIT_RETURN_PROCESSING',
    retryable: true
  });
  assert.deepStrictEqual(
    calls.slice(beforeRecovery).map((call) => call.method),
    ['querySplitReturn', 'splitReturn', 'querySplitReturn']
  );
  assert.deepStrictEqual(calls.filter(
    (call) => call.method === 'splitReturn'
  ).map((call) => call.body), [originalReturnBody, originalReturnBody]);

  queryMode = 'success';
  assert.deepStrictEqual(await fixture.handler(command({ refundFen: 2000 })), {
    ok: true,
    refundNo: refund.refundNo,
    status: 'processing'
  });
  assert.strictEqual(calls.filter((call) => call.method === 'splitReturn').length, 2);
  assert.strictEqual(calls.filter((call) => call.method === 'refund').length, 1);
  assert(calls.filter((call) => call.method === 'querySplitReturn').every(
    (call) => call.outReturnNo === originalReturnNo
  ));
  assert.strictEqual(refund.splitReturnNo, originalReturnNo);
}

async function testAcceptedRefundNeedsQueryForTerminalCouponAwareMath() {
  const fixture = createRequestFixture();
  const refundNo = refundNoForOrder(ORDER_ID, IDEMPOTENCY_KEY);
  await fixture.handler(command());
  assert.strictEqual(fixture.store.state.refunds.get(refundNo).status, 'processing');

  const outcome = await fixture.handler(command());
  assert.deepStrictEqual(outcome, { ok: true, refundNo, status: 'succeeded' });
  assert.deepStrictEqual(fixture.calls[1], {
    method: 'queryRefund',
    outRefundNo: refundNo,
    query: { sub_mchid: SUB_MCHID }
  });

  const order = fixture.store.state.orders.get(ORDER_ID);
  assert.strictEqual(order.paymentStatus, 'partially_refunded');
  assert.strictEqual(order.grossRefundedFen, 5000);
  assert.strictEqual(order.refundedTableFeeFen, 4000);
  assert.strictEqual(order.couponRefundedFen, 1000);
  assert.strictEqual(
    order.grossRefundedFen,
    order.refundedTableFeeFen + order.couponRefundedFen
  );
  assert.strictEqual(order.retainedCouponSubsidyFen, 1000);
  assert.strictEqual(order.paidTableFeeFen, 4000);
  assert.strictEqual(order.totalCostFen, 200);
  assert.strictEqual(order.shopNetFen, 3800);
  assert.strictEqual(order.shopSettlementFen, 4800);
  assert.strictEqual(order.reversedTotalCostFen, 200);
  assert.strictEqual(order.channelFeeFen, null);
  assert.strictEqual(order.platformNetFen, null);
  assert.strictEqual(order.refundFeeReconciliationStatus, 'pending');
  assert.strictEqual(fixture.store.state.refunds.get(refundNo).status, 'succeeded');
  assert.strictEqual(fixture.store.state.events.size, 1);
}

async function testMultipleRefundsUseCumulativeFactsAndFullRefundZerosCost() {
  const fixture = createRequestFixture();
  await fixture.handler(command());
  await fixture.handler(command());

  const secondKey = 'refund-case-0002';
  const secondRefundNo = refundNoForOrder(ORDER_ID, secondKey);
  const originalRefund = fixture.client.refund;
  fixture.client.refund = async (body) => {
    fixture.calls.push({ method: 'refund', body: clone(body) });
    return refundResponse({
      refundFen: body.amount.refund,
      payerTotalFen: 8000,
      payerRefundFen: 4000,
      refundNo: body.out_refund_no,
      status: 'SUCCESS'
    });
  };
  fixture.client.queryRefund = async (outRefundNo, query) => {
    fixture.calls.push({ method: 'queryRefund', outRefundNo, query: clone(query) });
    return refundResponse({
      refundFen: 5000,
      payerTotalFen: 8000,
      payerRefundFen: 4000,
      refundNo: outRefundNo,
      status: 'SUCCESS'
    });
  };

  await fixture.handler(command({ idempotencyKey: secondKey }));
  assert.strictEqual(fixture.store.state.refunds.get(secondRefundNo).status, 'processing');
  await fixture.handler(command({ idempotencyKey: secondKey }));
  fixture.client.refund = originalRefund;

  const order = fixture.store.state.orders.get(ORDER_ID);
  assert.strictEqual(order.paymentStatus, 'refunded');
  assert.strictEqual(order.grossRefundedFen, 10000);
  assert.strictEqual(order.refundedTableFeeFen, 8000);
  assert.strictEqual(order.couponRefundedFen, 2000);
  assert.strictEqual(
    order.grossRefundedFen,
    order.refundedTableFeeFen + order.couponRefundedFen
  );
  assert.strictEqual(order.retainedCouponSubsidyFen, 0);
  assert.strictEqual(order.paidTableFeeFen, 0);
  assert.strictEqual(order.totalCostFen, 0);
  assert.strictEqual(order.shopNetFen, 0);
  assert.strictEqual(order.shopSettlementFen, 0);
  assert.strictEqual(order.reversedTotalCostFen, 400);
  assert.strictEqual(fixture.store.state.events.size, 2);
  const callsBeforeReplay = fixture.calls.length;
  assert.deepStrictEqual(await fixture.handler(command({
    idempotencyKey: secondKey
  })), {
    ok: true,
    refundNo: secondRefundNo,
    status: 'succeeded'
  });
  assert.strictEqual(fixture.calls.length, callsBeforeReplay);
}

async function testFullRefundReturnsAllRemainingPlatformSplit() {
  const fixture = createRequestFixture({ order: splitOrder() });
  assert.strictEqual(
    (await fixture.handler(command({ refundFen: 2000 }))).status,
    'processing'
  );
  assert.strictEqual(
    (await fixture.handler(command({ refundFen: 2000 }))).status,
    'succeeded'
  );

  const secondKey = 'refund-case-0002';
  const secondAccepted = await fixture.handler(command({
    refundFen: 8000,
    idempotencyKey: secondKey
  }));
  assert.deepStrictEqual(secondAccepted, {
    ok: true,
    refundNo: refundNoForOrder(ORDER_ID, secondKey),
    status: 'processing'
  });
  assert.strictEqual(
    (await fixture.handler(command({ refundFen: 8000, idempotencyKey: secondKey }))).status,
    'succeeded'
  );

  const returnAmounts = fixture.calls
    .filter((call) => call.method === 'splitReturn')
    .map((call) => call.body.amount);
  assert.deepStrictEqual(returnAmounts, [100, 300]);
  const order = fixture.store.state.orders.get(ORDER_ID);
  assert.strictEqual(order.splitReturnedFen, 400);
  assert.strictEqual(order.splitStatus, 'reversed');
  assert.strictEqual(order.grossRefundedFen, 10000);
  assert.strictEqual(order.refundedTableFeeFen, 10000);
  assert.strictEqual(order.paymentStatus, 'refunded');
  assert.strictEqual(order.paidTableFeeFen, 0);
  assert.strictEqual(order.totalCostFen, 0);
  assert.strictEqual(order.preRefundChannelFeeFen, 100);
  assert.strictEqual(order.preRefundPlatformNetFen, 400);
  assert.strictEqual(order.preRefundChannelFeeEvidenceHash, 'a'.repeat(64));
  assert.strictEqual(order.channelFeeEvidenceHash, null);
  assert.strictEqual(order.financeAutomationBlocked, true);
}

async function testTerminalRefundIdMustMatchAcceptedIdentity() {
  const fixture = createRequestFixture();
  const refundNo = refundNoForOrder(ORDER_ID, IDEMPOTENCY_KEY);
  await fixture.handler(command());
  fixture.client.queryRefund = async (outRefundNo, query) => {
    fixture.calls.push({ method: 'queryRefund', outRefundNo, query: clone(query) });
    return {
      ...refundResponse({
        refundFen: 5000,
        payerTotalFen: 8000,
        payerRefundFen: 4000,
        refundNo: outRefundNo,
        status: 'SUCCESS'
      }),
      refund_id: '50000000382019052709732670000'
    };
  };

  assert.deepStrictEqual(await fixture.handler(command()), {
    ok: false,
    code: 'REFUND_MANUAL_REVIEW',
    retryable: false
  });
  assert.strictEqual(fixture.store.state.orders.get(ORDER_ID).orderStatus, 'manual_review');
  assert.strictEqual(fixture.store.state.orders.get(ORDER_ID).refundedTableFeeFen, 0);
  assert.strictEqual(fixture.store.state.refunds.get(refundNo).status, 'manual_review');
}

async function testAcceptedResponseRequiresOfficialCreateTime() {
  const client = {
    async refund(body) {
      const remote = refundResponse({
        refundFen: body.amount.refund,
        payerTotalFen: 8000,
        payerRefundFen: 4000,
        refundNo: body.out_refund_no
      });
      delete remote.create_time;
      return remote;
    },
    async queryRefund() {
      throw new Error('not expected');
    },
    async splitReturn() {
      throw new Error('not expected');
    },
    async querySplitReturn() {
      throw new Error('not expected');
    }
  };
  const fixture = createRequestFixture({ client });
  assert.deepStrictEqual(await fixture.handler(command()), {
    ok: false,
    code: 'REFUND_MANUAL_REVIEW',
    retryable: false
  });
  assert.strictEqual(
    fixture.store.state.orders.get(ORDER_ID).orderStatus,
    'manual_review'
  );
}

function testNoCouponRefundRequiresPayerAmountToMatchGross() {
  const order = splitOrder();
  const refundNo = refundNoForOrder(ORDER_ID, IDEMPOTENCY_KEY);
  const localRefund = {
    refundNo,
    subMchid: SUB_MCHID,
    refundFen: 5000,
    cumulativePayerBeforeFen: 0,
    wechatRefundId: ''
  };
  const remote = refundResponse({
    refundNo,
    refundFen: 5000,
    payerTotalFen: 10000,
    payerRefundFen: 4999,
    status: 'SUCCESS'
  });
  const validation = validateQueryRefund(remote, order, localRefund, true);
  assert(validation.reasons.includes('AMOUNT_PAYER_REFUND'));
  assert.strictEqual(validation.normalized, null);
}

async function testAmbiguousSubmissionQueriesSameRefundInsteadOfResubmitting() {
  let refundCalls = 0;
  let queryCalls = 0;
  const client = {
    async refund() {
      refundCalls += 1;
      throw new Error('timeout after send');
    },
    async queryRefund(outRefundNo) {
      queryCalls += 1;
      return refundResponse({
        refundFen: 5000,
        payerTotalFen: 8000,
        payerRefundFen: 4000,
        refundNo: outRefundNo,
        status: 'SUCCESS'
      });
    },
    async splitReturn() {
      throw new Error('not expected');
    },
    async querySplitReturn() {
      throw new Error('not expected');
    }
  };
  const fixture = createRequestFixture({ client });
  assert.deepStrictEqual(await fixture.handler(command()), {
    ok: false,
    code: 'REFUND_RECONCILIATION_REQUIRED',
    retryable: true
  });
  assert.deepStrictEqual(await fixture.handler(command()), {
    ok: true,
    refundNo: refundNoForOrder(ORDER_ID, IDEMPOTENCY_KEY),
    status: 'succeeded'
  });
  assert.strictEqual(refundCalls, 1);
  assert.strictEqual(queryCalls, 1);
}

async function testVerifiedNotFoundRetriesSameDeterministicRefundNumber() {
  const submitted = [];
  let queryCalls = 0;
  const client = {
    async refund(body) {
      submitted.push(body.out_refund_no);
      if (submitted.length === 1) throw new Error('timeout before send');
      return refundResponse({
        refundFen: body.amount.refund,
        payerTotalFen: 8000,
        payerRefundFen: 4000,
        refundNo: body.out_refund_no
      });
    },
    async queryRefund() {
      queryCalls += 1;
      const error = new Error('verified refund does not exist');
      error.name = 'WechatPayApiError';
      error.statusCode = 404;
      error.code = 'RESOURCE_NOT_EXISTS';
      throw error;
    },
    async splitReturn() {
      throw new Error('not expected');
    },
    async querySplitReturn() {
      throw new Error('not expected');
    }
  };
  const fixture = createRequestFixture({ client });
  assert.strictEqual((await fixture.handler(command())).code, 'REFUND_RECONCILIATION_REQUIRED');
  assert.deepStrictEqual(await fixture.handler(command()), {
    ok: true,
    refundNo: refundNoForOrder(ORDER_ID, IDEMPOTENCY_KEY),
    status: 'processing'
  });
  assert.strictEqual(queryCalls, 1);
  assert.deepStrictEqual(submitted, [
    refundNoForOrder(ORDER_ID, IDEMPOTENCY_KEY),
    refundNoForOrder(ORDER_ID, IDEMPOTENCY_KEY)
  ]);
}

async function testTerminalRefundQueriesBecomeManualReview() {
  for (const status of ['CLOSED', 'ABNORMAL']) {
    let store;
    const client = {
      async refund(body) {
        return refundResponse({
          refundFen: body.amount.refund,
          payerTotalFen: 8000,
          payerRefundFen: 4000,
          refundNo: body.out_refund_no
        });
      },
      async queryRefund(outRefundNo) {
        const refund = store.state.refunds.get(outRefundNo);
        const order = store.state.orders.get(refund.orderId);
        return refundResponse({
          refundFen: refund.refundFen,
          payerTotalFen: order.wechatPayerTotalFen,
          payerRefundFen: 4000,
          refundNo: outRefundNo,
          transactionId: order.wechatTransactionId,
          outTradeNo: order.outTradeNo,
          status
        });
      },
      async splitReturn() { throw new Error('not expected'); },
      async querySplitReturn() { throw new Error('not expected'); }
    };
    const fixture = createRequestFixture({ client });
    store = fixture.store;
    const refundNo = refundNoForOrder(ORDER_ID, IDEMPOTENCY_KEY);
    assert.strictEqual((await fixture.handler(command())).status, 'processing');
    const timer = createRecoveryHandler(store, client);
    assert.deepStrictEqual(await timer(refundTimer), {
      ok: true,
      scanned: 1,
      claimed: 1,
      succeeded: 0,
      pending: 0,
      manualReview: 1,
      conflicts: 0
    });
    assert.strictEqual(store.state.refunds.get(refundNo).status, 'manual_review');
    assert.strictEqual(store.state.orders.get(ORDER_ID).orderStatus, 'manual_review');
    assert.strictEqual(store.state.events.size, 1);
  }
}

async function testVerifiedClientErrorsSeparateManualFromRetry() {
  for (const scenario of [
    {
      error: verifiedApiError(400, 'PARAM_ERROR'),
      expected: { ok: false, code: 'REFUND_MANUAL_REVIEW', retryable: false },
      status: 'manual_review'
    },
    {
      error: verifiedApiError(500, 'SYSTEM_ERROR'),
      expected: {
        ok: false,
        code: 'REFUND_RECONCILIATION_REQUIRED',
        retryable: true
      },
      status: 'processing'
    },
    {
      error: new Error('socket timeout'),
      expected: {
        ok: false,
        code: 'REFUND_RECONCILIATION_REQUIRED',
        retryable: true
      },
      status: 'processing'
    }
  ]) {
    const client = {
      async refund(body) {
        return refundResponse({
          refundFen: body.amount.refund,
          payerTotalFen: 8000,
          payerRefundFen: 4000,
          refundNo: body.out_refund_no
        });
      },
      async queryRefund() { throw scenario.error; },
      async splitReturn() { throw new Error('not expected'); },
      async querySplitReturn() { throw new Error('not expected'); }
    };
    const fixture = createRequestFixture({ client });
    const refundNo = refundNoForOrder(ORDER_ID, IDEMPOTENCY_KEY);
    assert.strictEqual((await fixture.handler(command())).status, 'processing');
    assert.deepStrictEqual(await fixture.handler(command()), scenario.expected);
    assert.strictEqual(fixture.store.state.refunds.get(refundNo).status, scenario.status);
    assert.strictEqual(
      fixture.store.state.events.size,
      scenario.status === 'manual_review' ? 1 : 0
    );
  }
}

function notificationResource(refundNo, overrides = {}) {
  const refundStatus = overrides.refund_status || 'SUCCESS';
  return {
    sp_mchid: SP_MCHID,
    sub_mchid: SUB_MCHID,
    transaction_id: TRANSACTION_ID,
    out_trade_no: OUT_TRADE_NO,
    refund_id: '50000000382019052709732678859',
    out_refund_no: refundNo,
    refund_status: refundStatus,
    ...(refundStatus === 'SUCCESS'
      ? { success_time: '2026-07-14T18:00:00+08:00' }
      : {}),
    user_received_account: 'payment user account',
    amount: {
      total: 10000,
      refund: 5000,
      payer_total: 8000,
      payer_refund: 4000
    },
    ...clone(overrides)
  };
}

function notificationEnvelope(overrides = {}) {
  return {
    id: 'EV-2026071418000000001',
    create_time: '2026-07-14T18:00:00+08:00',
    resource_type: 'encrypt-resource',
    event_type: 'REFUND.SUCCESS',
    summary: 'refund succeeded',
    resource: {
      algorithm: 'AEAD_AES_256_GCM',
      original_type: 'refund',
      ciphertext: 'AA==',
      nonce: '123456789012',
      associated_data: ''
    },
    ...clone(overrides)
  };
}

function createNotifyFixture(
  store,
  resource,
  verify = true,
  envelope = notificationEnvelope()
) {
  const rawBody = Buffer.from(JSON.stringify(envelope), 'utf8');
  const seen = {};
  const handler = createNotifyHandler({
    store,
    loadConfig: config,
    extractWechatPayEvent(event) {
      seen.event = event;
      return { headers: { timestamp: '1', nonce: 'n', signature: 's', serial: 'x' }, rawBody };
    },
    verifyWechatPaySignature(input) {
      seen.verifiedRawBody = input.rawBody;
      return verify;
    },
    decryptResource() {
      return Buffer.from(JSON.stringify(resource), 'utf8');
    },
    nowSeconds: () => Math.floor(NOW / 1000)
  });
  return { handler, rawBody, seen };
}

async function testRawVerifiedNotificationWithoutCurrencyFinalizesOnce() {
  const fixture = createRequestFixture();
  const refundNo = refundNoForOrder(ORDER_ID, IDEMPOTENCY_KEY);
  await fixture.handler(command());
  const notify = createNotifyFixture(
    fixture.store,
    notificationResource(refundNo)
  );

  assert.deepStrictEqual(await notify.handler({ body: 'ignored parsed body' }), {
    statusCode: 204,
    body: ''
  });
  assert.strictEqual(notify.seen.verifiedRawBody, notify.rawBody);
  assert.strictEqual(fixture.store.state.orders.get(ORDER_ID).refundedTableFeeFen, 4000);
  assert.strictEqual(fixture.store.state.events.size, 1);

  assert.deepStrictEqual(await notify.handler({ body: 'duplicate' }), {
    statusCode: 204,
    body: ''
  });
  assert.strictEqual(fixture.store.state.events.size, 1);
  assert.strictEqual(fixture.store.state.orders.get(ORDER_ID).refundedTableFeeFen, 4000);
}

async function testForgedCallbackWritesNothingAndSignedMismatchReviews() {
  const forgedFixture = createRequestFixture();
  const refundNo = refundNoForOrder(ORDER_ID, IDEMPOTENCY_KEY);
  await forgedFixture.handler(command());
  const forged = createNotifyFixture(
    forgedFixture.store,
    notificationResource(refundNo),
    false
  );
  const before = clone({
    order: forgedFixture.store.state.orders.get(ORDER_ID),
    refund: forgedFixture.store.state.refunds.get(refundNo),
    events: [...forgedFixture.store.state.events.values()]
  });
  assert.deepStrictEqual(await forged.handler({}), { statusCode: 400, body: '' });
  assert.deepStrictEqual(clone({
    order: forgedFixture.store.state.orders.get(ORDER_ID),
    refund: forgedFixture.store.state.refunds.get(refundNo),
    events: [...forgedFixture.store.state.events.values()]
  }), before);

  const mismatchFixture = createRequestFixture();
  await mismatchFixture.handler(command());
  const mismatch = createNotifyFixture(
    mismatchFixture.store,
    notificationResource(refundNo, {
      amount: { total: 9999, refund: 5000, payer_total: 8000, payer_refund: 4000 }
    })
  );
  assert.deepStrictEqual(await mismatch.handler({}), { statusCode: 204, body: '' });
  assert.strictEqual(mismatchFixture.store.state.orders.get(ORDER_ID).orderStatus, 'manual_review');
  assert.strictEqual(mismatchFixture.store.state.orders.get(ORDER_ID).refundedTableFeeFen, 0);
  assert.strictEqual(mismatchFixture.store.state.events.size, 1);
  assert.strictEqual([...mismatchFixture.store.state.events.values()][0].eventType, 'refund_mismatch');
}

async function testNotificationContractRejectsMalformedWithoutWrites() {
  async function assertRejected(envelope, resource) {
    const fixture = createRequestFixture();
    const refundNo = refundNoForOrder(ORDER_ID, IDEMPOTENCY_KEY);
    await fixture.handler(command());
    const before = clone({
      order: fixture.store.state.orders.get(ORDER_ID),
      refund: fixture.store.state.refunds.get(refundNo),
      events: [...fixture.store.state.events.values()]
    });
    const notify = createNotifyFixture(fixture.store, resource, true, envelope);
    assert.deepStrictEqual(await notify.handler({}), { statusCode: 400, body: '' });
    assert.deepStrictEqual(clone({
      order: fixture.store.state.orders.get(ORDER_ID),
      refund: fixture.store.state.refunds.get(refundNo),
      events: [...fixture.store.state.events.values()]
    }), before);
  }

  const refundNo = refundNoForOrder(ORDER_ID, IDEMPOTENCY_KEY);
  const extraOuter = notificationEnvelope({ extra: true });
  const missingOuter = notificationEnvelope();
  delete missingOuter.summary;
  const invalidCreateTime = notificationEnvelope({
    create_time: '2026-02-31T12:00:00+08:00'
  });
  const statusMismatch = notificationEnvelope({ event_type: 'REFUND.CLOSED' });
  const extraPayload = notificationResource(refundNo, { extra: true });
  const extraAmount = notificationResource(refundNo, {
    amount: {
      total: 10000,
      refund: 5000,
      payer_total: 8000,
      payer_refund: 4000,
      currency: 'CNY'
    }
  });
  const missingAmount = notificationResource(refundNo);
  delete missingAmount.amount.payer_refund;
  const missingSuccessTime = notificationResource(refundNo);
  delete missingSuccessTime.success_time;
  const closedWithSuccessTime = notificationResource(refundNo, {
    refund_status: 'CLOSED',
    success_time: '2026-07-14T18:00:00+08:00'
  });

  for (const [envelope, resource] of [
    [extraOuter, notificationResource(refundNo)],
    [missingOuter, notificationResource(refundNo)],
    [invalidCreateTime, notificationResource(refundNo)],
    [statusMismatch, notificationResource(refundNo)],
    [notificationEnvelope(), extraPayload],
    [notificationEnvelope(), extraAmount],
    [notificationEnvelope(), missingAmount],
    [notificationEnvelope(), missingSuccessTime],
    [notificationEnvelope({ event_type: 'REFUND.CLOSED' }), closedWithSuccessTime]
  ]) {
    await assertRejected(envelope, resource);
  }
}

async function testClosedAndAbnormalNotificationsBecomeManualReview() {
  for (const status of ['CLOSED', 'ABNORMAL']) {
    const fixture = createRequestFixture();
    const refundNo = refundNoForOrder(ORDER_ID, IDEMPOTENCY_KEY);
    await fixture.handler(command());
    const notify = createNotifyFixture(
      fixture.store,
      notificationResource(refundNo, { refund_status: status }),
      true,
      notificationEnvelope({ event_type: `REFUND.${status}` })
    );
    assert.deepStrictEqual(await notify.handler({}), { statusCode: 204, body: '' });
    assert.strictEqual(fixture.store.state.refunds.get(refundNo).status, 'manual_review');
    assert.strictEqual(fixture.store.state.orders.get(ORDER_ID).orderStatus, 'manual_review');
    assert.strictEqual(fixture.store.state.orders.get(ORDER_ID).refundedTableFeeFen, 0);
    assert.strictEqual(fixture.store.state.events.size, 1);
    assert.strictEqual(
      [...fixture.store.state.events.values()][0].eventType,
      'refund_mismatch'
    );
  }
}

async function testNotificationQueryRaceCreatesOneEvent() {
  const fixture = createRequestFixture();
  const refundNo = refundNoForOrder(ORDER_ID, IDEMPOTENCY_KEY);
  await fixture.handler(command());
  const notify = createNotifyFixture(fixture.store, notificationResource(refundNo));

  const [notificationOutcome, queryOutcome] = await Promise.all([
    notify.handler({}),
    fixture.handler(command())
  ]);
  assert.deepStrictEqual(notificationOutcome, { statusCode: 204, body: '' });
  assert.deepStrictEqual(queryOutcome, { ok: true, refundNo, status: 'succeeded' });
  assert.strictEqual(fixture.store.state.events.size, 1);
  assert.strictEqual(fixture.store.state.orders.get(ORDER_ID).refundedTableFeeFen, 4000);
}

async function testNotificationBeforeAcceptedResponseKeepsOfficialCreateTime() {
  let startRefund;
  const started = new Promise((resolve) => { startRefund = resolve; });
  let releaseRefund;
  const client = {
    refund(body) {
      startRefund(body);
      return new Promise((resolve) => { releaseRefund = resolve; });
    },
    async queryRefund() {
      throw new Error('not expected');
    },
    async splitReturn() {
      throw new Error('not expected');
    },
    async querySplitReturn() {
      throw new Error('not expected');
    }
  };
  const fixture = createRequestFixture({ client });
  const refundNo = refundNoForOrder(ORDER_ID, IDEMPOTENCY_KEY);
  const pendingRequest = fixture.handler(command());
  const body = await started;
  const notify = createNotifyFixture(fixture.store, notificationResource(refundNo));
  assert.deepStrictEqual(await notify.handler({}), { statusCode: 204, body: '' });

  releaseRefund(refundResponse({
    refundFen: body.amount.refund,
    payerTotalFen: 8000,
    payerRefundFen: 4000,
    refundNo,
    status: 'PROCESSING'
  }));
  assert.deepStrictEqual(await pendingRequest, {
    ok: true,
    refundNo,
    status: 'succeeded'
  });
  const refund = fixture.store.state.refunds.get(refundNo);
  assert.strictEqual(refund.refundCreateTime, '2026-07-14T17:59:00+08:00');
  assert.strictEqual(
    refund.refundCreatedAt,
    Date.parse('2026-07-14T17:59:00+08:00')
  );
  assert.strictEqual(fixture.store.state.events.size, 1);
}

function createRecoveryHandler(store, client, now = NOW + REFUND_LEASE_MS + 1, context = {}) {
  return createHandler({
    store,
    getContext: () => context,
    loadConfig: config,
    createWechatPayClient: () => client,
    nowMs: () => now
  });
}

async function testRefundTimerGuardAndLostCallbackRecovery() {
  const deniedStore = createMemoryStore();
  let deniedNetwork = 0;
  const denied = createRecoveryHandler(
    deniedStore,
    new Proxy({}, {
      get() { return async () => { deniedNetwork += 1; }; }
    }),
    NOW + REFUND_LEASE_MS + 1,
    { OPENID: OWNER }
  );
  assert.deepStrictEqual(await denied(refundTimer), {
    ok: false,
    code: 'ACCESS_DENIED',
    retryable: false
  });
  assert.strictEqual(deniedStore.metrics.lists, 0);
  assert.strictEqual(deniedStore.metrics.transactions, 0);
  assert.strictEqual(deniedNetwork, 0);

  const invalidContextStore = createMemoryStore();
  const invalidContext = createRecoveryHandler(
    invalidContextStore,
    new Proxy({}, {
      get() { return async () => { deniedNetwork += 1; }; }
    }),
    NOW + REFUND_LEASE_MS + 1,
    { OPENID: 123 }
  );
  assert.deepStrictEqual(await invalidContext(refundTimer), {
    ok: false,
    code: 'ACCESS_DENIED',
    retryable: false
  });
  assert.strictEqual(invalidContextStore.metrics.lists, 0);
  assert.strictEqual(invalidContextStore.metrics.transactions, 0);
  assert.strictEqual(deniedNetwork, 0);

  const spoofStore = createMemoryStore();
  const spoof = createRecoveryHandler(spoofStore, new Proxy({}, {
    get() { return async () => { deniedNetwork += 1; }; }
  }));
  assert.deepStrictEqual(await spoof({ ...refundTimer, extra: true }), {
    ok: false,
    code: 'INVALID_ARGUMENT',
    retryable: false
  });
  assert.strictEqual(spoofStore.metrics.lists, 0);
  assert.strictEqual(spoofStore.metrics.transactions, 0);
  assert.strictEqual(deniedNetwork, 0);

  const fixture = createRequestFixture();
  const refundNo = refundNoForOrder(ORDER_ID, IDEMPOTENCY_KEY);
  assert.strictEqual((await fixture.handler(command())).status, 'processing');
  const timerHandler = createRecoveryHandler(fixture.store, fixture.client);
  assert.deepStrictEqual(await timerHandler(refundTimer), {
    ok: true,
    scanned: 1,
    claimed: 1,
    succeeded: 1,
    pending: 0,
    manualReview: 0,
    conflicts: 0
  });
  assert.strictEqual(fixture.store.state.refunds.get(refundNo).status, 'succeeded');
  assert.strictEqual(fixture.store.state.events.size, 1);
}

function seedDueRefund(store, index) {
  const suffix = String(index).padStart(2, '0');
  const orderId = `ord_refund_timer_${suffix}`;
  const idempotencyKey = `timer-case-${suffix}`;
  const refundNo = refundNoForOrder(orderId, idempotencyKey);
  const claim = {
    refundNo,
    attemptId: `refund_attempt_timer_${suffix}`,
    status: 'processing',
    claimedAt: NOW - 2 * REFUND_LEASE_MS,
    requestedAt: NOW - 2 * REFUND_LEASE_MS + index,
    leaseExpiresAt: NOW - REFUND_LEASE_MS,
    completedAt: null
  };
  const order = baseOrder({
    _id: orderId,
    orderId,
    outTradeNo: `pay_timer_${suffix}`,
    wechatTransactionId: `42${String(index).padStart(26, '0')}`,
    requestedRefundFen: 100,
    refundClaim: claim
  });
  const refund = {
    _id: refundNo,
    schemaVersion: 1,
    orderId,
    shopId: OWNER,
    subMchid: SUB_MCHID,
    refundNo,
    idempotencyKey,
    reason: REASON,
    refundFen: 100,
    status: 'processing',
    refundClaim: claim,
    splitReturnNo: null,
    splitReturnFen: 0,
    splitReturnStatus: 'not_required',
    splitReturnBasis: 'not_required',
    splitReturnAdjustmentStatus: 'not_required',
    wechatSplitReturnId: '',
    wechatRefundId: '',
    payerRefundFen: null,
    couponRefundFen: null,
    settlementRefundFen: null,
    settlementTotalFen: null,
    discountRefundFen: null,
    reportedRefundFeeFen: null,
    requestedAt: claim.requestedAt,
    refundCreateTime: null,
    refundCreatedAt: null,
    refundNextAttemptAt: NOW - 1,
    cumulativeRequestedBeforeFen: 0,
    cumulativeGrossBeforeFen: 0,
    cumulativePayerBeforeFen: 0,
    cumulativeCouponBeforeFen: 0,
    cumulativeSplitReturnedBeforeFen: 0,
    createdAt: { $date: 'server' },
    updatedAt: { $date: 'server' }
  };
  store.state.orders.set(orderId, order);
  store.state.refunds.set(refundNo, refund);
  return { order, refund };
}

async function testRefundTimerFairnessAndOwnerRace() {
  const store = createMemoryStore();
  store.state.orders.clear();
  const seeded = Array.from({ length: 25 }, (_unused, index) => (
    seedDueRefund(store, index)
  ));
  const successfulRefundNo = seeded[20].refund.refundNo;
  const client = {
    async queryRefund(outRefundNo) {
      const refund = store.state.refunds.get(outRefundNo);
      const order = store.state.orders.get(refund.orderId);
      return refundResponse({
        refundFen: refund.refundFen,
        payerTotalFen: order.wechatPayerTotalFen,
        payerRefundFen: 80,
        refundNo: outRefundNo,
        transactionId: order.wechatTransactionId,
        outTradeNo: order.outTradeNo,
        status: outRefundNo === successfulRefundNo ? 'SUCCESS' : 'PROCESSING'
      });
    },
    async refund() { throw new Error('not expected'); },
    async splitReturn() { throw new Error('not expected'); },
    async querySplitReturn() { throw new Error('not expected'); }
  };
  const timerHandler = createRecoveryHandler(store, client, NOW);
  const first = await timerHandler(refundTimer);
  assert.strictEqual(first.scanned, 20);
  assert.strictEqual(first.pending, 20);
  assert.strictEqual(first.succeeded, 0);
  const second = await timerHandler(refundTimer);
  assert.strictEqual(second.scanned, 5);
  assert.strictEqual(second.pending, 4);
  assert.strictEqual(second.succeeded, 1);
  assert.strictEqual(store.state.refunds.get(successfulRefundNo).status, 'succeeded');

  const raceFixture = createRequestFixture();
  const raceRefundNo = refundNoForOrder(ORDER_ID, IDEMPOTENCY_KEY);
  await raceFixture.handler(command());
  const raceTimer = createRecoveryHandler(raceFixture.store, raceFixture.client);
  const [timerOutcome, ownerOutcome] = await Promise.all([
    raceTimer(refundTimer),
    raceFixture.handler(command())
  ]);
  assert.strictEqual(timerOutcome.ok, true);
  assert.strictEqual(ownerOutcome.ok, true);
  assert.strictEqual(raceFixture.store.state.events.size, 1);
  assert.strictEqual(
    raceFixture.store.state.orders.get(ORDER_ID).grossRefundedFen,
    5000
  );
  assert.strictEqual(raceFixture.store.state.refunds.get(raceRefundNo).status, 'succeeded');
}

async function testProductionRefundStoreUsesBoundedDueQueries() {
  const queries = [];
  const commandApi = {
    in: (value) => ({ operator: 'in', value }),
    lte: (value) => ({ operator: 'lte', value }),
    exists: (value) => ({ operator: 'exists', value })
  };
  const db = {
    command: commandApi,
    collection(name) {
      assert.strictEqual(name, 'shop_refunds');
      return {
        where(filter) {
          const entry = { filter, orderBy: [], limit: null };
          queries.push(entry);
          const builder = {
            orderBy(field, direction) {
              entry.orderBy.push([field, direction]);
              return builder;
            },
            limit(value) { entry.limit = value; return builder; },
            async get() { return { data: [] }; }
          };
          return builder;
        }
      };
    },
    async runTransaction() { throw new Error('not used'); },
    serverDate() { return { $date: 'server' }; }
  };
  const productionStore = createCloudbaseRefundStore(db);
  assert.deepStrictEqual(await productionStore.listDueRefunds(NOW, 20), []);
  assert.strictEqual(queries.length, 4);
  assert.strictEqual(queries.filter(
    (query) => query.filter.refundNextAttemptAt.operator === 'lte'
  ).length, 2);
  assert.strictEqual(queries.filter(
    (query) => query.filter.refundNextAttemptAt.operator === 'exists'
  ).length, 2);
  assert(queries.every((query) => query.limit === 20));
}

function testDeployableCopiesAndPackageMetadata() {
  const root = path.join(__dirname, '..');
  const canonicalFiles = [
    'table-refund/table-refund.js',
    'table-refund/refund-transition.js',
    'table-refund/cloudbase-refund-store.js',
    'table-finance/money.js',
    'table-finance/state.js',
    'wechatpay-v3/client.js',
    'wechatpay-v3/config.js',
    'wechatpay-v3/http-event.js',
    'wechatpay-v3/bill-parser.js'
  ];
  for (const functionName of ['requestTableRefund', 'tableRefundNotifyV3']) {
    const indexSource = fs.readFileSync(
      path.join(root, 'cloudfunctions', functionName, 'index.js'),
      'utf8'
    );
    assert(!indexSource.includes("require('../_shared"));
    for (const relative of canonicalFiles) {
      const source = fs.readFileSync(
        path.join(root, 'cloudfunctions', '_shared', relative)
      );
      const deployed = fs.readFileSync(
        path.join(root, 'cloudfunctions', functionName, 'lib', relative)
      );
      assert(source.equals(deployed), `${functionName}/${relative} must be byte-identical`);
    }
    const manifest = JSON.parse(fs.readFileSync(
      path.join(root, 'cloudfunctions', functionName, 'package.json'),
      'utf8'
    ));
    assert.strictEqual(manifest.main, 'index.js');
    assert.strictEqual(manifest.dependencies['wx-server-sdk'], '~2.6.3');
  }
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(
    path.join(root, 'cloudfunctions/requestTableRefund/config.json'),
    'utf8'
  )), {
    triggers: [{
      name: 'reconcileTableRefundsTimer',
      type: 'timer',
      config: '0 */5 * * * * *'
    }]
  });
}

function testOfficialTimeRejectsImpossibleCalendarFacts() {
  assert.strictEqual(
    officialTime('2024-02-29T23:59:59.123+14:00'),
    Date.parse('2024-02-29T23:59:59.123+14:00')
  );
  for (const value of [
    '2026-02-31T12:00:00+08:00',
    '2025-02-29T12:00:00+08:00',
    '2026-04-31T12:00:00+08:00',
    '2026-07-14T24:00:00+08:00',
    '2026-07-14T23:60:00+08:00',
    '2026-07-14T23:59:60+08:00',
    '2026-07-14T23:59:59+14:01',
    '2026-07-14T23:59:59-14:01',
    '2026-07-14T23:59:59+24:00'
  ]) {
    assert.strictEqual(officialTime(value), null, value);
  }
}

async function testOwnerRefundServiceUsesExactCheckedCloudPayload() {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const originalWarn = console.warn;
  const calls = [];
  const app = { globalData: { cloudReady: false, role: 'shop' } };
  global.getApp = () => app;
  global.wx = {
    getStorageSync() { return ''; },
    setStorageSync() {},
    removeStorageSync() {},
    cloud: {
      callFunction(request) {
        calls.push(clone(request));
        return Promise.resolve({
          result: { ok: false, code: 'DENIED', msg: 'denied' }
        });
      }
    }
  };
  console.warn = () => {};
  const modulePath = path.join(__dirname, '..', 'miniprogram', 'services', 'data.js');
  delete require.cache[require.resolve(modulePath)];
  try {
    const data = require(modulePath);
    const input = {
      orderId: ORDER_ID,
      refundFen: 1234,
      reason: REASON,
      idempotencyKey: IDEMPOTENCY_KEY,
      ignored: 'must-not-cross-trust-boundary'
    };
    await assert.rejects(
      () => data.requestTableRefund(input),
      (error) => error && error.code === 'CLOUD_NOT_READY'
    );
    assert.strictEqual(calls.length, 0);

    app.globalData.cloudReady = true;
    await assert.rejects(
      () => data.requestTableRefund(input),
      (error) => error && error.code === 'DENIED'
    );
    assert.deepStrictEqual(calls, [{
      name: 'requestTableRefund',
      data: {
        orderId: ORDER_ID,
        refundFen: 1234,
        reason: REASON,
        idempotencyKey: IDEMPOTENCY_KEY
      }
    }]);
  } finally {
    delete require.cache[require.resolve(modulePath)];
    global.getApp = originalGetApp;
    global.wx = originalWx;
    console.warn = originalWarn;
  }
}

(async () => {
  const tests = [
    testExactOwnerCommandAndCumulativeGrossBound,
    testRefundRequiresActiveBoundShopOwnerBeforeSideEffects,
    testRefundCounterIdentityFailsBeforeSideEffects,
    testTerminalReplayValidatesRefundCounterIdentity,
    testPendingSplitSubmitsExactPartnerRefundAndOnlyProcesses,
    testRefundSubMchidIsImmutable,
    testCompletedSplitReturnsAndQueriesBeforeRefund,
    testCompletedSplitTracksZeroRoundedProvisionalAdjustment,
    testCompletedSplitRequiresCanonicalTask6ASnapshot,
    testPostSplitCouponRefundReturnsShareAndRecomputesRetainedCash,
    testReversedCouponSplitRefundSkipsDuplicateShareReturn,
    testCompletedSplitAcceptsPersistedTimeRepresentations,
    testNonterminalReturnBlocksRefundAndRecoversWithSameNumber,
    testMissingSplitReturnResubmitsExactRequestThenRequeries,
    testAcceptedRefundNeedsQueryForTerminalCouponAwareMath,
    testMultipleRefundsUseCumulativeFactsAndFullRefundZerosCost,
    testFullRefundReturnsAllRemainingPlatformSplit,
    testTerminalRefundIdMustMatchAcceptedIdentity,
    testAcceptedResponseRequiresOfficialCreateTime,
    testNoCouponRefundRequiresPayerAmountToMatchGross,
    testAmbiguousSubmissionQueriesSameRefundInsteadOfResubmitting,
    testVerifiedNotFoundRetriesSameDeterministicRefundNumber,
    testTerminalRefundQueriesBecomeManualReview,
    testVerifiedClientErrorsSeparateManualFromRetry,
    testRawVerifiedNotificationWithoutCurrencyFinalizesOnce,
    testForgedCallbackWritesNothingAndSignedMismatchReviews,
    testNotificationContractRejectsMalformedWithoutWrites,
    testClosedAndAbnormalNotificationsBecomeManualReview,
    testNotificationQueryRaceCreatesOneEvent,
    testNotificationBeforeAcceptedResponseKeepsOfficialCreateTime,
    testRefundTimerGuardAndLostCallbackRecovery,
    testRefundTimerFairnessAndOwnerRace,
    testProductionRefundStoreUsesBoundedDueQueries,
    testOfficialTimeRejectsImpossibleCalendarFacts,
    testOwnerRefundServiceUsesExactCheckedCloudPayload,
    testDeployableCopiesAndPackageMetadata
  ];
  for (const test of tests) await test();
  console.log(`table refunds ok (${tests.length} tests)`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
