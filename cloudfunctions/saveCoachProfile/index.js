const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 保存（创建或更新）当前用户的教练资料，并将其角色标记为 coach
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const {
    nickname,
    playYears,
    coachYears,
    avatar,
    certificates,
    intro,
    availability,
    pricePerMinute
  } = event;

  const profile = {
    nickname: nickname || '',
    playYears: Number(playYears) || 0,
    coachYears: Number(coachYears) || 0,
    avatar: avatar || '',
    certificates: Array.isArray(certificates) ? certificates : [],
    intro: intro || '',
    availability: Array.isArray(availability) ? availability : [],
    pricePerMinute: Number(pricePerMinute) || 0,
    updatedAt: db.serverDate()
  };

  const coaches = db.collection('coaches');
  const existing = await coaches.where({ _openid: OPENID }).get();
  if (existing.data.length) {
    await coaches.doc(existing.data[0]._id).update({ data: profile });
  } else {
    await coaches.add({ data: Object.assign({ _openid: OPENID }, profile) });
  }

  // 同步用户角色
  try {
    const users = db.collection('users');
    const u = await users.where({ _openid: OPENID }).get();
    if (u.data.length) {
      await users.doc(u.data[0]._id).update({ data: { role: 'coach' } });
    } else {
      await users.add({ data: { _openid: OPENID, role: 'coach' } });
    }
  } catch (err) {
    console.error('update user role failed', err);
  }

  return { ok: true };
};
