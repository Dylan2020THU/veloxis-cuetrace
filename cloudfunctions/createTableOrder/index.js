const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 当前自然日（北京时间 UTC+8）的 YYYY-MM-DD（与 getTodayRevenue 同口径）
function todayKeyCN() {
  const cn = new Date(Date.now() + 8 * 3600 * 1000);
  const y = cn.getUTCFullYear();
  const m = cn.getUTCMonth() + 1;
  const d = cn.getUTCDate();
  return y + '-' + (m < 10 ? '0' + m : m) + '-' + (d < 10 ? '0' + d : d);
}

// 结账：写一笔球桌计费订单。owner 以服务端 OPENID 为准（不信任前端 _owner）；
// date 服务端按北京时区统一计算，保证与 getTodayRevenue 的"今日"一致。
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const e = event || {};
  const amount = Number(e.amount) || 0;
  const record = {
    _openid: OPENID,
    amount,
    storeId: e.storeId || '',
    tableId: e.tableId || '',
    tableName: e.tableName || '',
    durationMin: Number(e.durationMin) || 0,
    date: todayKeyCN(),
    createdAt: db.serverDate()
  };
  const res = await db.collection('shop_orders').add({ data: record });
  return { ok: true, amount, orderId: res._id };
};
