const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 开启一张球桌的使用记录（支持绑定到店球员 / 教学局教练）
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { tableId, storeId, memberOpenid, coachOpenid, coachJoinedAt, verified } = event;
  if (!tableId) return { ok: false, msg: '缺少 tableId' };

  const now = Date.now();
  const res = await db.collection('sessions').add({
    data: {
      _openid: OPENID,
      tableId,
      storeId: storeId || '',
      memberOpenid: memberOpenid || '',
      coachOpenid: coachOpenid || '',
      coachJoinedAt: coachOpenid ? (coachJoinedAt || now) : null,
      verified: !!verified,
      status: 'active',
      startedAt: now,
      createdAt: db.serverDate()
    }
  });
  return { ok: true, sessionId: res._id };
};
