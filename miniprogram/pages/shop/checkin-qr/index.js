const data = require('../../../services/data');

function decodeRouteOption(value) {
  try {
    return decodeURIComponent(value || '');
  } catch (e) {
    return value || '';
  }
}

Page({
  behaviors: [require('../../../utils/themeBehavior')],
  data: {
    store: null,
    tableId: '',
    tableName: '',
    qr: '',
    qrLoading: false,
    qrError: '',
    payload: '',
    loading: true
  },

  onLoad(options) {
    this._load(
      decodeRouteOption(options && options.storeId),
      decodeRouteOption(options && options.tableId),
      decodeRouteOption(options && options.tableName)
    );
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
      this.setData({ store, tableId, tableName, payload, loading: false, qrLoading: true, qrError: '' });
      data.genStoreCheckinCode(store._id, tableId, tableName)
        .then((qr) => this.setData({
          qr: qr || '',
          qrLoading: false,
          qrError: qr ? '' : '桌码生成失败，请确认 genCheckinCode 云函数已部署'
        }))
        .catch((error) => this.setData({
          qrLoading: false,
          qrError: (error && (error.errMsg || error.message)) || '桌码生成失败，请稍后重试'
        }));
    }).catch(() => this.setData({ loading: false }));
  },

  copyPayload() {
    wx.setClipboardData({
      data: this.data.payload,
      success: () => wx.showToast({ title: '已复制', icon: 'success' })
    });
  }
});
