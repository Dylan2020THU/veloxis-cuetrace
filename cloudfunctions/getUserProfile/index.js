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

// 读取当前微信用户在 users 集合中的资料；昵称缺失时从教练/店铺资料补全
exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  const users = db.collection('users');

  let user = { openid: OPENID, role: 'member', roles: ['member'], currentRole: 'member', nickname: '', avatar: '' };

  try {
    const res = await users.where({ _openid: OPENID }).get();
    if (res.data.length) {
      const u = res.data[0];
      const roles = normalizeRoles(u.role, u.roles);
      const currentRole = u.currentRole || u.role || roles[0] || 'member';
      user = Object.assign(user, {
        role: currentRole,
        roles,
        currentRole,
        nickname: u.nickname || '',
        avatar: u.avatar || '',
        gender: u.gender || '',
        birthDate: u.birthDate || '',
        phone: u.phone || '',
        locationCity: u.locationCity || '',
        hometown: Array.isArray(u.hometown) ? u.hometown : [],
        years: u.years || '',
        level: u.level || '',
        canSeeGender: u.canSeeGender !== undefined ? !!u.canSeeGender : true,
        canSeeBirthDate: u.canSeeBirthDate !== undefined ? !!u.canSeeBirthDate : true,
        canSeeHometown: u.canSeeHometown !== undefined ? !!u.canSeeHometown : true,
        canSeePhone: u.canSeePhone !== undefined ? !!u.canSeePhone : false
      });
    } else {
      return { user: null };
    }

    if (!user.nickname) {
      if (user.currentRole === 'coach' || user.roles.indexOf('coach') !== -1) {
        const c = await db.collection('coaches').where({ _openid: OPENID }).get();
        if (c.data.length && c.data[0].nickname) user.nickname = c.data[0].nickname;
      } else if (user.currentRole === 'shop') {
        const s = await db.collection('shops').where({ _openid: OPENID }).get();
        if (s.data.length && s.data[0].name) user.nickname = s.data[0].name;
      }
    }

    if (!user.nickname) user.nickname = '大川会员';
    return { user };
  } catch (err) {
    console.error('getUserProfile failed', err);
    return { user: null };
  }
};
