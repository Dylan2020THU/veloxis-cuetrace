const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { store } = event;

  if (!store || !store.name) {
    return { ok: false, msg: '门店名称不能为空' };
  }

  const profile = {
    name: store.name,
    address: store.address || '',
    brandId: store.brandId || '',
    cover: store.cover || '',
    region: store.region || '',
    tableTypes: Array.isArray(store.tableTypes) ? store.tableTypes : [],
    updatedAt: db.serverDate()
  };

  if (store._id) {
    try {
      await db.collection('stores').doc(store._id).update({ data: profile });
      return { ok: true, storeId: store._id };
    } catch (e) {
      // 不存在则新建
    }
  }

  profile._openid = OPENID;
  profile.createdAt = db.serverDate();
  const res = await db.collection('stores').add({ data: profile });
  return { ok: true, storeId: res._id };
};
