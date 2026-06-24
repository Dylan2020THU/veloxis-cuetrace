const mock = require('../../utils/mock');
const data = require('../../services/data');
const rank = require('../../utils/rank');

const ROLE_LABEL = { member: '会员', coach: '教练', shop: '店家' };

Page({
  behaviors: [require('../../utils/themeBehavior')],

  data: {
    nickname: '大川会员',
    avatar: '',
    role: 'member',
    roleLabel: '会员',
    isCoach: false,
    isShop: false,
    // 训练统计
    summary: { totalDays: 0, totalHoursText: '0.0', streak: 0 },
    // 约球计数：我发起 / 我参与 / 约教练 / 约球桌
    matchCounts: { posted: 0, joined: 0, coach: 0, table: 0 }
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().refresh();
    }
    const app = getApp();
    const role = mock.getRole();
    const profile = app.globalData.userProfile;
    this.setData({
      role,
      roleLabel: ROLE_LABEL[role] || '会员',
      isCoach: role === 'coach',
      isShop: role === 'shop',
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
    this.loadAchievement();
    this.loadMatchCounts();
  },

  // 训练统计（累计打卡天 / 累计时长 / 连续打卡天）
  loadAchievement() {
    data.getMemberCheckins().then((stats) => {
      const summary = rank.summarize(stats);
      this.setData({ summary });
    }).catch((err) => {
      console.warn('[我的] 训练统计加载失败', err);
    });
  },

  // 约球计数：我发起 / 我参与 / 约教练 / 约球桌
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

  // ---------- 导航 ----------
  // 齿轮：跳转到全屏「设置」页
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
  goCoachProfile() {
    wx.navigateTo({ url: '/pages/coach/profile/index' });
  },
  goCoachMembers() {
    wx.switchTab({ url: '/pages/coach/members/index' });
  },
  goCoachBookings() {
    wx.navigateTo({ url: '/pages/coach/bookings/index' });
  },
  goShopDashboard() {
    wx.navigateTo({ url: '/pages/shop/dashboard/index' });
  }
});
