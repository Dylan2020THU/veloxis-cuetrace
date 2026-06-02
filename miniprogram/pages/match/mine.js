const data = require('../../services/data.js');

Page({
  data: {
    loading: true,
    bookings: [],
    matches: [],
    joins: []
  },

  onShow() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  load() {
    this.setData({ loading: true });
    return Promise.all([
      data.getMyBookings(),
      data.getMyMatches(),
      data.getMyJoins()
    ]).then(([bookings, matches, joins]) => {
      this.setData({
        bookings: bookings.map((b) => ({
          ...b,
          typeText: b.type === 'coach' ? '约教练' : '约球桌',
          priceText:
            b.type === 'coach'
              ? b.price
                ? `${b.price} 元/分钟`
                : '面议'
              : b.price
              ? `${b.price} 元/小时`
              : '面议'
        })),
        matches,
        joins,
        loading: false
      });
    });
  },

  cancelBooking(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '取消预约',
      content: '确定要取消该预约吗？',
      success: (res) => {
        if (!res.confirm) return;
        data.cancelBooking(id).then(() => {
          wx.showToast({ title: '已取消', icon: 'success' });
          this.setData({ bookings: this.data.bookings.filter((b) => b._id !== id) });
        });
      }
    });
  },

  cancelMatch(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除邀约',
      content: '确定要删除这条约球邀约吗？',
      success: (res) => {
        if (!res.confirm) return;
        data.cancelMatch(id).then(() => {
          wx.showToast({ title: '已删除', icon: 'success' });
          this.setData({ matches: this.data.matches.filter((m) => m._id !== id) });
        });
      }
    });
  },

  cancelJoin(e) {
    const { id, match } = e.currentTarget.dataset;
    wx.showModal({
      title: '取消报名',
      content: '确定要退出这场球局吗？',
      success: (res) => {
        if (!res.confirm) return;
        data.cancelJoin(id, match).then(() => {
          wx.showToast({ title: '已取消', icon: 'success' });
          this.setData({ joins: this.data.joins.filter((j) => j._id !== id) });
        });
      }
    });
  }
});
