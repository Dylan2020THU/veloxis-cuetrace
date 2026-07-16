const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const PHONE_RE = /^1\d{10}$/;
const CODE_RE = /^\d{6}$/;
const MAX_FAILED_ATTEMPTS = 5;

function hashCode(phone, code) {
  const secret = process.env.SMS_CODE_HASH_SECRET || process.env.CUETRACE_SMS_SECRET_KEY || '';
  return crypto.createHash('sha256').update(`${phone}:${code}:${secret}`).digest('hex');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function smsCodeId(openid, phone) {
  return sha256(`sms:${openid}:${phone}`);
}

function normalizeAccount(value) {
  return String(value || '').trim().toLowerCase();
}

function invalidCodeResult() {
  return { ok: false, code: 'INVALID_CODE', msg: '验证码错误或已失效' };
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
  if (!OPENID) return { ok: false, code: 'UNAUTHORIZED', msg: '无法识别微信身份' };
  if (!PHONE_RE.test(phone)) return { ok: false, code: 'INVALID_PHONE', msg: '请输入正确的手机号' };
  if (!CODE_RE.test(smsCode)) return { ok: false, code: 'INVALID_CODE', msg: '请输入 6 位验证码' };
  if (!(process.env.SMS_CODE_HASH_SECRET || process.env.CUETRACE_SMS_SECRET_KEY)) {
    return { ok: false, code: 'CONFIG_MISSING', msg: '短信服务未配置' };
  }

  const expected = hashCode(phone, smsCode);
  const bindingId = sha256(`wechat:${OPENID}`);
  const codeId = smsCodeId(OPENID, phone);
  return db.runTransaction(async (transaction) => {
    const codeRef = transaction.collection('sms_codes').doc(codeId);
    const codeRes = await codeRef.get();
    const code = codeRes && codeRes.data;
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
    const accountNormalized = normalizeAccount(binding.account);
    const expectedAccountId = accountNormalized ? sha256(`account:${accountNormalized}`) : '';
    if (
      !account
      || !accountNormalized
      || binding.accountId !== account._id
      || binding.accountId !== expectedAccountId
      || account._id !== expectedAccountId
      || account._openid !== OPENID
      || account.account !== binding.account
      || account.accountNormalized !== accountNormalized
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
    const transactionNow = Date.now();
    if (
      !code
      || code._id !== codeId
      || code.used !== false
      || code.locked !== false
      || code._openid !== OPENID
      || code.phone !== phone
      || typeof code.codeHash !== 'string'
      || !code.codeHash
      || !Number.isFinite(code.createdAt)
      || !Number.isFinite(code.expiresAt)
      || code.expiresAt <= transactionNow
      || !Number.isInteger(code.failedAttempts)
      || code.failedAttempts < 0
      || code.failedAttempts >= MAX_FAILED_ATTEMPTS
    ) {
      return invalidCodeResult();
    }
    if (code.codeHash !== expected) {
      const previousAttempts = Number.isInteger(code.failedAttempts) && code.failedAttempts > 0
        ? code.failedAttempts
        : 0;
      const failedAttempts = Math.min(previousAttempts + 1, MAX_FAILED_ATTEMPTS);
      const locked = failedAttempts >= MAX_FAILED_ATTEMPTS;
      const data = {
        failedAttempts,
        locked,
        used: locked,
        updatedAt: db.serverDate()
      };
      if (locked) data.lockedAt = transactionNow;
      await codeRef.update({ data });
      return invalidCodeResult();
    }

    await codeRef.update({
      data: {
        used: true,
        usedAt: transactionNow,
        updatedAt: db.serverDate()
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
