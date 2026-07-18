'use strict';

const crypto = require('crypto');

const SNAPSHOT_KEYS = Object.freeze([
  'spAppid',
  'spMchid',
  'subAppid',
  'subMchid',
  'openidMode',
  'profileSchemaVersion',
  'policyVersion'
]);

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isAppId(value) {
  return typeof value === 'string' && /^wx[0-9A-Za-z]{16}$/.test(value);
}

function isMerchantId(value) {
  return typeof value === 'string' && /^[0-9]{8,32}$/.test(value);
}

function isSafeText(value, maximumBytes) {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= maximumBytes
    && !/[\x00-\x1f\x7f]/.test(value);
}

function paymentProfileError() {
  return new TypeError('payment profile is not ready');
}

function canonicalCheckoutToken(value) {
  if (typeof value !== 'string' || !/^[0-9A-Za-z_-]{22}$/.test(value)) {
    return null;
  }
  let decoded;
  try {
    decoded = Buffer.from(value, 'base64url');
  } catch (_error) {
    return null;
  }
  return decoded.length === 16 && decoded.toString('base64url') === value
    ? value
    : null;
}

function hashCheckoutToken(value) {
  const token = canonicalCheckoutToken(value);
  return token === null
    ? null
    : crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function snapshotReadyPaymentProfile(profile, order, config) {
  if (
    !isPlainObject(profile)
    || !isPlainObject(order)
    || !isPlainObject(config)
    || typeof order.shopId !== 'string'
    || profile._id !== order.shopId
    || profile.shopId !== order.shopId
    || profile.schemaVersion !== 1
    || profile.status !== 'ready'
    || profile.onboardingStatus !== 'approved'
    || profile.contractStatus !== 'signed'
    || profile.profitSharingAuthorizationStatus !== 'authorized'
    || profile.paymentEnabled !== true
    || profile.profitSharingEnabled !== true
    || profile.tradeBillModeVerified !== true
    || profile.policyVersion !== 'table_commission_v1'
    || order.policyVersion !== profile.policyVersion
    || !isMerchantId(profile.subMchid)
    || !isAppId(config.spAppId)
    || !isMerchantId(config.spMchid)
  ) {
    throw paymentProfileError();
  }

  let subAppid = null;
  if (profile.openidMode === 'sp_openid') {
    if (![undefined, null, ''].includes(profile.subAppid)) {
      throw paymentProfileError();
    }
  } else if (profile.openidMode === 'sub_openid') {
    if (!isAppId(profile.subAppid)) throw paymentProfileError();
    subAppid = profile.subAppid;
  } else {
    throw paymentProfileError();
  }

  return Object.freeze({
    spAppid: config.spAppId,
    spMchid: config.spMchid,
    subAppid,
    subMchid: profile.subMchid,
    openidMode: profile.openidMode,
    profileSchemaVersion: profile.schemaVersion,
    policyVersion: profile.policyVersion
  });
}

function isPaymentProfileSnapshot(value) {
  if (
    !isPlainObject(value)
    || Object.keys(value).length !== SNAPSHOT_KEYS.length
    || !SNAPSHOT_KEYS.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    || !isAppId(value.spAppid)
    || !isMerchantId(value.spMchid)
    || !isMerchantId(value.subMchid)
    || value.profileSchemaVersion !== 1
    || value.policyVersion !== 'table_commission_v1'
  ) {
    return false;
  }
  if (value.openidMode === 'sp_openid') return value.subAppid === null;
  return value.openidMode === 'sub_openid' && isAppId(value.subAppid);
}

function assertSnapshotMatchesConfig(snapshot, config) {
  if (
    !isPaymentProfileSnapshot(snapshot)
    || !isPlainObject(config)
    || snapshot.spAppid !== config.spAppId
    || snapshot.spMchid !== config.spMchid
  ) {
    throw new TypeError('payment profile snapshot is invalid');
  }
}

function buildPartnerJsapiBody({
  order,
  paymentProfileSnapshot,
  payerOpenid,
  config
}) {
  assertSnapshotMatchesConfig(paymentProfileSnapshot, config);
  if (
    !isPlainObject(order)
    || order.policyVersion !== paymentProfileSnapshot.policyVersion
    || !Number.isSafeInteger(order.quotedTableFeeFen)
    || order.quotedTableFeeFen <= 0
    || typeof order.outTradeNo !== 'string'
    || !/^[0-9A-Za-z_|*\-]{6,32}$/.test(order.outTradeNo)
    || !isSafeText(payerOpenid, 128)
    || typeof config.tableNotifyUrl !== 'string'
    || !/^https:\/\/[^\s]+$/.test(config.tableNotifyUrl)
  ) {
    throw new TypeError('partner JSAPI payment input is invalid');
  }

  const body = {
    sp_appid: paymentProfileSnapshot.spAppid,
    sp_mchid: paymentProfileSnapshot.spMchid
  };
  if (paymentProfileSnapshot.subAppid !== null) {
    body.sub_appid = paymentProfileSnapshot.subAppid;
  }
  body.sub_mchid = paymentProfileSnapshot.subMchid;
  body.description = 'CueTrace球桌费';
  body.out_trade_no = order.outTradeNo;
  body.notify_url = config.tableNotifyUrl;
  body.amount = { total: order.quotedTableFeeFen, currency: 'CNY' };
  body.payer = paymentProfileSnapshot.openidMode === 'sp_openid'
    ? { sp_openid: payerOpenid }
    : { sub_openid: payerOpenid };
  body.settle_info = { profit_sharing: true };
  return body;
}

function signClientPayment({
  paymentProfileSnapshot,
  prepayId,
  timeStamp,
  nonceStr,
  merchantPrivateKey,
  signMiniProgramPayment
}) {
  if (
    !isPaymentProfileSnapshot(paymentProfileSnapshot)
    || !isSafeText(prepayId, 64)
    || typeof timeStamp !== 'string'
    || !/^(?:0|[1-9][0-9]{0,10})$/.test(timeStamp)
    || !isSafeText(nonceStr, 32)
    || !merchantPrivateKey
    || typeof signMiniProgramPayment !== 'function'
  ) {
    throw new TypeError('mini-program payment signing input is invalid');
  }
  const appId = paymentProfileSnapshot.openidMode === 'sp_openid'
    ? paymentProfileSnapshot.spAppid
    : paymentProfileSnapshot.subAppid;
  const signed = signMiniProgramPayment({
    appId,
    timeStamp,
    nonceStr,
    prepayId,
    privateKey: merchantPrivateKey
  });
  if (
    !isPlainObject(signed)
    || signed.timeStamp !== timeStamp
    || signed.nonceStr !== nonceStr
    || signed.package !== `prepay_id=${prepayId}`
    || signed.signType !== 'RSA'
    || !isSafeText(signed.paySign, 512)
  ) {
    throw new TypeError('mini-program payment signature is invalid');
  }
  return {
    timeStamp: signed.timeStamp,
    nonceStr: signed.nonceStr,
    package: signed.package,
    signType: signed.signType,
    paySign: signed.paySign
  };
}

module.exports = {
  SNAPSHOT_KEYS,
  buildPartnerJsapiBody,
  canonicalCheckoutToken,
  hashCheckoutToken,
  isPaymentProfileSnapshot,
  signClientPayment,
  snapshotReadyPaymentProfile
};
