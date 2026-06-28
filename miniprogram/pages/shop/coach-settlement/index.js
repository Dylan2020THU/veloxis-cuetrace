const data = require('../../../services/data');

const PERIODS = [
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
  { key: 'all', label: '全部' }
];

Page({
  behaviors: [require('../../../utils/themeBehavior')],
  data: {
    periods: PERIODS,
    period: 'month',
    loading: true,
    totalPendingNet: 0,
    pendingCoachCount: 0,
    coaches: [],
    // 明细 sheet
    showDetail: false,
    detailTab: 'pending',
    detail: null,
    settling: false
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().refresh();
    this.load();
  },

  load() {
    this.setData({ loading: true });
    data.getShopCoachSettlement(this.data.period).then((r) => {
      r = r || { totalPendingNet: 0, pendingCoachCount: 0, coaches: [] };
      this.setData({ loading: false, totalPendingNet: r.totalPendingNet, pendingCoachCount: r.pendingCoachCount, coaches: r.coaches || [] });
    }).catch(() => this.setData({ loading: false }));
  },

  onPeriod(e) {
    const period = e.currentTarget.dataset.key;
    if (period === this.data.period) return;
    this.setData({ period });
    this.load();
    if (this.data.showDetail && this.data.detail) this._loadDetail(this.data.detail.coachOpenid);
  },

  openDetail(e) {
    this._loadDetail(e.currentTarget.dataset.openid);
  },
  _loadDetail(coachOpenid) {
    data.getCoachSettlementDetail(coachOpenid, this.data.period).then((d) => {
      this.setData({ showDetail: true, detail: d, detailTab: 'pending' });
    });
  },
  closeDetail() { this.setData({ showDetail: false }); },
  noop() {},
  onDetailTab(e) { this.setData({ detailTab: e.currentTarget.dataset.tab }); },

  doSettle() {
    const d = this.data.detail;
    if (!d || this.data.settling) return;
    if (!d.pending || !d.pending.length) { wx.showToast({ title: '无待结算课时', icon: 'none' }); return; }
    const label = (this.data.periods.find((p) => p.key === this.data.period) || {}).label || '';
    wx.showModal({
      title: '确认结算',
      content: `确认结清「${d.nickname}」${label} ${d.pending.length} 节课时，应付 ¥${d.summary.net}？`,
      confirmText: '结算',
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ settling: true });
        data.settleCoach(d.coachOpenid, this.data.period).then((r) => {
          this.setData({ settling: false });
          if (r && r.ok === false) { wx.showToast({ title: r.msg || '结算失败', icon: 'none' }); return; }
          wx.showToast({ title: '已结算', icon: 'success' });
          this._loadDetail(d.coachOpenid);
          this.load();
        }).catch(() => { this.setData({ settling: false }); wx.showToast({ title: '结算失败', icon: 'none' }); });
      }
    });
  }
});
