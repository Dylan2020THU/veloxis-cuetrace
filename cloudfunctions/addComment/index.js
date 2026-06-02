const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

// 发表评论
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { postId, content, authorName, authorAvatar } = event;

  if (!postId || !content) return { ok: false, msg: '评论内容不能为空' };

  const res = await db.collection('post_comments').add({
    data: {
      _openid: OPENID,
      postId,
      content,
      authorName: authorName || '球友',
      authorAvatar: authorAvatar || '',
      createdAt: db.serverDate()
    }
  });

  await db.collection('posts').doc(postId).update({ data: { commentCount: _.inc(1) } });

  return { ok: true, id: res._id };
};
