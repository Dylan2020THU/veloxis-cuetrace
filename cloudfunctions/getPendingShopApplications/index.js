const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 系统管理员 openid 白名单。部署后填入管理员真实 openid（可在云函数日志 / login 返回里取）。
// 注意：reviewShopApplication 需保持同一份白名单。
const ADMIN_OPENIDS = [
  'ovvdY3VKYCo7_jTzdpgGbuf26-tA' // 管理员 openid（张总）
];

// 管理员拉取店主资质申请列表。event.status: 'pending'(默认) | 'approved' | 'rejected' | 'all'
// 仅白名单 openid 可调用。
exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  if (ADMIN_OPENIDS.indexOf(OPENID) === -1) {
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
