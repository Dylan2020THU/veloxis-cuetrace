const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

function canViewPost(post, currentOpenid, region, mutualOpenids) {
  const visibility = (post && post.visibility) || 'public';
  if (!post) return false;
  if (post._openid === currentOpenid) return true;
  if (visibility === 'private') return false;
  if (visibility === 'region') {
    return !!(region && post.region === region);
  }
  if (visibility === 'mutual') {
    return mutualOpenids.indexOf(post._openid) !== -1;
  }
  return true;
}

async function getMutualOpenids(posts, currentOpenid) {
  const authorIds = Array.from(new Set(
    posts
      .filter((post) => post && post.visibility === 'mutual' && post._openid && post._openid !== currentOpenid)
      .map((post) => post._openid)
  ));
  if (!authorIds.length) return [];

  const followRes = await db
    .collection('user_follows')
    .where({ _openid: currentOpenid, authorOpenid: _.in(authorIds) })
    .get();
  const followedByMe = new Set(followRes.data.map((item) => item.authorOpenid));

  const reverseRes = await db
    .collection('user_follows')
    .where({ _openid: _.in(authorIds), authorOpenid: currentOpenid })
    .get();
  const followingMe = new Set(reverseRes.data.map((item) => item._openid));

  return authorIds.filter((openid) => followedByMe.has(openid) && followingMe.has(openid));
}

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
    .limit(Math.min(pageSize * 2, 100))
    .get();

  const mutualOpenids = await getMutualOpenids(res.data, OPENID);
  return {
    posts: res.data
      .filter((post) => canViewPost(post, OPENID, region, mutualOpenids))
      .slice(0, pageSize)
  };
};
