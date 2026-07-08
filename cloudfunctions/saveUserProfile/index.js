const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const VALID_ROLES = ['member', 'coach', 'shop'];

function normalizeRoles(role, roles) {
  const list = Array.isArray(roles) ? roles.filter((r) => VALID_ROLES.indexOf(r) !== -1) : [];
  if (list.length) return Array.from(new Set(list));
  if (role === 'coach') return ['member', 'coach'];
  if (role === 'shop') return ['shop'];
  return ['member'];
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const users = db.collection('users');
  const existing = await users.where({ _openid: OPENID }).get();
  const current = (existing.data && existing.data[0]) || {};
  const roles = normalizeRoles(current.role, current.roles);
  const currentRole = event.role || current.currentRole || current.role || roles[0] || 'member';
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
    roles,
    currentRole,
    role: currentRole,
    updatedAt: db.serverDate()
  };

  if (existing.data.length) {
    await users.doc(existing.data[0]._id).update({ data: profile });
  } else {
    await users.add({ data: Object.assign({ _openid: OPENID }, profile) });
  }

  return { ok: true };
};
