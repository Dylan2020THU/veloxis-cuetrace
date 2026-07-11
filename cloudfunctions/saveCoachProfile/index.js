const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function bindingId(openid) {
  return sha256(`wechat:${openid}`);
}

function fail(code, msg) {
  return { ok: false, code, msg };
}

async function getDocument(collection, id) {
  const result = await db.collection(collection).doc(id).get();
  return result && result.data ? result.data : null;
}

// 保存（创建或更新）当前用户的教练资料。教练身份只由店主审核通过开通。
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const userId = bindingId(OPENID);
  const binding = await getDocument('wechat_bindings', userId);
  if (!binding || binding._id !== userId || binding._openid !== OPENID || !binding.accountId) {
    return fail('ACCOUNT_NOT_BOUND', '请先登录或注册账号');
  }

  const account = await getDocument('accounts', binding.accountId);
  if (
    !account ||
    account._id !== binding.accountId ||
    account._openid !== OPENID ||
    account.account !== binding.account ||
    account.status !== 'active'
  ) {
    return fail('ACCOUNT_NOT_BOUND', '账号绑定信息不完整');
  }

  const user = await getDocument('users', userId);
  if (!user || user._id !== userId || user._openid !== OPENID) {
    return fail('ACCOUNT_NOT_BOUND', '账号资料不存在');
  }

  const {
    nickname,
    playYears,
    coachYears,
    avatar,
    certificates,
    intro,
    availability,
    pricePerMinute,
    hallId,
    hallName,
    coachId
  } = event;

  const profile = {
    nickname: nickname || '',
    playYears: Number(playYears) || 0,
    coachYears: Number(coachYears) || 0,
    avatar: avatar || '',
    certificates: Array.isArray(certificates) ? certificates : [],
    intro: intro || '',
    availability: Array.isArray(availability) ? availability : [],
    pricePerMinute: Number(pricePerMinute) || 0,
    hallId: hallId || '',
    hallName: hallName || '',
    coachId: coachId || '',
    updatedAt: db.serverDate()
  };

  await db.collection('coaches').doc(userId).set({
    data: Object.assign({ _openid: OPENID }, profile)
  });

  // 同步用户昵称头像，不在这里开通教练身份。
  const userPatch = { updatedAt: db.serverDate() };
  if (nickname) userPatch.nickname = nickname;
  if (avatar) userPatch.avatar = avatar;
  await db.collection('users').doc(userId).update({ data: userPatch });

  return { ok: true };
};
