const data = require('../../../services/data');

Page({
  data: {
    members: [],
    linkable: [],
    cloudReady: false,
    showAdd: false,
    memberCode: ''
  },

  onShow() {
    this.setData({ cloudReady: getApp().globalData.cloudReady });
    this.loadMembers();
  },

  loadMembers() {
    data.getMyMembers().then((members) => this.setData({ members }));
  },

  openAdd() {
    data.getLinkableMembers().then((linkable) => {
      this.setData({ showAdd: true, linkable, memberCode: '' });
    });
  },

  closeAdd() {
    this.setData({ showAdd: false });
  },

  onCodeInput(e) {
    this.setData({ memberCode: e.detail.value });
  },

  // mock 模式：从候选会员中选择绑定
  linkDemo(e) {
    const openid = e.currentTarget.dataset.openid;
    this.doLink(openid);
  },

  // 云端模式：通过会员编码（openid）绑定
  linkByCode() {
    const code = this.data.memberCode.trim();
    if (!code) {
      wx.showToast({ title: '请输入会员编码', icon: 'none' });
      return;
    }
    this.doLink(code);
  },

  doLink(memberOpenid) {
    data.linkMember(memberOpenid).then((r) => {
      if (r && r.ok === false) {
        wx.showToast({ title: r.msg || '绑定失败', icon: 'none' });
        return;
      }
      wx.showToast({ title: '绑定成功', icon: 'success' });
      this.setData({ showAdd: false });
      this.loadMembers();
    });
  },

  viewMember(e) {
    const { openid, nickname } = e.currentTarget.dataset;
    wx.navigateTo({
      url: `/pages/coach/member/index?openid=${encodeURIComponent(openid)}&nickname=${encodeURIComponent(nickname)}`
    });
  }
});
