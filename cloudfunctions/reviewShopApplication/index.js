const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 系统管理员 openid 白名单。需与 getPendingShopApplications 保持一致。
const ADMIN_OPENIDS = [
  'ovvdY3VKYCo7_jTzdpgGbuf26-tA' // 管理员 openid（张总，与 getPendingShopApplications 保持一致）
];

// 管理员审核店主资质申请：approve=true 通过 / false 驳回（驳回写 reason，店主可见）。
// 通过后把申请人 users.role 置为 shop，便于其登录直接进入店主端。仅白名单 openid 可调用。
exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  if (ADMIN_OPENIDS.indexOf(OPENID) === -1) {
    return { ok: false, code: 'FORBIDDEN', msg: '无审核权限' };
  }

  const { applicationId, approve, reason } = event;
  if (!applicationId) return { ok: false, msg: '缺少申请 ID' };

  const apps = db.collection('shop_applications');
  try {
    const res = await apps.doc(applicationId).get();
    const application = res.data;
    if (!application) return { ok: false, msg: '申请不存在' };

    const status = approve ? 'approved' : 'rejected';
    await apps.doc(applicationId).update({
      data: {
        status,
        reason: approve ? '' : (reason || '资料未通过核验'),
        reviewedBy: OPENID,
        reviewedAt: db.serverDate()
      }
    });

    if (approve) {
      try {
        const users = db.collection('users');
        const u = await users.where({ _openid: application._openid }).get();
        if (u.data.length) {
          await users.doc(u.data[0]._id).update({ data: { role: 'shop', updatedAt: db.serverDate() } });
        }
      } catch (e) {
        console.error('set role after approve failed', e);
      }
    }

    return { ok: true, status };
  } catch (err) {
    console.error('reviewShopApplication failed', err);
    return { ok: false, msg: '审核失败，请重试' };
  }
};
