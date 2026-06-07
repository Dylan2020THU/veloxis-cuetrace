const data = require('../../../services/data');

Page({
  behaviors: [require('../../../utils/themeBehavior')],
  data: {
    shop: null,
    loading: true,
    // 设置表单
    editing: false,
    halls: [],
    hallNames: [],
    hallIndex: 0,
    shopName: '',
    submitting: false,
    // 概览
    coachCount: 0,
    memberCount: 0,
    totalHoursText: '0'
  },

  onShow() {
    // 店主端首页为根页面，隐藏左上角默认的「返回首页」胶囊，保持左上角干净
    if (wx.hideHomeButton) wx.hideHomeButton();
    this.load();
  },

  load() {
    this.setData({ loading: true });
    data.getShopProfile().then((shop) => {
      if (!shop) {
        // 未设置店铺：进入设置态
        data.getHalls().then((halls) => {
          this.setData({
            loading: false,
            editing: true,
            halls,
            hallNames: halls.map((h) => h.name)
          });
        });
        return;
      }
      this.setData({ shop, loading: false, editing: false });
      this.loadOverview();
    });
  },

  loadOverview() {
    Promise.all([data.getShopCoaches(), data.getShopMembers()]).then(([coaches, members]) => {
      const totalMinutes = members.reduce((s, m) => s + (m.totalMinutes || 0), 0);
      this.setData({
        coachCount: coaches.length,
        memberCount: members.length,
        totalHoursText: (totalMinutes / 60).toFixed(1)
      });
    });
  },

  startEdit() {
    data.getHalls().then((halls) => {
      const idx = Math.max(
        0,
        halls.findIndex((h) => this.data.shop && h._id === this.data.shop.hallId)
      );
      this.setData({
        editing: true,
        halls,
        hallNames: halls.map((h) => h.name),
        hallIndex: idx,
        shopName: (this.data.shop && this.data.shop.name) || ''
      });
    });
  },

  onNameInput(e) {
    this.setData({ shopName: e.detail.value });
  },

  onHallChange(e) {
    this.setData({ hallIndex: Number(e.detail.value) });
  },

  saveShop() {
    if (this.data.submitting) return;
    const { shopName, halls, hallIndex } = this.data;
    if (!shopName) {
      wx.showToast({ title: '请填写店铺名称', icon: 'none' });
      return;
    }
    if (!halls.length) {
      wx.showToast({ title: '暂无可选台球厅', icon: 'none' });
      return;
    }
    const hall = halls[hallIndex];
    const existingTableTypes = (this.data.shop && this.data.shop.tableTypes) || [];
    this.setData({ submitting: true });
    data
      .saveShopProfile({
        name: shopName,
        hallId: hall._id,
        hallName: hall.name,
        tableTypes: existingTableTypes
      })
      .then(() => {
        wx.showToast({ title: '已保存', icon: 'success' });
        this.setData({ editing: false });
        this.load();
      })
      .catch((err) => {
        console.error('保存店铺失败', err);
        wx.showToast({ title: '保存失败', icon: 'none' });
      })
      .finally(() => this.setData({ submitting: false }));
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
