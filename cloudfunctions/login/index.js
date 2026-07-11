const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const VALID_ROLES = ['member', 'coach', 'shop'];

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function bindingId(openid) {
  return sha256(`wechat:${openid}`);
}

function fail(code, msg) {
  return { ok: false, code, msg };
}

function normalizeServerRoles(user) {
  const source = Array.isArray(user && user.roles) ? user.roles : [];
  const roles = source.filter((role) => VALID_ROLES.indexOf(role) !== -1);
  if (roles.length) return Array.from(new Set(roles));
  return ['member'];
}

async function getOptional(ref) {
  const result = await ref.get();
  return result && result.data ? result.data : null;
}

function safeUserResult(user, roles, currentRole, account, deletionCanceled) {
  return {
    openid: user._openid,
    account: account.account,
    role: currentRole,
    roles,
    currentRole,
    nickname: user.nickname || '',
    avatar: user.avatar || '',
    deletionCanceled: !!deletionCanceled
  };
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const requestedRole = VALID_ROLES.indexOf(event.role) !== -1 ? event.role : 'member';
  const userId = bindingId(OPENID);

  return db.runTransaction(async (transaction) => {
    const binding = await getOptional(transaction.collection('wechat_bindings').doc(userId));
    if (
      !binding ||
      binding._id !== userId ||
      binding._openid !== OPENID ||
      !binding.accountId ||
      !binding.account
    ) {
      return fail('ACCOUNT_NOT_BOUND', '请先登录或注册账号');
    }
    const account = await getOptional(transaction.collection('accounts').doc(binding.accountId));
    const userRef = transaction.collection('users').doc(userId);
    const requestRef = transaction.collection('account_deletion_requests').doc(userId);
    const user = await getOptional(userRef);
    const request = await getOptional(requestRef);
    if (
      !account ||
      account.status !== 'active' ||
      account._openid !== OPENID ||
      account._id !== binding.accountId ||
      account.account !== binding.account ||
      !user ||
      user._id !== userId ||
      user._openid !== OPENID
    ) {
      return fail('ACCOUNT_NOT_BOUND', '账号绑定信息不完整');
    }
    if (user.deletionStatus === 'purging') {
      return fail('ACCOUNT_DELETION_LOCKED', '账号注销已进入删除流程，无法继续登录');
    }

    const roles = normalizeServerRoles(user);
    if (roles.indexOf(requestedRole) === -1) {
      return fail('ROLE_NOT_ALLOWED', '该账号未开通此身份');
    }

    let deletionCanceled = false;
    const userUpdate = {
      roles,
      currentRole: requestedRole,
      role: requestedRole,
      updatedAt: db.serverDate()
    };
    if (user.deletionStatus === 'pending') {
      const consistentRequest = !!(
        request &&
        request._id === userId &&
        request._openid === OPENID &&
        request.accountId === binding.accountId &&
        request.account === binding.account &&
        request.deletionStatus === 'pending' &&
        Number.isFinite(user.deletionRequestedAt) &&
        Number.isFinite(user.deletionScheduledAt) &&
        Number.isFinite(request.deletionRequestedAt) &&
        Number.isFinite(request.deletionScheduledAt) &&
        request.deletionRequestedAt === user.deletionRequestedAt &&
        request.deletionScheduledAt === user.deletionScheduledAt
      );
      if (!consistentRequest) {
        return fail('DELETION_REQUEST_INCONSISTENT', '注销申请状态不一致，请稍后重试');
      }
      if (Date.now() >= user.deletionScheduledAt) {
        return fail('ACCOUNT_DELETION_LOCKED', '账号注销已进入删除流程，无法继续登录');
      }
      deletionCanceled = true;
      Object.assign(userUpdate, {
        deletionStatus: _.remove(),
        deletionReason: _.remove(),
        deletionRequestedAt: _.remove(),
        deletionScheduledAt: _.remove(),
        deletionCanceledAt: db.serverDate()
      });
      await requestRef.update({
        data: {
          deletionStatus: 'canceled',
          deletionCanceledAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      });
    } else if (request && request.deletionStatus === 'pending') {
      return fail('DELETION_REQUEST_INCONSISTENT', '注销申请状态不一致，请稍后重试');
    }

    await userRef.update({ data: userUpdate });
    return safeUserResult(user, roles, requestedRole, account, deletionCanceled);
  });
};
