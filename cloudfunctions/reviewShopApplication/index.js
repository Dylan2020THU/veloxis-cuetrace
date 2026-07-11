const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const BOOTSTRAP_ADMIN_OPENIDS = [
  'ovvdY3VKYCo7_jTzdpgGbuf26-tA'
];
const ADMIN_ACCOUNTS = ['admin_zhx'];
const VALID_ROLES = ['member', 'coach', 'shop'];

function mergeShopRole(user) {
  const roles = Array.isArray(user && user.roles) ? user.roles.filter((role) => VALID_ROLES.indexOf(role) !== -1) : [];
  if (user && VALID_ROLES.indexOf(user.role) !== -1 && roles.indexOf(user.role) === -1) roles.push(user.role);
  if (roles.indexOf('member') === -1) roles.unshift('member');
  if (roles.indexOf('shop') === -1) roles.push('shop');
  return Array.from(new Set(roles));
}

async function hasActiveAccountBinding(openid) {
  const bindingRes = await db.collection('wechat_bindings').where({ _openid: openid }).limit(1).get();
  const binding = bindingRes.data && bindingRes.data[0];
  if (!binding || !binding.accountId || !binding.account) return false;
  const accountRes = await db.collection('accounts').doc(binding.accountId).get();
  const account = accountRes && accountRes.data;
  return !!(
    account &&
    account._id === binding.accountId &&
    account._openid === openid &&
    account.account === binding.account &&
    account.status === 'active'
  );
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

  const apps = db.collection('shop_applications');
  try {
    const res = await apps.doc(applicationId).get();
    const application = res.data;
    if (!application) return { ok: false, msg: '申请不存在' };

    const users = db.collection('users');
    let user = null;
    if (approve) {
      const userRes = await users.where({ _openid: application._openid }).get();
      user = userRes.data && userRes.data[0];
      if (!user && !(await hasActiveAccountBinding(application._openid))) {
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
        await users.doc(user._id).update({
          data: {
            roles: mergeShopRole(user),
            updatedAt: db.serverDate()
          }
        });
      } else {
        await users.add({
          data: {
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
  } catch (err) {
    console.error('reviewShopApplication failed', err);
    return { ok: false, msg: '审核失败，请重试' };
  }
};
