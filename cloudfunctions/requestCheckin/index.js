const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 球员到店：发起待前台确认的到店请求
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { storeId, storeName, tableId, tableName, nickname, avatar, lat, lng, dist } = event;
  if (!storeId) return { ok: false, msg: '缺少 storeId' };

  // 同一球员对同一门店仅保留一条 pending：旧的置 superseded
  await db.collection('checkin_requests').where({
    memberOpenid: OPENID, storeId, status: 'pending'
  }).update({ data: { status: 'superseded' } }).catch(() => {});

  const res = await db.collection('checkin_requests').add({
    data: {
      memberOpenid: OPENID,
      storeId,
      storeName: storeName || '',
      tableId: tableId || '',
      tableName: tableName || '',
      nickname: nickname || '',
      avatar: avatar || '',
      lat: typeof lat === 'number' ? lat : null,
      lng: typeof lng === 'number' ? lng : null,
      dist: typeof dist === 'number' ? dist : null,
      status: 'pending',
      createdAt: Date.now()
    }
  });
  return { ok: true, request: { _id: res._id } };
};
