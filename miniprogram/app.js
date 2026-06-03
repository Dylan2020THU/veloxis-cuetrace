const { initData } = require('./services/data');

const THEME_KEY = 'dc_theme_mode';

App({
  globalData: {
    // 是否已成功初始化云开发环境；失败则自动回退到本地 mock 数据
    cloudReady: false,
    // 云开发环境 ID。部署云开发后，把这里替换成你的环境 ID。
    cloudEnv: '',
    openid: '',
    role: 'member',
    brandColor: '#067EF9',
    // 主题：themeMode 为用户选择(light/dark/system)，theme 为实际生效(light/dark)
    themeMode: 'system',
    theme: 'light'
  },

  // 主题变更订阅者（页面通过 themeBehavior 注册）
  themeListeners: [],
  systemTheme: '',

  onLaunch() {
    this.initTheme();
    this.initRole();
    this.initCloud();
    // 首次启动时确保本地至少有一份可演示的数据
    initData();
  },

  // 冷启动时恢复上次登录的身份，避免重置为默认 member 导致底栏显示错乱
  initRole() {
    try {
      const role = wx.getStorageSync('dc_role');
      if (role) this.globalData.role = role;
    } catch (e) {}
  },

  // ---------- 主题 ----------
  initTheme() {
    let mode = 'system';
    try {
      mode = wx.getStorageSync(THEME_KEY) || 'system';
    } catch (e) {}
    this.globalData.themeMode = mode;
    this.systemTheme = this.getSystemTheme();
    this.applyTheme();
    if (wx.onThemeChange) {
      wx.onThemeChange((res) => {
        this.systemTheme = res.theme || 'light';
        if (this.globalData.themeMode === 'system') this.applyTheme();
      });
    }
  },

  getSystemTheme() {
    try {
      const info = wx.getAppBaseInfo ? wx.getAppBaseInfo() : wx.getSystemInfoSync();
      return info && info.theme ? info.theme : 'light';
    } catch (e) {
      return 'light';
    }
  },

  // 根据 themeMode 解析出实际主题，并同步导航栏 / tabBar / 订阅者
  applyTheme() {
    const mode = this.globalData.themeMode;
    const theme = mode === 'system' ? this.systemTheme || 'light' : mode;
    this.globalData.theme = theme;

    const dark = theme === 'dark';
    if (wx.setNavigationBarColor) {
      wx.setNavigationBarColor({
        frontColor: '#ffffff',
        backgroundColor: dark ? '#15171c' : '#067EF9'
      });
    }
    if (wx.setTabBarStyle) {
      wx.setTabBarStyle({
        color: dark ? '#7a818c' : '#9aa0a6',
        selectedColor: '#067EF9',
        backgroundColor: dark ? '#15171c' : '#ffffff',
        borderStyle: dark ? 'white' : 'black'
      });
    }
    this.themeListeners.forEach((fn) => {
      try {
        fn(theme);
      } catch (e) {}
    });
  },

  setThemeMode(mode) {
    this.globalData.themeMode = mode;
    try {
      wx.setStorageSync(THEME_KEY, mode);
    } catch (e) {}
    this.applyTheme();
  },

  watchTheme(fn) {
    if (this.themeListeners.indexOf(fn) === -1) this.themeListeners.push(fn);
  },

  unwatchTheme(fn) {
    this.themeListeners = this.themeListeners.filter((f) => f !== fn);
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
