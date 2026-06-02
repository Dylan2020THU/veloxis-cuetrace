const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 登录：返回 openid，并在 users 集合中初始化会员记录
exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  const users = db.collection('users');

  try {
    const existing = await users.where({ _openid: OPENID }).get();
    if (!existing.data.length) {
      await users.add({
        data: {
          _openid: OPENID,
          role: 'member',
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

  return { openid: OPENID };
};
