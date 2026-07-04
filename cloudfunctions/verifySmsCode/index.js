const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const PHONE_RE = /^1\d{10}$/;
const CODE_RE = /^\d{6}$/;

function hashCode(phone, code) {
  const secret = process.env.SMS_CODE_HASH_SECRET || process.env.TENCENTCLOUD_SECRET_KEY || '';
  return crypto.createHash('sha256').update(`${phone}:${code}:${secret}`).digest('hex');
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const phone = String(event.phone || '').trim();
  const smsCode = String(event.code || '').trim();
  if (!PHONE_RE.test(phone)) return { ok: false, code: 'INVALID_PHONE', msg: '请输入正确的手机号' };
  if (!CODE_RE.test(smsCode)) return { ok: false, code: 'INVALID_CODE', msg: '请输入 6 位验证码' };
  if (!(process.env.SMS_CODE_HASH_SECRET || process.env.TENCENTCLOUD_SECRET_KEY)) {
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
    .find((item) => item.codeHash === expected);
  if (!matched) return { ok: false, code: 'INVALID_CODE', msg: '验证码错误或已过期' };

  await codes.doc(matched._id).update({
    data: {
      used: true,
      usedAt: now
    }
  });

  const users = db.collection('users');
  const existing = await users.where({ _openid: OPENID }).limit(1).get();
  const phoneData = {
    phone,
    phoneVerifiedAt: now,
    updatedAt: db.serverDate()
  };
  if (existing.data.length) {
    await users.doc(existing.data[0]._id).update({ data: phoneData });
  } else {
    await users.add({
      data: Object.assign({
        _openid: OPENID,
        role: 'member',
        nickname: '',
        avatar: '',
        createdAt: db.serverDate()
      }, phoneData)
    });
  }

  return { ok: true, phone };
};
