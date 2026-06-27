const data = require('../../../services/data');

Page({
  behaviors: [require('../../../utils/themeBehavior')],

  data: {
    loading: true,
    shopName: '我的球厅',
    logo: '',
    storeCount: 0,
    coachCount: 0,
    memberCount: 0,
    todayRevenue: '0',
    stores: []
  },

  onShow() {
    this.load();
  },

  load() {
    this.setData({ loading: true });
    Promise.all([
      data.getShopProfile(),
      data.getShopBrands().catch(() => []),
      data.getShopStores().catch(() => []),
      data.getShopCoaches().catch(() => []),
      data.getShopMembers().catch(() => []),
      data.getTodayShopRevenue().catch(() => 0)
    ]).then(([profile, brands, stores, coaches, members, revenue]) => {
      const brand = (brands && brands[0]) || {};
      const shopName = (profile && profile.name) || brand.name || '我的球厅';
      const list = (stores || []).map((s) => ({
        _id: s._id,
        name: s.name || '未命名门店',
        address: s.address || '未填写地址',
        businessHours: s.businessHours || '',
        tableTypeCount: (s.tableTypes && s.tableTypes.length) || 0
      }));
      this.setData({
        loading: false,
        shopName,
        logo: brand.logo || '',
        storeCount: list.length,
        coachCount: (coaches || []).length,
        memberCount: (members || []).length,
        todayRevenue: this._fmt(revenue),
        stores: list
      });
    }).catch((err) => {
      console.warn('[球厅主页] 加载失败', err);
      this.setData({ loading: false });
    });
  },

  // 金额格式化：四舍五入到元 + 千分位
  _fmt(v) {
    const n = Math.round(Number(v) || 0);
    return ('' + n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  },

  goEdit() {
    wx.navigateTo({ url: '/pages/shop/profile/edit/index' });
  },
  goStores() {
    wx.navigateTo({ url: '/pages/shop/brand-add/index' });
  },
  goTableTypes() {
    wx.switchTab({ url: '/pages/shop/table-types/index' });
  }
});
