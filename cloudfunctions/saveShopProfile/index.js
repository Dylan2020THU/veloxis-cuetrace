const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 保存（创建或更新）当前用户的店铺资料，并将其角色标记为 shop
// 支持部分字段更新：name/hallId/hallName/tableTypes 任选其一均可传入
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { name, hallId, hallName, tableTypes } = event;

  const profile = {};
  if (name !== undefined) profile.name = name;
  if (hallId !== undefined) profile.hallId = hallId;
  if (hallName !== undefined) profile.hallName = hallName;
  if (tableTypes !== undefined) profile.tableTypes = Array.isArray(tableTypes) ? tableTypes : [];

  if (Object.keys(profile).length === 0) {
    return { ok: false, msg: '没有任何字段需要更新' };
  }
  profile.updatedAt = db.serverDate();

  const shops = db.collection('shops');
  const existing = await shops.where({ _openid: OPENID }).get();

  // 资质门控：无既有店铺记录者，必须持有"已通过"的营业执照资质申请方可创建店铺，
  // 防止未审核用户直接调用本云函数自助建店 / 自升店主、绕过营业执照审核。
  // 已有店铺记录的存量/已建店主可继续更新（豁免）。shops 集合的唯一写入口即此处。
  if (!existing.data.length) {
    let approved = false;
    try {
      const appRes = await db
        .collection('shop_applications')
        .where({ _openid: OPENID, status: 'approved' })
        .get();
      approved = appRes.data.length > 0;
    } catch (e) {
      // shop_applications 集合不存在 → 视为未通过
    }
    if (!approved) {
      return { ok: false, code: 'NOT_APPROVED', msg: '店主资质未通过审核，无法创建店铺' };
    }
  }

  if (existing.data.length) {
    await shops.doc(existing.data[0]._id).update({ data: profile });
  } else {
    await shops.add({ data: Object.assign({ _openid: OPENID }, profile) });
  }

  try {
    const users = db.collection('users');
    const u = await users.where({ _openid: OPENID }).get();
    const userPatch = { role: 'shop', updatedAt: db.serverDate() };
    if (name) userPatch.nickname = name;
    if (u.data.length) {
      await users.doc(u.data[0]._id).update({ data: userPatch });
    } else {
      await users.add({
        data: Object.assign({ _openid: OPENID, nickname: name || '', avatar: '' }, userPatch)
      });
    }
  } catch (err) {
    console.error('update user role failed', err);
  }

  return { ok: true };
};
