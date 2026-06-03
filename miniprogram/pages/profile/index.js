const mock = require('../../utils/mock');
const data = require('../../services/data');

const ROLE_LABEL = { member: '会员', coach: '教练', shop: '店家' };
const THEME_LABEL = { light: '白天模式', dark: '夜间模式', system: '跟随系统' };

Page({
  behaviors: [require('../../utils/themeBehavior')],

  data: {
    nickname: '大川会员',
    cloudReady: false,
    openid: '',
    role: 'member',
    roleLabel: '会员',
    isCoach: false,
    isShop: false,
    hasCoachProfile: false,
    hasShopProfile: false,
    themeMode: 'system',
    themeModeLabel: '跟随系统'
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().refresh();
    }
    const app = getApp();
    const role = mock.getRole();
    this.setData({
      cloudReady: app.globalData.cloudReady,
      openid: app.globalData.openid || mock.MOCK_OPENID,
      role,
      roleLabel: ROLE_LABEL[role] || '会员',
      isCoach: role === 'coach',
      isShop: role === 'shop',
      themeMode: app.globalData.themeMode,
      themeModeLabel: THEME_LABEL[app.globalData.themeMode] || '跟随系统'
    });
    data.getCoachProfile().then((p) => this.setData({ hasCoachProfile: !!p }));
    data.getShopProfile().then((p) => this.setData({ hasShopProfile: !!p }));
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
    data.setRole(next).then(() => {
      this.setData({
        role: next,
        roleLabel: ROLE_LABEL[next],
        isCoach: next === 'coach',
        isShop: next === 'shop'
      });
      if (typeof this.getTabBar === 'function' && this.getTabBar()) {
        this.getTabBar().refresh();
      }
      wx.showToast({ title: `已切换为${ROLE_LABEL[next]}`, icon: 'none' });
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
        if (app && app.globalData) app.globalData.openid = '';
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
  },

  resetMock() {
    wx.showModal({
      title: '重置演示数据',
      content: '将清空本地数据并重新生成一份演示数据，确定？',
      success: (res) => {
        if (!res.confirm) return;
        [
          'dc_seeded',
          'dc_sessions',
          'dc_halls',
          'dc_members',
          'dc_links',
          'dc_role',
          'dc_coach_profile',
          'dc_shop',
          'dc_shop_coaches',
          'dc_all_coaches',
          'dc_posts',
          'dc_post_likes',
          'dc_comments',
          'dc_follows',
          'dc_matches',
          'dc_bookings',
          'dc_match_joins'
        ].forEach((k) => wx.removeStorageSync(k));
        mock.ensureSeeded();
        this.setData({
          role: 'member',
          roleLabel: '会员',
          isCoach: false,
          isShop: false,
          hasCoachProfile: false,
          hasShopProfile: false
        });
        wx.showToast({ title: '已重置', icon: 'success' });
      }
    });
  }
});
