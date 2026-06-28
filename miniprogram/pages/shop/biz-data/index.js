const data = require('../../../services/data');

const RANGES = [{ key: 7, label: '近7天' }, { key: 30, label: '近30天' }];

Page({
  behaviors: [require('../../../utils/themeBehavior')],
  data: {
    ranges: RANGES,
    rangeDays: 7,
    loading: true,
    today: { revenue: 0, opens: 0, activeMembers: 0, lessons: 0 },
    range: { revenue: 0, opens: 0, activeMembers: 0, lessons: 0 },
    bars: [],
    tip: ''
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().refresh();
    this.load();
  },

  load() {
    this.setData({ loading: true });
    data.getShopBizOverview(this.data.rangeDays).then((r) => {
      r = r || { today: {}, range: {}, trend: [] };
      const trend = r.trend || [];
      const max = trend.reduce((m, t) => Math.max(m, t.revenue || 0), 0);
      const bars = trend.map((t) => ({
        date: t.date,
        revenue: t.revenue || 0,
        h: max > 0 ? Math.max(t.revenue > 0 ? 4 : 0, Math.round((t.revenue || 0) / max * 100)) : 0,
        md: t.date.slice(5).replace('-', '/')
      }));
      this.setData({ loading: false, today: r.today || {}, range: r.range || {}, bars, tip: '' });
    }).catch(() => this.setData({ loading: false }));
  },

  onRange(e) {
    const rangeDays = Number(e.currentTarget.dataset.key);
    if (rangeDays === this.data.rangeDays) return;
    this.setData({ rangeDays, tip: '' });
    this.load();
  },

  onBar(e) {
    const i = e.currentTarget.dataset.i;
    const b = this.data.bars[i];
    if (b) this.setData({ tip: `${b.md} · ¥${b.revenue}` });
  }
});
