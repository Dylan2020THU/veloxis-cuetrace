const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const VALID_ROLES = ['member', 'coach', 'shop'];

async function openCoachRole(coachOpenid) {
  if (!coachOpenid) return;
  const users = db.collection('users');
  const res = await users.where({ _openid: coachOpenid }).get();
  if (!res.data.length) {
    await users.add({
      data: {
        _openid: coachOpenid,
        roles: ['member', 'coach'],
        currentRole: 'member',
        role: 'member',
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    return;
  }
  const user = res.data[0];
  const roles = Array.from(new Set([].concat(user.roles || [], user.role || 'member', ['member', 'coach'])))
    .filter((role) => VALID_ROLES.indexOf(role) !== -1);
  await users.doc(user._id).update({
    data: {
      roles,
      currentRole: user.currentRole || user.role || 'member',
      role: user.role || user.currentRole || 'member',
      updatedAt: db.serverDate()
    }
  });
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const { applicationId, approve, reason } = event;
  if (!applicationId) return { ok: false, msg: '缺少申请 ID' };

  const apps = db.collection('coach_shop_applications');
  const appRes = await apps.doc(applicationId).get().catch(() => null);
  const application = appRes && appRes.data;
  if (!application) return { ok: false, msg: '申请不存在' };
  if (application.shopOpenid !== OPENID) return { ok: false, code: 'FORBIDDEN', msg: '无权审核该申请' };

  const status = approve ? 'approved' : 'rejected';
  await apps.doc(applicationId).update({
    data: {
      status,
      reason: approve ? '' : (reason || '店家未通过绑定申请'),
      reviewedBy: OPENID,
      reviewedAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  });

  if (approve) {
    const links = db.collection('shop_coach_links');
    const existing = await links
      .where({ shopOpenid: OPENID, coachOpenid: application.coachOpenid, storeId: application.storeId })
      .get();
    const linkPatch = {
      shopOpenid: OPENID,
      coachOpenid: application.coachOpenid,
      storeId: application.storeId,
      storeName: application.storeName || '',
      status: 'active',
      source: 'coach_apply',
      applicationId,
      updatedAt: db.serverDate()
    };
    if (existing.data.length) {
      await links.doc(existing.data[0]._id).update({ data: linkPatch });
    } else {
      await links.add({ data: Object.assign({}, linkPatch, { createdAt: db.serverDate() }) });
    }

    const coachRes = await db.collection('coaches').where({ _openid: application.coachOpenid }).get().catch(() => ({ data: [] }));
    if (coachRes.data.length) {
      await db.collection('coaches').doc(coachRes.data[0]._id).update({
        data: {
          hallId: application.storeId,
          hallName: application.storeName || '',
          bindingStatus: 'approved',
          updatedAt: db.serverDate()
        }
      });
    }
    await openCoachRole(application.coachOpenid);
  }

  return { ok: true, status };
};
