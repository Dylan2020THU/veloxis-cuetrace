// 页面混入：自动注入当前主题到 data.theme，并订阅全局主题变更。
// 用法：Page({ behaviors: [require('相对路径/utils/themeBehavior')], ... })
function applyNavBar(theme) {
  if (!wx.setNavigationBarColor) return;
  wx.setNavigationBarColor({
    frontColor: '#ffffff',
    backgroundColor: theme === 'dark' ? '#15171c' : '#067EF9'
  });
}

module.exports = Behavior({
  data: {
    theme: 'light'
  },

  lifetimes: {},

  // Page 使用 behaviors 时，下列页面生命周期会与页面自身的同名方法一并触发
  onLoad() {
    const app = getApp();
    if (!app) return;
    const theme = app.globalData.theme;
    this.setData({ theme });
    applyNavBar(theme);
    this._themeCb = (t) => {
      this.setData({ theme: t });
      applyNavBar(t);
    };
    app.watchTheme(this._themeCb);
  },

  onShow() {
    const app = getApp();
    if (!app) return;
    this.setData({ theme: app.globalData.theme });
    applyNavBar(app.globalData.theme);
    // 驱动自定义底栏刷新（nextTick 确保页面栈与 tabBar 实例已就绪）
    const syncTabBar = () => {
      if (typeof this.getTabBar !== 'function') return;
      const tabBar = this.getTabBar();
      if (tabBar && typeof tabBar.refresh === 'function') tabBar.refresh();
    };
    if (typeof wx.nextTick === 'function') {
      wx.nextTick(syncTabBar);
    } else {
      setTimeout(syncTabBar, 0);
    }
  },

  onUnload() {
    const app = getApp();
    if (app && this._themeCb) app.unwatchTheme(this._themeCb);
  }
});
