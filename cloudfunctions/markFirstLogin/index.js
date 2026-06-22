const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const VALID_ROLES = ['member', 'coach', 'shop'];

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { role, firstLoginAt } = event;
  const r = VALID_ROLES.indexOf(role) !== -1 ? role : 'member';

  try {
    const users = db.collection('users');
    const res = await users.where({ _openid: OPENID }).get();
    if (res.data.length) {
      const docId = res.data[0]._id;
      const u = res.data[0];
      const patch = {};
      if (!u.firstLoginAt) patch.firstLoginAt = firstLoginAt;
      const existingRole = u.per_role && u.per_role[r];
      patch[`per_role.${r}.firstLoginAt`] = existingRole && existingRole.firstLoginAt
        ? existingRole.firstLoginAt
        : firstLoginAt;
      if (Object.keys(patch).length) {
        await users.doc(docId).update({ data: patch });
      }
    } else {
      await users.add({
        data: {
          _openid: OPENID,
          role: r,
          firstLoginAt,
          nickname: '',
          avatar: '',
          per_role: { [r]: { firstLoginAt, plan: 'free', term: 1 } }
        }
      });
    }
    return { ok: true, firstLoginAt };
  } catch (err) {
    console.error('markFirstLogin failed', err);
    return { ok: false };
  }
};
