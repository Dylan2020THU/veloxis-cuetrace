const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const DELETE_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

// 账号注销：提交注销申请并进入 7 天保留期，不在这里立即删除数据。
exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const reason = String(event.reason || '').slice(0, 80);
  const now = Date.now();
  const deletionScheduledAt = now + DELETE_DELAY_MS;
  const users = db.collection('users');

  const data = {
    deletionStatus: 'pending',
    deletionReason: reason,
    deletionRequestedAt: now,
    deletionScheduledAt,
    updatedAt: db.serverDate()
  };

  const found = await users.where({ _openid: OPENID }).limit(1).get();
  if (found.data.length) {
    await users.doc(found.data[0]._id).update({ data });
  } else {
    await users.add({
      data: Object.assign({
        _openid: OPENID,
        role: 'member',
        nickname: '',
        avatar: '',
        createdAt: db.serverDate()
      }, data)
    });
  }

  try {
    await db.collection('account_deletion_requests').add({
      data: {
        _openid: OPENID,
        reason,
        deletionStatus: 'pending',
        deletionRequestedAt: now,
        deletionScheduledAt,
        createdAt: db.serverDate()
      }
    });
  } catch (err) {
    console.warn('[deleteAccount] write account_deletion_requests failed', err);
  }

  return { ok: true, deletionStatus: 'pending', deletionRequestedAt: now, deletionScheduledAt };
};
