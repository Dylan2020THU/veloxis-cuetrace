const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

// 社区动态流。tab: discover | follow | region
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { page = 0, pageSize = 20, tab = 'discover', region = '' } = event;

  const posts = db.collection('posts');
  let where = {};

  if (tab === 'follow') {
    const followRes = await db
      .collection('user_follows')
      .where({ _openid: OPENID })
      .get();
    const followed = followRes.data.map((f) => f.authorOpenid);
    if (!followed.length) return { posts: [] };
    where = { _openid: _.in(followed) };
  } else if (tab === 'region') {
    if (!region) return { posts: [] };
    where = { region };
  }

  const res = await posts
    .where(where)
    .orderBy('createdAt', 'desc')
    .skip(page * pageSize)
    .limit(pageSize)
    .get();

  return { posts: res.data };
};
