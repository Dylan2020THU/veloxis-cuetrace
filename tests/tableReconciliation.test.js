'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  ARTIFACT_LEASE_MS,
  POLICY_VERSION,
  RUN_LEASE_MS,
  TRADE_BILL_HEADERS,
  artifactDescriptor,
  buildOrderConfirmation,
  chinaDateBounds,
  matchPaymentEvidence,
  matchRefundEvidence,
  normalizeBillTimeToChinaSecond,
  normalizeRfc3339ToChinaSecond,
  orderSnapshotToken,
  parseTradeBill,
  previousChinaBillDate,
  runIdForBillDate
} = require('../cloudfunctions/_shared/table-reconciliation/table-reconciliation');
const {
  createReconcileFinanceHandler
} = require('../cloudfunctions/reconcileTableFinance/index');
const {
  createCloudbaseReconciliationStore
} = require('../cloudfunctions/_shared/table-reconciliation/cloudbase-reconciliation-store');
const {
  verifyBillHash
} = require('../cloudfunctions/_shared/wechatpay-v3/bill-parser');
const {
  financialEventId,
  splitNoForOrder
} = require('../cloudfunctions/_shared/table-finance/state');
const {
  assessSettlement
} = require('../cloudfunctions/_shared/table-profit-sharing/table-profit-sharing');

const OWNER = 'owner_reconciliation_001';
const OTHER_OWNER = 'owner_reconciliation_002';
const SP_MCHID = '1900000100';
const SUB_MCHID = '1900000109';
const OTHER_SUB_MCHID = '1900000110';
const ORDER_ID = 'ord_reconciliation_001';
const OUT_TRADE_NO = 'pay_reconciliation_001';
const TRANSACTION_ID = '4200000000000000000000000001';
const REFUND_NO = 'refund_reconciliation_001';
const WECHAT_REFUND_ID = '50000000382019052709732678859';
const PAYMENT_SUCCESS_TIME = '2026-07-13T23:59:59.456+08:00';
const REFUND_CREATE_TIME = '2026-07-14T08:01:02+08:00';
const BILL_DATE = '2026-07-13';
const REFUND_BILL_DATE = '2026-07-14';
const NOW = Date.parse('2026-07-14T10:15:00+08:00');
const REFUND_NOW = Date.parse('2026-07-15T10:15:00+08:00');

const EXPECTED_HEADERS = Object.freeze([
  '交易时间', '公众账号ID', '商户号', '特约商户号', '设备号', '微信订单号', '商户订单号',
  '用户标识', '交易类型', '交易状态', '付款银行', '货币种类', '应结订单金额', '代金券金额',
  '微信退款单号', '商户退款单号', '退款金额', '充值券退款金额', '退款类型', '退款状态',
  '商品名称', '商户数据包', '手续费', '费率', '订单金额', '申请退款金额', '费率备注'
]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function paymentProfile(overrides = {}) {
  return {
    _id: OWNER,
    shopId: OWNER,
    schemaVersion: 1,
    status: 'ready',
    onboardingStatus: 'approved',
    contractStatus: 'signed',
    profitSharingAuthorizationStatus: 'authorized',
    paymentEnabled: true,
    profitSharingEnabled: true,
    policyVersion: POLICY_VERSION,
    subMchid: SUB_MCHID,
    tradeBillModeVerified: true,
    ...clone(overrides)
  };
}

function paymentSnapshot(overrides = {}) {
  return {
    spAppid: 'wx1234567890abcdef',
    spMchid: SP_MCHID,
    subAppid: null,
    subMchid: SUB_MCHID,
    openidMode: 'sp_openid',
    profileSchemaVersion: 1,
    policyVersion: POLICY_VERSION,
    ...clone(overrides)
  };
}

function order(overrides = {}) {
  return {
    _id: ORDER_ID,
    orderId: ORDER_ID,
    schemaVersion: 2,
    _openid: OWNER,
    shopId: OWNER,
    orderStatus: 'complete',
    paymentStatus: 'paid',
    splitStatus: 'pending',
    policyVersion: POLICY_VERSION,
    billingMode: 'table_commission',
    commissionRateBps: 500,
    includesChannelFee: true,
    outTradeNo: OUT_TRADE_NO,
    wechatTransactionId: TRANSACTION_ID,
    wechatSuccessTime: PAYMENT_SUCCESS_TIME,
    paidAt: Date.parse(PAYMENT_SUCCESS_TIME),
    paymentProfileSnapshot: paymentSnapshot(),
    wechatOrderTotalFen: 10000,
    wechatPayerTotalFen: 10000,
    couponSubsidyFen: 0,
    grossRefundedFen: 0,
    refundedTableFeeFen: 0,
    couponRefundedFen: 0,
    retainedCouponSubsidyFen: 0,
    paidTableFeeFen: 10000,
    totalCostFen: 500,
    shopNetFen: 9500,
    shopSettlementFen: 9500,
    channelFeeFen: null,
    platformNetFen: null,
    channelFeeEvidenceHash: null,
    paymentBillFeeEvidence: null,
    paymentBillDiscoveryCompletedAt: null,
    refundFeeReconciliationStatus: null,
    financeAutomationBlocked: false,
    ...clone(overrides)
  };
}

function refund(overrides = {}) {
  return {
    _id: REFUND_NO,
    orderId: ORDER_ID,
    shopId: OWNER,
    subMchid: SUB_MCHID,
    refundNo: REFUND_NO,
    status: 'succeeded',
    verifiedSource: 'query',
    refundFen: 2000,
    payerRefundFen: 2000,
    couponRefundFen: 0,
    settlementRefundFen: 2000,
    refundCreateTime: REFUND_CREATE_TIME,
    refundCreatedAt: Date.parse(REFUND_CREATE_TIME),
    wechatRefundId: WECHAT_REFUND_ID,
    reportedRefundFeeFen: 999,
    ...clone(overrides)
  };
}

function paymentBillRow(overrides = {}) {
  return {
    '交易时间': '2026-07-13 23:59:59',
    '公众账号ID': 'wx1234567890abcdef',
    '商户号': SP_MCHID,
    '特约商户号': SUB_MCHID,
    '设备号': '',
    '微信订单号': TRANSACTION_ID,
    '商户订单号': OUT_TRADE_NO,
    '用户标识': 'openid_bill_001',
    '交易类型': 'JSAPI',
    '交易状态': 'SUCCESS',
    '付款银行': 'OTHERS',
    '货币种类': 'CNY',
    '应结订单金额': '100.00',
    '代金券金额': '0.00',
    '微信退款单号': '0',
    '商户退款单号': '0',
    '退款金额': '0.00',
    '充值券退款金额': '0.00',
    '退款类型': '',
    '退款状态': '',
    '商品名称': 'table fee',
    '商户数据包': '',
    '手续费': '0.60',
    '费率': '0.60%',
    '订单金额': '100.00',
    '申请退款金额': '0.00',
    '费率备注': '',
    ...clone(overrides)
  };
}

function refundBillRow(overrides = {}) {
  return paymentBillRow({
    '交易时间': '2026-07-14 08:01:02',
    '交易状态': 'REFUND',
    '应结订单金额': '0.00',
    '代金券金额': '0.00',
    '微信退款单号': WECHAT_REFUND_ID,
    '商户退款单号': REFUND_NO,
    '退款金额': '20.00',
    '充值券退款金额': '0.00',
    '退款类型': 'ORIGINAL',
    '退款状态': 'SUCCESS',
    '手续费': '-0.12',
    '订单金额': '0.00',
    '申请退款金额': '20.00',
    ...clone(overrides)
  });
}

function csvCell(value) {
  const text = `\`${value}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function tradeBillBytes(rows, headers = EXPECTED_HEADERS) {
  const main = [
    headers.join(','),
    ...rows.map((entry) => headers.map((header) => csvCell(entry[header] ?? '')).join(','))
  ];
  const summaryHeaders = [
    '总交易单数', '应结订单总金额', '退款总金额', '充值券退款总金额', '手续费总金额',
    '订单总金额', '申请退款总金额'
  ];
  const summary = ['1', '100.00', '0.00', '0.00', '0.60', '100.00', '0.00'];
  return Buffer.from([
    ...main,
    '',
    summaryHeaders.join(','),
    summary.map(csvCell).join(','),
    ''
  ].join('\r\n'), 'utf8');
}

function artifactFor(date, bytes, overrides = {}) {
  const base = artifactDescriptor(POLICY_VERSION, date, SUB_MCHID);
  return {
    ...base,
    sha1: crypto.createHash('sha1').update(bytes).digest('hex'),
    ...clone(overrides)
  };
}

function matchedPayment(orderValue = order(), date = BILL_DATE, rowOverrides = {}) {
  const bytes = tradeBillBytes([paymentBillRow(rowOverrides)]);
  const parsed = parseTradeBill(bytes);
  const outcome = matchPaymentEvidence(
    orderValue,
    parsed.rows,
    artifactFor(date, bytes)
  );
  assert.strictEqual(outcome.status, 'matched', JSON.stringify(outcome));
  return outcome.evidence;
}

function matchedRefund(
  orderValue = order({
    paymentStatus: 'partially_refunded',
    paidTableFeeFen: 8000,
    totalCostFen: 400,
    shopNetFen: 7600,
    shopSettlementFen: 7600,
    grossRefundedFen: 2000,
    refundedTableFeeFen: 2000,
    refundFeeReconciliationStatus: 'pending',
    financeAutomationBlocked: true
  }),
  refundValue = refund(),
  rowOverrides = {}
) {
  const bytes = tradeBillBytes([refundBillRow(rowOverrides)]);
  const parsed = parseTradeBill(bytes);
  const outcome = matchRefundEvidence(
    orderValue,
    refundValue,
    parsed.rows,
    artifactFor(REFUND_BILL_DATE, bytes)
  );
  assert.strictEqual(outcome.status, 'matched', JSON.stringify(outcome));
  return outcome.evidence;
}

function assertManual(outcome, code) {
  assert.strictEqual(outcome.status, 'manual_review', JSON.stringify(outcome));
  assert(outcome.reasonCodes.includes(code), JSON.stringify(outcome.reasonCodes));
}

function testExactHeadersParserAndChinaDates() {
  assert.deepStrictEqual(TRADE_BILL_HEADERS, EXPECTED_HEADERS);
  assert.strictEqual(TRADE_BILL_HEADERS.length, 27);
  assert.strictEqual(previousChinaBillDate(NOW), BILL_DATE);
  assert.strictEqual(
    previousChinaBillDate(Date.parse('2026-07-14T00:05:00+08:00')),
    BILL_DATE
  );
  assert.deepStrictEqual(chinaDateBounds(BILL_DATE), {
    startMs: Date.parse('2026-07-13T00:00:00+08:00'),
    endMs: Date.parse('2026-07-14T00:00:00+08:00')
  });
  assert.strictEqual(
    runIdForBillDate(POLICY_VERSION, BILL_DATE),
    `${POLICY_VERSION}__${BILL_DATE}`
  );

  const parsed = parseTradeBill(tradeBillBytes([paymentBillRow()]));
  assert.deepStrictEqual(parsed.headers, EXPECTED_HEADERS);
  assert.strictEqual(parsed.rows[0]['订单金额'], 10000);
  assert.strictEqual(parsed.rows[0]['手续费'], 60);

  const missing = EXPECTED_HEADERS.slice(0, -1);
  assert.throws(
    () => parseTradeBill(tradeBillBytes([paymentBillRow()], missing)),
    /header/i
  );
  const reordered = [...EXPECTED_HEADERS];
  [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  assert.throws(
    () => parseTradeBill(tradeBillBytes([paymentBillRow()], reordered)),
    /header/i
  );
}

function testArtifactContract() {
  const artifact = artifactDescriptor(POLICY_VERSION, BILL_DATE, SUB_MCHID);
  assert.deepStrictEqual(artifact, {
    artifactId: `${POLICY_VERSION}__${BILL_DATE}__trade__sub_mchid__${SUB_MCHID}`,
    policyVersion: POLICY_VERSION,
    billDate: BILL_DATE,
    billType: 'trade',
    scopeType: 'sub_mchid',
    scopeAccount: SUB_MCHID,
    cloudPath: `finance/bills/${BILL_DATE}/${SUB_MCHID}/trade.csv`
  });
}

function testExactPaymentMatchingAndMismatchReasons() {
  const value = order();
  const bytes = tradeBillBytes([paymentBillRow()]);
  const parsed = parseTradeBill(bytes);
  const artifact = artifactFor(BILL_DATE, bytes);
  const matched = matchPaymentEvidence(value, parsed.rows, artifact);
  assert.strictEqual(matched.status, 'matched');
  assert.strictEqual(matched.evidence.row.kind, 'payment');
  assert.strictEqual(matched.evidence.row.feeFen, 60);
  assert.match(matched.evidence.row.rowIdentityHash, /^[0-9a-f]{64}$/);

  const sameDayBytes = tradeBillBytes([
    paymentBillRow(),
    refundBillRow({ '交易时间': '2026-07-13 23:59:59' })
  ]);
  assert.strictEqual(
    matchPaymentEvidence(
      value,
      parseTradeBill(sameDayBytes).rows,
      artifactFor(BILL_DATE, sameDayBytes)
    ).status,
    'matched',
    'a refund row for the same transaction must not look like a duplicate payment row'
  );

  assertManual(
    matchPaymentEvidence(value, [], artifact),
    'PAYMENT_ROW_MISSING'
  );
  assertManual(
    matchPaymentEvidence(value, [parsed.rows[0], clone(parsed.rows[0])], artifact),
    'PAYMENT_ROW_DUPLICATE'
  );
  const conflictingPaymentBytes = tradeBillBytes([
    paymentBillRow(),
    paymentBillRow({ '微信订单号': '4200000000000000000000000999' })
  ]);
  assertManual(
    matchPaymentEvidence(
      value,
      parseTradeBill(conflictingPaymentBytes).rows,
      artifactFor(BILL_DATE, conflictingPaymentBytes)
    ),
    'PAYMENT_ROW_CONFLICT'
  );

  const cases = [
    [{ '微信订单号': '4200000000000000000000000999' }, 'PAYMENT_IDENTITY_MISMATCH'],
    [{ '货币种类': 'USD' }, 'PAYMENT_CURRENCY_MISMATCH'],
    [{ '交易状态': 'REFUND' }, 'PAYMENT_STATUS_MISMATCH'],
    [{ '订单金额': '99.99' }, 'PAYMENT_TOTAL_MISMATCH'],
    [{ '手续费': '-0.60' }, 'PAYMENT_FEE_SIGN'],
    [{ '交易时间': '2026-07-13 23:59:58' }, 'PAYMENT_TIME_MISMATCH']
  ];
  for (const [overrides, code] of cases) {
    const candidateBytes = tradeBillBytes([paymentBillRow(overrides)]);
    assertManual(
      matchPaymentEvidence(
        value,
        parseTradeBill(candidateBytes).rows,
        artifactFor(BILL_DATE, candidateBytes)
      ),
      code
    );
  }

  const wrongLocalDate = order({
    wechatSuccessTime: '2026-07-14T00:00:00+08:00'
  });
  assertManual(
    matchPaymentEvidence(wrongLocalDate, parsed.rows, artifact),
    'PAYMENT_BILL_DATE_MISMATCH'
  );
}

function testCouponIsPaymentValidAndAutomationProceeds() {
  const couponOrder = order({
    wechatPayerTotalFen: 9000,
    couponSubsidyFen: 1000,
    paidTableFeeFen: 9000,
    totalCostFen: 450,
    shopNetFen: 8550,
    shopSettlementFen: 9550,
    retainedCouponSubsidyFen: 1000
  });
  const evidence = matchedPayment(couponOrder, BILL_DATE, {
    '应结订单金额': '90.00',
    '代金券金额': '10.00'
  });
  const confirmation = buildOrderConfirmation({
    order: couponOrder,
    refunds: [],
    paymentEvidence: evidence,
    refundEvidences: [],
    confirmedAtMs: NOW,
    nowMs: NOW
  });
  assert.strictEqual(confirmation.status, 'confirmed');
  assert.deepStrictEqual(confirmation.reasonCodes, []);
  assert.strictEqual(confirmation.orderPatch.totalCostFen, 450);
  assert.strictEqual(confirmation.orderPatch.channelFeeFen, 60);
  assert.strictEqual(confirmation.orderPatch.platformNetFen, 390);
  assert.strictEqual(confirmation.orderPatch.financeAutomationBlocked, false);
  assert.strictEqual(confirmation.orderPatch.orderStatus, 'complete');
}

function testRefundTerminalIdentitySignsAndReportedFeeIgnored() {
  const value = order({
    paymentStatus: 'partially_refunded',
    paidTableFeeFen: 8000,
    totalCostFen: 400,
    shopNetFen: 7600,
    shopSettlementFen: 7600,
    grossRefundedFen: 2000,
    refundedTableFeeFen: 2000,
    refundFeeReconciliationStatus: 'pending',
    financeAutomationBlocked: true
  });
  const localRefund = refund({ reportedRefundFeeFen: 8888 });
  const bytes = tradeBillBytes([refundBillRow()]);
  const parsed = parseTradeBill(bytes);
  const artifact = artifactFor(REFUND_BILL_DATE, bytes);
  const matched = matchRefundEvidence(value, localRefund, parsed.rows, artifact);
  assert.strictEqual(matched.status, 'matched');
  assert.strictEqual(matched.evidence.row.feeFen, -12);
  assert.notStrictEqual(matched.evidence.row.feeFen, localRefund.reportedRefundFeeFen);
  assert.strictEqual(
    matchRefundEvidence(
      value,
      refund({
        verifiedSource: 'notification',
        settlementRefundFen: null,
        refundCreateTime: null,
        refundCreatedAt: null
      }),
      parsed.rows,
      artifact
    ).status,
    'matched',
    'notification-only success may rely on the signed bill settlement amount'
  );

  const cases = [
    [refund({ status: 'processing' }), refundBillRow(), 'REFUND_LOCAL_NOT_TERMINAL'],
    [localRefund, refundBillRow({ '退款状态': 'PROCESSING' }), 'REFUND_BILL_NOT_TERMINAL'],
    [localRefund, refundBillRow({ '微信退款单号': '50000000382019052709732670000' }), 'REFUND_IDENTITY_MISMATCH'],
    [localRefund, refundBillRow({ '手续费': '0.12' }), 'REFUND_FEE_SIGN'],
    [localRefund, refundBillRow({ '申请退款金额': '19.99' }), 'REFUND_TOTAL_MISMATCH'],
    [localRefund, refundBillRow({ '交易时间': '2026-07-14 08:01:03' }), 'REFUND_TIME_MISMATCH']
  ];
  for (const [refundValue, rowValue, code] of cases) {
    const candidateBytes = tradeBillBytes([rowValue]);
    assertManual(
      matchRefundEvidence(
        value,
        refundValue,
        parseTradeBill(candidateBytes).rows,
        artifactFor(REFUND_BILL_DATE, candidateBytes)
      ),
      code
    );
  }

  assertManual(
    matchRefundEvidence(value, localRefund, [], artifact),
    'REFUND_ROW_MISSING'
  );
  assertManual(
    matchRefundEvidence(
      value,
      localRefund,
      [parsed.rows[0], clone(parsed.rows[0])],
      artifact
    ),
    'REFUND_ROW_DUPLICATE'
  );
  const conflictingRefundBytes = tradeBillBytes([
    refundBillRow(),
    refundBillRow({ '微信退款单号': '50000000382019052709732670000' })
  ]);
  assertManual(
    matchRefundEvidence(
      value,
      localRefund,
      parseTradeBill(conflictingRefundBytes).rows,
      artifactFor(REFUND_BILL_DATE, conflictingRefundBytes)
    ),
    'REFUND_ROW_CONFLICT'
  );
}

function testConfirmationEventShapeAndRefundAggregation() {
  const initialOrder = order();
  const paymentEvidence = matchedPayment(initialOrder);
  const initial = buildOrderConfirmation({
    order: initialOrder,
    refunds: [],
    paymentEvidence,
    refundEvidences: [],
    confirmedAtMs: NOW,
    nowMs: NOW
  });
  assert.strictEqual(initial.status, 'confirmed');
  assert.strictEqual(initial.orderPatch.totalCostFen, 500);
  assert.strictEqual(initial.orderPatch.channelFeeFen, 60);
  assert.strictEqual(initial.orderPatch.platformNetFen, 440);
  assert.strictEqual(initial.orderPatch.financeAutomationBlocked, false);
  assert.strictEqual(initial.orderPatch.refundFeeReconciliationStatus, 'confirmed');
  assert.match(initial.eventDocument.evidenceHash, /^[0-9a-f]{64}$/);
  assert.strictEqual(
    initial.eventId,
    financialEventId(
      'channel_fee_confirmed',
      `${ORDER_ID}:${initial.eventDocument.evidenceHash}`
    )
  );
  assert.deepStrictEqual(initial.eventDocument, {
    eventType: 'channel_fee_confirmed',
    businessType: 'table_order',
    businessId: ORDER_ID,
    orderId: ORDER_ID,
    transactionId: TRANSACTION_ID,
    source: 'wechat_trade_bill',
    paymentBillDate: BILL_DATE,
    artifacts: [{
      billDate: BILL_DATE,
      artifactId: paymentEvidence.artifact.artifactId,
      sha1: paymentEvidence.artifact.sha1
    }],
    rows: [paymentEvidence.row],
    retainedPaidTableFeeFen: 10000,
    retainedCouponSubsidyFen: 0,
    totalCostFen: 500,
    channelFeeFen: 60,
    platformNetFen: 440,
    actualPlatformNetFen: 440,
    evidenceHash: initial.eventDocument.evidenceHash,
    confirmedAtMs: NOW,
    createdAt: null
  });

  const refundedOrder = order({
    paymentStatus: 'partially_refunded',
    grossRefundedFen: 2000,
    refundedTableFeeFen: 2000,
    paidTableFeeFen: 8000,
    totalCostFen: 400,
    shopNetFen: 7600,
    shopSettlementFen: 7600,
    channelFeeFen: null,
    platformNetFen: null,
    channelFeeEvidenceHash: null,
    preRefundChannelFeeFen: 60,
    preRefundPlatformNetFen: 440,
    preRefundChannelFeeEvidenceHash: initial.eventDocument.evidenceHash,
    paymentBillFeeEvidence: paymentEvidence,
    refundFeeReconciliationStatus: 'pending',
    financeAutomationBlocked: true
  });
  const localRefund = refund();
  const refundEvidence = matchedRefund(refundedOrder, localRefund);
  const reconciled = buildOrderConfirmation({
    order: refundedOrder,
    refunds: [localRefund],
    paymentEvidence: null,
    refundEvidences: [refundEvidence],
    confirmedAtMs: REFUND_NOW,
    nowMs: REFUND_NOW
  });
  assert.strictEqual(reconciled.status, 'confirmed');
  assert.strictEqual(reconciled.orderPatch.channelFeeFen, 48);
  assert.strictEqual(reconciled.orderPatch.totalCostFen, 400);
  assert.strictEqual(reconciled.orderPatch.platformNetFen, 352);
  assert.strictEqual(reconciled.refundPatches[REFUND_NO].billFeeEvidence.row.feeFen, -12);
  assert.deepStrictEqual(
    reconciled.eventDocument.artifacts.map((entry) => entry.billDate),
    [BILL_DATE, REFUND_BILL_DATE]
  );
  assert.deepStrictEqual(
    reconciled.eventDocument.rows.map((entry) => entry.kind),
    ['payment', 'refund']
  );
  assert.strictEqual(reconciled.eventDocument.channelFeeFen, 48);
}

function testPostSplitRefundAdjustmentUsesOfficialFeeEvidence() {
  const paymentEvidence = matchedPayment(order());
  const refundedOrder = order({
    paymentStatus: 'partially_refunded',
    splitStatus: 'succeeded',
    grossRefundedFen: 2000,
    refundedTableFeeFen: 2000,
    paidTableFeeFen: 8000,
    totalCostFen: 400,
    shopNetFen: 7600,
    shopSettlementFen: 7600,
    channelFeeFen: null,
    platformNetFen: null,
    channelFeeEvidenceHash: null,
    preRefundChannelFeeFen: 60,
    preRefundPlatformNetFen: 440,
    preRefundChannelFeeEvidenceHash: 'b'.repeat(64),
    paymentBillFeeEvidence: paymentEvidence,
    splitPlatformNetFen: 440,
    splitReturnedFen: 100,
    refundFeeReconciliationStatus: 'pending',
    financeAutomationBlocked: true
  });
  const localRefund = refund({
    splitReturnFen: 100,
    splitReturnBasis: 'provisional_cumulative_requested_gross',
    splitReturnAdjustmentStatus: 'pending'
  });
  const refundEvidence = matchedRefund(refundedOrder, localRefund);
  const mismatch = buildOrderConfirmation({
    order: refundedOrder,
    refunds: [localRefund],
    paymentEvidence: null,
    refundEvidences: [refundEvidence],
    confirmedAtMs: REFUND_NOW,
    nowMs: REFUND_NOW
  });
  assert.strictEqual(mismatch.status, 'blocked');
  assert(mismatch.reasonCodes.includes('SPLIT_RETURN_ADJUSTMENT_MISMATCH'));
  assert.strictEqual(mismatch.orderPatch.expectedCumulativeSplitReturnedFen, 88);
  assert.strictEqual(mismatch.orderPatch.splitReturnAdjustmentDeltaFen, 12);
  assert.strictEqual(mismatch.orderPatch.splitReturnAdjustmentStatus, 'manual_review');
  assert.strictEqual(mismatch.orderPatch.financeAutomationBlocked, true);
  assert.strictEqual(
    mismatch.refundPatches[REFUND_NO].splitReturnAdjustmentStatus,
    'manual_review'
  );

  const exactOrder = {
    ...refundedOrder,
    splitReturnedFen: 88
  };
  const exactRefund = {
    ...localRefund,
    splitReturnFen: 88
  };
  const exact = buildOrderConfirmation({
    order: exactOrder,
    refunds: [exactRefund],
    paymentEvidence: null,
    refundEvidences: [matchedRefund(exactOrder, exactRefund)],
    confirmedAtMs: REFUND_NOW,
    nowMs: REFUND_NOW
  });
  assert.strictEqual(exact.status, 'confirmed');
  assert.strictEqual(exact.orderPatch.expectedCumulativeSplitReturnedFen, 88);
  assert.strictEqual(exact.orderPatch.splitReturnAdjustmentDeltaFen, 0);
  assert.strictEqual(exact.orderPatch.splitReturnAdjustmentStatus, 'confirmed');
  assert.strictEqual(
    exact.refundPatches[REFUND_NO].splitReturnAdjustmentStatus,
    'confirmed'
  );
  assert.notStrictEqual(
    orderSnapshotToken(refundedOrder),
    orderSnapshotToken(exactOrder)
  );
}

function testZeroPlatformSplitRefundNeedsNoAdjustment() {
  const initial = order();
  const paymentEvidence = matchedPayment(initial, BILL_DATE, {
    '手续费': '5.00',
    '费率': '5.00%'
  });
  const refundedOrder = order({
    paymentStatus: 'partially_refunded',
    splitStatus: 'succeeded',
    grossRefundedFen: 2000,
    refundedTableFeeFen: 2000,
    paidTableFeeFen: 8000,
    totalCostFen: 400,
    shopNetFen: 7600,
    shopSettlementFen: 7600,
    channelFeeFen: null,
    platformNetFen: null,
    channelFeeEvidenceHash: null,
    preRefundChannelFeeFen: 500,
    preRefundPlatformNetFen: 0,
    preRefundChannelFeeEvidenceHash: 'c'.repeat(64),
    paymentBillFeeEvidence: paymentEvidence,
    splitPlatformNetFen: 0,
    splitReturnedFen: 0,
    refundFeeReconciliationStatus: 'pending',
    financeAutomationBlocked: true
  });
  const localRefund = refund({
    splitReturnFen: 0,
    splitReturnBasis: 'not_required',
    splitReturnAdjustmentStatus: 'not_required',
    reportedRefundFeeFen: 100
  });
  const refundEvidence = matchedRefund(refundedOrder, localRefund, {
    '手续费': '-1.00'
  });
  const result = buildOrderConfirmation({
    order: refundedOrder,
    refunds: [localRefund],
    paymentEvidence: null,
    refundEvidences: [refundEvidence],
    confirmedAtMs: REFUND_NOW,
    nowMs: REFUND_NOW
  });
  assert.strictEqual(result.status, 'confirmed');
  assert.strictEqual(result.orderPatch.platformNetFen, 0);
  assert.strictEqual(result.orderPatch.expectedCumulativeSplitReturnedFen, 0);
  assert.strictEqual(result.orderPatch.splitReturnAdjustmentDeltaFen, 0);
  assert.strictEqual(result.orderPatch.splitReturnAdjustmentStatus, 'not_required');
}

function testGeneratedFeeEventAuthorizesProfitSharing() {
  const base = order({
    splitCycle: 'T_PLUS_1',
    splitNo: splitNoForOrder(ORDER_ID)
  });
  const confirmation = buildOrderConfirmation({
    order: base,
    refunds: [],
    paymentEvidence: matchedPayment(base),
    refundEvidences: [],
    confirmedAtMs: NOW,
    nowMs: NOW
  });
  const reconciledOrder = { ...base, ...confirmation.orderPatch };
  const paymentEvent = {
    _id: financialEventId('payment_succeeded', ORDER_ID),
    eventType: 'payment_succeeded',
    businessType: 'table_order',
    businessId: ORDER_ID,
    orderId: ORDER_ID,
    transactionId: TRANSACTION_ID,
    successTime: PAYMENT_SUCCESS_TIME,
    totalFen: 10000,
    payerTotalFen: 10000,
    couponSubsidyFen: 0
  };
  const feeEvent = {
    _id: confirmation.eventId,
    ...confirmation.eventDocument,
    createdAt: { $date: 'server' }
  };
  const assessment = assessSettlement(
    reconciledOrder,
    paymentEvent,
    feeEvent,
    { spAppId: 'wx1234567890abcdef', spMchid: SP_MCHID },
    NOW
  );
  assert.strictEqual(assessment.status, 'eligible');
}

function testAllSucceededRefundEvidenceRequiredAndDedupe() {
  const value = order({
    paymentStatus: 'partially_refunded',
    grossRefundedFen: 2000,
    refundedTableFeeFen: 2000,
    paidTableFeeFen: 8000,
    totalCostFen: 400,
    shopNetFen: 7600,
    shopSettlementFen: 7600,
    paymentBillFeeEvidence: matchedPayment(order()),
    financeAutomationBlocked: true,
    refundFeeReconciliationStatus: 'pending'
  });
  const localRefund = refund();
  const missing = buildOrderConfirmation({
    order: value,
    refunds: [localRefund],
    paymentEvidence: null,
    refundEvidences: [],
    confirmedAtMs: REFUND_NOW,
    nowMs: REFUND_NOW
  });
  assert.strictEqual(missing.status, 'pending');
  assert(missing.reasonCodes.includes('REFUND_FEE_EVIDENCE_MISSING'));
  assert.strictEqual(missing.orderPatch.channelFeeFen, undefined);
  assert.deepStrictEqual(
    missing.orderPatch.paymentBillFeeEvidence,
    value.paymentBillFeeEvidence
  );

  const unresolved = buildOrderConfirmation({
    order: value,
    refunds: [refund({ status: 'processing', billFeeEvidence: null })],
    paymentEvidence: null,
    refundEvidences: [],
    confirmedAtMs: REFUND_NOW,
    nowMs: REFUND_NOW
  });
  assert.strictEqual(unresolved.status, 'pending');
  assert(unresolved.reasonCodes.includes('REFUND_LOCAL_NOT_TERMINAL'));
  assert.deepStrictEqual(
    unresolved.orderPatch.paymentBillFeeEvidence,
    value.paymentBillFeeEvidence
  );

  const evidence = matchedRefund(value, localRefund);
  const duplicate = buildOrderConfirmation({
    order: value,
    refunds: [localRefund],
    paymentEvidence: null,
    refundEvidences: [evidence, clone(evidence)],
    confirmedAtMs: REFUND_NOW,
    nowMs: REFUND_NOW
  });
  assert.strictEqual(duplicate.status, 'manual_review');
  assert(duplicate.reasonCodes.includes('REFUND_EVIDENCE_DUPLICATE'));
}

function testFeeAboveCostPreservesActualFeeAndDisplaysZero() {
  const smallOrder = order({
    wechatOrderTotalFen: 1000,
    wechatPayerTotalFen: 1000,
    paidTableFeeFen: 1000,
    totalCostFen: 50,
    shopNetFen: 950,
    shopSettlementFen: 950
  });
  const evidence = matchedPayment(smallOrder, BILL_DATE, {
    '应结订单金额': '10.00',
    '订单金额': '10.00',
    '手续费': '0.60'
  });
  const result = buildOrderConfirmation({
    order: smallOrder,
    refunds: [],
    paymentEvidence: evidence,
    refundEvidences: [],
    confirmedAtMs: NOW,
    nowMs: NOW
  });
  assert.strictEqual(result.status, 'blocked');
  assert(result.reasonCodes.includes('CHANNEL_FEE_EXCEEDS_TOTAL_COST'));
  assert.strictEqual(result.orderPatch.channelFeeFen, 60);
  assert.strictEqual(result.orderPatch.platformNetFen, 0);
  assert.strictEqual(result.eventDocument.actualPlatformNetFen, -10);
  assert.strictEqual(result.orderPatch.financeAutomationBlocked, true);
  assert.strictEqual(result.orderPatch.orderStatus, 'manual_review');
}

function testFeeRateAboveFivePercentBlocksEvenWhenRoundedCostCoversIt() {
  const value = order({
    wechatOrderTotalFen: 11,
    wechatPayerTotalFen: 11,
    paidTableFeeFen: 11,
    totalCostFen: 1,
    shopNetFen: 10,
    shopSettlementFen: 10
  });
  const evidence = matchedPayment(value, BILL_DATE, {
    '应结订单金额': '0.11',
    '订单金额': '0.11',
    '手续费': '0.01'
  });
  const result = buildOrderConfirmation({
    order: value,
    refunds: [],
    paymentEvidence: evidence,
    refundEvidences: [],
    confirmedAtMs: NOW,
    nowMs: NOW
  });
  assert.strictEqual(result.status, 'blocked');
  assert(result.reasonCodes.includes('CHANNEL_FEE_RATE_ABOVE_POLICY'));
  assert(!result.reasonCodes.includes('CHANNEL_FEE_EXCEEDS_TOTAL_COST'));
}

function testForeignManualReviewIsNotClearedByFeeEvidence() {
  const value = order({
    orderStatus: 'manual_review',
    manualReviewReason: 'profit_sharing',
    manualReviewReasonCodes: ['SPLIT_TERMINAL_MISMATCH'],
    financeAutomationBlocked: true
  });
  const result = buildOrderConfirmation({
    order: value,
    refunds: [],
    paymentEvidence: matchedPayment(value),
    refundEvidences: [],
    confirmedAtMs: NOW,
    nowMs: NOW
  });
  assert.strictEqual(result.status, 'blocked');
  assert(result.reasonCodes.includes('NON_RECONCILIATION_MANUAL_REVIEW'));
  assert.strictEqual(result.orderPatch.channelFeeFen, 60);
  assert.strictEqual(result.orderPatch.orderStatus, 'manual_review');
  assert.strictEqual(result.orderPatch.financeAutomationBlocked, true);
  assert.strictEqual(result.orderPatch.manualReviewReason, 'profit_sharing');
  assert.deepStrictEqual(
    result.orderPatch.manualReviewReasonCodes,
    ['SPLIT_TERMINAL_MISMATCH']
  );
}

function testConfirmationWindowAndStableEvidenceHash() {
  const value = order();
  const evidence = matchedPayment(value);
  const beforeTen = Date.parse('2026-07-14T09:59:59+08:00');
  assertManual(buildOrderConfirmation({
    order: value,
    refunds: [],
    paymentEvidence: evidence,
    refundEvidences: [],
    confirmedAtMs: beforeTen,
    nowMs: beforeTen
  }), 'CONFIRMATION_BEFORE_BILL_WINDOW');

  const first = buildOrderConfirmation({
    order: value,
    refunds: [],
    paymentEvidence: evidence,
    refundEvidences: [],
    confirmedAtMs: NOW,
    nowMs: NOW
  });
  const later = buildOrderConfirmation({
    order: value,
    refunds: [],
    paymentEvidence: evidence,
    refundEvidences: [],
    confirmedAtMs: NOW + 60_000,
    nowMs: NOW + 60_000
  });
  assert.strictEqual(first.eventDocument.evidenceHash, later.eventDocument.evidenceHash);
  assert.notStrictEqual(first.eventDocument.confirmedAtMs, later.eventDocument.confirmedAtMs);
}

function testOrderSnapshotTokenDetectsFinanceCasChanges() {
  const original = order();
  assert.match(orderSnapshotToken(original), /^[0-9a-f]{64}$/);
  assert.notStrictEqual(
    orderSnapshotToken(original),
    orderSnapshotToken({ ...original, paidTableFeeFen: 9999 })
  );
  assert.notStrictEqual(
    orderSnapshotToken(original),
    orderSnapshotToken({ ...original, paymentStatus: 'partially_refunded' })
  );
}

function testStrictOfficialTimeParsingRejectsCalendarNormalization() {
  assert.strictEqual(
    normalizeRfc3339ToChinaSecond('2024-02-29T16:00:00Z'),
    '2024-03-01 00:00:00'
  );
  assert.strictEqual(
    normalizeBillTimeToChinaSecond('2024-02-29 23:59:59'),
    '2024-02-29 23:59:59'
  );
  for (const malformed of [
    '2026-02-29T00:00:00+08:00',
    '2026-04-31T00:00:00+08:00',
    '2026-01-01T24:00:00+08:00',
    '2026-01-01T00:00:60+08:00',
    '2026-01-01T00:00:00+24:00'
  ]) {
    assert.strictEqual(normalizeRfc3339ToChinaSecond(malformed), null, malformed);
  }
  for (const malformed of [
    '2026-02-29 00:00:00',
    '2026-04-31 00:00:00',
    '2026-01-01 24:00:00',
    '2026-01-01 00:00:60'
  ]) {
    assert.strictEqual(normalizeBillTimeToChinaSecond(malformed), null, malformed);
  }

  const invalidOrder = order({
    wechatSuccessTime: '2026-02-31T23:59:59+08:00'
  });
  const bytes = tradeBillBytes([paymentBillRow()]);
  assertManual(
    matchPaymentEvidence(
      invalidOrder,
      parseTradeBill(bytes).rows,
      artifactFor(BILL_DATE, bytes)
    ),
    'PAYMENT_TIME_INVALID'
  );
  const invalidRefund = refund({
    refundCreateTime: '2026-02-31T08:01:02+08:00'
  });
  const refundBytes = tradeBillBytes([refundBillRow()]);
  assertManual(
    matchRefundEvidence(
      order({
        paymentStatus: 'partially_refunded',
        paidTableFeeFen: 8000,
        totalCostFen: 400,
        shopNetFen: 7600,
        shopSettlementFen: 7600,
        grossRefundedFen: 2000,
        refundedTableFeeFen: 2000
      }),
      invalidRefund,
      parseTradeBill(refundBytes).rows,
      artifactFor(REFUND_BILL_DATE, refundBytes)
    ),
    'REFUND_TIME_INVALID'
  );
}

function anomalyKey(input) {
  return `anomaly_${crypto.createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex')
    .slice(0, 58)}`;
}

function createMemoryStore({
  profiles = [paymentProfile()],
  orders = [order()],
  refunds = [],
  artifacts = [],
  runs = [],
  events = [],
  beforeApply = null
} = {}) {
  const state = {
    profiles: new Map(profiles.map((value) => [value._id, clone(value)])),
    orders: new Map(orders.map((value) => [value._id, clone(value)])),
    refunds: new Map(refunds.map((value) => [value._id, clone(value)])),
    artifacts: new Map(artifacts.map((value) => [value._id || value.artifactId, clone(value)])),
    runs: new Map(runs.map((value) => [value._id || value.runId, clone(value)])),
    events: new Map(events.map((value) => [value._id, clone(value)])),
    anomalies: new Map(),
    operations: [],
    transactionDepth: 0,
    applyCalls: 0
  };

  async function transaction(label, work) {
    state.operations.push(`tx:${label}:start`);
    state.transactionDepth += 1;
    try {
      return await work();
    } finally {
      state.transactionDepth -= 1;
      state.operations.push(`tx:${label}:end`);
    }
  }

  function recordAnomalyDocument(input) {
    const reasonCodes = [...new Set(input.reasonCodes || [])].sort();
    const identity = {
      reasonCodes,
      billDate: input.billDate || null,
      subMchid: input.subMchid || null,
      orderId: input.orderId || null,
      refundNo: input.refundNo || null
    };
    const id = input.anomalyId || anomalyKey(identity);
    if (!state.anomalies.has(id)) {
      state.anomalies.set(id, {
        _id: id,
        ...clone(identity),
        artifactId: input.artifactId || null,
        source: 'wechat_trade_bill',
        status: 'open',
        severity: 'blocking'
      });
    } else if (state.anomalies.get(id).severity !== 'blocking') {
      state.anomalies.get(id).severity = 'blocking';
    }
    return id;
  }

  return {
    state,
    serverDate() {
      return { $date: 'server' };
    },
    async listRetryableBillDates(input) {
      state.operations.push(`query:retryable-runs:${input.limit}`);
      return [...state.runs.values()]
        .filter((value) => (
          value.status === 'running'
          && value.leaseExpiresAt <= input.nowMs
          && value.billDate < input.beforeBillDate
        ))
        .sort((left, right) => (
          left.leaseExpiresAt - right.leaseExpiresAt
          || left.billDate.localeCompare(right.billDate)
        ))
        .slice(0, input.limit)
        .map((value) => value.billDate);
    },
    async listUnreconciledPaidOrders(input) {
      state.operations.push(`query:unreconciled-payments:${input.limit}`);
      return [...state.orders.values()]
        .filter((value) => (
          value.schemaVersion === 2
          && ['complete', 'manual_review'].includes(value.orderStatus)
          && ['paid', 'partially_refunded', 'refunded'].includes(value.paymentStatus)
          && value.paymentBillFeeEvidence === null
          && value.paymentBillDiscoveryCompletedAt === null
          && Number.isSafeInteger(value.paidAt)
          && value.paidAt >= 0
          && value.paidAt < input.beforeMs
        ))
        .sort((left, right) => (
          (left.orderStatus === 'complete' ? 0 : 1)
          - (right.orderStatus === 'complete' ? 0 : 1)
          || left.paidAt - right.paidAt
          || left._id.localeCompare(right._id)
        ))
        .slice(0, input.limit)
        .map(clone);
    },
    async claimRun(input) {
      return transaction('claim-run', async () => {
        const existing = state.runs.get(input.runId);
        if (
          existing
          && existing.status === 'completed'
          && input.reopenCompleted !== true
        ) {
          return { status: 'completed', run: clone(existing) };
        }
        if (
          existing
          && existing.status === 'running'
          && existing.leaseExpiresAt > input.claimedAt
        ) {
          return { status: 'active', run: clone(existing) };
        }
        const run = {
          _id: input.runId,
          runId: input.runId,
          policyVersion: input.policyVersion,
          billDate: input.billDate,
          attemptId: input.attemptId,
          status: 'running',
          claimedAt: input.claimedAt,
          leaseExpiresAt: input.leaseExpiresAt,
          revision: existing && Number.isSafeInteger(existing.revision)
            ? existing.revision + 1
            : (existing && existing.status === 'completed' ? 1 : 0)
        };
        state.runs.set(input.runId, run);
        return { status: 'claimed', run: clone(run) };
      });
    },
    async completeRun(input) {
      return transaction('complete-run', async () => {
        const current = state.runs.get(input.runId);
        if (!current || current.attemptId !== input.attemptId || current.status !== 'running') {
          return false;
        }
        Object.assign(current, {
          status: 'completed',
          completedAt: input.completedAt,
          summary: clone(input.summary)
        });
        return true;
      });
    },
    async renewRun(input) {
      return transaction('renew-run', async () => {
        const current = state.runs.get(input.runId);
        if (!current || current.attemptId !== input.attemptId || current.status !== 'running') {
          return false;
        }
        current.leaseExpiresAt = input.leaseExpiresAt;
        current.heartbeatAt = input.heartbeatAt;
        return true;
      });
    },
    async deferRun(input) {
      return transaction('defer-run', async () => {
        const current = state.runs.get(input.runId);
        if (!current || current.attemptId !== input.attemptId || current.status !== 'running') {
          return false;
        }
        current.leaseExpiresAt = input.leaseExpiresAt;
        current.deferredAt = input.deferredAt;
        current.lastAttemptSummary = clone(input.summary);
        return true;
      });
    },
    async listBillProfiles(limit) {
      state.operations.push(`query:profiles:${limit}`);
      return [...state.profiles.values()]
        .sort((left, right) => left._id.localeCompare(right._id))
        .slice(0, limit)
        .map(clone);
    },
    async recordAnomaly(input) {
      return transaction('anomaly', async () => recordAnomalyDocument(input));
    },
    async claimArtifact(input) {
      return transaction('claim-artifact', async () => {
        const id = input.artifact.artifactId;
        const existing = state.artifacts.get(id);
        if (existing && existing.sha1 !== input.sha1) {
          return { status: 'conflict', artifact: clone(existing) };
        }
        if (existing && existing.sha1 === input.sha1 && existing.fileId) {
          return { status: 'replay', artifact: clone(existing) };
        }
        if (
          existing
          && existing.sha1 === input.sha1
          && existing.leaseExpiresAt > input.claimedAt
          && existing.attemptId !== input.attemptId
        ) {
          return { status: 'active', artifact: clone(existing) };
        }
        const value = {
          ...(existing || {}),
          _id: id,
          ...clone(input.artifact),
          sha1: input.sha1,
          signedHashType: input.hashType,
          signedHashValue: input.signedHashValue,
          calculatedSha1: input.sha1,
          byteLength: input.byteLength,
          sourceMetadata: clone(input.sourceMetadata),
          parseStatus: existing && existing.parseStatus ? existing.parseStatus : 'claimed',
          attemptId: input.attemptId,
          claimedAt: input.claimedAt,
          leaseExpiresAt: input.leaseExpiresAt,
          storageVisibility: 'private'
        };
        state.artifacts.set(id, value);
        return {
          status: existing ? 'resumed' : 'claimed',
          artifact: clone(value)
        };
      });
    },
    async markArtifactUploaded(input) {
      return transaction('artifact-uploaded', async () => {
        const current = state.artifacts.get(input.artifactId);
        if (
          !current
          || current.sha1 !== input.sha1
          || current.attemptId !== input.attemptId
        ) return false;
        Object.assign(current, {
          fileId: input.fileId,
          uploadedAt: input.uploadedAt,
          storageVisibility: 'private',
          contentType: input.contentType,
          parseStatus: 'uploaded'
        });
        return true;
      });
    },
    async markArtifactParsed(input) {
      return transaction('artifact-parsed', async () => {
        const current = state.artifacts.get(input.artifactId);
        if (!current || current.sha1 !== input.sha1) return false;
        Object.assign(current, {
          parseStatus: 'parsed',
          parsedAt: input.parsedAt,
          rowCount: input.rowCount,
          headerCount: input.headerCount
        });
        return true;
      });
    },
    async listOrdersForBill(input) {
      state.operations.push(`query:orders:${input.limit}`);
      return [...state.orders.values()]
        .filter((value) => (
          value.schemaVersion === 2
          && value.paymentProfileSnapshot
          && value.paymentProfileSnapshot.subMchid === input.subMchid
          && Number.isSafeInteger(value.paidAt)
          && value.paidAt >= input.startMs
          && value.paidAt < input.endMs
        ))
        .sort((left, right) => left.paidAt - right.paidAt || left._id.localeCompare(right._id))
        .slice(0, input.limit)
        .map(clone);
    },
    async listRefundsForBill(input) {
      state.operations.push(`query:refunds:${input.limit}`);
      return [...state.refunds.values()]
        .filter((value) => {
          if (value.subMchid !== input.subMchid) return false;
          const official = value.refundCreatedAt;
          const requested = value.requestedAt;
          return Number.isSafeInteger(official) ? (
            Number.isSafeInteger(official)
            && official >= input.startMs
            && official < input.endMs
          ) : (
            Number.isSafeInteger(requested)
            && requested >= input.startMs
            && requested < input.endMs
          );
        })
        .sort((left, right) => (
          (left.refundCreatedAt || left.requestedAt)
          - (right.refundCreatedAt || right.requestedAt)
          || left._id.localeCompare(right._id)
        ))
        .slice(0, input.limit)
        .map(clone);
    },
    async getOrder(id) {
      state.operations.push(`get:order:${id}`);
      return clone(state.orders.get(id) || null);
    },
    async getRefund(id) {
      state.operations.push(`get:refund:${id}`);
      return clone(state.refunds.get(id) || null);
    },
    async listRefundsForOrder(input) {
      state.operations.push(`query:order-refunds:${input.orderId}:${input.limit}`);
      return [...state.refunds.values()]
        .filter((value) => value.orderId === input.orderId)
        .sort((left, right) => left._id.localeCompare(right._id))
        .slice(0, input.limit)
        .map(clone);
    },
    async blockOrder(input) {
      return transaction('block-order', async () => {
        const current = state.orders.get(input.orderId);
        if (!current) return false;
        const foreignManualReview = current.orderStatus === 'manual_review'
          && current.manualReviewReason !== 'finance_reconciliation';
        Object.assign(current, {
          orderStatus: 'manual_review',
          financeAutomationBlocked: true,
          manualReviewReason: foreignManualReview
            ? (current.manualReviewReason || 'existing_manual_review')
            : 'finance_reconciliation',
          manualReviewReasonCodes: foreignManualReview
            ? (Array.isArray(current.manualReviewReasonCodes)
              ? current.manualReviewReasonCodes
              : [])
            : [...new Set(input.reasonCodes)].sort(),
          paymentBillDiscoveryCompletedAt: { $date: 'server' }
        });
        recordAnomalyDocument(input);
        return true;
      });
    },
    async applyOrderEvidence(input) {
      return transaction('apply-order', async () => {
        state.applyCalls += 1;
        if (beforeApply) beforeApply(state, input);
        const current = state.orders.get(input.orderId);
        if (!current || orderSnapshotToken(current) !== input.expectedOrderToken) {
          return { status: 'conflict', reasonCodes: ['ORDER_CAS_CONFLICT'] };
        }
        const orderRefunds = [...state.refunds.values()]
          .filter((value) => value.orderId === input.orderId)
          .sort((left, right) => left._id.localeCompare(right._id))
          .map(clone);
        if (JSON.stringify(orderRefunds) !== JSON.stringify(input.refundSnapshots)) {
          return { status: 'conflict', reasonCodes: ['REFUND_CAS_CONFLICT'] };
        }
        const result = buildOrderConfirmation({
          order: clone(current),
          refunds: orderRefunds,
          paymentEvidence: input.paymentEvidence,
          refundEvidences: input.refundEvidences,
          confirmedAtMs: input.confirmedAtMs,
          nowMs: input.nowMs
        });
        if (result.paymentEvidence) {
          current.paymentBillFeeEvidence = clone(result.paymentEvidence);
        }
        for (const [refundNo, patchValue] of Object.entries(result.refundPatches || {})) {
          Object.assign(state.refunds.get(refundNo), clone(patchValue));
        }
        if (result.eventDocument) {
          const existing = state.events.get(result.eventId);
          if (existing) {
            const comparable = clone(existing);
            delete comparable._id;
            comparable.createdAt = null;
            const expected = clone(result.eventDocument);
            expected.confirmedAtMs = comparable.confirmedAtMs;
            if (JSON.stringify(comparable) !== JSON.stringify(expected)) {
              Object.assign(current, {
                orderStatus: 'manual_review',
                financeAutomationBlocked: true,
                manualReviewReason: 'finance_reconciliation',
                manualReviewReasonCodes: ['EXISTING_FEE_EVENT_CONFLICT']
              });
              recordAnomalyDocument({
                orderId: current.orderId,
                billDate: input.billDate,
                subMchid: current.paymentProfileSnapshot.subMchid,
                reasonCodes: ['EXISTING_FEE_EVENT_CONFLICT']
              });
              return { status: 'manual_review', reasonCodes: ['EXISTING_FEE_EVENT_CONFLICT'] };
            }
          } else {
            state.events.set(result.eventId, {
              _id: result.eventId,
              ...clone(result.eventDocument),
              createdAt: { $date: 'server' }
            });
          }
        }
        if (result.orderPatch) Object.assign(current, clone(result.orderPatch));
        if (['blocked', 'manual_review'].includes(result.status)) {
          recordAnomalyDocument({
            orderId: current.orderId,
            billDate: input.billDate,
            subMchid: current.paymentProfileSnapshot.subMchid,
            reasonCodes: result.reasonCodes
          });
        }
        return result;
      });
    }
  };
}

function handlerFixture({
  now = NOW,
  billBytes = tradeBillBytes([paymentBillRow()]),
  store = createMemoryStore(),
  runtimeContext = {},
  invocationContext = {},
  tradeBillError = null,
  downloadBillError = null,
  uploadArtifactError = null
} = {}) {
  const clientCalls = [];
  const uploadCalls = [];
  const signedHash = crypto.createHash('sha1').update(billBytes).digest('hex');
  const client = {
    async tradeBill(query) {
      assert.strictEqual(store.state.transactionDepth, 0);
      clientCalls.push({ method: 'tradeBill', query: clone(query) });
      if (tradeBillError) throw tradeBillError;
      return {
        download_url: 'https://api.mch.weixin.qq.com/v3/billdownload/file?token=a%2Fb%20c',
        hash_type: 'SHA1',
        hash_value: signedHash
      };
    },
    async downloadBill(metadata) {
      assert.strictEqual(store.state.transactionDepth, 0);
      clientCalls.push({ method: 'downloadBill', metadata: clone(metadata) });
      if (downloadBillError) throw downloadBillError;
      return Buffer.from(billBytes);
    }
  };
  const handler = createReconcileFinanceHandler({
    store,
    getContext: () => runtimeContext,
    loadConfig: () => ({ spMchid: SP_MCHID }),
    createWechatPayClient: () => client,
    nowMs: () => now,
    makeAttemptId: () => 'reconcile_attempt_001',
    async uploadPrivateArtifact(input) {
      assert.strictEqual(store.state.transactionDepth, 0);
      uploadCalls.push(clone({
        cloudPath: input.cloudPath,
        byteLength: input.fileContent.length,
        metadata: input.metadata
      }));
      store.state.operations.push('storage:upload');
      if (uploadArtifactError) throw uploadArtifactError;
      return { fileId: `cloud://${input.cloudPath}` };
    }
  });
  return { handler, store, clientCalls, uploadCalls, invocationContext, signedHash };
}

async function testTimerGuardReadyProfileAndPrivateArtifactFlow() {
  const denied = handlerFixture();
  assert.deepStrictEqual(await denied.handler({}), {
    ok: false,
    code: 'ACCESS_DENIED'
  });
  assert.deepStrictEqual(await denied.handler({
    Type: 'Timer',
    TriggerName: 'wrong'
  }), { ok: false, code: 'ACCESS_DENIED' });
  const runtimeOpenid = handlerFixture({ runtimeContext: { OPENID: OWNER } });
  assert.deepStrictEqual(await runtimeOpenid.handler({
    Type: 'Timer',
    TriggerName: 'reconcileTableFinanceTimer'
  }), { ok: false, code: 'ACCESS_DENIED' });
  const invocationOpenid = handlerFixture();
  assert.deepStrictEqual(await invocationOpenid.handler({
    Type: 'Timer',
    TriggerName: 'reconcileTableFinanceTimer'
  }, { OPENID: OWNER }), { ok: false, code: 'ACCESS_DENIED' });
  assert.deepStrictEqual(await invocationOpenid.handler({
    Type: 'Timer',
    TriggerName: 'reconcileTableFinanceTimer'
  }, { OPENID: '' }), { ok: false, code: 'ACCESS_DENIED' });
  assert.strictEqual(denied.clientCalls.length, 0);
  assert.strictEqual(runtimeOpenid.clientCalls.length, 0);
  assert.strictEqual(invocationOpenid.clientCalls.length, 0);

  const fixture = handlerFixture();
  const result = await fixture.handler({
    Type: 'Timer',
    TriggerName: 'reconcileTableFinanceTimer'
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.billDate, BILL_DATE);
  assert.deepStrictEqual(fixture.clientCalls[0], {
    method: 'tradeBill',
    query: {
      bill_date: BILL_DATE,
      sub_mchid: SUB_MCHID,
      bill_type: 'ALL'
    }
  });
  assert.strictEqual(Object.hasOwn(fixture.clientCalls[0].query, 'tar_type'), false);
  assert.deepStrictEqual(fixture.uploadCalls, [{
    cloudPath: `finance/bills/${BILL_DATE}/${SUB_MCHID}/trade.csv`,
    byteLength: tradeBillBytes([paymentBillRow()]).length,
    metadata: {
      visibility: 'private',
      contentType: 'text/csv; charset=utf-8',
      sha1: fixture.signedHash
    }
  }]);
  assert(
    fixture.store.state.operations.indexOf('tx:claim-artifact:end')
      < fixture.store.state.operations.indexOf('storage:upload')
  );
  const artifact = [...fixture.store.state.artifacts.values()][0];
  assert.strictEqual(artifact.signedHashType, 'SHA1');
  assert.strictEqual(artifact.signedHashValue, fixture.signedHash);
  assert.strictEqual(artifact.calculatedSha1, fixture.signedHash);
  assert.strictEqual(artifact.storageVisibility, 'private');
  assert.strictEqual(artifact.parseStatus, 'parsed');
  assert.strictEqual(fixture.store.state.events.size, 1);
  const storedOrder = fixture.store.state.orders.get(ORDER_ID);
  assert.strictEqual(storedOrder.channelFeeFen, 60);
  assert.strictEqual(storedOrder.platformNetFen, 440);
  assert.strictEqual(storedOrder.financeAutomationBlocked, false);
}

async function testUnverifiedBillModeCreatesAnomalyWithoutNetwork() {
  const store = createMemoryStore({
    profiles: [paymentProfile({ tradeBillModeVerified: false })]
  });
  const fixture = handlerFixture({ store });
  const result = await fixture.handler({
    Type: 'Timer',
    TriggerName: 'reconcileTableFinanceTimer'
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(fixture.clientCalls.length, 0);
  assert.strictEqual(fixture.uploadCalls.length, 0);
  assert.strictEqual(store.state.anomalies.size, 1);
  const anomaly = [...store.state.anomalies.values()][0];
  assert(anomaly.reasonCodes.includes('TRADE_BILL_MODE_NOT_VERIFIED'));
  assert.strictEqual(anomaly.status, 'open');
  assert.strictEqual(anomaly.billDate, BILL_DATE);
  assert.strictEqual(anomaly.severity, 'blocking');
}

async function testRollbackDisablesNewClaimsWithoutDisablingBillReconciliation() {
  const store = createMemoryStore({
    profiles: [paymentProfile({
      paymentEnabled: false,
      profitSharingEnabled: false
    })]
  });
  const fixture = handlerFixture({ store });
  const result = await fixture.handler({
    Type: 'Timer',
    TriggerName: 'reconcileTableFinanceTimer'
  });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(
    fixture.clientCalls.map((entry) => entry.method),
    ['tradeBill', 'downloadBill']
  );
  assert.strictEqual(store.state.events.size, 1);
  assert.strictEqual(store.state.orders.get(ORDER_ID).channelFeeFen, 60);
}

async function testLiveLeaseBlocksAndExpiredLeaseResumes() {
  const runId = runIdForBillDate(POLICY_VERSION, BILL_DATE);
  const liveStore = createMemoryStore({
    runs: [{
      _id: runId,
      runId,
      policyVersion: POLICY_VERSION,
      billDate: BILL_DATE,
      attemptId: 'other_attempt',
      status: 'running',
      claimedAt: NOW - 1000,
      leaseExpiresAt: NOW + RUN_LEASE_MS
    }]
  });
  const live = handlerFixture({ store: liveStore });
  assert.deepStrictEqual(await live.handler({
    Type: 'Timer',
    TriggerName: 'reconcileTableFinanceTimer'
  }), {
    ok: false,
    code: 'RECONCILIATION_ALREADY_RUNNING',
    billDate: BILL_DATE
  });
  assert.strictEqual(live.clientCalls.length, 0);

  const expiredStore = createMemoryStore({
    runs: [{
      _id: runId,
      runId,
      policyVersion: POLICY_VERSION,
      billDate: BILL_DATE,
      attemptId: 'expired_attempt',
      status: 'running',
      claimedAt: NOW - RUN_LEASE_MS * 2,
      leaseExpiresAt: NOW - 1
    }]
  });
  const expired = handlerFixture({ store: expiredStore });
  const result = await expired.handler({
    Type: 'Timer',
    TriggerName: 'reconcileTableFinanceTimer'
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(expired.clientCalls.filter((call) => call.method === 'tradeBill').length, 1);
  assert.strictEqual(expiredStore.state.runs.get(runId).attemptId, 'reconcile_attempt_001');
  assert.strictEqual(expiredStore.state.runs.get(runId).status, 'completed');
}

async function testExpiredOlderRunIsRetriedAlongsideCurrentBillDate() {
  const oldRunId = runIdForBillDate(POLICY_VERSION, BILL_DATE);
  const currentRunId = runIdForBillDate(POLICY_VERSION, REFUND_BILL_DATE);
  const store = createMemoryStore({
    orders: [],
    runs: [{
      _id: oldRunId,
      runId: oldRunId,
      policyVersion: POLICY_VERSION,
      billDate: BILL_DATE,
      attemptId: 'expired_old_attempt',
      status: 'running',
      claimedAt: NOW - RUN_LEASE_MS * 2,
      leaseExpiresAt: NOW - 1
    }]
  });
  const fixture = handlerFixture({ store, now: REFUND_NOW });
  const result = await fixture.handler({
    Type: 'Timer',
    TriggerName: 'reconcileTableFinanceTimer'
  });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(
    fixture.clientCalls
      .filter((call) => call.method === 'tradeBill')
      .map((call) => call.query.bill_date),
    [BILL_DATE, REFUND_BILL_DATE]
  );
  assert.strictEqual(store.state.runs.get(oldRunId).status, 'completed');
  assert.strictEqual(store.state.runs.get(currentRunId).status, 'completed');
}

async function testStatementFailureClassificationAndRunDeferral() {
  const apiError = (code, statusCode) => Object.assign(new Error(code), {
    code,
    statusCode
  });

  const emptyStore = createMemoryStore({ orders: [], refunds: [] });
  const noStatement = handlerFixture({
    store: emptyStore,
    tradeBillError: apiError('NO_STATEMENT_EXIST', 404)
  });
  const noStatementResult = await noStatement.handler({
    Type: 'Timer',
    TriggerName: 'reconcileTableFinanceTimer'
  });
  assert.strictEqual(noStatementResult.ok, true);
  assert.strictEqual(emptyStore.state.anomalies.size, 0);
  assert.strictEqual(
    emptyStore.state.runs.get(runIdForBillDate(POLICY_VERSION, BILL_DATE)).status,
    'completed'
  );

  const missingStore = createMemoryStore();
  const missing = handlerFixture({
    store: missingStore,
    tradeBillError: apiError('NO_STATEMENT_EXIST', 404)
  });
  const missingResult = await missing.handler({
    Type: 'Timer',
    TriggerName: 'reconcileTableFinanceTimer'
  });
  assert.strictEqual(missingResult.ok, true);
  assert.strictEqual(missingStore.state.orders.get(ORDER_ID).orderStatus, 'manual_review');
  assert(
    missingStore.state.orders.get(ORDER_ID).manualReviewReasonCodes
      .includes('TRADE_BILL_MISSING_WITH_LOCAL_CANDIDATES')
  );

  const transientStore = createMemoryStore();
  const transient = handlerFixture({
    store: transientStore,
    tradeBillError: apiError('STATEMENT_CREATING', 500)
  });
  const transientResult = await transient.handler({
    Type: 'Timer',
    TriggerName: 'reconcileTableFinanceTimer'
  });
  assert.strictEqual(transientResult.ok, false);
  assert.strictEqual(transientResult.code, 'FINANCE_RECONCILIATION_PENDING');
  const transientRun = transientStore.state.runs.get(
    runIdForBillDate(POLICY_VERSION, BILL_DATE)
  );
  assert.strictEqual(transientRun.status, 'running');
  assert(transientRun.lastAttemptSummary.pending > 0);

  const authStore = createMemoryStore();
  const auth = handlerFixture({
    store: authStore,
    tradeBillError: apiError('SIGN_ERROR', 401)
  });
  const authResult = await auth.handler({
    Type: 'Timer',
    TriggerName: 'reconcileTableFinanceTimer'
  });
  assert.strictEqual(authResult.ok, true);
  assert.strictEqual(authStore.state.orders.get(ORDER_ID).financeAutomationBlocked, true);
  assert(
    authStore.state.orders.get(ORDER_ID).manualReviewReasonCodes
      .includes('TRADE_BILL_ACCESS_FAILED')
  );
}

async function testRetryableArtifactStagesDeferAndParseFailureFreezesCrossDayOrder() {
  const timer = {
    Type: 'Timer',
    TriggerName: 'reconcileTableFinanceTimer'
  };
  const runId = runIdForBillDate(POLICY_VERSION, BILL_DATE);
  const serverError = Object.assign(new Error('download unavailable'), { statusCode: 500 });
  const downloadStore = createMemoryStore();
  const download = handlerFixture({
    store: downloadStore,
    downloadBillError: serverError
  });
  const downloadResult = await download.handler(timer);
  assert.strictEqual(downloadResult.code, 'FINANCE_RECONCILIATION_PENDING');
  assert.strictEqual(downloadStore.state.runs.get(runId).status, 'running');
  assert(downloadStore.state.operations.includes('tx:renew-run:start'));

  const uploadStore = createMemoryStore();
  const upload = handlerFixture({
    store: uploadStore,
    uploadArtifactError: new Error('storage unavailable')
  });
  const uploadResult = await upload.handler(timer);
  assert.strictEqual(uploadResult.code, 'FINANCE_RECONCILIATION_PENDING');
  assert.strictEqual(uploadStore.state.runs.get(runId).status, 'running');

  let hashError;
  try {
    verifyBillHash(Buffer.from('downloaded-corrupt-bill'), 'SHA1', '0'.repeat(40));
  } catch (error) {
    hashError = error;
  }
  assert(hashError);
  assert.strictEqual(hashError.code, 'BILL_HASH_INVALID');
  const hashStore = createMemoryStore();
  const hash = handlerFixture({ store: hashStore, downloadBillError: hashError });
  const hashResult = await hash.handler(timer);
  assert.strictEqual(hashResult.code, 'FINANCE_RECONCILIATION_PENDING');
  assert.strictEqual(hashStore.state.orders.get(ORDER_ID).financeAutomationBlocked, true);
  assert(
    hashStore.state.orders.get(ORDER_ID).manualReviewReasonCodes
      .includes('TRADE_BILL_HASH_INVALID')
  );

  const bytes = tradeBillBytes([paymentBillRow()]);
  const descriptor = artifactDescriptor(POLICY_VERSION, BILL_DATE, SUB_MCHID);
  const sha1 = crypto.createHash('sha1').update(bytes).digest('hex');
  const activeStore = createMemoryStore({
    artifacts: [{
      _id: descriptor.artifactId,
      ...descriptor,
      sha1,
      attemptId: 'other_attempt',
      claimedAt: NOW - 1000,
      leaseExpiresAt: NOW + ARTIFACT_LEASE_MS,
      parseStatus: 'claimed',
      storageVisibility: 'private'
    }]
  });
  const active = handlerFixture({ store: activeStore, billBytes: bytes });
  const activeResult = await active.handler(timer);
  assert.strictEqual(activeResult.code, 'FINANCE_RECONCILIATION_PENDING');
  assert.strictEqual(activeStore.state.runs.get(runId).status, 'running');

  const parseStore = createMemoryStore({
    orders: [order({
      channelFeeFen: 60,
      platformNetFen: 440,
      refundFeeReconciliationStatus: 'confirmed'
    })],
    refunds: [refund()]
  });
  const parse = handlerFixture({
    now: REFUND_NOW,
    billBytes: Buffer.from('not-an-official-trade-bill', 'utf8'),
    store: parseStore
  });
  const parseResult = await parse.handler(timer);
  assert.strictEqual(parseResult.code, 'FINANCE_RECONCILIATION_PENDING');
  assert.strictEqual(
    parseStore.state.runs.get(runIdForBillDate(POLICY_VERSION, REFUND_BILL_DATE)).status,
    'running'
  );
  assert.strictEqual(parseStore.state.orders.get(ORDER_ID).financeAutomationBlocked, true);
  assert(
    parseStore.state.orders.get(ORDER_ID).manualReviewReasonCodes
      .includes('TRADE_BILL_PARSE_FAILED')
  );
}

async function testArtifactReplayResumesWithoutUploadAndHashConflictNeverOverwrites() {
  const bytes = tradeBillBytes([paymentBillRow()]);
  const descriptor = artifactDescriptor(POLICY_VERSION, BILL_DATE, SUB_MCHID);
  const sha1 = crypto.createHash('sha1').update(bytes).digest('hex');
  const replayStore = createMemoryStore({
    artifacts: [{
      _id: descriptor.artifactId,
      ...descriptor,
      sha1,
      signedHashType: 'SHA1',
      signedHashValue: sha1,
      calculatedSha1: sha1,
      fileId: `cloud://${descriptor.cloudPath}`,
      parseStatus: 'parsed',
      storageVisibility: 'private',
      attemptId: 'first_attempt',
      claimedAt: NOW - 1000,
      leaseExpiresAt: NOW - 1
    }]
  });
  const replay = handlerFixture({ store: replayStore, billBytes: bytes });
  const replayResult = await replay.handler({
    Type: 'Timer',
    TriggerName: 'reconcileTableFinanceTimer'
  });
  assert.strictEqual(replayResult.ok, true);
  assert.strictEqual(replay.uploadCalls.length, 0);
  assert.strictEqual(replayStore.state.artifacts.get(descriptor.artifactId).fileId,
    `cloud://${descriptor.cloudPath}`);
  assert.strictEqual(replayStore.state.events.size, 1);

  const originalArtifact = {
    _id: descriptor.artifactId,
    ...descriptor,
    sha1: 'a'.repeat(40),
    signedHashType: 'SHA1',
    signedHashValue: 'a'.repeat(40),
    calculatedSha1: 'a'.repeat(40),
    fileId: 'cloud://original-file',
    parseStatus: 'parsed',
    storageVisibility: 'private'
  };
  const conflictStore = createMemoryStore({ artifacts: [originalArtifact] });
  const conflict = handlerFixture({ store: conflictStore, billBytes: bytes });
  const conflictResult = await conflict.handler({
    Type: 'Timer',
    TriggerName: 'reconcileTableFinanceTimer'
  });
  assert.strictEqual(conflictResult.ok, true);
  assert.strictEqual(conflict.uploadCalls.length, 0);
  assert.deepStrictEqual(
    conflictStore.state.artifacts.get(descriptor.artifactId),
    originalArtifact
  );
  assert.strictEqual(conflictStore.state.events.size, 0);
  assert.strictEqual(conflictStore.state.anomalies.size, 2);
  assert.strictEqual(conflictStore.state.orders.get(ORDER_ID).orderStatus, 'manual_review');
  assert.strictEqual(conflictStore.state.orders.get(ORDER_ID).financeAutomationBlocked, true);
  assert(
    conflictStore.state.orders.get(ORDER_ID).manualReviewReasonCodes
      .includes('BILL_ARTIFACT_HASH_CONFLICT')
  );
  assert(
    [...conflictStore.state.anomalies.values()]
      .every((entry) => entry.reasonCodes.includes('BILL_ARTIFACT_HASH_CONFLICT'))
  );

  const refundBytes = tradeBillBytes([refundBillRow()]);
  const refundDescriptor = artifactDescriptor(
    POLICY_VERSION,
    REFUND_BILL_DATE,
    SUB_MCHID
  );
  const refundConflictStore = createMemoryStore({
    orders: [order({
      channelFeeFen: 60,
      platformNetFen: 440,
      channelFeeEvidenceHash: 'f'.repeat(64),
      refundFeeReconciliationStatus: 'confirmed'
    })],
    refunds: [refund()],
    artifacts: [{
      ...refundDescriptor,
      _id: refundDescriptor.artifactId,
      sha1: 'b'.repeat(40),
      calculatedSha1: 'b'.repeat(40),
      fileId: 'cloud://original-refund-file',
      parseStatus: 'parsed',
      storageVisibility: 'private'
    }]
  });
  const refundConflict = handlerFixture({
    store: refundConflictStore,
    now: REFUND_NOW,
    billBytes: refundBytes
  });
  await refundConflict.handler({
    Type: 'Timer',
    TriggerName: 'reconcileTableFinanceTimer'
  });
  assert.strictEqual(
    refundConflictStore.state.orders.get(ORDER_ID).orderStatus,
    'manual_review'
  );
  assert.strictEqual(
    refundConflictStore.state.orders.get(ORDER_ID).financeAutomationBlocked,
    true
  );
}

async function testRefundBillPersistsEvidenceAndAppendsNewEvent() {
  const initialOrder = order();
  const paymentEvidence = matchedPayment(initialOrder);
  const initialConfirmation = buildOrderConfirmation({
    order: initialOrder,
    refunds: [],
    paymentEvidence,
    refundEvidences: [],
    confirmedAtMs: NOW,
    nowMs: NOW
  });
  const value = order({
    paymentStatus: 'partially_refunded',
    grossRefundedFen: 2000,
    refundedTableFeeFen: 2000,
    paidTableFeeFen: 8000,
    totalCostFen: 400,
    shopNetFen: 7600,
    shopSettlementFen: 7600,
    paymentBillFeeEvidence: paymentEvidence,
    preRefundChannelFeeFen: 60,
    preRefundPlatformNetFen: 440,
    preRefundChannelFeeEvidenceHash: initialConfirmation.eventDocument.evidenceHash,
    refundFeeReconciliationStatus: 'pending',
    financeAutomationBlocked: true
  });
  const localRefund = refund({
    verifiedSource: 'notification',
    settlementRefundFen: null,
    refundCreateTime: null,
    refundCreatedAt: null,
    requestedAt: Date.parse('2026-07-13T23:59:58+08:00')
  });
  const store = createMemoryStore({
    orders: [value],
    refunds: [localRefund],
    events: [{
      _id: initialConfirmation.eventId,
      ...initialConfirmation.eventDocument,
      createdAt: { $date: 'server' }
    }]
  });
  const fixture = handlerFixture({
    now: REFUND_NOW,
    billBytes: tradeBillBytes([refundBillRow()]),
    store
  });
  const result = await fixture.handler({
    Type: 'Timer',
    TriggerName: 'reconcileTableFinanceTimer'
  });
  assert.strictEqual(result.ok, true);
  const updatedRefund = store.state.refunds.get(REFUND_NO);
  assert.strictEqual(updatedRefund.status, 'succeeded');
  assert.strictEqual(updatedRefund.billFeeEvidence.row.feeFen, -12);
  assert.strictEqual(updatedRefund.refundCreateTime, REFUND_CREATE_TIME);
  assert.strictEqual(updatedRefund.refundCreatedAt, Date.parse(REFUND_CREATE_TIME));
  assert.strictEqual(updatedRefund.reportedRefundFeeFen, 999);
  const updatedOrder = store.state.orders.get(ORDER_ID);
  assert.strictEqual(updatedOrder.channelFeeFen, 48);
  assert.strictEqual(updatedOrder.platformNetFen, 352);
  assert.strictEqual(updatedOrder.refundFeeReconciliationStatus, 'confirmed');
  assert.strictEqual(updatedOrder.financeAutomationBlocked, false);
  assert.strictEqual(store.state.events.size, 2);
}

async function testValidPaymentEvidencePersistsWhileRefundEvidenceIsPending() {
  const paymentDateRefund = refund({
    refundCreateTime: '2026-07-13T23:58:00+08:00',
    refundCreatedAt: Date.parse('2026-07-13T23:58:00+08:00')
  });
  const value = order({
    paymentStatus: 'partially_refunded',
    grossRefundedFen: 2000,
    refundedTableFeeFen: 2000,
    paidTableFeeFen: 8000,
    totalCostFen: 400,
    shopNetFen: 7600,
    shopSettlementFen: 7600,
    refundFeeReconciliationStatus: 'pending',
    financeAutomationBlocked: true
  });
  const store = createMemoryStore({
    orders: [value],
    refunds: [paymentDateRefund]
  });
  const fixture = handlerFixture({
    store,
    billBytes: tradeBillBytes([paymentBillRow()])
  });
  const result = await fixture.handler({
    Type: 'Timer',
    TriggerName: 'reconcileTableFinanceTimer'
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'FINANCE_RECONCILIATION_PENDING');
  const updated = store.state.orders.get(ORDER_ID);
  assert.strictEqual(updated.paymentBillFeeEvidence.row.kind, 'payment');
  assert.strictEqual(updated.paymentBillFeeEvidence.artifact.billDate, BILL_DATE);
  assert.strictEqual(updated.channelFeeFen, null);
  assert.strictEqual(updated.refundFeeReconciliationStatus, 'pending');
  assert.strictEqual(updated.financeAutomationBlocked, true);
  assert.strictEqual(store.state.events.size, 0);
}

async function testMissingDuplicateMismatchAndNonterminalBlockWithoutPaymentTruthOverwrite() {
  const scenarios = [
    [[], 'PAYMENT_ROW_MISSING'],
    [[paymentBillRow(), paymentBillRow()], 'PAYMENT_ROW_DUPLICATE'],
    [[paymentBillRow({ '货币种类': 'USD' })], 'PAYMENT_CURRENCY_MISMATCH']
  ];
  for (const [rows, code] of scenarios) {
    const store = createMemoryStore();
    const before = clone(store.state.orders.get(ORDER_ID));
    const fixture = handlerFixture({ store, billBytes: tradeBillBytes(rows) });
    const result = await fixture.handler({
      Type: 'Timer',
      TriggerName: 'reconcileTableFinanceTimer'
    });
    assert.strictEqual(result.ok, true);
    const after = store.state.orders.get(ORDER_ID);
    assert.strictEqual(after.outTradeNo, before.outTradeNo);
    assert.strictEqual(after.wechatTransactionId, before.wechatTransactionId);
    assert.strictEqual(after.paymentStatus, before.paymentStatus);
    assert.strictEqual(after.wechatOrderTotalFen, before.wechatOrderTotalFen);
    assert.strictEqual(after.channelFeeFen, null);
    assert.strictEqual(after.orderStatus, 'manual_review');
    assert.strictEqual(after.financeAutomationBlocked, true);
    assert(after.manualReviewReasonCodes.includes(code));
    const anomalyCount = store.state.anomalies.size;
    await store.blockOrder({
      orderId: ORDER_ID,
      billDate: BILL_DATE,
      subMchid: SUB_MCHID,
      reasonCodes: [code]
    });
    assert.strictEqual(store.state.anomalies.size, anomalyCount);
  }

  const pendingRefund = refund({ status: 'processing' });
  const refundOrder = order({
    paymentStatus: 'partially_refunded',
    grossRefundedFen: 2000,
    refundedTableFeeFen: 0,
    paidTableFeeFen: 10000,
    refundFeeReconciliationStatus: 'pending',
    financeAutomationBlocked: true
  });
  const refundStore = createMemoryStore({
    orders: [refundOrder],
    refunds: [pendingRefund]
  });
  const refundFixture = handlerFixture({
    now: REFUND_NOW,
    billBytes: tradeBillBytes([refundBillRow()]),
    store: refundStore
  });
  await refundFixture.handler({
    Type: 'Timer',
    TriggerName: 'reconcileTableFinanceTimer'
  });
  assert(
    refundStore.state.orders.get(ORDER_ID).manualReviewReasonCodes
      .includes('REFUND_LOCAL_NOT_TERMINAL')
  );
  assert.strictEqual(refundStore.state.refunds.get(REFUND_NO).billFeeEvidence, undefined);
}

async function testInvalidEvidenceDoesNotOverwriteForeignManualReview() {
  const store = createMemoryStore({
    orders: [order({
      orderStatus: 'manual_review',
      manualReviewReason: 'refund_mismatch',
      manualReviewReasonCodes: ['EXISTING_REFUND_MISMATCH_CONFLICT'],
      financeAutomationBlocked: true
    })]
  });
  const fixture = handlerFixture({ store, billBytes: tradeBillBytes([]) });
  const result = await fixture.handler({
    Type: 'Timer',
    TriggerName: 'reconcileTableFinanceTimer'
  });
  assert.strictEqual(result.ok, true);
  const updated = store.state.orders.get(ORDER_ID);
  assert.strictEqual(updated.manualReviewReason, 'refund_mismatch');
  assert.deepStrictEqual(
    updated.manualReviewReasonCodes,
    ['EXISTING_REFUND_MISMATCH_CONFLICT']
  );
  assert(
    [...store.state.anomalies.values()]
      .some((entry) => entry.reasonCodes.includes('PAYMENT_ROW_MISSING'))
  );
}

async function testFinalCasConflictBlocksAndCreatesNoEvent() {
  const store = createMemoryStore({
    beforeApply(state) {
      state.orders.get(ORDER_ID).paymentStatus = 'partially_refunded';
    }
  });
  const fixture = handlerFixture({ store });
  const result = await fixture.handler({
    Type: 'Timer',
    TriggerName: 'reconcileTableFinanceTimer'
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(store.state.events.size, 0);
  assert.strictEqual(store.state.orders.get(ORDER_ID).channelFeeFen, null);
  assert.strictEqual(store.state.orders.get(ORDER_ID).financeAutomationBlocked, true);
  assert(
    store.state.orders.get(ORDER_ID).manualReviewReasonCodes
      .includes('ORDER_CAS_CONFLICT')
  );
  assert.strictEqual(store.state.anomalies.size, 1);
}

async function testRefundSnapshotCasConflictBlocksAndCreatesNoEvent() {
  const localRefund = refund({
    status: 'processing',
    verifiedSource: null,
    refundCreateTime: null,
    refundCreatedAt: null
  });
  const store = createMemoryStore({
    refunds: [localRefund],
    beforeApply(state) {
      state.refunds.get(REFUND_NO).requestedRefundFen = 1;
    }
  });
  const fixture = handlerFixture({ store });
  const result = await fixture.handler({
    Type: 'Timer',
    TriggerName: 'reconcileTableFinanceTimer'
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(store.state.events.size, 0);
  assert.strictEqual(store.state.orders.get(ORDER_ID).channelFeeFen, null);
  assert.strictEqual(store.state.orders.get(ORDER_ID).financeAutomationBlocked, true);
  assert(
    store.state.orders.get(ORDER_ID).manualReviewReasonCodes
      .includes('REFUND_CAS_CONFLICT')
  );
  assert.strictEqual(store.state.anomalies.size, 1);
}

async function testEvidencePersistenceFailureDefersAndBlocksOrder() {
  const store = createMemoryStore({
    beforeApply() {
      throw new Error('database unavailable');
    }
  });
  const fixture = handlerFixture({ store });
  const result = await fixture.handler({
    Type: 'Timer',
    TriggerName: 'reconcileTableFinanceTimer'
  });
  assert.strictEqual(result.code, 'FINANCE_RECONCILIATION_PENDING');
  assert.strictEqual(
    store.state.runs.get(runIdForBillDate(POLICY_VERSION, BILL_DATE)).status,
    'running'
  );
  assert.strictEqual(store.state.events.size, 0);
  assert.strictEqual(store.state.orders.get(ORDER_ID).financeAutomationBlocked, true);
  assert(
    store.state.orders.get(ORDER_ID).manualReviewReasonCodes
      .includes('ORDER_EVIDENCE_WRITE_FAILED')
  );
}

async function testSameEvidenceReplayCreatesNoSecondEventOrMutation() {
  const store = createMemoryStore();
  const fixture = handlerFixture({ store });
  await fixture.handler({
    Type: 'Timer',
    TriggerName: 'reconcileTableFinanceTimer'
  });
  const firstEvent = clone([...store.state.events.values()][0]);
  const firstOrder = clone(store.state.orders.get(ORDER_ID));
  const firstArtifact = clone([...store.state.artifacts.values()][0]);
  store.state.runs.clear();
  const replay = handlerFixture({ store, now: NOW + 60_000 });
  await replay.handler({
    Type: 'Timer',
    TriggerName: 'reconcileTableFinanceTimer'
  });
  assert.strictEqual(store.state.events.size, 1);
  assert.deepStrictEqual([...store.state.events.values()][0], firstEvent);
  assert.strictEqual(replay.uploadCalls.length, 0);
  assert.strictEqual(store.state.orders.get(ORDER_ID).channelFeeEvidenceHash,
    firstOrder.channelFeeEvidenceHash);
  assert.strictEqual([...store.state.artifacts.values()][0].fileId, firstArtifact.fileId);
}

async function testCompletedRunReopensForLatePaidOrder() {
  const store = createMemoryStore({ orders: [] });
  const first = handlerFixture({ store });
  const completed = await first.handler({
    Type: 'Timer',
    TriggerName: 'reconcileTableFinanceTimer'
  });
  assert.strictEqual(completed.ok, true);
  assert.strictEqual(store.state.events.size, 0);

  store.state.orders.set(ORDER_ID, order());
  const late = handlerFixture({ store, now: NOW + 5 * 60 * 1000 });
  const reopened = await late.handler({
    Type: 'Timer',
    TriggerName: 'reconcileTableFinanceTimer'
  });
  assert.strictEqual(reopened.ok, true);
  assert.notStrictEqual(reopened.alreadyCompleted, true);
  assert.strictEqual(
    store.state.orders.get(ORDER_ID).paymentBillFeeEvidence.row.outTradeNo,
    OUT_TRADE_NO
  );
  assert.strictEqual(store.state.events.size, 1);
  assert.strictEqual(
    store.state.runs.get(runIdForBillDate(POLICY_VERSION, BILL_DATE)).revision,
    1
  );

  const replay = handlerFixture({ store, now: NOW + 10 * 60 * 1000 });
  const replayed = await replay.handler({
    Type: 'Timer',
    TriggerName: 'reconcileTableFinanceTimer'
  });
  assert.strictEqual(replayed.alreadyCompleted, true);
  assert.strictEqual(store.state.events.size, 1);
}

async function testUnreconciledCandidateSkipsPermanentManualReview() {
  const manualOrder = order({
    _id: 'ord_manual_oldest',
    orderId: 'ord_manual_oldest',
    outTradeNo: 'pay_manual_oldest',
    orderStatus: 'manual_review',
    paymentBillDiscoveryCompletedAt: NOW - 1,
    paidAt: Date.parse('2026-07-10T10:00:00+08:00')
  });
  const eligibleOrder = order({
    _id: 'ord_late_eligible',
    orderId: 'ord_late_eligible',
    outTradeNo: 'pay_late_eligible',
    paidAt: Date.parse('2026-07-11T10:00:00+08:00')
  });
  const store = createMemoryStore({ orders: [manualOrder, eligibleOrder] });
  const candidates = await store.listUnreconciledPaidOrders({
    beforeMs: NOW,
    limit: 1
  });
  assert.deepStrictEqual(candidates.map((value) => value._id), [eligibleOrder._id]);

  const unattemptedManual = {
    ...manualOrder,
    paymentBillDiscoveryCompletedAt: null
  };
  const manualStore = createMemoryStore({ orders: [unattemptedManual] });
  const manualCandidates = await manualStore.listUnreconciledPaidOrders({
    beforeMs: NOW,
    limit: 1
  });
  assert.deepStrictEqual(
    manualCandidates.map((value) => value._id),
    [unattemptedManual._id]
  );
}

function createQueryRecorder() {
  const calls = [];
  function collection(name) {
    const record = { collection: name, where: null, orderBy: [], limit: null };
    const query = {
      where(value) {
        record.where = value;
        return query;
      },
      orderBy(field, direction) {
        record.orderBy.push([field, direction]);
        return query;
      },
      limit(value) {
        record.limit = value;
        return query;
      },
      async get() {
        calls.push(clone(record));
        return { data: [] };
      },
      doc(id) {
        return {
          async get() { return { data: null }; },
          async set() { calls.push({ collection: name, doc: id, method: 'set' }); },
          async update() { calls.push({ collection: name, doc: id, method: 'update' }); }
        };
      }
    };
    return query;
  }
  const command = {
    gte: (value) => ({ $gte: value }),
    lt: (value) => ({ $lt: value }),
    lte: (value) => ({ $lte: value }),
    exists: (value) => ({ $exists: value }),
    in: (value) => ({ $in: value }),
    and: (values) => ({ $and: values })
  };
  return {
    calls,
    db: {
      collection,
      command,
      serverDate() { return { $date: 'server' }; },
      runTransaction(work) { return work({ collection }); }
    }
  };
}

async function testProductionStoreUsesBoundedIndexableQueries() {
  const invalidRecorder = createQueryRecorder();
  delete invalidRecorder.db.command.in;
  assert.throws(
    () => createCloudbaseReconciliationStore(invalidRecorder.db),
    TypeError
  );

  const recorder = createQueryRecorder();
  const store = createCloudbaseReconciliationStore(recorder.db);
  await store.listRetryableBillDates({
    beforeBillDate: BILL_DATE,
    nowMs: NOW,
    limit: 2
  });
  await store.listUnreconciledPaidOrders({
    beforeMs: Date.parse('2026-07-14T00:00:00+08:00'),
    limit: 2
  });
  await store.listBillProfiles(25);
  await store.listOrdersForBill({
    subMchid: SUB_MCHID,
    startMs: Date.parse('2026-07-13T00:00:00+08:00'),
    endMs: Date.parse('2026-07-14T00:00:00+08:00'),
    limit: 101
  });
  await store.listRefundsForBill({
    subMchid: SUB_MCHID,
    startMs: Date.parse('2026-07-14T00:00:00+08:00'),
    endMs: Date.parse('2026-07-15T00:00:00+08:00'),
    limit: 101
  });
  await store.listRefundsForOrder({ orderId: ORDER_ID, limit: 101 });

  const retryQuery = recorder.calls.find(
    (call) => call.collection === 'finance_reconciliation_runs'
  );
  assert.deepStrictEqual(retryQuery.where, {
    status: 'running',
    leaseExpiresAt: { $lte: NOW },
    billDate: { $lt: BILL_DATE }
  });
  assert.deepStrictEqual(retryQuery.orderBy, [
    ['leaseExpiresAt', 'asc'],
    ['billDate', 'asc']
  ]);
  assert.strictEqual(retryQuery.limit, 2);

  const profileQuery = recorder.calls.find((call) => call.collection === 'shop_payment_profiles');
  assert.deepStrictEqual(profileQuery.where, {
    schemaVersion: 1,
    status: 'ready',
    policyVersion: POLICY_VERSION
  });
  assert.deepStrictEqual(profileQuery.orderBy, [['_id', 'asc']]);
  assert.strictEqual(profileQuery.limit, 25);

  const unreconciledOrderQueries = recorder.calls.filter((call) => (
    call.collection === 'shop_orders'
    && Object.prototype.hasOwnProperty.call(call.where, 'paymentBillFeeEvidence')
  ));
  assert.strictEqual(unreconciledOrderQueries.length, 2);
  for (const query of unreconciledOrderQueries) {
    assert.strictEqual(query.where.schemaVersion, 2);
    assert(['complete', 'manual_review'].includes(query.where.orderStatus));
    assert.deepStrictEqual(query.where.paymentStatus, {
      $in: ['paid', 'partially_refunded', 'refunded']
    });
    assert.strictEqual(query.where.paymentBillFeeEvidence, null);
    assert.strictEqual(query.where.paymentBillDiscoveryCompletedAt, null);
    assert(query.where.paidAt);
    assert.deepStrictEqual(query.orderBy, [['paidAt', 'asc'], ['_id', 'asc']]);
    assert.strictEqual(query.limit, 2);
  }
  assert.strictEqual(
    unreconciledOrderQueries.filter((query) => query.where.orderStatus === 'complete').length,
    1
  );
  assert.strictEqual(
    unreconciledOrderQueries.filter((query) => query.where.orderStatus === 'manual_review').length,
    1
  );

  const orderQuery = recorder.calls.find((call) => (
    call.collection === 'shop_orders'
    && call.where['paymentProfileSnapshot.subMchid'] === SUB_MCHID
  ));
  assert.strictEqual(orderQuery.where.schemaVersion, 2);
  assert.strictEqual(orderQuery.where['paymentProfileSnapshot.subMchid'], SUB_MCHID);
  assert(orderQuery.where.paidAt);
  assert.deepStrictEqual(orderQuery.orderBy, [['paidAt', 'asc'], ['_id', 'asc']]);
  assert.strictEqual(orderQuery.limit, 101);

  const allRefundQueries = recorder.calls.filter((call) => call.collection === 'shop_refunds');
  const refundQueries = allRefundQueries.filter((call) => call.where.subMchid === SUB_MCHID);
  assert.strictEqual(refundQueries.length, 2);
  assert(refundQueries.some((query) => query.where.refundCreatedAt));
  assert(refundQueries.some((query) => query.where.requestedAt));
  for (const query of refundQueries) {
    assert.strictEqual(query.where.subMchid, SUB_MCHID);
    assert.strictEqual(query.limit, 101);
    assert.strictEqual(query.orderBy[1][0], '_id');
  }
  const requestedFallbackQuery = refundQueries.find((query) => query.where.requestedAt);
  assert.strictEqual(requestedFallbackQuery.where.refundCreatedAt, null);
  const orderRefundQuery = allRefundQueries.find((query) => query.where.orderId === ORDER_ID);
  assert(orderRefundQuery);
  assert.deepStrictEqual(orderRefundQuery.orderBy, [['_id', 'asc']]);
  assert.strictEqual(orderRefundQuery.limit, 101);
}

function testDeployableFunctionContract() {
  const root = path.join(__dirname, '..');
  const functionRoot = path.join(root, 'cloudfunctions', 'reconcileTableFinance');
  const indexSource = fs.readFileSync(path.join(functionRoot, 'index.js'), 'utf8');
  assert(!indexSource.includes("require('../_shared"));
  const storeSource = fs.readFileSync(
    path.join(root, 'cloudfunctions', '_shared', 'table-reconciliation', 'cloudbase-reconciliation-store.js'),
    'utf8'
  );
  const applyStart = storeSource.indexOf('    async applyOrderEvidence(input) {');
  const applyEnd = storeSource.indexOf('\n    }\n  });', applyStart);
  assert(applyStart >= 0 && applyEnd > applyStart);
  assert(!storeSource.slice(applyStart, applyEnd).includes('.where('));
  const canonicalFiles = [
    'table-reconciliation/table-reconciliation.js',
    'table-reconciliation/cloudbase-reconciliation-store.js',
    'table-finance/money.js',
    'table-finance/state.js',
    'wechatpay-v3/client.js',
    'wechatpay-v3/config.js',
    'wechatpay-v3/http-event.js',
    'wechatpay-v3/bill-parser.js'
  ];
  for (const relative of canonicalFiles) {
    const source = fs.readFileSync(path.join(root, 'cloudfunctions', '_shared', relative));
    const deployed = fs.readFileSync(path.join(functionRoot, 'lib', relative));
    assert(source.equals(deployed), `${relative} must be byte-identical`);
  }
  const manifest = JSON.parse(fs.readFileSync(
    path.join(functionRoot, 'package.json'),
    'utf8'
  ));
  assert.strictEqual(manifest.main, 'index.js');
  assert.strictEqual(manifest.dependencies['wx-server-sdk'], '~2.6.3');
  const timer = JSON.parse(fs.readFileSync(
    path.join(functionRoot, 'config.json'),
    'utf8'
  ));
  assert.deepStrictEqual(timer, {
    triggers: [{
      name: 'reconcileTableFinanceTimer',
      type: 'timer',
      config: '0 15 10 * * * *'
    }]
  });
}

(async () => {
  const tests = [
    testExactHeadersParserAndChinaDates,
    testArtifactContract,
    testExactPaymentMatchingAndMismatchReasons,
    testCouponIsPaymentValidAndAutomationProceeds,
    testRefundTerminalIdentitySignsAndReportedFeeIgnored,
    testConfirmationEventShapeAndRefundAggregation,
    testPostSplitRefundAdjustmentUsesOfficialFeeEvidence,
    testZeroPlatformSplitRefundNeedsNoAdjustment,
    testGeneratedFeeEventAuthorizesProfitSharing,
    testAllSucceededRefundEvidenceRequiredAndDedupe,
    testFeeAboveCostPreservesActualFeeAndDisplaysZero,
    testFeeRateAboveFivePercentBlocksEvenWhenRoundedCostCoversIt,
    testForeignManualReviewIsNotClearedByFeeEvidence,
    testConfirmationWindowAndStableEvidenceHash,
    testOrderSnapshotTokenDetectsFinanceCasChanges,
    testStrictOfficialTimeParsingRejectsCalendarNormalization,
    testTimerGuardReadyProfileAndPrivateArtifactFlow,
    testUnverifiedBillModeCreatesAnomalyWithoutNetwork,
    testRollbackDisablesNewClaimsWithoutDisablingBillReconciliation,
    testLiveLeaseBlocksAndExpiredLeaseResumes,
    testExpiredOlderRunIsRetriedAlongsideCurrentBillDate,
    testStatementFailureClassificationAndRunDeferral,
    testRetryableArtifactStagesDeferAndParseFailureFreezesCrossDayOrder,
    testArtifactReplayResumesWithoutUploadAndHashConflictNeverOverwrites,
    testRefundBillPersistsEvidenceAndAppendsNewEvent,
    testValidPaymentEvidencePersistsWhileRefundEvidenceIsPending,
    testMissingDuplicateMismatchAndNonterminalBlockWithoutPaymentTruthOverwrite,
    testInvalidEvidenceDoesNotOverwriteForeignManualReview,
    testFinalCasConflictBlocksAndCreatesNoEvent,
    testRefundSnapshotCasConflictBlocksAndCreatesNoEvent,
    testEvidencePersistenceFailureDefersAndBlocksOrder,
    testSameEvidenceReplayCreatesNoSecondEventOrMutation,
    testCompletedRunReopensForLatePaidOrder,
    testUnreconciledCandidateSkipsPermanentManualReview,
    testProductionStoreUsesBoundedIndexableQueries,
    testDeployableFunctionContract
  ];
  for (const test of tests) await test();
  console.log(`table reconciliation ok (${tests.length} tests)`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
