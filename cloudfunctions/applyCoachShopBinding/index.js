const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const { storeId, coachNickname, coachAvatar } = event;
  if (!storeId) return { ok: false, msg: '请选择球厅' };

  const storeRes = await db.collection('stores').doc(storeId).get().catch(() => null);
  const store = storeRes && storeRes.data;
  if (!store || !store._openid) return { ok: false, msg: '球厅不存在或未配置店主' };

  const apps = db.collection('coach_shop_applications');
  const existing = await apps.where({ coachOpenid: OPENID, storeId }).get();
  const patch = {
    _openid: OPENID,
    coachOpenid: OPENID,
    coachNickname: coachNickname || '',
    coachAvatar: coachAvatar || '',
    shopOpenid: store._openid,
    storeId,
    storeName: store.name || '',
    status: 'pending',
    reason: '',
    updatedAt: db.serverDate()
  };

  if (existing.data.length) {
    await apps.doc(existing.data[0]._id).update({ data: patch });
    return { ok: true, id: existing.data[0]._id, status: 'pending' };
  }

  const res = await apps.add({
    data: Object.assign({}, patch, { createdAt: db.serverDate() })
  });
  return { ok: true, id: res._id, status: 'pending' };
};
