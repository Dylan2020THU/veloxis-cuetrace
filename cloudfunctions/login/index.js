const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const VALID_ROLES = ['member', 'coach', 'shop'];

// 登录：以微信身份(openid)为唯一账号，在 users 集合中创建/更新用户记录。
// event.role 可选：登录页选定的身份；传入时写入云端，实现身份长期持久化（换设备/清缓存仍生效）。
// 返回 { openid, role }，role 以云端记录为准，供前端同步本地。
exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const users = db.collection('users');
  const role = VALID_ROLES.indexOf(event.role) !== -1 ? event.role : '';

  let userRole = 'member';
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
      userRole = role || doc.role || 'member';
      nickname = doc.nickname || '';
      avatar = doc.avatar || '';
      // 仅当显式传入且与云端不一致时才更新，避免无谓写操作
      if (role && role !== doc.role) {
        await users.doc(doc._id).update({ data: { role, updatedAt: db.serverDate() } });
      }
    } else {
      userRole = role || 'member';
      await users.add({
        data: {
          _openid: OPENID,
          role: userRole,
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

  return { openid: OPENID, role: userRole, nickname, avatar, deletionCanceled };
};
