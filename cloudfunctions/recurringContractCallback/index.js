const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const crypto = require('crypto');
const db = cloud.database();

function parseXml(xml) {
  const out = {};
  String(xml || '').replace(/<([^!?][^>\s\/]*)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/\1>/g, (m, key, cdata, text) => {
    out[key] = cdata !== undefined ? cdata : text;
    return m;
  });
  return out;
}

function signParams(params, key) {
  const text = Object.keys(params)
    .filter((k) => k !== 'sign' && params[k] !== undefined && params[k] !== '')
    .sort()
    .map((k) => k + '=' + params[k])
    .join('&') + '&key=' + key;
  return crypto.createHash('md5').update(text, 'utf8').digest('hex').toUpperCase();
}

function ack() {
  return '<xml><return_code><![CDATA[SUCCESS]]></return_code><return_msg><![CDATA[OK]]></return_msg></xml>';
}

function bodyOf(event) {
  return event.xml || event.body || event.rawBody || event;
}

exports.main = async (event = {}) => {
  const body = typeof bodyOf(event) === 'string' ? bodyOf(event) : JSON.stringify(bodyOf(event));
  const data = parseXml(body);
  const key = process.env.PAP_SIGN_KEY || '';
  if (key && data.sign && signParams(data, key) !== data.sign) return ack();

  const contractCode = data.contract_code || data.contractCode || '';
  const contract_id = data.contract_id || data.contractId || '';
  if (!contractCode) return ack();

  const status = data.result_code === 'SUCCESS' || data.return_code === 'SUCCESS'
    ? (contract_id ? 'active' : 'contract_changed')
    : 'contract_failed';

  const update = {
    status,
    contractId: contract_id,
    contract_id,
    raw: data,
    updatedAt: db.serverDate()
  };
  if (status === 'active') update.activatedAt = db.serverDate();

  try {
    await db.collection('subscriptions').where({ contractCode }).update({ data: update });
  } catch (err) {
    console.error('[recurringContractCallback] update failed', err);
  }
  return ack();
};
