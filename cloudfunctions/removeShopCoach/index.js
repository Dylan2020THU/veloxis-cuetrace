const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 店家将一名教练移出本店管理
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { coachOpenid } = event;

  if (!coachOpenid) return { ok: false, msg: '缺少 coachOpenid' };

  const links = db.collection('shop_coach_links');
  const existing = await links.where({ shopOpenid: OPENID, coachOpenid }).get();
  for (const l of existing.data) {
    await links.doc(l._id).remove();
  }

  return { ok: true };
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
