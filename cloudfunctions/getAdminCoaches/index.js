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

async function readCollection(name) {
  const res = await db.collection(name).limit(1000).get().catch(() => ({ data: [] }));
  return res.data || [];
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const loginName = (event.loginName || '').trim();
  if (!(await isAdminOpenid(OPENID, loginName))) {
    return { ok: false, code: 'FORBIDDEN', msg: '无管理员权限', summary: {}, coaches: [] };
  }

  const coaches = await readCollection('coaches');
  const users = await readCollection('users');
  const links = await readCollection('shop_coach_links');
  const applications = await readCollection('coach_shop_applications');
  const stores = await readCollection('stores');
  const usersByOpenid = {};
  const storesById = {};
  users.forEach((item) => { usersByOpenid[item._openid] = item; });
  stores.forEach((item) => { storesById[item._id] = item; });

  const activeLinks = links.filter((item) => item.status === 'active');
  const pendingApps = applications.filter((item) => (item.status || 'pending') === 'pending');
  const rows = coaches.map((coach) => {
    const openid = coach._openid || coach.openid || '';
    const link = activeLinks.find((item) => item.coachOpenid === openid);
    const pending = pendingApps.find((item) => item.coachOpenid === openid);
    const user = usersByOpenid[openid] || {};
    const store = link ? (storesById[link.storeId] || {}) : {};
    const bindingStatus = link ? 'approved' : pending ? 'pending' : 'none';
    return {
      coachOpenid: openid,
      coachName: coach.nickname || user.nickname || '教练',
      avatar: coach.avatar || user.avatar || '',
      boundStoreName: link ? (link.storeName || store.name || '') : '',
      bindingStatus,
      studentCount: coach.studentCount || 0,
      createdAt: coach.createdAt || user.createdAt || ''
    };
  });

  return {
    ok: true,
    summary: {
      totalCoaches: rows.length,
      boundCoaches: rows.filter((item) => item.bindingStatus === 'approved').length,
      pendingApplications: pendingApps.length,
      unboundCoaches: rows.filter((item) => item.bindingStatus === 'none').length,
      activeCoaches: rows.filter((item) => item.bindingStatus === 'approved').length
    },
    coaches: rows
  };
};
