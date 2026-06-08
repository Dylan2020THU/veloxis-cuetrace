const data = require('../../../services/data');

const TABLE_COLOR_PALETTE = [
  '#E54545', '#FF7A00', '#FFC100', '#34C759',
  '#00B4D8', '#5856D6', '#AF52DE', '#FF2D55'
];

function matchTableColor(name) {
  if (name.includes('金')) return '#C9A84C';
  if (name.includes('银')) return '#067EF9';
  return TABLE_COLOR_PALETTE[Math.floor(Math.random() * TABLE_COLOR_PALETTE.length)];
}

Page({
  behaviors: [require('../../../utils/themeBehavior')],
  data: {
    tableTypes: [],
    editingIdx: -1,
    formName: '',
    formPrice: '',
    formImage: '',
    formBgColor: '',
    colorPalette: [
      '#E54545', '#FF7A00', '#FFC100', '#C9A84C',
      '#34C759', '#067EF9', '#00B4D8', '#5856D6',
      '#AF52DE', '#FF2D55'
    ],
    submitting: false,
    uploading: false,
    stores: [],
    currentStoreId: '',
    currentStoreName: ''
  },

  onLoad() {
    this.loadShop();
  },

  loadShop() {
    Promise.all([data.getShopStores(), data.getShopProfile()]).then(([stores, shop]) => {
      const currentStoreId = (shop && shop.storeId) ? shop.storeId : (stores.length ? stores[0]._id : '');
      const currentStore = stores.find((s) => s._id === currentStoreId) || {};
      this.setData({ stores, currentStoreId, currentStoreName: currentStore.name || '' });
      return this._loadTableTypes(currentStoreId);
    });
  },

  _loadTableTypes(storeId) {
    if (storeId) {
      data.getStores(storeId).then((stores) => {
        const store = stores.find((s) => s._id === storeId);
        const types = (store && store.tableTypes) || [];
        const patched = types.map((t) =>
          t.bgColor ? t : Object.assign({}, t, { bgColor: matchTableColor(t.name) })
        );
        this.setData({ tableTypes: patched });
      });
    } else {
      data.getShopProfile().then((shop) => {
        const types = (shop && shop.tableTypes) || [];
        const patched = types.map((t) =>
          t.bgColor ? t : Object.assign({}, t, { bgColor: matchTableColor(t.name) })
        );
        this.setData({ tableTypes: patched });
      });
    }
  },

  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const tempFilePath = res.tempFiles[0].tempFilePath;
        this.setData({ uploading: true });
        data.uploadImage(tempFilePath).then((url) => {
          this.setData({ formImage: url, uploading: false });
        }).catch(() => {
          this.setData({ uploading: false });
          wx.showToast({ title: '图片上传失败', icon: 'none' });
        });
      }
    });
  },

  onNameInput(e) {
    this.setData({ formName: e.detail.value });
    this._syncDefaultBgColor(e.detail.value);
  },

  onPriceInput(e) {
    this.setData({ formPrice: e.detail.value });
  },

  _syncDefaultBgColor(name) {
    if (this.data.formBgColor) return;
    this.setData({ formBgColor: matchTableColor(name) });
  },

  chooseBgColor(e) {
    this.setData({ formBgColor: e.currentTarget.dataset.color });
  },

  addOrUpdateType() {
    const name = this.data.formName.trim();
    const price = Number(this.data.formPrice);
    if (!name) {
      wx.showToast({ title: '请输入桌型名称', icon: 'none' });
      return;
    }
    if (!price || price <= 0) {
      wx.showToast({ title: '请输入正确的价格', icon: 'none' });
      return;
    }
    const newType = {
      name,
      pricePerHour: price,
      image: this.data.formImage,
      bgColor: this.data.formBgColor || matchTableColor(name)
    };
    let tableTypes;
    if (this.data.editingIdx >= 0) {
      tableTypes = [...this.data.tableTypes];
      tableTypes[this.data.editingIdx] = newType;
    } else {
      if (this.data.tableTypes.some((t) => t.name === name)) {
        wx.showToast({ title: '该桌型已存在', icon: 'none' });
        return;
      }
      tableTypes = [...this.data.tableTypes, newType];
    }
    this.setData({ tableTypes, editingIdx: -1, formName: '', formPrice: '', formImage: '', formBgColor: '' });
  },

  editType(e) {
    const idx = e.currentTarget.dataset.idx;
    const t = this.data.tableTypes[idx];
    this.setData({
      editingIdx: idx,
      formName: t.name,
      formPrice: String(t.pricePerHour),
      formImage: t.image || '',
      formBgColor: t.bgColor || ''
    });
  },

  cancelEdit() {
    this.setData({ editingIdx: -1, formName: '', formPrice: '', formImage: '', formBgColor: '' });
  },

  removeType(e) {
    const idx = e.currentTarget.dataset.idx;
    const name = this.data.tableTypes[idx].name;
    wx.showModal({
      title: '删除桌型',
      content: `确定删除「${name}」吗？`,
      success: (res) => {
        if (!res.confirm) return;
        const tableTypes = this.data.tableTypes.filter((_, i) => i !== idx);
        this.setData({ tableTypes });
      }
    });
  },

  save() {
    if (this.data.submitting) return;
    if (!this.data.tableTypes.length) {
      wx.showToast({ title: '请至少添加一个桌型', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    const storeId = this.data.currentStoreId;
    data.getStores(storeId).then((stores) => {
      const store = stores.find((s) => s._id === storeId) || {};
      store.tableTypes = this.data.tableTypes;
      return data.saveShopStore(store);
    })
      .then(() => {
        if (getApp().globalData._shopCache) {
          getApp().globalData._shopCache.tableTypes = this.data.tableTypes;
        }
        wx.showToast({ title: '已保存', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 600);
      })
      .catch(() => {
        wx.showToast({ title: '保存失败', icon: 'none' });
      })
      .finally(() => this.setData({ submitting: false }));
  },

  onStoreChange(e) {
    const idx = e.detail.value;
    const store = this.data.stores[idx];
    this.setData({ currentStoreId: store._id, currentStoreName: store.name });
    this._loadTableTypes(store._id);
  }
});
