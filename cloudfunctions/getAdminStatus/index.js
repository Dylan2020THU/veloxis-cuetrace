const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

function adminId(openid) {
  return crypto.createHash('sha256').update(`admin-openid:${openid}`).digest('hex');
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const loginName = (event.loginName || '').trim();
  const id = adminId(OPENID);
  const res = await db.collection('admins').doc(id).get();
  const admin = res && res.data;
  const isAdmin = !!(
    admin &&
    admin._id === id &&
    admin._openid === OPENID &&
    admin.account === loginName &&
    admin.status === 'active'
  );
  return { ok: true, isAdmin, bootstrap: false, accountAdmin: isAdmin };
};
