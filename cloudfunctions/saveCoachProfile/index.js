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
    pricePerMinute,
    hallId,
    hallName,
    coachId
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
    hallId: hallId || '',
    hallName: hallName || '',
    coachId: coachId || '',
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
    const userPatch = { role: 'coach', updatedAt: db.serverDate() };
    if (nickname) userPatch.nickname = nickname;
    if (avatar) userPatch.avatar = avatar;
    if (u.data.length) {
      await users.doc(u.data[0]._id).update({ data: userPatch });
    } else {
      await users.add({
        data: Object.assign({ _openid: OPENID, nickname: nickname || '', avatar: avatar || '' }, userPatch)
      });
    }
  } catch (err) {
    console.error('update user role failed', err);
  }

  return { ok: true };
};
