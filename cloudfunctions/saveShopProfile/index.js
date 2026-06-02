const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 保存（创建或更新）当前用户的店铺资料，并将其角色标记为 shop
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { name, hallId, hallName } = event;

  if (!name || !hallId) {
    return { ok: false, msg: '缺少店铺名称或所属台球厅' };
  }

  const profile = {
    name,
    hallId,
    hallName: hallName || '',
    updatedAt: db.serverDate()
  };

  const shops = db.collection('shops');
  const existing = await shops.where({ _openid: OPENID }).get();
  if (existing.data.length) {
    await shops.doc(existing.data[0]._id).update({ data: profile });
  } else {
    await shops.add({ data: Object.assign({ _openid: OPENID }, profile) });
  }

  try {
    const users = db.collection('users');
    const u = await users.where({ _openid: OPENID }).get();
    if (u.data.length) {
      await users.doc(u.data[0]._id).update({ data: { role: 'shop' } });
    } else {
      await users.add({ data: { _openid: OPENID, role: 'shop' } });
    }
  } catch (err) {
    console.error('update user role failed', err);
  }

  return { ok: true };
};
