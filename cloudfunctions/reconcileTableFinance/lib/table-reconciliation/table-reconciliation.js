'use strict';

const crypto = require('crypto');
const { calculateSettlement } = require('../table-finance/money');
const { financialEventId } = require('../table-finance/state');
const { parseBillCsv } = require('../wechatpay-v3/bill-parser');

const POLICY_VERSION = 'table_commission_v1';
const RUN_LEASE_MS = 15 * 60 * 1000;
const ARTIFACT_LEASE_MS = 15 * 60 * 1000;

const TRADE_BILL_HEADERS = Object.freeze([
  '交易时间', '公众账号ID', '商户号', '特约商户号', '设备号', '微信订单号', '商户订单号',
  '用户标识', '交易类型', '交易状态', '付款银行', '货币种类', '应结订单金额', '代金券金额',
  '微信退款单号', '商户退款单号', '退款金额', '充值券退款金额', '退款类型', '退款状态',
  '商品名称', '商户数据包', '手续费', '费率', '订单金额', '申请退款金额', '费率备注'
]);

const TRADE_BILL_AMOUNT_HEADERS = Object.freeze([
  '应结订单金额',
  '代金券金额',
  '退款金额',
  '充值券退款金额',
  '手续费',
  '订单金额',
  '申请退款金额'
]);

const SUMMARY_AMOUNT_HEADERS = Object.freeze([
  '应结订单总金额',
  '退款总金额',
  '充值券退款总金额',
  '手续费总金额',
  '订单总金额',
  '申请退款总金额'
]);

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeFen(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function safeText(value, maximumBytes = 256) {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= maximumBytes
    && !/[\x00-\x1f\x7f]/.test(value);
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function manual(reasonCodes) {
  return {
    status: 'manual_review',
    reasonCodes: uniqueSorted(reasonCodes)
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = value[key] === undefined ? null : canonicalize(value[key]);
    }
    return result;
  }
  return value === undefined ? null : value;
}

function stableHash(value) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalize(value)), 'utf8')
    .digest('hex');
}

function leapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, month) {
  const values = [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return values[month - 1] || 0;
}

function validCalendar(year, month, day, hour, minute, second) {
  return Number.isInteger(year)
    && year >= 2000
    && year <= 9999
    && Number.isInteger(month)
    && month >= 1
    && month <= 12
    && Number.isInteger(day)
    && day >= 1
    && day <= daysInMonth(year, month)
    && Number.isInteger(hour)
    && hour >= 0
    && hour <= 23
    && Number.isInteger(minute)
    && minute >= 0
    && minute <= 59
    && Number.isInteger(second)
    && second >= 0
    && second <= 59;
}

function components(match) {
  return match.slice(1, 7).map(Number);
}

function formatUtcSecond(milliseconds) {
  const date = new Date(milliseconds);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
    + ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function normalizeRfc3339ToChinaSecond(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/
  );
  if (!match) return null;
  const [year, month, day, hour, minute, second] = components(match);
  if (!validCalendar(year, month, day, hour, minute, second)) return null;
  const fractionMs = Number((match[7] || '').padEnd(3, '0').slice(0, 3) || '0');
  let offsetMinutes = 0;
  if (match[8] !== 'Z') {
    const offsetHour = Number(match[8].slice(1, 3));
    const offsetMinute = Number(match[8].slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return null;
    offsetMinutes = (offsetHour * 60 + offsetMinute) * (match[8][0] === '-' ? -1 : 1);
  }
  const instant = Date.UTC(year, month - 1, day, hour, minute, second, fractionMs)
    - offsetMinutes * 60_000;
  if (!Number.isSafeInteger(instant)) return null;
  return formatUtcSecond(instant + 8 * 60 * 60 * 1000);
}

function normalizeBillTimeToChinaSecond(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/
  );
  if (!match) return null;
  const values = components(match);
  return validCalendar(...values) ? value : null;
}

function billTimeToEpoch(value) {
  const normalized = normalizeBillTimeToChinaSecond(value);
  if (!normalized) return null;
  const match = normalized.match(
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/
  );
  const [year, month, day, hour, minute, second] = components(match);
  const instant = Date.UTC(year, month - 1, day, hour, minute, second)
    - 8 * 60 * 60 * 1000;
  return Number.isSafeInteger(instant) ? instant : null;
}

function validBillDate(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && normalizeBillTimeToChinaSecond(`${value} 00:00:00`) !== null;
}

function chinaDateBounds(billDate) {
  if (!validBillDate(billDate)) throw new TypeError('billDate is invalid');
  const [year, month, day] = billDate.split('-').map(Number);
  const startMs = Date.UTC(year, month - 1, day) - 8 * 60 * 60 * 1000;
  return { startMs, endMs: startMs + 24 * 60 * 60 * 1000 };
}

function previousChinaBillDate(nowMs) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError('nowMs is invalid');
  }
  const china = new Date(nowMs + 8 * 60 * 60 * 1000);
  const previous = new Date(Date.UTC(
    china.getUTCFullYear(),
    china.getUTCMonth(),
    china.getUTCDate() - 1
  ));
  const pad = (value) => String(value).padStart(2, '0');
  return `${previous.getUTCFullYear()}-${pad(previous.getUTCMonth() + 1)}-${pad(previous.getUTCDate())}`;
}

function runIdForBillDate(policyVersion, billDate) {
  if (policyVersion !== POLICY_VERSION || !validBillDate(billDate)) {
    throw new TypeError('reconciliation run identity is invalid');
  }
  return `${policyVersion}__${billDate}`;
}

function artifactDescriptor(policyVersion, billDate, subMchid) {
  if (
    policyVersion !== POLICY_VERSION
    || !validBillDate(billDate)
    || typeof subMchid !== 'string'
    || !/^[0-9]{8,32}$/.test(subMchid)
  ) {
    throw new TypeError('trade-bill artifact identity is invalid');
  }
  return Object.freeze({
    artifactId: `${policyVersion}__${billDate}__trade__sub_mchid__${subMchid}`,
    policyVersion,
    billDate,
    billType: 'trade',
    scopeType: 'sub_mchid',
    scopeAccount: subMchid,
    cloudPath: `finance/bills/${billDate}/${subMchid}/trade.csv`
  });
}

function parseTradeBill(rawBytes) {
  const parsed = parseBillCsv(rawBytes, {
    requiredHeaders: [...TRADE_BILL_HEADERS],
    amountHeaders: [...TRADE_BILL_AMOUNT_HEADERS],
    summaryAmountHeaders: [...SUMMARY_AMOUNT_HEADERS]
  });
  if (JSON.stringify(parsed.headers) !== JSON.stringify(TRADE_BILL_HEADERS)) {
    throw new Error('trade bill header must exactly match the official ALL header');
  }
  return parsed;
}

function localRefundNosFromTradeBill(rows, limit) {
  if (
    !Array.isArray(rows)
    || !Number.isSafeInteger(limit)
    || limit <= 0
    || limit > 1000
  ) throw new TypeError('trade-bill refund lookup bounds are invalid');
  const refundNoHeader = TRADE_BILL_HEADERS[15];
  const values = new Set();
  for (const row of rows) {
    if (!isPlainObject(row)) throw new TypeError('trade-bill row is invalid');
    const refundNo = row[refundNoHeader];
    if (
      typeof refundNo === 'string'
      && /^refund_[A-Za-z0-9_-]{1,57}$/.test(refundNo)
    ) values.add(refundNo);
    if (values.size >= limit) break;
  }
  return [...values].sort();
}

function normalizedArtifact(artifact) {
  if (
    !isPlainObject(artifact)
    || !validBillDate(artifact.billDate)
    || !safeText(artifact.artifactId, 200)
    || typeof artifact.sha1 !== 'string'
    || !/^[0-9a-f]{40}$/.test(artifact.sha1)
  ) {
    return null;
  }
  return {
    billDate: artifact.billDate,
    artifactId: artifact.artifactId,
    sha1: artifact.sha1
  };
}

function rowIdentityHash(kind, row) {
  return stableHash({
    kind,
    values: TRADE_BILL_HEADERS.map((header) => [header, row[header]])
  });
}

function paymentEventRow(order, row, artifact) {
  return {
    kind: 'payment',
    billDate: artifact.billDate,
    artifactId: artifact.artifactId,
    rowIdentityHash: rowIdentityHash('payment', row),
    feeFen: row['手续费'],
    outTradeNo: order.outTradeNo,
    transactionId: order.wechatTransactionId,
    subMchid: order.paymentProfileSnapshot.subMchid
  };
}

function refundEventRow(order, refund, row, artifact) {
  return {
    kind: 'refund',
    billDate: artifact.billDate,
    artifactId: artifact.artifactId,
    rowIdentityHash: rowIdentityHash('refund', row),
    feeFen: row['手续费'],
    outTradeNo: order.outTradeNo,
    transactionId: order.wechatTransactionId,
    subMchid: order.paymentProfileSnapshot.subMchid,
    refundNo: refund.refundNo,
    wechatRefundId: refund.wechatRefundId
  };
}

function paymentOrderReasons(order) {
  const reasons = [];
  if (!isPlainObject(order) || order._id !== order.orderId || order.schemaVersion !== 2) {
    return ['PAYMENT_ORDER_INVALID'];
  }
  if (!['complete', 'manual_review'].includes(order.orderStatus)) reasons.push('PAYMENT_ORDER_STATE');
  if (!['paid', 'partially_refunded', 'refunded'].includes(order.paymentStatus)) {
    reasons.push('PAYMENT_STATUS_LOCAL');
  }
  if (order.policyVersion !== POLICY_VERSION) reasons.push('PAYMENT_POLICY');
  if (!safeText(order.outTradeNo, 32)) reasons.push('PAYMENT_OUT_TRADE_NO');
  if (!safeText(order.wechatTransactionId, 32)) reasons.push('PAYMENT_TRANSACTION_ID');
  if (
    !isPlainObject(order.paymentProfileSnapshot)
    || !/^[0-9]{8,32}$/.test(order.paymentProfileSnapshot.subMchid || '')
  ) reasons.push('PAYMENT_PROFILE');
  for (const name of ['wechatOrderTotalFen', 'wechatPayerTotalFen', 'couponSubsidyFen']) {
    if (!safeFen(order[name])) reasons.push(`PAYMENT_${name.toUpperCase()}`);
  }
  if (
    safeFen(order.wechatOrderTotalFen)
    && safeFen(order.wechatPayerTotalFen)
    && safeFen(order.couponSubsidyFen)
    && order.wechatPayerTotalFen + order.couponSubsidyFen !== order.wechatOrderTotalFen
  ) reasons.push('PAYMENT_AMOUNT_IDENTITY');
  return reasons;
}

function matchPaymentEvidence(order, rows, artifactInput) {
  const reasons = paymentOrderReasons(order);
  const artifact = normalizedArtifact(artifactInput);
  if (!artifact) reasons.push('PAYMENT_ARTIFACT_INVALID');
  if (!Array.isArray(rows)) reasons.push('PAYMENT_ROWS_INVALID');
  if (reasons.length > 0) return manual(reasons);

  const sameMerchantOrder = rows.filter((row) => (
    isPlainObject(row) && row['商户订单号'] === order.outTradeNo
  ));
  if (sameMerchantOrder.length === 0) return manual(['PAYMENT_ROW_MISSING']);
  const paymentRows = sameMerchantOrder.filter((row) => (
    row['微信退款单号'] === '0'
    && row['商户退款单号'] === '0'
  ));
  if (paymentRows.length === 0) return manual(['PAYMENT_ROW_MISSING']);
  const exact = paymentRows.filter((row) => (
    row['微信订单号'] === order.wechatTransactionId
    && row['特约商户号'] === order.paymentProfileSnapshot.subMchid
  ));
  if (exact.length === 0) return manual(['PAYMENT_IDENTITY_MISMATCH']);
  if (exact.length !== 1) return manual(['PAYMENT_ROW_DUPLICATE']);
  if (paymentRows.length !== 1) return manual(['PAYMENT_ROW_CONFLICT']);
  const row = exact[0];

  if (row['交易状态'] !== 'SUCCESS') reasons.push('PAYMENT_STATUS_MISMATCH');
  if (row['货币种类'] !== 'CNY') reasons.push('PAYMENT_CURRENCY_MISMATCH');
  if (row['订单金额'] !== order.wechatOrderTotalFen) {
    reasons.push('PAYMENT_TOTAL_MISMATCH');
  }
  if (row['代金券金额'] !== order.couponSubsidyFen) {
    reasons.push('PAYMENT_COUPON_MISMATCH');
  }
  if (
    !safeFen(row['应结订单金额'])
    || row['应结订单金额'] > order.wechatOrderTotalFen
    || (
      order.couponSubsidyFen === 0
      && row['应结订单金额'] !== order.wechatOrderTotalFen
    )
  ) reasons.push('PAYMENT_SETTLEMENT_TOTAL_MISMATCH');
  if (!Number.isSafeInteger(row['手续费']) || row['手续费'] <= 0) {
    reasons.push('PAYMENT_FEE_SIGN');
  }
  if (
    row['退款金额'] !== 0
    || row['充值券退款金额'] !== 0
    || row['申请退款金额'] !== 0
  ) reasons.push('PAYMENT_REFUND_AMOUNT_CONFLICT');

  const officialTime = normalizeRfc3339ToChinaSecond(order.wechatSuccessTime);
  const billTime = normalizeBillTimeToChinaSecond(row['交易时间']);
  if (officialTime === null) reasons.push('PAYMENT_TIME_INVALID');
  if (billTime === null) reasons.push('PAYMENT_ROW_TIME_INVALID');
  if (officialTime && artifact.billDate !== officialTime.slice(0, 10)) {
    reasons.push('PAYMENT_BILL_DATE_MISMATCH');
  }
  if (officialTime && billTime && officialTime !== billTime) {
    reasons.push('PAYMENT_TIME_MISMATCH');
  }
  if (reasons.length > 0) return manual(reasons);

  return {
    status: 'matched',
    evidence: {
      artifact,
      row: paymentEventRow(order, row, artifact),
      officialOrderTotalFen: row['订单金额'],
      officialSettlementTotalFen: row['应结订单金额'],
      couponFen: row['代金券金额'],
      officialTime: billTime
    }
  };
}

function matchRefundEvidence(order, refund, rows, artifactInput) {
  const reasons = paymentOrderReasons(order);
  const artifact = normalizedArtifact(artifactInput);
  if (!artifact) reasons.push('REFUND_ARTIFACT_INVALID');
  if (!isPlainObject(refund) || refund._id !== refund.refundNo || refund.orderId !== order.orderId) {
    reasons.push('REFUND_LOCAL_INVALID');
  }
  if (!Array.isArray(rows)) reasons.push('REFUND_ROWS_INVALID');
  if (reasons.length > 0) return manual(reasons);

  const sameRefund = rows.filter((row) => (
    isPlainObject(row) && row['商户退款单号'] === refund.refundNo
  ));
  if (sameRefund.length === 0) return manual(['REFUND_ROW_MISSING']);
  const exact = sameRefund.filter((row) => (
    row['微信退款单号'] === refund.wechatRefundId
    && row['商户订单号'] === order.outTradeNo
    && row['微信订单号'] === order.wechatTransactionId
    && row['特约商户号'] === order.paymentProfileSnapshot.subMchid
  ));
  if (exact.length === 0) return manual(['REFUND_IDENTITY_MISMATCH']);
  if (exact.length !== 1) return manual(['REFUND_ROW_DUPLICATE']);
  if (sameRefund.length !== 1) return manual(['REFUND_ROW_CONFLICT']);
  const row = exact[0];

  if (refund.status !== 'succeeded' || !['query', 'notification'].includes(refund.verifiedSource)) {
    reasons.push('REFUND_LOCAL_NOT_TERMINAL');
  }
  if (row['交易状态'] !== 'REFUND') reasons.push('REFUND_TRANSACTION_STATUS');
  if (row['退款状态'] !== 'SUCCESS') reasons.push('REFUND_BILL_NOT_TERMINAL');
  if (row['货币种类'] !== 'CNY') reasons.push('REFUND_CURRENCY_MISMATCH');
  if (!Number.isSafeInteger(row['手续费']) || row['手续费'] >= 0) {
    reasons.push('REFUND_FEE_SIGN');
  }
  if (!safeFen(refund.refundFen) || row['申请退款金额'] !== refund.refundFen) {
    reasons.push('REFUND_TOTAL_MISMATCH');
  }
  if (
    refund.settlementRefundFen !== null
    && (
      !safeFen(refund.settlementRefundFen)
      || row['退款金额'] !== refund.settlementRefundFen
    )
  ) reasons.push('REFUND_SETTLEMENT_TOTAL_MISMATCH');
  const notificationTimeOmitted = refund.refundCreateTime === null
    && refund.verifiedSource === 'notification';
  const officialTime = notificationTimeOmitted
    ? null
    : normalizeRfc3339ToChinaSecond(refund.refundCreateTime);
  const billTime = normalizeBillTimeToChinaSecond(row['交易时间']);
  if (!notificationTimeOmitted && officialTime === null) reasons.push('REFUND_TIME_INVALID');
  if (billTime === null) reasons.push('REFUND_ROW_TIME_INVALID');
  if (billTime && artifact.billDate !== billTime.slice(0, 10)) {
    reasons.push('REFUND_BILL_DATE_MISMATCH');
  }
  if (officialTime && artifact.billDate !== officialTime.slice(0, 10)) {
    reasons.push('REFUND_BILL_DATE_MISMATCH');
  }
  if (officialTime && billTime && officialTime !== billTime) {
    reasons.push('REFUND_TIME_MISMATCH');
  }
  if (reasons.length > 0) return manual(reasons);

  return {
    status: 'matched',
    evidence: {
      refundNo: refund.refundNo,
      wechatRefundId: refund.wechatRefundId,
      artifact,
      row: refundEventRow(order, refund, row, artifact),
      officialGrossRefundFen: row['申请退款金额'],
      officialSettlementRefundFen: row['退款金额'],
      rechargeCouponRefundFen: row['充值券退款金额'],
      officialTime: billTime,
      officialCreatedAt: billTimeToEpoch(billTime)
    }
  };
}

function orderSnapshotToken(order) {
  if (!isPlainObject(order)) throw new TypeError('order snapshot is invalid');
  const names = [
    '_id', 'orderId', 'schemaVersion', 'orderStatus', 'paymentStatus', 'splitStatus',
    'policyVersion', 'outTradeNo', 'wechatTransactionId', 'wechatSuccessTime',
    'wechatOrderTotalFen', 'wechatPayerTotalFen', 'couponSubsidyFen',
    'grossRefundedFen', 'refundedTableFeeFen', 'couponRefundedFen',
    'requestedRefundFen', 'refundClaim',
    'retainedCouponSubsidyFen', 'paidTableFeeFen', 'totalCostFen',
    'channelFeeFen', 'platformNetFen', 'channelFeeEvidenceHash',
    'preRefundChannelFeeFen', 'preRefundPlatformNetFen',
    'preRefundChannelFeeEvidenceHash', 'refundFeeReconciliationStatus',
    'financeAutomationBlocked', 'paymentBillFeeEvidence',
    'splitPlatformNetFen', 'splitReturnedFen',
    'splitReturnAdjustmentStatus'
  ];
  const snapshot = {};
  for (const name of names) snapshot[name] = order[name] === undefined ? null : order[name];
  snapshot.paymentProfileSnapshot = order.paymentProfileSnapshot || null;
  return stableHash(snapshot);
}

function storedPaymentReasons(order, evidence) {
  const reasons = [];
  if (!isPlainObject(evidence) || !isPlainObject(evidence.row)) return ['PAYMENT_FEE_EVIDENCE_MISSING'];
  const artifact = normalizedArtifact(evidence.artifact);
  const row = evidence.row;
  if (!artifact) reasons.push('PAYMENT_EVIDENCE_ARTIFACT');
  if (
    row.kind !== 'payment'
    || row.billDate !== (artifact && artifact.billDate)
    || row.artifactId !== (artifact && artifact.artifactId)
    || !/^[0-9a-f]{64}$/.test(row.rowIdentityHash || '')
    || !Number.isSafeInteger(row.feeFen)
    || row.feeFen <= 0
    || row.outTradeNo !== order.outTradeNo
    || row.transactionId !== order.wechatTransactionId
    || row.subMchid !== order.paymentProfileSnapshot.subMchid
  ) reasons.push('PAYMENT_EVIDENCE_IDENTITY');
  const successTime = normalizeRfc3339ToChinaSecond(order.wechatSuccessTime);
  if (!successTime || !artifact || artifact.billDate !== successTime.slice(0, 10)) {
    reasons.push('PAYMENT_EVIDENCE_DATE');
  }
  if (evidence.couponFen !== order.couponSubsidyFen) reasons.push('PAYMENT_EVIDENCE_COUPON');
  return uniqueSorted(reasons);
}

function storedRefundReasons(order, refund, evidence) {
  const reasons = [];
  if (!isPlainObject(evidence) || !isPlainObject(evidence.row)) return ['REFUND_FEE_EVIDENCE_MISSING'];
  const artifact = normalizedArtifact(evidence.artifact);
  const row = evidence.row;
  if (!artifact) reasons.push('REFUND_EVIDENCE_ARTIFACT');
  if (
    row.kind !== 'refund'
    || row.billDate !== (artifact && artifact.billDate)
    || row.artifactId !== (artifact && artifact.artifactId)
    || !/^[0-9a-f]{64}$/.test(row.rowIdentityHash || '')
    || !Number.isSafeInteger(row.feeFen)
    || row.feeFen >= 0
    || row.outTradeNo !== order.outTradeNo
    || row.transactionId !== order.wechatTransactionId
    || row.subMchid !== order.paymentProfileSnapshot.subMchid
    || row.refundNo !== refund.refundNo
    || row.wechatRefundId !== refund.wechatRefundId
  ) reasons.push('REFUND_EVIDENCE_IDENTITY');
  return uniqueSorted(reasons);
}

function sortedArtifacts(evidences) {
  const byIdentity = new Map();
  for (const evidence of evidences) {
    const artifact = normalizedArtifact(evidence.artifact);
    if (!artifact) return { reason: 'EVIDENCE_ARTIFACT_INVALID' };
    const key = `${artifact.billDate}\n${artifact.artifactId}`;
    const existing = byIdentity.get(key);
    if (existing && existing.sha1 !== artifact.sha1) {
      return { reason: 'EVIDENCE_ARTIFACT_HASH_CONFLICT' };
    }
    byIdentity.set(key, artifact);
  }
  return {
    artifacts: [...byIdentity.values()].sort((left, right) => (
      left.billDate.localeCompare(right.billDate)
      || left.artifactId.localeCompare(right.artifactId)
    ))
  };
}

function sortRows(rows) {
  return [...rows].sort((left, right) => {
    const kind = (left.kind === 'payment' ? 0 : 1) - (right.kind === 'payment' ? 0 : 1);
    return kind
      || (left.refundNo || '').localeCompare(right.refundNo || '')
      || (left.wechatRefundId || '').localeCompare(right.wechatRefundId || '')
      || left.rowIdentityHash.localeCompare(right.rowIdentityHash);
  });
}

function pendingFinancePatch(order, reasonCodes, paymentEvidence) {
  const foreignManualReview = order.orderStatus === 'manual_review'
    && order.manualReviewReason !== 'finance_reconciliation';
  const patch = {
    orderStatus: 'manual_review',
    financeAutomationBlocked: true,
    refundFeeReconciliationStatus: 'pending',
    manualReviewReason: foreignManualReview
      ? (order.manualReviewReason || 'existing_manual_review')
      : 'finance_reconciliation',
    manualReviewReasonCodes: foreignManualReview
      ? (Array.isArray(order.manualReviewReasonCodes)
        ? order.manualReviewReasonCodes
        : [])
      : uniqueSorted(reasonCodes)
  };
  if (paymentEvidence) patch.paymentBillFeeEvidence = paymentEvidence;
  return patch;
}

function buildOrderConfirmation({
  order,
  refunds,
  paymentEvidence,
  refundEvidences,
  confirmedAtMs,
  nowMs
}) {
  const orderReasons = paymentOrderReasons(order);
  if (orderReasons.length > 0) return manual(orderReasons);
  if (
    !Array.isArray(refunds)
    || !Array.isArray(refundEvidences)
    || !Number.isSafeInteger(confirmedAtMs)
    || confirmedAtMs < 0
    || !Number.isSafeInteger(nowMs)
    || nowMs < confirmedAtMs
  ) return manual(['CONFIRMATION_INPUT_INVALID']);

  const effectivePayment = paymentEvidence || order.paymentBillFeeEvidence || null;
  const paymentReasons = storedPaymentReasons(order, effectivePayment);
  if (paymentReasons.length > 0) {
    return {
      status: 'pending',
      reasonCodes: paymentReasons,
      orderPatch: pendingFinancePatch(order, paymentReasons, null),
      refundPatches: {}
    };
  }

  if (refunds.some((value) => !value || value.status !== 'succeeded')) {
    return {
      status: 'pending',
      reasonCodes: ['REFUND_LOCAL_NOT_TERMINAL'],
      paymentEvidence: effectivePayment,
      orderPatch: pendingFinancePatch(
        order,
        ['REFUND_LOCAL_NOT_TERMINAL'],
        effectivePayment
      ),
      refundPatches: {}
    };
  }

  const incoming = new Map();
  for (const evidence of refundEvidences) {
    if (!isPlainObject(evidence) || !safeText(evidence.refundNo, 64)) {
      return manual(['REFUND_EVIDENCE_INVALID']);
    }
    if (incoming.has(evidence.refundNo)) return manual(['REFUND_EVIDENCE_DUPLICATE']);
    incoming.set(evidence.refundNo, evidence);
  }
  const refundPatches = {};
  const effectiveRefundEvidence = [];
  const successfulRefunds = refunds.filter((value) => value && value.status === 'succeeded');
  for (const localRefund of successfulRefunds) {
    const evidence = incoming.get(localRefund.refundNo) || localRefund.billFeeEvidence || null;
    const reasons = storedRefundReasons(order, localRefund, evidence);
    if (reasons.length > 0) {
      return {
        status: 'pending',
        reasonCodes: reasons,
        paymentEvidence: effectivePayment,
        orderPatch: pendingFinancePatch(order, reasons, effectivePayment),
        refundPatches
      };
    }
    effectiveRefundEvidence.push(evidence);
    if (incoming.has(localRefund.refundNo)) {
      const patch = {
        billFeeEvidence: evidence,
        billFeeEvidenceStatus: 'confirmed'
      };
      if (
        localRefund.refundCreateTime === null
        && localRefund.refundCreatedAt === null
        && localRefund.verifiedSource === 'notification'
        && typeof evidence.officialTime === 'string'
        && Number.isSafeInteger(evidence.officialCreatedAt)
      ) {
        patch.refundCreateTime = `${evidence.officialTime.replace(' ', 'T')}+08:00`;
        patch.refundCreatedAt = evidence.officialCreatedAt;
      }
      refundPatches[localRefund.refundNo] = patch;
    }
  }
  for (const refundNo of incoming.keys()) {
    if (!successfulRefunds.some((value) => value.refundNo === refundNo)) {
      return manual(['REFUND_LOCAL_NOT_TERMINAL']);
    }
  }
  const refundIdentity = new Set();
  for (const evidence of effectiveRefundEvidence) {
    const key = `${evidence.refundNo}\n${evidence.wechatRefundId}\n${evidence.row.rowIdentityHash}`;
    if (refundIdentity.has(key)) return manual(['REFUND_EVIDENCE_DUPLICATE']);
    refundIdentity.add(key);
  }

  const cumulativePayerRefundFen = successfulRefunds.reduce(
    (sum, value) => sum + (safeFen(value.payerRefundFen) ? value.payerRefundFen : Number.NaN),
    0
  );
  const cumulativeCouponRefundFen = successfulRefunds.reduce(
    (sum, value) => sum + (safeFen(value.couponRefundFen) ? value.couponRefundFen : Number.NaN),
    0
  );
  if (
    !Number.isSafeInteger(cumulativePayerRefundFen)
    || !Number.isSafeInteger(cumulativeCouponRefundFen)
    || cumulativePayerRefundFen !== order.refundedTableFeeFen
    || cumulativeCouponRefundFen !== (order.couponRefundedFen || 0)
    || order.paidTableFeeFen !== order.wechatPayerTotalFen - cumulativePayerRefundFen
  ) return manual(['ORDER_RETAINED_AMOUNT_MISMATCH']);
  const retainedCouponSubsidyFen = order.couponSubsidyFen - cumulativeCouponRefundFen;
  if (
    !safeFen(retainedCouponSubsidyFen)
    || (order.retainedCouponSubsidyFen || 0) !== retainedCouponSubsidyFen
  ) return manual(['ORDER_RETAINED_COUPON_MISMATCH']);

  const allEvidence = [effectivePayment, ...effectiveRefundEvidence];
  const artifactResult = sortedArtifacts(allEvidence);
  if (artifactResult.reason) return manual([artifactResult.reason]);
  const rows = sortRows(allEvidence.map((value) => value.row));
  if (rows.length === 0 || rows[0].kind !== 'payment' || rows.filter((row) => row.kind === 'payment').length !== 1) {
    return manual(['PAYMENT_EVIDENCE_CARDINALITY']);
  }
  const channelFeeFen = rows.reduce((sum, row) => sum + row.feeFen, 0);
  if (!safeFen(channelFeeFen)) return manual(['CHANNEL_FEE_NEGATIVE']);
  const settlement = calculateSettlement(order.paidTableFeeFen, null);
  const actualPlatformNetFen = settlement.totalCostFen - channelFeeFen;
  const platformNetFen = Math.max(0, actualPlatformNetFen);
  const splitAdjustmentRefunds = successfulRefunds.filter((value) => (
    value.splitReturnBasis === 'provisional_cumulative_requested_gross'
    || ['pending', 'confirmed', 'manual_review'].includes(
      value.splitReturnAdjustmentStatus
    )
  ));
  const hasSplitReturnAdjustment = order.splitPlatformNetFen !== undefined
    || splitAdjustmentRefunds.length > 0;
  let splitReturnAdjustment = null;
  if (hasSplitReturnAdjustment) {
    if (
      !safeFen(order.splitPlatformNetFen)
      || !safeFen(order.splitReturnedFen)
      || order.splitReturnedFen > order.splitPlatformNetFen
    ) return manual(['SPLIT_RETURN_ADJUSTMENT_SNAPSHOT']);
    if (order.splitPlatformNetFen === 0) {
      splitReturnAdjustment = {
        expectedCumulativeSplitReturnedFen: 0,
        actualCumulativeSplitReturnedFen: 0,
        splitReturnAdjustmentDeltaFen: 0,
        splitReturnAdjustmentStatus: 'not_required'
      };
    } else {
      if (splitAdjustmentRefunds.length === 0) {
        return manual(['SPLIT_RETURN_ADJUSTMENT_SNAPSHOT']);
      }
      const expectedCumulativeSplitReturnedFen = Math.min(
        order.splitPlatformNetFen,
        Math.max(0, order.splitPlatformNetFen - platformNetFen)
      );
      const splitReturnAdjustmentDeltaFen = order.splitReturnedFen
        - expectedCumulativeSplitReturnedFen;
      if (!Number.isSafeInteger(splitReturnAdjustmentDeltaFen)) {
        return manual(['SPLIT_RETURN_ADJUSTMENT_SNAPSHOT']);
      }
      splitReturnAdjustment = {
        expectedCumulativeSplitReturnedFen,
        actualCumulativeSplitReturnedFen: order.splitReturnedFen,
        splitReturnAdjustmentDeltaFen,
        splitReturnAdjustmentStatus: splitReturnAdjustmentDeltaFen === 0
          ? 'confirmed'
          : 'manual_review'
      };
      for (const localRefund of splitAdjustmentRefunds) {
        refundPatches[localRefund.refundNo] = {
          ...(refundPatches[localRefund.refundNo] || {}),
          splitReturnAdjustmentStatus:
            splitReturnAdjustment.splitReturnAdjustmentStatus
        };
      }
    }
  }
  const paymentBillDate = effectivePayment.artifact.billDate;
  const latestBillDate = artifactResult.artifacts[artifactResult.artifacts.length - 1].billDate;
  const availableAtMs = chinaDateBounds(latestBillDate).endMs + 10 * 60 * 60 * 1000;
  if (confirmedAtMs < availableAtMs) return manual(['CONFIRMATION_BEFORE_BILL_WINDOW']);

  const hashInput = {
    source: 'wechat_trade_bill',
    policyVersion: order.policyVersion,
    orderId: order.orderId,
    outTradeNo: order.outTradeNo,
    transactionId: order.wechatTransactionId,
    subMchid: order.paymentProfileSnapshot.subMchid,
    paymentBillDate,
    wechatOrderTotalFen: order.wechatOrderTotalFen,
    wechatPayerTotalFen: order.wechatPayerTotalFen,
    couponSubsidyFen: order.couponSubsidyFen,
    retainedPaidTableFeeFen: order.paidTableFeeFen,
    retainedCouponSubsidyFen,
    totalCostFen: settlement.totalCostFen,
    channelFeeFen,
    platformNetFen,
    actualPlatformNetFen,
    ...(splitReturnAdjustment || {}),
    artifacts: artifactResult.artifacts,
    rows
  };
  const evidenceHash = stableHash(hashInput);
  const eventId = financialEventId(
    'channel_fee_confirmed',
    `${order.orderId}:${evidenceHash}`
  );
  const eventDocument = {
    eventType: 'channel_fee_confirmed',
    businessType: 'table_order',
    businessId: order.orderId,
    orderId: order.orderId,
    transactionId: order.wechatTransactionId,
    source: 'wechat_trade_bill',
    paymentBillDate,
    artifacts: artifactResult.artifacts,
    rows,
    retainedPaidTableFeeFen: order.paidTableFeeFen,
    retainedCouponSubsidyFen,
    totalCostFen: settlement.totalCostFen,
    channelFeeFen,
    platformNetFen,
    actualPlatformNetFen,
    ...(splitReturnAdjustment || {}),
    evidenceHash,
    confirmedAtMs,
    createdAt: null
  };
  const blockedReasons = [];
  const foreignManualReview = order.orderStatus === 'manual_review'
    && order.manualReviewReason !== 'finance_reconciliation';
  if (foreignManualReview) blockedReasons.push('NON_RECONCILIATION_MANUAL_REVIEW');
  if (
    effectiveRefundEvidence.some((value) => value.rechargeCouponRefundFen !== 0)
  ) blockedReasons.push('COUPON_ALLOCATION_UNPILOTED');
  if (
    BigInt(channelFeeFen) * 10000n
      > BigInt(order.paidTableFeeFen) * 500n
  ) blockedReasons.push('CHANNEL_FEE_RATE_ABOVE_POLICY');
  if (actualPlatformNetFen < 0) blockedReasons.push('CHANNEL_FEE_EXCEEDS_TOTAL_COST');
  if (
    splitReturnAdjustment
    && splitReturnAdjustment.splitReturnAdjustmentStatus === 'manual_review'
  ) blockedReasons.push('SPLIT_RETURN_ADJUSTMENT_MISMATCH');
  const blocked = blockedReasons.length > 0;
  const existingManualReasonCodes = Array.isArray(order.manualReviewReasonCodes)
    ? uniqueSorted(order.manualReviewReasonCodes.filter((value) => safeText(value, 128)))
    : [];
  return {
    status: blocked ? 'blocked' : 'confirmed',
    reasonCodes: uniqueSorted(blockedReasons),
    paymentEvidence: effectivePayment,
    refundPatches,
    eventId,
    eventDocument,
    orderPatch: {
      orderStatus: blocked ? 'manual_review' : 'complete',
      totalCostFen: settlement.totalCostFen,
      channelFeeFen,
      platformNetFen,
      channelFeeEvidenceHash: evidenceHash,
      paymentBillFeeEvidence: effectivePayment,
      refundFeeReconciliationStatus: 'confirmed',
      financeAutomationBlocked: blocked,
      ...(splitReturnAdjustment || {}),
      manualReviewReason: foreignManualReview
        ? (order.manualReviewReason || 'existing_manual_review')
        : (blocked ? 'finance_reconciliation' : null),
      manualReviewReasonCodes: foreignManualReview
        ? existingManualReasonCodes
        : uniqueSorted(blockedReasons)
    }
  };
}

module.exports = {
  ARTIFACT_LEASE_MS,
  POLICY_VERSION,
  RUN_LEASE_MS,
  TRADE_BILL_AMOUNT_HEADERS,
  TRADE_BILL_HEADERS,
  artifactDescriptor,
  buildOrderConfirmation,
  chinaDateBounds,
  localRefundNosFromTradeBill,
  matchPaymentEvidence,
  matchRefundEvidence,
  normalizeBillTimeToChinaSecond,
  normalizeRfc3339ToChinaSecond,
  orderSnapshotToken,
  parseTradeBill,
  previousChinaBillDate,
  runIdForBillDate,
  stableHash
};
