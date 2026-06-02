const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

// 点赞 / 取消点赞，返回最新状态与点赞数
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { postId } = event;
  if (!postId) return { ok: false };

  const likes = db.collection('post_likes');
  const existing = await likes.where({ _openid: OPENID, postId }).get();

  let liked;
  if (existing.data.length) {
    await likes.doc(existing.data[0]._id).remove();
    await db.collection('posts').doc(postId).update({ data: { likeCount: _.inc(-1) } });
    liked = false;
  } else {
    await likes.add({ data: { _openid: OPENID, postId, createdAt: db.serverDate() } });
    await db.collection('posts').doc(postId).update({ data: { likeCount: _.inc(1) } });
    liked = true;
  }

  const postRes = await db.collection('posts').doc(postId).get();
  return { ok: true, liked, likeCount: postRes.data.likeCount };
};
