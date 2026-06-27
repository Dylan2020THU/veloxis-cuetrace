const { buildGrid, today } = require('../../utils/date');
const { colorOfLevel, levelFromMinutes, formatDuration, LEVEL_COLORS, rampFor } = require('../../utils/color');

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
    },
    // 主题：由父页传入（'light' | 'dark'），切换时重算格子配色
    theme: {
      type: String,
      value: 'light',
      observer() {
        this.rebuild();
      }
    }
  },

  data: {
    columns: [],
    months: [],
    monthsWidth: 0,
    stride: STRIDE,
    selectedKey: '',
    tooltip: '',
    // 是否存在金色（教练身份计时）的日子 → 决定是否展示金/蓝双图例
    hasGold: false,
    c0: LEVEL_COLORS[0],
    c1: LEVEL_COLORS[1],
    c2: LEVEL_COLORS[2],
    c3: LEVEL_COLORS[3],
    g0: LEVEL_COLORS[0],
    g1: LEVEL_COLORS[1],
    g2: LEVEL_COLORS[2],
    g3: LEVEL_COLORS[3]
  },

  lifetimes: {
    attached() {
      this.rebuild();
    }
  },

  methods: {
    rebuild() {
      const theme = this.data.theme;
      const blue = rampFor(theme, 'personal');
      const gold = rampFor(theme, 'coach');
      const statMap = {};
      let hasGold = false;
      (this.data.stats || []).forEach((s) => {
        statMap[s.date] = s;
        if (s.kind === 'coach') hasGold = true;
      });

      const { columns, months } = buildGrid(today(), this.data.weeks);
      const viewCols = columns.map((col) =>
        col.map((cell) => {
          const st = statMap[cell.key];
          const totalMinutes = st ? st.totalMinutes : 0;
          const sessionCount = st ? st.sessionCount : 0;
          const kind = st && st.kind ? st.kind : 'personal';
          const level = st
            ? st.level != null
              ? st.level
              : levelFromMinutes(totalMinutes)
            : 0;
          return {
            key: cell.key,
            inRange: cell.inRange,
            level,
            kind,
            totalMinutes,
            sessionCount,
            color: cell.inRange ? colorOfLevel(level, theme, kind) : 'transparent'
          };
        })
      );

      this.setData({
        columns: viewCols,
        months,
        monthsWidth: columns.length * STRIDE,
        hasGold,
        c0: blue[0],
        c1: blue[1],
        c2: blue[2],
        c3: blue[3],
        g0: gold[0],
        g1: gold[1],
        g2: gold[2],
        g3: gold[3]
      });
    },

    onCellTap(e) {
      const ds = e.currentTarget.dataset;
      if (!ds.range) return; // 超出范围（未来日期）不响应
      const key = ds.key;
      const total = Number(ds.total) || 0;
      const count = Number(ds.count) || 0;
      const level = Number(ds.level) || 0;
      const kind = ds.kind || 'personal';

      const [, m, d] = key.split('-').map(Number);
      let tooltip;
      if (total > 0) {
        tooltip = kind === 'coach'
          ? `${m}月${d}日 · 教练计时 ${formatDuration(total)}`
          : `${m}月${d}日 · 今日训练总时长 ${formatDuration(total)}`;
      } else {
        tooltip = `${m}月${d}日 · 当日未训练`;
      }

      this.setData({ selectedKey: key, tooltip });
      this.triggerEvent('select', {
        date: key,
        totalMinutes: total,
        sessionCount: count,
        level,
        kind
      });
    }
  }
});
