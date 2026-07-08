const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const BOOTSTRAP_ADMIN_OPENIDS = [
  'ovvdY3VKYCo7_jTzdpgGbuf26-tA'
];
const ADMIN_ACCOUNTS = ['admin_zhx'];

async function getActiveAdmins() {
  try {
    const res = await db.collection('admins').where({ status: 'active' }).get();
    return res.data || [];
  } catch (e) {
    return [];
  }
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const loginName = (event.loginName || '').trim();
  const accountAdmin = ADMIN_ACCOUNTS.indexOf(loginName) !== -1;
  if (!accountAdmin) {
    return { ok: true, isAdmin: false, bootstrap: false, accountAdmin: false };
  }
  const admins = await getActiveAdmins();
  const active = admins.some((item) => item._openid === OPENID && item.account === loginName);
  const bootstrap = !admins.length && BOOTSTRAP_ADMIN_OPENIDS.indexOf(OPENID) !== -1;
  return { ok: true, isAdmin: active || bootstrap, bootstrap, accountAdmin };
};
