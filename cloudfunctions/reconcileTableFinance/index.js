'use strict';

const crypto = require('crypto');
const {
  ARTIFACT_LEASE_MS,
  POLICY_VERSION,
  RUN_LEASE_MS,
  artifactDescriptor,
  chinaDateBounds,
  localRefundNosFromTradeBill,
  matchPaymentEvidence,
  matchRefundEvidence,
  orderSnapshotToken,
  parseTradeBill,
  previousChinaBillDate,
  runIdForBillDate
} = require('./lib/table-reconciliation/table-reconciliation');

const PROFILE_LIMIT = 101;
const PROFILE_PROCESS_LIMIT = 100;
const DOCUMENT_LIMIT = 101;
const DOCUMENT_PROCESS_LIMIT = 100;
const RETRY_DATE_LIMIT = 1;
const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactTimerEvent(event) {
  return isPlainObject(event)
    && Object.keys(event).length === 2
    && event.Type === 'Timer'
    && event.TriggerName === 'reconcileTableFinanceTimer';
}

function hasOpenid(value) {
  return isPlainObject(value)
    && Object.prototype.hasOwnProperty.call(value, 'OPENID');
}

function chinaBillDateFromMs(value) {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  const shifted = value + CHINA_OFFSET_MS;
  if (!Number.isSafeInteger(shifted)) return null;
  const date = new Date(shifted);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function validAttemptId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && !/[\x00-\x1f\x7f]/.test(value);
}

function validBillProfile(profile) {
  return isPlainObject(profile)
    && typeof profile._id === 'string'
    && profile._id.length > 0
    && profile.shopId === profile._id
    && profile.schemaVersion === 1
    && profile.status === 'ready'
    && profile.onboardingStatus === 'approved'
    && profile.contractStatus === 'signed'
    && profile.profitSharingAuthorizationStatus === 'authorized'
    && typeof profile.paymentEnabled === 'boolean'
    && typeof profile.profitSharingEnabled === 'boolean'
    && profile.policyVersion === POLICY_VERSION
    && typeof profile.subMchid === 'string'
    && /^[0-9]{8,32}$/.test(profile.subMchid);
}

function verifiedDownloadMetadata(metadata, bytes) {
  if (
    !isPlainObject(metadata)
    || metadata.hash_type !== 'SHA1'
    || typeof metadata.hash_value !== 'string'
    || !/^[0-9A-Fa-f]{40}$/.test(metadata.hash_value)
    || typeof metadata.download_url !== 'string'
    || (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array))
  ) return null;
  const raw = Buffer.from(bytes);
  const sha1 = crypto.createHash('sha1').update(raw).digest('hex');
  if (sha1 !== metadata.hash_value.toLowerCase()) return null;
  let download;
  try {
    download = new URL(metadata.download_url);
  } catch (_error) {
    return null;
  }
  if (
    download.protocol !== 'https:'
    || !['api.mch.weixin.qq.com', 'api2.mch.weixin.qq.com'].includes(download.hostname)
    || download.port
    || download.username
    || download.password
    || download.hash
    || download.pathname !== '/v3/billdownload/file'
    || !download.search
  ) return null;
  return {
    raw,
    sha1,
    sourceMetadata: {
      applicationEndpoint: '/v3/bill/tradebill',
      hashType: 'SHA1',
      hashValue: metadata.hash_value,
      downloadHost: download.hostname,
      downloadPath: download.pathname,
      downloadUrlShortLived: true
    }
  };
}

function createReconcileFinanceHandler(dependencies) {
  const functionNames = [
    'getContext',
    'loadConfig',
    'createWechatPayClient',
    'nowMs',
    'makeAttemptId',
    'uploadPrivateArtifact'
  ];
  if (
    !isPlainObject(dependencies)
    || !dependencies.store
    || functionNames.some((name) => typeof dependencies[name] !== 'function')
  ) throw new TypeError('reconcileTableFinance dependencies are invalid');
  const {
    store,
    getContext,
    loadConfig,
    createWechatPayClient,
    nowMs,
    makeAttemptId,
    uploadPrivateArtifact
  } = dependencies;

  function operationNow() {
    const value = nowMs();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid clock');
    return value;
  }

  function leaseExpiresAt(value, durationMs) {
    const expiresAt = value + durationMs;
    if (!Number.isSafeInteger(expiresAt)) throw new Error('invalid lease expiry');
    return expiresAt;
  }

  async function anomaly(input) {
    const anomalyId = await store.recordAnomaly(input);
    if (!anomalyId) throw new Error('finance anomaly persistence failed');
    return anomalyId;
  }

  async function blockOrder(input) {
    const blocked = await store.blockOrder(input);
    if (!blocked) throw new Error('finance order block failed');
    return true;
  }

  async function candidatesForArtifact(profile, bounds, summary) {
    const [orders, refunds] = await Promise.all([
      store.listOrdersForBill({
        subMchid: profile.subMchid,
        startMs: bounds.startMs,
        endMs: bounds.endMs,
        limit: DOCUMENT_LIMIT
      }),
      store.listRefundsForBill({
        subMchid: profile.subMchid,
        startMs: bounds.startMs,
        endMs: bounds.endMs,
        limit: DOCUMENT_LIMIT
      })
    ]);
    if (!Array.isArray(orders) || !Array.isArray(refunds)) {
      throw new Error('bill candidate query returned invalid data');
    }
    if (orders.length > DOCUMENT_PROCESS_LIMIT || refunds.length > DOCUMENT_PROCESS_LIMIT) {
      summary.manualReview += 1;
      summary.pending += 1;
      await anomaly({
        billDate: summary.billDate,
        subMchid: profile.subMchid,
        reasonCodes: ['BILL_CANDIDATE_LIMIT_EXCEEDED']
      });
      return null;
    }
    return { orders, refunds };
  }

  async function discoverBillRefundCandidates(profile, parsed, candidates, summary) {
    const refundNos = localRefundNosFromTradeBill(parsed.rows, DOCUMENT_LIMIT);
    if (refundNos.length > DOCUMENT_PROCESS_LIMIT) {
      summary.manualReview += 1;
      summary.pending += 1;
      await anomaly({
        billDate: summary.billDate,
        subMchid: profile.subMchid,
        reasonCodes: ['BILL_REFUND_ROW_LIMIT_EXCEEDED']
      });
      return null;
    }
    const refunds = new Map(
      candidates.refunds
        .filter((value) => value && typeof value._id === 'string')
        .map((value) => [value._id, value])
    );
    for (const refundNo of refundNos) {
      if (refunds.has(refundNo)) continue;
      const localRefund = await store.getRefund(refundNo);
      if (
        localRefund
        && localRefund._id === refundNo
        && localRefund.refundNo === refundNo
        && localRefund.subMchid === profile.subMchid
      ) refunds.set(refundNo, localRefund);
    }
    if (refunds.size > DOCUMENT_PROCESS_LIMIT) {
      summary.manualReview += 1;
      summary.pending += 1;
      await anomaly({
        billDate: summary.billDate,
        subMchid: profile.subMchid,
        reasonCodes: ['BILL_REFUND_CANDIDATE_LIMIT_EXCEEDED']
      });
      return null;
    }
    return {
      orders: candidates.orders,
      refunds: [...refunds.values()].sort((left, right) => (
        left._id.localeCompare(right._id)
      ))
    };
  }

  async function freezeArtifactCandidates({
    profile,
    billDate,
    artifactId,
    reasonCodes,
    summary,
    candidates: suppliedCandidates = null
  }) {
    const candidates = suppliedCandidates || await candidatesForArtifact(
      profile,
      chinaDateBounds(billDate),
      summary
    );
    if (!candidates) throw new Error('artifact candidates require manual pagination');
    const orderIds = new Set(
      candidates.orders
        .filter((value) => value && typeof value.orderId === 'string')
        .map((value) => value.orderId)
    );
    for (const localRefund of candidates.refunds) {
      if (!localRefund || typeof localRefund.orderId !== 'string') continue;
      const currentOrder = await store.getOrder(localRefund.orderId);
      if (
        currentOrder
        && currentOrder.paymentProfileSnapshot
        && currentOrder.paymentProfileSnapshot.subMchid === profile.subMchid
      ) orderIds.add(currentOrder.orderId);
    }
    for (const orderId of orderIds) {
      const blocked = await store.blockOrder({
        orderId,
        billDate,
        subMchid: profile.subMchid,
        artifactId,
        reasonCodes
      });
      if (!blocked) throw new Error('artifact candidate freeze failed');
    }
    return orderIds.size;
  }

  async function reconcileArtifact({
    profile,
    artifact,
    parsed,
    billDate,
    summary,
    candidates: suppliedCandidates = null
  }) {
    const bounds = chinaDateBounds(billDate);
    const candidates = suppliedCandidates
      || await candidatesForArtifact(profile, bounds, summary);
    if (!candidates) return;
    const groups = new Map();

    function groupFor(currentOrder) {
      let group = groups.get(currentOrder.orderId);
      if (!group) {
        group = {
          order: currentOrder,
          expectedOrderToken: orderSnapshotToken(currentOrder),
          paymentEvidence: null,
          refundEvidences: [],
          invalidReasonCodes: []
        };
        groups.set(currentOrder.orderId, group);
      }
      return group;
    }

    for (const currentOrder of candidates.orders) {
      summary.ordersScanned += 1;
      const matched = matchPaymentEvidence(currentOrder, parsed.rows, artifact);
      if (matched.status !== 'matched') {
        summary.manualReview += 1;
        await blockOrder({
          orderId: currentOrder && currentOrder.orderId,
          billDate,
          subMchid: profile.subMchid,
          artifactId: artifact.artifactId,
          reasonCodes: matched.reasonCodes || ['PAYMENT_EVIDENCE_INVALID']
        });
        continue;
      }
      groupFor(currentOrder).paymentEvidence = matched.evidence;
    }

    for (const localRefund of candidates.refunds) {
      if (!localRefund || typeof localRefund.orderId !== 'string') continue;
      const currentOrder = await store.getOrder(localRefund.orderId);
      if (
        !currentOrder
        || !currentOrder.paymentProfileSnapshot
        || currentOrder.paymentProfileSnapshot.subMchid !== profile.subMchid
      ) continue;
      summary.refundsScanned += 1;
      const matched = matchRefundEvidence(
        currentOrder,
        localRefund,
        parsed.rows,
        artifact
      );
      if (matched.status !== 'matched') {
        summary.manualReview += 1;
        groupFor(currentOrder).invalidReasonCodes.push(
          ...(matched.reasonCodes || ['REFUND_EVIDENCE_INVALID'])
        );
        continue;
      }
      groupFor(currentOrder).refundEvidences.push(matched.evidence);
    }

    for (const group of groups.values()) {
      let result;
      try {
        const confirmedAtMs = operationNow();
        const refundSnapshots = await store.listRefundsForOrder({
          orderId: group.order.orderId,
          limit: DOCUMENT_LIMIT
        });
        if (!Array.isArray(refundSnapshots)) {
          throw new Error('order refund query returned invalid data');
        }
        result = await store.applyOrderEvidence({
          orderId: group.order.orderId,
          expectedOrderToken: group.expectedOrderToken,
          refundSnapshots,
          paymentEvidence: group.paymentEvidence,
          refundEvidences: group.refundEvidences,
          billDate,
          subMchid: profile.subMchid,
          artifactId: artifact.artifactId,
          confirmedAtMs,
          nowMs: confirmedAtMs
        });
      } catch (_error) {
        summary.pending += 1;
        await blockOrder({
          orderId: group.order.orderId,
          billDate,
          subMchid: profile.subMchid,
          artifactId: artifact.artifactId,
          reasonCodes: ['ORDER_EVIDENCE_WRITE_FAILED']
        });
        continue;
      }
      if (!result || result.status === 'conflict') {
        summary.conflicts += 1;
        await blockOrder({
          orderId: group.order.orderId,
          billDate,
          subMchid: profile.subMchid,
          artifactId: artifact.artifactId,
          reasonCodes: result && result.reasonCodes
            ? result.reasonCodes
            : ['ORDER_CAS_CONFLICT']
        });
      } else if (group.invalidReasonCodes.length > 0) {
        summary.pending += 1;
        await blockOrder({
          orderId: group.order.orderId,
          billDate,
          subMchid: profile.subMchid,
          artifactId: artifact.artifactId,
          reasonCodes: [...new Set(group.invalidReasonCodes)].sort()
        });
      } else if (['confirmed', 'duplicate'].includes(result.status)) {
        summary.confirmed += 1;
      } else if (result.status === 'blocked') {
        summary.manualReview += 1;
      } else if (result.status === 'pending') {
        summary.pending += 1;
        await blockOrder({
          orderId: group.order.orderId,
          billDate,
          subMchid: profile.subMchid,
          artifactId: artifact.artifactId,
          reasonCodes: result.reasonCodes || ['FINANCE_EVIDENCE_PENDING']
        });
      } else {
        summary.manualReview += 1;
      }
    }
  }

  function statementErrorKind(error) {
    const code = error && typeof error.code === 'string' ? error.code : '';
    const statusCode = error && Number.isInteger(error.statusCode)
      ? error.statusCode
      : null;
    if (code === 'NO_STATEMENT_EXIST') return 'missing';
    if (
      code === 'STATEMENT_CREATING'
      || statusCode === null
      || [408, 425, 429].includes(statusCode)
      || statusCode >= 500
    ) return 'retryable';
    return 'permanent';
  }

  function hasCandidates(candidates) {
    return !!candidates
      && (candidates.orders.length > 0 || candidates.refunds.length > 0);
  }

  async function executeReconcileTableFinance(
    billDate,
    { reopenCompleted = false } = {}
  ) {
    let now;
    let attemptId;
    let runId;
    try {
      now = operationNow();
      attemptId = makeAttemptId();
      if (!validAttemptId(attemptId)) throw new Error('invalid attempt');
      runId = runIdForBillDate(POLICY_VERSION, billDate);
    } catch (_error) {
      return { ok: false, code: 'FINANCE_RECONCILIATION_NOT_AVAILABLE' };
    }

    let run;
    try {
      run = await store.claimRun({
        runId,
        policyVersion: POLICY_VERSION,
        billDate,
        attemptId,
        claimedAt: now,
        leaseExpiresAt: leaseExpiresAt(now, RUN_LEASE_MS),
        reopenCompleted
      });
    } catch (_error) {
      return { ok: false, code: 'FINANCE_RECONCILIATION_FAILED', billDate };
    }
    if (run.status === 'active') {
      return { ok: false, code: 'RECONCILIATION_ALREADY_RUNNING', billDate };
    }
    if (run.status === 'completed') {
      return { ok: true, billDate, alreadyCompleted: true };
    }
    if (run.status !== 'claimed') {
      return { ok: false, code: 'FINANCE_RECONCILIATION_FAILED', billDate };
    }

    let client;
    try {
      client = createWechatPayClient(loadConfig());
    } catch (_error) {
      return { ok: false, code: 'FINANCE_RECONCILIATION_NOT_AVAILABLE', billDate };
    }

    const summary = {
      ok: true,
      billDate,
      profilesScanned: 0,
      artifactsProcessed: 0,
      ordersScanned: 0,
      refundsScanned: 0,
      confirmed: 0,
      pending: 0,
      manualReview: 0,
      conflicts: 0
    };
    let profiles;
    try {
      profiles = await store.listBillProfiles(PROFILE_LIMIT);
      if (!Array.isArray(profiles)) throw new Error('invalid profile list');
    } catch (_error) {
      return { ok: false, code: 'FINANCE_RECONCILIATION_FAILED', billDate };
    }
    if (profiles.length > PROFILE_PROCESS_LIMIT) {
      await anomaly({ billDate, reasonCodes: ['PAYMENT_PROFILE_LIMIT_EXCEEDED'] });
      return { ok: false, code: 'FINANCE_RECONCILIATION_FAILED', billDate };
    }

    const subMchidCounts = new Map();
    for (const profile of profiles) {
      if (profile && typeof profile.subMchid === 'string') {
        subMchidCounts.set(profile.subMchid, (subMchidCounts.get(profile.subMchid) || 0) + 1);
      }
    }

    for (const profile of profiles) {
      const heartbeatAt = operationNow();
      const renewed = await store.renewRun({
        runId,
        attemptId,
        heartbeatAt,
        leaseExpiresAt: leaseExpiresAt(heartbeatAt, RUN_LEASE_MS)
      });
      if (!renewed) return { ...summary, ok: false, code: 'RUN_CAS_CONFLICT' };
      summary.profilesScanned += 1;
      let profileReason = null;
      if (!validBillProfile(profile)) profileReason = 'PAYMENT_PROFILE_INVALID';
      else if (profile.tradeBillModeVerified !== true) {
        profileReason = 'TRADE_BILL_MODE_NOT_VERIFIED';
      } else if (subMchidCounts.get(profile.subMchid) !== 1) {
        profileReason = 'PAYMENT_PROFILE_SUB_MCHID_DUPLICATE';
      }
      if (profileReason) {
        summary.manualReview += 1;
        await anomaly({
          billDate,
          subMchid: profile && profile.subMchid,
          reasonCodes: [profileReason]
        });
        continue;
      }

      const candidates = await candidatesForArtifact(
        profile,
        chinaDateBounds(billDate),
        summary
      );
      if (!candidates) continue;

      let metadata;
      let bytes;
      try {
        metadata = await client.tradeBill({
          bill_date: billDate,
          sub_mchid: profile.subMchid,
          bill_type: 'ALL'
        });
      } catch (error) {
        const kind = statementErrorKind(error);
        if (kind === 'missing' && !hasCandidates(candidates)) continue;
        if (kind === 'retryable') {
          summary.pending += 1;
          await anomaly({
            billDate,
            subMchid: profile.subMchid,
            reasonCodes: ['TRADE_BILL_RETRYABLE']
          });
          continue;
        }
        const reasonCode = kind === 'missing'
          ? 'TRADE_BILL_MISSING_WITH_LOCAL_CANDIDATES'
          : 'TRADE_BILL_ACCESS_FAILED';
        summary.manualReview += 1;
        await anomaly({
          billDate,
          subMchid: profile.subMchid,
          reasonCodes: [reasonCode]
        });
        await freezeArtifactCandidates({
          profile,
          billDate,
          artifactId: artifactDescriptor(POLICY_VERSION, billDate, profile.subMchid).artifactId,
          reasonCodes: [reasonCode],
          summary,
          candidates
        });
        continue;
      }
      try {
        bytes = await client.downloadBill(metadata);
      } catch (error) {
        if (error && error.code === 'BILL_HASH_INVALID') {
          summary.manualReview += 1;
          summary.pending += 1;
          await anomaly({
            billDate,
            subMchid: profile.subMchid,
            reasonCodes: ['TRADE_BILL_HASH_INVALID']
          });
          await freezeArtifactCandidates({
            profile,
            billDate,
            artifactId: artifactDescriptor(
              POLICY_VERSION,
              billDate,
              profile.subMchid
            ).artifactId,
            reasonCodes: ['TRADE_BILL_HASH_INVALID'],
            summary,
            candidates
          });
          continue;
        }
        const statusCode = error && Number.isInteger(error.statusCode)
          ? error.statusCode
          : null;
        if ([400, 401, 403].includes(statusCode)) {
          summary.manualReview += 1;
          await anomaly({
            billDate,
            subMchid: profile.subMchid,
            reasonCodes: ['TRADE_BILL_ACCESS_FAILED']
          });
          await freezeArtifactCandidates({
            profile,
            billDate,
            artifactId: artifactDescriptor(POLICY_VERSION, billDate, profile.subMchid).artifactId,
            reasonCodes: ['TRADE_BILL_ACCESS_FAILED'],
            summary,
            candidates
          });
          continue;
        }
        summary.pending += 1;
        await anomaly({
          billDate,
          subMchid: profile.subMchid,
          reasonCodes: ['TRADE_BILL_DOWNLOAD_RETRYABLE']
        });
        continue;
      }
      const verified = verifiedDownloadMetadata(metadata, bytes);
      if (!verified) {
        summary.manualReview += 1;
        summary.pending += 1;
        await anomaly({
          billDate,
          subMchid: profile.subMchid,
          reasonCodes: ['TRADE_BILL_HASH_INVALID']
        });
        await freezeArtifactCandidates({
          profile,
          billDate,
          artifactId: artifactDescriptor(POLICY_VERSION, billDate, profile.subMchid).artifactId,
          reasonCodes: ['TRADE_BILL_HASH_INVALID'],
          summary,
          candidates
        });
        continue;
      }
      const descriptor = artifactDescriptor(POLICY_VERSION, billDate, profile.subMchid);
      let artifactClaim;
      try {
        const artifactClaimedAt = operationNow();
        artifactClaim = await store.claimArtifact({
          artifact: descriptor,
          sha1: verified.sha1,
          hashType: metadata.hash_type,
          signedHashValue: metadata.hash_value,
          byteLength: verified.raw.length,
          sourceMetadata: verified.sourceMetadata,
          attemptId,
          claimedAt: artifactClaimedAt,
          leaseExpiresAt: leaseExpiresAt(artifactClaimedAt, ARTIFACT_LEASE_MS)
        });
      } catch (_error) {
        summary.pending += 1;
        await anomaly({
          billDate,
          subMchid: profile.subMchid,
          artifactId: descriptor.artifactId,
          reasonCodes: ['BILL_ARTIFACT_CLAIM_FAILED']
        });
        continue;
      }
      if (artifactClaim.status === 'conflict') {
        summary.conflicts += 1;
        await anomaly({
          billDate,
          subMchid: profile.subMchid,
          artifactId: descriptor.artifactId,
          reasonCodes: ['BILL_ARTIFACT_HASH_CONFLICT']
        });
        await freezeArtifactCandidates({
          profile,
          billDate,
          artifactId: descriptor.artifactId,
          reasonCodes: ['BILL_ARTIFACT_HASH_CONFLICT'],
          summary,
          candidates
        });
        continue;
      }
      if (artifactClaim.status === 'active') {
        summary.pending += 1;
        continue;
      }
      if (!['claimed', 'resumed', 'replay'].includes(artifactClaim.status)) {
        summary.conflicts += 1;
        summary.pending += 1;
        await anomaly({
          billDate,
          subMchid: profile.subMchid,
          artifactId: descriptor.artifactId,
          reasonCodes: ['BILL_ARTIFACT_CLAIM_INVALID']
        });
        continue;
      }

      if (!artifactClaim.artifact.fileId) {
        let uploaded;
        try {
          uploaded = await uploadPrivateArtifact({
            cloudPath: descriptor.cloudPath,
            fileContent: verified.raw,
            metadata: {
              visibility: 'private',
              contentType: 'text/csv; charset=utf-8',
              sha1: verified.sha1
            }
          });
          if (!uploaded || typeof uploaded.fileId !== 'string' || !uploaded.fileId) {
            throw new Error('private upload did not return a file ID');
          }
        } catch (_error) {
          summary.pending += 1;
          await anomaly({
            billDate,
            subMchid: profile.subMchid,
            artifactId: descriptor.artifactId,
            reasonCodes: ['BILL_ARTIFACT_UPLOAD_FAILED']
          });
          continue;
        }
        const marked = await store.markArtifactUploaded({
          artifactId: descriptor.artifactId,
          attemptId,
          sha1: verified.sha1,
          fileId: uploaded.fileId,
          uploadedAt: operationNow(),
          contentType: 'text/csv; charset=utf-8'
        });
        if (!marked) {
          summary.conflicts += 1;
          summary.pending += 1;
          await anomaly({
            billDate,
            subMchid: profile.subMchid,
            artifactId: descriptor.artifactId,
            reasonCodes: ['BILL_ARTIFACT_UPLOAD_CAS_CONFLICT']
          });
          continue;
        }
      }

      let parsed;
      try {
        parsed = parseTradeBill(verified.raw);
      } catch (_error) {
        summary.manualReview += 1;
        summary.pending += 1;
        await anomaly({
          billDate,
          subMchid: profile.subMchid,
          artifactId: descriptor.artifactId,
          reasonCodes: ['TRADE_BILL_PARSE_FAILED']
        });
        await freezeArtifactCandidates({
          profile,
          billDate,
          artifactId: descriptor.artifactId,
          reasonCodes: ['TRADE_BILL_PARSE_FAILED'],
          summary,
          candidates
        });
        continue;
      }
      const artifactCandidates = await discoverBillRefundCandidates(
        profile,
        parsed,
        candidates,
        summary
      );
      const parsedMarked = await store.markArtifactParsed({
        artifactId: descriptor.artifactId,
        sha1: verified.sha1,
        parsedAt: operationNow(),
        rowCount: parsed.rows.length,
        headerCount: parsed.headers.length
      });
      if (!parsedMarked) {
        summary.conflicts += 1;
        summary.pending += 1;
        await anomaly({
          billDate,
          subMchid: profile.subMchid,
          artifactId: descriptor.artifactId,
          reasonCodes: ['BILL_ARTIFACT_PARSE_CAS_CONFLICT']
        });
        continue;
      }
      summary.artifactsProcessed += 1;
      if (!artifactCandidates) continue;
      await reconcileArtifact({
        profile,
        artifact: { ...descriptor, sha1: verified.sha1 },
        parsed,
        billDate,
        summary,
        candidates: artifactCandidates
      });
    }

    if (summary.pending > 0) {
      const pendingResult = {
        ...summary,
        ok: false,
        code: 'FINANCE_RECONCILIATION_PENDING'
      };
      const deferredAt = operationNow();
      const deferred = await store.deferRun({
        runId,
        attemptId,
        deferredAt,
        leaseExpiresAt: leaseExpiresAt(deferredAt, RUN_LEASE_MS),
        summary: pendingResult
      });
      if (!deferred) return { ...pendingResult, code: 'RUN_CAS_CONFLICT' };
      return pendingResult;
    }

    const completed = await store.completeRun({
      runId,
      attemptId,
      completedAt: operationNow(),
      summary
    });
    if (!completed) return { ...summary, ok: false, code: 'RUN_CAS_CONFLICT' };
    return summary;
  }

  return async function reconcileTableFinance(event, context = {}) {
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
    ) return { ok: false, code: 'ACCESS_DENIED' };

    let defaultBillDate;
    let retryableBillDates;
    let unreconciledBillDates;
    try {
      const currentNow = operationNow();
      defaultBillDate = previousChinaBillDate(currentNow);
      const beforeMs = chinaDateBounds(defaultBillDate).endMs;
      const [retryable, unreconciledOrders] = await Promise.all([
        store.listRetryableBillDates({
          beforeBillDate: defaultBillDate,
          nowMs: currentNow,
          limit: RETRY_DATE_LIMIT
        }),
        store.listUnreconciledPaidOrders({
          beforeMs,
          limit: RETRY_DATE_LIMIT
        })
      ]);
      retryableBillDates = retryable;
      unreconciledBillDates = [...new Set(unreconciledOrders.map((value) => (
        value && chinaBillDateFromMs(value.paidAt)
      )).filter((value) => value && value <= defaultBillDate))];
      if (!Array.isArray(retryableBillDates)) {
        throw new Error('retryable bill-date query returned invalid data');
      }
      if (!Array.isArray(unreconciledBillDates)) {
        throw new Error('unreconciled bill-date query returned invalid data');
      }
    } catch (_error) {
      return {
        ok: false,
        code: 'FINANCE_RECONCILIATION_FAILED',
        ...(defaultBillDate ? { billDate: defaultBillDate } : {})
      };
    }

    const billDates = [...new Set([
      ...retryableBillDates.filter((value) => (
        typeof value === 'string'
        && /^\d{4}-\d{2}-\d{2}$/.test(value)
        && value < defaultBillDate
      )),
      ...unreconciledBillDates,
      defaultBillDate
    ])];
    const reopenCompletedDates = new Set(unreconciledBillDates);
    const results = [];
    for (const billDate of billDates) {
      try {
        results.push(await executeReconcileTableFinance(billDate, {
          reopenCompleted: reopenCompletedDates.has(billDate)
        }));
      } catch (_error) {
        results.push({
          ok: false,
          code: 'FINANCE_RECONCILIATION_FAILED',
          billDate
        });
      }
    }
    const currentResult = results[results.length - 1];
    if (billDates.length === 1) return currentResult;
    const retryResults = results.slice(0, -1);
    const retryFailed = retryResults.some((value) => !value || value.ok !== true);
    return {
      ...currentResult,
      ...(currentResult.ok === true && retryFailed
        ? { ok: false, code: 'FINANCE_RECONCILIATION_PENDING' }
        : {}),
      retriedBillDates: billDates.slice(0, -1),
      retryResults
    };
  };
}

let productionHandler = null;

function getProductionHandler() {
  if (productionHandler) return productionHandler;
  const cloud = require('wx-server-sdk');
  const {
    createCloudbaseReconciliationStore
  } = require('./lib/table-reconciliation/cloudbase-reconciliation-store');
  const { loadWechatPayConfig } = require('./lib/wechatpay-v3/config');
  const { createWechatPayClient } = require('./lib/wechatpay-v3/client');
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
  productionHandler = createReconcileFinanceHandler({
    store: createCloudbaseReconciliationStore(
      cloud.database({ throwOnNotFound: false })
    ),
    getContext: () => cloud.getWXContext(),
    loadConfig: () => loadWechatPayConfig(),
    createWechatPayClient,
    nowMs: () => Date.now(),
    makeAttemptId: () => crypto.randomBytes(16).toString('hex'),
    async uploadPrivateArtifact({ cloudPath, fileContent }) {
      return cloud.uploadFile({ cloudPath, fileContent });
    }
  });
  return productionHandler;
}

exports.createReconcileFinanceHandler = createReconcileFinanceHandler;
exports.main = (event, context) => getProductionHandler()(event, context);
