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

function bindingId(openid) {
  return crypto.createHash('sha256').update(`wechat:${openid}`).digest('hex');
}

function fail(code, msg) {
  return { ok: false, code, msg };
}

function isBlockingSubscriptionStatus(status) {
  return status === 'active' || status === 'pending_contract' || status === 'cancel_required';
}

async function getOptional(ref) {
  const result = await ref.get();
  return result && result.data ? result.data : null;
}

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

function genContractCode() {
  return `CTRC${Date.now().toString(36)}${crypto.randomBytes(10).toString('hex')}`.slice(0, 32);
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

  const contractCode = genContractCode();
  const requestSerial = Date.now();
  const timestamp = Math.floor(Date.now() / 1000);
  const signingParams = {
    appid: config.appid,
    mch_id: config.mch_id,
    plan_id: config.plan_id,
    contract_code: contractCode,
    request_serial: requestSerial,
    contract_display_account: '强化杆迹' + (PERIOD_LABEL[period] || '包年') + '连续订阅',
    notify_url: config.notify_url,
    timestamp,
    outerid: OPENID
  };
  const extraData = Object.assign({}, signingParams, {
    notify_url: encodeURIComponent(config.notify_url)
  });
  extraData.sign = signParams(signingParams, config.key);

  return db.runTransaction(async (transaction) => {
    const userId = bindingId(OPENID);
    const binding = await getOptional(transaction.collection('wechat_bindings').doc(userId));
    if (
      !binding ||
      binding._id !== userId ||
      binding._openid !== OPENID ||
      !binding.accountId ||
      !binding.account
    ) {
      return fail('ACCOUNT_NOT_BOUND', '账号绑定信息不完整');
    }
    const account = await getOptional(transaction.collection('accounts').doc(binding.accountId));
    const userRef = transaction.collection('users').doc(userId);
    const user = await getOptional(userRef);
    if (
      !account ||
      account._id !== binding.accountId ||
      account._openid !== OPENID ||
      account.account !== binding.account ||
      account.status !== 'active' ||
      !user ||
      user._id !== userId ||
      user._openid !== OPENID
    ) {
      return fail('ACCOUNT_NOT_BOUND', '账号绑定信息不完整');
    }
    const roles = Array.isArray(user.roles) ? user.roles : [];
    if (roles.indexOf(role) === -1) {
      return fail('ROLE_NOT_ALLOWED', '该账号未开通此身份');
    }
    if (user.deletionStatus === 'pending' || user.deletionStatus === 'purging') {
      return fail('ACCOUNT_DELETION_PENDING', '账号正在注销，无法开通连续订阅');
    }
    if (isBlockingSubscriptionStatus(user.subscriptionStatus)) {
      return fail('ACTIVE_SUBSCRIPTION', '已有连续订阅或签约正在处理中');
    }

    const perRole = (user.per_role && typeof user.per_role === 'object') ? user.per_role : {};
    const current = (perRole[role] && typeof perRole[role] === 'object') ? perRole[role] : {};
    const priced = fulfill.computeAmountYuan({ planKey, role, period, current, paymentMode });
    if (!priced.ok) return fail(priced.code, '套餐校验失败');

    const added = await transaction.collection('subscriptions').add({
      data: {
        _openid: OPENID,
        userId,
        role,
        planKey,
        planId: config.plan_id,
        period,
        paymentMode,
        amount: priced.amount,
        contractCode,
        contractId: '',
        requestSerial,
        status: 'pending_contract',
        signTarget: SIGN_TARGET,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    await userRef.update({
      data: {
        subscriptionStatus: 'pending_contract',
        subscriptionId: added._id,
        updatedAt: db.serverDate()
      }
    });

    return {
      ok: true,
      appId: SIGN_MINI_APPID,
      path: 'pages/index/index',
      extraData,
      subscriptionId: added._id
    };
  });
};
