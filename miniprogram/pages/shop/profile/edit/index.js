const data = require('../../../../services/data');

Page({
  behaviors: [require('../../../../utils/themeBehavior')],

  data: {
    loading: true,
    hasStore: false,        // 是否已有可编辑的球厅（有独立门店记录 或 已有店铺资料）
    hasStoreRecord: false,  // 是否存在独立 stores 记录（无则保存时新建，回填 stores 集合）
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
    tableTypes: [],
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
      const prof = profile || {};
      const store = (stores || []).find((s) => s._id === prof.storeId) || (stores || [])[0] || null;
      // 云端 / 单店：无独立 stores 记录时，用店铺资料(shops)里的 hall 信息兜底，
      // 避免有店却被误判为"还没创建门店"。门店名取 hallName，桌型取资料里的 tableTypes。
      const hasShop = !!store || !!(prof.name || prof.hallName) || !!brand.name;
      this.setData({
        loading: false,
        hasStore: hasShop,
        hasStoreRecord: !!store,
        brandId: brand._id || prof.brandId || '',
        storeId: store ? store._id : '',
        shopName: prof.name || brand.name || '',
        logo: brand.logo || '',
        storeName: store ? (store.name || '') : (prof.hallName || ''),
        address: store ? (store.address || '') : '',
        lat: store && typeof store.lat === 'number' ? store.lat : null,
        lng: store && typeof store.lng === 'number' ? store.lng : null,
        businessHours: store ? (store.businessHours || '') : '',
        intro: store ? (store.intro || '') : '',
        tableTypes: store ? (store.tableTypes || []) : (prof.tableTypes || [])
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
    const storeName = (this.data.storeName || '').trim();
    if (!storeName) return wx.showToast({ title: '请输入门店名称', icon: 'none' });

    this.setData({ submitting: true });
    const brandId = this.data.brandId || `brand_${Date.now()}`;
    const storeId = this.data.storeId || `store_${Date.now()}`;
    const tableTypes = this.data.tableTypes || [];
    // 三处落库，各自容错（云端可能部分函数未部署，一处失败不影响其余）：
    // 1) shops 店铺资料：name + hallName(门店名) + tableTypes —— 云端 saveShopProfile 直接支持，立即生效并回显
    // 2) brands 品牌名 / logo
    // 3) stores 门店记录：补全 stores 集合（地址/营业时间/简介/桌型），多门店视图后续可用
    const safe = (p) => p.catch((e) => { console.warn('[编辑球厅信息] 局部保存失败', e); return null; });
    Promise.resolve()
      .then(() => safe(data.saveShopProfile({ name: shopName, hallName: storeName, tableTypes })))
      .then(() => safe(data.saveShopBrand({ _id: brandId, name: shopName, logo: this.data.logo })))
      .then(() => safe(data.saveShopStore({
        _id: storeId,
        brandId,
        name: storeName,
        address: (this.data.address || '').trim(),
        lat: this.data.lat,
        lng: this.data.lng,
        businessHours: (this.data.businessHours || '').trim(),
        intro: (this.data.intro || '').trim(),
        tableTypes
      })))
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
