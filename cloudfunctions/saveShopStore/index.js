const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const VALID_ROLES = ['member', 'coach', 'shop'];

function bindingId(openid) {
  return crypto.createHash('sha256').update(`wechat:${openid}`).digest('hex');
}

function fail(code, msg) {
  return { ok: false, code, msg };
}

async function getDocument(collection, id) {
  const result = await db.collection(collection).doc(id).get();
  return result && result.data ? result.data : null;
}

async function getBoundUser(openid) {
  const userId = bindingId(openid);
  const binding = await getDocument('wechat_bindings', userId);
  if (
    !binding ||
    binding._id !== userId ||
    binding._openid !== openid ||
    !binding.accountId ||
    !binding.account
  ) return null;

  const account = await getDocument('accounts', binding.accountId);
  if (
    !account ||
    account._id !== binding.accountId ||
    account._openid !== openid ||
    account.account !== binding.account ||
    account.status !== 'active'
  ) return null;

  const user = await getDocument('users', userId);
  if (!user || user._id !== userId || user._openid !== openid) return null;
  return user;
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const { store } = event;

  if (!store || !store.name) {
    return fail('INVALID_INPUT', '门店名称不能为空');
  }

  try {
    const user = await getBoundUser(OPENID);
    if (!user) return fail('ACCOUNT_NOT_BOUND', '账号绑定信息不完整');
    const roles = Array.isArray(user.roles)
      ? user.roles.filter((role) => VALID_ROLES.indexOf(role) !== -1)
      : [];
    if (roles.indexOf('shop') === -1) {
      return fail('SHOP_ROLE_REQUIRED', '当前用户尚未通过店主审核');
    }

    const profile = {
      name: store.name,
      address: store.address || '',
      brandId: store.brandId || '',
      cover: store.cover || '',
      region: store.region || '',
      // 到店打卡 / 距离：经纬度 + 打卡开关（白名单，未列入的字段会被丢弃）
      lat: typeof store.lat === 'number' ? store.lat : null,
      lng: typeof store.lng === 'number' ? store.lng : null,
      checkinEnabled: !!store.checkinEnabled,
      tableTypes: Array.isArray(store.tableTypes) ? store.tableTypes : [],
      // 球厅信息编辑新增字段：营业时间 / 简介
      businessHours: store.businessHours || '',
      intro: store.intro || '',
      updatedAt: db.serverDate()
    };

    if (store._id) {
      const existing = await getDocument('stores', store._id);
      if (!existing || existing._openid !== OPENID) {
        return fail('STORE_NOT_OWNED', '门店不存在或不属于当前店主');
      }
      await db.collection('stores').doc(store._id).update({ data: profile });
      return { ok: true, storeId: store._id };
    }

    profile._openid = OPENID;
    profile.createdAt = db.serverDate();
    const res = await db.collection('stores').add({ data: profile });
    return { ok: true, storeId: res._id };
  } catch (error) {
    return fail('STORE_WRITE_FAILED', '门店保存失败，请重试');
  }
};
