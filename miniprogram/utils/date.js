// 日期工具：统一以本地时区的 YYYY-MM-DD 作为某一天的键

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

// 将 Date 格式化为 YYYY-MM-DD
function toKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// 解析 YYYY-MM-DD 为本地 Date（当天 0 点）
function fromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

// 今天 0 点
function today() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// 生成 GitHub 风格热力图网格。
// 以 endDate 所在周的周六为最后一格，向前覆盖 weeks 周（默认 53 周）。
// 返回 { columns: [[cell x7], ...], months: [{label, col}] }
// 每个 cell: { key, date, inRange, weekday }
function buildGrid(endDate, weeks = 53) {
  const end = new Date(endDate.getTime());
  end.setHours(0, 0, 0, 0);
  // 让最后一列补齐到本周周六（getDay: 0=周日 ... 6=周六）
  const lastSaturday = addDays(end, 6 - end.getDay());
  const totalDays = weeks * 7;
  const start = addDays(lastSaturday, -(totalDays - 1));

  const columns = [];
  const months = [];
  let lastMonth = -1;

  for (let w = 0; w < weeks; w++) {
    const col = [];
    for (let r = 0; r < 7; r++) {
      const cellDate = addDays(start, w * 7 + r);
      const inRange = cellDate.getTime() <= end.getTime();
      col.push({
        key: toKey(cellDate),
        date: cellDate,
        weekday: r,
        inRange
      });
      // 记录每月首次出现的列，用于顶部月份标签
      if (r === 0) {
        const m = cellDate.getMonth();
        if (m !== lastMonth) {
          months.push({ col: w, label: `${m + 1}月` });
          lastMonth = m;
        }
      }
    }
    columns.push(col);
  }

  return { columns, months };
}

module.exports = { pad, toKey, fromKey, addDays, today, buildGrid };
