const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

// 套餐与计费（与前端 utils/billing.js 对齐）
// 注意：价格以前端 PLANS 为唯一事实源；服务端内置一份做兜底（防被绕过篡改金额）
// 真支付接入后，本函数会要求 orderId 必传，且订单 paid=true 才放行
const PLANS = {
  player_pro: { role: 'member', termOptions: { 1: 98, 2: 176, 3: 235 } },
  coach_pro: { role: 'coach', termOptions: { 1: 980, 2: 1764, 3: 2352 } },
  shop_basic: { role: 'shop', termOptions: { 1: 1980, 2: 3564, 3: 4752 } },
  shop_pro: { role: 'shop', termOptions: { 1: 3980, 2: 7164, 3: 9552 } }
};
const VALID_ROLES = ['member', 'coach', 'shop'];
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const planKey = String(event.planKey || '');
  const role = VALID_ROLES.indexOf(event.role) !== -1 ? event.role : '';
  const term = Math.max(1, Math.min(3, Number(event.term) || 1));

  // 1) 套餐校验：必须在白名单内
  const plan = PLANS[planKey];
  if (!plan) {
    return { ok: false, code: 'INVALID_PLAN', msg: '套餐不存在' };
  }
  if (plan.role !== role) {
    return { ok: false, code: 'ROLE_MISMATCH', msg: '套餐与角色不匹配' };
  }
  const amount = plan.termOptions[term] || plan.termOptions[1];

  // 2) 找用户记录
  const users = db.collection('users');
  const found = await users.where({ _openid: OPENID }).get();
  if (!found.data.length) {
    return { ok: false, code: 'USER_NOT_FOUND', msg: '请先登录' };
  }
  const user = found.data[0];

  // 3) 计算到期时间：续期累加 / 首次从 now
  const now = Date.now();
  const perRole = (user.per_role && typeof user.per_role === 'object') ? user.per_role : {};
  const current = (perRole[role] && typeof perRole[role] === 'object') ? perRole[role] : {};
  const currentExpires = current.planExpiresAt || 0;
  const base = (current.plan === planKey && currentExpires > now) ? currentExpires : now;
  const planExpiresAt = base + term * ONE_YEAR_MS;

  // 4) 落库
  const updateData = {
    per_role: Object.assign({}, perRole, {
      [role]: Object.assign({}, current, {
        plan: planKey,
        term,
        planExpiresAt,
        upgradedAt: now
      })
    }),
    updatedAt: db.serverDate()
  };
  await users.doc(user._id).update({ data: updateData });

  // 5) 写订单留痕（demo 期直接 paid=true；接真支付后改 paid=false，付款回调再置 true）
  try {
    await db.collection('orders').add({
      data: {
        _openid: OPENID,
        planKey,
        role,
        term,
        amount,
        paid: true,
        source: 'demo',
        createdAt: db.serverDate()
      }
    });
  } catch (err) {
    // orders 集合不存在不阻塞
    console.warn('write order failed', err);
  }

  return {
    ok: true,
    plan: planKey,
    role,
    term,
    planExpiresAt,
    amount
  };
};
