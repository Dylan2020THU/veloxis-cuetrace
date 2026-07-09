const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const ADMIN_CREDENTIALS = [
  { account: 'admin_zhx', password: '2612694' }
];

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const account = (event.account || '').trim();
  const password = event.password || '';
  const hit = ADMIN_CREDENTIALS.find((item) => item.account === account && item.password === password);
  if (!hit) return { ok: false, code: 'INVALID_ADMIN', msg: '管理员账号或密码错误' };

  const admins = db.collection('admins');
  const res = await admins.where({ _openid: OPENID, account }).get().catch(() => ({ data: [] }));
  const data = { _openid: OPENID, account, status: 'active', updatedAt: db.serverDate() };
  if (res.data && res.data.length) {
    await admins.doc(res.data[0]._id).update({ data });
  } else {
    await admins.add({ data: Object.assign({}, data, { createdAt: db.serverDate() }) });
  }
  return { ok: true, isAdmin: true, account };
};
