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
      createdAt: db.serverDate()
    }
  });

  return { ok: true, id: res._id };
};
