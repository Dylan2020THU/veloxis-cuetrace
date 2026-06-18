const data = require('../../../services/data');
const billing = require('../../../utils/billing');

const TRIAL_DAY_MS = 24 * 60 * 60 * 1000;

Page({
  behaviors: [require('../../../utils/themeBehavior')],

  data: {
    openid: '',
    nickname: '',
    avatar: '',
    isCoach: false,
    isCurrentUser: false,
    // 教练特有
    coachYears: '',
    intro: '',
    pricePerMinute: '',
    certificates: [],
    // 会员特有
    totalDays: 0,
    totalHoursText: '0',
    streak: 0,
    stats: [],
    loading: true,
    // 计费相关
    plan: 'free',
    planLabel: '免费版',
    trialRemaining: 0,
    trialDays: 0,
    // 三态 banner：
    //   'trial'   试期内   → "试期内，还剩 X 天"，banner 不可点
    //   'active'  已购有效 → "会员剩余 X 天 · 点此续费"，banner 可点
    //   'expired' 试期外+未购 → "试期已结束，去开通"，banner 可点
    bannerMode: 'expired',
    planRemainDays: 0
  },

  onLoad(query) {
    const openid = decodeURIComponent(query.openid || '');
    const nickname = decodeURIComponent(query.nickname || '');
    const isCoach = query.isCoach === '1';
    const isCurrentUser = query.isCurrentUser === '1';
    this.setData({ openid, nickname, isCoach, isCurrentUser });
    wx.setNavigationBarTitle({ title: nickname || '球员信息' });
    this.loadProfile(openid, isCoach, isCurrentUser);
    if (isCurrentUser) this.loadBilling();
  },

  // 加载当前用户计费状态（plan / 试期剩余 / 三态 banner）
  loadBilling() {
    data.getUserBilling().then((b) => {
      if (!b) return;
      const planKey = b.plan || 'free';
      const plan = billing.PLANS[planKey] || billing.PLANS.free;
      const trialMs = b.trialRemainingMs || 0;
      const inTrial = billing.isInTrial();
      const hasActiveMember = billing.isPlanActive('player_pro') || billing.isPlanActive('member_basic');
      const planExpiresAt = billing.getPlanExpiry() || 0;
      const planRemainDays = (planExpiresAt && Date.now() < planExpiresAt)
        ? Math.max(0, Math.ceil((planExpiresAt - Date.now()) / (24 * 60 * 60 * 1000)))
        : 0;
      let bannerMode = 'expired';
      if (inTrial) bannerMode = 'trial';
      else if (hasActiveMember) bannerMode = 'active';
      this.setData({
        plan: planKey,
        planLabel: plan.label || '免费版',
        trialRemaining: trialMs,
        trialDays: trialMs > 0 ? Math.ceil(trialMs / TRIAL_DAY_MS) : 0,
        bannerMode,
        planRemainDays
      });
    }).catch((err) => {
      console.warn('[球员主页] 拉取计费状态失败', err);
    });
  },

  // 主动开通：多端 tab 模式
  onOpenPaywall() {
    const app = getApp();
    // active 模式默认 focus 到当前已购档（续费同档），expired 模式给 player_pro
    const focusKey = this.data.bannerMode === 'active' && this.data.plan !== 'free'
      ? this.data.plan
      : 'player_pro';
    app.paywall({
      feature: '',
      planKey: focusKey,
      role: 'member',
      multi: true,
      from: 'player_profile'
    }, (ok) => {
      if (ok) this.loadBilling();
    });
  },

  // 顶部 banner 入口：trial 模式不响应；active/expired 弹 paywall
  onTapProfileBanner() {
    if (this.data.bannerMode === 'trial') return;
    this.onOpenPaywall();
  },

  // 模拟被拦场景：试期外体验付费功能 → 触发 feature 拦截
  onTryBlockedFeature() {
    const app = getApp();
    // 走 billing.requirePlan 验证拦截逻辑
    billing.requirePlan({
      feature: 'member.bookTable',
      role: 'member',
      title: '在线约球桌'
    }).then((ok) => {
      if (ok) {
        wx.showToast({ title: '已可使用', icon: 'success' });
      } else {
        // 用户中途关闭，不做处理
      }
    }).catch(() => {});
  },

  loadProfile(openid, isCoach, isCurrentUser) {
    if (isCurrentUser) {
      if (isCoach) {
        this.loadCurrentCoach();
      } else {
        this.loadCurrentMember();
      }
    } else {
      if (isCoach) {
        this.loadCoachProfile(openid);
      } else {
        this.loadMemberProfile(openid);
      }
    }
  },

  loadCurrentCoach() {
    data.getCoachProfile().then((p) => {
      if (!p) { this.setData({ loading: false }); return; }
      this.setData({
        nickname: p.nickname || this.data.nickname,
        avatar: p.avatar || '',
        coachYears: p.coachYears || '',
        intro: p.intro || '',
        pricePerMinute: p.pricePerMinute || '',
        certificates: p.certificates || [],
        loading: false
      });
    });
  },

  loadCurrentMember() {
    data.getUserProfile().then((u) => {
      if (u) this.setData({ nickname: u.nickname || this.data.nickname, avatar: u.avatar || '' });
      data.getMemberCheckins().then((stats) => {
        const summary = this._computeSummary(stats);
        this.setData({
          stats,
          totalDays: summary.totalDays,
          totalHoursText: summary.totalHoursText,
          streak: summary.streak,
          loading: false
        });
      }).catch(() => this.setData({ loading: false }));
    });
  },

  loadCoachProfile(openid) {
    data.getCoachProfileByOpenid(openid).then((p) => {
      if (!p) { this.setData({ loading: false }); return; }
      this.setData({
        nickname: p.nickname || this.data.nickname,
        avatar: p.avatar || '',
        coachYears: p.coachYears || '',
        intro: p.intro || '',
        pricePerMinute: p.pricePerMinute || '',
        certificates: p.certificates || [],
        loading: false
      });
    }).catch(() => this.setData({ loading: false }));
  },

  loadMemberProfile(openid) {
    data.getMemberProfileByOpenid(openid).then((m) => {
      if (m) this.setData({ nickname: m.nickname || this.data.nickname, avatar: m.avatar || '' });
      data.getMemberCheckinsByOpenid(openid).then((stats) => {
        const summary = this._computeSummary(stats);
        this.setData({
          stats,
          totalDays: summary.totalDays,
          totalHoursText: summary.totalHoursText,
          streak: summary.streak,
          loading: false
        });
      }).catch(() => this.setData({ loading: false }));
    }).catch(() => this.setData({ loading: false }));
  },

  _computeSummary(stats) {
    let totalMinutes = 0;
    const map = {};
    stats.forEach((s) => {
      totalMinutes += s.totalMinutes || 0;
      if (s.date) map[s.date] = true;
    });
    let streak = 0;
    const { addDays, today, toKey } = require('../../../utils/date');
    let cursor = today();
    while (map[toKey(cursor)]) {
      streak += 1;
      cursor = addDays(cursor, -1);
    }
    return {
      totalDays: stats.length,
      totalHoursText: (totalMinutes / 60).toFixed(1),
      streak
    };
  },

  onBack() {
    wx.navigateBack({ fail: () => wx.navigateTo({ url: '/pages/shop/hall-status/index' }) });
  }
});
