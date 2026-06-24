const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const DAY_MS = 24 * 60 * 60 * 1000;

// 套餐与计费（与前端 utils/billing.js 对齐）
// 注意：价格以服务端为防篡改兜底事实源；周期 period = month/quarter/year
const PLANS = {
  shop_lite: { role: 'shop', level: 1, prices: { month: 59, quarter: 159, year: 588 } },
  shop_basic: { role: 'shop', level: 2, prices: { month: 199, quarter: 549, year: 1980 } },
  shop_pro: { role: 'shop', level: 3, prices: { month: 499, quarter: 1350, year: 4980 }, grandfatherYear: 3980 }
};
const PERIOD_MS = {
  month: 30 * DAY_MS,
  quarter: 91 * DAY_MS,
  year: 365 * DAY_MS
};
const VALID_ROLES = ['member', 'coach', 'shop'];

// 老客保护价生效截止时间戳：上线前已购 shop_pro 的店主续费按老价 ¥3980/年。
// 0 = 未启用；上线时把它设为上线日的毫秒时间戳即可生效。
const GRANDFATHER_CUTOFF = 0;

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const planKey = String(event.planKey || '');
  const role = VALID_ROLES.indexOf(event.role) !== -1 ? event.role : '';
  const period = PERIOD_MS[event.period] ? event.period : 'year';

  // 1) 套餐校验
  const plan = PLANS[planKey];
  if (!plan) {
    return { ok: false, code: 'INVALID_PLAN', msg: '套餐不存在' };
  }
  if (plan.role !== role) {
    return { ok: false, code: 'ROLE_MISMATCH', msg: '套餐与角色不匹配' };
  }
  let amount = plan.prices[period] || plan.prices.year;

  // 2) 找用户记录
  const users = db.collection('users');
  const found = await users.where({ _openid: OPENID }).get();
  if (!found.data.length) {
    return { ok: false, code: 'USER_NOT_FOUND', msg: '请先登录' };
  }
  const user = found.data[0];

  // 3) 老客保护价：上线前已购 shop_pro 且为包年续费 → 按 ¥3980/年
  const now = Date.now();
  const perRole = (user.per_role && typeof user.per_role === 'object') ? user.per_role : {};
  const current = (perRole[role] && typeof perRole[role] === 'object') ? perRole[role] : {};
  if (
    planKey === 'shop_pro' && period === 'year' && plan.grandfatherYear &&
    GRANDFATHER_CUTOFF > 0 && current.plan === 'shop_pro' &&
    current.upgradedAt && current.upgradedAt < GRANDFATHER_CUTOFF
  ) {
    amount = plan.grandfatherYear;
  }

  // 4) 计算到期：续期累加 / 首次从 now
  const currentExpires = current.planExpiresAt || 0;
  const base = (current.plan === planKey && currentExpires > now) ? currentExpires : now;
  const planExpiresAt = base + PERIOD_MS[period];

  // 5) 落库
  const updateData = {
    per_role: Object.assign({}, perRole, {
      [role]: Object.assign({}, current, {
        plan: planKey,
        period,
        planExpiresAt,
        upgradedAt: now
      })
    }),
    updatedAt: db.serverDate()
  };
  await users.doc(user._id).update({ data: updateData });

  // 6) 写订单留痕（demo 期 paid=true；接真支付后改 paid=false，回调再置 true）
  try {
    await db.collection('orders').add({
      data: {
        _openid: OPENID,
        planKey,
        role,
        period,
        amount,
        paid: true,
        source: 'demo',
        createdAt: db.serverDate()
      }
    });
  } catch (err) {
    console.warn('write order failed', err);
  }

  return {
    ok: true,
    plan: planKey,
    role,
    period,
    planExpiresAt,
    amount
  };
};
