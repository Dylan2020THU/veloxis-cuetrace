const data = require('../../services/data');
const mock = require('../../utils/mock');

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(ts).toLocaleDateString();
}

Page({
  behaviors: [require('../../utils/themeBehavior')],
  data: {
    postId: '',
    region: '',
    post: null,
    liked: false,
    following: false,
    isOwn: false,
    comments: [],
    commentText: '',
    loading: true,
    submitting: false
  },

  onLoad(query) {
    this.setData({ postId: query.id, region: query.region || '' });
    this.load();
  },

  load() {
    this.setData({ loading: true });
    data.getPostDetail(this.data.postId, { region: this.data.region }).then((res) => {
      const post = res.post;
      if (post) post.timeText = timeAgo(post.createdAt);
      const comments = (res.comments || []).map((c) => ({
        ...c,
        timeText: timeAgo(c.createdAt)
      }));
      const myOpenid = getApp().globalData.openid || mock.MOCK_OPENID;
      const isOwn = !!(post && post._openid === myOpenid);
      this.setData({
        post,
        liked: res.liked,
        following: !!res.following,
        isOwn,
        comments,
        loading: false
      });
    });
  },

  onToggleFollow() {
    if (!this.data.post) return;
    data.toggleFollow(this.data.post._openid).then((r) => {
      if (r && r.ok) this.setData({ following: r.following });
    });
  },

  previewImage(e) {
    const idx = e.currentTarget.dataset.index;
    wx.previewImage({ current: this.data.post.images[idx], urls: this.data.post.images });
  },

  onToggleLike() {
    data.toggleLike(this.data.postId).then((r) => {
      if (r && r.ok) {
        const post = this.data.post;
        post.likeCount = r.likeCount;
        this.setData({ liked: r.liked, post });
      }
    });
  },

  onCommentInput(e) {
    this.setData({ commentText: e.detail.value });
  },

  submitComment() {
    const text = this.data.commentText.trim();
    if (!text) return;
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    data
      .addComment(this.data.postId, text)
      .then(() => {
        this.setData({ commentText: '' });
        this.load();
      })
      .finally(() => this.setData({ submitting: false }));
  }
});
