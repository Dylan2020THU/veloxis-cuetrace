const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const $ = db.command.aggregate;

// 当前自然日（北京时间 UTC+8）的 YYYY-MM-DD。
// 与 createTableOrder 写入时同口径，避免云端默认 UTC 导致"今日"错位。
function todayKeyCN() {
  const cn = new Date(Date.now() + 8 * 3600 * 1000);
  const y = cn.getUTCFullYear();
  const m = cn.getUTCMonth() + 1;
  const d = cn.getUTCDate();
  return y + '-' + (m < 10 ? '0' + m : m) + '-' + (d < 10 ? '0' + d : d);
}

// 今日营收：当前店主今日所有结账订单金额合计（元）。供「我的 / 球厅主页」展示。
exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  const today = todayKeyCN();
  try {
    const res = await db
      .collection('shop_orders')
      .aggregate()
      .match({ _openid: OPENID, date: today })
      .group({ _id: null, total: $.sum('$amount') })
      .end();
    const total = (res.list && res.list[0] && res.list[0].total) || 0;
    return { ok: true, total };
  } catch (e) {
    // 集合不存在 / 无数据时安全返回 0，避免前端报错
    return { ok: true, total: 0 };
  }
};
