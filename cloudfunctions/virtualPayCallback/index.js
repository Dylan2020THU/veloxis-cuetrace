const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const fulfill = require('./lib/fulfill');

// 虚拟支付「消息推送」处理：道具发货推送 xpay_goods_deliver_notify（现金购买道具支付成功后触发）。
// 在小程序后台「开发管理 → 消息推送」把推送地址配到本云函数即可（云开发支持推送到云函数）。
// 须返回 { ErrCode: 0, ErrMsg: 'success' }（大小写敏感），否则微信最多重推 15 次 → 故幂等是硬性要求。
// 字段名以官方推送报文为准：Event / OpenId / OutTradeNo / Env / GoodsInfo.ProductId / WeChatPayInfo.TransactionId。
const ACK = { ErrCode: 0, ErrMsg: 'success' };

exports.main = async (event = {}) => {
  const evType = event.Event || event.event || '';

  // 只处理道具发货推送；其它推送（含退款/投诉/登录等）一律 ack，避免重推风暴。
  if (evType !== 'xpay_goods_deliver_notify') {
    return ACK;
  }

  const wxPay = event.WeChatPayInfo || event.weChatPayInfo || {};
  const outTradeNo = event.OutTradeNo || event.out_trade_no;
  const transactionId = wxPay.TransactionId || wxPay.transactionId || '';
  if (!outTradeNo) return ACK;

  const orders = db.collection('orders');
  const found = await orders.where({ outTradeNo }).limit(1).get();
  if (!found.data.length) return ACK;
  const order = found.data[0];

  // 幂等：已支付直接 ack，不重复发货
  if (order.paid === true || order.status === 'paid') return ACK;

  // 条件更新：仅 pending → paid，防并发重复发货
  const flip = await orders.where({ _id: order._id, status: 'pending' }).update({
    data: { paid: true, status: 'paid', transactionId, paidAt: db.serverDate() }
  });
  if (!flip.stats || flip.stats.updated === 0) return ACK; // 已被另一并发推送处理

  // 发货：写订阅状态
  try {
    const userRes = await db.collection('users').where({ _openid: order._openid }).limit(1).get();
    if (userRes.data.length) {
      const user = userRes.data[0];
      const perRole = (user.per_role && typeof user.per_role === 'object') ? user.per_role : {};
      const current = (perRole[order.role] && typeof perRole[order.role] === 'object') ? perRole[order.role] : {};
      const now = Date.now();
      const planExpiresAt = fulfill.computeExpiry({ current, planKey: order.planKey, period: order.period, now });
      await fulfill.applyEntitlement({
        db, userId: user._id, perRole, role: order.role,
        planKey: order.planKey, period: order.period, planExpiresAt, now
      });
    }
  } catch (err) {
    // 订单已置 paid 但发货失败：写补偿表 fulfill_failures + 告警，由查单/补偿任务或人工兜底。仍 ack，避免重推导致二次入账。
    console.error('[virtualPayCallback] fulfill failed', err);
    try {
      await db.collection('fulfill_failures').add({
        data: {
          outTradeNo, _openid: order._openid, source: 'virtual',
          planKey: order.planKey, role: order.role, period: order.period,
          transactionId, error: String((err && err.message) || err),
          resolved: false, createdAt: db.serverDate()
        }
      });
    } catch (e2) {
      console.error('[virtualPayCallback] write fulfill_failures failed', e2);
    }
  }

  return ACK;
};
