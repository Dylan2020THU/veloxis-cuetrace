const data = require('../../services/data');

const VALID_ROLES = ['member', 'coach', 'shop'];

// 账户区入口文案：店主端按「球厅」口吻，其余沿用「个人 / 我的」
const ACCOUNT_LABELS = {
  shop: { profile: '球厅主页', edit: '编辑球厅信息', qr: '球厅二维码' },
  coach: { profile: '个人主页', edit: '编辑教练资料', qr: '我的二维码' },
  default: { profile: '个人主页', edit: '编辑我的信息', qr: '我的二维码' }
};

const DELETE_REASONS = ['不再使用', '功能不好用', '隐私/数据顾虑', '换账号', '其他原因'];

function currentRole() {
  const app = getApp();
  const role = app && app.globalData && (app.globalData.currentRole || app.globalData.role);
  return VALID_ROLES.indexOf(role) !== -1 ? role : 'member';
}

function canApplyCoach() {
  return currentRole() === 'member';
}

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
    isAdmin: false,
    canApplyCoach: false,
    loggingOut: false
  },

  onLoad() {
    this._active = true;
    this._disposed = false;
    this._loggingOut = false;
    this._logoutPromptOpen = false;
    this._logoutRequestSequence = 0;
    this._activeLogoutRequestId = 0;
  },

  onShow() {
    this._active = true;
    this._logoutPromptOpen = false;
    const app = getApp();
    const profile = app.globalData.userProfile;
    const labels = ACCOUNT_LABELS[currentRole()] || ACCOUNT_LABELS.default;
    this.setData({
      nickname: (profile && profile.nickname) || '大川会员',
      profileLabel: labels.profile,
      editLabel: labels.edit,
      qrLabel: labels.qr,
      isAdmin: false,
      canApplyCoach: false
    });
    this.refreshCacheSize();
    this.refreshAdminStatus();
    this.refreshCoachApplyEntry(profile);
  },

  refreshAdminStatus() {
    data
      .getAdminStatus()
      .then((r) => this.setData({ isAdmin: !!(r && r.isAdmin) }))
      .catch(() => this.setData({ isAdmin: false }));
  },

  refreshCoachApplyEntry(profile) {
    if (!canApplyCoach(profile)) {
      this.setData({ canApplyCoach: false });
      return;
    }
    data.getMyCoachShopBindingStatus()
      .then((r) => this.setData({ canApplyCoach: ((r && r.status) || 'none') !== 'approved' }))
      .catch(() => this.setData({ canApplyCoach: true }));
  },

  // ---------- 账户 ----------
  goAccountSecurity() {
    wx.navigateTo({ url: '/pages/settings/account-security/index' });
  },
  goMyProfile() {
    // 店主端走专属「球厅主页」；球员/教练沿用个人主页
    if (currentRole() === 'shop') {
      wx.navigateTo({ url: '/pages/shop/profile/index' });
      return;
    }
    const nickname = encodeURIComponent(this.data.nickname || '');
    wx.navigateTo({ url: `/pages/player/profile/index?isCurrentUser=1&nickname=${nickname}` });
  },
  goEditProfile() {
    // 店主端走专属「编辑球厅信息」；教练端走「编辑教练资料」；球员沿用编辑我的信息
    if (currentRole() === 'shop') {
      wx.navigateTo({ url: '/pages/shop/profile/edit/index' });
      return;
    }
    if (currentRole() === 'coach') {
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

  goBecomeCoach() {
    wx.navigateTo({ url: '/pages/coach/apply/index' });
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
        const keep = new Set([
          'cuetrace_auth_v2_session',
          'cuetrace_auth_v2_client',
          'cuetrace_auth_v2_migrated',
          'dc_theme_mode'
        ]);
        try {
          const info = wx.getStorageInfoSync();
          (info.keys || []).forEach((k) => {
            if (!keep.has(k)) wx.removeStorageSync(k);
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

  switchIdentity() {
    wx.reLaunch({ url: '/pages/login/index?switchRole=1' });
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
    if (
      this._disposed
      || this._active === false
      || this._loggingOut
      || this._logoutPromptOpen
    ) return;
    this._logoutPromptOpen = true;
    const modalGeneration = (this._logoutModalGeneration || 0) + 1;
    this._logoutModalGeneration = modalGeneration;
    wx.showModal({
      title: '退出账号',
      content: '确定要退出当前账号吗？',
      confirmText: '退出',
      confirmColor: '#e54545',
      success: (res) => {
        if (
          this._disposed
          || this._active === false
          || modalGeneration !== this._logoutModalGeneration
        ) return;
        this._logoutPromptOpen = false;
        if (!res.confirm) return;
        this._loggingOut = true;
        const requestId = (this._logoutRequestSequence || 0) + 1;
        this._logoutRequestSequence = requestId;
        this._activeLogoutRequestId = requestId;
        const generation = (this._logoutGeneration || 0) + 1;
        this._logoutGeneration = generation;
        this.setData({ loggingOut: true });
        data.logoutCurrentSession()
          .then(() => {
            if (!this.settleLogoutRequest(requestId) || !this.isCurrentLogout(generation)) return;
            this.setData({ loggingOut: false });
            const app = getApp();
            if (app && app.globalData) {
              app.globalData.openid = '';
              app.globalData.role = '';
              app.globalData.currentRole = '';
              app.globalData.roles = [];
              app.globalData.userProfile = null;
              app.globalData.authRolePickerRequired = false;
            }
            try {
              wx.removeStorageSync('dc_role');
            } catch (e) {}
            wx.reLaunch({ url: '/pages/login/index' });
          })
          .catch((error) => {
            if (!this.settleLogoutRequest(requestId) || !this.isCurrentLogout(generation)) return;
            this.setData({ loggingOut: false });
            if (error && error.code === 'AUTH_ATTEMPT_STALE') return;
            wx.showToast({ title: '退出失败，请稍后重试', icon: 'none' });
          });
      }
    });
  },

  settleLogoutRequest(requestId) {
    if (this._activeLogoutRequestId !== requestId) return false;
    this._activeLogoutRequestId = 0;
    this._loggingOut = false;
    return true;
  },

  isCurrentLogout(generation) {
    return !this._disposed && this._active !== false && generation === this._logoutGeneration;
  },

  deactivate() {
    this._active = false;
    this._logoutPromptOpen = false;
    this._logoutModalGeneration = (this._logoutModalGeneration || 0) + 1;
    this._logoutGeneration = (this._logoutGeneration || 0) + 1;
    this.setData({ loggingOut: false });
  },

  onHide() {
    this.deactivate();
  },

  onUnload() {
    this._disposed = true;
    this.deactivate();
  }
});
