const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

// 账号注销：删除本人(openid)归属的全部数据。不可恢复。
exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  const removed = {};

  // 以 _openid = 本人 归属的集合
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
      const r = await db.collection(name).where({ _openid: OPENID }).remove();
      removed[name] = (r && r.stats && r.stats.removed) || 0;
    } catch (e) {
      removed[name] = 'skip';
    }
  }

  // 关系类集合：按角色字段匹配本人
  try {
    await db.collection('coach_member_links')
      .where(_.or([{ coachOpenid: OPENID }, { memberOpenid: OPENID }])).remove();
  } catch (e) {}
  try {
    await db.collection('shop_coach_links')
      .where(_.or([{ shopOpenid: OPENID }, { coachOpenid: OPENID }])).remove();
  } catch (e) {}
  try {
    await db.collection('user_follows')
      .where(_.or([{ _openid: OPENID }, { authorOpenid: OPENID }])).remove();
  } catch (e) {}

  return { ok: true, removed };
};
