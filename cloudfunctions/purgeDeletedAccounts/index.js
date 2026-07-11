const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const PURGE_LEASE_MS = 10 * 60 * 1000;
const DOCUMENT_DELETE_BATCH_SIZE = 20;
const MAX_CLEANUP_SCANS = 3;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function bindingId(openid) {
  return sha256(`wechat:${openid}`);
}

async function getOptional(ref) {
  const result = await ref.get();
  return result && result.data ? result.data : null;
}

function lifecycleError(code) {
  const error = new Error(code);
  error.lifecycleCode = code;
  return error;
}

function isBlockingSubscriptionStatus(status) {
  return status === 'active' || status === 'pending_contract' || status === 'cancel_required';
}

async function hasActiveSubscription(database, openid) {
  const result = await database.collection('subscriptions')
    .where({
      _openid: openid,
      status: _.in(['active', 'pending_contract', 'cancel_required'])
    })
    .limit(1)
    .get();
  return result.data.length > 0;
}

async function readIdentity(database, candidate, now, checkSubscription = true) {
  const openid = candidate && candidate._openid;
  const userId = openid ? bindingId(openid) : '';
  if (!openid || candidate._id !== userId) return null;

  const binding = await getOptional(database.collection('wechat_bindings').doc(userId));
  if (
    !binding ||
    binding._id !== userId ||
    binding._openid !== openid ||
    !binding.accountId ||
    !binding.account
  ) {
    return null;
  }
  const account = await getOptional(database.collection('accounts').doc(binding.accountId));
  const user = await getOptional(database.collection('users').doc(userId));
  const request = await getOptional(database.collection('account_deletion_requests').doc(userId));
  const deletionStatus = user && user.deletionStatus;
  if (
    !account ||
    account._id !== binding.accountId ||
    account._openid !== openid ||
    account.account !== binding.account ||
    account.status !== 'active' ||
    !user ||
    user._id !== userId ||
    user._openid !== openid ||
    (deletionStatus !== 'pending' && deletionStatus !== 'purging') ||
    !Number.isFinite(user.deletionRequestedAt) ||
    !Number.isFinite(user.deletionScheduledAt) ||
    user.deletionScheduledAt > now ||
    !request ||
    request._id !== userId ||
    request._openid !== openid ||
    request.accountId !== binding.accountId ||
    request.account !== binding.account ||
    request.deletionStatus !== deletionStatus ||
    !Number.isFinite(request.deletionRequestedAt) ||
    !Number.isFinite(request.deletionScheduledAt) ||
    request.deletionRequestedAt !== user.deletionRequestedAt ||
    request.deletionScheduledAt !== user.deletionScheduledAt ||
    request.deletionScheduledAt > now
  ) {
    return null;
  }
  if (
    deletionStatus === 'purging' &&
    (
      !user.purgeLeaseId ||
      request.purgeLeaseId !== user.purgeLeaseId ||
      !Number.isFinite(user.purgeLeaseExpiresAt) ||
      request.purgeLeaseExpiresAt !== user.purgeLeaseExpiresAt
    )
  ) {
    return null;
  }
  if (isBlockingSubscriptionStatus(user.subscriptionStatus)) {
    throw lifecycleError('ACTIVE_SUBSCRIPTION');
  }
  if (checkSubscription && await hasActiveSubscription(database, openid)) {
    throw lifecycleError('ACTIVE_SUBSCRIPTION');
  }
  return { openid, userId, accountId: binding.accountId, user, request };
}

async function claimIdentity(candidate, now, leaseId) {
  return db.runTransaction(async (transaction) => {
    const identity = await readIdentity(transaction, candidate, now, false);
    if (!identity) throw lifecycleError('AUTH_CHAIN_CHANGED');
    if (
      identity.user.deletionStatus === 'purging' &&
      identity.user.purgeLeaseId !== leaseId &&
      identity.user.purgeLeaseExpiresAt > now
    ) {
      throw lifecycleError('PURGE_LEASE_HELD');
    }

    const leaseExpiresAt = now + PURGE_LEASE_MS;
    const lease = {
      deletionStatus: 'purging',
      purgeLeaseId: leaseId,
      purgeLeaseExpiresAt: leaseExpiresAt,
      updatedAt: db.serverDate()
    };
    await transaction.collection('users').doc(identity.userId).update({ data: lease });
    await transaction.collection('account_deletion_requests').doc(identity.userId).update({ data: lease });
    identity.user = Object.assign({}, identity.user, lease);
    identity.request = Object.assign({}, identity.request, lease);
    return identity;
  });
}

async function queryDocuments(name, query) {
  const documents = [];
  let lastSeen = '';
  while (true) {
    const pageQuery = lastSeen
      ? _.and(query, { _id: _.gt(lastSeen) })
      : query;
    const result = await db.collection(name)
      .where(pageQuery)
      .orderBy('_id', 'asc')
      .limit(100)
      .get();
    const page = result && Array.isArray(result.data) ? result.data : [];
    if (page.some((item) => !item || typeof item._id !== 'string' || !item._id)) {
      throw lifecycleError('INVALID_DOCUMENT_ID');
    }
    documents.push(...page);
    if (page.length < 100) break;
    const nextLastSeen = page[page.length - 1]._id;
    if (nextLastSeen <= lastSeen) throw lifecycleError('UNSTABLE_QUERY_CURSOR');
    lastSeen = nextLastSeen;
  }
  return documents;
}

function isFinancialLesson(lesson) {
  const amountFields = ['amount', 'paidAmount', 'settlementAmount'];
  const hasFinancialAmount = amountFields.some((field) => {
    const value = lesson[field];
    if (value === undefined || value === null) return false;
    if (typeof value === 'string' && !value.trim()) return false;
    const amount = Number(value);
    return !Number.isFinite(amount) || amount !== 0;
  });
  if (hasFinancialAmount) return true;
  if (lesson.settled === true) return true;
  const referenceFields = [
    'settlementStatus',
    'settlementId',
    'settledAt',
    'orderId',
    'transactionId'
  ];
  return referenceFields.some((field) => (
    lesson[field] !== undefined && lesson[field] !== null && lesson[field] !== ''
  ));
}

function isOwnedUserContentFileID(fileID, identity) {
  if (typeof fileID !== 'string' || fileID.indexOf('cloud://') !== 0) return false;
  const match = fileID.match(/^cloud:\/\/([A-Za-z0-9.-]+)\/(.+)$/);
  if (!match || /[\\%?#]/.test(match[2])) return false;
  if (!match[1].split('.').every((part) => (
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(part)
  ))) {
    return false;
  }
  const parts = match[2].split('/');
  if (parts.length < 3 || parts[0] !== 'user-content') return false;
  if (parts[1] !== identity.userId) return false;
  return parts.slice(2).every((part) => (
    part &&
    part !== '.' &&
    part !== '..' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)
  ));
}

function addCloudValue(files, value, identity, seenFiles) {
  if (typeof value === 'string') {
    if (isOwnedUserContentFileID(value, identity) && !seenFiles.has(value)) {
      seenFiles.add(value);
      files.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => addCloudValue(files, item, identity, seenFiles));
    return;
  }
  if (value && typeof value === 'object') {
    Object.keys(value).forEach((key) => addCloudValue(files, value[key], identity, seenFiles));
  }
}

function createCleanupTracker() {
  return {
    documentIds: new Map(),
    files: new Set(),
    storeIds: new Set(),
    postIds: new Set(),
    matchIds: new Set()
  };
}

async function buildCleanupPlan(identity, tracker) {
  const { openid, user } = identity;
  const removals = new Map();
  const files = new Set();

  function addDocuments(name, documents) {
    let seen = tracker.documentIds.get(name);
    if (!seen) {
      seen = new Set();
      tracker.documentIds.set(name, seen);
    }
    let ids = removals.get(name);
    if (!ids) {
      ids = [];
      removals.set(name, ids);
    }
    documents.forEach((document) => {
      if (seen.has(document._id)) return;
      seen.add(document._id);
      ids.push(document._id);
      addCloudValue(files, document, identity, tracker.files);
    });
  }

  async function gather(name, query) {
    const documents = await queryDocuments(name, query);
    addDocuments(name, documents);
    return documents;
  }

  addCloudValue(files, user, identity, tracker.files);
  await gather('training_sessions', { _openid: openid });
  await gather('coaches', { _openid: openid });
  await gather('shops', { _openid: openid });
  const stores = await gather('stores', { _openid: openid });
  const posts = await gather('posts', { _openid: openid });
  await gather('post_likes', { _openid: openid });
  await gather('post_comments', _.or({ _openid: openid }, { authorOpenid: openid }));
  const matches = await gather('matches', { _openid: openid });
  await gather('match_joins', { _openid: openid });
  await gather('bookings', { _openid: openid });
  await gather('sms_codes', { _openid: openid });
  await gather('shop_applications', { _openid: openid });
  await gather(
    'coach_shop_applications',
    _.or({ _openid: openid }, { coachOpenid: openid }, { shopOpenid: openid })
  );
  await gather('checkin_requests', { memberOpenid: openid });
  await gather(
    'sessions',
    _.or({ _openid: openid }, { memberOpenid: openid }, { coachOpenid: openid })
  );
  const lessons = await queryDocuments(
    'coach_lessons',
    _.or({ coachOpenid: openid }, { memberOpenid: openid })
  );
  addDocuments('coach_lessons', lessons.filter((lesson) => !isFinancialLesson(lesson)));
  await gather('brands', { _openid: openid });
  await gather(
    'members',
    _.or({ _openid: openid }, { openid }, { memberOpenid: openid })
  );
  await gather('coach_member_links', _.or({ coachOpenid: openid }, { memberOpenid: openid }));
  await gather('shop_coach_links', _.or({ shopOpenid: openid }, { coachOpenid: openid }));
  await gather('user_follows', _.or({ _openid: openid }, { authorOpenid: openid }));

  stores.forEach((store) => tracker.storeIds.add(store._id));
  posts.forEach((post) => tracker.postIds.add(post._id));
  matches.forEach((match) => tracker.matchIds.add(match._id));
  for (const storeId of tracker.storeIds) {
    await gather('checkin_requests', { storeId });
    await gather('sessions', { storeId });
    await gather('shop_coach_links', { storeId });
  }
  for (const postId of tracker.postIds) {
    await gather('post_likes', { postId });
    await gather('post_comments', { postId });
  }
  for (const matchId of tracker.matchIds) {
    await gather('match_joins', { matchId });
  }

  return {
    removals: Array.from(removals.entries())
      .filter((entry) => entry[1].length)
      .map(([name, ids]) => ({ name, ids })),
    files: Array.from(files)
  };
}

async function validateAndRenewLease(transaction, candidate, leaseId) {
  const now = Date.now();
  const identity = await readIdentity(transaction, candidate, now, false);
  if (
    !identity ||
    identity.user.deletionStatus !== 'purging' ||
    identity.user.purgeLeaseId !== leaseId ||
    identity.request.purgeLeaseId !== leaseId ||
    identity.user.purgeLeaseExpiresAt <= now
  ) {
    throw lifecycleError('PURGE_LEASE_LOST');
  }
  const lease = {
    purgeLeaseExpiresAt: now + PURGE_LEASE_MS,
    updatedAt: db.serverDate()
  };
  await transaction.collection('users').doc(identity.userId).update({ data: lease });
  await transaction.collection('account_deletion_requests').doc(identity.userId).update({ data: lease });
  return identity;
}

async function renewLease(candidate, leaseId) {
  return db.runTransaction((transaction) => (
    validateAndRenewLease(transaction, candidate, leaseId)
  ));
}

async function deleteCloudFiles(candidate, leaseId, files) {
  for (let offset = 0; offset < files.length; offset += 50) {
    const batch = files.slice(offset, offset + 50);
    await renewLease(candidate, leaseId);
    const result = await cloud.deleteFile({ fileList: batch });
    const outcomes = result && Array.isArray(result.fileList) ? result.fileList : [];
    const byFile = new Map(outcomes.map((item) => [item.fileID, item]));
    const failed = batch.some((fileID) => {
      const outcome = byFile.get(fileID);
      if (!outcome) return true;
      if (Object.prototype.hasOwnProperty.call(outcome, 'code')) {
        return outcome.code !== 'SUCCESS' && outcome.code !== 'STORAGE_FILE_NONEXIST';
      }
      return outcome.status !== 0 && outcome.status !== 'SUCCESS';
    });
    if (failed) {
      throw lifecycleError('CLOUD_FILE_DELETE_FAILED');
    }
  }
}

async function deleteDocumentBatch(candidate, leaseId, name, ids) {
  return db.runTransaction(async (transaction) => {
    await validateAndRenewLease(transaction, candidate, leaseId);
    let removed = 0;
    for (const id of ids) {
      const result = await transaction.collection(name).doc(id).delete();
      removed += result && result.stats && Number.isFinite(result.stats.removed)
        ? result.stats.removed
        : 1;
    }
    return removed;
  });
}

async function executeCleanup(candidate, leaseId, plan) {
  await deleteCloudFiles(candidate, leaseId, plan.files);
  const removed = {};
  for (const item of plan.removals) {
    for (let offset = 0; offset < item.ids.length; offset += DOCUMENT_DELETE_BATCH_SIZE) {
      const batch = item.ids.slice(offset, offset + DOCUMENT_DELETE_BATCH_SIZE);
      const count = await deleteDocumentBatch(candidate, leaseId, item.name, batch);
      removed[item.name] = (removed[item.name] || 0) + count;
    }
  }

  return removed;
}

async function executeStableCleanup(identity, candidate, leaseId) {
  const tracker = createCleanupTracker();
  const removed = {};
  for (let scan = 0; scan < MAX_CLEANUP_SCANS; scan += 1) {
    const plan = await buildCleanupPlan(identity, tracker);
    if (!plan.files.length && !plan.removals.length) return removed;
    if (await hasActiveSubscription(db, identity.openid)) {
      throw lifecycleError('ACTIVE_SUBSCRIPTION');
    }
    const partial = await executeCleanup(candidate, leaseId, plan);
    Object.keys(partial).forEach((name) => {
      removed[name] = (removed[name] || 0) + partial[name];
    });
  }
  throw lifecycleError('CLEANUP_NOT_STABLE');
}

async function listAllDue() {
  const candidates = [];
  let lastSeen = '';
  const statusQuery = { deletionStatus: _.in(['pending', 'purging']) };
  while (true) {
    const query = lastSeen
      ? _.and(statusQuery, { _id: _.gt(lastSeen) })
      : statusQuery;
    const page = await db.collection('users')
      .where(query)
      .orderBy('_id', 'asc')
      .limit(100)
      .get();
    const data = page && Array.isArray(page.data) ? page.data : [];
    if (data.some((candidate) => !candidate || typeof candidate._id !== 'string' || !candidate._id)) {
      throw lifecycleError('INVALID_CANDIDATE_ID');
    }
    candidates.push(...data);
    if (data.length < 100) break;
    const nextLastSeen = data[data.length - 1]._id;
    if (nextLastSeen <= lastSeen) throw lifecycleError('UNSTABLE_CANDIDATE_CURSOR');
    lastSeen = nextLastSeen;
  }
  return candidates;
}

function maskedBinding(candidate) {
  const openid = candidate && candidate._openid;
  const value = openid
    ? bindingId(openid)
    : sha256(`candidate:${candidate && candidate._id ? candidate._id : ''}`);
  return value.slice(0, 12);
}

function warnFailure(code, candidate, error) {
  const reason = error && error.lifecycleCode ? ` reason=${error.lifecycleCode}` : '';
  console.warn(`[purgeDeletedAccounts] ${code} binding=${maskedBinding(candidate)}${reason}`);
}

async function purgeIdentity(candidate, removed, leaseId) {
  return db.runTransaction(async (transaction) => {
    const now = Date.now();
    const identity = await readIdentity(transaction, candidate, now, false);
    if (!identity) throw new Error('AUTH_CHAIN_CHANGED');
    if (
      identity.user.deletionStatus !== 'purging' ||
      identity.user.purgeLeaseId !== leaseId ||
      identity.request.purgeLeaseId !== leaseId ||
      identity.user.purgeLeaseExpiresAt <= now
    ) {
      throw lifecycleError('PURGE_LEASE_LOST');
    }

    const accountRef = transaction.collection('accounts').doc(identity.accountId);
    const bindingRef = transaction.collection('wechat_bindings').doc(identity.userId);
    const userRef = transaction.collection('users').doc(identity.userId);
    const requestRef = transaction.collection('account_deletion_requests').doc(identity.userId);
    await accountRef.delete();
    await bindingRef.delete();
    await userRef.delete();
    await requestRef.update({
      data: {
        deletionStatus: 'purged',
        _openid: _.remove(),
        accountId: _.remove(),
        account: _.remove(),
        reason: _.remove(),
        deletionRequestedAt: _.remove(),
        deletionScheduledAt: _.remove(),
        purgeLeaseId: _.remove(),
        purgeLeaseExpiresAt: _.remove(),
        purgedAt: db.serverDate(),
        removed,
        updatedAt: db.serverDate()
      }
    });
    return identity;
  });
}

exports.main = async (event = {}) => {
  const context = cloud.getWXContext() || {};
  if (
    context.OPENID ||
    event.Type !== 'Timer' ||
    event.TriggerName !== 'dailyAccountDeletionPurge'
  ) {
    return { ok: false, code: 'FORBIDDEN' };
  }

  const leaseId = crypto.randomBytes(16).toString('hex');
  let candidates;
  try {
    candidates = await listAllDue();
  } catch (error) {
    console.warn('[purgeDeletedAccounts] BATCH_READ_FAILED');
    return { ok: false, checked: 0, purged: 0, failed: 1 };
  }

  let purged = 0;
  let failed = 0;
  let checked = 0;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const candidateNow = Date.now();
    if (
      candidate.deletionStatus === 'pending' &&
      Number.isFinite(candidate.deletionScheduledAt) &&
      candidate.deletionScheduledAt > candidateNow
    ) {
      continue;
    }
    checked += 1;

    let identity;
    try {
      const preflight = await readIdentity(db, candidate, candidateNow);
      if (!preflight) throw lifecycleError('AUTH_CHAIN_CHANGED');
      identity = await claimIdentity(candidate, candidateNow, leaseId);
    } catch (error) {
      failed += 1;
      warnFailure('PURGE_PREFLIGHT_FAILED', candidate, error);
      continue;
    }
    if (!identity) {
      failed += 1;
      warnFailure('PURGE_PREFLIGHT_FAILED', candidate);
      continue;
    }

    let removed;
    try {
      removed = await executeStableCleanup(identity, candidate, leaseId);
    } catch (error) {
      failed += 1;
      warnFailure('AUXILIARY_CLEANUP_FAILED', candidate, error);
      continue;
    }

    try {
      if (await hasActiveSubscription(db, identity.openid)) {
        throw lifecycleError('ACTIVE_SUBSCRIPTION');
      }
      await purgeIdentity(candidate, removed, leaseId);
      purged += 1;
    } catch (error) {
      failed += 1;
      warnFailure('AUTH_PURGE_FAILED', candidate, error);
    }
  }

  return { ok: failed === 0, checked, purged, failed };
};
