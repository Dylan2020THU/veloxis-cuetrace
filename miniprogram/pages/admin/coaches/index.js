const data = require('../../../services/data');

const STATUS_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'approved', label: '已绑定' },
  { value: 'pending', label: '待审核' },
  { value: 'none', label: '未绑定' }
];

const STATUS_TEXT = {
  approved: '已绑定',
  pending: '待审核',
  none: '未绑定'
};

Page({
  data: {
    loading: true,
    error: '',
    keyword: '',
    status: 'all',
    statusOptions: STATUS_OPTIONS,
    summary: {},
    coaches: [],
    filteredCoaches: []
  },

  onShow() {
    this.load();
  },

  load() {
    this.setData({ loading: true, error: '' });
    data.getAdminCoaches()
      .then((res) => {
        const coaches = ((res && res.coaches) || []).map((item) => Object.assign({}, item, {
          statusText: STATUS_TEXT[item.bindingStatus] || '未绑定',
          statusClass: item.bindingStatus === 'approved' ? 'ok' : item.bindingStatus === 'pending' ? 'warn' : ''
        }));
        this.setData({ coaches, loading: false });
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

  applyFilters() {
    const keyword = (this.data.keyword || '').trim().toLowerCase();
    const filteredCoaches = (this.data.coaches || []).filter((item) => {
      const statusOk = this.data.status === 'all' || item.bindingStatus === this.data.status;
      const text = `${item.coachName || ''} ${item.boundStoreName || ''}`.toLowerCase();
      return statusOk && (!keyword || text.indexOf(keyword) !== -1);
    });
    this.setData({ filteredCoaches, summary: this.buildSummary(filteredCoaches) });
  },

  buildSummary(list) {
    const rows = list || [];
    return {
      totalCoaches: rows.length,
      boundCoaches: rows.filter((item) => item.bindingStatus === 'approved').length,
      pendingApplications: rows.filter((item) => item.bindingStatus === 'pending').length,
      unboundCoaches: rows.filter((item) => item.bindingStatus === 'none').length
    };
  },

  goAdminTab(e) {
    const url = e.currentTarget.dataset.url;
    if (!url || url === '/pages/admin/coaches/index') return;
    wx.reLaunch({ url });
  }
});
