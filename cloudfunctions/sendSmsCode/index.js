const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const https = require('https');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const PHONE_RE = /^1\d{10}$/;
const CODE_TTL_MS = 5 * 60 * 1000;
const RESEND_MS = 60 * 1000;
const SMS_HOST = 'sms.tencentcloudapi.com';
const SMS_SERVICE = 'sms';
const SMS_VERSION = '2021-01-11';
const SMS_TIMEOUT_MS = 8000;

function sha256(value, encoding) {
  return crypto.createHash('sha256').update(value).digest(encoding || 'hex');
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

function hashCode(phone, code) {
  const secret = process.env.SMS_CODE_HASH_SECRET || process.env.CUETRACE_SMS_SECRET_KEY || '';
  return sha256(`${phone}:${code}:${secret}`);
}

function smsCodeId(openid, phone) {
  return sha256(`sms:${openid}:${phone}`);
}

function config() {
  const cfg = {
    secretId: process.env.CUETRACE_SMS_SECRET_ID || '',
    secretKey: process.env.CUETRACE_SMS_SECRET_KEY || '',
    smsSdkAppId: process.env.CUETRACE_SMS_SDK_APP_ID || '',
    signName: process.env.CUETRACE_SMS_SIGN_NAME || '',
    templateId: process.env.CUETRACE_SMS_TEMPLATE_ID || '',
    region: process.env.CUETRACE_SMS_REGION || 'ap-guangzhou',
    templateParams: process.env.CUETRACE_SMS_TEMPLATE_PARAMS || 'code,expire'
  };
  const missing = Object.keys(cfg).filter((k) => k !== 'region' && k !== 'templateParams' && !cfg[k]);
  return { cfg, missing };
}

function buildTemplateParamSet(code, templateParams) {
  return String(templateParams || 'code,expire')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (p === 'expire' ? String(CODE_TTL_MS / 60 / 1000) : code));
}

function signRequest(payload, cfg, timestamp) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const contentType = 'application/json; charset=utf-8';
  const canonicalHeaders = `content-type:${contentType}\nhost:${SMS_HOST}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256(payload)
  ].join('\n');
  const credentialScope = `${date}/${SMS_SERVICE}/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(timestamp),
    credentialScope,
    sha256(canonicalRequest)
  ].join('\n');
  const secretDate = hmac(`TC3${cfg.secretKey}`, date);
  const secretService = hmac(secretDate, SMS_SERVICE);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = hmac(secretSigning, stringToSign, 'hex');

  return `TC3-HMAC-SHA256 Credential=${cfg.secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function sendTencentSms(phone, code, cfg) {
  const body = JSON.stringify({
    PhoneNumberSet: [`+86${phone}`],
    SmsSdkAppId: cfg.smsSdkAppId,
    SignName: cfg.signName,
    TemplateId: cfg.templateId,
    TemplateParamSet: buildTemplateParamSet(code, cfg.templateParams)
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const headers = {
    Authorization: signRequest(body, cfg, timestamp),
    'Content-Type': 'application/json; charset=utf-8',
    Host: SMS_HOST,
    'X-TC-Action': 'SendSms',
    'X-TC-Timestamp': String(timestamp),
    'X-TC-Version': SMS_VERSION,
    'X-TC-Region': cfg.region
  };

  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'POST',
      hostname: SMS_HOST,
      path: '/',
      headers
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch (e) {
          reject(new Error('短信服务返回异常'));
          return;
        }
        const status = parsed && parsed.Response && parsed.Response.SendStatusSet && parsed.Response.SendStatusSet[0];
        if (res.statusCode >= 200 && res.statusCode < 300 && status && status.Code === 'Ok') {
          resolve(parsed.Response);
          return;
        }
        reject(new Error((status && status.Message) || (parsed.Response && parsed.Response.Error && parsed.Response.Error.Message) || '短信发送失败'));
      });
    });
    req.on('error', reject);
    req.setTimeout(SMS_TIMEOUT_MS, () => {
      req.destroy(new Error('SMS request timeout'));
    });
    req.write(body);
    req.end();
  });
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const phone = String(event.phone || '').trim();
  if (!OPENID) return { ok: false, code: 'UNAUTHORIZED', msg: '无法识别微信身份' };
  if (!PHONE_RE.test(phone)) return { ok: false, code: 'INVALID_PHONE', msg: '请输入正确的手机号' };

  const { cfg, missing } = config();
  if (missing.length) {
    return { ok: false, code: 'CONFIG_MISSING', msg: '短信服务未配置', missing };
  }

  const codeId = smsCodeId(OPENID, phone);
  const attemptId = crypto.randomBytes(16).toString('hex');
  const claim = await db.runTransaction(async (transaction) => {
    const codeRef = transaction.collection('sms_codes').doc(codeId);
    const result = await codeRef.get();
    const current = result && result.data;
    const transactionNow = Date.now();
    if (
      current
      && (
        current._id !== codeId
        || current._openid !== OPENID
        || current.phone !== phone
      )
    ) {
      return { ok: false, code: 'SMS_STATE_INVALID', msg: '验证码状态异常，请稍后重试' };
    }
    if (
      current
      && Number.isFinite(current.lastSendAttemptAt)
      && transactionNow - current.lastSendAttemptAt < RESEND_MS
    ) {
      return { ok: false, code: 'TOO_FREQUENT', msg: '请稍后再获取验证码' };
    }

    const data = {
      _openid: OPENID,
      phone,
      attemptId,
      lastSendAttemptAt: transactionNow,
      codeHash: '',
      failedAttempts: 0,
      locked: false,
      lockedAt: 0,
      used: true,
      usedAt: 0,
      expiresAt: 0,
      updatedAt: db.serverDate()
    };
    if (current) await codeRef.update({ data });
    else await codeRef.set({ data });
    return { ok: true };
  });
  if (!claim || claim.ok !== true) {
    return claim || { ok: false, code: 'SMS_SEND_FAILED', msg: '验证码发送失败，请稍后重试' };
  }

  const smsCode = String(crypto.randomInt(100000, 1000000));
  try {
    await sendTencentSms(phone, smsCode, cfg);
  } catch (e) {
    return { ok: false, code: 'SMS_SEND_FAILED', msg: '验证码发送失败，请稍后重试' };
  }

  const finalized = await db.runTransaction(async (transaction) => {
    const codeRef = transaction.collection('sms_codes').doc(codeId);
    const result = await codeRef.get();
    const current = result && result.data;
    if (
      !current
      || current._id !== codeId
      || current._openid !== OPENID
      || current.phone !== phone
      || current.attemptId !== attemptId
    ) {
      return false;
    }
    const transactionNow = Date.now();
    await codeRef.update({
      data: {
        codeHash: hashCode(phone, smsCode),
        failedAttempts: 0,
        locked: false,
        used: false,
        createdAt: transactionNow,
        expiresAt: transactionNow + CODE_TTL_MS,
        updatedAt: db.serverDate()
      }
    });
    return true;
  });
  if (!finalized) {
    return { ok: false, code: 'SMS_SEND_CONFLICT', msg: '验证码状态已变更，请重新获取' };
  }

  return { ok: true, expiresIn: CODE_TTL_MS / 1000 };
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
