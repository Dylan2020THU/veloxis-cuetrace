const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const crypto = require('crypto');
const db = cloud.database();
const fulfill = require('./lib/fulfill');

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

  const outTradeNo = data.out_trade_no || data.outTradeNo || '';
  if (!outTradeNo) return ack();

  const found = await db.collection('orders').where({ outTradeNo }).limit(1).get();
  if (!found.data.length) return ack();
  const order = found.data[0];
  if (order.paid === true || order.status === 'paid') return ack();

  const success = data.return_code === 'SUCCESS' && data.result_code === 'SUCCESS';
  if (!success) {
    await db.collection('orders').doc(order._id).update({
      data: { status: 'failed', recurringResult: data, updatedAt: db.serverDate() }
    });
    if (order.subscriptionId) {
      await db.collection('subscriptions').doc(order.subscriptionId).update({
        data: { status: 'past_due', lastFailure: data, updatedAt: db.serverDate() }
      });
    }
    return ack();
  }

  const userRes = await db.collection('users').where({ _openid: order._openid }).limit(1).get();
  if (!userRes.data.length) return ack();
  const user = userRes.data[0];
  const perRole = (user.per_role && typeof user.per_role === 'object') ? user.per_role : {};
  const current = (perRole[order.role] && typeof perRole[order.role] === 'object') ? perRole[order.role] : {};
  const now = Date.now();
  const planExpiresAt = fulfill.computeExpiry({ current, planKey: order.planKey, period: order.period, now });
  const subscription = Object.assign({}, current.subscription || {}, {
    status: 'active',
    subscriptionId: order.subscriptionId || '',
    lastDebitAt: now,
    nextRenewAt: planExpiresAt,
    contractId: data.contract_id || ''
  });

  await fulfill.applyEntitlement({
    db,
    userId: user._id,
    perRole,
    role: order.role,
    planKey: order.planKey,
    period: order.period,
    paymentMode: 'recurring',
    planExpiresAt,
    now,
    subscription
  });

  await db.collection('orders').doc(order._id).update({
    data: {
      paid: true,
      status: 'paid',
      transactionId: data.transaction_id || '',
      recurringResult: data,
      paidAt: db.serverDate()
    }
  });
  if (order.subscriptionId) {
    await db.collection('subscriptions').doc(order.subscriptionId).update({
      data: {
        status: 'active',
        lastDebitAt: now,
        nextRenewAt: planExpiresAt,
        updatedAt: db.serverDate()
      }
    });
  }
  return ack();
};
