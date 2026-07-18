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

function failAck(message) {
  return `<xml><return_code><![CDATA[FAIL]]></return_code><return_msg><![CDATA[${message}]]></return_msg></xml>`;
}

function bodyOf(event) {
  return event.xml || event.body || event.rawBody || event;
}

async function getOptional(ref) {
  const result = await ref.get();
  return result && result.data ? result.data : null;
}

exports.main = async (event = {}) => {
  const body = typeof bodyOf(event) === 'string' ? bodyOf(event) : JSON.stringify(bodyOf(event));
  const data = parseXml(body);
  const key = process.env.PAP_SIGN_KEY || '';
  const merchantId = process.env.PAP_MCH_ID || '';
  if (!key || !merchantId || !data.sign || signParams(data, key) !== data.sign) {
    return failAck('SIGN_ERROR');
  }
  if (data.return_code !== 'SUCCESS' || data.result_code !== 'SUCCESS') {
    return failAck('RESULT_NOT_SUCCESS');
  }

  const contractCode = data.contract_code || data.contractCode || '';
  const contract_id = data.contract_id || data.contractId || '';
  const changeType = data.change_type || '';
  if (
    !contractCode ||
    !contract_id ||
    !data.openid ||
    !data.operate_time ||
    data.mch_id !== merchantId ||
    (changeType !== 'ADD' && changeType !== 'DELETE')
  ) {
    return failAck('INVALID_CALLBACK');
  }

  const status = changeType === 'ADD' ? 'active' : 'canceled';

  const update = {
    status,
    contractId: contract_id,
    contract_id,
    wechatOperateTime: data.operate_time,
    wechatChangeType: changeType,
    raw: data,
    updatedAt: db.serverDate()
  };
  if (status === 'active') update.activatedAt = db.serverDate();
  else update.canceledAt = db.serverDate();

  try {
    const found = await db.collection('subscriptions').where({ contractCode }).limit(1).get();
    if (!found.data.length || !found.data[0]._id || !found.data[0].userId) {
      return failAck('SUBSCRIPTION_NOT_FOUND');
    }
    const subscriptionId = found.data[0]._id;
    const userId = found.data[0].userId;
    await db.runTransaction(async (transaction) => {
      const subscriptionRef = transaction.collection('subscriptions').doc(subscriptionId);
      const userRef = transaction.collection('users').doc(userId);
      const subscription = await getOptional(subscriptionRef);
      const user = await getOptional(userRef);
      if (
        !subscription ||
        subscription._id !== subscriptionId ||
        subscription.contractCode !== contractCode ||
        subscription.userId !== userId ||
        subscription._openid !== data.openid ||
        (subscription.planId && subscription.planId !== data.plan_id)
      ) {
        throw new Error('SUBSCRIPTION_GUARD_MISMATCH');
      }
      const previousOperateTime = subscription.wechatOperateTime || '';
      const previousChangeType = subscription.wechatChangeType || '';
      if (
        previousOperateTime &&
        (
          data.operate_time < previousOperateTime ||
          data.operate_time === previousOperateTime &&
            previousChangeType === 'DELETE' &&
            changeType === 'ADD'
        )
      ) {
        return;
      }
      const currentContractId = subscription.contractId || subscription.contract_id || '';
      if (!user) {
        if (
          changeType === 'DELETE' &&
          subscription.status === 'canceled' &&
          currentContractId === contract_id
        ) {
          return;
        }
        throw new Error('SUBSCRIPTION_GUARD_MISMATCH');
      }
      if (user._id !== userId || user._openid !== subscription._openid) {
        throw new Error('SUBSCRIPTION_GUARD_MISMATCH');
      }
      if (user.subscriptionId !== subscriptionId) {
        await subscriptionRef.update({ data: update });
        if (changeType === 'ADD') {
          await userRef.update({
            data: {
              subscriptionStatus: 'cancel_required',
              conflictingSubscriptionId: subscriptionId,
              updatedAt: db.serverDate()
            }
          });
        } else if (user.conflictingSubscriptionId === subscriptionId) {
          const nextSubscription = await getOptional(
            transaction.collection('subscriptions').doc(user.subscriptionId)
          );
          if (!nextSubscription || nextSubscription._openid !== subscription._openid) {
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
        return;
      }
      const hasOtherConflict = user.conflictingSubscriptionId &&
        user.conflictingSubscriptionId !== subscriptionId;
      const expectedUserStatus = hasOtherConflict ? 'cancel_required' : status;
      if (
        subscription.status === status &&
        currentContractId === contract_id &&
        user.subscriptionStatus === expectedUserStatus
      ) {
        return;
      }
      await subscriptionRef.update({ data: update });
      await userRef.update({
        data: {
          subscriptionStatus: expectedUserStatus,
          subscriptionId,
          updatedAt: db.serverDate()
        }
      });
    });
  } catch (err) {
    console.error('[recurringContractCallback] update failed', err);
    return failAck('RETRY');
  }
  return ack();
};
