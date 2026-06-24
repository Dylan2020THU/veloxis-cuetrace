const data = require('../../../services/data');

Page({
  behaviors: [require('../../../utils/themeBehavior')],
  data: {
    store: null,
    qr: '',
    payload: '',
    loading: true
  },

  onLoad(options) {
    this._load((options && options.storeId) || '');
  },

  _load(storeId) {
    const p = storeId
      ? data.getStoreById(storeId)
      : data.getShopStores().then((ss) => (ss && ss[0]) || null);
    p.then((store) => {
      if (!store) { this.setData({ loading: false }); return; }
      this.setData({ store, payload: 's=' + store._id, loading: false });
      data.genStoreCheckinCode(store._id)
        .then((qr) => this.setData({ qr: qr || '' }))
        .catch(() => {});
    }).catch(() => this.setData({ loading: false }));
  },

  copyPayload() {
    wx.setClipboardData({
      data: this.data.payload,
      success: () => wx.showToast({ title: '已复制', icon: 'success' })
    });
  }
});
