const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 关注 / 取消关注某作者
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { authorOpenid } = event;
  if (!authorOpenid) return { ok: false };
  if (authorOpenid === OPENID) return { ok: false, msg: '不能关注自己' };

  const follows = db.collection('user_follows');
  const existing = await follows.where({ _openid: OPENID, authorOpenid }).get();

  let following;
  if (existing.data.length) {
    await follows.doc(existing.data[0]._id).remove();
    following = false;
  } else {
    await follows.add({ data: { _openid: OPENID, authorOpenid, createdAt: db.serverDate() } });
    following = true;
  }
  return { ok: true, following };
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
