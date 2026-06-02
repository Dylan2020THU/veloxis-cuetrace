// 大川蓝配色与时长分级
// 品牌色 大川蓝 RGB(6,126,249) = #067EF9

const EMPTY = '#ebedf0';
const LEVEL_COLORS = {
  0: EMPTY,
  1: 'rgba(6,126,249,0.35)', // 0-3 小时
  2: 'rgba(6,126,249,0.65)', // 3-8 小时
  3: 'rgba(6,126,249,1)' // 8 小时以上
};

// 依据当日训练总时长（分钟）计算颜色深度等级
// 0：未训练；1：0-3h；2：3-8h；3：8h 以上
function levelFromMinutes(totalMinutes) {
  if (!totalMinutes || totalMinutes <= 0) return 0;
  const hours = totalMinutes / 60;
  if (hours <= 3) return 1;
  if (hours <= 8) return 2;
  return 3;
}

function colorOfLevel(level) {
  return LEVEL_COLORS[level] || EMPTY;
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

module.exports = { EMPTY, LEVEL_COLORS, levelFromMinutes, colorOfLevel, formatDuration };
