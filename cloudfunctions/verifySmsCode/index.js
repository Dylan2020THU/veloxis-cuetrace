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
    .find((item) => item._id && item.codeHash === expected);
  if (!matched) return { ok: false, code: 'INVALID_CODE', msg: '验证码错误或已过期' };

  const bindingId = sha256(`wechat:${OPENID}`);
  return db.runTransaction(async (transaction) => {
    const bindingRef = transaction.collection('wechat_bindings').doc(bindingId);
    const bindingRes = await bindingRef.get();
    const binding = bindingRes && bindingRes.data;
    if (!binding) {
      return { ok: false, code: 'WECHAT_NOT_BOUND', msg: '请先绑定或注册账号' };
    }
    if (binding._id !== bindingId || !binding.accountId || binding._openid !== OPENID) {
      return { ok: false, code: 'ACCOUNT_NOT_BOUND', msg: '账号绑定不完整' };
    }

    const accountRef = transaction.collection('accounts').doc(binding.accountId);
    const accountRes = await accountRef.get();
    const account = accountRes && accountRes.data;
    if (
      !account
      || binding.accountId !== account._id
      || account._openid !== OPENID
      || account.account !== binding.account
    ) {
      return { ok: false, code: 'ACCOUNT_NOT_BOUND', msg: '账号绑定不完整' };
    }
    if (account.status !== 'active') {
      return { ok: false, code: 'ACCOUNT_DISABLED', msg: '账号已停用' };
    }

    const userRef = transaction.collection('users').doc(bindingId);
    const userRes = await userRef.get();
    const user = userRes && userRes.data;
    if (!user || user._id !== bindingId || user._openid !== OPENID) {
      return { ok: false, code: 'ACCOUNT_NOT_BOUND', msg: '账号绑定不完整' };
    }
    if (user.phone !== phone) {
      return { ok: false, code: 'PHONE_NOT_MATCH', msg: '手机号与当前账号不匹配' };
    }

    const codeRef = transaction.collection('sms_codes').doc(matched._id);
    const codeRes = await codeRef.get();
    const code = codeRes && codeRes.data;
    const transactionNow = Date.now();
    if (
      !code
      || code._id !== matched._id
      || code.used !== false
      || code._openid !== OPENID
      || code.phone !== phone
      || code.codeHash !== expected
      || code.expiresAt <= transactionNow
    ) {
      return { ok: false, code: 'INVALID_CODE', msg: '验证码错误或已过期' };
    }

    await codeRef.update({
      data: {
        used: true,
        usedAt: transactionNow
      }
    });
    await userRef.update({
      data: {
        phone,
        phoneVerifiedAt: transactionNow,
        updatedAt: db.serverDate()
      }
    });

    const roles = serverRoles(user);
    const currentRole = [user.currentRole, user.role].find((role) => roles.indexOf(role) !== -1) || roles[0];
    return {
      ok: true,
      phone,
      account: account.account,
      roles,
      currentRole
    };
  });
};
