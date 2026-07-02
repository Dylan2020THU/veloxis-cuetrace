const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const BOOTSTRAP_ADMIN_OPENIDS = [
  'ovvdY3VKYCo7_jTzdpgGbuf26-tA'
];

async function getActiveAdmins() {
  try {
    const res = await db.collection('admins').where({ status: 'active' }).get();
    return res.data || [];
  } catch (e) {
    return [];
  }
}

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  const admins = await getActiveAdmins();
  const active = admins.some((item) => item._openid === OPENID);
  const bootstrap = !admins.length && BOOTSTRAP_ADMIN_OPENIDS.indexOf(OPENID) !== -1;
  return { ok: true, isAdmin: active || bootstrap, bootstrap };
};
