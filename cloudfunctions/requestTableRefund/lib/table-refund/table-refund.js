'use strict';

const crypto = require('crypto');
const { calculateSettlement } = require('../table-finance/money');

const REFUND_CLAIM_LEASE_MS = 120_000;
const SPLIT_RETURN_DESCRIPTION = 'CueTrace table refund';
const ACTIVE_REFUND_STATUSES = Object.freeze(['returning', 'processing']);
const TERMINAL_REFUND_STATUSES = Object.freeze(['succeeded', 'manual_review']);

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function safeText(value, maximumBytes) {
  return typeof value === 'string'
    && value.length > 0
    && value === value.trim()
    && Buffer.byteLength(value, 'utf8') <= maximumBytes
    && !/[\x00-\x1f\x7f]/.test(value);
}

function safeFen(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function officialTime(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:(Z)|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] || '').padEnd(3, '0') || '0');
  const offsetHour = match[8] ? 0 : Number(match[10]);
  const offsetMinute = match[8] ? 0 : Number(match[11]);
  if (
    year < 1
    || month < 1
    || month > 12
    || day < 1
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 14
    || offsetMinute > 59
    || (offsetHour === 14 && offsetMinute !== 0)
  ) {
    return null;
  }
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, millisecond);
  if (
    local.getUTCFullYear() !== year
    || local.getUTCMonth() !== month - 1
    || local.getUTCDate() !== day
    || local.getUTCHours() !== hour
    || local.getUTCMinutes() !== minute
    || local.getUTCSeconds() !== second
    || local.getUTCMilliseconds() !== millisecond
  ) {
    return null;
  }
  const offsetSign = match[9] === '-' ? -1 : 1;
  const offsetMs = offsetSign * (offsetHour * 60 + offsetMinute) * 60_000;
  const parsed = local.getTime() - offsetMs;
  const roundTrip = new Date(parsed + offsetMs);
  return Number.isSafeInteger(parsed)
    && parsed >= 0
    && roundTrip.getUTCFullYear() === year
    && roundTrip.getUTCMonth() === month - 1
    && roundTrip.getUTCDate() === day
    && roundTrip.getUTCHours() === hour
    && roundTrip.getUTCMinutes() === minute
    && roundTrip.getUTCSeconds() === second
    && roundTrip.getUTCMilliseconds() === millisecond
    ? parsed
    : null;
}

function persistedTimeMs(value) {
  if (safeFen(value)) return value;
  if (value instanceof Date) {
    const milliseconds = value.getTime();
    return Number.isSafeInteger(milliseconds) && milliseconds >= 0
      ? milliseconds
      : null;
  }
  return typeof value === 'string' ? officialTime(value) : null;
}

function digest(namespace, parts, length) {
  const hash = crypto.createHash('sha256');
  for (const part of [namespace, ...parts]) {
    if (typeof part !== 'string' || part.length === 0) {
      throw new TypeError('deterministic refund identifier input is invalid');
    }
    const bytes = Buffer.from(part, 'utf8');
    hash.update(`${bytes.length}:`).update(bytes);
  }
  return hash.digest('hex').slice(0, length);
}

function splitReturnNoForRefund(refundNo) {
  return `return_${digest('split-return', [refundNo], 57)}`;
}

function refundAttemptId(refundNo) {
  return `refund_attempt_${digest('refund-claim', [refundNo], 42)}`;
}

function exactRefundCommand(event) {
  const names = ['orderId', 'refundFen', 'reason', 'idempotencyKey'];
  return isPlainObject(event)
    && Object.keys(event).length === names.length
    && names.every((name) => hasOwn(event, name))
    && safeText(event.orderId, 128)
    && Number.isSafeInteger(event.refundFen)
    && event.refundFen > 0
    && safeText(event.reason, 80)
    && /^[A-Za-z0-9_-]{8,64}$/.test(event.idempotencyKey);
}

function exactNotificationRefund(remote, expectedStatus) {
  const commonKeys = [
    'sp_mchid',
    'sub_mchid',
    'transaction_id',
    'out_trade_no',
    'refund_id',
    'out_refund_no',
    'refund_status',
    'user_received_account',
    'amount'
  ];
  const keys = expectedStatus === 'SUCCESS'
    ? commonKeys.concat('success_time')
    : commonKeys;
  const amountKeys = ['total', 'refund', 'payer_total', 'payer_refund'];
  return ['SUCCESS', 'CLOSED', 'ABNORMAL'].includes(expectedStatus)
    && isPlainObject(remote)
    && Object.keys(remote).length === keys.length
    && keys.every((key) => hasOwn(remote, key))
    && remote.refund_status === expectedStatus
    && safeText(remote.sp_mchid, 32)
    && safeText(remote.sub_mchid, 32)
    && safeText(remote.transaction_id, 32)
    && safeText(remote.out_trade_no, 32)
    && safeText(remote.refund_id, 32)
    && safeText(remote.out_refund_no, 64)
    && safeText(remote.user_received_account, 128)
    && (expectedStatus !== 'SUCCESS' || officialTime(remote.success_time) !== null)
    && isPlainObject(remote.amount)
    && Object.keys(remote.amount).length === amountKeys.length
    && amountKeys.every((key) => hasOwn(remote.amount, key))
    && amountKeys.every((key) => safeFen(remote.amount[key]));
}

function validPaymentSnapshot(snapshot) {
  return isPlainObject(snapshot)
    && safeText(snapshot.spMchid, 32)
    && /^[0-9]{8,32}$/.test(snapshot.spMchid)
    && safeText(snapshot.subMchid, 32)
    && /^[0-9]{8,32}$/.test(snapshot.subMchid);
}

function refundCounters(order) {
  if (!isPlainObject(order)) return null;
  const grossRefundedFen = order.grossRefundedFen === undefined
    ? 0
    : order.grossRefundedFen;
  const couponRefundedFen = order.couponRefundedFen === undefined
    ? 0
    : order.couponRefundedFen;
  const requestedRefundFen = order.requestedRefundFen === undefined
    ? grossRefundedFen
    : order.requestedRefundFen;
  const splitReturnedFen = order.splitReturnedFen === undefined
    ? 0
    : order.splitReturnedFen;
  const values = {
    grossRefundedFen,
    payerRefundedFen: order.refundedTableFeeFen,
    couponRefundedFen,
    requestedRefundFen,
    splitReturnedFen
  };
  if (Object.values(values).some((value) => !safeFen(value))) return null;
  const verifiedRefundFen = values.payerRefundedFen
    + values.couponRefundedFen;
  if (
    !Number.isSafeInteger(verifiedRefundFen)
    || values.grossRefundedFen !== verifiedRefundFen
  ) return null;
  return values;
}

function validCompletedSplitSnapshot(order) {
  const claim = order.splitClaim;
  const splitFen = platformSplitFen(order);
  const claimCompletedAt = isPlainObject(claim)
    ? persistedTimeMs(claim.completedAt)
    : null;
  const splitCompletedAt = persistedTimeMs(order.splitCompletedAt);
  return splitFen !== null
    && isPlainObject(claim)
    && safeText(claim.attemptId, 64)
    && claim.status === 'succeeded'
    && safeFen(claim.claimedAt)
    && safeFen(claim.leaseExpiresAt)
    && claimCompletedAt !== null
    && splitCompletedAt === claimCompletedAt
    && safeText(order.splitNo, 64)
    && safeText(order.unfreezeNo, 64)
    && safeText(order.wechatUnfreezeOrderId, 64)
    && (splitFen === 0
      ? order.wechatSplitOrderId === null && order.wechatSplitDetailId === null
      : safeText(order.wechatSplitOrderId, 64)
        && safeText(order.wechatSplitDetailId, 64));
}

function validRefundOrder(order, ownerOpenid) {
  const counters = refundCounters(order);
  if (
    !isPlainObject(order)
    || order._id !== order.orderId
    || order.schemaVersion !== 2
    || order._openid !== ownerOpenid
    || order.shopId !== ownerOpenid
    || order.orderStatus !== 'complete'
    || !['paid', 'partially_refunded'].includes(order.paymentStatus)
    || !['pending', 'succeeded', 'reversed'].includes(order.splitStatus)
    || !safeText(order.outTradeNo, 32)
    || !safeText(order.wechatTransactionId, 32)
    || !validPaymentSnapshot(order.paymentProfileSnapshot)
    || !safeFen(order.wechatOrderTotalFen)
    || order.wechatOrderTotalFen <= 0
    || !safeFen(order.wechatPayerTotalFen)
    || order.wechatPayerTotalFen > order.wechatOrderTotalFen
    || !safeFen(order.couponSubsidyFen)
    || order.couponSubsidyFen !== order.wechatOrderTotalFen - order.wechatPayerTotalFen
    || !safeFen(order.paidTableFeeFen)
    || !safeFen(order.totalCostFen)
    || !safeFen(order.shopNetFen)
    || !safeFen(order.shopSettlementFen)
    || !safeFen(order.reversedTotalCostFen)
    || !counters
  ) {
    return false;
  }
  if (
    counters.grossRefundedFen > order.wechatOrderTotalFen
    || counters.payerRefundedFen > order.wechatPayerTotalFen
    || counters.couponRefundedFen > order.couponSubsidyFen
    || counters.requestedRefundFen < counters.grossRefundedFen
    || counters.requestedRefundFen > order.wechatOrderTotalFen
    || order.paidTableFeeFen !== order.wechatPayerTotalFen - counters.payerRefundedFen
  ) {
    return false;
  }
  if (
    order.paymentStatus === 'partially_refunded'
    && (
      !safeFen(order.retainedCouponSubsidyFen)
      || order.retainedCouponSubsidyFen
        !== order.couponSubsidyFen - counters.couponRefundedFen
    )
  ) {
    return false;
  }
  if (
    ['succeeded', 'reversed'].includes(order.splitStatus)
    && !validCompletedSplitSnapshot(order)
  ) {
    return false;
  }
  const settlement = calculateSettlement(order.paidTableFeeFen, null);
  if (
    order.totalCostFen !== settlement.totalCostFen
    || order.shopNetFen !== settlement.shopNetFen
    || order.shopSettlementFen !== settlement.shopNetFen
      + order.couponSubsidyFen - counters.couponRefundedFen
  ) {
    return false;
  }
  if (order.refundClaim !== null && order.refundClaim !== undefined) {
    const claim = order.refundClaim;
    if (
      !isPlainObject(claim)
      || !safeText(claim.refundNo, 64)
      || !safeText(claim.attemptId, 64)
      || !ACTIVE_REFUND_STATUSES.concat(TERMINAL_REFUND_STATUSES).includes(claim.status)
      || !safeFen(claim.claimedAt)
      || !safeFen(claim.requestedAt)
      || !safeFen(claim.leaseExpiresAt)
      || (claim.completedAt !== null && !safeFen(claim.completedAt))
    ) {
      return false;
    }
  }
  return true;
}

function platformSplitFen(order) {
  const value = order.splitPlatformNetFen === undefined
    ? order.platformNetFen
    : order.splitPlatformNetFen;
  return safeFen(value) ? value : null;
}

function provisionalSplitReturnFen(order, nextRequestedRefundFen) {
  const counters = refundCounters(order);
  const splitFen = platformSplitFen(order);
  if (
    !counters
    || splitFen === null
    || !safeFen(nextRequestedRefundFen)
    || nextRequestedRefundFen > order.wechatOrderTotalFen
    || counters.splitReturnedFen > splitFen
  ) {
    throw new TypeError('split return snapshot is invalid');
  }
  if (splitFen === 0 || counters.splitReturnedFen === splitFen) return 0;
  let target;
  if (nextRequestedRefundFen === order.wechatOrderTotalFen) {
    target = splitFen;
  } else {
    const provisionalPayerRefundFen = Math.min(
      order.wechatPayerTotalFen,
      nextRequestedRefundFen
    );
    const retainedPayerFen = order.wechatPayerTotalFen - provisionalPayerRefundFen;
    const originalCostFen = calculateSettlement(order.wechatPayerTotalFen, null).totalCostFen;
    const retainedCostFen = calculateSettlement(retainedPayerFen, null).totalCostFen;
    target = Math.min(splitFen, originalCostFen - retainedCostFen);
  }
  return Math.max(0, target - counters.splitReturnedFen);
}

function buildSplitReturnBody({ order, refund }) {
  if (
    !isPlainObject(order)
    || !isPlainObject(refund)
    || !validPaymentSnapshot(order.paymentProfileSnapshot)
    || !safeText(order.splitNo, 64)
    || !safeText(refund.splitReturnNo, 64)
    || !Number.isSafeInteger(refund.splitReturnFen)
    || refund.splitReturnFen <= 0
  ) {
    throw new TypeError('split return request snapshot is invalid');
  }
  return {
    sub_mchid: order.paymentProfileSnapshot.subMchid,
    out_order_no: order.splitNo,
    out_return_no: refund.splitReturnNo,
    return_mchid: order.paymentProfileSnapshot.spMchid,
    amount: refund.splitReturnFen,
    description: SPLIT_RETURN_DESCRIPTION
  };
}

function buildPartnerRefundBody({ order, refund, config }) {
  if (
    !isPlainObject(order)
    || !isPlainObject(refund)
    || !isPlainObject(config)
    || !validPaymentSnapshot(order.paymentProfileSnapshot)
    || !safeText(order.wechatTransactionId, 32)
    || !safeText(refund.refundNo, 64)
    || !safeText(refund.reason, 80)
    || !Number.isSafeInteger(refund.refundFen)
    || refund.refundFen <= 0
    || !safeFen(order.wechatOrderTotalFen)
    || typeof config.tableRefundNotifyUrl !== 'string'
    || !/^https:\/\/[^\s]+$/.test(config.tableRefundNotifyUrl)
  ) {
    throw new TypeError('partner refund request snapshot is invalid');
  }
  return {
    sub_mchid: order.paymentProfileSnapshot.subMchid,
    transaction_id: order.wechatTransactionId,
    out_refund_no: refund.refundNo,
    reason: refund.reason,
    notify_url: config.tableRefundNotifyUrl,
    amount: {
      refund: refund.refundFen,
      total: order.wechatOrderTotalFen,
      currency: 'CNY'
    }
  };
}

function commonRefundReasons(remote, order, refund) {
  const reasons = [];
  if (!isPlainObject(remote)) return ['REFUND_SHAPE'];
  if (
    !isPlainObject(order.paymentProfileSnapshot)
    || refund.subMchid !== order.paymentProfileSnapshot.subMchid
  ) reasons.push('SUB_MCHID');
  if (remote.out_refund_no !== refund.refundNo) reasons.push('OUT_REFUND_NO');
  if (remote.transaction_id !== order.wechatTransactionId) reasons.push('TRANSACTION_ID');
  if (remote.out_trade_no !== order.outTradeNo) reasons.push('OUT_TRADE_NO');
  if (!safeText(remote.refund_id, 32)) reasons.push('REFUND_ID');
  if (
    safeText(refund.wechatRefundId, 32)
    && remote.refund_id !== refund.wechatRefundId
  ) {
    reasons.push('REFUND_ID');
  }
  const amount = remote.amount;
  if (!isPlainObject(amount)) return reasons.concat('AMOUNT');
  if (amount.total !== order.wechatOrderTotalFen) reasons.push('AMOUNT_TOTAL');
  if (amount.refund !== refund.refundFen) reasons.push('AMOUNT_REFUND');
  if (amount.payer_total !== order.wechatPayerTotalFen) reasons.push('AMOUNT_PAYER_TOTAL');
  if (
    !safeFen(amount.payer_refund)
    || amount.payer_refund > amount.refund
    || (order.couponSubsidyFen === 0 && amount.payer_refund !== amount.refund)
    || refund.cumulativePayerBeforeFen + amount.payer_refund > order.wechatPayerTotalFen
  ) {
    reasons.push('AMOUNT_PAYER_REFUND');
  }
  return reasons;
}

function validateQueryRefund(remote, order, refund, requireSuccess = false) {
  const reasons = commonRefundReasons(remote, order, refund);
  if (!isPlainObject(remote)) return { reasons, status: null, normalized: null };
  if (!['SUCCESS', 'CLOSED', 'PROCESSING', 'ABNORMAL'].includes(remote.status)) {
    reasons.push('REFUND_STATUS');
  }
  if (requireSuccess && remote.status !== 'SUCCESS') reasons.push('REFUND_NOT_SUCCESS');
  const refundCreatedAt = officialTime(remote.create_time);
  if (refundCreatedAt === null) reasons.push('CREATE_TIME');
  const amount = remote.amount;
  if (isPlainObject(amount)) {
    if (amount.currency !== 'CNY') reasons.push('AMOUNT_CURRENCY');
    for (const name of ['settlement_refund', 'settlement_total', 'discount_refund']) {
      if (!safeFen(amount[name])) reasons.push(`AMOUNT_${name.toUpperCase()}`);
    }
    if (
      safeFen(amount.discount_refund)
      && safeFen(amount.refund)
      && safeFen(amount.payer_refund)
      && amount.discount_refund !== amount.refund - amount.payer_refund
    ) {
      reasons.push('AMOUNT_DISCOUNT_REFUND');
    }
    if (hasOwn(amount, 'refund_fee') && !safeFen(amount.refund_fee)) {
      reasons.push('AMOUNT_REFUND_FEE');
    }
  }
  const succeededAt = remote.status === 'SUCCESS'
    ? officialTime(remote.success_time)
    : null;
  if (remote.status === 'SUCCESS' && succeededAt === null) {
    reasons.push('SUCCESS_TIME');
  }
  return {
    reasons: [...new Set(reasons)].sort(),
    status: remote.status,
    refundCreateTime: remote.create_time,
    refundCreatedAt,
    normalized: reasons.length === 0 && remote.status === 'SUCCESS'
      ? {
        refundNo: remote.out_refund_no,
        refundId: remote.refund_id,
        transactionId: remote.transaction_id,
        outTradeNo: remote.out_trade_no,
        successTime: remote.success_time,
        succeededAt,
        refundCreateTime: remote.create_time,
        refundCreatedAt,
        totalFen: amount.total,
        grossRefundFen: amount.refund,
        payerTotalFen: amount.payer_total,
        payerRefundFen: amount.payer_refund,
        couponRefundFen: amount.refund - amount.payer_refund,
        settlementRefundFen: amount.settlement_refund,
        settlementTotalFen: amount.settlement_total,
        discountRefundFen: amount.discount_refund,
        refundFeeFen: hasOwn(amount, 'refund_fee') ? amount.refund_fee : null
      }
      : null
  };
}

function validateNotificationRefund(remote, order, refund, expectedStatus = 'SUCCESS') {
  const reasons = commonRefundReasons(remote, order, refund);
  if (!isPlainObject(remote)) return { reasons, normalized: null };
  if (remote.sp_mchid !== order.paymentProfileSnapshot.spMchid) reasons.push('SP_MCHID');
  if (remote.sub_mchid !== order.paymentProfileSnapshot.subMchid) reasons.push('SUB_MCHID');
  if (remote.refund_status !== expectedStatus) reasons.push('REFUND_STATUS');
  const succeededAt = expectedStatus === 'SUCCESS'
    ? officialTime(remote.success_time)
    : null;
  if (expectedStatus === 'SUCCESS' && succeededAt === null) reasons.push('SUCCESS_TIME');
  const amount = remote.amount;
  return {
    reasons: [...new Set(reasons)].sort(),
    normalized: reasons.length === 0 && expectedStatus === 'SUCCESS'
      ? {
        refundNo: remote.out_refund_no,
        refundId: remote.refund_id,
        transactionId: remote.transaction_id,
        outTradeNo: remote.out_trade_no,
        successTime: remote.success_time,
        succeededAt,
        refundCreateTime: null,
        refundCreatedAt: null,
        totalFen: amount.total,
        grossRefundFen: amount.refund,
        payerTotalFen: amount.payer_total,
        payerRefundFen: amount.payer_refund,
        couponRefundFen: amount.refund - amount.payer_refund,
        settlementRefundFen: null,
        settlementTotalFen: null,
        discountRefundFen: null,
        refundFeeFen: null
      }
      : null
  };
}

function validateSplitReturn(remote, order, refund) {
  const reasons = [];
  if (!isPlainObject(remote)) return { reasons: ['SPLIT_RETURN_SHAPE'], result: null };
  if (remote.sub_mchid !== order.paymentProfileSnapshot.subMchid) reasons.push('SUB_MCHID');
  if (remote.order_id !== order.wechatSplitOrderId) reasons.push('SPLIT_ORDER_ID');
  if (remote.out_order_no !== order.splitNo) reasons.push('SPLIT_NO');
  if (remote.out_return_no !== refund.splitReturnNo) reasons.push('SPLIT_RETURN_NO');
  if (remote.return_mchid !== order.paymentProfileSnapshot.spMchid) reasons.push('RETURN_MCHID');
  if (remote.amount !== refund.splitReturnFen) reasons.push('RETURN_AMOUNT');
  if (remote.description !== SPLIT_RETURN_DESCRIPTION) reasons.push('RETURN_DESCRIPTION');
  if (!['PROCESSING', 'SUCCESS', 'FAILED'].includes(remote.result)) reasons.push('RETURN_RESULT');
  if (!safeText(remote.return_id, 64)) reasons.push('RETURN_ID');
  if (officialTime(remote.create_time) === null) reasons.push('RETURN_CREATE_TIME');
  if (remote.result === 'SUCCESS' && officialTime(remote.finish_time) === null) {
    reasons.push('RETURN_FINISH_TIME');
  }
  return { reasons: [...new Set(reasons)].sort(), result: remote.result };
}

module.exports = {
  ACTIVE_REFUND_STATUSES,
  REFUND_CLAIM_LEASE_MS,
  SPLIT_RETURN_DESCRIPTION,
  buildPartnerRefundBody,
  buildSplitReturnBody,
  exactRefundCommand,
  exactNotificationRefund,
  officialTime,
  platformSplitFen,
  provisionalSplitReturnFen,
  refundAttemptId,
  refundCounters,
  safeText,
  splitReturnNoForRefund,
  validateNotificationRefund,
  validateQueryRefund,
  validateSplitReturn,
  validRefundOrder
};
