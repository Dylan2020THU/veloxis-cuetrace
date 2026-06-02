const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 发布一条约球邀约
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { hallId, hallName, datetime, gameType, note, authorName } = event;

  const res = await db.collection('matches').add({
    data: {
      _openid: OPENID,
      authorName: authorName || '球友',
      hallId: hallId || '',
      hallName: hallName || '',
      datetime: datetime || '',
      gameType: gameType || '',
      note: note || '',
      joinCount: 0,
      status: 'open',
      createdAt: db.serverDate()
    }
  });

  return { ok: true, id: res._id };
};
