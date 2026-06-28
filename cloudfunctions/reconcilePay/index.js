// 支付对账 / 发货补偿定时任务（铁律一：异步通知缺失 / 发货失败的兜底）。
// 由 config.json 的 timer 触发器周期调用；也可手动调用做一次性对账。
//
// 本期实现【已付款但发货失败】的补偿：扫 fulfill_failures（resolved=false）→ 确认订单已 paid →
//   幂等补发权益 → 标记 resolved。claim-first 条件更新防并发重复补发。
//
// ⚠️【待补】「回调/推送丢失导致订单卡 pending」的主动查单补发：
//   需调用官方「查询订单」服务端接口确认是否已支付，再补发——
//     · 微信支付(cloudPay, source='wxpay')：云开发 cloudPay 查询订单接口
//     · 虚拟支付(source='virtual')：小程序虚拟支付「查询订单」接口（不在微信支付知识库覆盖内）
//   这两个查询接口的确切签名/字段需以官方文档为准，未确认前不臆造、不在此处对 pending 单自动发货
//   （未经服务端确认即对 pending 发货 = 白发风险）。确认接口后在 reconcilePendingOrders() 内补齐。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const fulfill = require('./lib/fulfill');

// 补偿：已付款但发货失败的订单（fulfill_failures）
async function retryFulfillFailures() {
  const res = await db.collection('fulfill_failures').where({ resolved: false }).limit(50).get();
  let fixed = 0, skipped = 0, failed = 0;
  for (const f of res.data) {
    // claim-first：仅 resolved:false → true 抢占，防并发/重复补发
    const claim = await db.collection('fulfill_failures')
      .where({ _id: f._id, resolved: false })
      .update({ data: { resolved: true, resolvedAt: db.serverDate() } });
    if (!claim.stats || claim.stats.updated === 0) { skipped += 1; continue; }
    try {
      const ordRes = await db.collection('orders').where({ outTradeNo: f.outTradeNo }).limit(1).get();
      const order = ordRes.data[0];
      // 只补「确已支付」的单（发货失败前回调已把 paid=true）；未支付的不在本补偿范围
      if (!order || !(order.paid === true || order.status === 'paid')) { skipped += 1; continue; }
      const userRes = await db.collection('users').where({ _openid: f._openid }).limit(1).get();
      if (!userRes.data.length) { skipped += 1; continue; }
      const user = userRes.data[0];
      const perRole = (user.per_role && typeof user.per_role === 'object') ? user.per_role : {};
      const current = (perRole[f.role] && typeof perRole[f.role] === 'object') ? perRole[f.role] : {};
      const now = Date.now();
      const planExpiresAt = fulfill.computeExpiry({ current, planKey: f.planKey, period: f.period, now });
      await fulfill.applyEntitlement({
        db, userId: user._id, perRole, role: f.role,
        planKey: f.planKey, period: f.period, planExpiresAt, now
      });
      fixed += 1;
    } catch (e) {
      // 补发失败：回退 resolved=false 等下一周期重试，并记 attempts/lastError
      failed += 1;
      console.error('[reconcilePay] retry fulfill failed', f.outTradeNo, e);
      try {
        await db.collection('fulfill_failures').doc(f._id).update({
          data: { resolved: false, attempts: db.command.inc(1), lastError: String((e && e.message) || e), lastTriedAt: db.serverDate() }
        });
      } catch (e2) { console.error('[reconcilePay] reopen failure record failed', f._id, e2); }
    }
  }
  return { scanned: res.data.length, fixed, skipped, failed };
}

// 【待补】卡 pending 订单的主动查单补发：见文件头说明，需官方查询订单接口确认后实现。
async function reconcilePendingOrders() {
  return { pending: 'skipped', reason: '待接入官方查询订单接口' };
}

exports.main = async () => {
  const failures = await retryFulfillFailures();
  const pending = await reconcilePendingOrders();
  console.log('[reconcilePay] done', JSON.stringify({ failures, pending }));
  return { ok: true, failures, pending };
};
