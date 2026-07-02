const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const profile = {
    nickname: event.nickname || '',
    avatar: event.avatar || '',
    gender: event.gender || '',
    birthDate: event.birthDate || '',
    phone: event.phone || '',
    locationCity: event.locationCity || '',
    hometown: Array.isArray(event.hometown) ? event.hometown : [],
    years: event.years || '',
    level: event.level || '',
    canSeeGender: event.canSeeGender !== undefined ? !!event.canSeeGender : true,
    canSeeBirthDate: event.canSeeBirthDate !== undefined ? !!event.canSeeBirthDate : true,
    canSeeHometown: event.canSeeHometown !== undefined ? !!event.canSeeHometown : true,
    canSeePhone: event.canSeePhone !== undefined ? !!event.canSeePhone : false,
    role: 'member',
    updatedAt: db.serverDate()
  };

  const users = db.collection('users');
  const existing = await users.where({ _openid: OPENID }).get();
  if (existing.data.length) {
    await users.doc(existing.data[0]._id).update({ data: profile });
  } else {
    await users.add({ data: Object.assign({ _openid: OPENID }, profile) });
  }

  return { ok: true };
};
