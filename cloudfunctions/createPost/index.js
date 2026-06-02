const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 发布一条社区帖子（图文 / 视频）
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { type, title, content, images, video, cover, authorName, authorAvatar } = event;

  if (!content && !(images && images.length) && !video) {
    return { ok: false, msg: '内容不能为空' };
  }

  const res = await db.collection('posts').add({
    data: {
      _openid: OPENID,
      authorName: authorName || '球友',
      authorAvatar: authorAvatar || '',
      type: type || (video ? 'video' : 'image'),
      title: title || '',
      content: content || '',
      images: Array.isArray(images) ? images : [],
      video: video || '',
      cover: cover || (Array.isArray(images) && images[0]) || '',
      likeCount: 0,
      commentCount: 0,
      createdAt: db.serverDate()
    }
  });

  return { ok: true, id: res._id };
};
