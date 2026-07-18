const data = require('../../../services/data');

Page({
  behaviors: [require('../../../utils/themeBehavior')],

  data: {
    match: null,
    joiners: [],
    loading: true,
    joined: false
  },

  onLoad(query) {
    const id = decodeURIComponent(query.id || '');
    this.setData({ matchId: id });
    this.loadDetail(id);
    wx.showShareMenu();
  },

  onShow() {
    if (this.data.matchId) this.loadDetail(this.data.matchId);
  },

  loadDetail(id) {
    this.setData({ loading: true, match: null, joiners: [] });
    data.getMatchPosts().then((posts) => {
      const match = posts.find((p) => p._id === id);
      if (!match) {
        this.setData({ loading: false, match: null });
        wx.setNavigationBarTitle({ title: '约球详情' });
        wx.showToast({ title: '未找到该球局', icon: 'none' });
        return;
      }
      this.setData({ match, loading: false });
      wx.setNavigationBarTitle({ title: match.authorName ? `${match.authorName}的约球` : '约球详情' });
      this._loadJoiners(id);
    }).catch((err) => {
      console.error('[match detail] loadDetail error:', err);
      this.setData({ loading: false });
    });
  },

  _loadJoiners(id) {
    data.getMatchJoiners(id).then((joiners) => {
      this.setData({ joiners: Array.isArray(joiners) ? joiners : [] });
    }).catch(() => this.setData({ joiners: [] }));
  },

  applyMatch() {
    wx.showModal({
      title: '确认报名',
      content: '确定报名此次球局？',
      confirmText: '是',
      cancelText: '否',
      success: (res) => {
        if (!res.confirm) return;
        data.joinMatch(this.data.matchId).then((r) => {
          wx.showToast({ title: '报名成功', icon: 'success' });
          this.setData({ joined: true });
          this._loadJoiners(this.data.matchId);
          if (this.data.match) {
            this.setData({
              match: Object.assign({}, this.data.match, {
                joinCount: r && r.joinCount != null ? r.joinCount : (this.data.match.joinCount || 0) + 1
              })
            });
          }
        });
      }
    });
  },

  onShareAppMessage() {
    const m = this.data.match;
    return {
      title: m ? `${m.authorName}约球：${m.gameType || '台球局'}` : '约球局',
      path: `/pages/match/detail/index?id=${encodeURIComponent(this.data.matchId)}`
    };
  }
});
