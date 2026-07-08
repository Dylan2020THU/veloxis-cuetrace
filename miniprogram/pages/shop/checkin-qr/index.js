const data = require('../../../services/data');

Page({
  behaviors: [require('../../../utils/themeBehavior')],
  data: {
    store: null,
    tableId: '',
    tableName: '',
    qr: '',
    payload: '',
    loading: true
  },

  onLoad(options) {
    this._load((options && options.storeId) || '', (options && options.tableId) || '', (options && options.tableName) || '');
  },

  _load(storeId, tableId, tableName) {
    const p = storeId
      ? data.getStoreById(storeId)
      : data.getShopStores().then((ss) => (ss && ss[0]) || null);
    p.then((store) => {
      if (!store) { this.setData({ loading: false }); return; }
      const payload = tableId
        ? `s=${store._id}&t=${tableId}${tableName ? '&tn=' + encodeURIComponent(tableName) : ''}`
        : 's=' + store._id;
      this.setData({ store, tableId, tableName, payload, loading: false });
      data.genStoreCheckinCode(store._id, tableId, tableName)
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
