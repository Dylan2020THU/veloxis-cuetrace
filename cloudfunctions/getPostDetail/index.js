const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

async function canViewPost(post, currentOpenid, region) {
  const visibility = (post && post.visibility) || 'public';
  if (!post) return false;
  if (post._openid === currentOpenid) return true;
  if (visibility === 'private') return false;
  if (visibility === 'region') return !!(region && post.region === region);
  if (visibility === 'mutual') {
    const followRes = await db
      .collection('user_follows')
      .where({ _openid: currentOpenid, authorOpenid: post._openid })
      .get();
    if (!followRes.data.length) return false;
    const reverseRes = await db
      .collection('user_follows')
      .where({ _openid: post._openid, authorOpenid: currentOpenid })
      .get();
    return reverseRes.data.length > 0;
  }
  return true;
}

// 帖子详情：返回帖子、当前用户是否点赞、评论列表
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { postId, region = '' } = event;
  if (!postId) return { post: null };

  const postRes = await db.collection('posts').doc(postId).get();
  const post = postRes.data;
  if (!(await canViewPost(post, OPENID, region))) {
    return { post: null, liked: false, comments: [], following: false };
  }

  const likeRes = await db
    .collection('post_likes')
    .where({ _openid: OPENID, postId })
    .get();
  const liked = likeRes.data.length > 0;

  const commentRes = await db
    .collection('post_comments')
    .where({ postId })
    .orderBy('createdAt', 'asc')
    .get();

  let following = false;
  if (post && post._openid) {
    const followRes = await db
      .collection('user_follows')
      .where({ _openid: OPENID, authorOpenid: post._openid })
      .get();
    following = followRes.data.length > 0;
  }

  return { post, liked, comments: commentRes.data, following };
};

const { guardClientRequest } = require('./lib/auth/protocol-guard');
const protocolGuardedMain = exports.main;

exports.main = async (event = {}, ...args) => {
  const gate = await guardClientRequest({
    db,
    event,
    supportedSchemaVersions: [1]
  });
  if (!gate.ok) return gate;
  let businessEvent = event;
  if (Object.prototype.hasOwnProperty.call(event, 'authProtocol')) {
    businessEvent = { ...event };
    delete businessEvent.authProtocol;
  }
  return protocolGuardedMain(businessEvent, ...args);
};
