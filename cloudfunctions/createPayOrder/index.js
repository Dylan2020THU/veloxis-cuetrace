// 基础支付（微信支付·JSAPI/小程序支付）下单 —— 云开发 cloudPay 方式（免证书）。
// ⚠️ AI 参考微信支付官方 Java 示例 + 云开发 cloudPay 文档翻译生成，非官方维护。
//    请开发人员自行审查逻辑，上线前充分测试，AI 不对生成代码正确性负责。
//
// 官方流程：JSAPI/小程序下单(4012791897) → 返回 payment 给前端 wx.requestPayment(4012791898)。
// cloudPay：商户号在云开发控制台绑定，签名/证书由平台托管；支付结果回调走 functionName 指定的云函数。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const fulfill = require('./lib/fulfill');

const SUB_MCH_ID = process.env.WXPAY_SUB_MCH_ID || '';                 // 你的微信支付商户号(mchid)，需在云开发控制台绑定
const ENV_ID = process.env.WXPAY_ENV_ID || 'cloud1-d4g2abcud02b40531'; // 当前云环境ID（回调云函数所在环境）
const CALLBACK_FN = process.env.WXPAY_CALLBACK_FN || 'payCallback';     // 支付结果回调云函数名

const PLAN_LABEL = { shop_lite: '启航版', shop_basic: '标准版', shop_pro: '旗舰版' };
const PERIOD_LABEL = { month: '包月', quarter: '包季', year: '包年' };

function genNonceStr() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
function genOutTradeNo(openid) {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  const ts = '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  const tail = String(openid || '').slice(-6).replace(/[^0-9A-Za-z]/g, '0');
  const rand = Math.random().toString(36).slice(2, 6);
  return ('CT' + ts + tail + rand).slice(0, 32);
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const planKey = String(event.planKey || '');
  const role = fulfill.normRole(event.role);
  const period = fulfill.normPeriod(event.period);

  // 1) 取用户与当前订阅
  const users = db.collection('users');
  const found = await users.where({ _openid: OPENID }).get();
  if (!found.data.length) return { ok: false, code: 'USER_NOT_FOUND', msg: '请先登录' };
  const user = found.data[0];
  const perRole = (user.per_role && typeof user.per_role === 'object') ? user.per_role : {};
  const current = (perRole[role] && typeof perRole[role] === 'object') ? perRole[role] : {};

  // 2) 服务端算价（防篡改）→ 分
  const priced = fulfill.computeAmountYuan({ planKey, role, period, current });
  if (!priced.ok) return { ok: false, code: priced.code, msg: '套餐校验失败' };
  const totalFee = fulfill.yuanToFen(priced.amount); // 单位：分

  // 3) 复用未支付订单（防连点多单）或新建 pending
  const orders = db.collection('orders');
  const reuse = await orders.where({ _openid: OPENID, planKey, period, status: 'pending', source: 'wxpay' })
    .orderBy('createdAt', 'desc').limit(1).get();
  let outTradeNo;
  if (reuse.data.length) {
    outTradeNo = reuse.data[0].outTradeNo;
  } else {
    outTradeNo = genOutTradeNo(OPENID);
    await orders.add({
      data: {
        outTradeNo, _openid: OPENID, planKey, role, period,
        amount: priced.amount, totalFee, paid: false, status: 'pending',
        source: 'wxpay', createdAt: db.serverDate()
      }
    });
  }

  // 4) cloudPay 统一下单（JSAPI）。totalFee 单位：分。
  const body = '强化杆迹-' + (PLAN_LABEL[planKey] || planKey) + (PERIOD_LABEL[period] || period);
  let res;
  try {
    res = await cloud.cloudPay.unifiedOrder({
      body,
      outTradeNo,
      spbillCreateIp: '127.0.0.1',
      subMchId: SUB_MCH_ID,
      totalFee,
      envId: ENV_ID,
      functionName: CALLBACK_FN,
      nonceStr: genNonceStr(),
      tradeType: 'JSAPI',
      openid: OPENID
    });
  } catch (e) {
    console.error('[createPayOrder] unifiedOrder failed', e);
    return { ok: false, code: 'UNIFIED_ORDER_FAIL', msg: (e && e.errMsg) || '下单失败' };
  }

  // res.payment 即 wx.requestPayment 所需参数（timeStamp/nonceStr/package/signType/paySign）
  if (!res || !res.payment) {
    return { ok: false, code: 'NO_PAYMENT', msg: '下单返回异常', raw: res };
  }
  return { ok: true, outTradeNo, payment: res.payment };
};
