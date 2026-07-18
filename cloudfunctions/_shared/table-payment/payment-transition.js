'use strict';

const { calculateSettlement } = require('./table-finance/money');
const { financialEventId } = require('./table-finance/state');
const { isPaymentProfileSnapshot } = require('./table-payment');
const MAX_CHECKIN_AGE_MS = 30 * 60 * 1000;
const MAX_CHECKIN_CLOCK_SKEW_MS = 60 * 1000;
const TRAINING_CORE_KEYS = Object.freeze([
  '_id',
  '_openid',
  'memberOpenid',
  'shopId',
  'storeId',
  'tableId',
  'sessionId',
  'orderId',
  'hallId',
  'date',
  'startTime',
  'startedAt',
  'endedAt',
  'durationMinutes',
  'verified',
  'verificationSource',
  'verifiedAt'
]);
const COACH_LESSON_CORE_KEYS = Object.freeze([
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
  'date',
  'startTime',
  'startedAt',
  'endedAt',
  'durationMinutes',
  'amount',
  'settled',
  'verified',
  'verificationSource',
  'verifiedAt'
]);

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function safeText(value, maximumBytes) {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= maximumBytes
    && !/[\x00-\x1f\x7f]/.test(value);
}

function safeCharacterText(value, maximumCharacters) {
  return typeof value === 'string'
    && value.length > 0
    && Array.from(value).length <= maximumCharacters
    && !/[\x00-\x1f\x7f-\x9f]/.test(value);
}

function officialSuccessTime(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] || '').padEnd(3, '0'));
  const offsetHour = match[8] === 'Z' ? 0 : Number(match[10]);
  const offsetMinute = match[8] === 'Z' ? 0 : Number(match[11]);
  if (
    month < 1
    || month > 12
    || day < 1
    || day > 31
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
  ) {
    return null;
  }

  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, millisecond);
  if (
    calendar.getUTCFullYear() !== year
    || calendar.getUTCMonth() !== month - 1
    || calendar.getUTCDate() !== day
    || calendar.getUTCHours() !== hour
    || calendar.getUTCMinutes() !== minute
    || calendar.getUTCSeconds() !== second
    || calendar.getUTCMilliseconds() !== millisecond
  ) {
    return null;
  }
  const offset = (offsetHour * 60) + offsetMinute;
  const signedOffset = match[9] === '-' ? -offset : offset;
  const parsed = calendar.getTime() - (signedOffset * 60 * 1000);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function promotionAmount(transaction, expectedSubsidy) {
  if (!hasOwn(transaction, 'promotion_detail')) return expectedSubsidy;
  const details = transaction.promotion_detail;
  if (!Array.isArray(details) || details.length === 0) return null;
  let total = 0;
  for (const detail of details) {
    if (
      !isPlainObject(detail)
      || !safeText(detail.coupon_id, 32)
      || !safeCharacterText(detail.name, 64)
      || !Number.isSafeInteger(detail.amount)
      || detail.amount <= 0
      || (hasOwn(detail, 'currency') && detail.currency !== 'CNY')
    ) {
      return null;
    }
    total += detail.amount;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total === expectedSubsidy ? total : null;
}

function occupancyIdFor(storeId, tableId) {
  return `${storeId.length}_${storeId}__${tableId}`;
}

function verifiedTrainingIdForOrder(orderId) {
  return `verified_training_${orderId}`;
}

function verifiedCoachLessonIdForOrder(orderId) {
  return `verified_coach_lesson_${orderId}`;
}

function safeOpenid(value) {
  return safeText(value, 128) && /^[0-9A-Za-z_-]+$/.test(value);
}

function safeDocumentId(value) {
  return typeof value === 'string'
    && /^[0-9A-Za-z_-]{1,64}$/.test(value);
}

function checkinTimeMatchesSession(value, snapshot, startedAt) {
  return Number.isSafeInteger(value)
    && value >= 0
    && value === snapshot
    && value >= startedAt - MAX_CHECKIN_AGE_MS
    && value <= startedAt + MAX_CHECKIN_CLOCK_SKEW_MS;
}

function chinaTrainingTime(startedAt) {
  const shifted = startedAt + (8 * 60 * 60 * 1000);
  const date = new Date(shifted);
  if (!Number.isSafeInteger(shifted) || Number.isNaN(date.getTime())) return null;
  const iso = date.toISOString();
  return { date: iso.slice(0, 10), startTime: iso.slice(11, 16) };
}

function verifiedTrainingSnapshot(order, session, paidAt, context) {
  if (!context.memberOpenid) return null;
  const localTime = chinaTrainingTime(session.startedAt);
  if (!localTime) return null;
  return {
    _id: verifiedTrainingIdForOrder(order.orderId),
    schemaVersion: 2,
    _openid: context.memberOpenid,
    memberOpenid: context.memberOpenid,
    shopId: order.shopId,
    storeId: order.storeId,
    tableId: order.tableId,
    sessionId: order.sessionId,
    orderId: order.orderId,
    hallId: order.storeId,
    hallName: context.hallName,
    tableName: typeof order.tableName === 'string' ? order.tableName : '',
    date: localTime.date,
    startTime: localTime.startTime,
    startedAt: session.startedAt,
    endedAt: session.checkoutAt,
    durationMinutes: Math.max(
      1,
      Math.round((session.checkoutAt - session.startedAt) / 60000)
    ),
    verified: true,
    verificationSource: 'platform_payment',
    verifiedAt: paidAt
  };
}

function verifiedCoachLessonSnapshot(order, session, paidAt, context) {
  if (!context.memberOpenid || !context.coachOpenid) return null;
  const localTime = chinaTrainingTime(session.coachJoinedAt);
  if (!localTime) return null;
  return {
    _id: verifiedCoachLessonIdForOrder(order.orderId),
    schemaVersion: 2,
    _openid: context.coachOpenid,
    coachOpenid: context.coachOpenid,
    coachNickname: '',
    memberOpenid: context.memberOpenid,
    memberNickname: '',
    shopId: order.shopId,
    storeId: order.storeId,
    tableId: order.tableId,
    sessionId: order.sessionId,
    orderId: order.orderId,
    hallId: order.storeId,
    hallName: context.hallName,
    tableName: typeof order.tableName === 'string' ? order.tableName : '',
    date: localTime.date,
    startTime: localTime.startTime,
    startedAt: session.coachJoinedAt,
    endedAt: session.checkoutAt,
    durationMinutes: Math.max(
      1,
      Math.round((session.checkoutAt - session.coachJoinedAt) / 60000)
    ),
    amount: 0,
    settled: false,
    verified: true,
    verificationSource: 'platform_payment',
    verifiedAt: paidAt
  };
}

async function loadEntitlementContext(tx, order, session) {
  const empty = { memberOpenid: '', coachOpenid: '', hallName: '' };
  const shopStore = await tx.getStore(order.storeId);
  if (
    !isPlainObject(shopStore)
    || shopStore._id !== order.storeId
    || shopStore._openid !== order.shopId
  ) {
    return empty;
  }
  const hallName = safeCharacterText(shopStore.name, 100) ? shopStore.name : '';
  if (
    !safeOpenid(session.memberOpenid)
    || !safeDocumentId(session.memberCheckinId)
  ) {
    return { ...empty, hallName };
  }
  const checkin = await tx.getEntitlementCheckin(session.memberCheckinId);
  const trustedMember = (
    isPlainObject(checkin)
    && checkin._id === session.memberCheckinId
    && checkin.memberOpenid === session.memberOpenid
    && checkin.storeId === order.storeId
    && checkin.tableId === order.tableId
    && checkin.role === 'member'
    && checkin.ready === true
    && checkin.status === 'confirmed'
    && checkin.sessionId === session._id
    && checkin.boundAt === session.startedAt
    && checkinTimeMatchesSession(
      checkin.joinedAt,
      session.memberCheckinJoinedAt,
      session.startedAt
    )
    && checkinTimeMatchesSession(
      checkin.readyAt,
      session.memberReadyAt,
      session.startedAt
    )
  );
  if (!trustedMember) return { ...empty, hallName };

  let coachOpenid = '';
  if (
    safeOpenid(session.coachOpenid)
    && safeDocumentId(session.coachCheckinId)
    && safeDocumentId(session.coachLinkId)
    && Number.isSafeInteger(session.coachJoinedAt)
    && session.coachJoinedAt >= session.startedAt
    && session.coachJoinedAt <= session.checkoutAt
  ) {
    const coachCheckin = await tx.getEntitlementCheckin(session.coachCheckinId);
    const link = await tx.getCoachLink(session.coachLinkId);
    if (
      isPlainObject(coachCheckin)
      && coachCheckin._id === session.coachCheckinId
      && coachCheckin.memberOpenid === session.coachOpenid
      && coachCheckin.storeId === order.storeId
      && coachCheckin.tableId === order.tableId
      && coachCheckin.role === 'coach'
      && coachCheckin.ready === true
      && coachCheckin.status === 'confirmed'
      && coachCheckin.sessionId === session._id
      && coachCheckin.boundAt === session.startedAt
      && checkinTimeMatchesSession(
        coachCheckin.joinedAt,
        session.coachCheckinJoinedAt,
        session.startedAt
      )
      && checkinTimeMatchesSession(
        coachCheckin.readyAt,
        session.coachReadyAt,
        session.startedAt
      )
      && isPlainObject(link)
      && link._id === session.coachLinkId
      && link.shopOpenid === order.shopId
      && link.coachOpenid === session.coachOpenid
      && link.status === 'active'
      && (!link.storeId || link.storeId === order.storeId)
    ) {
      coachOpenid = session.coachOpenid;
    }
  }
  return { memberOpenid: session.memberOpenid, coachOpenid, hallName };
}

function coreSnapshotMatches(existing, expected, keys) {
  return isPlainObject(existing)
    && keys.every((key) => hasOwn(existing, key) && existing[key] === expected[key]);
}

async function ensureVerifiedEntitlements(store, tx, order, session, paidAt) {
  const context = await loadEntitlementContext(tx, order, session);
  const training = verifiedTrainingSnapshot(order, session, paidAt, context);
  const coachLesson = verifiedCoachLessonSnapshot(
    order,
    session,
    paidAt,
    context
  );
  const existingTraining = training
    ? await tx.getVerifiedTraining(training._id)
    : null;
  const existingCoachLesson = coachLesson
    ? await tx.getVerifiedCoachLesson(coachLesson._id)
    : null;
  const reasonCodes = [];
  if (
    training
    && existingTraining
    && !coreSnapshotMatches(existingTraining, training, TRAINING_CORE_KEYS)
  ) {
    reasonCodes.push('TRAINING_SNAPSHOT_CONFLICT');
  }
  if (
    coachLesson
    && existingCoachLesson
    && !coreSnapshotMatches(
      existingCoachLesson,
      coachLesson,
      COACH_LESSON_CORE_KEYS
    )
  ) {
    reasonCodes.push('COACH_LESSON_SNAPSHOT_CONFLICT');
  }
  if (reasonCodes.length > 0) {
    return { reasonCodes: [...new Set(reasonCodes)].sort() };
  }
  if (
    training
    && !existingTraining
  ) {
    await tx.setVerifiedTraining(training._id, {
      ...training,
      createdAt: store.serverDate()
    });
  }
  if (
    coachLesson
    && !existingCoachLesson
  ) {
    await tx.setVerifiedCoachLesson(coachLesson._id, {
      ...coachLesson,
      createdAt: store.serverDate()
    });
  }
  return { reasonCodes: [] };
}

function localRelationshipReasons(order, session) {
  const reasons = [];
  if (
    !isPlainObject(order)
    || order._id !== order.orderId
    || order.schemaVersion !== 2
    || typeof order.shopId !== 'string'
    || order._openid !== order.shopId
    || order.policyVersion !== 'table_commission_v1'
    || order.billingMode !== 'table_commission'
    || order.commissionRateBps !== 500
    || order.includesChannelFee !== true
    || order.splitCycle !== 'T_PLUS_1'
    || !Number.isSafeInteger(order.quotedTableFeeFen)
    || order.quotedTableFeeFen <= 0
    || !Number.isSafeInteger(order.tableGrossFen)
    || !Number.isSafeInteger(order.tableDiscountFen)
    || order.tableGrossFen - order.tableDiscountFen !== order.quotedTableFeeFen
    || !safeText(order.payerOpenid, 128)
    || !isPaymentProfileSnapshot(order.paymentProfileSnapshot)
  ) {
    reasons.push('ORDER_SNAPSHOT');
  }
  if (
    !isPlainObject(session)
    || session._id !== order.sessionId
    || session.schemaVersion !== 2
    || session._openid !== order.shopId
    || session.shopId !== order.shopId
    || session.storeId !== order.storeId
    || session.tableId !== order.tableId
    || session.orderId !== order.orderId
    || session.checkoutAt !== order.checkoutAt
    || !Number.isSafeInteger(session.startedAt)
    || session.startedAt < 0
    || session.startedAt !== order.startedAt
    || !Number.isSafeInteger(session.checkoutAt)
    || session.checkoutAt <= session.startedAt
    || order.actualDurationMs !== session.checkoutAt - session.startedAt
    || !chinaTrainingTime(session.startedAt)
  ) {
    reasons.push('SESSION_RELATIONSHIP');
  }
  return reasons;
}

function knownOutTradeNo(order, outTradeNo) {
  if (!safeText(outTradeNo, 32)) return false;
  if (order.outTradeNo === outTradeNo) return true;
  return Array.isArray(order.previousOutTradeNos)
    && order.previousOutTradeNos.every((value) => safeText(value, 32))
    && new Set(order.previousOutTradeNos).size === order.previousOutTradeNos.length
    && order.previousOutTradeNos.includes(outTradeNo);
}

function verifiedReasons(order, transaction) {
  const reasons = [];
  if (!isPlainObject(transaction)) return ['TRANSACTION_SHAPE'];
  const snapshot = order.paymentProfileSnapshot;
  if (!isPaymentProfileSnapshot(snapshot)) {
    return ['PAYMENT_PROFILE_SNAPSHOT'];
  }
  if (transaction.sp_appid !== snapshot.spAppid) reasons.push('SP_APPID');
  if (transaction.sp_mchid !== snapshot.spMchid) reasons.push('SP_MCHID');
  if (transaction.sub_mchid !== snapshot.subMchid) reasons.push('SUB_MCHID');
  if (snapshot.subAppid === null) {
    if (hasOwn(transaction, 'sub_appid')) reasons.push('SUB_APPID');
  } else if (transaction.sub_appid !== snapshot.subAppid) {
    reasons.push('SUB_APPID');
  }
  if (!knownOutTradeNo(order, transaction.out_trade_no)) reasons.push('OUT_TRADE_NO');
  if (transaction.trade_type !== 'JSAPI') reasons.push('TRADE_TYPE');
  if (transaction.trade_state !== 'SUCCESS') reasons.push('TRADE_STATE');
  const payer = transaction.payer;
  const payerField = snapshot.openidMode === 'sp_openid' ? 'sp_openid' : 'sub_openid';
  if (!isPlainObject(payer) || payer[payerField] !== order.payerOpenid) {
    reasons.push('PAYER_OPENID');
  }
  if (!safeText(transaction.transaction_id, 32)) reasons.push('TRANSACTION_ID');
  const paidAt = officialSuccessTime(transaction.success_time);
  if (paidAt === null || paidAt < order.checkoutAt) reasons.push('SUCCESS_TIME');
  const amount = transaction.amount;
  if (!isPlainObject(amount)) {
    reasons.push('AMOUNT');
  } else {
    if (
      !Number.isSafeInteger(amount.total)
      || amount.total !== order.quotedTableFeeFen
    ) reasons.push('AMOUNT_TOTAL');
    if (
      !Number.isSafeInteger(amount.payer_total)
      || amount.payer_total < 0
      || amount.payer_total > amount.total
    ) reasons.push('AMOUNT_PAYER_TOTAL');
    if (amount.currency !== 'CNY') reasons.push('AMOUNT_CURRENCY');
    if (amount.payer_currency !== 'CNY') reasons.push('PAYER_CURRENCY');
    if (
      Number.isSafeInteger(amount.total)
      && Number.isSafeInteger(amount.payer_total)
      && amount.payer_total >= 0
      && amount.payer_total <= amount.total
      && promotionAmount(transaction, amount.total - amount.payer_total) === null
    ) reasons.push('PROMOTION_DETAIL');
  }
  return [...new Set(reasons)].sort();
}

function terminalSnapshotMatches(order, transaction, paidAt) {
  const amount = transaction.amount;
  const subsidy = amount.total - amount.payer_total;
  const settlement = calculateSettlement(amount.payer_total, null);
  const entitlementManualReview = order.orderStatus === 'manual_review'
    && order.manualReviewReason === 'entitlement_snapshot_conflict'
    && Array.isArray(order.manualReviewReasonCodes)
    && order.manualReviewReasonCodes.length > 0;
  return (order.orderStatus === 'complete' || entitlementManualReview)
    && order.paymentStatus === 'paid'
    && order.splitStatus === 'pending'
    && order.wechatTransactionId === transaction.transaction_id
    && (
      order.paidOutTradeNo === transaction.out_trade_no
      || (
        !hasOwn(order, 'paidOutTradeNo')
        && transaction.out_trade_no === order.outTradeNo
      )
    )
    && order.wechatSuccessTime === transaction.success_time
    && order.paidAt === paidAt
    && order.wechatOrderTotalFen === amount.total
    && order.wechatPayerTotalFen === amount.payer_total
    && order.couponSubsidyFen === subsidy
    && order.retainedCouponSubsidyFen === subsidy
    && order.paidTableFeeFen === amount.payer_total
    && order.grossRefundedFen === 0
    && order.couponRefundedFen === 0
    && order.requestedRefundFen === 0
    && order.splitReturnedFen === 0
    && order.totalCostFen === settlement.totalCostFen
    && order.shopNetFen === settlement.shopNetFen
    && order.shopSettlementFen === settlement.shopNetFen + subsidy
    && order.channelFeeFen === null
    && order.platformNetFen === null;
}

function successEventMatches(event, order, transaction) {
  const amount = transaction.amount;
  return isPlainObject(event)
    && event.eventType === 'payment_succeeded'
    && event.businessType === 'table_order'
    && event.businessId === order.orderId
    && event.orderId === order.orderId
    && (
      event.outTradeNo === transaction.out_trade_no
      || (
        !hasOwn(event, 'outTradeNo')
        && transaction.out_trade_no === order.outTradeNo
      )
    )
    && event.transactionId === transaction.transaction_id
    && event.successTime === transaction.success_time
    && event.totalFen === amount.total
    && event.payerTotalFen === amount.payer_total
    && event.couponSubsidyFen === amount.total - amount.payer_total;
}

function mismatchEventMatches(event, order, reasonCodes) {
  return isPlainObject(event)
    && event.eventType === 'payment_mismatch'
    && event.businessType === 'table_order'
    && event.businessId === order.orderId
    && event.orderId === order.orderId
    && event.redacted === true
    && Array.isArray(event.reasonCodes)
    && JSON.stringify(event.reasonCodes) === JSON.stringify(reasonCodes);
}

function entitlementAnomalyEventMatches(event, order, reasonCodes) {
  return isPlainObject(event)
    && event.eventType === 'entitlement_snapshot_conflict'
    && event.businessType === 'table_order'
    && event.businessId === order.orderId
    && event.orderId === order.orderId
    && event.blocking === true
    && event.redacted === true
    && Array.isArray(event.reasonCodes)
    && JSON.stringify(event.reasonCodes) === JSON.stringify(reasonCodes);
}

async function recordEntitlementAnomaly(store, tx, order, reasons) {
  const eventId = financialEventId(
    'entitlement_snapshot_conflict',
    order.orderId
  );
  const normalizedReasons = [...new Set(reasons)].sort();
  const existing = await tx.getFinancialEvent(eventId);
  if (!existing) {
    await tx.setFinancialEvent(eventId, {
      eventType: 'entitlement_snapshot_conflict',
      businessType: 'table_order',
      businessId: order.orderId,
      orderId: order.orderId,
      reasonCodes: normalizedReasons,
      blocking: true,
      redacted: true,
      createdAt: store.serverDate()
    });
  }
  const effectiveReasons = existing
    && !entitlementAnomalyEventMatches(existing, order, normalizedReasons)
    ? ['EXISTING_ENTITLEMENT_ANOMALY_CONFLICT']
    : normalizedReasons;
  if (
    order.orderStatus !== 'manual_review'
    || order.manualReviewReason !== 'entitlement_snapshot_conflict'
    || JSON.stringify(order.manualReviewReasonCodes || []) !== JSON.stringify(effectiveReasons)
  ) {
    await tx.updateOrder(order.orderId, {
      orderStatus: 'manual_review',
      manualReviewReason: 'entitlement_snapshot_conflict',
      manualReviewReasonCodes: effectiveReasons,
      updatedAt: store.serverDate()
    });
  }
  return effectiveReasons;
}

async function recordMismatch(store, tx, order, reasons) {
  const eventId = financialEventId('payment_mismatch', order.orderId);
  const normalizedReasons = [...new Set(reasons)].sort();
  const existing = await tx.getFinancialEvent(eventId);
  if (!existing) {
    await tx.setFinancialEvent(eventId, {
      eventType: 'payment_mismatch',
      businessType: 'table_order',
      businessId: order.orderId,
      orderId: order.orderId,
      reasonCodes: normalizedReasons,
      redacted: true,
      createdAt: store.serverDate()
    });
  }
  const effectiveReasons = existing
    && !mismatchEventMatches(existing, order, normalizedReasons)
    ? ['EXISTING_MISMATCH_CONFLICT']
    : normalizedReasons;
  if (
    order.orderStatus !== 'manual_review'
    || JSON.stringify(order.manualReviewReasonCodes || []) !== JSON.stringify(effectiveReasons)
  ) {
    await tx.updateOrder(order.orderId, {
      orderStatus: 'manual_review',
      manualReviewReason: 'payment_mismatch',
      manualReviewReasonCodes: effectiveReasons,
      updatedAt: store.serverDate()
    });
  }
  return { status: 'mismatch', orderId: order.orderId };
}

async function applyVerifiedTransaction({ store, transaction, expectedOrderId }) {
  if (!store || !isPlainObject(transaction)) {
    throw new TypeError('verified payment transition input is invalid');
  }
  let orderId = expectedOrderId;
  if (orderId === undefined) {
    if (!safeText(transaction.out_trade_no, 32)) return { status: 'unknown' };
    const matches = await store.findOrdersByOutTradeNo(transaction.out_trade_no, 2);
    if (!Array.isArray(matches) || matches.length !== 1) return { status: 'unknown' };
    orderId = matches[0]._id;
  }
  if (!safeText(orderId, 128)) return { status: 'unknown' };

  return store.runTransaction(async (tx) => {
    const order = await tx.getOrder(orderId);
    if (!order || order._id !== orderId) return { status: 'unknown' };
    const session = await tx.getSession(order.sessionId);
    const reasons = localRelationshipReasons(order, session)
      .concat(verifiedReasons(order, transaction));
    if (reasons.length > 0) {
      return recordMismatch(store, tx, order, [...new Set(reasons)].sort());
    }

    const paidAt = officialSuccessTime(transaction.success_time);
    const successEventId = financialEventId('payment_succeeded', order.orderId);
    const existingSuccess = await tx.getFinancialEvent(successEventId);
    if (existingSuccess) {
      if (
        successEventMatches(existingSuccess, order, transaction)
        && terminalSnapshotMatches(order, transaction, paidAt)
        && session.status === 'closed'
        && session.closedAt === paidAt
      ) {
        if (order.orderStatus === 'manual_review') {
          const anomalyId = financialEventId(
            'entitlement_snapshot_conflict',
            order.orderId
          );
          const anomaly = await tx.getFinancialEvent(anomalyId);
          if (!entitlementAnomalyEventMatches(
            anomaly,
            order,
            order.manualReviewReasonCodes
          )) {
            await recordEntitlementAnomaly(
              store,
              tx,
              order,
              order.manualReviewReasonCodes
            );
          }
        }
        return { status: 'duplicate', orderId: order.orderId };
      }
      return recordMismatch(store, tx, order, ['EXISTING_SUCCESS_CONFLICT']);
    }
    if (
      order.orderStatus !== 'awaiting_payment'
      || order.paymentStatus !== 'unpaid'
      || order.splitStatus !== 'pending'
      || order.paidTableFeeFen !== order.quotedTableFeeFen
      || session.status !== 'awaiting_payment'
      || session.closedAt !== null
    ) {
      return recordMismatch(store, tx, order, ['LOCAL_STATE']);
    }

    const entitlement = await ensureVerifiedEntitlements(
      store,
      tx,
      order,
      session,
      paidAt
    );
    let entitlementReasonCodes = entitlement.reasonCodes;
    if (entitlementReasonCodes.length > 0) {
      entitlementReasonCodes = await recordEntitlementAnomaly(
        store,
        tx,
        order,
        entitlementReasonCodes
      );
    }

    const amount = transaction.amount;
    const couponSubsidyFen = amount.total - amount.payer_total;
    const settlement = calculateSettlement(amount.payer_total, null);
    await tx.setFinancialEvent(successEventId, {
      eventType: 'payment_succeeded',
      businessType: 'table_order',
      businessId: order.orderId,
      orderId: order.orderId,
      outTradeNo: transaction.out_trade_no,
      transactionId: transaction.transaction_id,
      successTime: transaction.success_time,
      totalFen: amount.total,
      payerTotalFen: amount.payer_total,
      couponSubsidyFen,
      createdAt: store.serverDate()
    });
    await tx.updateOrder(order.orderId, {
      orderStatus: entitlementReasonCodes.length > 0
        ? 'manual_review'
        : 'complete',
      ...(entitlementReasonCodes.length > 0 ? {
        manualReviewReason: 'entitlement_snapshot_conflict',
        manualReviewReasonCodes: entitlementReasonCodes
      } : {}),
      paymentStatus: 'paid',
      splitStatus: 'pending',
      wechatTransactionId: transaction.transaction_id,
      paidOutTradeNo: transaction.out_trade_no,
      wechatSuccessTime: transaction.success_time,
      paidAt,
      wechatOrderTotalFen: amount.total,
      wechatPayerTotalFen: amount.payer_total,
      couponSubsidyFen,
      retainedCouponSubsidyFen: couponSubsidyFen,
      paidTableFeeFen: amount.payer_total,
      grossRefundedFen: 0,
      couponRefundedFen: 0,
      requestedRefundFen: 0,
      splitReturnedFen: 0,
      totalCostFen: settlement.totalCostFen,
      shopNetFen: settlement.shopNetFen,
      shopSettlementFen: settlement.shopNetFen + couponSubsidyFen,
      channelFeeFen: null,
      platformNetFen: null,
      updatedAt: store.serverDate()
    });
    await tx.updateSession(session._id, {
      status: 'closed',
      closedAt: paidAt,
      updatedAt: store.serverDate()
    });

    const occupancyId = occupancyIdFor(order.storeId, order.tableId);
    const occupancy = await tx.getOccupancy(occupancyId);
    if (
      occupancy
      && occupancy._id === occupancyId
      && occupancy.shopId === order.shopId
      && occupancy.storeId === order.storeId
      && occupancy.tableId === order.tableId
      && occupancy.sessionId === order.sessionId
    ) {
      await tx.removeOccupancy(occupancyId);
    }
    return { status: 'success', orderId: order.orderId };
  });
}

module.exports = {
  applyVerifiedTransaction,
  occupancyIdFor,
  officialSuccessTime,
  promotionAmount,
  verifiedCoachLessonIdForOrder,
  verifiedTrainingIdForOrder,
  verifiedReasons
};
