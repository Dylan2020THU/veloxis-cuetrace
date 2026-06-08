const data = require('../../../services/data');

Page({
  behaviors: [require('../../../utils/themeBehavior')],
  data: {
    loading: true,
    // 品牌数据
    shopBrands: [],
    hasBrand: false,
    // 概览
    storeCount: 0,
    coachCount: 0,
    memberCount: 0,
    totalHoursText: '0'
  },

  onShow() {
    if (wx.hideHomeButton) wx.hideHomeButton();
    this.load();
  },

  load() {
    this.setData({ loading: true });
    Promise.all([
      data.getShopBrands(),
      data.getShopStores(),
      data.getShopCoaches(),
      data.getShopMembers()
    ]).then(([brands, stores, coaches, members]) => {
      const hasBrand = brands.length > 0;
      const totalMinutes = members.reduce((s, m) => s + (m.totalMinutes || 0), 0);
      this.setData({
        loading: false,
        shopBrands: brands,
        hasBrand,
        storeCount: stores.length,
        coachCount: coaches.length,
        memberCount: members.length,
        totalHoursText: (totalMinutes / 60).toFixed(1)
      });
    });
  },

  goBrandAdd() {
    wx.navigateTo({ url: '/pages/shop/brand-add/index' });
  },

  goCoaches() {
    wx.navigateTo({ url: '/pages/shop/coaches/index' });
  },

  goMembers() {
    wx.navigateTo({ url: '/pages/shop/members/index' });
  },

  goTableTypes() {
    wx.navigateTo({ url: '/pages/shop/table-types/index' });
  },

  goHallStatus() {
    wx.navigateTo({ url: '/pages/shop/hall-status/index' });
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
        try {
          wx.removeStorageSync('dc_role');
        } catch (e) {}
        wx.reLaunch({ url: '/pages/login/index' });
      }
    });
  }
});
