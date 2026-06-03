const data = require('../../services/data');
const { today, addDays, toKey } = require('../../utils/date');
const { formatDuration } = require('../../utils/color');

Page({
  behaviors: [require('../../utils/themeBehavior')],
  data: {
    stats: [],
    totalDays: 0,
    totalHoursText: '0',
    streak: 0,
    selectedLabel: '',
    selectedTotalText: '',
    detailList: [],
    loading: true
  },

  onLoad() {
    data.login().finally(() => this.loadHeatmap());
  },

  // 从其它页面（如新增记录）返回时刷新
  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().refresh();
    }
    if (!this.data.loading) {
      this.loadHeatmap();
    }
  },

  loadHeatmap() {
    const end = today();
    const start = addDays(end, -(53 * 7 - 1));
    const startKey = toKey(start);
    const endKey = toKey(end);

    this.setData({ loading: true });
    data
      .getHeatmap({ startKey, endKey })
      .then((stats) => {
        const summary = this.computeSummary(stats);
        this.setData({
          stats,
          loading: false,
          totalDays: summary.totalDays,
          totalHoursText: summary.totalHoursText,
          streak: summary.streak
        });
        // 默认选中今天
        this.selectDay(endKey);
      })
      .catch((err) => {
        console.error('加载热力图失败', err);
        this.setData({ loading: false });
        wx.showToast({ title: '加载失败', icon: 'none' });
      });
  },

  computeSummary(stats) {
    let totalMinutes = 0;
    const map = {};
    stats.forEach((s) => {
      totalMinutes += s.totalMinutes || 0;
      map[s.date] = true;
    });
    // 连续打卡天数：从今天往前数
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
    data.getDayDetail(dateKey).then((sessions) => {
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
  },

  goAdd() {
    wx.switchTab({ url: '/pages/training/add' });
  }
});
