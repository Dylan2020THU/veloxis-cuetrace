const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 结账同步：把球桌实测时长写为绑定球员的"已核验训练" + 教学局教练课时。
// date / startTime 由客户端按本地时区算好传入，避免服务端 UTC 偏差。
// 注意：云函数内 db.add() 不会自动注入 _openid，故可显式写 _openid=memberOpenid，
// 让该训练记录归属"球员"而非发起结账的"店家"。
exports.main = async (event) => {
  const { memberOpenid, memberNickname, coachOpenid, coachNickname, hallId, hallName, date, startTime, durationMinutes, amount } = event;
  const mins = Math.round(Number(durationMinutes) || 0);
  if (!memberOpenid || mins <= 0) return { ok: false, msg: '参数不足' };

  await db.collection('training_sessions').add({
    data: {
      _openid: memberOpenid,
      hallId: hallId || '',
      hallName: hallName || '',
      date: date || '',
      startTime: startTime || '',
      durationMinutes: mins,
      verified: true,
      createdAt: db.serverDate()
    }
  });

  if (coachOpenid) {
    await db.collection('coach_lessons').add({
      data: {
        coachOpenid,
        coachNickname: coachNickname || '',
        memberOpenid,
        memberNickname: memberNickname || '',
        hallId: hallId || '',
        hallName: hallName || '',
        date: date || '',
        durationMinutes: mins,
        amount: Number(amount) || 0,
        verified: true,
        createdAt: db.serverDate()
      }
    });
  }
  return { ok: true };
};
