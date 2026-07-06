const data = require('../../services/data');
const mock = require('../../utils/mock');

// 账户区入口文案：店主端按「球厅」口吻，其余沿用「个人 / 我的」
const ACCOUNT_LABELS = {
  shop: { profile: '球厅主页', edit: '编辑球厅信息', qr: '球厅二维码' },
  coach: { profile: '个人主页', edit: '编辑教练资料', qr: '我的二维码' },
  default: { profile: '个人主页', edit: '编辑我的信息', qr: '我的二维码' }
};

const DELETE_REASONS = ['不再使用', '功能不好用', '隐私/数据顾虑', '换账号', '其他原因'];

Page({
  behaviors: [require('../../utils/themeBehavior')],

  data: {
    // 个人主页跳转需要昵称
    nickname: '大川会员',
    // 本地缓存大小
    cacheText: '',
    // 账户区入口文案（按角色：店主→球厅口吻）
    profileLabel: '个人主页',
    editLabel: '编辑我的信息',
    qrLabel: '我的二维码',
    // 系统管理员：显示「店主资质审核」入口
    isAdmin: false
  },

  onShow() {
    const app = getApp();
    const profile = app.globalData.userProfile;
    const labels = ACCOUNT_LABELS[mock.getRole()] || ACCOUNT_LABELS.default;
    this.setData({
      nickname: (profile && profile.nickname) || '大川会员',
      profileLabel: labels.profile,
      editLabel: labels.edit,
      qrLabel: labels.qr,
      isAdmin: false
    });
    this.refreshCacheSize();
    this.refreshAdminStatus();
  },

  refreshAdminStatus() {
    data
      .getAdminStatus()
      .then((r) => this.setData({ isAdmin: !!(r && r.isAdmin) }))
      .catch(() => this.setData({ isAdmin: false }));
  },

  // ---------- 账户 ----------
  goAccountSecurity() {
    wx.navigateTo({ url: '/pages/settings/account-security/index' });
  },
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
    // 店主端走专属「编辑球厅信息」；教练端走「编辑教练资料」；球员沿用编辑我的信息
    if (mock.getRole() === 'shop') {
      wx.navigateTo({ url: '/pages/shop/profile/edit/index' });
      return;
    }
    if (mock.getRole() === 'coach') {
      wx.navigateTo({ url: '/pages/coach/profile/index' });
      return;
    }
    wx.navigateTo({ url: '/pages/player/profile/edit/index' });
  },
  // 我的二维码（账号编码的二维码版，供不同端互扫识别）
  goMyQrcode() {
    wx.navigateTo({ url: '/pages/profile/qrcode/index' });
  },

  // 系统管理员：进入店主资质审核
  goShopReview() {
    wx.navigateTo({ url: '/pages/shop/admin/review/index' });
  },

  // ---------- 通用 ----------
  // 统计本地缓存大小
  refreshCacheSize() {
    try {
      const info = wx.getStorageInfoSync();
      this.setData({ cacheText: (info.currentSize || 0) + ' KB' });
    } catch (e) {
      this.setData({ cacheText: '' });
    }
  },

  // 清理缓存：清除本地缓存，但保留登录身份
  clearCache() {
    wx.showModal({
      title: '清理缓存',
      content: '将清除本地缓存数据（不会退出登录），确定？',
      confirmText: '清理',
      success: (res) => {
        if (!res.confirm) return;
        const keep = { dc_role: 1 };
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
  // 账号注销：先调研原因，再进入 7 天保留期。
  deleteAccount() {
    wx.showActionSheet({
      itemList: DELETE_REASONS,
      success: (picked) => {
        const reason = DELETE_REASONS[picked.tapIndex] || '其他原因';
        wx.showModal({
          title: '申请注销账号',
          content: `注销原因：${reason}\n\n账号将进入 7 天保留期，期间重新登录将中止注销流程。7 天后将删除你的训练记录、社区内容、约球与预约等数据。`,
          confirmText: '申请注销',
          confirmColor: '#e54545',
          success: (res) => {
            if (!res.confirm) return;
            wx.showLoading({ title: '处理中', mask: true });
            data.deleteAccount({ reason }).then(() => {
              try { wx.removeStorageSync('dc_role'); } catch (e) {}
              const app = getApp();
              if (app && app.globalData) {
                app.globalData.openid = '';
                app.globalData.role = '';
                app.globalData.userProfile = null;
              }
              wx.hideLoading();
              wx.showModal({
                title: '已申请注销',
                content: '账号将在 7 天后完成注销。期间重新登录将中止注销流程。',
                showCancel: false,
                confirmText: '知道了',
                success: () => wx.reLaunch({ url: '/pages/login/index' })
              });
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
