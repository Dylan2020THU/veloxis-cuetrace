// 基础支付（微信支付·JSAPI）cloudPay 支付结果回调云函数。
// 由 createPayOrder 的 unifiedOrder(functionName='payCallback') 指定；支付成功后云开发调用本函数。
// cloudPay 已代为验签，本函数只需幂等发货并返回 { errcode: 0, errmsg: 'SUCCESS' }（否则微信重推）。
// ⚠️ AI 参考微信支付官方 Java 示例 + 云开发 cloudPay 文档翻译生成，非官方维护。
//    请开发人员自行审查逻辑，上线前充分测试，AI 不对生成代码正确性负责。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const fulfill = require('./lib/fulfill');

const ACK = { errcode: 0, errmsg: 'SUCCESS' };

exports.main = async (event = {}) => {
  // cloudPay 回调字段（兼容 camelCase / 下划线两种命名）
  const returnCode = event.returnCode || event.return_code;
  const resultCode = event.resultCode || event.result_code;
  const outTradeNo = event.outTradeNo || event.out_trade_no;
  const paidFen = Number(event.totalFee || event.total_fee || 0);
  const transactionId = event.transactionId || event.transaction_id || '';

  // 通信/业务结果非成功：仍 ack（避免重推风暴），不发货
  if ((returnCode && returnCode !== 'SUCCESS') || (resultCode && resultCode !== 'SUCCESS')) return ACK;
  if (!outTradeNo) return ACK;

  const orders = db.collection('orders');
  const found = await orders.where({ outTradeNo }).limit(1).get();
  if (!found.data.length) return ACK;
  const order = found.data[0];

  // 幂等：已支付直接 ack，不重复发货
  if (order.paid === true || order.status === 'paid') return ACK;
  // 金额校验（防错单/篡改）
  if (order.totalFee && paidFen && order.totalFee !== paidFen) {
    console.error('[payCallback] amount mismatch', { outTradeNo, expect: order.totalFee, got: paidFen });
    return ACK;
  }

  // 条件更新：仅 pending → paid，防并发重复发货
  const flip = await orders.where({ _id: order._id, status: 'pending' }).update({
    data: { paid: true, status: 'paid', transactionId, paidAt: db.serverDate() }
  });
  if (!flip.stats || flip.stats.updated === 0) return ACK; // 已被另一并发回调处理

  // 发货：写订阅
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
    // 订单已置 paid 但发货失败：写补偿表 fulfill_failures + 告警，由查单/补偿任务或人工兜底。仍 ack，避免重推二次入账。
    console.error('[payCallback] fulfill failed', err);
    try {
      await db.collection('fulfill_failures').add({
        data: {
          outTradeNo, _openid: order._openid, source: 'wxpay',
          planKey: order.planKey, role: order.role, period: order.period,
          transactionId, error: String((err && err.message) || err),
          resolved: false, createdAt: db.serverDate()
        }
      });
    } catch (e2) {
      console.error('[payCallback] write fulfill_failures failed', e2);
    }
  }

  return ACK;
};
