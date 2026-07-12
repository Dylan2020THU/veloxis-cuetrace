const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 店家将一名教练纳入本店管理
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { coachOpenid, storeId, storeName } = event;

  if (!coachOpenid) return { ok: false, msg: '缺少 coachOpenid' };

  const shopRes = await db.collection('users').where({ _openid: OPENID }).get();
  const shop = shopRes.data && shopRes.data[0];
  if (!shop || !Array.isArray(shop.roles) || shop.roles.indexOf('shop') === -1) {
    return { ok: false, code: 'SHOP_ROLE_REQUIRED', msg: '当前用户尚未通过店主审核' };
  }

  const coachRes = await db.collection('users').where({ _openid: coachOpenid }).get();
  const coach = coachRes.data && coachRes.data[0];
  if (!coach || !Array.isArray(coach.roles) || coach.roles.indexOf('coach') === -1) {
    return { ok: false, code: 'COACH_ROLE_REQUIRED', msg: '该用户尚未通过教练审核' };
  }

  let store = null;
  if (storeId) {
    let storeRes;
    try {
      storeRes = await db.collection('stores').doc(storeId).get();
    } catch (error) {
      return { ok: false, code: 'STORE_NOT_OWNED', msg: '门店不存在或不属于当前店主' };
    }
    store = storeRes && storeRes.data;
    if (!store || store._openid !== OPENID) {
      return { ok: false, code: 'STORE_NOT_OWNED', msg: '门店不存在或不属于当前店主' };
    }
  }
  const trustedStoreName = store ? (store.name || '') : null;

  const links = db.collection('shop_coach_links');
  const existing = await links.where({ shopOpenid: OPENID, coachOpenid }).get();
  if (existing.data.length) {
    const link = existing.data[0];
    if (link.status !== 'active') {
      await links.doc(link._id).update({
        data: {
          status: 'active',
          storeId: storeId || link.storeId || '',
          storeName: trustedStoreName !== null ? trustedStoreName : (storeName || link.storeName || ''),
          source: 'shop_add',
          updatedAt: db.serverDate()
        }
      });
    }
    return { ok: true, msg: '已添加' };
  }

  const res = await links.add({
    data: {
      shopOpenid: OPENID,
      coachOpenid,
      storeId: storeId || '',
      storeName: trustedStoreName !== null ? trustedStoreName : (storeName || ''),
      status: 'active',
      source: 'shop_add',
      createdAt: db.serverDate()
    }
  });
  return { ok: true, id: res._id };
};
