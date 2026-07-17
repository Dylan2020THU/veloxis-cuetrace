'use strict';

const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const https = require('https');
const {
  loadKeyring,
  candidateHmacIds
} = require('./lib/auth/keyring');
const {
  normalizePhone,
  wechatIdentity
} = require('./lib/auth/identifiers');
const { requireSession } = require('./lib/auth/session');
const {
  claimSmsChallenge,
  finalizeSmsSend
} = require('./lib/auth/sms');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const SMS_HOST = 'sms.tencentcloudapi.com';
const SMS_SERVICE = 'sms';
const SMS_VERSION = '2021-01-11';
const SMS_TIMEOUT_MS = 8000;
const SMS_CODE_TTL_SECONDS = 300;
const SMS_RESEND_SECONDS = 60;
const PURPOSES = new Set([
  'login',
  'bind_phone',
  'wechat_entry',
  'reauth'
]);
const SESSION_PURPOSES = new Set([
  'bind_phone',
  'reauth'
]);

const RESULTS = Object.freeze({
  INVALID_PHONE: Object.freeze({
    ok: false,
    code: 'INVALID_PHONE',
    msg: '请输入正确的手机号'
  }),
  INVALID_ARGUMENT: Object.freeze({
    ok: false,
    code: 'INVALID_ARGUMENT',
    msg: '请求参数无效'
  }),
  UNAUTHORIZED: Object.freeze({
    ok: false,
    code: 'UNAUTHORIZED',
    msg: '无法识别微信身份'
  }),
  SMS_TOO_FREQUENT: Object.freeze({
    ok: false,
    code: 'SMS_TOO_FREQUENT',
    msg: '验证码发送过于频繁，请稍后重试'
  }),
  SMS_SEND_FAILED: Object.freeze({
    ok: false,
    code: 'SMS_SEND_FAILED',
    msg: '验证码发送失败，请稍后重试'
  })
});

function failure(code) {
  return { ...RESULTS[code] };
}

function sha256(value) {
  return crypto
    .createHash('sha256')
    .update(value)
    .digest('hex');
}

function hmac(key, value, encoding) {
  return crypto
    .createHmac('sha256', key)
    .update(value)
    .digest(encoding);
}

function providerConfig() {
  const config = {
    secretId:
      process.env.CUETRACE_SMS_SECRET_ID || '',
    secretKey:
      process.env.CUETRACE_SMS_SECRET_KEY || '',
    smsSdkAppId:
      process.env.CUETRACE_SMS_SDK_APP_ID || '',
    signName:
      process.env.CUETRACE_SMS_SIGN_NAME || '',
    templateId:
      process.env.CUETRACE_SMS_TEMPLATE_ID || '',
    region:
      process.env.CUETRACE_SMS_REGION || 'ap-guangzhou',
    templateParams:
      process.env.CUETRACE_SMS_TEMPLATE_PARAMS
        || 'code,expire'
  };
  const templateParams = String(config.templateParams)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (
    [
      config.secretId,
      config.secretKey,
      config.smsSdkAppId,
      config.signName,
      config.templateId
    ].some((value) => !value.trim())
    || templateParams.length === 0
  ) {
    return null;
  }
  config.templateParams = templateParams;
  return config;
}

function templateParamSet(code, templateParams) {
  return templateParams.map((item) => (
      item === 'expire'
        ? String(SMS_CODE_TTL_SECONDS / 60)
        : code
  ));
}

function signRequest(payload, config, timestamp) {
  const date = new Date(timestamp * 1000)
    .toISOString()
    .slice(0, 10);
  const contentType =
    'application/json; charset=utf-8';
  const canonicalHeaders =
    'content-type:'
    + contentType
    + '\nhost:'
    + SMS_HOST
    + '\n';
  const signedHeaders = 'content-type;host';
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256(payload)
  ].join('\n');
  const credentialScope =
    date
    + '/'
    + SMS_SERVICE
    + '/tc3_request';
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(timestamp),
    credentialScope,
    sha256(canonicalRequest)
  ].join('\n');
  const secretDate = hmac(
    'TC3' + config.secretKey,
    date
  );
  const secretService = hmac(
    secretDate,
    SMS_SERVICE
  );
  const secretSigning = hmac(
    secretService,
    'tc3_request'
  );
  const signature = hmac(
    secretSigning,
    stringToSign,
    'hex'
  );
  return 'TC3-HMAC-SHA256 Credential='
    + config.secretId
    + '/'
    + credentialScope
    + ', SignedHeaders='
    + signedHeaders
    + ', Signature='
    + signature;
}

function sendTencentSms(phone, code, config) {
  const payload = JSON.stringify({
    PhoneNumberSet: [phone],
    SmsSdkAppId: config.smsSdkAppId,
    SignName: config.signName,
    TemplateId: config.templateId,
    TemplateParamSet: templateParamSet(
      code,
      config.templateParams
    )
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const headers = {
    Authorization: signRequest(
      payload,
      config,
      timestamp
    ),
    'Content-Type':
      'application/json; charset=utf-8',
    Host: SMS_HOST,
    'X-TC-Action': 'SendSms',
    'X-TC-Timestamp': String(timestamp),
    'X-TC-Version': SMS_VERSION,
    'X-TC-Region': config.region
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    let deadlineTimer;

    function cleanup() {
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      }
    }

    function finish(callback, value) {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    }

    function fail(error) {
      finish(
        reject,
        error instanceof Error
          ? error
          : new Error('provider request failed')
      );
    }

    function abortRequest(message) {
      const error = new Error(message);
      fail(error);
      if (request && typeof request.destroy === 'function') {
        try {
          request.destroy(error);
        } catch (_) {
          // The promise has already failed closed.
        }
      }
    }

    deadlineTimer = setTimeout(() => {
      abortRequest('provider request deadline exceeded');
    }, SMS_TIMEOUT_MS);

    try {
      request = https.request({
        method: 'POST',
        hostname: SMS_HOST,
        path: '/',
        headers
      }, (response) => {
        let raw = '';
        let responseEnded = false;
        response.on('data', (chunk) => {
          raw += chunk;
        });
        response.on('aborted', () => {
          fail(new Error('provider response aborted'));
        });
        response.on('error', fail);
        response.on('close', () => {
          if (!responseEnded) {
            fail(new Error('provider response closed'));
          }
        });
        response.on('end', () => {
          responseEnded = true;
          let parsed;
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch (_) {
            fail(new Error('provider response invalid'));
            return;
          }
          const providerResponse =
            parsed
            && parsed.Response;
          const status =
            providerResponse
            && Array.isArray(
              providerResponse.SendStatusSet
            )
            && providerResponse.SendStatusSet[0];
          if (
            response.statusCode >= 200
            && response.statusCode < 300
            && status
            && status.Code === 'Ok'
          ) {
            finish(resolve, true);
            return;
          }
          fail(new Error('provider rejected request'));
        });
      });
      request.on('error', fail);
      request.setTimeout(SMS_TIMEOUT_MS, () => {
        abortRequest('provider request timeout');
      });
      request.write(payload);
      request.end();
    } catch (error) {
      fail(error);
    }
  });
}

function validClientInstanceId(value) {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= 256
  );
}

function normalizeInput(event) {
  let phone;
  try {
    phone = normalizePhone(event.phone);
  } catch (_) {
    return { result: failure('INVALID_PHONE') };
  }
  if (
    !PURPOSES.has(event.purpose)
    || !validClientInstanceId(
      event.clientInstanceId
    )
  ) {
    return { result: failure('INVALID_ARGUMENT') };
  }
  return {
    phone,
    purpose: event.purpose,
    clientInstanceId: event.clientInstanceId
  };
}

async function finalizeFailure(claim, keyring) {
  try {
    await db.runTransaction((transaction) => (
      finalizeSmsSend({
        transaction,
        claim,
        providerResult: { status: 'failed' },
        now: new Date(Date.now()),
        keyring
      })
    ));
  } catch (_) {
    return false;
  }
  return true;
}

exports.main = async (event = {}) => {
  const input = normalizeInput(event);
  if (input.result) return input.result;

  let keyring;
  let trustedWechat;
  try {
    keyring = loadKeyring(process.env);
    trustedWechat = wechatIdentity(
      cloud.getWXContext()
    );
  } catch (error) {
    if (
      error
      && error.code === 'INVALID_WECHAT_IDENTITY'
    ) {
      return failure('UNAUTHORIZED');
    }
    return failure('SMS_SEND_FAILED');
  }

  let authenticated = null;
  if (SESSION_PURPOSES.has(input.purpose)) {
    authenticated = await requireSession({
      db,
      event: { sessionToken: event.sessionToken },
      now: new Date(Date.now()),
      keyring
    });
    if (
      authenticated
      && authenticated.ok === false
    ) {
      return authenticated;
    }
    if (
      !authenticated
      || !authenticated.account
      || !authenticated.session
      || authenticated.accountId
        !== authenticated.account._id
      || authenticated.session.accountId
        !== authenticated.accountId
    ) {
      return failure('SMS_SEND_FAILED');
    }
  }

  if (input.purpose === 'reauth') {
    let phoneBindingCandidates;
    try {
      phoneBindingCandidates = candidateHmacIds(
        keyring,
        'phone-binding',
        input.phone,
        'phone'
      );
    } catch (_) {
      return failure('SMS_SEND_FAILED');
    }
    if (
      !authenticated.account.phoneBindingId
      || !phoneBindingCandidates.some(
        (candidate) => (
          candidate.id
          === authenticated.account.phoneBindingId
        )
      )
    ) {
      return failure('INVALID_PHONE');
    }
  }

  const config = providerConfig();
  if (!config) return failure('SMS_SEND_FAILED');

  const scope = {
    purpose: input.purpose,
    clientInstanceId: input.clientInstanceId,
    wechatBindingInput: trustedWechat.bindingInput,
    accountId: authenticated
      ? authenticated.accountId
      : '',
    sessionId:
      input.purpose === 'reauth'
        ? authenticated.session._id
        : ''
  };

  let claim;
  try {
    claim = await db.runTransaction(
      (transaction) => claimSmsChallenge({
        transaction,
        phone: input.phone,
        purpose: input.purpose,
        scope,
        wxIdentity: trustedWechat,
        now: new Date(Date.now()),
        keyring
      })
    );
  } catch (error) {
    if (
      error
      && error.code === 'SMS_TOO_FREQUENT'
    ) {
      return failure('SMS_TOO_FREQUENT');
    }
    return failure('SMS_SEND_FAILED');
  }

  let code;
  try {
    code = crypto
      .randomInt(0, 1000000)
      .toString()
      .padStart(6, '0');
  } catch (_) {
    await finalizeFailure(claim, keyring);
    return failure('SMS_SEND_FAILED');
  }

  try {
    await sendTencentSms(
      input.phone,
      code,
      config
    );
  } catch (_) {
    await finalizeFailure(claim, keyring);
    return failure('SMS_SEND_FAILED');
  }

  let finalized;
  try {
    finalized = await db.runTransaction(
      (transaction) => finalizeSmsSend({
        transaction,
        claim,
        providerResult: {
          status: 'sent',
          code
        },
        now: new Date(Date.now()),
        keyring
      })
    );
  } catch (_) {
    return failure('SMS_SEND_FAILED');
  }
  if (!finalized || finalized.ok !== true) {
    return failure('SMS_SEND_FAILED');
  }

  return {
    ok: true,
    challengeId: claim.challengeId,
    expiresIn: SMS_CODE_TTL_SECONDS,
    resendAfter: SMS_RESEND_SECONDS
  };
};

const { guardClientRequest } = require('./lib/auth/protocol-guard');
const protocolGuardedMain = exports.main;

exports.main = async (event = {}, ...args) => {
  const gate = await guardClientRequest({
    db,
    event,
    supportedSchemaVersions: [2]
  });
  if (!gate.ok) return gate;
  let businessEvent = event;
  if (
    Object.prototype.hasOwnProperty.call(
      event,
      'authProtocol'
    )
  ) {
    businessEvent = { ...event };
    delete businessEvent.authProtocol;
  }
  return protocolGuardedMain(
    businessEvent,
    ...args
  );
};
