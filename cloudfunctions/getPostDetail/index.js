const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 帖子详情：返回帖子、当前用户是否点赞、评论列表
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { postId } = event;
  if (!postId) return { post: null };

  const postRes = await db.collection('posts').doc(postId).get();
  const post = postRes.data;

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
