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

const TIME_OPTIONS = ['00:00','01:00','02:00','03:00','04:00','05:00','06:00','07:00','08:00','09:00','10:00','11:00','12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00', '21:00', '22:00', '23:00'];

Page({
  behaviors: [require('../../utils/themeBehavior')],
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
    timeIndex: 4,
    tableTypeIndex: 0
  },

  onLoad() {
    this.loadAll();
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().refresh();
    }
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
      const tablesWithMin = tables.map((t) => {
        if (t.tableTypes && t.tableTypes.length) {
          const prices = t.tableTypes.map((tt) => tt.pricePerHour).filter((p) => p > 0);
          const min = prices.length ? Math.min(...prices) : 0;
          return Object.assign({}, t, { minPricePerHour: min || 0 });
        }
        return Object.assign({}, t, { minPricePerHour: t.pricePerHour || 0 });
      });
      this.setData({ matches, coaches, tables: tablesWithMin, loading: false });
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

  openDetail(e) {
    const id = e.currentTarget.dataset.id;
    console.log('[match] openDetail id:', id);
    if (!id) { console.warn('openDetail: id 为空'); return; }
    wx.navigateTo({ url: `/pages/match/detail/index?id=${encodeURIComponent(id)}` });
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
    const typeOptions = (t.tableTypes && t.tableTypes.length) ? t.tableTypes : [];
    const firstType = typeOptions[0] || {};
    this.setData({
      tableTypeIndex: 0,
      booking: {
        type: 'table',
        targetId: t._id,
        targetName: t.name,
        hallName: t.name,
        price: firstType.pricePerHour || t.pricePerHour || 0,
        priceLabel: firstType.pricePerHour ? `${firstType.pricePerHour} 元/小时` : '面议',
        tableTypeOptions: typeOptions,
        tableTypeIndex: 0
      }
    });
  },

  onTableTypeChange(e) {
    const idx = Number(e.detail.value);
    const opts = this.data.booking.tableTypeOptions;
    const selected = opts[idx] || {};
    this.setData({
      tableTypeIndex: idx,
      booking: Object.assign({}, this.data.booking, {
        tableTypeIndex: idx,
        price: selected.pricePerHour || 0,
        priceLabel: selected.pricePerHour ? `${selected.pricePerHour} 元/小时` : '面议'
      })
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
    const tableTypeOption = b.tableTypeOptions && b.tableTypeOptions[b.tableTypeIndex];
    const tableTypeName = tableTypeOption ? tableTypeOption.name : '';
    data
      .createBooking({
        type: b.type,
        targetId: b.targetId,
        targetName: b.targetName,
        hallName: b.hallName,
        datetime,
        price: b.price,
        tableType: tableTypeName
      })
      .then(() => {
        this.setData({ booking: null });
        wx.showToast({ title: '预约已提交', icon: 'success' });
      });
  }
});
