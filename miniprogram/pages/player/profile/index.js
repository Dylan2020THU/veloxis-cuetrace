const data = require('../../../services/data');

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
    loading: true
  },

  onLoad(query) {
    const openid = decodeURIComponent(query.openid || '');
    const nickname = decodeURIComponent(query.nickname || '');
    const isCoach = query.isCoach === '1';
    const isCurrentUser = query.isCurrentUser === '1';
    this.setData({ openid, nickname, isCoach, isCurrentUser });
    wx.setNavigationBarTitle({ title: nickname || '球员信息' });
    this.loadProfile(openid, isCoach, isCurrentUser);
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
