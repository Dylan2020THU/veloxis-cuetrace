const data = require('../../../services/data');

Page({
  data: {
    coaches: [],
    linkable: [],
    cloudReady: false,
    showAdd: false,
    coachCode: ''
  },

  onShow() {
    this.setData({ cloudReady: getApp().globalData.cloudReady });
    this.loadCoaches();
  },

  loadCoaches() {
    data.getShopCoaches().then((coaches) => this.setData({ coaches }));
  },

  openAdd() {
    data.getLinkableCoaches().then((linkable) => {
      this.setData({ showAdd: true, linkable, coachCode: '' });
    });
  },

  closeAdd() {
    this.setData({ showAdd: false });
  },

  onCodeInput(e) {
    this.setData({ coachCode: e.detail.value });
  },

  addDemo(e) {
    this.doAdd(e.currentTarget.dataset.openid);
  },

  addByCode() {
    const code = this.data.coachCode.trim();
    if (!code) {
      wx.showToast({ title: '请输入教练编码', icon: 'none' });
      return;
    }
    this.doAdd(code);
  },

  doAdd(coachOpenid) {
    data.addShopCoach(coachOpenid).then((r) => {
      if (r && r.ok === false) {
        wx.showToast({ title: r.msg || '添加失败', icon: 'none' });
        return;
      }
      wx.showToast({ title: '已添加', icon: 'success' });
      this.setData({ showAdd: false });
      this.loadCoaches();
    });
  },

  removeCoach(e) {
    const openid = e.currentTarget.dataset.openid;
    const nickname = e.currentTarget.dataset.nickname;
    wx.showModal({
      title: '移除教练',
      content: `确定将「${nickname}」移出本店管理？`,
      success: (res) => {
        if (!res.confirm) return;
        data.removeShopCoach(openid).then(() => {
          wx.showToast({ title: '已移除', icon: 'none' });
          this.loadCoaches();
        });
      }
    });
  }
});
