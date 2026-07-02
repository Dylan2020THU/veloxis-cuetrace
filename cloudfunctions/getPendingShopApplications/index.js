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

async function isAdminOpenid(openid) {
  const admins = await getActiveAdmins();
  if (admins.length) {
    return admins.some((item) => item._openid === openid);
  }
  return BOOTSTRAP_ADMIN_OPENIDS.indexOf(openid) !== -1;
}

// 管理员拉取店主资质申请列表。event.status: 'pending'(默认) | 'approved' | 'rejected' | 'all'
// 仅 admins 集合 active 管理员可调用；集合未初始化时允许兜底管理员调用。
exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  if (!(await isAdminOpenid(OPENID))) {
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
