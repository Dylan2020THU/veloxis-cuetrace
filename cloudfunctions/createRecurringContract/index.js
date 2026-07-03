const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const crypto = require('crypto');
const db = cloud.database();
const fulfill = require('./lib/fulfill');

const SIGN_MINI_APPID = 'wxbd687630cd02ce1d';
const SIGN_TARGET = '/papay/entrustweb';
const PERIOD_PLAN_ENV = {
  month: 'PAP_PLAN_ID_MONTH',
  quarter: 'PAP_PLAN_ID_QUARTER',
  year: 'PAP_PLAN_ID_YEAR'
};
const PERIOD_LABEL = { month: '包月', quarter: '包季', year: '包年' };

function signParams(params, key) {
  const text = Object.keys(params)
    .filter((k) => k !== 'sign' && params[k] !== undefined && params[k] !== '')
    .sort()
    .map((k) => k + '=' + params[k])
    .join('&') + '&key=' + key;
  return crypto.createHash('md5').update(text, 'utf8').digest('hex').toUpperCase();
}

function envConfig(period) {
  const planId = process.env[PERIOD_PLAN_ENV[period]];
  const config = {
    appid: process.env.PAP_APPID || '',
    mch_id: process.env.PAP_MCH_ID || '',
    key: process.env.PAP_SIGN_KEY || '',
    notify_url: process.env.PAP_CONTRACT_NOTIFY_URL || '',
    plan_id: planId || ''
  };
  const missing = Object.keys(config).filter((k) => !config[k]);
  return { config, missing };
}

function genContractCode(openid) {
  const tail = String(openid || '').slice(-8).replace(/[^0-9A-Za-z]/g, '0');
  return ('CTRC' + Date.now() + tail).slice(0, 32);
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const planKey = String(event.planKey || '');
  const role = fulfill.normRole(event.role);
  const period = fulfill.normPeriod(event.period);
  const paymentMode = 'recurring';

  const { config, missing } = envConfig(period);
  if (missing.length) {
    return {
      ok: false,
      code: 'PAP_CONFIG_MISSING',
      msg: '连续订阅尚未配置微信支付委托代扣参数',
      missing
    };
  }

  const users = db.collection('users');
  const found = await users.where({ _openid: OPENID }).limit(1).get();
  if (!found.data.length) return { ok: false, code: 'USER_NOT_FOUND', msg: '请先登录' };
  const user = found.data[0];
  const perRole = (user.per_role && typeof user.per_role === 'object') ? user.per_role : {};
  const current = (perRole[role] && typeof perRole[role] === 'object') ? perRole[role] : {};
  const priced = fulfill.computeAmountYuan({ planKey, role, period, current, paymentMode });
  if (!priced.ok) return { ok: false, code: priced.code, msg: '套餐校验失败' };

  const contractCode = genContractCode(OPENID);
  const requestSerial = Date.now();
  const timestamp = Math.floor(Date.now() / 1000);
  const extraData = {
    appid: config.appid,
    mch_id: config.mch_id,
    plan_id: config.plan_id,
    contract_code: contractCode,
    request_serial: requestSerial,
    contract_display_account: '强化杆迹' + (PERIOD_LABEL[period] || '包年') + '连续订阅',
    notify_url: encodeURIComponent(config.notify_url),
    timestamp,
    outerid: OPENID,
    path: 'pages/index/index'
  };
  extraData.sign = signParams(extraData, config.key);

  await db.collection('subscriptions').add({
    data: {
      _openid: OPENID,
      userId: user._id,
      role,
      planKey,
      period,
      paymentMode,
      amount: priced.amount,
      contractCode,
      contractId: '',
      status: 'pending_contract',
      signTarget: SIGN_TARGET,
      createdAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  });

  return {
    ok: true,
    appId: SIGN_MINI_APPID,
    path: 'pages/index/index',
    extraData
  };
};
