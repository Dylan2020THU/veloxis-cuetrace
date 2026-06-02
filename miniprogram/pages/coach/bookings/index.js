const data = require('../../../services/data.js');

Page({
  data: {
    loading: true,
    bookings: []
  },

  onShow() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  load() {
    this.setData({ loading: true });
    return data.getCoachBookings().then((bookings) => {
      this.setData({
        bookings: bookings.map((b) => ({
          ...b,
          priceText: b.price ? `${b.price} 元/分钟` : '面议'
        })),
        loading: false
      });
    });
  }
});
