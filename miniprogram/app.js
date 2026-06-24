const { initData, login, getUserProfile, getUserBilling } = require('./services/data');

const THEME_KEY = 'dc_theme_mode';

App({
  globalData: {
    // 是否已成功初始化云开发环境；失败则自动回退到本地 mock 数据
    cloudReady: false,
    // 云开发环境 ID。部署云开发后，把这里替换成你的环境 ID。
    // 置空则强制使用本地 mock 数据（演示/开发阶段）。
    cloudEnv: 'cloud1-d4g2abcud02b40531',
    openid: '',
    role: 'member',
    userProfile: null,
    // 收费/试用：firstLoginAt 首次登录时间戳，plan 当前套餐（free/player_pro/coach_pro/shop_basic/shop_pro）
    firstLoginAt: 0,
    plan: 'free',
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
    // 冷启动恢复计费状态：写入 firstLoginAt / plan 到 globalData
    // onLaunch 同步阶段 getApp() 可能尚未挂载到 services/data 上，延后一帧再调避免崩溃
    this.sessionReady = new Promise((resolve) => {
      setTimeout(() => {
        this.restoreSession().then(resolve, resolve);
      }, 0);
    });
    this.billingReady = getUserBilling({ role: this.globalData.role }).catch((err) => {
      console.warn('[大川激流] 计费状态恢复失败', err);
    });
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
  },

  // 冷启动恢复：本地有 dc_role 时，以微信身份静默登录并拉取云端用户资料
  restoreSession() {
    if (!this.globalData.cloudReady) return Promise.resolve();
    let hasRole = false;
    try {
      hasRole = !!wx.getStorageSync('dc_role');
    } catch (e) {}
    if (!hasRole) return Promise.resolve();
    return login()
      .then(() => getUserProfile())
      // 用当前 role 拉取对应的计费状态，避免跨角色时间戳串台
      .then(() => {
        const role = (this.globalData && this.globalData.role) || '';
        if (role && typeof getUserBilling === 'function') {
          return getUserBilling({ role }).catch((err) => {
            console.warn('[大川激流] 计费状态恢复失败', err);
          });
        }
      })
      .catch((err) => {
        console.warn('[大川激流] 会话恢复失败', err);
      });
  },

  // ---------- 付费墙（全局入口）----------
  // 调用方式：getApp().paywall({ feature, planKey, role, multi }, (ok) => { ... })
  // 内部通过 getCurrentPages() 找到当前页面的 <paywall id="paywall"> 并 show()
  // 未找到 paywall 组件时降级为 wx.showModal
  paywall(opts, cb) {
    const pages = getCurrentPages();
    const cur = pages[pages.length - 1];
    if (cur && typeof cur.selectComponent === 'function') {
      const comp = cur.selectComponent('#paywall');
      if (comp && typeof comp.show === 'function') {
        comp.show(opts || {}, cb);
        return;
      }
    }
    // 降级：原生模态弹窗
    const billing = require('./utils/billing');
    const planKey = opts && opts.planKey;
    const plan = (planKey && billing.PLANS[planKey]) || billing.PLANS.free;
    wx.showModal({
      title: '该功能需升级',
      content: `${plan.label}（¥${billing.getPlanPrice(planKey, 'year')}/年）后可使用`,
      confirmText: '去看看',
      cancelText: '暂不开通',
      success: (res) => typeof cb === 'function' && cb(!!res.confirm),
      fail: () => typeof cb === 'function' && cb(false)
    });
  }
});
