const data = require('../../../services/data');
const billing = require('../../../utils/billing.js');

// 简单确定性 hash：用于演示阶段稳定地生成学员的「在练 / 在线」状态
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
    members: [],
    linkable: [],
    cloudReady: false,
    showAdd: false,
    memberCode: ''
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().refresh();
    }
    this.setData({ cloudReady: getApp().globalData.cloudReady });
    this.loadMembers();
  },

  loadMembers() {
    data.getMyMembers().then((members) => {
      // TODO: training（是否在练）/ online（是否在线）应由真实业务数据提供。
      // 当前为演示阶段：用 openid 确定性派生，便于查看底色与绿点效果。
      const list = (members || []).map((m) => {
        const h = hashCode(m.openid || '');
        return Object.assign({}, m, {
          training: h % 3 !== 0,
          online: h % 2 === 0
        });
      });
      this.setData({ members: list });
    });
  },

  openAdd() {
    billing
      .requirePlan({ feature: 'coach.memberMgmt', title: '学员管理' })
      .then((ok) => {
        if (!ok) return;
        data.getLinkableMembers().then((linkable) => {
          this.setData({ showAdd: true, linkable, memberCode: '' });
        });
      });
  },

  closeAdd() {
    this.setData({ showAdd: false });
  },

  noop() {},

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
    billing
      .requirePlan({ feature: 'coach.memberMgmt', title: '学员管理' })
      .then((ok) => {
        if (!ok) return;
        this.doLink(code);
      });
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
