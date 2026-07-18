'use strict';

const { calculateSettlement } = require('../table-finance/money');
const { financialEventId } = require('../table-finance/state');
const {
  refundCounters,
  safeText,
  validateNotificationRefund,
  validateQueryRefund
} = require('./table-refund');

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizedReasonCodes(reasons) {
  return [...new Set(Array.isArray(reasons) ? reasons : ['REFUND_MISMATCH'])]
    .filter((reason) => typeof reason === 'string' && reason.length > 0)
    .sort();
}

function mismatchEventMatches(event, refund, reasonCodes) {
  return isPlainObject(event)
    && event.eventType === 'refund_mismatch'
    && event.businessType === 'table_refund'
    && event.businessId === refund.refundNo
    && event.orderId === refund.orderId
    && event.refundNo === refund.refundNo
    && event.redacted === true
    && Array.isArray(event.reasonCodes)
    && JSON.stringify(event.reasonCodes) === JSON.stringify(reasonCodes);
}

async function recordMismatchInTransaction(store, tx, order, refund, reasons) {
  const reasonCodes = normalizedReasonCodes(reasons);
  const eventId = financialEventId('refund_mismatch', refund.refundNo);
  const existing = await tx.getFinancialEvent(eventId);
  if (!existing) {
    await tx.setFinancialEvent(eventId, {
      eventType: 'refund_mismatch',
      businessType: 'table_refund',
      businessId: refund.refundNo,
      orderId: refund.orderId,
      refundNo: refund.refundNo,
      reasonCodes,
      redacted: true,
      createdAt: store.serverDate()
    });
  }
  const effectiveReasons = existing
    && !mismatchEventMatches(existing, refund, reasonCodes)
    ? ['EXISTING_REFUND_MISMATCH_CONFLICT']
    : reasonCodes;
  const orderUpdate = {
    orderStatus: 'manual_review',
    manualReviewReason: 'refund_mismatch',
    manualReviewReasonCodes: effectiveReasons,
    updatedAt: store.serverDate()
  };
  if (
    isPlainObject(order.refundClaim)
    && order.refundClaim.refundNo === refund.refundNo
    && refund.status !== 'succeeded'
  ) {
    orderUpdate.refundClaim = {
      ...order.refundClaim,
      status: 'manual_review',
      completedAt: order.refundClaim.completedAt || order.refundClaim.claimedAt
    };
  }
  await tx.updateOrder(order.orderId, orderUpdate);
  const refundUpdate = {
    manualReviewReasonCodes: effectiveReasons,
    updatedAt: store.serverDate()
  };
  if (refund.status !== 'succeeded') {
    refundUpdate.status = 'manual_review';
    refundUpdate.refundClaim = {
      ...refund.refundClaim,
      status: 'manual_review',
      completedAt: refund.refundClaim.completedAt || refund.refundClaim.claimedAt
    };
  }
  await tx.updateRefund(refund.refundNo, refundUpdate);
  return { status: 'mismatch', orderId: order.orderId, refundNo: refund.refundNo };
}

async function markRefundManualReview({ store, refundNo, reasons }) {
  if (!store || !safeText(refundNo, 64)) {
    throw new TypeError('refund manual-review input is invalid');
  }
  return store.runTransaction(async (tx) => {
    const refund = await tx.getRefund(refundNo);
    if (!refund || refund._id !== refundNo || refund.refundNo !== refundNo) {
      return { status: 'unknown' };
    }
    const order = await tx.getOrder(refund.orderId);
    if (!order || order._id !== refund.orderId) return { status: 'unknown' };
    return recordMismatchInTransaction(store, tx, order, refund, reasons);
  });
}

async function applyTerminalRefundNotification({ store, refund, status }) {
  if (
    !store
    || !isPlainObject(refund)
    || !['CLOSED', 'ABNORMAL'].includes(status)
    || !safeText(refund.out_refund_no, 64)
  ) {
    throw new TypeError('terminal refund notification input is invalid');
  }
  return store.runTransaction(async (tx) => {
    const localRefund = await tx.getRefund(refund.out_refund_no);
    if (!localRefund || localRefund._id !== refund.out_refund_no) {
      return { status: 'unknown' };
    }
    const order = await tx.getOrder(localRefund.orderId);
    if (!order || order._id !== localRefund.orderId) return { status: 'unknown' };
    const validation = validateNotificationRefund(
      refund,
      order,
      localRefund,
      status
    );
    return recordMismatchInTransaction(
      store,
      tx,
      order,
      localRefund,
      validation.reasons.length > 0
        ? validation.reasons
        : [`REFUND_${status}`]
    );
  });
}

function successEventMatches(event, refund, normalized) {
  const cumulativeGrossRefundFen = refund.cumulativeGrossBeforeFen
    + normalized.grossRefundFen;
  const cumulativePayerRefundFen = refund.cumulativePayerBeforeFen
    + normalized.payerRefundFen;
  const cumulativeCouponRefundFen = refund.cumulativeCouponBeforeFen
    + normalized.couponRefundFen;
  return isPlainObject(event)
    && event.eventType === 'refund_succeeded'
    && event.businessType === 'table_refund'
    && event.businessId === refund.refundNo
    && event.orderId === refund.orderId
    && event.refundNo === refund.refundNo
    && event.refundId === normalized.refundId
    && event.transactionId === normalized.transactionId
    && event.outTradeNo === normalized.outTradeNo
    && event.successTime === normalized.successTime
    && event.grossRefundFen === normalized.grossRefundFen
    && event.payerRefundFen === normalized.payerRefundFen
    && event.couponRefundFen === normalized.couponRefundFen
    && event.cumulativeGrossRefundFen === cumulativeGrossRefundFen
    && event.cumulativePayerRefundFen === cumulativePayerRefundFen
    && event.cumulativeCouponRefundFen === cumulativeCouponRefundFen
    && event.splitReturnNo === refund.splitReturnNo
    && event.splitReturnFen === refund.splitReturnFen;
}

function successSnapshotReasons(order, refund, normalized) {
  const reasons = [];
  const counters = refundCounters(order);
  if (!counters) return ['ORDER_REFUND_COUNTERS'];
  if (refund.status !== 'processing') reasons.push('REFUND_LOCAL_STATUS');
  if (
    !isPlainObject(order.refundClaim)
    || order.refundClaim.refundNo !== refund.refundNo
    || order.refundClaim.attemptId !== refund.refundClaim.attemptId
    || order.refundClaim.status !== 'processing'
  ) {
    reasons.push('REFUND_CLAIM');
  }
  if (counters.grossRefundedFen !== refund.cumulativeGrossBeforeFen) {
    reasons.push('CUMULATIVE_GROSS_BEFORE');
  }
  if (counters.payerRefundedFen !== refund.cumulativePayerBeforeFen) {
    reasons.push('CUMULATIVE_PAYER_BEFORE');
  }
  if (counters.couponRefundedFen !== refund.cumulativeCouponBeforeFen) {
    reasons.push('CUMULATIVE_COUPON_BEFORE');
  }
  if (
    counters.requestedRefundFen
    !== refund.cumulativeRequestedBeforeFen + refund.refundFen
  ) {
    reasons.push('CUMULATIVE_REQUESTED');
  }
  if (
    counters.splitReturnedFen
    !== refund.cumulativeSplitReturnedBeforeFen + refund.splitReturnFen
  ) {
    reasons.push('CUMULATIVE_SPLIT_RETURN');
  }
  const nextGross = refund.cumulativeGrossBeforeFen + normalized.grossRefundFen;
  const nextPayer = refund.cumulativePayerBeforeFen + normalized.payerRefundFen;
  const nextCoupon = refund.cumulativeCouponBeforeFen + normalized.couponRefundFen;
  if (nextGross > order.wechatOrderTotalFen) reasons.push('CUMULATIVE_GROSS_EXCEEDED');
  if (nextPayer > order.wechatPayerTotalFen) reasons.push('CUMULATIVE_PAYER_EXCEEDED');
  if (nextCoupon > order.couponSubsidyFen) reasons.push('CUMULATIVE_COUPON_EXCEEDED');
  return [...new Set(reasons)].sort();
}

async function applyVerifiedRefund({ store, remoteRefund, source }) {
  if (
    !store
    || !isPlainObject(remoteRefund)
    || !['query', 'notification'].includes(source)
  ) {
    throw new TypeError('verified refund transition input is invalid');
  }
  const refundNo = remoteRefund.out_refund_no;
  if (!safeText(refundNo, 64)) return { status: 'unknown' };

  return store.runTransaction(async (tx) => {
    const refund = await tx.getRefund(refundNo);
    if (!refund || refund._id !== refundNo || refund.refundNo !== refundNo) {
      return { status: 'unknown' };
    }
    const order = await tx.getOrder(refund.orderId);
    if (!order || order._id !== refund.orderId) return { status: 'unknown' };

    const validation = source === 'query'
      ? validateQueryRefund(remoteRefund, order, refund, true)
      : validateNotificationRefund(remoteRefund, order, refund);
    if (validation.reasons.length > 0 || !validation.normalized) {
      return recordMismatchInTransaction(
        store,
        tx,
        order,
        refund,
        validation.reasons.length > 0 ? validation.reasons : ['REFUND_SHAPE']
      );
    }
    const normalized = validation.normalized;
    const eventId = financialEventId('refund_succeeded', refund.refundNo);
    const existing = await tx.getFinancialEvent(eventId);
    if (existing) {
      if (successEventMatches(existing, refund, normalized) && refund.status === 'succeeded') {
        if (
          source === 'query'
          && (
            refund.discountRefundFen === null
            || refund.refundCreateTime === null
          )
        ) {
          await tx.updateRefund(refund.refundNo, {
            refundCreateTime: normalized.refundCreateTime,
            refundCreatedAt: normalized.refundCreatedAt,
            settlementRefundFen: normalized.settlementRefundFen,
            settlementTotalFen: normalized.settlementTotalFen,
            discountRefundFen: normalized.discountRefundFen,
            reportedRefundFeeFen: normalized.refundFeeFen,
            queryEvidenceCompletedAt: normalized.succeededAt,
            updatedAt: store.serverDate()
          });
        }
        return { status: 'duplicate', orderId: order.orderId, refundNo };
      }
      return recordMismatchInTransaction(
        store,
        tx,
        order,
        refund,
        ['EXISTING_REFUND_SUCCESS_CONFLICT']
      );
    }

    const localReasons = successSnapshotReasons(order, refund, normalized);
    if (localReasons.length > 0) {
      return recordMismatchInTransaction(store, tx, order, refund, localReasons);
    }

    const cumulativeGrossRefundFen = refund.cumulativeGrossBeforeFen
      + normalized.grossRefundFen;
    const cumulativePayerRefundFen = refund.cumulativePayerBeforeFen
      + normalized.payerRefundFen;
    const cumulativeCouponRefundFen = refund.cumulativeCouponBeforeFen
      + normalized.couponRefundFen;
    const retainedPayerFen = order.wechatPayerTotalFen - cumulativePayerRefundFen;
    const retainedCouponFen = order.couponSubsidyFen - cumulativeCouponRefundFen;
    const settlement = calculateSettlement(retainedPayerFen, null);
    const originalCostFen = calculateSettlement(order.wechatPayerTotalFen, null).totalCostFen;
    const fullyRefunded = cumulativeGrossRefundFen === order.wechatOrderTotalFen
      && cumulativePayerRefundFen === order.wechatPayerTotalFen
      && cumulativeCouponRefundFen === order.couponSubsidyFen;
    const completedAt = normalized.succeededAt;
    const completedClaim = {
      ...refund.refundClaim,
      status: 'succeeded',
      completedAt
    };

    await tx.setFinancialEvent(eventId, {
      eventType: 'refund_succeeded',
      businessType: 'table_refund',
      businessId: refund.refundNo,
      orderId: refund.orderId,
      refundNo: refund.refundNo,
      refundId: normalized.refundId,
      transactionId: normalized.transactionId,
      outTradeNo: normalized.outTradeNo,
      successTime: normalized.successTime,
      grossRefundFen: normalized.grossRefundFen,
      payerRefundFen: normalized.payerRefundFen,
      couponRefundFen: normalized.couponRefundFen,
      cumulativeGrossRefundFen,
      cumulativePayerRefundFen,
      cumulativeCouponRefundFen,
      splitReturnNo: refund.splitReturnNo,
      splitReturnFen: refund.splitReturnFen,
      createdAt: store.serverDate()
    });
    await tx.updateRefund(refund.refundNo, {
      status: 'succeeded',
      refundClaim: completedClaim,
      wechatRefundId: normalized.refundId,
      refundSuccessTime: normalized.successTime,
      refundCompletedAt: completedAt,
      refundCreateTime: normalized.refundCreateTime || refund.refundCreateTime,
      refundCreatedAt: normalized.refundCreatedAt === null
        ? refund.refundCreatedAt
        : normalized.refundCreatedAt,
      payerRefundFen: normalized.payerRefundFen,
      couponRefundFen: normalized.couponRefundFen,
      settlementRefundFen: normalized.settlementRefundFen,
      settlementTotalFen: normalized.settlementTotalFen,
      discountRefundFen: normalized.discountRefundFen,
      reportedRefundFeeFen: normalized.refundFeeFen,
      verifiedSource: source,
      updatedAt: store.serverDate()
    });
    await tx.updateOrder(order.orderId, {
      paymentStatus: fullyRefunded ? 'refunded' : 'partially_refunded',
      refundClaim: completedClaim,
      grossRefundedFen: cumulativeGrossRefundFen,
      refundedTableFeeFen: cumulativePayerRefundFen,
      couponRefundedFen: cumulativeCouponRefundFen,
      retainedCouponSubsidyFen: retainedCouponFen,
      paidTableFeeFen: retainedPayerFen,
      totalCostFen: settlement.totalCostFen,
      shopNetFen: settlement.shopNetFen,
      shopSettlementFen: settlement.shopNetFen + retainedCouponFen,
      reversedTotalCostFen: originalCostFen - settlement.totalCostFen,
      preRefundChannelFeeFen: order.preRefundChannelFeeFen === undefined
        ? order.channelFeeFen
        : order.preRefundChannelFeeFen,
      preRefundPlatformNetFen: order.preRefundPlatformNetFen === undefined
        ? order.platformNetFen
        : order.preRefundPlatformNetFen,
      preRefundChannelFeeEvidenceHash:
        order.preRefundChannelFeeEvidenceHash === undefined
          ? order.channelFeeEvidenceHash
          : order.preRefundChannelFeeEvidenceHash,
      channelFeeFen: null,
      platformNetFen: null,
      channelFeeEvidenceHash: null,
      refundFeeReconciliationStatus: 'pending',
      financeAutomationBlocked: true,
      updatedAt: store.serverDate()
    });
    return { status: 'success', orderId: order.orderId, refundNo };
  });
}

function applyVerifiedRefundQuery({ store, refund }) {
  return applyVerifiedRefund({ store, remoteRefund: refund, source: 'query' });
}

function applyVerifiedRefundNotification({ store, refund }) {
  return applyVerifiedRefund({ store, remoteRefund: refund, source: 'notification' });
}

module.exports = {
  applyTerminalRefundNotification,
  applyVerifiedRefundNotification,
  applyVerifiedRefundQuery,
  markRefundManualReview
};
