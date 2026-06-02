const data = require('../../../services/data');
const { formatDuration } = require('../../../utils/color');

Page({
  data: {
    members: [],
    loading: true,
    totalDays: 0,
    totalHoursText: '0'
  },

  onLoad() {
    this.load();
  },

  load() {
    this.setData({ loading: true });
    data
      .getShopMembers()
      .then((list) => {
        let totalDays = 0;
        let totalMinutes = 0;
        const members = list.map((m) => {
          totalDays += m.checkinDays || 0;
          totalMinutes += m.totalMinutes || 0;
          return Object.assign({}, m, {
            durationText: formatDuration(m.totalMinutes),
            hoursText: (m.totalMinutes / 60).toFixed(1)
          });
        });
        this.setData({
          members,
          loading: false,
          totalDays,
          totalHoursText: (totalMinutes / 60).toFixed(1)
        });
      })
      .catch((err) => {
        console.error('加载会员统计失败', err);
        this.setData({ loading: false });
      });
  }
});
