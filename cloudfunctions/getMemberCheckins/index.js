const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async (event) => {
  const { targetOpenid } = event;
  const { OPENID } = cloud.getWXContext();
  const query = targetOpenid
    ? db.collection('training_sessions').where({ _openid: targetOpenid })
    : db.collection('training_sessions').where({ _openid: OPENID });

  try {
    const res = await query.orderBy('date', 'desc').limit(500).get();
    return { ok: true, checkins: res.data || [] };
  } catch (err) {
    console.error('getMemberCheckins failed', err);
    return { ok: true, checkins: [] };
  }
};
