const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 新增一条训练记录（热力图数据源）
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { hallId, hallName, date, startTime, durationMinutes } = event;

  if (!date || !durationMinutes) {
    return { ok: false, msg: '缺少必要参数 date / durationMinutes' };
  }

  const res = await db.collection('training_sessions').add({
    data: {
      _openid: OPENID,
      hallId: hallId || '',
      hallName: hallName || '',
      date,
      startTime: startTime || '',
      durationMinutes: Number(durationMinutes) || 0,
      verified: false,
      createdAt: db.serverDate()
    }
  });

  return { ok: true, id: res._id };
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
