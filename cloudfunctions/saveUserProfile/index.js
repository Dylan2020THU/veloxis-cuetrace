const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const users = db.collection('users');
  const existing = await users.where({ _openid: OPENID }).get();
  const current = (existing.data && existing.data[0]) || {};
  const profile = {
    nickname: event.nickname !== undefined ? event.nickname : (current.nickname || ''),
    avatar: event.avatar !== undefined ? event.avatar : (current.avatar || ''),
    gender: event.gender !== undefined ? event.gender : (current.gender || ''),
    birthDate: event.birthDate !== undefined ? event.birthDate : (current.birthDate || ''),
    phone: event.phone !== undefined ? event.phone : (current.phone || ''),
    locationCity: event.locationCity !== undefined ? event.locationCity : (current.locationCity || ''),
    hometown: event.hometown !== undefined
      ? (Array.isArray(event.hometown) ? event.hometown : [])
      : (Array.isArray(current.hometown) ? current.hometown : []),
    years: event.years !== undefined ? event.years : (current.years || ''),
    level: event.level !== undefined ? event.level : (current.level || ''),
    canSeeGender: event.canSeeGender !== undefined ? !!event.canSeeGender : (current.canSeeGender !== undefined ? !!current.canSeeGender : true),
    canSeeBirthDate: event.canSeeBirthDate !== undefined ? !!event.canSeeBirthDate : (current.canSeeBirthDate !== undefined ? !!current.canSeeBirthDate : true),
    canSeeHometown: event.canSeeHometown !== undefined ? !!event.canSeeHometown : (current.canSeeHometown !== undefined ? !!current.canSeeHometown : true),
    canSeePhone: event.canSeePhone !== undefined ? !!event.canSeePhone : (current.canSeePhone !== undefined ? !!current.canSeePhone : false),
    role: event.role || current.role || 'member',
    updatedAt: db.serverDate()
  };

  if (existing.data.length) {
    await users.doc(existing.data[0]._id).update({ data: profile });
  } else {
    await users.add({ data: Object.assign({ _openid: OPENID }, profile) });
  }

  return { ok: true };
};
