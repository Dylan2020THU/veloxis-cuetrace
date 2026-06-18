const data = require('../../../services/data');
const billing = require('../../../utils/billing.js');

const TRIAL_DAY_MS = 24 * 60 * 60 * 1000;

Page({
  behaviors: [require('../../../utils/themeBehavior')],
  data: {
    loading: true,
    // 品牌数据
    shopBrands: [],
    hasBrand: false,
    // 概览
    storeCount: 0,
    coachCount: 0,
    memberCount: 0,
    totalHoursText: '0',
    // 计费状态
    plan: 'free',
    trialDays: 0,
    bannerMode: 'expired', // 'trial' 试期内 / 'active' 已购有效 / 'expired' 试期外且未购
    planRemainDays: 0      // 已购有效时：剩余天数
  },

  onShow() {
    if (wx.hideHomeButton) wx.hideHomeButton();
    this.load();
    this.loadBilling();
  },

  // 加载计费状态（顶部 banner 用）
  // 三态：
  //   'trial'   试期内   → 展示"试用还剩 X 天"，banner 不可点
  //   'active'  已购有效 → 展示"会员剩余 X 天 · 点此续费"，banner 可点
  //   'expired' 试期外+未购 → 展示"试期已结束，去开通"，banner 可点
  loadBilling() {
    data.getUserBilling().then((b) => {
      if (!b) return;
      const planKey = b.plan || 'free';
      const trialMs = b.trialRemainingMs || 0;
      // getUserBilling 已把 planExpiresAt 同步到 globalData；billing.isPlanActive 直接读
      const inTrial = billing.isInTrial();
      const hasActiveShop = billing.isPlanActive('shop_basic') || billing.isPlanActive('shop_pro');
      const planExpiresAt = billing.getPlanExpiry() || 0;
      const planRemainDays = (planExpiresAt && Date.now() < planExpiresAt)
        ? Math.max(0, Math.ceil((planExpiresAt - Date.now()) / (24 * 60 * 60 * 1000)))
        : 0;
      let bannerMode = 'expired';
      if (inTrial) bannerMode = 'trial';
      else if (hasActiveShop) bannerMode = 'active';
      this.setData({
        plan: planKey,
        trialDays: trialMs > 0 ? Math.ceil(trialMs / TRIAL_DAY_MS) : 0,
        bannerMode,
        planRemainDays
      });
    }).catch((err) => {
      console.warn('[店主主控台] 拉取计费状态失败', err);
    });
  },

  // banner 统一入口：trial 模式不可点；active/expired 弹对应档位的 paywall
  onTapBanner() {
    if (this.data.bannerMode === 'trial') return;
    const app = getApp();
    // active 模式默认 focus 到当前已购档（续费同档），expired 模式给 shop_basic
    const focusKey = this.data.bannerMode === 'active' && this.data.plan !== 'free'
      ? this.data.plan
      : 'shop_basic';
    app.paywall({
      feature: '',
      planKey: focusKey,
      role: 'shop',
      multi: true,
      from: 'shop_dashboard_banner'
    }, (ok) => {
      if (ok) this.loadBilling();
    });
  },

  load() {
    this.setData({ loading: true });
    Promise.all([
      data.getShopBrands(),
      data.getShopStores(),
      data.getShopCoaches(),
      data.getShopMembers()
    ]).then(([brands, stores, coaches, members]) => {
      const hasBrand = brands.length > 0;
      const totalMinutes = members.reduce((s, m) => s + (m.totalMinutes || 0), 0);
      this.setData({
        loading: false,
        shopBrands: brands,
        hasBrand,
        storeCount: stores.length,
        coachCount: coaches.length,
        memberCount: members.length,
        totalHoursText: (totalMinutes / 60).toFixed(1)
      });
    });
  },

  goBrandAdd() {
    wx.navigateTo({ url: '/pages/shop/brand-add/index' });
  },

  goCoaches() {
    billing
      .requirePlan({ feature: 'shop.report', title: '教练与门店经营' })
      .then((ok) => {
        if (!ok) return;
        wx.navigateTo({ url: '/pages/shop/coaches/index' });
      });
  },

  goMembers() {
    billing
      .requirePlan({ feature: 'shop.memberMgmt', title: '会员管理' })
      .then((ok) => {
        if (!ok) return;
        wx.navigateTo({ url: '/pages/shop/members/index' });
      });
  },

  goTableTypes() {
    billing
      .requirePlan({ feature: 'shop.report', title: '桌型与价格管理' })
      .then((ok) => {
        if (!ok) return;
        wx.navigateTo({ url: '/pages/shop/table-types/index' });
      });
  },

  goHallStatus() {
    billing
      .requirePlan({ feature: 'shop.report', title: '球厅状态' })
      .then((ok) => {
        if (!ok) return;
        wx.navigateTo({ url: '/pages/shop/hall-status/index' });
      });
  },

  logout() {
    wx.showModal({
      title: '退出账号',
      content: '确定要退出当前账号吗？',
      confirmText: '退出',
      confirmColor: '#e54545',
      success: (res) => {
        if (!res.confirm) return;
        const app = getApp();
        if (app && app.globalData) app.globalData.openid = '';
        try {
          wx.removeStorageSync('dc_role');
        } catch (e) {}
        wx.reLaunch({ url: '/pages/login/index' });
      }
    });
  }
});
