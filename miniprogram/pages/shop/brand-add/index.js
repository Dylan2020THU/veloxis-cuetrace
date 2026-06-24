const data = require('../../../services/data');
const billing = require('../../../utils/billing');

Page({
  data: {
    step: 1,
    // 品牌
    brandName: '',
    brandLogo: '',
    // 门店
    storeName: '',
    storeAddress: '',
    storeLat: null,
    storeLng: null,
    checkinEnabled: false,
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

  // 地图选点：捕获门店经纬度（用于到店打卡核验与距离展示）
  chooseLocation() {
    wx.chooseLocation({
      success: (res) => {
        this.setData({
          storeLat: res.latitude,
          storeLng: res.longitude,
          storeAddress: res.address || this.data.storeAddress,
          storeName: this.data.storeName || res.name || ''
        });
      },
      fail: (err) => {
        const msg = (err && err.errMsg) || '';
        if (/auth|permission|deny/i.test(msg)) {
          wx.showToast({ title: '需要授权位置权限', icon: 'none' });
        }
      }
    });
  },

  // 到店打卡开关：开启需已订阅（启航版起）或试用期内
  onCheckinToggle(e) {
    const on = e.detail.value;
    if (!on) { this.setData({ checkinEnabled: false }); return; }
    if (billing.canUse('shop.checkin')) { this.setData({ checkinEnabled: true }); return; }
    // 还原开关，弹订阅墙；用户开通后再置真
    this.setData({ checkinEnabled: false });
    billing.requirePlan({ feature: 'shop.checkin', title: '到店打卡核验' }).then((ok) => {
      this.setData({ checkinEnabled: !!ok });
    });
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
        lat: this.data.storeLat,
        lng: this.data.storeLng,
        checkinEnabled: this.data.checkinEnabled,
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
