const data = require('../../../services/data');

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
    coachCode: '',
    stores: [],
    currentStoreId: '',
    currentStoreName: ''
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().refresh();
    }
    this.setData({ cloudReady: getApp().globalData.cloudReady });
    this.load();
  },

  load() {
    data.getShopStores().then((stores) => {
      const shop = data.getShopProfile() || Promise.resolve({});
      return Promise.all([stores, shop]);
    }).then(([stores, shop]) => {
      const fallbackStoreId = (stores.length ? stores[0]._id : (shop.storeId || ''));
      const currentStore = stores.find((s) => s._id === fallbackStoreId) || {};
      this.setData({ stores, currentStoreId: fallbackStoreId, currentStoreName: currentStore.name || '' });
      const capturedStoreId = fallbackStoreId;
      return data.getShopCoaches().then((coaches) => {
        const list = (coaches || [])
          .filter((c) => !capturedStoreId || c.hallId === capturedStoreId)
          .map((c) => Object.assign({}, c, { online: hashCode(c.openid || '') % 2 === 0 }));
        this.setData({ coaches: list });
      });
    });
  },

  onStoreChange(e) {
    const idx = e.detail.value;
    const stores = this.data.stores;
    const store = stores[idx];
    const newStoreId = store._id;
    this.setData({ currentStoreId: newStoreId, currentStoreName: store.name });
    data.getShopCoaches().then((coaches) => {
      const list = (coaches || [])
        .filter((c) => c.hallId === newStoreId)
        .map((c) => Object.assign({}, c, { online: hashCode(c.openid || '') % 2 === 0 }));
      this.setData({ coaches: list });
    });
  },

  // 点击教练，查看其给哪些球员上过课
  viewCoach(e) {
    const { openid, nickname } = e.currentTarget.dataset;
    wx.navigateTo({
      url: `/pages/shop/coach-students/index?openid=${encodeURIComponent(
        openid
      )}&nickname=${encodeURIComponent(nickname)}&storeId=${encodeURIComponent(this.data.currentStoreId)}`
    });
  },

  openAdd() {
    data.getLinkableCoaches().then((linkable) => {
      const { currentStoreId } = this.data;
      const filtered = linkable.filter((c) => !currentStoreId || c.hallId === currentStoreId);
      this.setData({ showAdd: true, linkable: filtered, coachCode: '' });
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

  // 扫码添加：扫教练出示的「我的二维码」，解析后加入本店
  scanAdd() {
    wx.scanCode({
      onlyFromCamera: false,
      success: (res) => {
        data.resolveAccount(res.result).then((acc) => {
          if (!acc || !acc.openid) {
            wx.showToast({ title: '未识别的二维码', icon: 'none' });
            return;
          }
          if (acc.role && acc.role !== 'coach') {
            wx.showToast({ title: '请扫描教练的二维码', icon: 'none' });
            return;
          }
          this.doAdd(acc.openid);
        });
      },
      fail: () => {}
    });
  },

  doAdd(coachOpenid) {
    data.addShopCoach(coachOpenid).then((r) => {
      if (r && r.ok === false) {
        wx.showToast({ title: r.msg || '添加失败', icon: 'none' });
        return;
      }
      wx.showToast({ title: '已添加', icon: 'success' });
      this.setData({ showAdd: false });
      this.load();
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
          this.load();
        });
      }
    });
  }
});
