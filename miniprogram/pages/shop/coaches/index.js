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
    this.setData({ cloudReady: getApp().globalData.cloudReady });
    this.load();
  },

  load() {
    data.getShopStores().then((stores) => {
      const shop = data.getShopProfile() || Promise.resolve({});
      return Promise.all([stores, shop]);
    }).then(([stores, shop]) => {
      const currentStoreId = shop && shop.storeId ? shop.storeId : (stores.length ? stores[0]._id : '');
      const currentStore = stores.find((s) => s._id === currentStoreId) || {};
      this.setData({ stores, currentStoreId, currentStoreName: currentStore.name || '' });
      return data.getShopCoaches();
    }).then((coaches) => {
      const { currentStoreId } = this.data;
      const list = (coaches || [])
        .filter((c) => !currentStoreId || c.hallId === currentStoreId)
        .map((c) => Object.assign({}, c, { online: hashCode(c.openid || '') % 2 === 0 }));
      this.setData({ coaches: list });
    });
  },

  onStoreChange(e) {
    const idx = e.detail.value;
    const stores = this.data.stores;
    const store = stores[idx];
    this.setData({ currentStoreId: store._id, currentStoreName: store.name });
    data.getShopCoaches().then((coaches) => {
      const list = (coaches || [])
        .filter((c) => c.hallId === store._id)
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
