const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const BOOTSTRAP_ADMIN_OPENIDS = [
  'ovvdY3VKYCo7_jTzdpgGbuf26-tA'
];
const ADMIN_ACCOUNTS = ['admin_zhx'];
const VALID_ROLES = ['member', 'coach', 'shop'];

function bindingId(openid) {
  return crypto.createHash('sha256').update(`wechat:${openid}`).digest('hex');
}

function mergeShopRole(user) {
  const roles = Array.isArray(user && user.roles) ? user.roles.filter((role) => VALID_ROLES.indexOf(role) !== -1) : [];
  if (roles.indexOf('member') === -1) roles.unshift('member');
  if (roles.indexOf('shop') === -1) roles.push('shop');
  return Array.from(new Set(roles));
}

async function getBoundIdentity(transaction, openid) {
  const bindingDocId = bindingId(openid);
  const bindingRes = await transaction.collection('wechat_bindings').doc(bindingDocId).get();
  const binding = bindingRes && bindingRes.data;
  if (
    !binding ||
    binding._id !== bindingDocId ||
    binding._openid !== openid ||
    !binding.accountId ||
    !binding.account
  ) return null;
  const accountRes = await transaction.collection('accounts').doc(binding.accountId).get();
  const account = accountRes && accountRes.data;
  if (
    !account ||
    account._id !== binding.accountId ||
    account._openid !== openid ||
    account.account !== binding.account ||
    account.status !== 'active'
  ) return null;
  return { binding, account, userDocId: bindingDocId };
}

async function getActiveAdmins() {
  try {
    const res = await db.collection('admins').where({ status: 'active' }).get();
    return res.data || [];
  } catch (e) {
    return [];
  }
}

async function isAdminOpenid(openid, loginName) {
  if (ADMIN_ACCOUNTS.indexOf(loginName) === -1) return false;
  const admins = await getActiveAdmins();
  if (admins.length) {
    return admins.some((item) => item._openid === openid && item.account === loginName);
  }
  return BOOTSTRAP_ADMIN_OPENIDS.indexOf(openid) !== -1;
}

// 管理员审核店主资质申请：approve=true 通过 / false 驳回（驳回写 reason，店主可见）。
// 通过后把 shop 授权合并到申请人的 users.roles，不改变其当前身份。仅管理员可调用。
exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const loginName = (event.loginName || '').trim();
  if (!(await isAdminOpenid(OPENID, loginName))) {
    return { ok: false, code: 'FORBIDDEN', msg: '无审核权限' };
  }

  const { applicationId, approve, reason } = event;
  if (!applicationId) return { ok: false, msg: '缺少申请 ID' };

  try {
    return await db.runTransaction(async (transaction) => {
      const apps = transaction.collection('shop_applications');
      const res = await apps.doc(applicationId).get();
      const application = res.data;
      if (!application) return { ok: false, msg: '申请不存在' };

      const users = transaction.collection('users');
      let user = null;
      let identity = null;
      if (approve) {
        identity = await getBoundIdentity(transaction, application._openid);
        if (!identity) {
          return { ok: false, code: 'ACCOUNT_NOT_BOUND', msg: '账号绑定信息不完整' };
        }
        const userRes = await users.doc(identity.userDocId).get();
        user = userRes && userRes.data;
        if (user && (user._id !== identity.userDocId || user._openid !== application._openid)) {
          return { ok: false, code: 'ACCOUNT_NOT_BOUND', msg: '账号绑定信息不完整' };
        }
      }

      const status = approve ? 'approved' : 'rejected';
      await apps.doc(applicationId).update({
        data: {
          status,
          reason: approve ? '' : (reason || '资料未通过核验'),
          reviewedBy: OPENID,
          reviewedAt: db.serverDate()
        }
      });

      if (approve) {
        if (user) {
          await users.doc(identity.userDocId).update({
            data: {
              roles: mergeShopRole(user),
              updatedAt: db.serverDate()
            }
          });
        } else {
          await users.doc(identity.userDocId).set({
            data: {
              _id: identity.userDocId,
              _openid: application._openid,
              roles: ['member', 'shop'],
              currentRole: 'member',
              role: 'member',
              nickname: '',
              avatar: '',
              createdAt: db.serverDate(),
              updatedAt: db.serverDate()
            }
          });
        }
      }

      return { ok: true, status };
    });
  } catch (err) {
    console.error('reviewShopApplication failed', err);
    return { ok: false, msg: '审核失败，请重试' };
  }
};
