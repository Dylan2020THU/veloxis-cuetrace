const data = require('../../../services/data');

Page({
  data: {
    step: 1,
    // 品牌
    brandName: '',
    brandLogo: '',
    // 门店
    storeName: '',
    storeAddress: '',
    tableTypes: [],
    // 编辑态
    editingIdx: -1,
    formName: '',
    formPrice: '',
    formImage: '',
    formBgColor: '#067ef9',
    // 提交
    submitting: false,
    colorPalette: ['#067ef9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#3b82f6', '#ec4899', '#14b8a6']
  },

  onLoad() {
    // 预先加载已有品牌
    data.getShopBrands().then((brands) => {
      if (brands.length > 0) {
        this.setData({ brandName: brands[0].name, brandLogo: brands[0].logo || '' });
      }
    });
  },

  onBrandNameInput(e) {
    this.setData({ brandName: e.detail.value });
  },

  onBrandLogoTap() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      success: (res) => {
        this.setData({ brandLogo: res.tempFiles[0].tempFilePath });
      }
    });
  },

  nextStep() {
    const { step } = this.data;
    if (step === 1 && !this.data.brandName.trim()) {
      return wx.showToast({ title: '请输入品牌名称', icon: 'none' });
    }
    this.setData({ step: step + 1 });
  },

  prevStep() {
    this.setData({ step: this.data.step - 1 });
  },

  onStoreNameInput(e) {
    this.setData({ storeName: e.detail.value });
  },

  onStoreAddressInput(e) {
    this.setData({ storeAddress: e.detail.value });
  },

  onNameInput(e) {
    this.setData({ formName: e.detail.value });
  },

  onPriceInput(e) {
    this.setData({ formPrice: e.detail.value });
  },

  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        this.setData({ formImage: res.tempFiles[0].tempFilePath });
      }
    });
  },

  chooseBgColor(e) {
    this.setData({ formBgColor: e.currentTarget.dataset.color });
  },

  editType(e) {
    const idx = e.currentTarget.dataset.idx;
    const t = this.data.tableTypes[idx];
    this.setData({
      editingIdx: idx,
      formName: t.name,
      formPrice: String(t.pricePerHour),
      formImage: t.image || '',
      formBgColor: t.bgColor || '#067ef9'
    });
  },

  removeType(e) {
    const idx = e.currentTarget.dataset.idx;
    const arr = this.data.tableTypes.slice();
    arr.splice(idx, 1);
    this.setData({ tableTypes: arr });
  },

  cancelEdit() {
    this.setData({ editingIdx: -1, formName: '', formPrice: '', formImage: '', formBgColor: '#067ef9' });
  },

  addOrUpdateType() {
    const { formName, formPrice, editingIdx } = this.data;
    if (!formName.trim()) return wx.showToast({ title: '请输入桌型名称', icon: 'none' });
    if (!formPrice || isNaN(Number(formPrice))) return wx.showToast({ title: '请输入有效价格', icon: 'none' });
    const arr = this.data.tableTypes.slice();
    const entry = {
      name: formName.trim(),
      pricePerHour: Number(formPrice),
      image: this.data.formImage,
      bgColor: this.data.formBgColor
    };
    if (editingIdx >= 0) {
      arr[editingIdx] = entry;
    } else {
      arr.push(entry);
    }
    this.setData({ tableTypes: arr, editingIdx: -1, formName: '', formPrice: '', formImage: '', formBgColor: '#067ef9' });
  },

  submit() {
    const { brandName, brandLogo, storeName, storeAddress, tableTypes, submitting } = this.data;
    if (submitting) return;
    if (!brandName.trim()) return wx.showToast({ title: '请填写品牌名称', icon: 'none' });
    if (!storeName.trim()) return wx.showToast({ title: '请填写门店名称', icon: 'none' });

    this.setData({ submitting: true });

    const brandId = `brand_${Date.now()}`;
    const storeId = `store_${Date.now()}`;

    Promise.resolve()
      .then(() => data.saveShopBrand({ _id: brandId, name: brandName.trim(), logo: brandLogo }))
      .then(() => data.saveShopStore({
        _id: storeId,
        brandId,
        name: storeName.trim(),
        address: storeAddress.trim(),
        tableTypes: tableTypes.length ? tableTypes : [
          { name: '乔氏金腿', pricePerHour: 78, bgColor: '#067ef9' },
          { name: '乔氏银腿', pricePerHour: 68, bgColor: '#3b82f6' }
        ]
      }))
      .then(() => data.saveShopProfile({ brandId, storeId, name: brandName.trim() }))
      .then(() => {
        wx.showToast({ title: '添加成功', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 1200);
      })
      .catch(() => {
        this.setData({ submitting: false });
        wx.showToast({ title: '保存失败', icon: 'none' });
      });
  }
});
