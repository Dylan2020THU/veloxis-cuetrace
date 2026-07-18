'use strict';

const {
  POLICY_VERSION,
  buildOrderConfirmation,
  orderSnapshotToken,
  stableHash
} = require('./table-reconciliation');

const ORDER_REFUND_LIMIT = 101;
const ANOMALY_SEVERITY = 'blocking';

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionalData(result) {
  return result && result.data ? result.data : null;
}

function listData(result) {
  return result && Array.isArray(result.data) ? result.data : [];
}

function exactPositiveLimit(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 1000;
}

function exactTimeRange(input) {
  return isPlainObject(input)
    && Number.isSafeInteger(input.startMs)
    && input.startMs >= 0
    && Number.isSafeInteger(input.endMs)
    && input.endMs > input.startMs
    && exactPositiveLimit(input.limit);
}

function anomalyIdentity(input) {
  const reasonCodes = [...new Set(
    Array.isArray(input.reasonCodes) ? input.reasonCodes : ['FINANCE_RECONCILIATION']
  )].filter((value) => typeof value === 'string' && value.length > 0).sort();
  return {
    reasonCodes,
    billDate: input.billDate || null,
    subMchid: input.subMchid || null,
    orderId: input.orderId || null,
    refundNo: input.refundNo || null
  };
}

function anomalyId(input) {
  return `anomaly_${stableHash(anomalyIdentity(input)).slice(0, 58)}`;
}

async function setAnomalyIfAbsent(source, serverDate, input) {
  const identity = anomalyIdentity(input);
  const id = anomalyId(input);
  const reference = source.collection('finance_anomalies').doc(id);
  const existing = optionalData(await reference.get());
  if (!existing) {
    await reference.set({
      data: {
        _id: id,
        ...identity,
        artifactId: input.artifactId || null,
        source: 'wechat_trade_bill',
        status: 'open',
        severity: ANOMALY_SEVERITY,
        createdAt: serverDate()
      }
    });
  } else if (existing.severity !== ANOMALY_SEVERITY) {
    await reference.update({
      data: {
        severity: ANOMALY_SEVERITY,
        updatedAt: serverDate()
      }
    });
  }
  return id;
}

function equivalent(left, right) {
  return stableHash(left) === stableHash(right);
}

function eventMatches(existing, proposed) {
  if (!isPlainObject(existing) || !isPlainObject(proposed)) return false;
  const comparable = { ...existing };
  delete comparable._id;
  comparable.createdAt = null;
  const expected = {
    ...proposed,
    confirmedAtMs: comparable.confirmedAtMs
  };
  return equivalent(comparable, expected);
}

function manualReviewFields(current, reasonCodes) {
  const foreignManualReview = current.orderStatus === 'manual_review'
    && current.manualReviewReason !== 'finance_reconciliation';
  return {
    orderStatus: 'manual_review',
    financeAutomationBlocked: true,
    manualReviewReason: foreignManualReview
      ? (current.manualReviewReason || 'existing_manual_review')
      : 'finance_reconciliation',
    manualReviewReasonCodes: foreignManualReview
      ? (Array.isArray(current.manualReviewReasonCodes)
        ? current.manualReviewReasonCodes
        : [])
      : reasonCodes
  };
}

function createCloudbaseReconciliationStore(db) {
  if (
    !db
    || typeof db.collection !== 'function'
    || typeof db.runTransaction !== 'function'
    || typeof db.serverDate !== 'function'
    || !db.command
    || typeof db.command.gte !== 'function'
    || typeof db.command.lt !== 'function'
    || typeof db.command.lte !== 'function'
    || typeof db.command.in !== 'function'
    || typeof db.command.and !== 'function'
  ) {
    throw new TypeError('CloudBase database is required');
  }
  const range = (startMs, endMs) => db.command.and([
    db.command.gte(startMs),
    db.command.lt(endMs)
  ]);

  return Object.freeze({
    serverDate() {
      return db.serverDate();
    },

    async listRetryableBillDates(input) {
      if (
        !isPlainObject(input)
        || typeof input.beforeBillDate !== 'string'
        || !/^\d{4}-\d{2}-\d{2}$/.test(input.beforeBillDate)
        || !Number.isSafeInteger(input.nowMs)
        || input.nowMs < 0
        || !exactPositiveLimit(input.limit)
      ) throw new TypeError('retryable run query is invalid');
      const page = await db.collection('finance_reconciliation_runs')
        .where({
          status: 'running',
          leaseExpiresAt: db.command.lte(input.nowMs),
          billDate: db.command.lt(input.beforeBillDate)
        })
        .orderBy('leaseExpiresAt', 'asc')
        .orderBy('billDate', 'asc')
        .limit(input.limit)
        .get();
      return [...new Set(listData(page)
        .map((value) => value && value.billDate)
        .filter((value) => (
          typeof value === 'string'
          && /^\d{4}-\d{2}-\d{2}$/.test(value)
        )))];
    },

    async listUnreconciledPaidOrders(input) {
      if (
        !isPlainObject(input)
        || !Number.isSafeInteger(input.beforeMs)
        || input.beforeMs < 0
        || !exactPositiveLimit(input.limit)
      ) throw new TypeError('unreconciled payment query is invalid');
      const query = (orderStatus) => db.collection('shop_orders')
        .where({
          schemaVersion: 2,
          orderStatus,
          paymentStatus: db.command.in(['paid', 'partially_refunded', 'refunded']),
          paymentBillFeeEvidence: null,
          paymentBillDiscoveryCompletedAt: null,
          paidAt: db.command.lt(input.beforeMs)
        })
        .orderBy('paidAt', 'asc')
        .orderBy('_id', 'asc')
        .limit(input.limit)
        .get();
      const pages = await Promise.all(
        ['complete', 'manual_review'].map((orderStatus) => query(orderStatus))
      );
      const unique = new Map();
      for (const page of pages) {
        for (const value of listData(page)) {
          if (
            !value
            || typeof value._id !== 'string'
            || !value._id
            || !['complete', 'manual_review'].includes(value.orderStatus)
            || !Number.isSafeInteger(value.paidAt)
            || value.paidAt < 0
            || value.paidAt >= input.beforeMs
          ) throw new Error('unreconciled payment query returned invalid data');
          if (!unique.has(value._id)) unique.set(value._id, value);
        }
      }
      return [...unique.values()].sort((left, right) => (
        (left.orderStatus === 'complete' ? 0 : 1)
        - (right.orderStatus === 'complete' ? 0 : 1)
        || left.paidAt - right.paidAt
        || left._id.localeCompare(right._id)
      )).slice(0, input.limit);
    },

    async claimRun(input) {
      if (
        !isPlainObject(input)
        || typeof input.runId !== 'string'
        || input.policyVersion !== POLICY_VERSION
        || typeof input.billDate !== 'string'
        || typeof input.attemptId !== 'string'
        || !Number.isSafeInteger(input.claimedAt)
        || !Number.isSafeInteger(input.leaseExpiresAt)
        || input.leaseExpiresAt <= input.claimedAt
      ) throw new TypeError('reconciliation run claim is invalid');
      return db.runTransaction(async (transaction) => {
        const reference = transaction.collection('finance_reconciliation_runs')
          .doc(input.runId);
        const existing = optionalData(await reference.get());
        if (
          existing
          && existing.status === 'completed'
          && input.reopenCompleted !== true
        ) {
          return { status: 'completed', run: existing };
        }
        if (
          existing
          && existing.status === 'running'
          && Number.isSafeInteger(existing.leaseExpiresAt)
          && existing.leaseExpiresAt > input.claimedAt
        ) return { status: 'active', run: existing };
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
            : (existing && existing.status === 'completed' ? 1 : 0),
          createdAt: existing && existing.createdAt
            ? existing.createdAt
            : db.serverDate(),
          updatedAt: db.serverDate()
        };
        await reference.set({ data: run });
        return { status: 'claimed', run };
      });
    },

    async completeRun(input) {
      if (!isPlainObject(input)) throw new TypeError('run completion is invalid');
      return db.runTransaction(async (transaction) => {
        const reference = transaction.collection('finance_reconciliation_runs')
          .doc(input.runId);
        const current = optionalData(await reference.get());
        if (
          !current
          || current.status !== 'running'
          || current.attemptId !== input.attemptId
        ) return false;
        await reference.update({
          data: {
            status: 'completed',
            completedAt: input.completedAt,
            summary: input.summary,
            updatedAt: db.serverDate()
          }
        });
        return true;
      });
    },

    async renewRun(input) {
      if (
        !isPlainObject(input)
        || typeof input.runId !== 'string'
        || typeof input.attemptId !== 'string'
        || !Number.isSafeInteger(input.heartbeatAt)
        || !Number.isSafeInteger(input.leaseExpiresAt)
        || input.leaseExpiresAt <= input.heartbeatAt
      ) throw new TypeError('run renewal is invalid');
      return db.runTransaction(async (transaction) => {
        const reference = transaction.collection('finance_reconciliation_runs')
          .doc(input.runId);
        const current = optionalData(await reference.get());
        if (
          !current
          || current.status !== 'running'
          || current.attemptId !== input.attemptId
        ) return false;
        await reference.update({
          data: {
            heartbeatAt: input.heartbeatAt,
            leaseExpiresAt: input.leaseExpiresAt,
            updatedAt: db.serverDate()
          }
        });
        return true;
      });
    },

    async deferRun(input) {
      if (
        !isPlainObject(input)
        || typeof input.runId !== 'string'
        || typeof input.attemptId !== 'string'
        || !Number.isSafeInteger(input.deferredAt)
        || !Number.isSafeInteger(input.leaseExpiresAt)
        || input.leaseExpiresAt <= input.deferredAt
        || !isPlainObject(input.summary)
      ) throw new TypeError('run deferral is invalid');
      return db.runTransaction(async (transaction) => {
        const reference = transaction.collection('finance_reconciliation_runs')
          .doc(input.runId);
        const current = optionalData(await reference.get());
        if (
          !current
          || current.status !== 'running'
          || current.attemptId !== input.attemptId
        ) return false;
        await reference.update({
          data: {
            deferredAt: input.deferredAt,
            leaseExpiresAt: input.leaseExpiresAt,
            lastAttemptSummary: input.summary,
            updatedAt: db.serverDate()
          }
        });
        return true;
      });
    },

    async listBillProfiles(limit) {
      if (!exactPositiveLimit(limit)) throw new TypeError('profile query limit is invalid');
      return listData(await db.collection('shop_payment_profiles')
        .where({
          schemaVersion: 1,
          status: 'ready',
          policyVersion: POLICY_VERSION
        })
        .orderBy('_id', 'asc')
        .limit(limit)
        .get());
    },

    async recordAnomaly(input) {
      return db.runTransaction((transaction) => (
        setAnomalyIfAbsent(transaction, () => db.serverDate(), input)
      ));
    },

    async claimArtifact(input) {
      if (
        !isPlainObject(input)
        || !isPlainObject(input.artifact)
        || typeof input.sha1 !== 'string'
        || !/^[0-9a-f]{40}$/.test(input.sha1)
        || input.hashType !== 'SHA1'
        || typeof input.signedHashValue !== 'string'
        || input.signedHashValue.toLowerCase() !== input.sha1
        || !Number.isSafeInteger(input.byteLength)
        || input.byteLength <= 0
      ) throw new TypeError('bill artifact claim is invalid');
      return db.runTransaction(async (transaction) => {
        const reference = transaction.collection('wechat_bill_artifacts')
          .doc(input.artifact.artifactId);
        const existing = optionalData(await reference.get());
        if (existing && existing.sha1 !== input.sha1) {
          return { status: 'conflict', artifact: existing };
        }
        if (existing && existing.sha1 === input.sha1 && existing.fileId) {
          return { status: 'replay', artifact: existing };
        }
        if (
          existing
          && existing.sha1 === input.sha1
          && Number.isSafeInteger(existing.leaseExpiresAt)
          && existing.leaseExpiresAt > input.claimedAt
          && existing.attemptId !== input.attemptId
        ) return { status: 'active', artifact: existing };
        const document = {
          ...(existing || {}),
          _id: input.artifact.artifactId,
          ...input.artifact,
          sha1: input.sha1,
          signedHashType: input.hashType,
          signedHashValue: input.signedHashValue,
          calculatedSha1: input.sha1,
          byteLength: input.byteLength,
          sourceMetadata: input.sourceMetadata,
          attemptId: input.attemptId,
          claimedAt: input.claimedAt,
          leaseExpiresAt: input.leaseExpiresAt,
          parseStatus: existing && existing.parseStatus
            ? existing.parseStatus
            : 'claimed',
          storageVisibility: 'private',
          createdAt: existing && existing.createdAt
            ? existing.createdAt
            : db.serverDate(),
          updatedAt: db.serverDate()
        };
        await reference.set({ data: document });
        return {
          status: existing ? 'resumed' : 'claimed',
          artifact: document
        };
      });
    },

    async markArtifactUploaded(input) {
      return db.runTransaction(async (transaction) => {
        const reference = transaction.collection('wechat_bill_artifacts')
          .doc(input.artifactId);
        const current = optionalData(await reference.get());
        if (
          !current
          || current.sha1 !== input.sha1
          || current.attemptId !== input.attemptId
        ) return false;
        await reference.update({
          data: {
            fileId: input.fileId,
            uploadedAt: input.uploadedAt,
            storageVisibility: 'private',
            contentType: input.contentType,
            parseStatus: 'uploaded',
            updatedAt: db.serverDate()
          }
        });
        return true;
      });
    },

    async markArtifactParsed(input) {
      return db.runTransaction(async (transaction) => {
        const reference = transaction.collection('wechat_bill_artifacts')
          .doc(input.artifactId);
        const current = optionalData(await reference.get());
        if (!current || current.sha1 !== input.sha1) return false;
        await reference.update({
          data: {
            parseStatus: 'parsed',
            parsedAt: input.parsedAt,
            rowCount: input.rowCount,
            headerCount: input.headerCount,
            updatedAt: db.serverDate()
          }
        });
        return true;
      });
    },

    async listOrdersForBill(input) {
      if (
        !exactTimeRange(input)
        || typeof input.subMchid !== 'string'
        || !/^[0-9]{8,32}$/.test(input.subMchid)
      ) throw new TypeError('order bill query is invalid');
      return listData(await db.collection('shop_orders')
        .where({
          schemaVersion: 2,
          'paymentProfileSnapshot.subMchid': input.subMchid,
          paidAt: range(input.startMs, input.endMs)
        })
        .orderBy('paidAt', 'asc')
        .orderBy('_id', 'asc')
        .limit(input.limit)
        .get());
    },

    async listRefundsForBill(input) {
      if (
        !exactTimeRange(input)
        || typeof input.subMchid !== 'string'
        || !/^[0-9]{8,32}$/.test(input.subMchid)
      ) throw new TypeError('refund bill query is invalid');
      const query = (field, extra = {}) => db.collection('shop_refunds')
        .where({
          subMchid: input.subMchid,
          ...extra,
          [field]: range(input.startMs, input.endMs)
        })
        .orderBy(field, 'asc')
        .orderBy('_id', 'asc')
        .limit(input.limit)
        .get();
      const pages = await Promise.all([
        query('refundCreatedAt'),
        query('requestedAt', { refundCreatedAt: null })
      ]);
      const unique = new Map();
      for (const page of pages) {
        for (const value of listData(page)) {
          if (!value || typeof value._id !== 'string' || !value._id) {
            throw new Error('refund bill query returned an invalid document');
          }
          if (!unique.has(value._id)) unique.set(value._id, value);
        }
      }
      return [...unique.values()].sort((left, right) => {
        const leftTime = Number.isSafeInteger(left.refundCreatedAt)
          ? left.refundCreatedAt
          : left.requestedAt;
        const rightTime = Number.isSafeInteger(right.refundCreatedAt)
          ? right.refundCreatedAt
          : right.requestedAt;
        return leftTime - rightTime || left._id.localeCompare(right._id);
      }).slice(0, input.limit);
    },

    async listRefundsForOrder(input) {
      if (
        !isPlainObject(input)
        || typeof input.orderId !== 'string'
        || !input.orderId
        || !exactPositiveLimit(input.limit)
      ) throw new TypeError('order refund query is invalid');
      return listData(await db.collection('shop_refunds')
        .where({ orderId: input.orderId })
        .orderBy('_id', 'asc')
        .limit(input.limit)
        .get());
    },

    async getOrder(id) {
      if (typeof id !== 'string' || !id) throw new TypeError('order ID is invalid');
      return optionalData(await db.collection('shop_orders').doc(id).get());
    },

    async getRefund(id) {
      if (typeof id !== 'string' || !id) throw new TypeError('refund ID is invalid');
      return optionalData(await db.collection('shop_refunds').doc(id).get());
    },

    async blockOrder(input) {
      if (!isPlainObject(input) || typeof input.orderId !== 'string') {
        throw new TypeError('finance block input is invalid');
      }
      return db.runTransaction(async (transaction) => {
        const reference = transaction.collection('shop_orders').doc(input.orderId);
        const current = optionalData(await reference.get());
        if (!current || current._id !== input.orderId) return false;
        const reasonCodes = anomalyIdentity(input).reasonCodes;
        await reference.update({
          data: {
            ...manualReviewFields(current, reasonCodes),
            paymentBillDiscoveryCompletedAt: db.serverDate(),
            updatedAt: db.serverDate()
          }
        });
        await setAnomalyIfAbsent(transaction, () => db.serverDate(), input);
        return true;
      });
    },

    async applyOrderEvidence(input) {
      if (
        !isPlainObject(input)
        || typeof input.orderId !== 'string'
        || !/^[0-9a-f]{64}$/.test(input.expectedOrderToken || '')
        || !Array.isArray(input.refundSnapshots)
      ) throw new TypeError('order evidence input is invalid');
      return db.runTransaction(async (transaction) => {
        const orderReference = transaction.collection('shop_orders').doc(input.orderId);
        const current = optionalData(await orderReference.get());
        if (!current || orderSnapshotToken(current) !== input.expectedOrderToken) {
          return { status: 'conflict', reasonCodes: ['ORDER_CAS_CONFLICT'] };
        }
        const refunds = [];
        for (const snapshot of input.refundSnapshots) {
          if (
            !isPlainObject(snapshot)
            || typeof snapshot._id !== 'string'
            || !snapshot._id
            || snapshot.orderId !== input.orderId
          ) return { status: 'conflict', reasonCodes: ['REFUND_CAS_CONFLICT'] };
          const currentRefund = optionalData(
            await transaction.collection('shop_refunds').doc(snapshot._id).get()
          );
          if (!currentRefund || !equivalent(currentRefund, snapshot)) {
            return { status: 'conflict', reasonCodes: ['REFUND_CAS_CONFLICT'] };
          }
          refunds.push(currentRefund);
        }
        if (refunds.length >= ORDER_REFUND_LIMIT) {
          const reasons = ['ORDER_REFUND_LIMIT_EXCEEDED'];
          await orderReference.update({
            data: {
              ...manualReviewFields(current, reasons),
              updatedAt: db.serverDate()
            }
          });
          await setAnomalyIfAbsent(transaction, () => db.serverDate(), {
            ...input,
            reasonCodes: reasons
          });
          return { status: 'manual_review', reasonCodes: reasons };
        }
        const result = buildOrderConfirmation({
          order: current,
          refunds,
          paymentEvidence: input.paymentEvidence,
          refundEvidences: input.refundEvidences,
          confirmedAtMs: input.confirmedAtMs,
          nowMs: input.nowMs
        });
        if (result.status === 'manual_review' && !result.orderPatch) {
          result.orderPatch = manualReviewFields(current, result.reasonCodes);
        }

        for (const [refundNo, patch] of Object.entries(result.refundPatches || {})) {
          await transaction.collection('shop_refunds').doc(refundNo).update({
            data: { ...patch, updatedAt: db.serverDate() }
          });
        }

        let duplicate = false;
        if (result.eventDocument) {
          const eventReference = transaction.collection('financial_events')
            .doc(result.eventId);
          const existing = optionalData(await eventReference.get());
          if (existing && !eventMatches(existing, result.eventDocument)) {
            const reasons = ['EXISTING_FEE_EVENT_CONFLICT'];
            await orderReference.update({
              data: {
                ...manualReviewFields(current, reasons),
                updatedAt: db.serverDate()
              }
            });
            await setAnomalyIfAbsent(transaction, () => db.serverDate(), {
              ...input,
              reasonCodes: reasons
            });
            return { status: 'manual_review', reasonCodes: reasons };
          }
          if (!existing) {
            await eventReference.set({
              data: {
                _id: result.eventId,
                ...result.eventDocument,
                createdAt: db.serverDate()
              }
            });
          } else duplicate = true;
        }

        const currentPatch = {};
        for (const name of Object.keys(result.orderPatch || {})) {
          currentPatch[name] = current[name];
        }
        if (result.orderPatch && !equivalent(currentPatch, result.orderPatch)) {
          await orderReference.update({
            data: { ...result.orderPatch, updatedAt: db.serverDate() }
          });
        }
        if (['blocked', 'manual_review', 'pending'].includes(result.status)) {
          await setAnomalyIfAbsent(transaction, () => db.serverDate(), {
            ...input,
            reasonCodes: result.reasonCodes
          });
        }
        if (duplicate && result.status === 'confirmed') {
          return { ...result, status: 'duplicate' };
        }
        return result;
      });
    }
  });
}

module.exports = {
  createCloudbaseReconciliationStore
};
