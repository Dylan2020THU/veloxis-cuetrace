// 支付对账 / 发货补偿定时任务（铁律一：异步通知缺失 / 发货失败的兜底）。
// 由 config.json 的 timer 触发器周期调用；也可手动调用做一次性对账。
//
// 覆盖两类兜底：
//   1) 已付款但发货失败：扫 fulfill_failures(resolved=false) → 确认订单 paid → 幂等补发 → 标记 resolved。
//   2) 回调/推送丢失导致订单卡 pending：对超过宽限期仍 pending 的单【服务端主动查单】确认是否已付：
//        · 微信支付(cloudPay, source='wxpay')：cloud.cloudPay({appid}).queryOrder → trade_state==='SUCCESS'
//        · 虚拟支付(source='virtual')：POST /xpay/query_order → order.status===2(已支付待发货)/3/4(已发货)
//      查到已付 → 条件翻单 pending→paid 并补发货（与正式回调同一套幂等逻辑）。
//
// ⚠️ 依赖云函数环境变量（与 createPayOrder/createVirtualPayOrder 一致，勿硬编码密钥）：
//    WX_APPID / WX_APPSECRET（access_token）、WXPAY_SUB_MCH_ID（cloudPay 查单）、
//    VIRTUAL_PAY_APPKEY(/_SANDBOX) + VIRTUAL_PAY_ENV（虚拟支付 pay_sig / env）。
// ⚠️ 虚拟支付查单的 order_id：官方文档未明确「order_id 是否=商户 out_trade_no」，按上下文推断用 out_trade_no；
//    上线前务必在沙箱用真实单核对一次，若平台另有订单号需改用 wx_order_id（本兜底对纯 pending 单无 wx_order_id，
//    届时只能依赖发货推送，详见说明）。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const crypto = require('crypto');
const https = require('https');

const db = cloud.database();
const _ = db.command;
const fulfill = require('./lib/fulfill');

const WX_APPID = process.env.WX_APPID || 'wxa7c9920cda26d7ca';
const WX_APPSECRET = process.env.WX_APPSECRET || '';
const SUB_MCH_ID = process.env.WXPAY_SUB_MCH_ID || '';
const PAY_ENV = String(process.env.VIRTUAL_PAY_ENV || '0') === '1' ? 1 : 0;
const APPKEY = PAY_ENV === 1 ? (process.env.VIRTUAL_PAY_APPKEY_SANDBOX || '') : (process.env.VIRTUAL_PAY_APPKEY || '');
const PENDING_GRACE_MS = 10 * 60 * 1000; // 仅查超过 10 分钟仍 pending 的单，给正常回调留时间

function genNonce() { return crypto.randomBytes(16).toString('hex'); }

function httpsJson(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(url);
    const req = https.request({
      method, hostname: u.hostname, path: u.pathname + u.search,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// access_token（小程序普通 token），缓存在 wx_access_token 集合，提前 60s 过期刷新
async function getAccessToken() {
  const col = db.collection('wx_access_token');
  const now = Date.now();
  try {
    const r = await col.doc('mp').get();
    if (r.data && r.data.token && r.data.expireAt && r.data.expireAt > now + 60000) return r.data.token;
  } catch (e) { /* 不存在，继续获取 */ }
  const res = await httpsJson('GET',
    'https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=' + WX_APPID + '&secret=' + WX_APPSECRET);
  if (!res || !res.access_token) throw new Error('get access_token failed: ' + JSON.stringify(res));
  const token = res.access_token;
  const expireAt = now + (Number(res.expires_in || 7200) * 1000);
  try { await col.doc('mp').set({ data: { token, expireAt, updatedAt: db.serverDate() } }); }
  catch (e) { try { await col.add({ data: { _id: 'mp', token, expireAt, updatedAt: db.serverDate() } }); } catch (e2) {} }
  return token;
}

// 微信支付(cloudPay)查单：返回 { paid, totalFee, transactionId }
async function queryWxpayOrder(order) {
  const q = await cloud.cloudPay({ appid: WX_APPID }).queryOrder({
    sub_mch_id: SUB_MCH_ID, out_trade_no: order.outTradeNo, nonce_str: genNonce()
  });
  const ret = q && (q.returnCode || q.return_code);
  const result = q && (q.resultCode || q.result_code);
  const state = q && (q.tradeState || q.trade_state);
  const paid = ret === 'SUCCESS' && result === 'SUCCESS' && state === 'SUCCESS';
  return { paid, totalFee: Number((q && (q.totalFee || q.total_fee)) || 0), transactionId: (q && (q.transactionId || q.transaction_id)) || '' };
}

// 虚拟支付查单：返回 { paid, orderFee, transactionId }
async function queryVirtualOrder(order) {
  if (!APPKEY) throw new Error('virtual appkey missing');
  const token = await getAccessToken();
  const uri = '/xpay/query_order';
  const body = { openid: order._openid, env: PAY_ENV, order_id: order.outTradeNo }; // ⚠️ order_id=out_trade_no 为文档推断，需沙箱核对
  const post = JSON.stringify(body);
  const paySig = crypto.createHmac('sha256', APPKEY).update(uri + '&' + post).digest('hex');
  const url = 'https://api.weixin.qq.com' + uri + '?access_token=' + token + '&pay_sig=' + paySig;
  const r = await httpsJson('POST', url, body);
  const o = r && r.order;
  // status: 2=已支付待发货, 3=发货中, 4=已发货 → 均视为已付
  const paid = !!(r && r.errcode === 0 && o && [2, 3, 4].indexOf(Number(o.status)) !== -1);
  return { paid, orderFee: Number((o && o.order_fee) || 0), transactionId: '' };
}

// 确认已付 → 条件翻单 pending→paid 并补发货（与正式回调同一套幂等/补偿逻辑）
async function markPaidAndFulfill(order, transactionId) {
  const flip = await db.collection('orders').where({ _id: order._id, status: 'pending' }).update({
    data: { paid: true, status: 'paid', transactionId: transactionId || order.transactionId || '', paidAt: db.serverDate(), paidBy: 'reconcile' }
  });
  if (!flip.stats || flip.stats.updated === 0) return; // 已被正式回调处理
  try {
    const userRes = await db.collection('users').where({ _openid: order._openid }).limit(1).get();
    if (userRes.data.length) {
      const user = userRes.data[0];
      const perRole = (user.per_role && typeof user.per_role === 'object') ? user.per_role : {};
      const current = (perRole[order.role] && typeof perRole[order.role] === 'object') ? perRole[order.role] : {};
      const now = Date.now();
      const planExpiresAt = fulfill.computeExpiry({ current, planKey: order.planKey, period: order.period, now });
      await fulfill.applyEntitlement({ db, userId: user._id, perRole, role: order.role, planKey: order.planKey, period: order.period, planExpiresAt, now });
    }
  } catch (err) {
    console.error('[reconcilePay] fulfill after query failed', order.outTradeNo, err);
    try {
      await db.collection('fulfill_failures').add({ data: {
        outTradeNo: order.outTradeNo, _openid: order._openid, source: order.source || '',
        planKey: order.planKey, role: order.role, period: order.period,
        transactionId: transactionId || '', error: String((err && err.message) || err), resolved: false, createdAt: db.serverDate()
      } });
    } catch (e2) {}
  }
}

// 补偿一：已付款但发货失败（fulfill_failures）
async function retryFulfillFailures() {
  const res = await db.collection('fulfill_failures').where({ resolved: false }).limit(50).get();
  let fixed = 0, skipped = 0, failed = 0;
  for (const f of res.data) {
    const claim = await db.collection('fulfill_failures').where({ _id: f._id, resolved: false })
      .update({ data: { resolved: true, resolvedAt: db.serverDate() } });
    if (!claim.stats || claim.stats.updated === 0) { skipped += 1; continue; }
    try {
      const ordRes = await db.collection('orders').where({ outTradeNo: f.outTradeNo }).limit(1).get();
      const order = ordRes.data[0];
      if (!order || !(order.paid === true || order.status === 'paid')) { skipped += 1; continue; }
      const userRes = await db.collection('users').where({ _openid: f._openid }).limit(1).get();
      if (!userRes.data.length) { skipped += 1; continue; }
      const user = userRes.data[0];
      const perRole = (user.per_role && typeof user.per_role === 'object') ? user.per_role : {};
      const current = (perRole[f.role] && typeof perRole[f.role] === 'object') ? perRole[f.role] : {};
      const now = Date.now();
      const planExpiresAt = fulfill.computeExpiry({ current, planKey: f.planKey, period: f.period, now });
      await fulfill.applyEntitlement({ db, userId: user._id, perRole, role: f.role, planKey: f.planKey, period: f.period, planExpiresAt, now });
      fixed += 1;
    } catch (e) {
      failed += 1;
      console.error('[reconcilePay] retry fulfill failed', f.outTradeNo, e);
      try {
        await db.collection('fulfill_failures').doc(f._id).update({
          data: { resolved: false, attempts: _.inc(1), lastError: String((e && e.message) || e), lastTriedAt: db.serverDate() }
        });
      } catch (e2) { console.error('[reconcilePay] reopen failure record failed', f._id, e2); }
    }
  }
  return { scanned: res.data.length, fixed, skipped, failed };
}

// 补偿二：卡 pending 的单主动查单补发
async function reconcilePendingOrders() {
  const cutoff = Date.now() - PENDING_GRACE_MS;
  const res = await db.collection('orders').where({ status: 'pending' }).orderBy('createdAt', 'asc').limit(50).get();
  let checked = 0, paid = 0, stillPending = 0, errors = 0;
  for (const order of res.data) {
    const created = order.createdAt ? new Date(order.createdAt).getTime() : 0;
    if (created && created > cutoff) continue; // 太新，留给正常回调
    checked += 1;
    try {
      let q;
      if (order.source === 'wxpay') q = await queryWxpayOrder(order);
      else if (order.source === 'virtual') q = await queryVirtualOrder(order);
      else { stillPending += 1; continue; }
      // 金额核对：查得金额与本地下单金额不一致则不发货（防错单）
      const remoteFee = order.source === 'wxpay' ? q.totalFee : q.orderFee;
      if (q.paid && order.totalFee && remoteFee && order.totalFee !== remoteFee) {
        console.error('[reconcilePay] amount mismatch, skip', order.outTradeNo, { expect: order.totalFee, got: remoteFee });
        errors += 1; continue;
      }
      if (!q.paid) { stillPending += 1; continue; }
      await markPaidAndFulfill(order, q.transactionId);
      paid += 1;
    } catch (e) {
      errors += 1;
      console.error('[reconcilePay] query pending failed', order.outTradeNo, e);
    }
  }
  return { checked, paid, stillPending, errors };
}

exports.main = async () => {
  return { ok: false, code: 'PRODUCT_RETIRED', retryable: false };
};

const { guardClientRequest } = require('./lib/auth/protocol-guard');
const protocolGuardedMain = exports.main;

exports.main = async (event = {}, ...args) => {
  const gate = await guardClientRequest({
    db,
    event,
    supportedSchemaVersions: [1]
  });
  if (!gate.ok) return gate;
  let businessEvent = event;
  if (Object.prototype.hasOwnProperty.call(event, 'authProtocol')) {
    businessEvent = { ...event };
    delete businessEvent.authProtocol;
  }
  return protocolGuardedMain(businessEvent, ...args);
};
