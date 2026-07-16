const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const DELETE_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function bindingId(openid) {
  return sha256(`wechat:${openid}`);
}

function fail(code, msg) {
  return { ok: false, code, msg };
}

function isBlockingSubscriptionStatus(status) {
  return status === 'active' || status === 'pending_contract' || status === 'cancel_required';
}

async function getOptional(ref) {
  const result = await ref.get();
  return result && result.data ? result.data : null;
}

async function readLifecycle(database, openid, userId) {
  const binding = await getOptional(database.collection('wechat_bindings').doc(userId));
  if (
    !binding ||
    binding._id !== userId ||
    binding._openid !== openid ||
    !binding.accountId ||
    !binding.account
  ) {
    return { error: fail('ACCOUNT_NOT_BOUND', '请先登录或注册账号') };
  }

  const account = await getOptional(database.collection('accounts').doc(binding.accountId));
  const user = await getOptional(database.collection('users').doc(userId));
  const request = await getOptional(database.collection('account_deletion_requests').doc(userId));
  if (
    !account ||
    account._id !== binding.accountId ||
    account._openid !== openid ||
    account.account !== binding.account ||
    account.status !== 'active' ||
    !user ||
    user._id !== userId ||
    user._openid !== openid
  ) {
    return { error: fail('ACCOUNT_NOT_BOUND', '账号绑定信息不完整') };
  }

  if (user.deletionStatus === 'purging') {
    return { error: fail('ACCOUNT_DELETION_LOCKED', '账号注销已进入删除流程，无法重复申请') };
  }

  const pendingIdentityMatches = !!(
    request &&
    request._id === userId &&
    request._openid === openid &&
    request.accountId === binding.accountId &&
    request.account === binding.account
  );
  if (request && request.deletionStatus === 'pending' && !pendingIdentityMatches) {
    return {
      error: fail('DELETION_REQUEST_INCONSISTENT', '注销申请状态不一致，请稍后重试')
    };
  }

  const consistentPending = !!(
    request &&
    request.deletionStatus === 'pending' &&
    pendingIdentityMatches &&
    user.deletionStatus === 'pending' &&
    Number.isFinite(user.deletionRequestedAt) &&
    Number.isFinite(user.deletionScheduledAt) &&
    Number.isFinite(request.deletionRequestedAt) &&
    Number.isFinite(request.deletionScheduledAt) &&
    request.deletionRequestedAt === user.deletionRequestedAt &&
    request.deletionScheduledAt === user.deletionScheduledAt
  );
  if (user.deletionStatus === 'pending' && !consistentPending) {
    return {
      error: fail('DELETION_REQUEST_INCONSISTENT', '注销申请状态不一致，请稍后重试')
    };
  }
  if (isBlockingSubscriptionStatus(user.subscriptionStatus)) {
    return { error: fail('ACTIVE_SUBSCRIPTION', '请先取消连续包月服务再申请注销') };
  }
  return { binding, user, request, consistentPending };
}

// 账号注销：提交注销申请并进入 7 天保留期，不在这里立即删除数据。
exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const reason = String(event.reason || '').slice(0, 80);
  const now = Date.now();
  const userId = bindingId(OPENID);

  const initial = await readLifecycle(db, OPENID, userId);
  if (initial.error) return initial.error;
  const subscriptions = await db.collection('subscriptions')
    .where({
      _openid: OPENID,
      status: db.command.in(['active', 'pending_contract', 'cancel_required'])
    })
    .limit(1)
    .get();
  if (subscriptions.data.length) {
    return fail('ACTIVE_SUBSCRIPTION', '请先取消连续包月服务再申请注销');
  }

  return db.runTransaction(async (transaction) => {
    const lifecycle = await readLifecycle(transaction, OPENID, userId);
    if (lifecycle.error) return lifecycle.error;
    const { binding, request: existingRequest, consistentPending } = lifecycle;
    const userRef = transaction.collection('users').doc(userId);
    const requestRef = transaction.collection('account_deletion_requests').doc(userId);

    const deletionRequestedAt = consistentPending
      ? existingRequest.deletionRequestedAt
      : now;
    const deletionScheduledAt = consistentPending
      ? existingRequest.deletionScheduledAt
      : now + DELETE_DELAY_MS;
    const deletionReason = consistentPending ? (existingRequest.reason || reason) : reason;

    await userRef.update({
      data: {
        deletionStatus: 'pending',
        deletionReason,
        deletionRequestedAt,
        deletionScheduledAt,
        updatedAt: db.serverDate()
      }
    });
    await requestRef.set({
      data: {
        _id: userId,
        _openid: OPENID,
        accountId: binding.accountId,
        account: binding.account,
        reason: deletionReason,
        deletionStatus: 'pending',
        deletionRequestedAt,
        deletionScheduledAt,
        createdAt: consistentPending && existingRequest.createdAt
          ? existingRequest.createdAt
          : db.serverDate(),
        updatedAt: db.serverDate()
      }
    });

    return { ok: true, deletionStatus: 'pending', deletionRequestedAt, deletionScheduledAt };
  });
};

const { guardClientRequest } = require('./lib/auth/protocol-guard');
const protocolGuardedMain = exports.main;

exports.main = async (event = {}, ...args) => {
  const gate = await guardClientRequest({
    db,
    event,
    supportedSchemaVersions: [1]
  });
  if (!gate.ok) return gate;
  let businessEvent = event;
  if (Object.prototype.hasOwnProperty.call(event, 'authProtocol')) {
    businessEvent = { ...event };
    delete businessEvent.authProtocol;
  }
  return protocolGuardedMain(businessEvent, ...args);
};
