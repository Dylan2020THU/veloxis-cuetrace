const data = require('../../../services/data');
const { formatDuration } = require('../../../utils/color');

// 简单确定性 hash：演示阶段稳定生成会员的「在线」状态
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
    loading: true,
    totalDays: 0,
    totalHoursText: '0',
    stores: [],
    currentStoreId: '',
    currentStoreName: '',
    // 添加会员弹层
    showAdd: false,
    memberCode: '',
    linkable: [],
    cloudReady: false
  },

  onLoad() {
    // tab 页：数据加载交给 onShow（每次切入刷新），避免与 onShow 重复请求
  },

  load() {
    this.setData({ loading: true });
    Promise.all([data.getShopStores(), data.getShopProfile()]).then(([stores, shop]) => {
      const currentStoreId = (shop && shop.storeId) ? shop.storeId : (stores.length ? stores[0]._id : '');
      const currentStore = stores.find((s) => s._id === currentStoreId) || {};
      this.setData({ stores, currentStoreId, currentStoreName: currentStore.name || '' });
      return data.getShopMembers(currentStoreId);
    }).then((list) => {
        let totalDays = 0;
        let totalMinutes = 0;
        const members = list.map((m) => {
          totalDays += m.checkinDays || 0;
          totalMinutes += m.totalMinutes || 0;
          return Object.assign({}, m, {
            durationText: formatDuration(m.totalMinutes),
            hoursText: (m.totalMinutes / 60).toFixed(1),
            // TODO: online（是否在线）应由真实业务数据提供；演示阶段用 openid 确定性派生
            online: hashCode(m.openid || '') % 2 === 0
          });
        });
        this.setData({
          members,
          loading: false,
          totalDays,
          totalHoursText: (totalMinutes / 60).toFixed(1)
        });
      })
      .catch((err) => {
        console.error('加载会员统计失败', err);
        this.setData({ loading: false });
      });
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().refresh();
    }
    this.setData({ cloudReady: getApp().globalData.cloudReady });
    this.load();
  },

  // ---------- 添加会员（扫码 / 输入编码） ----------
  openAdd() {
    const current = (this.data.members || []).map((m) => m.openid);
    data.getMembers().then((all) => {
      const linkable = (all || []).filter((m) => current.indexOf(m.openid) === -1);
      this.setData({ showAdd: true, memberCode: '', linkable });
    });
  },

  closeAdd() {
    this.setData({ showAdd: false });
  },

  noop() {},

  onCodeInput(e) {
    this.setData({ memberCode: e.detail.value });
  },

  // 输入会员编码添加
  addByCode() {
    const code = (this.data.memberCode || '').trim();
    if (!code) {
      wx.showToast({ title: '请输入会员编码', icon: 'none' });
      return;
    }
    data.resolveAccount(code).then((acc) => {
      if (!acc || !acc.openid) {
        wx.showToast({ title: '未找到该编码对应的会员', icon: 'none' });
        return;
      }
      if (acc.role && acc.role !== 'member') {
        wx.showToast({ title: '请输入会员编码', icon: 'none' });
        return;
      }
      this.doAdd(acc.openid);
    });
  },

  // 扫码添加：扫会员出示的「我的二维码」
  scanAdd() {
    wx.scanCode({
      onlyFromCamera: false,
      success: (res) => {
        data.resolveAccount(res.result).then((acc) => {
          if (!acc || !acc.openid) {
            wx.showToast({ title: '未识别的二维码', icon: 'none' });
            return;
          }
          if (acc.role && acc.role !== 'member') {
            wx.showToast({ title: '请扫描会员的二维码', icon: 'none' });
            return;
          }
          this.doAdd(acc.openid);
        });
      },
      fail: () => {}
    });
  },

  // 演示：从会员列表中选择添加
  addDemo(e) {
    this.doAdd(e.currentTarget.dataset.openid);
  },

  doAdd(memberOpenid) {
    data.addShopMember(memberOpenid, this.data.currentStoreId).then((r) => {
      if (r && r.ok === false) {
        wx.showToast({ title: r.msg || '添加失败', icon: 'none' });
        return;
      }
      wx.showToast({ title: '已添加', icon: 'success' });
      this.setData({ showAdd: false });
      this.load();
    });
  },

  onStoreChange(e) {
    const idx = e.detail.value;
    const stores = this.data.stores;
    const store = stores[idx];
    this.setData({ currentStoreId: store._id, currentStoreName: store.name });
    this.load();
  },

  // 点击会员名字，跳转至该会员的训练打卡页面
  viewMember(e) {
    const { openid, nickname } = e.currentTarget.dataset;
    wx.navigateTo({
      url: `/pages/coach/member/index?openid=${encodeURIComponent(
        openid
      )}&nickname=${encodeURIComponent(nickname)}`
    });
  }
});
