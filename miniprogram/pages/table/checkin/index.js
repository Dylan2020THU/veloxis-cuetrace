const data = require('../../../services/data');
const { parseTableCode } = require('../../../utils/tableCode');

function tableIdFor(item, index) {
  return item.tableId || `T${index + 1}`;
}

Page({
  behaviors: [require('../../../utils/themeBehavior')],

  data: {
    loading: true,
    storeId: '',
    tableId: '',
    tableName: '',
    store: null,
    table: null,
    role: 'member',
    joined: false,
    ready: false,
    participants: []
  },

  onLoad(options) {
    const payload = parseTableCode(options || {});
    this.setData({
      storeId: payload.storeId,
      tableId: payload.tableId,
      tableName: payload.tableName,
      role: this.currentJoinRole()
    });
    this.loadTable();
  },

  currentJoinRole() {
    const app = getApp();
    const role = (app && app.globalData && app.globalData.role) || 'member';
    return role === 'coach' ? 'coach' : 'member';
  },

  currentProfile() {
    const app = getApp();
    const profile = (app && app.globalData && app.globalData.userProfile) || {};
    return {
      nickname: profile.nickname || (this.data.role === 'coach' ? '教练' : '球员'),
      avatar: profile.avatar || ''
    };
  },

  loadTable() {
    if (!this.data.storeId || !this.data.tableId) {
      this.setData({ loading: false });
      wx.showToast({ title: '无法识别球桌码', icon: 'none' });
      return;
    }
    data
      .getStoreById(this.data.storeId)
      .then((store) => {
        if (!store) {
          this.setData({ loading: false });
          wx.showToast({ title: '门店不存在', icon: 'none' });
          return;
        }
        const tableTypes = store.tableTypes || [];
        const table = tableTypes.map((item, index) => Object.assign({}, item, { tableId: tableIdFor(item, index) }))
          .find((item) => item.tableId === this.data.tableId) || {
            tableId: this.data.tableId,
            name: this.data.tableName || this.data.tableId,
            pricePerHour: 0
          };
        this.setData({
          store,
          table,
          tableName: this.data.tableName || table.name || table.tableId,
          loading: false
        });
        this.refreshParticipants();
      })
      .catch(() => {
        this.setData({ loading: false });
        wx.showToast({ title: '加载失败', icon: 'none' });
      });
  },

  refreshParticipants() {
    if (!this.data.storeId || !this.data.tableId) return;
    data.getTableParticipants(this.data.storeId, this.data.tableId).then((list) => {
      const participants = (list || []).map((item) => ({
        nickname: item.nickname || (item.role === 'coach' ? '教练' : '球员'),
        avatar: item.avatar || '',
        role: item.role === 'coach' ? 'coach' : 'member',
        ready: !!item.ready
      }));
      this.setData({ participants });
    }).catch(() => {});
  },

  submitCheckin(ready) {
    const profile = this.currentProfile();
    return data.requestCheckin({
      storeId: this.data.storeId,
      tableId: this.data.tableId,
      nickname: profile.nickname,
      avatar: profile.avatar,
      role: this.data.role,
      ready: !!ready
    });
  },

  joinTable() {
    this.submitCheckin(false)
      .then(() => {
        this.setData({ joined: true });
        this.refreshParticipants();
        wx.showToast({ title: '已加入', icon: 'success' });
      })
      .catch(() => wx.showToast({ title: '加入失败', icon: 'none' }));
  },

  startPlay() {
    this.submitCheckin(true)
      .then(() => {
        this.setData({ joined: true, ready: true });
        this.refreshParticipants();
        wx.showToast({ title: '已开打，等待店主核验', icon: 'none' });
      })
      .catch(() => wx.showToast({ title: '开打失败', icon: 'none' }));
  }
});
