// 大川蓝配色与时长分级
// 品牌色 大川蓝 RGB(6,126,249) = #067EF9

const EMPTY = '#ebedf0';
const LEVEL_COLORS = {
  0: EMPTY,
  1: 'rgba(6,126,249,0.35)', // 0-3 小时
  2: 'rgba(6,126,249,0.65)', // 3-8 小时
  3: 'rgba(6,126,249,1)' // 8 小时以上
};

// 未核验补记训练日：保留热力图点亮，但用灰色与已核验蓝色区分。
const LEVEL_COLORS_UNVERIFIED = {
  0: EMPTY,
  1: '#d8dde3',
  2: '#b9c0c9',
  3: '#8f99a6'
};

// 夜间档位配色（参照 GitHub 夜间贡献格：深灰空格 + 渐亮品牌蓝）
const EMPTY_DARK = '#2d333b';
const LEVEL_COLORS_DARK = {
  0: EMPTY_DARK,
  1: '#16456f', // 0-3 小时（深蓝）
  2: '#1f73cc', // 3-8 小时（中蓝）
  3: '#4aa3ff' // 8 小时以上（亮蓝）
};
const LEVEL_COLORS_UNVERIFIED_DARK = {
  0: EMPTY_DARK,
  1: '#3b4149',
  2: '#59616d',
  3: '#77818f'
};

// 金色档位配色：教练以「教练身份」计时的日子用金色（与大川蓝并列的第二色系）。
// 优先级 金 > 蓝：同一天若既有教练计时也有自主练球，总时长统一以金色表示。
const GOLD = '#f0a500';
const LEVEL_COLORS_GOLD = {
  0: EMPTY,
  1: 'rgba(240,165,0,0.40)', // 0-3 小时
  2: 'rgba(240,165,0,0.70)', // 3-8 小时
  3: 'rgba(240,165,0,1)' // 8 小时以上
};
const LEVEL_COLORS_GOLD_DARK = {
  0: EMPTY_DARK,
  1: '#5c4410', // 0-3 小时（深金）
  2: '#b3891f', // 3-8 小时（中金）
  3: '#f2c14e' // 8 小时以上（亮金）
};

// 按主题与身份取整套档位色。
// theme: 'dark' | 其它；kind: 'coach'（金）| 其它（蓝，含 'personal'/undefined）
function rampFor(theme, kind) {
  if (kind === 'coach') {
    return theme === 'dark' ? LEVEL_COLORS_GOLD_DARK : LEVEL_COLORS_GOLD;
  }
  return theme === 'dark' ? LEVEL_COLORS_DARK : LEVEL_COLORS;
}

// 依据当日训练总时长（分钟）计算颜色深度等级
// 0：未训练；1：0-3h；2：3-8h；3：8h 以上
function levelFromMinutes(totalMinutes) {
  if (!totalMinutes || totalMinutes <= 0) return 0;
  const hours = totalMinutes / 60;
  if (hours <= 3) return 1;
  if (hours <= 8) return 2;
  return 3;
}

function colorOfLevel(level, theme, kind) {
  const ramp = rampFor(theme, kind);
  return ramp[level] || ramp[0];
}

function colorOfTrainingDay(level, theme, kind, hasVerified) {
  if (kind !== 'coach' && level > 0 && hasVerified === false) {
    const ramp = theme === 'dark' ? LEVEL_COLORS_UNVERIFIED_DARK : LEVEL_COLORS_UNVERIFIED;
    return ramp[level] || ramp[0];
  }
  return colorOfLevel(level, theme, kind);
}

// 将分钟格式化为「X 小时 Y 分」
function formatDuration(totalMinutes) {
  const m = Math.max(0, Math.round(totalMinutes || 0));
  const h = Math.floor(m / 60);
  const min = m % 60;
  if (h > 0 && min > 0) return `${h} 小时 ${min} 分`;
  if (h > 0) return `${h} 小时`;
  return `${min} 分`;
}

module.exports = { EMPTY, EMPTY_DARK, GOLD, LEVEL_COLORS, LEVEL_COLORS_DARK, LEVEL_COLORS_UNVERIFIED, LEVEL_COLORS_UNVERIFIED_DARK, LEVEL_COLORS_GOLD, LEVEL_COLORS_GOLD_DARK, rampFor, levelFromMinutes, colorOfLevel, colorOfTrainingDay, formatDuration };
