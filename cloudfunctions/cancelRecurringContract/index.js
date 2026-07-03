const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const crypto = require('crypto');
const https = require('https');
const db = cloud.database();

const DELETE_CONTRACT_URL = 'https://api.mch.weixin.qq.com/papay/deletecontract';
const DELETE_CONTRACT_PATH = '/papay/deletecontract';

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

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const key = process.env.PAP_SIGN_KEY || '';
  const params = {
    appid: process.env.PAP_APPID || '',
    mch_id: process.env.PAP_MCH_ID || '',
    contract_id: String(event.contractId || event.contract_id || ''),
    contract_termination_remark: '用户取消连续订阅',
    version: '1.0'
  };
  if (!params.contract_id) {
    const found = await db.collection('subscriptions')
      .where({ _openid: OPENID, status: 'active' })
      .orderBy('updatedAt', 'desc')
      .limit(1)
      .get();
    if (found.data.length) params.contract_id = found.data[0].contractId || found.data[0].contract_id || '';
  }
  const missing = Object.keys(params).filter((k) => !params[k]).concat(key ? [] : ['PAP_SIGN_KEY']);
  if (missing.length) return { ok: false, code: 'PAP_CONFIG_MISSING', msg: '连续订阅解约参数未配置', missing, path: DELETE_CONTRACT_PATH };

  params.sign = signParams(params, key);
  const result = await postXml(DELETE_CONTRACT_URL, toXml(params));
  const ok = result.return_code === 'SUCCESS' && result.result_code === 'SUCCESS';
  await db.collection('subscriptions').where({ contractId: params.contract_id }).update({
    data: {
      status: ok ? 'canceled' : 'cancel_failed',
      cancelResult: result,
      canceledAt: ok ? db.serverDate() : null,
      updatedAt: db.serverDate()
    }
  });
  return { ok, result };
};
