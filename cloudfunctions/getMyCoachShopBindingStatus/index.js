const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();

  const linkRes = await db
    .collection('shop_coach_links')
    .where({ coachOpenid: OPENID, status: 'active' })
    .limit(1)
    .get()
    .catch(() => ({ data: [] }));
  if (linkRes.data.length) {
    return { ok: true, status: 'approved', link: linkRes.data[0], application: null };
  }

  const appRes = await db
    .collection('coach_shop_applications')
    .where({ coachOpenid: OPENID })
    .orderBy('updatedAt', 'desc')
    .limit(1)
    .get()
    .catch(() => ({ data: [] }));
  const application = appRes.data[0] || null;
  return { ok: true, status: application ? application.status : 'none', link: null, application };
};
