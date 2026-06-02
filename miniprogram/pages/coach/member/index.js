const data = require('../../../services/data');
const { today, addDays, toKey } = require('../../../utils/date');
const { formatDuration } = require('../../../utils/color');

Page({
  data: {
    targetOpenid: '',
    nickname: '',
    stats: [],
    totalDays: 0,
    totalHoursText: '0',
    streak: 0,
    selectedLabel: '',
    selectedTotalText: '',
    detailList: [],
    loading: true
  },

  onLoad(query) {
    const targetOpenid = decodeURIComponent(query.openid || '');
    const nickname = decodeURIComponent(query.nickname || '会员');
    this.setData({ targetOpenid, nickname });
    wx.setNavigationBarTitle({ title: `${nickname}的训练` });
    this.loadHeatmap();
  },

  loadHeatmap() {
    const end = today();
    const start = addDays(end, -(53 * 7 - 1));
    const startKey = toKey(start);
    const endKey = toKey(end);

    this.setData({ loading: true });
    data
      .getHeatmap({ startKey, endKey, targetOpenid: this.data.targetOpenid })
      .then((stats) => {
        const summary = this.computeSummary(stats);
        this.setData({
          stats,
          loading: false,
          totalDays: summary.totalDays,
          totalHoursText: summary.totalHoursText,
          streak: summary.streak
        });
        this.selectDay(endKey);
      })
      .catch((err) => {
        console.error('加载学员数据失败', err);
        this.setData({ loading: false });
        wx.showToast({ title: err.errMsg || '无权查看', icon: 'none' });
      });
  },

  computeSummary(stats) {
    let totalMinutes = 0;
    const map = {};
    stats.forEach((s) => {
      totalMinutes += s.totalMinutes || 0;
      map[s.date] = true;
    });
    let streak = 0;
    let cursor = today();
    while (map[toKey(cursor)]) {
      streak += 1;
      cursor = addDays(cursor, -1);
    }
    return {
      totalDays: stats.length,
      totalHoursText: (totalMinutes / 60).toFixed(1),
      streak
    };
  },

  onSelectDay(e) {
    this.selectDay(e.detail.date);
  },

  selectDay(dateKey) {
    const [, m, d] = dateKey.split('-').map(Number);
    data.getDayDetail(dateKey, this.data.targetOpenid).then((sessions) => {
      const totalMinutes = sessions.reduce((sum, s) => sum + (s.durationMinutes || 0), 0);
      const detailList = sessions.map((s) => ({
        ...s,
        durationText: formatDuration(s.durationMinutes)
      }));
      this.setData({
        selectedLabel: `${m}月${d}日`,
        selectedTotalText: totalMinutes > 0 ? formatDuration(totalMinutes) : '',
        detailList
      });
    });
  }
});
