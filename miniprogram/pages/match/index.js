const data = require('../../services/data.js');

const TABS = [
  { key: 'friend', text: '约球友' },
  { key: 'coach', text: '约教练' },
  { key: 'table', text: '约球桌' }
];

// 今天起 7 天，供预约选择
function buildDateOptions() {
  const week = ['日', '一', '二', '三', '四', '五', '六'];
  const out = [];
  const now = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(now.getTime() + i * 86400000);
    const md = `${d.getMonth() + 1}月${d.getDate()}日`;
    const label = i === 0 ? `今天 ${md}` : i === 1 ? `明天 ${md}` : `周${week[d.getDay()]} ${md}`;
    out.push(label);
  }
  return out;
}

const TIME_OPTIONS = ['10:00', '12:00', '14:00', '16:00', '18:00', '20:00', '21:00'];

Page({
  data: {
    tabs: TABS,
    active: 'friend',
    loading: true,
    matches: [],
    coaches: [],
    tables: [],
    // 预约弹窗
    booking: null,
    dateOptions: buildDateOptions(),
    timeOptions: TIME_OPTIONS,
    dateIndex: 0,
    timeIndex: 4
  },

  onLoad() {
    this.loadAll();
  },

  onShow() {
    this.loadAll();
  },

  onPullDownRefresh() {
    this.loadAll().then(() => wx.stopPullDownRefresh());
  },

  loadAll() {
    this.setData({ loading: true });
    return Promise.all([
      data.getMatchPosts(),
      data.getBookableCoaches(),
      data.getBookableTables()
    ]).then(([matches, coaches, tables]) => {
      this.setData({ matches, coaches, tables, loading: false });
    });
  },

  switchTab(e) {
    const key = e.currentTarget.dataset.key;
    if (key !== this.data.active) this.setData({ active: key });
  },

  goMine() {
    wx.navigateTo({ url: '/pages/match/mine' });
  },

  // ---- 约球友 ----
  goPost() {
    wx.navigateTo({ url: '/pages/match/post' });
  },

  joinMatch(e) {
    const id = e.currentTarget.dataset.id;
    data.joinMatch(id).then((r) => {
      wx.showToast({ title: '报名成功', icon: 'success' });
      const matches = this.data.matches.map((m) =>
        m._id === id ? Object.assign({}, m, { joinCount: r.joinCount != null ? r.joinCount : (m.joinCount || 0) + 1 }) : m
      );
      this.setData({ matches });
    });
  },

  // ---- 预约弹窗（约教练 / 约球桌通用）----
  openCoachBooking(e) {
    const c = this.data.coaches[e.currentTarget.dataset.index];
    this.setData({
      booking: {
        type: 'coach',
        targetId: c.openid || c._openid || '',
        targetName: c.nickname || '教练',
        hallName: '',
        price: c.pricePerMinute || 0,
        priceLabel: c.pricePerMinute ? `${c.pricePerMinute} 元/分钟` : '面议'
      }
    });
  },

  openTableBooking(e) {
    const t = this.data.tables[e.currentTarget.dataset.index];
    this.setData({
      booking: {
        type: 'table',
        targetId: t._id,
        targetName: t.name,
        hallName: t.name,
        price: t.pricePerHour || 0,
        priceLabel: t.pricePerHour ? `${t.pricePerHour} 元/小时` : '面议'
      }
    });
  },

  closeBooking() {
    this.setData({ booking: null });
  },

  noop() {},

  onDateChange(e) {
    this.setData({ dateIndex: Number(e.detail.value) });
  },

  onTimeChange(e) {
    this.setData({ timeIndex: Number(e.detail.value) });
  },

  confirmBooking() {
    const b = this.data.booking;
    if (!b) return;
    const datetime = `${this.data.dateOptions[this.data.dateIndex]} ${this.data.timeOptions[this.data.timeIndex]}`;
    data
      .createBooking({
        type: b.type,
        targetId: b.targetId,
        targetName: b.targetName,
        hallName: b.hallName,
        datetime,
        price: b.price
      })
      .then(() => {
        this.setData({ booking: null });
        wx.showToast({ title: '预约已提交', icon: 'success' });
      });
  }
});
