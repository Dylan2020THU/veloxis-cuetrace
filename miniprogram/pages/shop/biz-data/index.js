const data = require('../../../services/data');

const RANGES = [{ key: 7, label: '近7天' }, { key: 30, label: '近30天' }];

function fixed(value) {
  const number = Number(value);
  return (Number.isFinite(number) ? number : 0).toFixed(2);
}

function fenToYuan(value) {
  const fen = Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return (fen / 100).toFixed(2);
}

function financeDisplay(report) {
  const source = report || {};
  const coverage = Number.isSafeInteger(source.platformCoverageBps)
    ? source.platformCoverageBps
    : 0;
  return {
    legacyRevenueYuan: fixed(source.legacyRevenueYuan),
    platformPaidYuan: fenToYuan(source.platformPaidFen),
    externalPaidYuan: fenToYuan(source.externalPaidFen),
    platformCoverage: (coverage / 100).toFixed(2) + '%',
    shopNetTargetYuan: fenToYuan(source.shopNetTargetFen),
    totalCostYuan: fenToYuan(source.totalCostFen),
    channelFeeYuan: fenToYuan(source.channelFeeFen),
    platformNetYuan: fenToYuan(source.platformNetFen),
    manualReviewYuan: fenToYuan(source.manualReviewFen)
  };
}

Page({
  behaviors: [require('../../../utils/themeBehavior')],
  data: {
    ranges: RANGES,
    rangeDays: 7,
    loading: true,
    today: { revenue: 0, opens: 0, activeMembers: 0, lessons: 0 },
    range: { revenue: 0, opens: 0, activeMembers: 0, lessons: 0 },
    todayFinance: financeDisplay(),
    rangeFinance: financeDisplay(),
    bars: [],
    tip: ''
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().refresh();
    this.load();
  },

  load() {
    const rangeDays = this.data.rangeDays;
    const generation = (this._loadGeneration || 0) + 1;
    this._loadGeneration = generation;
    this.setData({ loading: true });
    return data.getShopBizOverview(rangeDays).then((r) => {
      if (generation !== this._loadGeneration || this.data.rangeDays !== rangeDays) return;
      r = r || { today: {}, range: {}, trend: [] };
      const trend = r.trend || [];
      const max = trend.reduce((m, t) => Math.max(m, t.revenue || 0), 0);
      const bars = trend.map((t) => ({
        date: t.date,
        revenue: t.revenue || 0,
        h: max > 0 ? Math.max(t.revenue > 0 ? 4 : 0, Math.round((t.revenue || 0) / max * 100)) : 0,
        md: t.date.slice(5).replace('-', '/')
      }));
      this.setData({
        loading: false,
        today: r.today || {},
        range: r.range || {},
        todayFinance: financeDisplay(r.today),
        rangeFinance: financeDisplay(r.range),
        bars,
        tip: ''
      });
    }).catch(() => {
      if (generation === this._loadGeneration && this.data.rangeDays === rangeDays) {
        this.setData({ loading: false });
      }
    });
  },

  onRange(e) {
    const rangeDays = Number(e.currentTarget.dataset.key);
    if (rangeDays === this.data.rangeDays) return;
    this.setData({ rangeDays, tip: '' });
    return this.load();
  },

  onBar(e) {
    const i = e.currentTarget.dataset.i;
    const b = this.data.bars[i];
    if (b) this.setData({ tip: `${b.md} · ¥${b.revenue}` });
  }
});
