const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 店家将一名教练纳入本店管理
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { coachOpenid } = event;

  if (!coachOpenid) return { ok: false, msg: '缺少 coachOpenid' };

  const links = db.collection('shop_coach_links');
  const existing = await links.where({ shopOpenid: OPENID, coachOpenid }).get();
  if (existing.data.length) {
    if (existing.data[0].status !== 'active') {
      await links.doc(existing.data[0]._id).update({ data: { status: 'active' } });
    }
    return { ok: true, msg: '已添加' };
  }

  const res = await links.add({
    data: {
      shopOpenid: OPENID,
      coachOpenid,
      status: 'active',
      createdAt: db.serverDate()
    }
  });
  return { ok: true, id: res._id };
};
