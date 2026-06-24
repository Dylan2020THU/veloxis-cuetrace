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

  // 注意：不要加 lifetimes:{} —— 带 lifetimes 时部分基础库会把本 behavior 当"组件行为"解析，
  // 从而忽略下面的页面级 onLoad/onShow，导致页面拿不到主题（整页不翻黑）。
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
    // 驱动自定义底栏刷新：先同步刷一次（切 tab 时高亮立即对上，避免 nextTick 慢半拍/对不上），
    // 再 nextTick 兜底一次（确保页面栈与 tabBar 实例已就绪）。
    const syncTabBar = () => {
      if (typeof this.getTabBar !== 'function') return;
      const tabBar = this.getTabBar();
      if (tabBar && typeof tabBar.refresh === 'function') tabBar.refresh();
    };
    syncTabBar();
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
