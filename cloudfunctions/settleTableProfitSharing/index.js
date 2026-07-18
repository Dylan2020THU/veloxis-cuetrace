'use strict';

const crypto = require('crypto');

const {
  CLAIM_LEASE_MS,
  assessSettlement,
  buildReceiverBody,
  buildSplitBody,
  buildUnfreezeBody,
  receiverRelationMatches,
  validateTerminal,
  successEventDocument,
  unfreezeNoForOrder
} = require('./lib/table-profit-sharing/table-profit-sharing');
const { financialEventId } = require('./lib/table-finance/state');

const BATCH_LIMIT = 20;
const PENDING_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const PENDING_TIMEOUT_REASON = 'PROFIT_SHARING_UNRESOLVED_24H';
const PENDING_ANOMALY_CONFLICT_REASON = 'PROFIT_SHARING_ANOMALY_ID_CONFLICT';
const RECOVERY_STAGES = Object.freeze([
  'receiver_setup',
  'split_query',
  'unfreeze_query',
  'legacy_query'
]);
const REMOTE_EVIDENCE_STAGES = Object.freeze([
  'receiver_setup',
  'split_query',
  'unfreeze_query'
]);

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactTimerEvent(event) {
  return isPlainObject(event)
    && Object.keys(event).length === 2
    && event.Type === 'Timer'
    && event.TriggerName === 'settleTableProfitSharingTimer';
}

function hasOpenid(value) {
  return isPlainObject(value)
    && typeof value.OPENID === 'string'
    && value.OPENID.length > 0;
}

function validAttemptId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && !/[\x00-\x1f\x7f]/.test(value);
}

function recoveryOutOrderNo(stage, expected) {
  if (stage === 'split_query') return expected.splitNo;
  if (stage === 'unfreeze_query') return expected.unfreezeNo;
  if (stage === 'legacy_query') {
    return expected.platformNetFen > 0
      ? expected.splitNo
      : expected.unfreezeNo;
  }
  return null;
}

function validRecovery(recovery, expected, now) {
  if (recovery === null || recovery === undefined) return true;
  if (
    !isPlainObject(recovery)
    || !Number.isSafeInteger(recovery.firstUncertainAtMs)
    || recovery.firstUncertainAtMs < 0
    || recovery.firstUncertainAtMs > now
    || recoveryDeadline(recovery) === null
    || !RECOVERY_STAGES.includes(recovery.stage)
    || (expected.platformNetFen === 0 && recovery.stage === 'split_query')
    || !Array.isArray(recovery.attemptEvidence)
    || recovery.attemptEvidence.length === 0
  ) return false;
  return recovery.attemptEvidence.every((attempt) => (
    isPlainObject(attempt)
    && validAttemptId(attempt.attemptId)
    && Number.isSafeInteger(attempt.attemptedAtMs)
    && attempt.attemptedAtMs >= 0
    && attempt.attemptedAtMs <= now
    && Number.isSafeInteger(attempt.recordedAtMs)
    && attempt.recordedAtMs >= attempt.attemptedAtMs
    && attempt.recordedAtMs >= recovery.firstUncertainAtMs
    && attempt.recordedAtMs <= now
    && RECOVERY_STAGES.includes(attempt.stage)
    && attempt.outOrderNo === recoveryOutOrderNo(attempt.stage, expected)
    && typeof attempt.outcomeCode === 'string'
    && attempt.outcomeCode.length > 0
    && attempt.outcomeCode.length <= 128
  )) && recovery.attemptEvidence[
    recovery.attemptEvidence.length - 1
  ].stage === recovery.stage;
}

function pendingResult(stage, outcomeCode, expected) {
  return {
    status: 'pending',
    evidence: {
      stage,
      outOrderNo: recoveryOutOrderNo(stage, expected),
      outcomeCode
    }
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = value[key] === undefined
        ? null
        : canonicalize(value[key]);
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

function recoveryDeadline(recovery) {
  if (!recovery || !Number.isSafeInteger(recovery.firstUncertainAtMs)) {
    return null;
  }
  const deadline = recovery.firstUncertainAtMs + PENDING_TIMEOUT_MS;
  return Number.isSafeInteger(deadline) ? deadline : null;
}

function timeoutExpected(order) {
  if (
    !isPlainObject(order)
    || typeof order._id !== 'string'
    || order._id.length === 0
    || order.orderId !== order._id
    || typeof order.splitNo !== 'string'
    || order.splitNo.length === 0
    || !Number.isSafeInteger(order.platformNetFen)
    || order.platformNetFen < 0
    || !isPlainObject(order.paymentProfileSnapshot)
    || typeof order.paymentProfileSnapshot.subMchid !== 'string'
    || order.paymentProfileSnapshot.subMchid.length === 0
  ) return null;
  let unfreezeNo;
  try {
    unfreezeNo = unfreezeNoForOrder(order.orderId);
  } catch (_error) {
    return null;
  }
  return {
    orderId: order.orderId,
    splitNo: order.splitNo,
    unfreezeNo,
    subMchid: order.paymentProfileSnapshot.subMchid,
    platformNetFen: order.platformNetFen
  };
}

function legacyRecovery(order, expected, now) {
  if (
    order.splitRecovery
    || !['processing', 'failed'].includes(order.splitStatus)
    || !isPlainObject(order.splitClaim)
    || !validAttemptId(order.splitClaim.attemptId)
    || !Number.isSafeInteger(order.splitClaim.claimedAt)
    || order.splitClaim.claimedAt < 0
    || order.splitClaim.claimedAt > now
  ) return null;
  const stage = 'legacy_query';
  return {
    firstUncertainAtMs: order.splitClaim.claimedAt,
    stage,
    attemptEvidence: [{
      attemptId: order.splitClaim.attemptId,
      attemptedAtMs: order.splitClaim.claimedAt,
      recordedAtMs: order.splitClaim.claimedAt,
      stage,
      outOrderNo: recoveryOutOrderNo(stage, expected),
      outcomeCode: 'LEGACY_ATTEMPT_STATE_UNKNOWN'
    }]
  };
}

function isCurrentSettlementCandidate(order, now) {
  if (
    !isPlainObject(order)
    || order.schemaVersion !== 2
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
    && isPlainObject(order.splitClaim)
    && Number.isSafeInteger(order.splitClaim.leaseExpiresAt)
    && order.splitClaim.leaseExpiresAt <= now;
}

function manualPatch(store, order, reasonCodes) {
  const claim = isPlainObject(order.splitClaim)
    ? {
        ...order.splitClaim,
        status: 'failed',
        completedAt: store.serverDate()
      }
    : null;
  return {
    orderStatus: 'manual_review',
    splitStatus: 'failed',
    splitClaim: claim,
    financeAutomationBlocked: true,
    manualReviewReason: 'profit_sharing',
    manualReviewReasonCodes: [...new Set(reasonCodes)].sort(),
    updatedAt: store.serverDate()
  };
}

function createSettleHandler(dependencies) {
  const functionNames = [
    'getContext',
    'loadConfig',
    'createWechatPayClient',
    'encryptSensitiveField',
    'nowMs',
    'makeAttemptId'
  ];
  if (
    !isPlainObject(dependencies)
    || !dependencies.store
    || functionNames.some((name) => typeof dependencies[name] !== 'function')
  ) {
    throw new TypeError('settleTableProfitSharing dependencies are invalid');
  }
  const {
    store,
    getContext,
    loadConfig,
    createWechatPayClient,
    encryptSensitiveField,
    nowMs,
    makeAttemptId
  } = dependencies;

  async function loadEvidence(tx, orderId, evidenceHash) {
    const paymentEventId = financialEventId('payment_succeeded', orderId);
    const feeEventId = typeof evidenceHash === 'string'
      ? financialEventId(
          'channel_fee_confirmed',
          `${orderId}:${evidenceHash}`
        )
      : null;
    const [paymentEvent, feeEvent] = await Promise.all([
      tx.getFinancialEvent(paymentEventId),
      feeEventId ? tx.getFinancialEvent(feeEventId) : null
    ]);
    return { paymentEvent, feeEvent };
  }

  async function claim(orderId, config, now) {
    const attemptId = makeAttemptId();
    if (!validAttemptId(attemptId) || !Number.isSafeInteger(now + CLAIM_LEASE_MS)) {
      throw new Error('invalid profit-sharing claim input');
    }
    return store.runTransaction(async (tx) => {
      const current = await tx.getOrder(orderId);
      if (!current || current._id !== orderId) return { status: 'conflict' };
      if (!isCurrentSettlementCandidate(current, now)) {
        return { status: 'conflict' };
      }
      const timeoutState = timeoutExpected(current);
      const migratedRecovery = timeoutState
        ? legacyRecovery(current, timeoutState, now)
        : null;
      const effectiveRecovery = current.splitRecovery || migratedRecovery;
      if (effectiveRecovery) {
        if (
          !timeoutState
          || !validRecovery(effectiveRecovery, timeoutState, now)
        ) {
          await tx.updateOrder(
            orderId,
            manualPatch(store, current, ['SPLIT_RECOVERY_INVALID'])
          );
          return { status: 'manual_review' };
        }
        if (recoveryDeadline(effectiveRecovery) <= now) {
          await finalizeTimeout(
            tx,
            current,
            timeoutState,
            effectiveRecovery
          );
          return { status: 'manual_review' };
        }
      }
      const evidence = await loadEvidence(
        tx,
        orderId,
        current.channelFeeEvidenceHash
      );
      const assessment = assessSettlement(
        current,
        evidence.paymentEvent,
        evidence.feeEvent,
        config,
        now
      );
      if (assessment.status === 'pending') {
        const uncappedNextAttemptAt = Math.max(
          Number.isSafeInteger(current.splitNextAttemptAt)
            ? current.splitNextAttemptAt
            : 0,
          now + CLAIM_LEASE_MS
        );
        const deadlineAt = recoveryDeadline(effectiveRecovery);
        const splitNextAttemptAt = deadlineAt === null
          ? uncappedNextAttemptAt
          : Math.min(uncappedNextAttemptAt, deadlineAt);
        await tx.updateOrder(orderId, {
          splitNextAttemptAt,
          ...(migratedRecovery ? { splitRecovery: migratedRecovery } : {}),
          updatedAt: store.serverDate()
        });
        return { status: 'pending' };
      }
      if (assessment.status === 'manual_review') {
        await tx.updateOrder(
          orderId,
          manualPatch(store, current, assessment.reasonCodes)
        );
        return { status: 'manual_review' };
      }
      if (!validRecovery(effectiveRecovery, assessment.expected, now)) {
        await tx.updateOrder(
          orderId,
          manualPatch(store, current, ['SPLIT_RECOVERY_INVALID'])
        );
        return { status: 'manual_review' };
      }
      const splitClaim = {
        attemptId,
        status: 'processing',
        claimedAt: now,
        leaseExpiresAt: now + CLAIM_LEASE_MS
      };
      await tx.updateOrder(orderId, {
        splitStatus: 'processing',
        splitClaim,
        ...(migratedRecovery ? { splitRecovery: migratedRecovery } : {}),
        updatedAt: store.serverDate()
      });
      return {
        status: 'claimed',
        attemptId,
        expected: assessment.expected,
        recoveryStage: effectiveRecovery
          ? effectiveRecovery.stage
          : (['processing', 'failed'].includes(current.splitStatus)
            ? 'legacy_query'
            : null)
      };
    });
  }

  async function ensureTimeoutAnomaly(
    tx,
    expected,
    recovery,
    createdAt
  ) {
    const identity = {
      reasonCodes: [PENDING_TIMEOUT_REASON],
      billDate: null,
      subMchid: expected.subMchid,
      orderId: expected.orderId,
      refundNo: null
    };
    const anomalyId = `anomaly_${stableHash(identity).slice(0, 58)}`;
    const existing = await tx.getFinanceAnomaly(anomalyId);
    const lastAttempt = recovery.attemptEvidence[
      recovery.attemptEvidence.length - 1
    ];
    const document = {
      ...identity,
      artifactId: null,
      source: 'profit_sharing',
      status: 'open',
      severity: 'blocking',
      operation: 'table_profit_sharing',
      splitNo: expected.splitNo,
      unfreezeNo: expected.unfreezeNo,
      firstUncertainAtMs: recovery.firstUncertainAtMs,
      deadlineAtMs: recoveryDeadline(recovery),
      attemptCount: recovery.attemptEvidence.length,
      lastOutcomeCode: lastAttempt.outcomeCode,
      createdAt
    };
    const matches = (candidate, expectedDocument, conflictingAnomalyId) => (
      isPlainObject(candidate)
      && stableHash({
        reasonCodes: candidate.reasonCodes,
        billDate: candidate.billDate,
        subMchid: candidate.subMchid,
        orderId: candidate.orderId,
        refundNo: candidate.refundNo
      }) === stableHash({
        reasonCodes: expectedDocument.reasonCodes,
        billDate: expectedDocument.billDate,
        subMchid: expectedDocument.subMchid,
        orderId: expectedDocument.orderId,
        refundNo: expectedDocument.refundNo
      })
      && candidate.artifactId === expectedDocument.artifactId
      && candidate.source === expectedDocument.source
      && candidate.operation === expectedDocument.operation
      && candidate.splitNo === expectedDocument.splitNo
      && candidate.unfreezeNo === expectedDocument.unfreezeNo
      && (
        conflictingAnomalyId === undefined
        || candidate.conflictingAnomalyId === conflictingAnomalyId
      )
    );
    const reopen = async (id, candidate) => {
      if (candidate.status === 'open' && candidate.severity === 'blocking') {
        return;
      }
      await tx.updateFinanceAnomaly(id, {
        status: 'open',
        severity: 'blocking',
        updatedAt: createdAt
      });
    };
    if (!existing) {
      await tx.setFinanceAnomaly(anomalyId, document);
      return {
        anomalyId,
        reasonCodes: [PENDING_TIMEOUT_REASON]
      };
    }
    if (matches(existing, document)) {
      await reopen(anomalyId, existing);
      return {
        anomalyId,
        reasonCodes: [PENDING_TIMEOUT_REASON]
      };
    }

    const conflictReasonCodes = [
      PENDING_ANOMALY_CONFLICT_REASON,
      PENDING_TIMEOUT_REASON
    ].sort();
    const conflictDocument = {
      ...document,
      reasonCodes: conflictReasonCodes,
      conflictingAnomalyId: anomalyId
    };
    const conflictId = `anomaly_${stableHash({
      identity: {
        reasonCodes: conflictDocument.reasonCodes,
        billDate: conflictDocument.billDate,
        subMchid: conflictDocument.subMchid,
        orderId: conflictDocument.orderId,
        refundNo: conflictDocument.refundNo
      },
      conflictingAnomalyId: anomalyId,
      namespace: 'profit_sharing_timeout_conflict'
    }).slice(0, 58)}`;
    const existingConflict = await tx.getFinanceAnomaly(conflictId);
    if (!existingConflict) {
      await tx.setFinanceAnomaly(conflictId, conflictDocument);
    } else if (matches(existingConflict, conflictDocument, anomalyId)) {
      await reopen(conflictId, existingConflict);
    } else {
      throw new Error('profit-sharing anomaly conflict record is occupied');
    }
    return {
      anomalyId: conflictId,
      reasonCodes: conflictReasonCodes
    };
  }

  async function finalizeTimeout(
    tx,
    current,
    expected,
    recovery,
    timedOutAt = store.serverDate()
  ) {
    const anomaly = await ensureTimeoutAnomaly(
      tx,
      expected,
      recovery,
      timedOutAt
    );
    await tx.updateOrder(current.orderId, {
      ...manualPatch(store, current, anomaly.reasonCodes),
      manualReviewAnomalyId: anomaly.anomalyId,
      splitNextAttemptAt: null,
      splitRecovery: {
        ...recovery,
        timedOutAt
      }
    });
    return anomaly.anomalyId;
  }

  async function guardRemoteCall(claimed) {
    const checkedAt = nowMs();
    if (!Number.isSafeInteger(checkedAt) || checkedAt < 0) return 'conflict';
    return store.runTransaction(async (tx) => {
      const current = await tx.getOrder(claimed.expected.orderId);
      if (
        !current
        || current._id !== claimed.expected.orderId
        || current.splitStatus !== 'processing'
        || !isPlainObject(current.splitClaim)
        || current.splitClaim.attemptId !== claimed.attemptId
        || current.splitClaim.status !== 'processing'
        || checkedAt < current.splitClaim.claimedAt
      ) return 'conflict';
      const recovery = current.splitRecovery || null;
      if (!validRecovery(recovery, claimed.expected, checkedAt)) {
        await tx.updateOrder(
          current.orderId,
          manualPatch(store, current, ['SPLIT_RECOVERY_INVALID'])
        );
        return 'manual_review';
      }
      if (recovery && recoveryDeadline(recovery) <= checkedAt) {
        await finalizeTimeout(tx, current, claimed.expected, recovery);
        return 'manual_review';
      }
      return 'allowed';
    });
  }

  async function finalizePending(claimed, evidence, pendingAt) {
    return store.runTransaction(async (tx) => {
      const current = await tx.getOrder(claimed.expected.orderId);
      if (
        !current
        || current._id !== claimed.expected.orderId
        || current.splitStatus !== 'processing'
        || !isPlainObject(current.splitClaim)
        || current.splitClaim.attemptId !== claimed.attemptId
        || current.splitClaim.status !== 'processing'
        || !isPlainObject(evidence)
        || !REMOTE_EVIDENCE_STAGES.includes(evidence.stage)
        || evidence.outOrderNo !== recoveryOutOrderNo(
          evidence.stage,
          claimed.expected
        )
        || typeof evidence.outcomeCode !== 'string'
        || evidence.outcomeCode.length === 0
        || evidence.outcomeCode.length > 128
        || !Number.isSafeInteger(pendingAt)
        || pendingAt < current.splitClaim.claimedAt
      ) return false;
      const previous = current.splitRecovery || null;
      if (!validRecovery(previous, claimed.expected, pendingAt)) return false;
      const recordedAt = store.serverDate();
      const attemptEvidence = {
        attemptId: claimed.attemptId,
        attemptedAtMs: current.splitClaim.claimedAt,
        stage: evidence.stage,
        outOrderNo: evidence.outOrderNo,
        outcomeCode: evidence.outcomeCode,
        recordedAtMs: pendingAt
      };
      const recovery = {
        firstUncertainAtMs: previous
          ? previous.firstUncertainAtMs
          : pendingAt,
        stage: evidence.stage,
        attemptEvidence: (previous
          ? previous.attemptEvidence
          : []).concat([attemptEvidence])
      };
      const deadlineAt = recoveryDeadline(recovery);
      if (deadlineAt === null) return false;
      if (pendingAt >= deadlineAt) {
        await finalizeTimeout(
          tx,
          current,
          claimed.expected,
          recovery,
          recordedAt
        );
        return 'manual_review';
      }
      const retryAt = pendingAt + CLAIM_LEASE_MS;
      if (!Number.isSafeInteger(retryAt)) return false;
      const nextAttemptAt = Math.min(retryAt, deadlineAt);
      await tx.updateOrder(current.orderId, {
        splitStatus: 'processing',
        splitClaim: {
          ...current.splitClaim,
          status: 'pending',
          completedAt: recordedAt,
          outcomeCode: evidence.outcomeCode,
          leaseExpiresAt: nextAttemptAt
        },
        splitRecovery: recovery,
        splitNextAttemptAt: nextAttemptAt,
        updatedAt: recordedAt
      });
      return 'pending';
    });
  }

  async function prepareUnfreezeSubmission(claimed, preparedAt) {
    return store.runTransaction(async (tx) => {
      const current = await tx.getOrder(claimed.expected.orderId);
      if (
        !current
        || current._id !== claimed.expected.orderId
        || current.splitStatus !== 'processing'
        || !isPlainObject(current.splitClaim)
        || current.splitClaim.attemptId !== claimed.attemptId
        || current.splitClaim.status !== 'processing'
        || !Number.isSafeInteger(preparedAt)
        || preparedAt < current.splitClaim.claimedAt
      ) return 'conflict';
      const previous = current.splitRecovery || null;
      if (!validRecovery(previous, claimed.expected, preparedAt)) {
        return 'conflict';
      }
      if (previous && previous.stage === 'unfreeze_query') {
        return 'query_only';
      }
      if (
        previous
        && recoveryDeadline(previous) <= preparedAt
      ) {
        await finalizeTimeout(
          tx,
          current,
          claimed.expected,
          previous
        );
        return 'manual_review';
      }
      const recovery = {
        firstUncertainAtMs: previous
          ? previous.firstUncertainAtMs
          : preparedAt,
        stage: 'unfreeze_query',
        attemptEvidence: (previous
          ? previous.attemptEvidence
          : []).concat([{
          attemptId: claimed.attemptId,
          attemptedAtMs: current.splitClaim.claimedAt,
          recordedAtMs: preparedAt,
          stage: 'unfreeze_query',
          outOrderNo: claimed.expected.unfreezeNo,
          outcomeCode: 'UNFREEZE_SUBMISSION_INTENT_RECORDED'
        }])
      };
      const deadlineAt = recoveryDeadline(recovery);
      const retryAt = preparedAt + CLAIM_LEASE_MS;
      if (deadlineAt === null || !Number.isSafeInteger(retryAt)) {
        return 'conflict';
      }
      const nextAttemptAt = Math.min(retryAt, deadlineAt);
      const updatedAt = store.serverDate();
      await tx.updateOrder(current.orderId, {
        splitClaim: {
          ...current.splitClaim,
          leaseExpiresAt: nextAttemptAt
        },
        splitRecovery: recovery,
        splitNextAttemptAt: nextAttemptAt,
        updatedAt
      });
      return 'prepared';
    });
  }

  async function finalizeManual(orderId, attemptId, reasonCodes) {
    return store.runTransaction(async (tx) => {
      const current = await tx.getOrder(orderId);
      if (
        !current
        || current._id !== orderId
        || current.splitStatus !== 'processing'
        || !isPlainObject(current.splitClaim)
        || current.splitClaim.attemptId !== attemptId
        || current.splitClaim.status !== 'processing'
      ) {
        return false;
      }
      await tx.updateOrder(
        orderId,
        manualPatch(store, current, reasonCodes)
      );
      return true;
    });
  }

  async function finalizeSuccess(
    claimed,
    config,
    splitTerminal,
    unfreezeTerminal
  ) {
    return store.runTransaction(async (tx) => {
      const current = await tx.getOrder(claimed.expected.orderId);
      if (
        !current
        || current._id !== claimed.expected.orderId
        || current.orderStatus !== 'complete'
        || current.splitStatus !== 'processing'
        || !isPlainObject(current.splitClaim)
        || current.splitClaim.attemptId !== claimed.attemptId
        || current.splitClaim.status !== 'processing'
      ) {
        return false;
      }
      const evidence = await loadEvidence(
        tx,
        current.orderId,
        current.channelFeeEvidenceHash
      );
      const assessment = assessSettlement(
        current,
        evidence.paymentEvent,
        evidence.feeEvent,
        config,
        current.splitClaim.leaseExpiresAt
      );
      if (
        assessment.status !== 'eligible'
        || JSON.stringify(assessment.expected) !== JSON.stringify(claimed.expected)
      ) {
        await tx.updateOrder(
          current.orderId,
          manualPatch(store, current, ['FINALIZE_EVIDENCE_CHANGED'])
        );
        return false;
      }
      const eventId = financialEventId(
        'profit_sharing_succeeded',
        current.orderId
      );
      if (await tx.getFinancialEvent(eventId)) {
        await tx.updateOrder(
          current.orderId,
          manualPatch(store, current, ['EXISTING_SPLIT_EVENT_CONFLICT'])
        );
        return false;
      }
      const completedAt = store.serverDate();
      await tx.setFinancialEvent(eventId, successEventDocument(
        claimed.expected,
        splitTerminal,
        unfreezeTerminal,
        completedAt
      ));
      await tx.updateOrder(current.orderId, {
        splitStatus: 'succeeded',
        splitClaim: {
          ...current.splitClaim,
          status: 'succeeded',
          completedAt
        },
        unfreezeNo: claimed.expected.unfreezeNo,
        wechatSplitOrderId: splitTerminal ? splitTerminal.orderId : null,
        wechatSplitDetailId: splitTerminal ? splitTerminal.detailId : null,
        wechatUnfreezeOrderId: unfreezeTerminal.orderId,
        splitCompletedAt: completedAt,
        updatedAt: completedAt
      });
      return true;
    });
  }

  async function settleClaim(claimed, config, client) {
    const expected = claimed.expected;
    const recoveryStage = claimed.recoveryStage;
    const gateRemoteCall = async () => {
      const permission = await guardRemoteCall(claimed);
      if (permission === 'allowed') return null;
      if (permission === 'manual_review') {
        return { status: 'manual_review_finalized' };
      }
      return { status: 'conflict' };
    };
    let splitTerminal = null;
    if (expected.platformNetFen > 0) {
      if (recoveryStage === null) {
        const encryptedName = encryptSensitiveField(
          config.platformReceiverName,
          config.encryptionPublicKey
        );
        const receiverGate = await gateRemoteCall();
        if (receiverGate) return receiverGate;
        try {
          const relation = await client.addReceiver(
            buildReceiverBody(expected, encryptedName)
          );
          if (!receiverRelationMatches(relation, expected)) {
            return { status: 'manual_review', reasonCodes: ['RECEIVER_RELATION_MISMATCH'] };
          }
        } catch (error) {
          const alreadyExists = error
            && error.name === 'WechatPayApiError'
            && error.code === 'RECEIVER_ALREADY_EXISTS';
          if (!alreadyExists) {
            return pendingResult(
              'receiver_setup',
              'RECEIVER_SETUP_UNAVAILABLE',
              expected
            );
          }
        }
        const splitGate = await gateRemoteCall();
        if (splitGate) return splitGate;
        try {
          await client.split(buildSplitBody(expected, encryptedName));
        } catch (_error) {
          // The deterministic split number is queried before any retry or inference.
        }
      }
      const splitQueryGate = await gateRemoteCall();
      if (splitQueryGate) return splitQueryGate;
      let remoteSplit;
      try {
        remoteSplit = await client.querySplit(expected.splitNo, {
          sub_mchid: expected.subMchid,
          transaction_id: expected.transactionId
        });
      } catch (_error) {
        if (recoveryStage === 'unfreeze_query') {
          return pendingResult(
            'unfreeze_query',
            'SPLIT_QUERY_UNAVAILABLE_DURING_UNFREEZE',
            expected
          );
        }
        return pendingResult(
          'split_query',
          'SPLIT_QUERY_UNAVAILABLE',
          expected
        );
      }
      const verifiedSplit = validateTerminal(remoteSplit, expected, 'split');
      if (verifiedSplit.status === 'pending') {
        if (recoveryStage === 'unfreeze_query') {
          return pendingResult(
            'unfreeze_query',
            'SPLIT_REMOTE_PROCESSING_DURING_UNFREEZE',
            expected
          );
        }
        return pendingResult(
          'split_query',
          'SPLIT_REMOTE_PROCESSING',
          expected
        );
      }
      if (verifiedSplit.status !== 'success') return verifiedSplit;
      splitTerminal = verifiedSplit.expected;
    }

    if (recoveryStage === null || recoveryStage === 'split_query') {
      const preparedAt = nowMs();
      const preparation = await prepareUnfreezeSubmission(
        claimed,
        preparedAt
      );
      if (preparation === 'manual_review') {
        return { status: 'manual_review_finalized' };
      }
      if (preparation === 'conflict') return { status: 'conflict' };
      if (preparation === 'prepared') {
        const unfreezeGate = await gateRemoteCall();
        if (unfreezeGate) return unfreezeGate;
        try {
          await client.unfreeze(buildUnfreezeBody(expected));
        } catch (_error) {
          // The persisted intent makes every later recovery query-only.
        }
      }
    }
    const unfreezeQueryGate = await gateRemoteCall();
    if (unfreezeQueryGate) return unfreezeQueryGate;
    let remoteUnfreeze;
    try {
      remoteUnfreeze = await client.querySplit(expected.unfreezeNo, {
        sub_mchid: expected.subMchid,
        transaction_id: expected.transactionId
      });
    } catch (_error) {
      return pendingResult(
        'unfreeze_query',
        'UNFREEZE_QUERY_UNAVAILABLE',
        expected
      );
    }
    const verifiedUnfreeze = validateTerminal(
      remoteUnfreeze,
      expected,
      'unfreeze'
    );
    if (verifiedUnfreeze.status === 'pending') {
      return pendingResult(
        'unfreeze_query',
        'UNFREEZE_REMOTE_PROCESSING',
        expected
      );
    }
    if (verifiedUnfreeze.status !== 'success') return verifiedUnfreeze;
    return {
      status: 'success',
      splitTerminal,
      unfreezeTerminal: verifiedUnfreeze.expected
    };
  }

  return async function settleTableProfitSharing(event, context = {}) {
    let runtimeContext;
    try {
      runtimeContext = getContext();
    } catch (_error) {
      return { ok: false, code: 'ACCESS_DENIED' };
    }
    if (
      !exactTimerEvent(event)
      || hasOpenid(context)
      || hasOpenid(runtimeContext)
    ) {
      return { ok: false, code: 'ACCESS_DENIED' };
    }

    let config;
    let client;
    let now;
    try {
      config = loadConfig();
      client = createWechatPayClient(config);
      now = nowMs();
      if (!Number.isSafeInteger(now) || now < 0) throw new Error('invalid clock');
    } catch (_error) {
      return { ok: false, code: 'PROFIT_SHARING_NOT_AVAILABLE' };
    }

    let candidates;
    try {
      candidates = await store.listSettlementCandidates(now, BATCH_LIMIT);
    } catch (_error) {
      return { ok: false, code: 'PROFIT_SHARING_FAILED' };
    }
    if (!Array.isArray(candidates)) {
      return { ok: false, code: 'PROFIT_SHARING_FAILED' };
    }

    const summary = {
      ok: true,
      scanned: 0,
      claimed: 0,
      succeeded: 0,
      pending: 0,
      manualReview: 0,
      conflicts: 0
    };
    for (const candidate of candidates) {
      summary.scanned += 1;
      let attemptNow;
      try {
        attemptNow = nowMs();
        if (!Number.isSafeInteger(attemptNow) || attemptNow < now) {
          throw new Error('invalid attempt clock');
        }
      } catch (_error) {
        summary.conflicts += 1;
        continue;
      }
      let claimed;
      try {
        claimed = await claim(candidate && candidate._id, config, attemptNow);
      } catch (_error) {
        summary.conflicts += 1;
        continue;
      }
      if (claimed.status !== 'claimed') {
        if (claimed.status === 'pending') summary.pending += 1;
        else if (claimed.status === 'manual_review') summary.manualReview += 1;
        else summary.conflicts += 1;
        continue;
      }
      summary.claimed += 1;
      let remote;
      try {
        remote = await settleClaim(claimed, config, client);
      } catch (_error) {
        const stage = claimed.recoveryStage === 'legacy_query'
          ? (claimed.expected.platformNetFen > 0
            ? 'split_query'
            : 'unfreeze_query')
          : (claimed.recoveryStage || 'receiver_setup');
        remote = pendingResult(stage, 'REMOTE_CALL_UNEXPECTED', claimed.expected);
      }
      if (remote.status === 'pending') {
        let pendingAt;
        try {
          pendingAt = nowMs();
          if (!Number.isSafeInteger(pendingAt) || pendingAt < attemptNow) {
            throw new Error('invalid pending clock');
          }
        } catch (_error) {
          summary.conflicts += 1;
          continue;
        }
        const finalized = await finalizePending(
          claimed,
          remote.evidence,
          pendingAt
        );
        if (finalized === 'pending') summary.pending += 1;
        else if (finalized === 'manual_review') summary.manualReview += 1;
        else summary.conflicts += 1;
        continue;
      }
      if (remote.status === 'manual_review') {
        if (await finalizeManual(
          claimed.expected.orderId,
          claimed.attemptId,
          remote.reasonCodes
        )) summary.manualReview += 1;
        else summary.conflicts += 1;
        continue;
      }
      if (remote.status === 'manual_review_finalized') {
        summary.manualReview += 1;
        continue;
      }
      if (remote.status === 'conflict') {
        summary.conflicts += 1;
        continue;
      }
      if (remote.status !== 'success') {
        if (await finalizeManual(
          claimed.expected.orderId,
          claimed.attemptId,
          ['REMOTE_STATE_UNKNOWN']
        )) summary.manualReview += 1;
        else summary.conflicts += 1;
        continue;
      }
      if (await finalizeSuccess(
        claimed,
        config,
        remote.splitTerminal,
        remote.unfreezeTerminal
      )) summary.succeeded += 1;
      else summary.conflicts += 1;
    }
    return summary;
  };
}

function optionalData(result) {
  return result && result.data ? result.data : null;
}

function listData(result) {
  return result && Array.isArray(result.data) ? result.data : [];
}

function transactionStore(source) {
  return {
    async getOrder(id) {
      return optionalData(await source.collection('shop_orders').doc(id).get());
    },
    async getFinancialEvent(id) {
      return optionalData(await source.collection('financial_events').doc(id).get());
    },
    async getFinanceAnomaly(id) {
      return optionalData(await source.collection('finance_anomalies').doc(id).get());
    },
    async updateOrder(id, data) {
      await source.collection('shop_orders').doc(id).update({ data });
    },
    async setFinancialEvent(id, document) {
      await source.collection('financial_events').doc(id).set({
        data: { _id: id, ...document }
      });
    },
    async setFinanceAnomaly(id, document) {
      await source.collection('finance_anomalies').doc(id).set({
        data: { _id: id, ...document }
      });
    },
    async updateFinanceAnomaly(id, data) {
      await source.collection('finance_anomalies').doc(id).update({ data });
    }
  };
}

function createCloudbaseProfitSharingStore(db) {
  if (
    !db
    || typeof db.collection !== 'function'
    || typeof db.runTransaction !== 'function'
    || typeof db.serverDate !== 'function'
    || !db.command
    || typeof db.command.lte !== 'function'
    || typeof db.command.in !== 'function'
    || typeof db.command.exists !== 'function'
  ) {
    throw new TypeError('CloudBase database is required');
  }
  return Object.freeze({
    async listSettlementCandidates(now, limit) {
      if (
        !Number.isSafeInteger(now)
        || now < 0
        || !Number.isSafeInteger(limit)
        || limit <= 0
      ) {
        throw new TypeError('profit-sharing query bounds are invalid');
      }
      const common = {
        schemaVersion: 2,
        orderStatus: 'complete',
        paymentStatus: db.command.in(['paid', 'partially_refunded', 'refunded'])
      };
      const states = [
        { splitStatus: 'pending' },
        { splitStatus: 'failed' },
        {
          splitStatus: 'processing',
          'splitClaim.leaseExpiresAt': db.command.lte(now)
        }
      ];
      const query = (splitState, due, virgin) => {
        let request = db.collection('shop_orders')
          .where({
            ...common,
            ...splitState,
            splitNextAttemptAt: due
          });
        if (!virgin) request = request.orderBy('splitNextAttemptAt', 'asc');
        return request
          .orderBy('paidAt', 'asc')
          .orderBy('_id', 'asc')
          .limit(limit)
          .get();
      };
      const pages = await Promise.all(states.flatMap((splitState) => [
        query(splitState, db.command.lte(now), false),
        query(splitState, db.command.exists(false), true)
      ]));
      const due = new Map();
      const virgin = new Map();
      for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
        const page = pages[pageIndex];
        const candidates = pageIndex % 2 === 0 ? due : virgin;
        for (const order of listData(page)) {
          if (!order || typeof order._id !== 'string' || !order._id) {
            throw new Error('profit-sharing query returned an invalid order ID');
          }
          if (
            candidates === due
            && (
              !Number.isSafeInteger(order.splitNextAttemptAt)
              || order.splitNextAttemptAt < 0
              || order.splitNextAttemptAt > now
            )
          ) {
            throw new Error('profit-sharing due query returned an invalid time');
          }
          if (!candidates.has(order._id)) candidates.set(order._id, order);
        }
      }
      const comparePaid = (left, right) => {
        const leftPaidAt = Number.isSafeInteger(left.paidAt)
          ? left.paidAt
          : Number.MAX_SAFE_INTEGER;
        const rightPaidAt = Number.isSafeInteger(right.paidAt)
          ? right.paidAt
          : Number.MAX_SAFE_INTEGER;
        return leftPaidAt - rightPaidAt
          || left._id.localeCompare(right._id);
      };
      const dueOrders = [...due.values()].sort((left, right) => (
        left.splitNextAttemptAt - right.splitNextAttemptAt
        || comparePaid(left, right)
      ));
      const virginOrders = [...virgin.values()].sort(comparePaid);
      const selected = [];
      const selectedIds = new Set();
      const append = (order) => {
        if (
          order
          && selected.length < limit
          && !selectedIds.has(order._id)
        ) {
          selectedIds.add(order._id);
          selected.push(order);
        }
      };
      const maximum = Math.max(dueOrders.length, virginOrders.length);
      for (let index = 0; index < maximum && selected.length < limit; index += 1) {
        append(dueOrders[index]);
        append(virginOrders[index]);
      }
      return selected;
    },
    runTransaction(work) {
      return db.runTransaction((transaction) => work(transactionStore(transaction)));
    },
    serverDate() {
      return db.serverDate();
    }
  });
}

let productionHandler = null;

function getProductionHandler() {
  if (productionHandler) return productionHandler;
  const cloud = require('wx-server-sdk');
  const { loadWechatPayConfig } = require('./lib/wechatpay-v3/config');
  const {
    createWechatPayClient,
    encryptSensitiveField
  } = require('./lib/wechatpay-v3/client');
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
  productionHandler = createSettleHandler({
    store: createCloudbaseProfitSharingStore(
      cloud.database({ throwOnNotFound: false })
    ),
    getContext: () => cloud.getWXContext(),
    loadConfig: () => loadWechatPayConfig(),
    createWechatPayClient,
    encryptSensitiveField,
    nowMs: () => Date.now(),
    makeAttemptId: () => crypto.randomBytes(16).toString('hex')
  });
  return productionHandler;
}

exports.createSettleHandler = createSettleHandler;
exports.createCloudbaseProfitSharingStore = createCloudbaseProfitSharingStore;
exports.main = (event, context) => getProductionHandler()(event, context);
