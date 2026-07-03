const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const fulfill = require('./lib/fulfill');

// 演示 / 人工开通入口：直接发货（不收钱）。
// 真实付费走 createVirtualPayOrder → wx.requestVirtualPayment → virtualPayCallback（凭支付结果发货）。
// 发货/算价逻辑统一在 lib/fulfill.js，三处复用，避免漂移。
exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const planKey = String(event.planKey || '');
  const role = fulfill.normRole(event.role);
  const period = fulfill.normPeriod(event.period);
  const paymentMode = 'one_time';

  // 1) 找用户记录
  const users = db.collection('users');
  const found = await users.where({ _openid: OPENID }).get();
  if (!found.data.length) {
    return { ok: false, code: 'USER_NOT_FOUND', msg: '请先登录' };
  }
  const user = found.data[0];
  const perRole = (user.per_role && typeof user.per_role === 'object') ? user.per_role : {};
  const current = (perRole[role] && typeof perRole[role] === 'object') ? perRole[role] : {};

  // 2) 套餐校验 + 服务端算价（防篡改，含老客价）
  const priced = fulfill.computeAmountYuan({ planKey, role, period, current, paymentMode });
  if (!priced.ok) {
    return { ok: false, code: priced.code, msg: '套餐校验失败' };
  }

  // 3) 计算到期（续期累加 / 首次从 now）并发货
  const now = Date.now();
  const planExpiresAt = fulfill.computeExpiry({ current, planKey, period, now });
  await fulfill.applyEntitlement({ db, userId: user._id, perRole, role, planKey, period, planExpiresAt, now, paymentMode });

  // 4) 写订单留痕（demo 期 paid=true、source=demo；真实付费由 virtualPayCallback 落 paid）
  try {
    await db.collection('orders').add({
      data: {
        _openid: OPENID, planKey, role, period, paymentMode,
        amount: priced.amount, paid: true, source: 'demo', createdAt: db.serverDate()
      }
    });
  } catch (err) {
    console.warn('write order failed', err);
  }

  return { ok: true, plan: planKey, role, period, planExpiresAt, amount: priced.amount };
};
