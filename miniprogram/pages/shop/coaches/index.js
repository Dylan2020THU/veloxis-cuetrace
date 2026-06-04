const data = require('../../../services/data');

// 简单确定性 hash：演示阶段稳定生成教练的「在店 / 在线」状态
function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  return h;
}

Page({
  behaviors: [require('../../../utils/themeBehavior')],
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
    data.getShopCoaches().then((coaches) => {
      // TODO: online（是否在店/在线）应由真实业务数据提供。
      // 当前为演示阶段：用 openid 确定性派生，便于查看绿点效果。
      const list = (coaches || []).map((c) =>
        Object.assign({}, c, { online: hashCode(c.openid || '') % 2 === 0 })
      );
      this.setData({ coaches: list });
    });
  },

  // 点击教练，查看其给哪些球员上过课
  viewCoach(e) {
    const { openid, nickname } = e.currentTarget.dataset;
    wx.navigateTo({
      url: `/pages/shop/coach-students/index?openid=${encodeURIComponent(
        openid
      )}&nickname=${encodeURIComponent(nickname)}`
    });
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
