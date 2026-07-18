const data = require('../../../services/data');

const STATUS_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'pending', label: '待审核' },
  { value: 'approved', label: '已通过' },
  { value: 'rejected', label: '已驳回' },
  { value: 'none', label: '未提交' }
];

const CHECKIN_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'enabled', label: '已开启打卡' },
  { value: 'disabled', label: '未开启打卡' }
];

const STATUS_TEXT = {
  pending: '待审核',
  approved: '已通过',
  rejected: '已驳回',
  none: '未提交'
};

Page({
  data: {
    loading: true,
    error: '',
    keyword: '',
    status: 'all',
    checkin: 'all',
    statusOptions: STATUS_OPTIONS,
    checkinOptions: CHECKIN_OPTIONS,
    backendSummary: {},
    summary: {},
    stores: [],
    filteredStores: []
  },

  onShow() {
    this.load();
  },

  load() {
    this.setData({ loading: true, error: '' });
    data.getAdminStores()
      .then((res) => {
        const backendSummary = (res && res.summary) || {};
        const stores = ((res && res.stores) || []).map((item) => Object.assign({}, item, {
          statusText: STATUS_TEXT[item.applicationStatus] || '未提交',
          statusClass: item.applicationStatus === 'approved' ? 'ok' : item.applicationStatus === 'pending' ? 'warn' : item.applicationStatus === 'rejected' ? 'bad' : '',
          checkinText: item.checkinEnabled ? '已开启打卡' : '未开启打卡',
          checkinClass: item.checkinEnabled ? 'ok' : ''
        }));
        this.setData({ stores, backendSummary, loading: false });
        this.applyFilters();
      })
      .catch((e) => this.setData({
        loading: false,
        error: (e && e.code) === 'FORBIDDEN' ? '管理员权限已失效，请重新登录' : '数据加载失败，请稍后重试'
      }));
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value || '' });
    this.applyFilters();
  },

  chooseStatus(e) {
    this.setData({ status: e.currentTarget.dataset.value });
    this.applyFilters();
  },

  chooseCheckin(e) {
    this.setData({ checkin: e.currentTarget.dataset.value });
    this.applyFilters();
  },

  applyFilters() {
    const keyword = (this.data.keyword || '').trim().toLowerCase();
    const filteredStores = (this.data.stores || []).filter((item) => {
      const statusOk = this.data.status === 'all' || item.applicationStatus === this.data.status;
      const checkinOk = this.data.checkin === 'all' || (this.data.checkin === 'enabled' ? item.checkinEnabled : !item.checkinEnabled);
      const text = `${item.storeName || ''} ${item.ownerName || ''} ${item.address || ''} ${item.region || ''}`.toLowerCase();
      return statusOk && checkinOk && (!keyword || text.indexOf(keyword) !== -1);
    });
    this.setData({ filteredStores, summary: this.buildSummary(filteredStores) });
  },

  buildSummary(list) {
    const rows = list || [];
    const backendSummary = this.data.backendSummary || {};
    return {
      totalStores: rows.length,
      approvedStores: rows.filter((item) => item.applicationStatus === 'approved').length,
      pendingApplications: backendSummary.pendingApplications === undefined
        ? rows.filter((item) => item.applicationStatus === 'pending').length
        : backendSummary.pendingApplications,
      checkinEnabledStores: rows.filter((item) => item.checkinEnabled).length
    };
  },

  goReview() {
    wx.navigateTo({ url: '/pages/shop/admin/review/index' });
  },

  goAdminTab(e) {
    const url = e.currentTarget.dataset.url;
    if (!url || url === '/pages/admin/stores/index') return;
    wx.reLaunch({ url });
  }
});
