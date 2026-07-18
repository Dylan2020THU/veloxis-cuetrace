'use strict';

const crypto = require('crypto');
const { calculateSettlement } = require('../table-finance/money');
const {
  financialEventId,
  splitNoForOrder
} = require('../table-finance/state');

const SPLIT_DESCRIPTION = 'CueTrace球桌服务费';
const UNFREEZE_DESCRIPTION = '解冻球厅剩余资金';
const CLAIM_LEASE_MS = 5 * 60 * 1000;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeText(value, maximum) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximum
    && !/[\x00-\x1f\x7f]/.test(value);
}

function safeFen(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function exactKeys(value, keys) {
  return isPlainObject(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function calendarDateParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1] ? { year, month, day } : null;
}

function officialTimeMs(value) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (
    !match
    || !calendarDateParts(match[1])
    || Number(match[2]) > 23
    || Number(match[3]) > 59
    || Number(match[4]) > 59
    || (match[5] !== undefined && Number(match[5]) > 23)
    || (match[6] !== undefined && Number(match[6]) > 59)
  ) return null;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function beijingDate(ms) {
  if (!Number.isSafeInteger(ms) || ms < 0) return null;
  const shifted = new Date(ms + 8 * 60 * 60 * 1000);
  return Number.isNaN(shifted.getTime())
    ? null
    : shifted.toISOString().slice(0, 10);
}

function nextDayTenBeijingMs(value) {
  const parts = calendarDateParts(value);
  if (!parts) return null;
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day + 1);
  date.setUTCHours(2, 0, 0, 0);
  const ms = date.getTime();
  return Number.isSafeInteger(ms) && ms >= 0 ? ms : null;
}

function digest(namespace, value, length) {
  const hash = crypto.createHash('sha256');
  const bytes = Buffer.from(value, 'utf8');
  hash.update(namespace).update(`${bytes.length}:`).update(bytes);
  return hash.digest('hex').slice(0, length);
}

function unfreezeNoForOrder(orderId) {
  if (!safeText(orderId, 256)) {
    throw new TypeError('orderId must be non-empty safe text');
  }
  return `unfreeze_${digest('unfreeze', orderId, 55)}`;
}

function validProfile(snapshot, config) {
  if (!isPlainObject(snapshot) || !isPlainObject(config)) return false;
  const keys = [
    'spAppid',
    'spMchid',
    'subAppid',
    'subMchid',
    'openidMode',
    'profileSchemaVersion',
    'policyVersion'
  ];
  return Object.keys(snapshot).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(snapshot, key))
    && snapshot.spAppid === config.spAppId
    && snapshot.spMchid === config.spMchid
    && /^wx[0-9A-Za-z]{16}$/.test(snapshot.spAppid)
    && /^[0-9]{8,32}$/.test(snapshot.spMchid)
    && /^[0-9]{8,32}$/.test(snapshot.subMchid)
    && snapshot.profileSchemaVersion === 1
    && snapshot.policyVersion === 'table_commission_v1'
    && (
      (snapshot.openidMode === 'sp_openid' && snapshot.subAppid === null)
      || (
        snapshot.openidMode === 'sub_openid'
        && /^wx[0-9A-Za-z]{16}$/.test(snapshot.subAppid)
      )
    );
}

function paymentEventMatches(event, order) {
  return isPlainObject(event)
    && event._id === financialEventId('payment_succeeded', order.orderId)
    && event.eventType === 'payment_succeeded'
    && event.businessType === 'table_order'
    && event.businessId === order.orderId
    && event.orderId === order.orderId
    && event.transactionId === order.wechatTransactionId
    && event.successTime === order.wechatSuccessTime
    && event.totalFen === order.wechatOrderTotalFen
    && event.payerTotalFen === order.wechatPayerTotalFen
    && event.couponSubsidyFen === order.couponSubsidyFen;
}

function feeEventMatches(event, order, now) {
  if (
    !isPlainObject(event)
    || event._id !== financialEventId(
      'channel_fee_confirmed',
      `${order.orderId}:${order.channelFeeEvidenceHash}`
    )
    || event.eventType !== 'channel_fee_confirmed'
    || event.businessType !== 'table_order'
    || event.businessId !== order.orderId
    || event.orderId !== order.orderId
    || event.transactionId !== order.wechatTransactionId
    || event.channelFeeFen !== order.channelFeeFen
    || event.platformNetFen !== order.platformNetFen
    || event.evidenceHash !== order.channelFeeEvidenceHash
    || event.source !== 'wechat_trade_bill'
    || !safeFen(event.confirmedAtMs)
    || event.confirmedAtMs > now
    || !Array.isArray(event.artifacts)
    || event.artifacts.length === 0
    || !Array.isArray(event.rows)
    || event.rows.length === 0
  ) return false;

  const successMs = officialTimeMs(order.wechatSuccessTime);
  const today = beijingDate(now);
  if (
    successMs === null
    || !today
    || !calendarDateParts(event.paymentBillDate)
    || event.paymentBillDate !== beijingDate(successMs)
    || event.paymentBillDate >= today
  ) return false;

  const artifactKeys = ['billDate', 'artifactId', 'sha1'];
  const artifacts = new Set();
  let previousArtifact = null;
  let maximumBillDate = null;
  for (const artifact of event.artifacts) {
    if (
      !exactKeys(artifact, artifactKeys)
      || !calendarDateParts(artifact.billDate)
      || artifact.billDate >= today
      || !safeText(artifact.artifactId, 256)
      || !/^[0-9a-f]{40}$/.test(artifact.sha1)
    ) return false;
    const key = `${artifact.billDate}\u0000${artifact.artifactId}`;
    if (previousArtifact !== null && key <= previousArtifact) return false;
    previousArtifact = key;
    maximumBillDate = artifact.billDate;
    artifacts.add(key);
  }
  const minimumConfirmation = nextDayTenBeijingMs(maximumBillDate);
  if (
    minimumConfirmation === null
    || event.confirmedAtMs < minimumConfirmation
  ) return false;

  const paymentKeys = [
    'kind',
    'billDate',
    'artifactId',
    'rowIdentityHash',
    'feeFen',
    'outTradeNo',
    'transactionId',
    'subMchid'
  ];
  const refundKeys = paymentKeys.concat(['refundNo', 'wechatRefundId']);
  const identities = new Set();
  let paymentRows = 0;
  let previousRefund = null;
  let channelFeeFen = 0;
  for (let index = 0; index < event.rows.length; index += 1) {
    const row = event.rows[index];
    const payment = row && row.kind === 'payment';
    const refund = row && row.kind === 'refund';
    if (
      (!payment && !refund)
      || !exactKeys(row, payment ? paymentKeys : refundKeys)
      || !calendarDateParts(row.billDate)
      || row.billDate >= today
      || !safeText(row.artifactId, 256)
      || !artifacts.has(`${row.billDate}\u0000${row.artifactId}`)
      || !/^[0-9a-f]{64}$/.test(row.rowIdentityHash)
      || identities.has(row.rowIdentityHash)
      || !Number.isSafeInteger(row.feeFen)
      || row.outTradeNo !== order.outTradeNo
      || row.transactionId !== order.wechatTransactionId
      || row.subMchid !== order.paymentProfileSnapshot.subMchid
    ) return false;
    identities.add(row.rowIdentityHash);
    if (payment) {
      paymentRows += 1;
      if (
        index !== 0
        || row.billDate !== event.paymentBillDate
        || row.feeFen < 0
      ) return false;
    } else {
      if (
        row.feeFen >= 0
        || !safeText(row.refundNo, 64)
        || !safeText(row.wechatRefundId, 64)
      ) return false;
      const key = `${row.refundNo}\u0000${row.wechatRefundId}\u0000${row.rowIdentityHash}`;
      if (previousRefund !== null && key <= previousRefund) return false;
      previousRefund = key;
    }
    channelFeeFen += row.feeFen;
    if (!Number.isSafeInteger(channelFeeFen)) return false;
  }
  return paymentRows === 1
    && channelFeeFen === event.channelFeeFen;
}

function result(status, reasonCodes = [], expected = null) {
  return Object.freeze({
    status,
    reasonCodes: Object.freeze([...new Set(reasonCodes)].sort()),
    expected
  });
}

function refundInProgress(order) {
  return isPlainObject(order.refundClaim)
    && ['returning', 'processing'].includes(order.refundClaim.status);
}

function assessSettlement(order, paymentEvent, feeEvent, config, now) {
  if (
    !isPlainObject(order)
    || !safeText(order._id, 256)
    || order.orderId !== order._id
    || order.schemaVersion !== 2
    || order.orderStatus !== 'complete'
    || !['paid', 'partially_refunded', 'refunded'].includes(order.paymentStatus)
    || !['pending', 'processing', 'failed'].includes(order.splitStatus)
    || !Number.isSafeInteger(now)
    || now < 0
  ) {
    return result('manual_review', ['LOCAL_STATE_INVALID']);
  }
  if (order.financeAutomationBlocked === true || refundInProgress(order)) {
    return result('pending');
  }
  if (
    order.splitStatus === 'processing'
    && (
      !isPlainObject(order.splitClaim)
      || !Number.isSafeInteger(order.splitClaim.leaseExpiresAt)
      || order.splitClaim.leaseExpiresAt > now
    )
  ) {
    return result('pending');
  }
  if (
    !validProfile(order.paymentProfileSnapshot, config)
    || order.policyVersion !== 'table_commission_v1'
    || order.billingMode !== 'table_commission'
    || order.commissionRateBps !== 500
    || order.includesChannelFee !== true
    || order.splitCycle !== 'T_PLUS_1'
    || typeof order.outTradeNo !== 'string'
    || !/^[0-9A-Za-z_|*\-]{6,32}$/.test(order.outTradeNo)
    || !safeText(order.wechatTransactionId, 32)
    || !safeText(order.wechatSuccessTime, 64)
    || !Number.isSafeInteger(order.paidAt)
    || order.paidAt < 0
    || order.splitNo !== splitNoForOrder(order.orderId)
  ) {
    return result('manual_review', ['PAYMENT_SNAPSHOT_INVALID']);
  }
  if (!paymentEvent) return result('pending');
  if (!paymentEventMatches(paymentEvent, order)) {
    return result('manual_review', ['PAYMENT_EVIDENCE_MISMATCH']);
  }
  if (
    order.channelFeeFen === null
    || order.platformNetFen === null
    || order.channelFeeEvidenceHash === undefined
    || !feeEvent
  ) {
    return result('pending');
  }
  if (
    !/^[0-9a-f]{64}$/.test(order.channelFeeEvidenceHash)
    || !feeEventMatches(feeEvent, order, now)
  ) {
    return result('manual_review', ['CHANNEL_FEE_EVIDENCE_MISMATCH']);
  }
  if (
    !safeFen(order.wechatOrderTotalFen)
    || !safeFen(order.wechatPayerTotalFen)
    || order.wechatPayerTotalFen > order.wechatOrderTotalFen
    || order.couponSubsidyFen
      !== order.wechatOrderTotalFen - order.wechatPayerTotalFen
    || !safeFen(order.paidTableFeeFen)
    || order.paidTableFeeFen > order.wechatPayerTotalFen
    || !safeFen(order.totalCostFen)
    || !safeFen(order.channelFeeFen)
    || !safeFen(order.platformNetFen)
    || !safeFen(order.shopNetFen)
    || !safeFen(order.shopSettlementFen)
  ) {
    return result('manual_review', ['SETTLEMENT_AMOUNT_INVALID']);
  }
  const retainedSubsidyFen = order.retainedCouponSubsidyFen;
  if (
    !safeFen(retainedSubsidyFen)
    || !safeFen(order.refundedTableFeeFen)
    || !safeFen(order.couponRefundedFen)
    || !safeFen(order.grossRefundedFen)
  ) {
    return result('manual_review', ['RETAINED_AMOUNT_INVALID']);
  }
  const payerTotal = order.paidTableFeeFen + order.refundedTableFeeFen;
  const couponTotal = retainedSubsidyFen + order.couponRefundedFen;
  const grossRefunded = order.refundedTableFeeFen + order.couponRefundedFen;
  const paidState = order.paymentStatus === 'paid'
    && order.paidTableFeeFen === order.wechatPayerTotalFen
    && order.refundedTableFeeFen === 0
    && order.couponRefundedFen === 0
    && retainedSubsidyFen === order.couponSubsidyFen
    && order.grossRefundedFen === 0;
  const partialState = order.paymentStatus === 'partially_refunded'
    && order.paidTableFeeFen > 0
    && order.paidTableFeeFen < order.wechatPayerTotalFen
    && payerTotal === order.wechatPayerTotalFen
    && couponTotal === order.couponSubsidyFen
    && grossRefunded === order.grossRefundedFen;
  const refundedState = order.paymentStatus === 'refunded'
    && order.paidTableFeeFen === 0
    && order.refundedTableFeeFen === order.wechatPayerTotalFen
    && order.couponRefundedFen === order.couponSubsidyFen
    && retainedSubsidyFen === 0
    && order.grossRefundedFen === order.wechatOrderTotalFen
    && couponTotal === order.couponSubsidyFen
    && grossRefunded === order.grossRefundedFen;
  if (
    !Number.isSafeInteger(payerTotal)
    || !Number.isSafeInteger(couponTotal)
    || !Number.isSafeInteger(grossRefunded)
    || order.shopSettlementFen !== order.shopNetFen + retainedSubsidyFen
    || (!paidState && !partialState && !refundedState)
  ) {
    return result('manual_review', ['RETAINED_AMOUNT_INVALID']);
  }
  const calculated = calculateSettlement(
    order.paidTableFeeFen,
    order.channelFeeFen
  );
  if (calculated.manualReview) {
    return result('manual_review', ['CHANNEL_FEE_EXCEEDS_TOTAL_COST']);
  }
  if (
    order.totalCostFen !== calculated.totalCostFen
    || order.platformNetFen !== calculated.platformNetFen
    || order.shopNetFen !== calculated.shopNetFen
  ) {
    return result('manual_review', ['SETTLEMENT_AMOUNT_MISMATCH']);
  }
  return result('eligible', [], Object.freeze({
    orderId: order.orderId,
    splitNo: order.splitNo,
    unfreezeNo: unfreezeNoForOrder(order.orderId),
    transactionId: order.wechatTransactionId,
    subMchid: order.paymentProfileSnapshot.subMchid,
    spMchid: order.paymentProfileSnapshot.spMchid,
    spAppid: order.paymentProfileSnapshot.spAppid,
    subAppid: order.paymentProfileSnapshot.subAppid,
    platformNetFen: order.platformNetFen,
    channelFeeFen: order.channelFeeFen,
    shopSettlementFen: order.shopSettlementFen,
    evidenceHash: order.channelFeeEvidenceHash
  }));
}

function buildReceiverBody(expected, encryptedName) {
  if (!isPlainObject(expected) || !safeText(encryptedName, 2048)) {
    throw new TypeError('receiver request input is invalid');
  }
  const body = {
    sub_mchid: expected.subMchid,
    appid: expected.spAppid
  };
  if (expected.subAppid !== null) body.sub_appid = expected.subAppid;
  return {
    ...body,
    type: 'MERCHANT_ID',
    account: expected.spMchid,
    name: encryptedName,
    relation_type: 'SERVICE_PROVIDER'
  };
}

function buildSplitBody(expected, encryptedName) {
  if (
    !isPlainObject(expected)
    || !safeText(encryptedName, 2048)
    || !Number.isSafeInteger(expected.platformNetFen)
    || expected.platformNetFen <= 0
  ) {
    throw new TypeError('split request input is invalid');
  }
  return {
    sub_mchid: expected.subMchid,
    transaction_id: expected.transactionId,
    out_order_no: expected.splitNo,
    receivers: [{
      type: 'MERCHANT_ID',
      account: expected.spMchid,
      name: encryptedName,
      amount: expected.platformNetFen,
      description: SPLIT_DESCRIPTION
    }],
    unfreeze_unsplit: false
  };
}

function buildUnfreezeBody(expected) {
  if (!isPlainObject(expected)) {
    throw new TypeError('unfreeze request input is invalid');
  }
  return {
    sub_mchid: expected.subMchid,
    transaction_id: expected.transactionId,
    out_order_no: expected.unfreezeNo,
    description: UNFREEZE_DESCRIPTION
  };
}

function receiverRelationMatches(remote, expected) {
  return isPlainObject(remote)
    && remote.sub_mchid === expected.subMchid
    && remote.type === 'MERCHANT_ID'
    && remote.account === expected.spMchid
    && remote.relation_type === 'SERVICE_PROVIDER';
}

function exactRemoteIdentity(remote, expected, outOrderNo) {
  return isPlainObject(remote)
    && remote.sub_mchid === expected.subMchid
    && remote.transaction_id === expected.transactionId
    && remote.out_order_no === outOrderNo
    && safeText(remote.order_id, 64)
    && Array.isArray(remote.receivers);
}

function validateTerminal(remote, expected, kind) {
  const outOrderNo = kind === 'split' ? expected.splitNo : expected.unfreezeNo;
  if (!exactRemoteIdentity(remote, expected, outOrderNo)) {
    return result('manual_review', [`${kind.toUpperCase()}_IDENTITY_MISMATCH`]);
  }
  if (remote.state === 'PROCESSING') return result('pending');
  if (remote.state !== 'FINISHED') {
    return result('manual_review', [`${kind.toUpperCase()}_STATE_UNKNOWN`]);
  }
  if (remote.receivers.length !== 1) {
    return result('manual_review', [`${kind.toUpperCase()}_RECEIVER_MISMATCH`]);
  }
  const receiver = remote.receivers[0];
  if (!isPlainObject(receiver)) {
    return result('manual_review', [`${kind.toUpperCase()}_RECEIVER_MISMATCH`]);
  }
  if (receiver.result === 'CLOSED') {
    return result('manual_review', [`${kind.toUpperCase()}_RECEIVER_FAILED`]);
  }
  if (receiver.result !== 'SUCCESS') {
    return result('manual_review', [`${kind.toUpperCase()}_RECEIVER_NOT_TERMINAL`]);
  }
  const split = kind === 'split';
  if (
    receiver.type !== 'MERCHANT_ID'
    || receiver.account !== (split ? expected.spMchid : expected.subMchid)
    || receiver.amount !== (
      split ? expected.platformNetFen : expected.shopSettlementFen
    )
    || receiver.description !== (
      split ? SPLIT_DESCRIPTION : UNFREEZE_DESCRIPTION
    )
    || !safeText(receiver.detail_id, 64)
  ) {
    return result('manual_review', [`${kind.toUpperCase()}_RECEIVER_MISMATCH`]);
  }
  return result('success', [], Object.freeze({
    orderId: remote.order_id,
    detailId: receiver.detail_id
  }));
}

function successEventDocument(expected, splitTerminal, unfreezeTerminal, createdAt) {
  return {
    eventType: 'profit_sharing_succeeded',
    businessType: 'table_order',
    businessId: expected.orderId,
    orderId: expected.orderId,
    transactionId: expected.transactionId,
    splitNo: expected.splitNo,
    splitOrderId: splitTerminal ? splitTerminal.orderId : null,
    splitDetailId: splitTerminal ? splitTerminal.detailId : null,
    unfreezeNo: expected.unfreezeNo,
    unfreezeOrderId: unfreezeTerminal.orderId,
    channelFeeFen: expected.channelFeeFen,
    platformNetFen: expected.platformNetFen,
    evidenceHash: expected.evidenceHash,
    createdAt
  };
}

module.exports = {
  CLAIM_LEASE_MS,
  SPLIT_DESCRIPTION,
  UNFREEZE_DESCRIPTION,
  assessSettlement,
  buildReceiverBody,
  buildSplitBody,
  buildUnfreezeBody,
  receiverRelationMatches,
  validateTerminal,
  successEventDocument,
  unfreezeNoForOrder
};
