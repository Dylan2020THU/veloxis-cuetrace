const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

function adminId(openid) {
  return crypto.createHash('sha256').update(`admin-openid:${openid}`).digest('hex');
}

async function isAdminOpenid(openid, loginName) {
  const id = adminId(openid);
  const res = await db.collection('admins').doc(id).get();
  const admin = res && res.data;
  return !!(
    admin &&
    admin._id === id &&
    admin._openid === openid &&
    admin.account === loginName &&
    admin.status === 'active'
  );
}

// 管理员拉取店主资质申请列表。event.status: 'pending'(默认) | 'approved' | 'rejected' | 'all'
// 仅 admins 集合中当前微信的 active 管理员记录可调用。
exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const loginName = (event.loginName || '').trim();
  if (!(await isAdminOpenid(OPENID, loginName))) {
    return { ok: false, code: 'FORBIDDEN', msg: '无审核权限', applications: [] };
  }

  const status = event.status || 'pending';
  try {
    const query = status === 'all' ? {} : { status };
    const res = await db
      .collection('shop_applications')
      .where(query)
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get();
    return { ok: true, applications: res.data };
  } catch (err) {
    console.error('getPendingShopApplications failed', err);
    return { ok: true, applications: [] };
  }
};
