const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 查询当前用户的店主资质申请状态。
// 返回 { status, application }
//   status: 'none' 未申请 | 'pending' 待审核 | 'approved' 已通过 | 'rejected' 已驳回
// 老店主豁免：尚无申请记录但已有 shops 资料 → 视为 approved，避免存量店铺被新审核流程锁住。
// 两个集合各自容错（首次部署可能尚未建表），任一查询失败都不影响另一分支。
exports.main = async () => {
  const { OPENID } = cloud.getWXContext();

  let application = null;
  try {
    const res = await db.collection('shop_applications').where({ _openid: OPENID }).get();
    if (res.data.length) application = res.data[0];
  } catch (e) {
    // 集合不存在等 → 视为无申请记录
  }
  if (application) {
    return { status: application.status || 'pending', application };
  }

  try {
    const shop = await db.collection('shops').where({ _openid: OPENID }).get();
    if (shop.data.length) return { status: 'approved', application: null, legacy: true };
  } catch (e) {
    // ignore
  }

  return { status: 'none', application: null };
};
