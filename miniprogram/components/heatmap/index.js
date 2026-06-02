const { buildGrid, today } = require('../../utils/date');
const { colorOfLevel, levelFromMinutes, formatDuration, LEVEL_COLORS } = require('../../utils/color');

const STRIDE = 30; // 每个格子占位宽度(rpx)：cell 24 + margin 3*2

Component({
  properties: {
    // [{ date, totalMinutes, sessionCount, level }]
    stats: {
      type: Array,
      value: [],
      observer() {
        this.rebuild();
      }
    },
    weeks: {
      type: Number,
      value: 53
    }
  },

  data: {
    columns: [],
    months: [],
    monthsWidth: 0,
    stride: STRIDE,
    selectedKey: '',
    tooltip: '',
    c0: LEVEL_COLORS[0],
    c1: LEVEL_COLORS[1],
    c2: LEVEL_COLORS[2],
    c3: LEVEL_COLORS[3]
  },

  lifetimes: {
    attached() {
      this.rebuild();
    }
  },

  methods: {
    rebuild() {
      const statMap = {};
      (this.data.stats || []).forEach((s) => {
        statMap[s.date] = s;
      });

      const { columns, months } = buildGrid(today(), this.data.weeks);
      const viewCols = columns.map((col) =>
        col.map((cell) => {
          const st = statMap[cell.key];
          const totalMinutes = st ? st.totalMinutes : 0;
          const sessionCount = st ? st.sessionCount : 0;
          const level = st
            ? st.level != null
              ? st.level
              : levelFromMinutes(totalMinutes)
            : 0;
          return {
            key: cell.key,
            inRange: cell.inRange,
            level,
            totalMinutes,
            sessionCount,
            color: cell.inRange ? colorOfLevel(level) : 'transparent'
          };
        })
      );

      this.setData({
        columns: viewCols,
        months,
        monthsWidth: columns.length * STRIDE
      });
    },

    onCellTap(e) {
      const ds = e.currentTarget.dataset;
      if (!ds.range) return; // 超出范围（未来日期）不响应
      const key = ds.key;
      const total = Number(ds.total) || 0;
      const count = Number(ds.count) || 0;
      const level = Number(ds.level) || 0;

      const [, m, d] = key.split('-').map(Number);
      const tooltip =
        total > 0
          ? `${m}月${d}日 · 今日训练总时长 ${formatDuration(total)}`
          : `${m}月${d}日 · 当日未训练`;

      this.setData({ selectedKey: key, tooltip });
      this.triggerEvent('select', {
        date: key,
        totalMinutes: total,
        sessionCount: count,
        level
      });
    }
  }
});
