const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const VALID_ROLES = ['member', 'coach', 'shop'];

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function bindingId(openid) {
  return sha256(`wechat:${openid}`);
}

function normalizeRoles(roles) {
  const list = Array.isArray(roles) ? roles.filter((r) => VALID_ROLES.indexOf(r) !== -1) : [];
  if (list.length) return Array.from(new Set(list));
  return ['member'];
}

async function getDocument(collection, id) {
  const result = await db.collection(collection).doc(id).get();
  return result && result.data ? result.data : null;
}

// 只读取当前微信绑定对应的确定性 users 文档。
exports.main = async () => {
  const { OPENID } = cloud.getWXContext();

  try {
    const userId = bindingId(OPENID);
    const binding = await getDocument('wechat_bindings', userId);
    if (!binding || binding._id !== userId || binding._openid !== OPENID || !binding.accountId) {
      return { user: null };
    }
    const account = await getDocument('accounts', binding.accountId);
    const source = await getDocument('users', userId);
    if (
      !account ||
      account._id !== binding.accountId ||
      account._openid !== OPENID ||
      account.account !== binding.account ||
      account.status !== 'active' ||
      !source ||
      source._id !== userId ||
      source._openid !== OPENID
    ) {
      return { user: null };
    }

    const roles = normalizeRoles(source.roles);
    const currentRole = roles.indexOf(source.currentRole) !== -1 ? source.currentRole : roles[0];
    const user = {
      openid: OPENID,
      storageNamespace: userId,
      role: currentRole,
      roles,
      currentRole,
      nickname: source.nickname || '大川会员',
      avatar: source.avatar || '',
      gender: source.gender || '',
      birthDate: source.birthDate || '',
      phone: source.phoneVerifiedAt ? (source.phone || '') : '',
      locationCity: source.locationCity || '',
      hometown: Array.isArray(source.hometown) ? source.hometown : [],
      years: source.years || '',
      level: source.level || '',
      canSeeGender: source.canSeeGender !== undefined ? !!source.canSeeGender : true,
      canSeeBirthDate: source.canSeeBirthDate !== undefined ? !!source.canSeeBirthDate : true,
      canSeeHometown: source.canSeeHometown !== undefined ? !!source.canSeeHometown : true,
      canSeePhone: source.canSeePhone !== undefined ? !!source.canSeePhone : false
    };
    return { user };
  } catch (err) {
    console.error('getUserProfile failed', err);
    return { user: null };
  }
};
