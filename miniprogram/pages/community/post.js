const data = require('../../services/data');

const VISIBILITY_OPTIONS = [
  { key: 'public', label: '公开可见', desc: '所有球友都能看到', icon: '○' },
  { key: 'region', label: '同城可见', desc: '仅同城社区流展示', icon: '⌖' },
  { key: 'mutual', label: '仅互关好友可见', desc: '你和对方互相关注后可见', icon: '⇄' },
  { key: 'private', label: '仅自己可见', desc: '仅你自己可查看', icon: '◎' }
];

function normalizeTopic(raw) {
  return String(raw || '')
    .replace(/^#+/, '')
    .trim()
    .replace(/\s+/g, '')
    .slice(0, 16);
}

Page({
  behaviors: [require('../../utils/themeBehavior')],
  data: {
    mode: 'image', // image | video
    title: '',
    content: '',
    images: [],
    video: '',
    videoCover: '',
    suggestedTopics: ['台球训练', '今日打卡', '中式八球', '斯诺克', '九球', '杆法练习'],
    topics: [],
    location: null,
    region: '',
    visibility: 'public',
    visibilityOptions: VISIBILITY_OPTIONS,
    visibilityLabel: VISIBILITY_OPTIONS[0].label,
    visibilityDesc: VISIBILITY_OPTIONS[0].desc,
    visibilitySheetVisible: false,
    submitting: false
  },

  switchMode(e) {
    const mode = e.currentTarget.dataset.mode;
    if (mode === this.data.mode) return;
    // 切换形式时清空已选媒体，避免图文/视频混淆
    this.setData({ mode, images: [], video: '', videoCover: '' });
  },

  onTitleInput(e) {
    this.setData({ title: e.detail.value });
  },

  onContentInput(e) {
    this.setData({ content: e.detail.value });
  },

  chooseImages() {
    const remain = 9 - this.data.images.length;
    if (remain <= 0) {
      wx.showToast({ title: '最多 9 张', icon: 'none' });
      return;
    }
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      success: (res) => {
        const paths = res.tempFiles.map((f) => f.tempFilePath);
        wx.showLoading({ title: '上传中' });
        Promise.all(paths.map((p) => data.uploadFile(p, 'community')))
          .then((urls) => this.setData({ images: this.data.images.concat(urls) }))
          .finally(() => wx.hideLoading());
      }
    });
  },

  removeImage(e) {
    const idx = e.currentTarget.dataset.index;
    const images = this.data.images.slice();
    images.splice(idx, 1);
    this.setData({ images });
  },

  chooseVideo() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['video'],
      success: (res) => {
        const file = res.tempFiles[0];
        wx.showLoading({ title: '上传中' });
        const tasks = [data.uploadFile(file.tempFilePath, 'community/video')];
        if (file.thumbTempFilePath) {
          tasks.push(data.uploadFile(file.thumbTempFilePath, 'community/cover'));
        }
        Promise.all(tasks)
          .then(([videoUrl, coverUrl]) => {
            this.setData({ video: videoUrl, videoCover: coverUrl || '' });
          })
          .finally(() => wx.hideLoading());
      }
    });
  },

  removeVideo() {
    this.setData({ video: '', videoCover: '' });
  },

  noop() {},

  addSuggestedTopic(e) {
    this.addTopic(e.currentTarget.dataset.topic);
  },

  openTopicInput() {
    wx.showModal({
      title: '添加话题',
      editable: true,
      placeholderText: '输入话题名称',
      confirmText: '添加',
      success: (res) => {
        if (res.confirm) this.addTopic(res.content);
      }
    });
  },

  addTopic(raw) {
    const topic = normalizeTopic(raw);
    if (!topic) return;
    const topics = this.data.topics.slice();
    if (topics.indexOf(topic) !== -1) {
      wx.showToast({ title: '话题已添加', icon: 'none' });
      return;
    }
    if (topics.length >= 5) {
      wx.showToast({ title: '最多添加 5 个话题', icon: 'none' });
      return;
    }
    topics.push(topic);
    this.setData({ topics });
  },

  removeTopic(e) {
    const idx = e.currentTarget.dataset.index;
    const topics = this.data.topics.slice();
    topics.splice(idx, 1);
    this.setData({ topics });
  },

  chooseLocation() {
    wx.chooseLocation({
      success: (res) => {
        const location = {
          name: res.name || '已标记地点',
          address: res.address || '',
          latitude: res.latitude,
          longitude: res.longitude
        };
        const region = data.resolveCityFromLocation
          ? data.resolveCityFromLocation(res.latitude, res.longitude)
          : '';
        this.setData({ location, region });
      },
      fail: (err) => {
        if (err && err.errMsg && err.errMsg.indexOf('cancel') !== -1) return;
        wx.showToast({ title: '未选择地点', icon: 'none' });
      }
    });
  },

  clearLocation() {
    this.setData({ location: null, region: '' });
  },

  chooseVisibility() {
    this.setData({ visibilitySheetVisible: true });
  },

  closeVisibilitySheet() {
    this.setData({ visibilitySheetVisible: false });
  },

  selectVisibility(e) {
    const key = e.currentTarget.dataset.key;
    const selected = VISIBILITY_OPTIONS.find((item) => item.key === key) || VISIBILITY_OPTIONS[0];
    this.setData({
      visibility: selected.key,
      visibilityLabel: selected.label,
      visibilityDesc: selected.desc,
      visibilitySheetVisible: false
    });
  },

  submit() {
    if (this.data.submitting) return;
    const {
      mode,
      title,
      content,
      images,
      video,
      videoCover,
      topics,
      location,
      region,
      visibility
    } = this.data;

    if (mode === 'image' && images.length === 0 && !content.trim()) {
      wx.showToast({ title: '请添加图片或文字', icon: 'none' });
      return;
    }
    if (mode === 'video' && !video) {
      wx.showToast({ title: '请添加视频', icon: 'none' });
      return;
    }

    const payload = {
      type: mode,
      title: title.trim(),
      content: content.trim(),
      images: mode === 'image' ? images : videoCover ? [videoCover] : [],
      video: mode === 'video' ? video : '',
      cover: mode === 'video' ? videoCover : images[0] || '',
      topics,
      location,
      region,
      visibility
    };

    this.setData({ submitting: true });
    data
      .createPost(payload)
      .then((r) => {
        if (r && r.ok === false) {
          wx.showToast({ title: r.msg || '发布失败', icon: 'none' });
          return;
        }
        wx.showToast({ title: '已发布', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 600);
      })
      .catch((err) => {
        console.error('发布失败', err);
        wx.showToast({ title: '发布失败', icon: 'none' });
      })
      .finally(() => this.setData({ submitting: false }));
  }
});
