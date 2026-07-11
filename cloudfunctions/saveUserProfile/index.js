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
  if (!existing.data || !existing.data.length) {
    return { ok: false, code: 'ACCOUNT_NOT_BOUND', msg: '账号资料不存在' };
  }
  const current = existing.data[0];
  const roles = normalizeRoles(current.role, current.roles);
  const requestedRole = event.role || current.currentRole || current.role || roles[0];
  if (roles.indexOf(requestedRole) === -1) {
    return { ok: false, code: 'ROLE_NOT_ALLOWED', msg: '该账号未开通此身份' };
  }
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
    currentRole: requestedRole,
    role: requestedRole,
    updatedAt: db.serverDate()
  };

  await users.doc(current._id).update({ data: profile });

  return { ok: true };
};
