// 训练段位 / 成长值 —— 纯逻辑（不依赖 wx / getApp，便于单元测试）
// 成长值 = 累计训练分钟数；按累计分钟阈值划分段位。

const RANKS = [
  { key: 'bronze', label: '青铜杆手', min: 0 },
  { key: 'silver', label: '白银杆手', min: 600 }, // 10 小时
  { key: 'gold', label: '黄金杆手', min: 3000 }, // 50 小时
  { key: 'platinum', label: '铂金杆手', min: 9000 }, // 150 小时
  { key: 'diamond', label: '钻石杆手', min: 24000 } // 400 小时
];

// 取「前一天」日期字符串（YYYY-MM-DD）
function prevDayKey(key) {
  const parts = String(key).split('-').map(Number);
  const dt = new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1);
  dt.setDate(dt.getDate() - 1);
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return dt.getFullYear() + '-' + m + '-' + d;
}

// 今日日期字符串（YYYY-MM-DD）
function todayKey() {
  const dt = new Date();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return dt.getFullYear() + '-' + m + '-' + d;
}

// 汇总打卡数据：累计天数 / 累计分钟 / 累计小时(文本) / 连续打卡天
// stats: [{ date: 'YYYY-MM-DD', totalMinutes }]；today 可注入（便于测试）
function summarize(stats, today) {
  const list = Array.isArray(stats) ? stats : [];
  let totalMinutes = 0;
  const dateSet = {};
  list.forEach((s) => {
    if (!s) return;
    const mins = s.totalMinutes != null
      ? s.totalMinutes
      : (s.durationMinutes != null ? s.durationMinutes : (s.minutes || 0));
    totalMinutes += Number(mins) || 0;
    if (s.date) dateSet[s.date] = true;
  });
  const totalDays = Object.keys(dateSet).length;
  let streak = 0;
  let cursor = today || todayKey();
  while (dateSet[cursor]) {
    streak += 1;
    cursor = prevDayKey(cursor);
  }
  return {
    totalDays,
    totalMinutes,
    totalHoursText: (totalMinutes / 60).toFixed(1),
    streak
  };
}

// 依据累计分钟数计算当前段位与下一段位进度
function computeRank(totalMinutes) {
  const growth = Math.max(0, Math.round(Number(totalMinutes) || 0));
  let idx = 0;
  for (let i = 0; i < RANKS.length; i++) {
    if (growth >= RANKS[i].min) idx = i;
  }
  const cur = RANKS[idx];
  const next = RANKS[idx + 1] || null;
  if (!next) {
    return {
      label: cur.label,
      level: idx + 1,
      growth,
      curMin: cur.min,
      nextMin: null,
      nextLabel: '',
      toNextMinutes: 0,
      toNextHoursText: '0',
      progress: 100,
      isMax: true
    };
  }
  const span = next.min - cur.min;
  const done = growth - cur.min;
  const progress = span > 0 ? Math.max(0, Math.min(100, Math.round((done / span) * 100))) : 0;
  const toNext = Math.max(0, next.min - growth);
  return {
    label: cur.label,
    level: idx + 1,
    growth,
    curMin: cur.min,
    nextMin: next.min,
    nextLabel: next.label,
    toNextMinutes: toNext,
    toNextHoursText: (toNext / 60).toFixed(1),
    progress,
    isMax: false
  };
}

module.exports = { RANKS, summarize, computeRank, prevDayKey, todayKey };
