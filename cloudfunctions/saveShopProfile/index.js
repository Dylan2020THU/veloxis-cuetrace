const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 保存（创建或更新）已获 shop 角色授权用户的店铺资料
// 支持部分字段更新：name/hallId/hallName/tableTypes 任选其一均可传入
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { name, hallId, hallName, tableTypes } = event;

  const profile = {};
  if (name !== undefined) profile.name = name;
  if (hallId !== undefined) profile.hallId = hallId;
  if (hallName !== undefined) profile.hallName = hallName;
  if (tableTypes !== undefined) profile.tableTypes = Array.isArray(tableTypes) ? tableTypes : [];

  if (Object.keys(profile).length === 0) {
    return { ok: false, msg: '没有任何字段需要更新' };
  }
  const userRes = await db.collection('users').where({ _openid: OPENID }).get();
  const user = userRes.data && userRes.data[0];
  if (!user || !Array.isArray(user.roles) || user.roles.indexOf('shop') === -1) {
    return { ok: false, code: 'SHOP_NOT_APPROVED', msg: '店主身份未通过审核' };
  }
  profile.updatedAt = db.serverDate();

  const shops = db.collection('shops');
  const existing = await shops.where({ _openid: OPENID }).get();

  if (existing.data.length) {
    await shops.doc(existing.data[0]._id).update({ data: profile });
  } else {
    await shops.add({ data: Object.assign({ _openid: OPENID }, profile) });
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
