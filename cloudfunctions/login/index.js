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

async function getBindingByOpenid(openid) {
  const result = await db.collection('wechat_bindings').doc(bindingId(openid)).get();
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
  const users = db.collection('users');
  const requestedRole = VALID_ROLES.indexOf(event.role) !== -1 ? event.role : 'member';
  const binding = await getBindingByOpenid(OPENID);
  if (!binding || binding._id !== bindingId(OPENID) || binding._openid !== OPENID || !binding.accountId) {
    return fail('ACCOUNT_NOT_BOUND', '请先登录或注册账号');
  }
  const accountResult = await db.collection('accounts').doc(binding.accountId).get();
  const account = accountResult && accountResult.data ? accountResult.data : null;
  if (
    !account ||
    account.status !== 'active' ||
    account._openid !== OPENID ||
    account._id !== binding.accountId ||
    account.account !== binding.account
  ) {
    return fail('ACCOUNT_NOT_BOUND', '账号绑定信息不完整');
  }

  const userResult = await users.doc(binding._id).get();
  const user = userResult && userResult.data ? userResult.data : null;
  if (!user || user._id !== binding._id || user._openid !== OPENID) {
    return fail('ACCOUNT_NOT_BOUND', '账号资料不存在');
  }
  let deletionCanceled = false;
  if (user.deletionStatus === 'pending') {
    const scheduledAt = user.deletionScheduledAt || 0;
    if (scheduledAt && Date.now() >= scheduledAt) {
      return fail('ACCOUNT_DELETION_LOCKED', '账号注销已进入删除流程，无法继续登录');
    }
    deletionCanceled = true;
    await users.doc(user._id).update({
      data: {
        deletionStatus: _.remove(),
        deletionReason: _.remove(),
        deletionRequestedAt: _.remove(),
        deletionScheduledAt: _.remove(),
        deletionCanceledAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    try {
      await db.collection('account_deletion_requests')
        .where({ _openid: OPENID, deletionStatus: 'pending' })
        .update({
          data: {
            deletionStatus: 'canceled',
            deletionCanceledAt: db.serverDate()
          }
        });
    } catch (e) {}
  }

  const roles = normalizeServerRoles(user);
  if (roles.indexOf(requestedRole) === -1) {
    return fail('ROLE_NOT_ALLOWED', '该账号未开通此身份');
  }
  await users.doc(user._id).update({
    data: { roles, currentRole: requestedRole, role: requestedRole, updatedAt: db.serverDate() }
  });

  return safeUserResult(user, roles, requestedRole, account, deletionCanceled);
};
