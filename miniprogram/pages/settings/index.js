const data = require('../../services/data');
const mock = require('../../utils/mock');

const THEME_LABEL = { light: '白天模式', dark: '夜间模式', system: '跟随系统' };
// 账户区入口文案：店主端按「球厅」口吻，其余沿用「个人 / 我的」
const ACCOUNT_LABELS = {
  shop: { profile: '球厅主页', edit: '编辑球厅信息', qr: '球厅二维码' },
  default: { profile: '个人主页', edit: '编辑我的信息', qr: '我的二维码' }
};

Page({
  behaviors: [require('../../utils/themeBehavior')],

  data: {
    // 个人主页跳转需要昵称
    nickname: '大川会员',
    // 背景模式展示
    themeMode: 'system',
    themeModeLabel: '跟随系统',
    // 本地缓存大小
    cacheText: '',
    // 账户区入口文案（按角色：店主→球厅口吻）
    profileLabel: '个人主页',
    editLabel: '编辑我的信息',
    qrLabel: '我的二维码'
  },

  onShow() {
    const app = getApp();
    const profile = app.globalData.userProfile;
    const mode = app.globalData.themeMode;
    const labels = ACCOUNT_LABELS[mock.getRole()] || ACCOUNT_LABELS.default;
    this.setData({
      nickname: (profile && profile.nickname) || '大川会员',
      themeMode: mode,
      themeModeLabel: THEME_LABEL[mode] || '跟随系统',
      profileLabel: labels.profile,
      editLabel: labels.edit,
      qrLabel: labels.qr
    });
    this.refreshCacheSize();
  },

  // ---------- 账户 ----------
  goMyProfile() {
    // 店主端走专属「球厅主页」；球员/教练沿用个人主页
    if (mock.getRole() === 'shop') {
      wx.navigateTo({ url: '/pages/shop/profile/index' });
      return;
    }
    const nickname = encodeURIComponent(this.data.nickname || '');
    wx.navigateTo({ url: `/pages/player/profile/index?isCurrentUser=1&nickname=${nickname}` });
  },
  goEditProfile() {
    // 店主端走专属「编辑球厅信息」；球员/教练沿用编辑我的信息
    if (mock.getRole() === 'shop') {
      wx.navigateTo({ url: '/pages/shop/profile/edit/index' });
      return;
    }
    wx.navigateTo({ url: '/pages/player/profile/edit/index' });
  },
  // 我的二维码（账号编码的二维码版，供不同端互扫识别）
  goMyQrcode() {
    wx.navigateTo({ url: '/pages/profile/qrcode/index' });
  },

  // ---------- 通用 ----------
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

  // ---------- 关于与法律 ----------
  about() {
    wx.showModal({
      title: '强化杆迹',
      content: '记录每一杆的成长。\n版本 v1.1.0',
      showCancel: false,
      confirmText: '知道了'
    });
  },

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
    wx.navigateTo({ url: '/pages/legal/index?type=agreement' });
  },
  goThirdParty() {
    wx.navigateTo({ url: '/pages/legal/index?type=thirdparty' });
  },

  // ---------- 账号 ----------
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
  }
});
