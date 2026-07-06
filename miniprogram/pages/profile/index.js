const mock = require('../../utils/mock');
const data = require('../../services/data');
const rank = require('../../utils/rank');
const billing = require('../../utils/billing.js');
const account = require('../../utils/account');

const ROLE_LABEL = { member: '会员', coach: '教练', shop: '店家' };
const DAY_MS = 24 * 60 * 60 * 1000;

// 经营工具九宫格图标（线性描边，CSS mask 渲染、颜色由样式控制；复用底栏同一技法）
const TOOL_SVG = {
  chart: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><line x1='3' y1='20' x2='21' y2='20'/><line x1='6' y1='20' x2='6' y2='14'/><line x1='12' y1='20' x2='12' y2='8'/><line x1='18' y1='20' x2='18' y2='11'/></svg>",
  users: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2'/><circle cx='9' cy='7' r='4'/><path d='M23 21v-2a4 4 0 0 0-3-3.87'/><path d='M16 3.13a4 4 0 0 1 0 7.75'/></svg>",
  wallet: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M3 8a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8z'/><path d='M3 8V6a2 2 0 0 1 2-2h11'/><circle cx='16.5' cy='13' r='1.2' fill='black' stroke='none'/></svg>",
  yuan: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='9'/><path d='M8.5 8l3.5 4 3.5-4'/><path d='M12 12v5'/><path d='M9.5 13.5h5'/></svg>",
  speaker: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M3 11v2l13 5V6L3 11z'/><path d='M16 8a4 4 0 0 1 0 8'/><path d='M6 14v3a2 2 0 0 0 4 0'/></svg>",
  star: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polygon points='12 3 14.6 8.6 21 9.3 16.2 13.6 17.6 20 12 16.7 6.4 20 7.8 13.6 3 9.3 9.4 8.6'/></svg>",
  store: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M4 4h16l1 5a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0z'/><path d='M5 11v9h14v-9'/><path d='M9 20v-5h6v5'/></svg>",
  pin: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M12 21s-6-5.2-6-10a6 6 0 0 1 12 0c0 4.8-6 10-6 10z'/><circle cx='12' cy='11' r='2.4'/></svg>"
};

function icon(name) {
  return 'data:image/svg+xml,' + encodeURIComponent(TOOL_SVG[name]).replace(/'/g, '%27');
}

// 经营工具：act 为路由动作（'soon' = 二期占位，点了 toast）；dot = 右上角"新功能"小点
const SHOP_TOOLS = [
  { label: '经营数据', icon: icon('chart'), act: 'bizData', dot: false },
  { label: '会员运营', icon: icon('users'), act: 'members', dot: false },
  { label: '教练结算', icon: icon('wallet'), act: 'coachSettle', dot: false },
  { label: '球桌定价', icon: icon('yuan'), act: 'tables', dot: false },
  { label: '营销推广', icon: icon('speaker'), act: 'soon', dot: true },
  { label: '评价管理', icon: icon('star'), act: 'soon', dot: true },
  { label: '店铺信息', icon: icon('store'), act: 'shopInfo', dot: false },
  { label: '门店管理', icon: icon('pin'), act: 'stores', dot: false }
];

Page({
  behaviors: [require('../../utils/themeBehavior')],

  data: {
    nickname: '大川会员',
    avatar: '',
    role: 'member',
    roleLabel: '会员',
    isCoach: false,
    isShop: false,
    // 账号编码（由 openid 确定性派生，跨端扫码/手输识别用）
    accountCode: '',
    // 训练统计（球员 / 教练）
    summary: { totalDays: 0, totalHoursText: '0.0', streak: 0 },
    // 约球计数：我发起 / 我参与 / 约教练 / 约球桌
    matchCounts: { posted: 0, joined: 0, coach: 0, table: 0 },
    // 店主商家中心
    shopTools: SHOP_TOOLS,
    shop: {
      hasBrand: false,
      // 概览（会员数为真实；今日营业额/开台/在台需营收&实时占用建模，暂为 0）
      memberCount: 0,
      storeCount: 0,
      coachCount: 0,
      todayRevenue: '0',
      todayOpens: 0,
      occupied: 0,
      // 资金（二期，暂为占位 0）
      withdrawable: '0.00',
      pending: '0.00',
      // 计费
      plan: 'free',
      trialDays: 0,
      bannerMode: 'expired', // trial / active / expired
      planRemainDays: 0
    }
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().refresh();
    }
    const app = getApp();
    const role = mock.getRole();
    const profile = app.globalData.userProfile;
    const openid = (app.globalData && app.globalData.openid) || mock.MOCK_OPENID;
    this.setData({
      role,
      roleLabel: ROLE_LABEL[role] || '会员',
      isCoach: role === 'coach',
      isShop: role === 'shop',
      accountCode: account.codeOf(openid),
      nickname: (profile && profile.nickname) || '大川会员',
      avatar: (profile && profile.avatar) || ''
    });
    data.getUserProfile().then((user) => {
      if (!user) return;
      const nextRole = user.role || role;
      this.setData({
        nickname: user.nickname || '大川会员',
        avatar: user.avatar || '',
        role: nextRole,
        roleLabel: ROLE_LABEL[nextRole] || '会员',
        isCoach: nextRole === 'coach',
        isShop: nextRole === 'shop'
      });
    });
    if (role === 'shop') {
      this.loadShopData();
      this.loadBilling();
      this.loadTodayRevenue();
    } else {
      this.loadAchievement();
      this.loadMatchCounts();
    }
  },

  onHide() {
    if (this._revTimer) {
      clearInterval(this._revTimer);
      this._revTimer = null;
    }
  },

  // ---------- 球员 / 教练 ----------
  loadAchievement() {
    data.getMemberCheckins().then((stats) => {
      const summary = rank.summarize(stats);
      this.setData({ summary });
    }).catch((err) => {
      console.warn('[我的] 训练统计加载失败', err);
    });
  },

  loadMatchCounts() {
    Promise.all([
      data.getMyMatches().catch(() => []),
      data.getMyJoins().catch(() => []),
      data.getMyBookings().catch(() => [])
    ]).then(([matches, joins, bookings]) => {
      const list = bookings || [];
      this.setData({
        matchCounts: {
          posted: (matches || []).length,
          joined: (joins || []).length,
          coach: list.filter((b) => b.type === 'coach').length,
          table: list.filter((b) => b.type === 'table').length
        }
      });
    });
  },

  // ---------- 店主：商家中心 ----------
  // 经营概览（会员数真实；门店/教练备用；今日营业额/开台/在台 待二期建模，保持 0）
  loadShopData() {
    Promise.all([
      data.getShopBrands().catch(() => []),
      data.getShopStores().catch(() => []),
      data.getShopCoaches().catch(() => []),
      data.getShopMembers().catch(() => [])
    ]).then(([brands, stores, coaches, members]) => {
      this.setData({
        'shop.hasBrand': (brands || []).length > 0,
        'shop.storeCount': (stores || []).length,
        'shop.coachCount': (coaches || []).length,
        'shop.memberCount': (members || []).length
      });
    }).catch((err) => console.warn('[我的] 店主概览加载失败', err));
  },

  loadBilling() {
    data.getUserBilling().then((b) => {
      if (!b) return;
      const trialMs = b.trialRemainingMs || 0;
      const inTrial = billing.isInTrial();
      const hasActiveShop = billing.isPlanActive('shop_basic') || billing.isPlanActive('shop_pro');
      const planExpiresAt = billing.getPlanExpiry() || 0;
      const planRemainDays = (planExpiresAt && Date.now() < planExpiresAt)
        ? Math.max(0, Math.ceil((planExpiresAt - Date.now()) / DAY_MS))
        : 0;
      let bannerMode = 'expired';
      if (inTrial) bannerMode = 'trial';
      else if (hasActiveShop) bannerMode = 'active';
      this.setData({
        'shop.plan': b.plan || 'free',
        'shop.trialDays': trialMs > 0 ? Math.ceil(trialMs / DAY_MS) : 0,
        'shop.bannerMode': bannerMode,
        'shop.planRemainDays': planRemainDays
      });
    }).catch((err) => console.warn('[我的] 计费状态加载失败', err));
  },

  // 今日营收：拉取并以 count-up 滚动到新值
  loadTodayRevenue() {
    data.getTodayShopRevenue().then((total) => {
      this._rollRevenue(Number(total) || 0);
    }).catch((err) => console.warn('[我的] 今日营收加载失败', err));
  },

  // 数字滚动（easeOutCubic ~700ms）：从上次展示值滚到新值；增加时滚动，相等/减少直接置位
  _rollRevenue(to) {
    const app = getApp();
    const from = (app.globalData && app.globalData.shopRevenueShown) || 0;
    if (this._revTimer) {
      clearInterval(this._revTimer);
      this._revTimer = null;
    }
    if (to <= from) {
      this.setData({ 'shop.todayRevenue': this._fmtMoney(to) });
      if (app.globalData) app.globalData.shopRevenueShown = to;
      return;
    }
    const steps = 24;
    const dur = 700;
    let i = 0;
    this._revTimer = setInterval(() => {
      i += 1;
      const p = i / steps;
      const eased = 1 - Math.pow(1 - p, 3);
      const val = from + (to - from) * eased;
      this.setData({ 'shop.todayRevenue': this._fmtMoney(val) });
      if (i >= steps) {
        clearInterval(this._revTimer);
        this._revTimer = null;
        this.setData({ 'shop.todayRevenue': this._fmtMoney(to) });
        if (app.globalData) app.globalData.shopRevenueShown = to;
      }
    }, dur / steps);
  },

  // 金额格式化：四舍五入到元 + 千分位
  _fmtMoney(v) {
    const n = Math.round(Number(v) || 0);
    return ('' + n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  },

  // 续费/开通：弹店主版 paywall
  goRenew() {
    const app = getApp();
    const focusKey = (this.data.shop.plan && this.data.shop.plan !== 'free') ? this.data.shop.plan : 'shop_basic';
    app.paywall({ feature: '', planKey: focusKey, role: 'shop', multi: false, from: 'shop_me_renew' }, (ok) => {
      if (ok) this.loadBilling();
    });
  },

  // 经营工具九宫格分发
  onTool(e) {
    const act = e.currentTarget.dataset.act;
    switch (act) {
      case 'members':
        wx.switchTab({ url: '/pages/shop/members/index' });
        break;
      case 'tables':
        wx.switchTab({ url: '/pages/shop/table-types/index' });
        break;
      case 'stores':
        wx.navigateTo({ url: '/pages/shop/brand-add/index' });
        break;
      case 'shopInfo':
        wx.navigateTo({ url: '/pages/shop/profile/edit/index' });
        break;
      case 'bizData':
        this.goBizData();
        break;
      case 'coachSettle':
        billing.requirePlan({ feature: 'shop.coachSettle', title: '教练结算' }).then((ok) => {
          if (!ok) return;
          wx.navigateTo({ url: '/pages/shop/coach-settlement/index' });
        });
        break;
      default:
        this.comingSoon();
    }
  },

  // 经营数据看板（挂订阅墙：标准版起）
  goBizData() {
    billing.requirePlan({ feature: 'shop.report', title: '经营数据' }).then((ok) => {
      if (!ok) return;
      wx.navigateTo({ url: '/pages/shop/biz-data/index' });
    });
  },

  comingSoon() {
    wx.showToast({ title: '二期上线', icon: 'none' });
  },

  // ---------- 账号编码 ----------
  // 点击编码：复制到剪贴板，方便发给对方手动添加
  chooseAvatar() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        const tempPath = file && file.tempFilePath;
        if (!tempPath) return;
        wx.showLoading({ title: '上传中', mask: true });
        data
          .uploadImage(tempPath)
          .then((url) => data.getUserProfile().then((user) => {
            const profile = user || {};
            return data.saveUserProfile({
              role: profile.role || this.data.role,
              nickname: profile.nickname || this.data.nickname,
              avatar: url,
              gender: profile.gender || '',
              birthDate: profile.birthDate || '',
              phone: profile.phone || '',
              locationCity: profile.locationCity || '',
              hometown: Array.isArray(profile.hometown) ? profile.hometown : [],
              years: profile.years || '',
              level: profile.level || '',
              canSeeGender: profile.canSeeGender,
              canSeeBirthDate: profile.canSeeBirthDate,
              canSeeHometown: profile.canSeeHometown,
              canSeePhone: profile.canSeePhone
            }).then((r) => ({ r, url, profile }));
          }))
          .then(({ r, url, profile }) => {
            if (r && r.ok === false) {
              wx.showToast({ title: r.msg || '保存失败', icon: 'none' });
              return;
            }
            const app = getApp();
            if (app.globalData) {
              app.globalData.userProfile = Object.assign({}, profile, {
                role: profile.role || this.data.role,
                nickname: profile.nickname || this.data.nickname,
                avatar: url
              });
            }
            this.setData({ avatar: url });
            wx.showToast({ title: '头像已更新', icon: 'success' });
          })
          .catch((err) => {
            console.warn('[我的] 头像更新失败', err);
            wx.showToast({ title: '头像更新失败', icon: 'none' });
          })
          .finally(() => wx.hideLoading());
      }
    });
  },

  copyCode() {
    if (!this.data.accountCode) return;
    wx.setClipboardData({
      data: this.data.accountCode,
      success: () => wx.showToast({ title: '编码已复制', icon: 'success' })
    });
  },
  // 点击二维码图标：直接打开「我的二维码」
  goMyQrcode() {
    wx.navigateTo({ url: '/pages/profile/qrcode/index' });
  },

  // ---------- 导航 ----------
  goSettings() {
    wx.navigateTo({ url: '/pages/settings/index' });
  },
  goMatchMine() {
    wx.navigateTo({ url: '/pages/match/mine' });
  },
  goCheckin() {
    wx.switchTab({ url: '/pages/checkin/index' });
  },
  goCommunity() {
    wx.switchTab({ url: '/pages/community/index' });
  },
  goEditProfile() {
    wx.navigateTo({ url: '/pages/player/profile/edit/index' });
  },
  goCoachMembers() {
    wx.switchTab({ url: '/pages/coach/members/index' });
  },
  goCoachBookings() {
    wx.navigateTo({ url: '/pages/coach/bookings/index' });
  }
});
