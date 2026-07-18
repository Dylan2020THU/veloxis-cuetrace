const data = require('../../../services/data');

Page({
  data: {
    profile: {
      account: '',
      roleLabel: '',
      permissions: []
    }
  },

  onShow() {
    this.setData({ profile: data.getAdminProfile() });
  },

  goAdminTab(e) {
    const url = e.currentTarget.dataset.url;
    if (!url || url === '/pages/admin/profile/index') return;
    wx.reLaunch({ url });
  },

  logout() {
    data.logoutAdmin();
    wx.reLaunch({ url: '/pages/login/index' });
  }
});
