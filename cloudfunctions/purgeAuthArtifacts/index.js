'use strict';

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const PAGE_LIMIT = 100;
const TIMER_TYPE = 'Timer';
const TIMER_NAME = 'purgeAuthArtifactsTimer';

function trustedTimer(event) {
  return !!event
    && event.Type === TIMER_TYPE
    && event.TriggerName === TIMER_NAME;
}

async function expiredDocuments(
  collectionName,
  field,
  now,
  limit = PAGE_LIMIT
) {
  if (
    !Number.isSafeInteger(limit)
    || limit < 1
    || limit > PAGE_LIMIT
  ) {
    throw new Error('Invalid cleanup page limit');
  }
  const result = await db
    .collection(collectionName)
    .where({ [field]: _.lte(now) })
    .limit(limit)
    .get();
  if (
    !result
    || !Array.isArray(result.data)
    || result.data.length > limit
  ) {
    throw new Error('Invalid cleanup query result');
  }
  return result.data;
}

function documentIds(documents) {
  const ids = new Set();
  for (const document of documents) {
    if (!document || typeof document._id !== 'string' || !document._id) {
      throw new Error('Invalid cleanup document');
    }
    ids.add(document._id);
  }
  return ids;
}

async function removeDocuments(collectionName, ids) {
  let removed = 0;
  for (const id of ids) {
    const result = await db.collection(collectionName).doc(id).remove();
    const count = result && result.stats && result.stats.removed;
    if (!Number.isSafeInteger(count) || count < 0 || count > 1) {
      throw new Error('Invalid cleanup delete result');
    }
    removed += count;
  }
  return removed;
}

exports.main = async (event = {}) => {
  if (!trustedTimer(event)) {
    return { ok: false, code: 'FORBIDDEN' };
  }

  try {
    const now = new Date(Date.now());
    const [smsDocuments, proofDocuments, idleSessions] =
      await Promise.all([
        expiredDocuments('sms_codes', 'expiresAt', now),
        expiredDocuments('auth_proofs', 'expiresAt', now),
        expiredDocuments('auth_sessions', 'idleExpiresAt', now)
      ]);
    const smsIds = documentIds(smsDocuments);
    const proofIds = documentIds(proofDocuments);
    const idleSessionIds = documentIds(idleSessions);
    const remainingSessionLimit = PAGE_LIMIT - idleSessionIds.size;
    const absoluteSessions = remainingSessionLimit > 0
      ? await expiredDocuments(
        'auth_sessions',
        'absoluteExpiresAt',
        now,
        remainingSessionLimit
      )
      : [];
    const sessionIds = documentIds([
      ...idleSessions,
      ...absoluteSessions
    ]);

    const smsCodesDeleted = await removeDocuments('sms_codes', smsIds);
    const authProofsDeleted = await removeDocuments(
      'auth_proofs',
      proofIds
    );
    const authSessionsDeleted = await removeDocuments(
      'auth_sessions',
      sessionIds
    );
    return {
      ok: true,
      smsCodesDeleted,
      authProofsDeleted,
      authSessionsDeleted
    };
  } catch (_) {
    return { ok: false, code: 'AUTH_INTERNAL_ERROR' };
  }
};
