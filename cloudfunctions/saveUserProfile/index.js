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

function fail(code, msg) {
  return { ok: false, code, msg };
}

async function getOptional(ref) {
  const result = await ref.get();
  return result && result.data ? result.data : null;
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const userId = bindingId(OPENID);
  return db.runTransaction(async (transaction) => {
    const binding = await getOptional(transaction.collection('wechat_bindings').doc(userId));
    if (!binding || binding._id !== userId || binding._openid !== OPENID || !binding.accountId) {
      return fail('ACCOUNT_NOT_BOUND', '请先登录或注册账号');
    }

    const account = await getOptional(transaction.collection('accounts').doc(binding.accountId));
    const userRef = transaction.collection('users').doc(userId);
    const current = await getOptional(userRef);
    if (
      !account ||
      account._id !== binding.accountId ||
      account._openid !== OPENID ||
      account.account !== binding.account ||
      account.status !== 'active' ||
      !current ||
      current._id !== userId ||
      current._openid !== OPENID
    ) {
      return fail('ACCOUNT_NOT_BOUND', '账号绑定信息不完整');
    }
    if (current.deletionStatus === 'pending' || current.deletionStatus === 'purging') {
      return fail('ACCOUNT_DELETION_PENDING', '账号正在注销，无法修改资料');
    }

    const roles = normalizeRoles(current.roles);
    const currentRole = roles.indexOf(current.currentRole) !== -1 ? current.currentRole : roles[0];
    const requestedRole = event.role || currentRole;
    if (roles.indexOf(requestedRole) === -1) {
      return fail('ROLE_NOT_ALLOWED', '该账号未开通此身份');
    }
    const profile = {
      nickname: event.nickname !== undefined ? event.nickname : (current.nickname || ''),
      avatar: event.avatar !== undefined ? event.avatar : (current.avatar || ''),
      gender: event.gender !== undefined ? event.gender : (current.gender || ''),
      birthDate: event.birthDate !== undefined ? event.birthDate : (current.birthDate || ''),
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
      updatedAt: db.serverDate()
    };

    await userRef.update({ data: profile });
    return { ok: true };
  });
};

const { guardClientRequest } = require('./lib/auth/protocol-guard');
const protocolGuardedMain = exports.main;

exports.main = async (event = {}, ...args) => {
  const gate = await guardClientRequest({
    db,
    event,
    supportedSchemaVersions: [1]
  });
  if (!gate.ok) return gate;
  let businessEvent = event;
  if (Object.prototype.hasOwnProperty.call(event, 'authProtocol')) {
    businessEvent = { ...event };
    delete businessEvent.authProtocol;
  }
  return protocolGuardedMain(businessEvent, ...args);
};
