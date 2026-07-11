const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const PHONE_RE = /^1\d{10}$/;
const CODE_RE = /^\d{6}$/;

function hashCode(phone, code) {
  const secret = process.env.SMS_CODE_HASH_SECRET || process.env.CUETRACE_SMS_SECRET_KEY || '';
  return crypto.createHash('sha256').update(`${phone}:${code}:${secret}`).digest('hex');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function serverRoles(user) {
  const source = Array.isArray(user && user.roles) ? user.roles : [];
  const roles = source.filter((role) => ['member', 'coach', 'shop'].indexOf(role) !== -1);
  return Array.from(new Set(roles.length ? roles : ['member']));
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const phone = String(event.phone || '').trim();
  const smsCode = String(event.code || '').trim();
  if (!PHONE_RE.test(phone)) return { ok: false, code: 'INVALID_PHONE', msg: '请输入正确的手机号' };
  if (!CODE_RE.test(smsCode)) return { ok: false, code: 'INVALID_CODE', msg: '请输入 6 位验证码' };
  if (!(process.env.SMS_CODE_HASH_SECRET || process.env.CUETRACE_SMS_SECRET_KEY)) {
    return { ok: false, code: 'CONFIG_MISSING', msg: '短信服务未配置' };
  }

  const bindingId = sha256(`wechat:${OPENID}`);
  const bindingRes = await db.collection('wechat_bindings').doc(bindingId).get().catch(() => null);
  const binding = bindingRes && bindingRes.data;
  if (!binding) {
    return { ok: false, code: 'WECHAT_NOT_BOUND', msg: '请先绑定或注册账号' };
  }
  if (!binding.accountId || binding._openid !== OPENID) {
    return { ok: false, code: 'ACCOUNT_NOT_BOUND', msg: '账号绑定不完整' };
  }

  const accountRes = await db.collection('accounts').doc(binding.accountId).get().catch(() => null);
  const account = accountRes && accountRes.data;
  if (!account || account._openid !== OPENID || account.account !== binding.account) {
    return { ok: false, code: 'ACCOUNT_NOT_BOUND', msg: '账号绑定不完整' };
  }
  if (account.status !== 'active') {
    return { ok: false, code: 'ACCOUNT_DISABLED', msg: '账号已停用' };
  }

  const userRes = await db.collection('users').doc(bindingId).get().catch(() => null);
  const user = userRes && userRes.data;
  if (!user || user._openid !== OPENID) {
    return { ok: false, code: 'ACCOUNT_NOT_BOUND', msg: '账号绑定不完整' };
  }
  if (user.phone !== phone) {
    return { ok: false, code: 'PHONE_NOT_MATCH', msg: '手机号与当前账号不匹配' };
  }

  const now = Date.now();
  const codes = db.collection('sms_codes');
  const found = await codes
    .where({ phone, _openid: OPENID, used: false })
    .limit(20)
    .get();
  const expected = hashCode(phone, smsCode);
  const matched = (found.data || [])
    .filter((item) => item.expiresAt > now)
    .sort((a, b) => b.createdAt - a.createdAt)
    .find((item) => item.codeHash === expected);
  if (!matched) return { ok: false, code: 'INVALID_CODE', msg: '验证码错误或已过期' };

  await codes.doc(matched._id).update({
    data: {
      used: true,
      usedAt: now
    }
  });

  const phoneData = {
    phone,
    phoneVerifiedAt: now,
    updatedAt: db.serverDate()
  };
  await db.collection('users').doc(bindingId).update({ data: phoneData });

  const roles = serverRoles(user);
  return {
    ok: true,
    phone,
    account: account.account,
    roles,
    currentRole: user.currentRole || user.role || roles[0]
  };
};
