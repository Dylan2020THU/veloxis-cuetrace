// app.js — 全局入口
const billing = require('./utils/billing');

// 云开发环境 ID（部署后填真实环境；保持与云函数所在环境一致）
const CLOUD_ENV = 'cloud1-d4g2abcud02b40531';

App({
  globalData: {
    role: '',
    account: '',
    openid: '',
    firstLoginAt: 0,
    plan: 'free',
    planExpiresAt: 0,
    per_role: {},
    cloudEnv: CLOUD_ENV,
    themeMode: 'light',
    theme: 'light',
    // 云端是否真正可用：由 probeCloud() 实测云函数后置位。
    // 探测成功前一律按 false 处理；认证调用失败关闭，普通演示数据仍可使用本地 mock。
    cloudReady: false
  },

  onLaunch() {
    this.initCloud();      // 同步初始化 SDK（不代表云函数已部署）
    this.ensureSeedData(); // 播种本地 mock 演示数据（清缓存/新装后自愈，避免店主端门店/教练/会员全为 0）
    this.bootstrap();      // 读本地登录态 / 订阅缓存
    this.initTheme();      // 固定应用白天模式
    this.probeCloud();     // 异步探测云端，通了才切云
  },

  // 确保本地 mock 数据已播种。ensureSeeded 自身幂等（dc_seeded_v2 标记）：
  // 已播种只做增量迁移、不覆盖店主已添加的门店；未播种（含清缓存后）才全量补齐演示数据。
  ensureSeedData() {
    try {
      require('./services/data').initData();
    } catch (e) {
      console.warn('[CueTrace] 本地数据播种失败', e);
    }
  },

  // 初始化云开发 SDK。仅建立连接，能否真正用云函数由 probeCloud 决定。
  initCloud() {
    if (!wx.cloud) {
      console.warn('[CueTrace] 基础库不支持云开发，使用本地 mock 数据运行');
      return;
    }
    try {
      wx.cloud.init({ env: this.globalData.cloudEnv || undefined, traceUser: true });
    } catch (e) {
      console.warn('[CueTrace] wx.cloud.init 失败，回退本地 mock', e);
    }
  },

  // 认证探测只调用 accountAuth.probe，不创建用户、不写数据库；明确返回 ok 才认定云端可用。
  // 探测成功后主动刷新订阅态，确保"云端发的货"能被端上读回。
  probeCloud() {
    if (!wx.cloud || !this.globalData.cloudEnv) return;
    wx.cloud
      .callFunction({ name: 'accountAuth', data: { action: 'probe' } })
      .then((res) => {
        if (!res.result || res.result.ok !== true) throw new Error('AUTH_PROBE_FAILED');
        this.globalData.cloudReady = true;
        this.refreshBilling();
      })
      .catch((e) => {
        this.globalData.cloudReady = false;
        console.warn('[CueTrace] 认证云服务探测失败', e);
      });
  },

  // 云端就绪后，主动从云端拉取并覆盖订阅态（惰性 require 避免循环依赖）。
  refreshBilling() {
    try {
      const data = require('./services/data');
      const role = this.globalData.role || '';
      if (data && typeof data.getUserBilling === 'function') {
        data.getUserBilling({ role }).catch(() => {});
      }
    } catch (e) {
      /* ignore：刷新失败不阻断启动，页面后续调用会再拉 */
    }
  },

  // 读取本地登录态与订阅缓存（mock / 上次会话）
  bootstrap() {
    this.globalData.openid = wx.getStorageSync('openid') || '';
    this.globalData.role = wx.getStorageSync('role') || '';
    this.globalData.firstLoginAt = wx.getStorageSync('firstLoginAt') || 0;
    this.restoreSubscription();
  },

  // 从本地缓存恢复订阅状态（云端就绪后由 refreshBilling / data.js 覆盖）
  restoreSubscription() {
    this.globalData.plan = wx.getStorageSync('plan') || 'free';
    this.globalData.planExpiresAt = wx.getStorageSync('planExpiresAt') || 0;
  },

  initTheme() {
    this._themeWatchers = this._themeWatchers || [];
    this.globalData.themeMode = 'light';
    this.globalData.theme = 'light';
    try {
      wx.setStorageSync('dc_theme_mode', 'light');
    } catch (e) {}
  },

  resolveTheme(mode) {
    return 'light';
  },

  applyTheme(theme) {
    this.globalData.theme = theme || 'light';
    (this._themeWatchers || []).slice().forEach((fn) => {
      try {
        fn(this.globalData.theme);
      } catch (e) {}
    });
  },

  setThemeMode(mode) {
    this.globalData.themeMode = 'light';
    try {
      wx.setStorageSync('dc_theme_mode', 'light');
    } catch (e) {}
    this.applyTheme('light');
  },

  watchTheme(fn) {
    if (typeof fn !== 'function') return;
    this._themeWatchers = this._themeWatchers || [];
    if (this._themeWatchers.indexOf(fn) === -1) this._themeWatchers.push(fn);
  },

  unwatchTheme(fn) {
    if (!this._themeWatchers) return;
    this._themeWatchers = this._themeWatchers.filter((item) => item !== fn);
  },

  // 付费墙统一入口：组件实例由当前页面注册（避免全局多实例）
  // 注意：paywall 组件暴露的方法是 show(opts, onResult)，回调走第二参（组件内部存为 _callback）。
  paywall(opts, cb) {
    const pages = getCurrentPages();
    const top = pages[pages.length - 1];
    const inst = top && top.selectComponent && top.selectComponent('#paywall');
    if (inst && typeof inst.show === 'function') {
      inst.show(opts, cb);
    } else if (cb) {
      cb(false);
    }
  }
});
