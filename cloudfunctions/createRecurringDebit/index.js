const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const crypto = require('crypto');
const https = require('https');
const db = cloud.database();
const fulfill = require('./lib/fulfill');

const DEBIT_URL = 'https://api.mch.weixin.qq.com/pay/pappayapply';
const DEBIT_PATH = '/pay/pappayapply';

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
    req.write(xml);
    req.end();
  });
}

function outTradeNo(openid) {
  const tail = String(openid || '').slice(-6).replace(/[^0-9A-Za-z]/g, '0');
  return ('CTR' + Date.now() + tail + Math.random().toString(36).slice(2, 6)).slice(0, 32);
}

async function pickSubscription(event) {
  if (event.subscriptionId) {
    const byId = await db.collection('subscriptions').doc(String(event.subscriptionId)).get();
    return byId.data || null;
  }
  const _ = db.command;
  const res = await db.collection('subscriptions')
    .where({ status: 'active', nextRenewAt: _.lte(Date.now()) })
    .orderBy('nextRenewAt', 'asc')
    .limit(1)
    .get();
  return res.data[0] || null;
}

exports.main = async (event = {}) => {
  const sub = await pickSubscription(event);
  if (!sub) return { ok: false, code: 'NO_DUE_SUBSCRIPTION', msg: '暂无到期连续订阅' };

  const key = process.env.PAP_SIGN_KEY || '';
  const priced = fulfill.computeAmountYuan({
    planKey: sub.planKey,
    role: sub.role,
    period: sub.period,
    current: {},
    paymentMode: 'recurring'
  });
  if (!priced.ok) return { ok: false, code: priced.code, msg: '套餐校验失败' };

  const tradeNo = outTradeNo(sub._openid);
  const params = {
    appid: process.env.PAP_APPID || '',
    mch_id: process.env.PAP_MCH_ID || '',
    nonce_str: Math.random().toString(36).slice(2, 18),
    body: '强化杆迹连续订阅',
    out_trade_no: tradeNo,
    total_fee: fulfill.yuanToFen(priced.amount),
    spbill_create_ip: '127.0.0.1',
    notify_url: process.env.PAP_DEBIT_NOTIFY_URL || '',
    trade_type: 'PAP',
    contract_id: sub.contractId || sub.contract_id || ''
  };
  const missing = Object.keys(params).filter((k) => !params[k]).concat(key ? [] : ['PAP_SIGN_KEY']);
  if (missing.length) return { ok: false, code: 'PAP_CONFIG_MISSING', msg: '连续订阅扣款参数未配置', missing, path: DEBIT_PATH };

  params.sign = signParams(params, key);
  await db.collection('orders').add({
    data: {
      outTradeNo: tradeNo,
      _openid: sub._openid,
      subscriptionId: sub._id,
      planKey: sub.planKey,
      role: sub.role,
      period: sub.period,
      paymentMode: 'recurring',
      amount: priced.amount,
      totalFee: params.total_fee,
      paid: false,
      status: 'pending',
      source: 'recurring',
      createdAt: db.serverDate()
    }
  });

  const result = await postXml(DEBIT_URL, toXml(params));
  await db.collection('orders').where({ outTradeNo: tradeNo }).update({
    data: { debitAccepted: result, updatedAt: db.serverDate() }
  });
  return { ok: result.return_code === 'SUCCESS', outTradeNo: tradeNo, result };
};
