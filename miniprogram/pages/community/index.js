const data = require('../../services/data');

Page({
  behaviors: [require('../../utils/themeBehavior')],
  data: {
    tab: 'discover', // discover | follow | region
    city: '北京', // 地区 tab 显示的城市名
    located: false, // 是否已成功定位
    colA: [],
    colB: [],
    loading: true,
    empty: false
  },

  onLoad() {
    // 进入时尝试定位，决定"地区"tab 的城市名
    data.resolveCity().then((city) => {
      if (city) {
        this.setData({ city, located: true });
      }
    });
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().refresh();
    }
    this.loadFeed();
  },

  onPullDownRefresh() {
    this.loadFeed(() => wx.stopPullDownRefresh());
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.tab) {
      // 重复点击"地区"tab 时重新定位
      if (tab === 'region') this.relocate();
      return;
    }
    this.setData({ tab });
    this.loadFeed();
  },

  // 点击地区 tab：未定位时先尝试定位，再切换
  onRegionTab() {
    if (this.data.tab === 'region') {
      this.relocate();
      return;
    }
    this.setData({ tab: 'region' });
    if (!this.data.located) {
      data.resolveCity().then((city) => {
        if (city) this.setData({ city, located: true });
        this.loadFeed();
      });
    } else {
      this.loadFeed();
    }
  },

  relocate() {
    wx.showLoading({ title: '定位中' });
    data
      .resolveCity()
      .then((city) => {
        if (city) {
          this.setData({ city, located: true });
          this.loadFeed();
        } else {
          wx.showToast({ title: '未获取到位置', icon: 'none' });
        }
      })
      .finally(() => wx.hideLoading());
  },

  loadFeed(done) {
    this.setData({ loading: true });
    data
      .getFeed({ page: 0, pageSize: 30, tab: this.data.tab, region: this.data.city })
      .then((posts) => {
        const colA = [];
        const colB = [];
        posts.forEach((p, i) => {
          (i % 2 === 0 ? colA : colB).push(p);
        });
        this.setData({ colA, colB, loading: false, empty: posts.length === 0 });
      })
      .catch((err) => {
        console.error('加载社区失败', err);
        this.setData({ loading: false });
      })
      .finally(() => done && done());
  },

  openDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/community/detail?id=${id}` });
  },

  goPost() {
    wx.navigateTo({ url: '/pages/community/post' });
  }
});
