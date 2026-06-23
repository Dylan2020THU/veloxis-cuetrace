const mock = require('../../utils/mock');
const data = require('../../services/data');
const rank = require('../../utils/rank');

const ROLE_LABEL = { member: '会员', coach: '教练', shop: '店家' };
const THEME_LABEL = { light: '白天模式', dark: '夜间模式', system: '跟随系统' };

Page({
  behaviors: [require('../../utils/themeBehavior')],

  data: {
    nickname: '大川会员',
    avatar: '',
    role: 'member',
    roleLabel: '会员',
    isCoach: false,
    isShop: false,
    hasCoachProfile: false,
    hasShopProfile: false,
    themeMode: 'system',
    themeModeLabel: '跟随系统',
    // 训练成就 / 段位
    summary: { totalDays: 0, totalHoursText: '0.0', streak: 0 },
    rankInfo: { label: '青铜杆手', growth: 0, nextMin: 600, nextLabel: '白银杆手', toNextHoursText: '10.0', progress: 0, isMax: false },
    // 约球计数：我发起 / 我参与 / 约教练 / 约球桌
    matchCounts: { posted: 0, joined: 0, coach: 0, table: 0 },
    // 设置面板开关
    settingsOpen: false,
    // 本地缓存大小（清理缓存项展示）
    cacheText: ''
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().refresh();
    }
    const app = getApp();
    const role = mock.getRole();
    const profile = app.globalData.userProfile;
    this.setData({
      role,
      roleLabel: ROLE_LABEL[role] || '会员',
      isCoach: role === 'coach',
      isShop: role === 'shop',
      nickname: (profile && profile.nickname) || '大川会员',
      avatar: (profile && profile.avatar) || '',
      themeMode: app.globalData.themeMode,
      themeModeLabel: THEME_LABEL[app.globalData.themeMode] || '跟随系统',
      settingsOpen: false
    });
    data.getUserProfile().then((user) => {
      if (!user) return;
      const nextRole = user.role || role;
      this.setData({
        nickname: user.nickname || '大川会员',
        avatar: user.avatar || '',
        role: nextRole,
        roleLabel: ROLE_LABEL[nextRole] || '会员',
        isCoach: nextRole === 'coach',
        isShop: nextRole === 'shop'
      });
    });
    data.getCoachProfile().then((p) => this.setData({ hasCoachProfile: !!p }));
    data.getShopProfile().then((p) => this.setData({ hasShopProfile: !!p }));
    this.loadAchievement();
    this.loadMatchCounts();
    this.refreshCacheSize();
  },

  // 训练成就 + 段位（成长值 = 累计训练分钟）
  loadAchievement() {
    data.getMemberCheckins().then((stats) => {
      const summary = rank.summarize(stats);
      const rankInfo = rank.computeRank(summary.totalMinutes);
      this.setData({ summary, rankInfo });
    }).catch((err) => {
      console.warn('[我的] 训练成就加载失败', err);
    });
  },

  // 约球计数：我发起 / 我参与 / 约教练 / 约球桌
  loadMatchCounts() {
    Promise.all([
      data.getMyMatches().catch(() => []),
      data.getMyJoins().catch(() => []),
      data.getMyBookings().catch(() => [])
    ]).then(([matches, joins, bookings]) => {
      const list = bookings || [];
      this.setData({
        matchCounts: {
          posted: (matches || []).length,
          joined: (joins || []).length,
          coach: list.filter((b) => b.type === 'coach').length,
          table: list.filter((b) => b.type === 'table').length
        }
      });
    });
  },

  // ---------- 导航 ----------
  goMyProfile() {
    this.setData({ settingsOpen: false });
    const nickname = encodeURIComponent(this.data.nickname || '');
    wx.navigateTo({ url: `/pages/player/profile/index?isCurrentUser=1&nickname=${nickname}` });
  },
  goMatchMine() {
    wx.navigateTo({ url: '/pages/match/mine' });
  },
  goCheckin() {
    wx.switchTab({ url: '/pages/checkin/index' });
  },
  goCommunity() {
    wx.switchTab({ url: '/pages/community/index' });
  },
  goEditProfile() {
    this.setData({ settingsOpen: false });
    wx.navigateTo({ url: '/pages/player/profile/edit/index' });
  },
  goCoachProfile() {
    wx.navigateTo({ url: '/pages/coach/profile/index' });
  },
  goCoachMembers() {
    wx.switchTab({ url: '/pages/coach/members/index' });
  },
  goCoachBookings() {
    wx.navigateTo({ url: '/pages/coach/bookings/index' });
  },
  goShopDashboard() {
    wx.navigateTo({ url: '/pages/shop/dashboard/index' });
  },

  about() {
    wx.showModal({
      title: '强化杆迹',
      content: '记录每一杆的成长。\n版本 v1.1.0',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  openSettings() {
    this.setData({ settingsOpen: true });
  },
  closeSettings() {
    this.setData({ settingsOpen: false });
  },
  noop() {},

  // 隐私政策（打开后台配置的《小程序隐私保护指引》）
  openPrivacy() {
    if (typeof wx.openPrivacyContract !== 'function') {
      wx.showToast({ title: '当前版本不支持', icon: 'none' });
      return;
    }
    wx.openPrivacyContract({
      fail: () => wx.showToast({ title: '请先在后台配置隐私协议', icon: 'none' })
    });
  },

  goAgreement() {
    this.setData({ settingsOpen: false });
    wx.navigateTo({ url: '/pages/legal/index?type=agreement' });
  },
  goThirdParty() {
    this.setData({ settingsOpen: false });
    wx.navigateTo({ url: '/pages/legal/index?type=thirdparty' });
  },

  // 统计本地缓存大小
  refreshCacheSize() {
    try {
      const info = wx.getStorageInfoSync();
      this.setData({ cacheText: (info.currentSize || 0) + ' KB' });
    } catch (e) {
      this.setData({ cacheText: '' });
    }
  },

  // 清理缓存：清除本地缓存，但保留登录身份与主题设置
  clearCache() {
    wx.showModal({
      title: '清理缓存',
      content: '将清除本地缓存数据（不会退出登录），确定？',
      confirmText: '清理',
      success: (res) => {
        if (!res.confirm) return;
        const keep = { dc_role: 1, dc_theme_mode: 1 };
        try {
          const info = wx.getStorageInfoSync();
          (info.keys || []).forEach((k) => {
            if (!keep[k]) wx.removeStorageSync(k);
          });
        } catch (e) {}
        this.refreshCacheSize();
        wx.showToast({ title: '已清理', icon: 'success' });
      }
    });
  },

  // 账号注销（不可恢复，双重确认）
  deleteAccount() {
    wx.showModal({
      title: '注销账号',
      content: '注销后将永久删除你的训练记录、社区内容、约球与预约等数据，且不可恢复。确定继续？',
      confirmText: '继续',
      confirmColor: '#e54545',
      success: (res) => {
        if (!res.confirm) return;
        wx.showModal({
          title: '再次确认',
          content: '这是不可逆操作，确认注销并删除全部数据吗？',
          confirmText: '确认注销',
          confirmColor: '#e54545',
          success: (res2) => {
            if (!res2.confirm) return;
            wx.showLoading({ title: '处理中', mask: true });
            data.deleteAccount().then(() => {
              try { wx.removeStorageSync('dc_role'); } catch (e) {}
              const app = getApp();
              if (app && app.globalData) {
                app.globalData.openid = '';
                app.globalData.userProfile = null;
              }
              wx.hideLoading();
              wx.showToast({ title: '已注销', icon: 'success' });
              setTimeout(() => wx.reLaunch({ url: '/pages/login/index' }), 800);
            }).catch(() => {
              wx.hideLoading();
              wx.showToast({ title: '注销失败，请重试', icon: 'none' });
            });
          }
        });
      }
    });
  },

  switchTheme() {
    const modes = ['light', 'dark', 'system'];
    wx.showActionSheet({
      itemList: ['白天模式', '夜间模式', '跟随系统'],
      success: (res) => {
        const mode = modes[res.tapIndex];
        const app = getApp();
        app.setThemeMode(mode);
        this.setData({ themeMode: mode, themeModeLabel: THEME_LABEL[mode] });
      }
    });
  },

  // 三身份切换
  switchRole() {
    wx.showActionSheet({
      itemList: ['会员', '教练', '店家'],
      success: (res) => {
        const next = ['member', 'coach', 'shop'][res.tapIndex];
        this.applyRole(next);
      }
    });
  },

  applyRole(next) {
    if (next === this.data.role) return;

    if (next === 'coach' && !this.data.hasCoachProfile) {
      this.promptCreate('成为教练', '尚未填写教练资料，是否前往填写？', () => this.goCoachProfile());
      return;
    }
    if (next === 'shop' && !this.data.hasShopProfile) {
      this.promptCreate('成为店家', '尚未设置店铺资料，是否前往设置？', () => this.goShopDashboard());
      return;
    }
    data.setRole(next).then((savedRole) => {
      const role = savedRole || next;
      this.setData({
        role,
        roleLabel: ROLE_LABEL[role],
        isCoach: role === 'coach',
        isShop: role === 'shop'
      });
      if (typeof this.getTabBar === 'function' && this.getTabBar()) {
        this.getTabBar().refresh();
      }
      wx.showToast({ title: `已切换为${ROLE_LABEL[role]}`, icon: 'none' });
    });
  },

  logout() {
    wx.showModal({
      title: '退出账号',
      content: '确定要退出当前账号吗？',
      confirmText: '退出',
      confirmColor: '#e54545',
      success: (res) => {
        if (!res.confirm) return;
        const app = getApp();
        if (app && app.globalData) {
          app.globalData.openid = '';
          app.globalData.userProfile = null;
        }
        // 清除登录身份，避免冷启动自动恢复上次身份
        try {
          wx.removeStorageSync('dc_role');
        } catch (e) {}
        wx.reLaunch({ url: '/pages/login/index' });
      }
    });
  },

  promptCreate(title, content, onConfirm) {
    wx.showModal({
      title,
      content,
      confirmText: '去设置',
      success: (res) => {
        if (res.confirm) onConfirm();
      }
    });
  }
});
