const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const { ses } = require('tencentcloud-sdk-nodejs-ses');

const SesClient = ses.v20201002.Client;

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database({ throwOnNotFound: false });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PUBLIC_RESET_RESULT = {
  ok: true,
  accepted: true,
  msg: '若信息匹配，验证码将发送至绑定邮箱'
};
const SES_TIMEOUT_MS = 8000;
const RESET_RESPONSE_MIN_MS = SES_TIMEOUT_MS + 1500;
const COOLDOWN_MS = 60 * 1000;
const EXPIRES_MS = 10 * 60 * 1000;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function normalizeAccount(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function accountId(account) {
  return sha256(`account:${normalizeAccount(account)}`);
}

function wechatBindingId(openid) {
  return sha256(`wechat:${openid}`);
}

function emailBindingId(email) {
  return sha256(`email:${normalizeEmail(email)}`);
}

function emailCodeId(purpose, email) {
  return sha256(`email-code:${purpose}:${normalizeEmail(email)}`);
}

function emailRateId(purpose, actor) {
  return sha256(`email-rate:${purpose}:${sha256(actor)}`);
}

function getConfig() {
  return {
    secretId: process.env.CUETRACE_SES_SECRET_ID || '',
    secretKey: process.env.CUETRACE_SES_SECRET_KEY || '',
    region: process.env.CUETRACE_SES_REGION || 'ap-guangzhou',
    fromEmail: process.env.CUETRACE_SES_FROM_EMAIL || '',
    templateId: Number(process.env.CUETRACE_SES_TEMPLATE_ID || 0),
    subject: process.env.CUETRACE_SES_SUBJECT || '强化杆迹验证码',
    replyTo: process.env.CUETRACE_SES_REPLY_TO || '',
    codeSecret: process.env.CUETRACE_EMAIL_CODE_SECRET || ''
  };
}

function isConfigured(config) {
  return !!(
    config.secretId &&
    config.secretKey &&
    config.region &&
    config.fromEmail &&
    Number.isInteger(config.templateId) &&
    config.templateId > 0 &&
    config.codeSecret
  );
}

function messageFor(code) {
  const messages = {
    INVALID_INPUT: '请求参数不正确',
    WECHAT_NOT_BOUND: '当前微信尚未绑定账号',
    ACCOUNT_NOT_BOUND: '账号绑定信息不完整，请重新登录',
    ACCOUNT_DISABLED: '账号已停用',
    ACCOUNT_DELETION_IN_PROGRESS: '账号注销处理中，请稍后重试',
    EMAIL_INVALID: '邮箱格式不正确',
    EMAIL_ALREADY_BOUND: '该邮箱已绑定其他账号',
    EMAIL_CODE_COOLDOWN: '请稍后重新发送',
    EMAIL_NOT_CONFIGURED: '邮件服务尚未配置',
    EMAIL_SEND_FAILED: '邮件发送失败，请稍后重试'
  };
  return messages[code] || '请求失败';
}

function fail(code) {
  return { ok: false, code, msg: messageFor(code) };
}

async function publicResetResult(startedAt) {
  const elapsed = Math.max(0, Date.now() - startedAt);
  const remaining = Math.max(0, RESET_RESPONSE_MIN_MS - elapsed);
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
  return PUBLIC_RESET_RESULT;
}

function serviceError(code) {
  const error = new Error(code);
  error.serviceCode = code;
  return error;
}

async function getOptional(ref) {
  const result = await ref.get();
  return result && result.data ? result.data : null;
}

function isAccountIdentity(account, id, openid) {
  return !!account &&
    account._id === id &&
    account._openid === openid &&
    account.accountNormalized === normalizeAccount(account.account) &&
    accountId(account.account) === id;
}

function isWechatIdentity(binding, id, openid, account) {
  return !!binding &&
    binding._id === id &&
    binding._openid === openid &&
    binding.accountId === account._id &&
    binding.account === account.account;
}

function isUserIdentity(user, id, openid) {
  return !!user && user._id === id && user._openid === openid;
}

function isEmailIdentity(binding, id, account, email) {
  return !!binding &&
    binding._id === id &&
    binding._openid === account._openid &&
    binding.status === 'active' &&
    binding.accountId === account._id &&
    binding.account === account.account &&
    binding.email === email &&
    binding.emailNormalized === email &&
    account.emailBindingId === id;
}

function isCooling(document, now) {
  const nextSendAt = Number(document && document.nextSendAt);
  return Number.isFinite(nextSendAt) && nextSendAt > now;
}

function makeRequestId() {
  return crypto.randomBytes(16).toString('hex');
}

function makeCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function hashCode(config, challengeId, code) {
  return crypto.createHmac('sha256', config.codeSecret)
    .update(`${challengeId}:${code}`)
    .digest('hex');
}

function makeSesClient(config) {
  return new SesClient({
    credential: {
      secretId: config.secretId,
      secretKey: config.secretKey
    },
    region: config.region,
    profile: {
      httpProfile: {
        endpoint: 'ses.tencentcloudapi.com',
        reqTimeout: SES_TIMEOUT_MS / 1000
      }
    }
  });
}

function makeSesParams(config, email, code) {
  const params = {
    FromEmailAddress: config.fromEmail,
    Destination: [email],
    Subject: config.subject,
    Template: {
      TemplateID: config.templateId,
      TemplateData: JSON.stringify({ code, minutes: '10' })
    },
    TriggerType: 1
  };
  if (config.replyTo) params.ReplyToAddresses = config.replyTo;
  return params;
}

function sanitizeToken(value, fallback) {
  const token = String(value || '');
  return /^[A-Za-z0-9_.-]{1,64}$/.test(token) ? token : fallback;
}

function logFailure(error, fallback) {
  console.error('sendEmailCode failure', {
    type: sanitizeToken(error && (error.code || error.name), fallback),
    requestId: sanitizeToken(
      error && (error.requestId || error.RequestId),
      'unavailable'
    )
  });
}

async function reserve(event, openid, email, requestId) {
  const purpose = event.purpose;
  const challengeId = emailCodeId(purpose, email);
  const actor = openid || accountId(event.account);
  const rateId = emailRateId(purpose, actor);

  return db.runTransaction(async (transaction) => {
    const challengeRef = transaction.collection('email_codes').doc(challengeId);
    const rateRef = transaction.collection('email_codes').doc(rateId);
    const challenge = await getOptional(challengeRef);
    const rate = await getOptional(rateRef);
    const now = Date.now();
    let target;

    if (purpose === 'bind') {
      if (!openid) throw serviceError('WECHAT_NOT_BOUND');
      const bindingId = wechatBindingId(openid);
      const binding = await getOptional(
        transaction.collection('wechat_bindings').doc(bindingId)
      );
      if (!binding) throw serviceError('WECHAT_NOT_BOUND');
      const account = await getOptional(
        transaction.collection('accounts').doc(binding.accountId)
      );
      const user = await getOptional(transaction.collection('users').doc(bindingId));
      if (!isAccountIdentity(account, binding.accountId, openid) ||
        !isWechatIdentity(binding, bindingId, openid, account) ||
        !isUserIdentity(user, bindingId, openid)
      ) {
        throw serviceError('ACCOUNT_NOT_BOUND');
      }
      if (account.status !== 'active') throw serviceError('ACCOUNT_DISABLED');
      if (user.deletionStatus === 'purging') {
        throw serviceError('ACCOUNT_DELETION_IN_PROGRESS');
      }
      const targetId = emailBindingId(email);
      const existing = await getOptional(
        transaction.collection('email_bindings').doc(targetId)
      );
      if (existing && existing.status === 'active' && existing.accountId !== account._id) {
        throw serviceError('EMAIL_ALREADY_BOUND');
      }
      target = { accountId: account._id, emailBindingId: targetId };
      if (isCooling(challenge, now) || isCooling(rate, now)) {
        throw serviceError('EMAIL_CODE_COOLDOWN');
      }
    } else {
      if (openid) {
        const actorUserId = wechatBindingId(openid);
        const actorUser = await getOptional(
          transaction.collection('users').doc(actorUserId)
        );
        if (isUserIdentity(actorUser, actorUserId, openid) &&
          actorUser.deletionStatus === 'purging'
        ) {
          return { shouldSend: false };
        }
      }
      const expectedAccountId = accountId(event.account);
      const account = await getOptional(
        transaction.collection('accounts').doc(expectedAccountId)
      );
      const targetId = emailBindingId(email);
      const binding = await getOptional(
        transaction.collection('email_bindings').doc(targetId)
      );
      const validAccount = isAccountIdentity(
        account,
        expectedAccountId,
        account && account._openid
      ) && account.status === 'active';
      const userId = validAccount ? wechatBindingId(account._openid) : '';
      const user = userId
        ? await getOptional(transaction.collection('users').doc(userId))
        : null;
      const matched = validAccount &&
        isUserIdentity(user, userId, account._openid) &&
        isEmailIdentity(binding, targetId, account, email);

      if (matched && user.deletionStatus === 'purging') return { shouldSend: false };
      if (isCooling(rate, now)) return { shouldSend: false };

      if (!matched || isCooling(challenge, now)) {
        await rateRef.set({ data: {
          purpose,
          actorHash: sha256(actor),
          requestId,
          status: 'rate_limit',
          nextSendAt: now + COOLDOWN_MS,
          updatedAt: now
        } });
        return { shouldSend: false };
      }
      target = { accountId: account._id, emailBindingId: targetId };
    }

    const nextSendAt = now + COOLDOWN_MS;
    await challengeRef.set({ data: {
      purpose,
      accountId: target.accountId,
      emailBindingId: target.emailBindingId,
      targetHash: target.emailBindingId,
      requestId,
      status: 'sending',
      nextSendAt,
      updatedAt: now
    } });
    await rateRef.set({ data: {
      purpose,
      actorHash: sha256(actor),
      requestId,
      status: 'rate_limit',
      nextSendAt,
      updatedAt: now
    } });

    return {
      shouldSend: true,
      challengeId,
      requestId
    };
  });
}

async function updateChallenge(reservation, data) {
  return db.runTransaction(async (transaction) => {
    const ref = transaction.collection('email_codes').doc(reservation.challengeId);
    const challenge = await getOptional(ref);
    if (!challenge || challenge.requestId !== reservation.requestId) return false;
    await ref.update({ data });
    return true;
  });
}

async function markFailed(reservation) {
  await updateChallenge(reservation, {
    status: 'failed',
    updatedAt: Date.now()
  });
}

async function sendReserved(client, config, reservation, email, code, codeHash) {
  try {
    await client.SendEmail(makeSesParams(config, email, code));
  } catch (error) {
    logFailure(error, 'SES_ERROR');
    try {
      await markFailed(reservation);
    } catch (markError) {
      logFailure(markError, 'DATABASE_ERROR');
    }
    return false;
  }

  const now = Date.now();
  return updateChallenge(reservation, {
    codeHash,
    status: 'active',
    attemptsLeft: 5,
    expiresAt: now + EXPIRES_MS,
    sentAt: now,
    updatedAt: now
  });
}

async function main(event) {
  const startedAt = Date.now();
  const input = event || {};
  const config = getConfig();
  if (!isConfigured(config)) return fail('EMAIL_NOT_CONFIGURED');
  if ((input.action && input.action !== 'send') ||
    (input.purpose !== 'bind' && input.purpose !== 'reset')
  ) {
    return fail('INVALID_INPUT');
  }

  const email = normalizeEmail(input.email);
  if (!EMAIL_RE.test(email) || email.length > 254) return fail('EMAIL_INVALID');

  let openid;
  let client;
  let requestId;
  let resetCode;
  let resetCodeHash;
  try {
    const context = cloud.getWXContext() || {};
    openid = String(context.OPENID || '');
    client = makeSesClient(config);
    requestId = makeRequestId();
    if (input.purpose === 'reset') {
      resetCode = makeCode();
      resetCodeHash = hashCode(config, emailCodeId(input.purpose, email), resetCode);
    }
  } catch (error) {
    logFailure(error, 'EMAIL_SERVICE_ERROR');
    return input.purpose === 'reset'
      ? publicResetResult(startedAt)
      : fail('EMAIL_SEND_FAILED');
  }

  let reservation;
  try {
    reservation = await reserve(input, openid, email, requestId);
  } catch (error) {
    if (input.purpose === 'reset') {
      if (!error.serviceCode) logFailure(error, 'DATABASE_ERROR');
      return publicResetResult(startedAt);
    }
    if (error.serviceCode) return fail(error.serviceCode);
    logFailure(error, 'DATABASE_ERROR');
    return fail('EMAIL_SEND_FAILED');
  }

  if (!reservation.shouldSend) return publicResetResult(startedAt);

  let sent;
  try {
    const code = resetCode || makeCode();
    const codeHash = resetCodeHash || hashCode(config, reservation.challengeId, code);
    sent = await sendReserved(client, config, reservation, email, code, codeHash);
  } catch (error) {
    logFailure(error, 'DATABASE_ERROR');
    return input.purpose === 'reset'
      ? publicResetResult(startedAt)
      : fail('EMAIL_SEND_FAILED');
  }
  if (input.purpose === 'reset') return publicResetResult(startedAt);
  if (!sent) return fail('EMAIL_SEND_FAILED');
  return { ok: true, accepted: true, msg: '验证码已发送' };
}

exports.main = main;
