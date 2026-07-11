const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

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
  const { storeId, coachNickname, coachAvatar, intro } = event;
  if (!storeId) return fail('INVALID_INPUT', '请选择球厅');

  try {
    const applicant = await getBoundUser(OPENID);
    if (!applicant) return fail('ACCOUNT_NOT_BOUND', '账号绑定信息不完整');

    const store = await getDocument('stores', storeId);
    if (!store || !store._openid) {
      return fail('STORE_NOT_OWNED', '球厅不存在或未配置店主');
    }

    const owner = await getBoundUser(store._openid);
    if (!owner) return fail('ACCOUNT_NOT_BOUND', '店主账号绑定信息不完整');
    if (!Array.isArray(owner.roles) || owner.roles.indexOf('shop') === -1) {
      return fail('SHOP_ROLE_REQUIRED', '球厅所有者尚未通过店主审核');
    }
    if (store._openid === OPENID) {
      return fail('SELF_APPLICATION_NOT_ALLOWED', '不能申请成为自己门店的教练');
    }

    const apps = db.collection('coach_shop_applications');
    const existing = await apps.where({ coachOpenid: OPENID, storeId }).get();
    const patch = {
      _openid: OPENID,
      coachOpenid: OPENID,
      coachNickname: coachNickname || '',
      coachAvatar: coachAvatar || '',
      intro: intro || '',
      shopOpenid: store._openid,
      storeId: store._id,
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
  } catch (error) {
    return fail('APPLICATION_FAILED', '申请提交失败，请重试');
  }
};
