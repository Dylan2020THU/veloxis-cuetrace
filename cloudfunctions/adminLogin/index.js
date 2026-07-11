const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const ADMIN_CREDENTIALS = [
  { account: 'admin_zhx', password: '2612694' }
];

function fail(code, msg) {
  return { ok: false, code, msg };
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const account = (event.account || '').trim();
  const password = event.password || '';
  const hit = ADMIN_CREDENTIALS.find((item) => item.account === account && item.password === password);
  if (!hit) return fail('INVALID_ADMIN', '管理员账号或密码错误');

  const admins = db.collection('admins');
  const byAccount = await admins.where({ account, status: 'active' }).get();
  if (byAccount.data.some((item) => item._openid !== OPENID)) {
    return fail('ACCOUNT_ALREADY_BOUND', '管理员账号已绑定其他微信');
  }
  const byOpenid = await admins.where({ _openid: OPENID, status: 'active' }).get();
  if (byOpenid.data.some((item) => item.account !== account)) {
    return fail('WECHAT_ALREADY_BOUND', '当前微信已绑定其他管理员账号');
  }

  const existing = byAccount.data.find((item) => item._openid === OPENID);
  const data = { _openid: OPENID, account, status: 'active', updatedAt: db.serverDate() };
  if (existing) {
    await admins.doc(existing._id).update({ data });
  } else {
    await admins.add({ data: Object.assign({}, data, { createdAt: db.serverDate() }) });
  }
  return { ok: true, isAdmin: true, account };
};
