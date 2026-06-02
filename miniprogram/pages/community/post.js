const data = require('../../services/data');

Page({
  data: {
    mode: 'image', // image | video
    title: '',
    content: '',
    images: [],
    video: '',
    videoCover: '',
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

  submit() {
    if (this.data.submitting) return;
    const { mode, title, content, images, video, videoCover } = this.data;

    if (!content.trim()) {
      wx.showToast({ title: '写点内容吧', icon: 'none' });
      return;
    }
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
      cover: mode === 'video' ? videoCover : images[0] || ''
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
