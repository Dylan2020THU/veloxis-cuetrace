const data = require('../../../services/data.js');

Page({
  behaviors: [require('../../../utils/themeBehavior')],
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
          priceText: b.price ? `${b.price} 元/分钟` : '面议',
          // 平台服务费：约教练订单按 commissionRate 抽取（结算时收取）
          commissionText: b.commissionRate
            ? `成交额的 ${Math.round(b.commissionRate * 100)}%（结算时收取）`
            : ''
        })),
        loading: false
      });
    });
  }
});
