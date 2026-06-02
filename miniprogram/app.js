const { initData } = require('./services/data');

App({
  globalData: {
    // 是否已成功初始化云开发环境；失败则自动回退到本地 mock 数据
    cloudReady: false,
    // 云开发环境 ID。部署云开发后，把这里替换成你的环境 ID。
    cloudEnv: '',
    openid: '',
    role: 'member',
    brandColor: '#067EF9'
  },

  onLaunch() {
    this.initCloud();
    // 首次启动时确保本地至少有一份可演示的数据
    initData();
  },

  initCloud() {
    if (!wx.cloud) {
      console.warn('[大川激流] 当前基础库不支持云开发，使用本地 mock 数据运行');
      return;
    }
    try {
      wx.cloud.init({
        env: this.globalData.cloudEnv || undefined,
        traceUser: true
      });
      // 仅当显式配置了环境 ID 时才认为云端可用
      this.globalData.cloudReady = !!this.globalData.cloudEnv;
    } catch (err) {
      console.warn('[大川激流] 云开发初始化失败，回退到本地 mock 数据', err);
      this.globalData.cloudReady = false;
    }
  }
});
