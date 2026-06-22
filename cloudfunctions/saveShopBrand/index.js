const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { brand } = event;

  if (!brand || !brand.name) {
    return { ok: false, msg: '品牌名称不能为空' };
  }

  const profile = {
    name: brand.name,
    logo: brand.logo || '',
    updatedAt: db.serverDate()
  };

  const existing = await db.collection('brands').where({ _openid: OPENID }).get();

  if (existing.data.length) {
    await db.collection('brands').doc(existing.data[0]._id).update({ data: profile });
    return { ok: true, brandId: existing.data[0]._id };
  } else {
    profile._openid = OPENID;
    profile.createdAt = db.serverDate();
    const res = await db.collection('brands').add({ data: profile });
    return { ok: true, brandId: res._id };
  }
};
