const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const VALID_ROLES = ['member', 'coach', 'shop'];
const ADMIN_ACCOUNTS = ['admin_zhx'];

function normalizeRoles(role, roles) {
  const list = Array.isArray(roles) ? roles.filter((r) => VALID_ROLES.indexOf(r) !== -1) : [];
  if (list.length) return Array.from(new Set(list));
  if (role === 'coach') return ['member', 'coach'];
  if (role === 'shop') return ['shop'];
  return ['member'];
}

function canEnterRole(roles, role) {
  return normalizeRoles('', roles).indexOf(role) !== -1;
}

function mergeRoles(a, b) {
  return Array.from(new Set((a || []).concat(b || []).filter((r) => VALID_ROLES.indexOf(r) !== -1)));
}

async function ensureAdminAccount(openid, account) {
  if (!account || ADMIN_ACCOUNTS.indexOf(account) === -1) return;
  try {
    const admins = db.collection('admins');
    const res = await admins.where({ _openid: openid }).get();
    const data = {
      _openid: openid,
      account,
      status: 'active',
      updatedAt: db.serverDate()
    };
    if (res.data.length) {
      await admins.doc(res.data[0]._id).update({ data });
    } else {
      await admins.add({ data: Object.assign({}, data, { createdAt: db.serverDate() }) });
    }
  } catch (err) {
    console.error('ensure admin account failed', err);
  }
}

// 登录：以微信身份(openid)为唯一账号，在 users 集合中创建/更新用户记录。
// event.role 可选：登录页选定的身份；传入时写入云端，实现身份长期持久化（换设备/清缓存仍生效）。
// 返回 { openid, role }，role 以云端记录为准，供前端同步本地。
exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const users = db.collection('users');
  const role = VALID_ROLES.indexOf(event.role) !== -1 ? event.role : '';
  const requestedRoles = Array.isArray(event.roles) ? normalizeRoles('', event.roles) : [];
  const loginName = (event.loginName || '').trim();

  let roles = normalizeRoles(role || 'member');
  let currentRole = role || roles[0] || 'member';
  let nickname = '';
  let avatar = '';
  let deletionCanceled = false;
  try {
    const existing = await users.where({ _openid: OPENID }).get();
    if (existing.data.length) {
      const doc = existing.data[0];
      if (doc.deletionStatus === 'pending') {
        const scheduledAt = doc.deletionScheduledAt || 0;
        if (scheduledAt && Date.now() >= scheduledAt) {
          return {
            ok: false,
            code: 'ACCOUNT_DELETION_LOCKED',
            msg: '账号注销已进入删除流程，无法继续登录'
          };
        }
        deletionCanceled = true;
        await users.doc(doc._id).update({
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
      roles = mergeRoles(normalizeRoles(doc.role, doc.roles), requestedRoles);
      currentRole = role || doc.currentRole || doc.role || roles[0] || 'member';
      if (!canEnterRole(roles, currentRole)) {
        return {
          ok: false,
          code: 'ROLE_NOT_ALLOWED',
          msg: currentRole === 'coach'
            ? '该账号尚未开通教练身份'
            : currentRole === 'shop'
              ? '该账号尚未开通店主身份'
              : '该账号不能登录球员端'
        };
      }
      nickname = doc.nickname || '';
      avatar = doc.avatar || '';
      await users.doc(doc._id).update({
        data: { roles, currentRole, role: currentRole, updatedAt: db.serverDate() }
      });
    } else {
      roles = mergeRoles(normalizeRoles(role || 'member'), requestedRoles);
      currentRole = role || roles[0] || 'member';
      await users.add({
        data: {
          _openid: OPENID,
          roles,
          currentRole,
          role: currentRole,
          nickname: '',
          avatar: '',
          createdAt: db.serverDate()
        }
      });
    }
  } catch (err) {
    // 集合不存在等情况不阻塞登录
    console.error('init user failed', err);
  }

  await ensureAdminAccount(OPENID, loginName);

  return { openid: OPENID, role: currentRole, roles, currentRole, nickname, avatar, deletionCanceled };
};
