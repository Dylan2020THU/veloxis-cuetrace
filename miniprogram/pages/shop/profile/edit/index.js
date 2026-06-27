const data = require('../../../../services/data');

Page({
  behaviors: [require('../../../../utils/themeBehavior')],

  data: {
    loading: true,
    hasStore: false,
    brandId: '',
    storeId: '',
    shopName: '',
    logo: '',
    storeName: '',
    address: '',
    lat: null,
    lng: null,
    businessHours: '',
    intro: '',
    submitting: false
  },

  onLoad() {
    this.load();
  },

  load() {
    Promise.all([
      data.getShopProfile(),
      data.getShopBrands().catch(() => []),
      data.getShopStores().catch(() => [])
    ]).then(([profile, brands, stores]) => {
      const brand = (brands && brands[0]) || {};
      const store = (stores || []).find((s) => profile && s._id === profile.storeId) || (stores || [])[0] || null;
      this.setData({
        loading: false,
        hasStore: !!store,
        brandId: brand._id || (profile && profile.brandId) || '',
        storeId: store ? store._id : '',
        shopName: (profile && profile.name) || brand.name || '',
        logo: brand.logo || '',
        storeName: store ? (store.name || '') : '',
        address: store ? (store.address || '') : '',
        lat: store && typeof store.lat === 'number' ? store.lat : null,
        lng: store && typeof store.lng === 'number' ? store.lng : null,
        businessHours: store ? (store.businessHours || '') : '',
        intro: store ? (store.intro || '') : ''
      });
    }).catch((err) => {
      console.warn('[编辑球厅信息] 加载失败', err);
      this.setData({ loading: false });
    });
  },

  onShopNameInput(e) { this.setData({ shopName: e.detail.value }); },
  onStoreNameInput(e) { this.setData({ storeName: e.detail.value }); },
  onAddressInput(e) { this.setData({ address: e.detail.value }); },
  onHoursInput(e) { this.setData({ businessHours: e.detail.value }); },
  onIntroInput(e) { this.setData({ intro: e.detail.value }); },

  chooseLogo() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      success: (res) => {
        const p = res.tempFiles[0].tempFilePath;
        wx.showLoading({ title: '上传中' });
        data.uploadImage(p).then((url) => this.setData({ logo: url })).finally(() => wx.hideLoading());
      }
    });
  },

  // 地图选点：捕获门店经纬度（到店打卡核验与距离展示用）
  chooseLocation() {
    wx.chooseLocation({
      success: (res) => {
        this.setData({
          lat: res.latitude,
          lng: res.longitude,
          address: res.address || this.data.address,
          storeName: this.data.storeName || res.name || ''
        });
      },
      fail: (err) => {
        const m = (err && err.errMsg) || '';
        if (/auth|permission|deny/i.test(m)) wx.showToast({ title: '需要授权位置权限', icon: 'none' });
      }
    });
  },

  goTableTypes() {
    wx.switchTab({ url: '/pages/shop/table-types/index' });
  },
  goCreateStore() {
    wx.navigateTo({ url: '/pages/shop/brand-add/index' });
  },

  save() {
    if (this.data.submitting) return;
    const shopName = (this.data.shopName || '').trim();
    if (!shopName) return wx.showToast({ title: '请输入球厅名称', icon: 'none' });
    if (!this.data.hasStore) return wx.showToast({ title: '请先在门店管理创建门店', icon: 'none' });
    const storeName = (this.data.storeName || '').trim();
    if (!storeName) return wx.showToast({ title: '请输入门店名称', icon: 'none' });

    this.setData({ submitting: true });
    const brandId = this.data.brandId || `brand_${Date.now()}`;
    Promise.resolve()
      .then(() => data.saveShopBrand({ _id: brandId, name: shopName, logo: this.data.logo }))
      .then(() => data.saveShopStore({
        _id: this.data.storeId,
        brandId,
        name: storeName,
        address: (this.data.address || '').trim(),
        lat: this.data.lat,
        lng: this.data.lng,
        businessHours: (this.data.businessHours || '').trim(),
        intro: (this.data.intro || '').trim()
      }))
      .then(() => data.saveShopProfile({ name: shopName, brandId, storeId: this.data.storeId }))
      .then(() => {
        wx.showToast({ title: '保存成功', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 1200);
      })
      .catch((err) => {
        console.warn('[编辑球厅信息] 保存失败', err);
        this.setData({ submitting: false });
        wx.showToast({ title: '保存失败', icon: 'none' });
      });
  }
});
