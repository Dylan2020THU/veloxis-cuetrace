const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

async function removeOwned(openid) {
  const removed = {};
  const ownCollections = [
    'users',
    'training_sessions',
    'coaches',
    'shops',
    'posts',
    'post_likes',
    'post_comments',
    'matches',
    'match_joins',
    'bookings'
  ];

  for (let i = 0; i < ownCollections.length; i++) {
    const name = ownCollections[i];
    try {
      const r = await db.collection(name).where({ _openid: openid }).remove();
      removed[name] = (r && r.stats && r.stats.removed) || 0;
    } catch (e) {
      removed[name] = 'skip';
    }
  }

  try {
    await db.collection('coach_member_links')
      .where(_.or([{ coachOpenid: openid }, { memberOpenid: openid }])).remove();
  } catch (e) {}
  try {
    await db.collection('shop_coach_links')
      .where(_.or([{ shopOpenid: openid }, { coachOpenid: openid }])).remove();
  } catch (e) {}
  try {
    await db.collection('user_follows')
      .where(_.or([{ _openid: openid }, { authorOpenid: openid }])).remove();
  } catch (e) {}

  return removed;
}

exports.main = async () => {
  const now = Date.now();
  const due = await db.collection('users')
    .where({
      deletionStatus: 'pending',
      deletionScheduledAt: _.lte(now)
    })
    .limit(100)
    .get();

  const results = [];
  for (let i = 0; i < due.data.length; i++) {
    const user = due.data[i];
    const openid = user._openid;
    if (!openid) continue;
    const removed = await removeOwned(openid);
    results.push({ openid, removed });
    try {
      await db.collection('account_deletion_requests')
        .where({ _openid: openid, deletionStatus: 'pending' })
        .update({
          data: {
            deletionStatus: 'purged',
            purgedAt: db.serverDate(),
            removed
          }
        });
    } catch (e) {}
  }

  return { ok: true, checked: due.data.length, results };
};
