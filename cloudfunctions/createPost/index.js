const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 发布一条社区帖子（图文 / 视频）
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const {
    type,
    title,
    content,
    images,
    video,
    cover,
    topics,
    location,
    region,
    visibility,
    authorName,
    authorAvatar
  } = event;

  if (!content && !(images && images.length) && !video) {
    return { ok: false, msg: '内容不能为空' };
  }

  const cleanTopics = Array.isArray(topics)
    ? topics
      .map((item) => String(item || '').replace(/^#+/, '').trim().replace(/\s+/g, '').slice(0, 16))
      .filter(Boolean)
      .slice(0, 5)
    : [];
  const cleanLocation = location && location.name
    ? {
      name: String(location.name).slice(0, 40),
      address: String(location.address || '').slice(0, 80),
      latitude: location.latitude,
      longitude: location.longitude
    }
    : null;
  const cleanVisibility = ['public', 'region', 'mutual', 'private'].indexOf(visibility) !== -1
    ? visibility
    : 'public';

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
      topics: cleanTopics,
      location: cleanLocation,
      region: region || '',
      visibility: cleanVisibility,
      likeCount: 0,
      commentCount: 0,
      createdAt: db.serverDate()
    }
  });

  return { ok: true, id: res._id };
};
