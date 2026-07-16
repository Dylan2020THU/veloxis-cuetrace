const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const crypto = require('crypto');
const https = require('https');
const db = cloud.database();

const DELETE_CONTRACT_URL = 'https://api.mch.weixin.qq.com/papay/deletecontract';
const DELETE_CONTRACT_PATH = '/papay/deletecontract';
const REQUEST_TIMEOUT_MS = 8000;

function isBlockingSubscriptionStatus(status) {
  return status === 'active' || status === 'pending_contract' || status === 'cancel_required';
}

function bindingId(openid) {
  return crypto.createHash('sha256').update(`wechat:${openid}`).digest('hex');
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

function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function toXml(params) {
  return '<xml>' + Object.keys(params).map((k) => '<' + k + '>' + escapeXml(params[k]) + '</' + k + '>').join('') + '</xml>';
}

function parseXml(xml) {
  const out = {};
  String(xml || '').replace(/<([^!?][^>\s\/]*)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/\1>/g, (m, key, cdata, text) => {
    out[key] = cdata !== undefined ? cdata : text;
    return m;
  });
  return out;
}

function postXml(url, xml) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      path: u.pathname,
      headers: {
        'Content-Type': 'text/xml',
        'Content-Length': Buffer.byteLength(xml)
      }
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve(parseXml(buf)));
    });
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('WECHAT_PAY_TIMEOUT'));
    });
    req.write(xml);
    req.end();
  });
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const key = process.env.PAP_SIGN_KEY || '';
  const requestedContractId = String(event.contractId || event.contract_id || '');
  const userId = bindingId(OPENID);
  const user = await getOptional(db.collection('users').doc(userId));
  if (!user || user._id !== userId || user._openid !== OPENID) {
    return { ok: false, code: 'SUBSCRIPTION_GUARD_MISMATCH', msg: '连续订阅状态不一致' };
  }
  let subscription;
  if (requestedContractId) {
    let found = await db.collection('subscriptions')
      .where({ contractId: requestedContractId })
      .limit(1)
      .get();
    if (!found.data.length) {
      found = await db.collection('subscriptions')
        .where({ contract_id: requestedContractId })
        .limit(1)
        .get();
    }
    subscription = found.data[0];
  } else if (user.conflictingSubscriptionId) {
    subscription = await getOptional(
      db.collection('subscriptions').doc(user.conflictingSubscriptionId)
    );
  } else {
    const found = await db.collection('subscriptions')
      .where({
        _openid: OPENID,
        status: db.command.in(['active', 'pending_contract'])
      })
      .orderBy('updatedAt', 'desc')
      .limit(1)
      .get();
    subscription = found.data[0];
  }
  if (
    !subscription ||
    !subscription._id ||
    subscription._openid !== OPENID ||
    subscription.userId !== userId
  ) {
    return { ok: false, code: 'SUBSCRIPTION_NOT_OWNED', msg: '连续订阅不存在或不属于当前账号' };
  }
  if (
    !(
      user.subscriptionId === subscription._id && (
        isBlockingSubscriptionStatus(user.subscriptionStatus) ||
        user.conflictingSubscriptionId && user.conflictingSubscriptionId !== subscription._id
      ) ||
      user.conflictingSubscriptionId === subscription._id
    )
  ) {
    return { ok: false, code: 'SUBSCRIPTION_GUARD_MISMATCH', msg: '连续订阅状态不一致' };
  }

  const params = {
    appid: process.env.PAP_APPID || '',
    mch_id: process.env.PAP_MCH_ID || '',
    contract_termination_remark: '用户取消连续订阅',
    version: '1.0'
  };
  const contractId = subscription.contractId || subscription.contract_id || '';
  if (contractId) {
    params.contract_id = contractId;
  } else if (subscription.planId && subscription.contractCode) {
    params.plan_id = subscription.planId;
    params.contract_code = subscription.contractCode;
  } else {
    return { ok: false, code: 'SUBSCRIPTION_GUARD_MISMATCH', msg: '连续订阅缺少可解约的协议标识' };
  }
  const missing = ['appid', 'mch_id'].filter((name) => !params[name])
    .concat(key ? [] : ['PAP_SIGN_KEY']);
  if (missing.length) return { ok: false, code: 'PAP_CONFIG_MISSING', msg: '连续订阅解约参数未配置', missing, path: DELETE_CONTRACT_PATH };

  params.sign = signParams(params, key);
  const result = await postXml(DELETE_CONTRACT_URL, toXml(params));
  const responseSignatureValid = !!result.sign && signParams(result, key) === result.sign;
  const responseIdentityMatches = params.contract_id
    ? result.contract_id === params.contract_id
    : result.plan_id === params.plan_id && result.contract_code === params.contract_code;
  const ok = result.return_code === 'SUCCESS' &&
    result.result_code === 'SUCCESS' &&
    result.mch_id === params.mch_id &&
    result.appid === params.appid &&
    responseSignatureValid &&
    responseIdentityMatches;
  if (!ok) {
    await db.collection('subscriptions').doc(subscription._id).update({
      data: {
        cancelResult: result,
        cancelFailedAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    return { ok: false, result };
  }

  await db.runTransaction(async (transaction) => {
    const subscriptionRef = transaction.collection('subscriptions').doc(subscription._id);
    const userRef = transaction.collection('users').doc(userId);
    const currentSubscription = await getOptional(subscriptionRef);
    const currentUser = await getOptional(userRef);
    if (
      !currentSubscription ||
      currentSubscription._id !== subscription._id ||
      currentSubscription._openid !== OPENID ||
      currentSubscription.userId !== userId ||
      (params.contract_id
        ? (currentSubscription.contractId || currentSubscription.contract_id || '') !== params.contract_id
        : currentSubscription.planId !== params.plan_id || currentSubscription.contractCode !== params.contract_code) ||
      !currentUser ||
      currentUser._id !== userId ||
      currentUser._openid !== OPENID ||
      !(
        currentUser.subscriptionId === subscription._id ||
        currentUser.conflictingSubscriptionId === subscription._id
      )
    ) {
      throw new Error('SUBSCRIPTION_GUARD_MISMATCH');
    }
    await subscriptionRef.update({
      data: {
        status: 'canceled',
        contractId: result.contract_id || currentSubscription.contractId || '',
        contract_id: result.contract_id || currentSubscription.contract_id || '',
        cancelResult: result,
        canceledAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    if (currentUser.subscriptionId === subscription._id) {
      const hasOtherConflict = currentUser.conflictingSubscriptionId &&
        currentUser.conflictingSubscriptionId !== subscription._id;
      await userRef.update({
        data: {
          subscriptionStatus: hasOtherConflict ? 'cancel_required' : 'canceled',
          subscriptionId: subscription._id,
          updatedAt: db.serverDate()
        }
      });
    } else {
      const nextSubscription = await getOptional(
        transaction.collection('subscriptions').doc(currentUser.subscriptionId)
      );
      if (!nextSubscription || nextSubscription._openid !== OPENID) {
        throw new Error('SUBSCRIPTION_GUARD_MISMATCH');
      }
      await userRef.update({
        data: {
          subscriptionStatus: nextSubscription.status,
          conflictingSubscriptionId: '',
          updatedAt: db.serverDate()
        }
      });
    }
  });
  return { ok, result };
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
