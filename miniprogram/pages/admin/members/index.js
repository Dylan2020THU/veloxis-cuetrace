const data = require('../../../services/data');

const TRAINING_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'trained', label: '有训练记录' },
  { value: 'untrained', label: '无训练记录' }
];

Page({
  data: {
    loading: true,
    error: '',
    keyword: '',
    training: 'all',
    trainingOptions: TRAINING_OPTIONS,
    summary: {},
    members: [],
    filteredMembers: []
  },

  onShow() {
    this.load();
  },

  load() {
    this.setData({ loading: true, error: '' });
    data.getAdminMembers()
      .then((res) => {
        const members = (res && res.members) || [];
        this.setData({ members, loading: false });
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

  chooseTraining(e) {
    this.setData({ training: e.currentTarget.dataset.value });
    this.applyFilters();
  },

  applyFilters() {
    const keyword = (this.data.keyword || '').trim().toLowerCase();
    const filteredMembers = (this.data.members || []).filter((item) => {
      const trained = (item.trainingDays || 0) > 0 || (item.totalTrainingHours || 0) > 0;
      const trainingOk = this.data.training === 'all' || (this.data.training === 'trained' ? trained : !trained);
      const text = `${item.memberName || ''} ${item.accountName || ''} ${item.lastStoreName || ''}`.toLowerCase();
      return trainingOk && (!keyword || text.indexOf(keyword) !== -1);
    });
    this.setData({ filteredMembers, summary: this.buildSummary(filteredMembers) });
  },

  buildSummary(list) {
    const rows = list || [];
    return {
      totalMembers: rows.length,
      newToday: 0,
      newThisWeek: 0,
      trainedMembers: rows.filter((item) => (item.trainingDays || 0) > 0 || (item.totalTrainingHours || 0) > 0).length
    };
  },

  goAdminTab(e) {
    const url = e.currentTarget.dataset.url;
    if (!url || url === '/pages/admin/members/index') return;
    wx.reLaunch({ url });
  }
});
