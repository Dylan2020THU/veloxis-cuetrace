// 共享计费 / 发货逻辑 —— 单一真相源。
// 部署约定：本文件是"源"，需复制到用到它的各云函数目录下的 lib/fulfill.js
//   （upgradePlan / createVirtualPayOrder / virtualPayCallback）。
//   云函数各自独立打包、不共享 node_modules，故采用"源 + 复制"方式。
//   ⚠️ 改动只改本文件，再同步覆盖三处 lib/fulfill.js，避免漂移。

const DAY_MS = 24 * 60 * 60 * 1000;

// 套餐与价格（与前端 utils/billing.js 对齐；服务端为防篡改事实源）
const PLANS = {
  shop_lite: { role: 'shop', level: 1, prices: { month: 69, quarter: 189, year: 588 } },
  shop_basic: { role: 'shop', level: 2, prices: { month: 239, quarter: 599, year: 1980 } },
  shop_pro: { role: 'shop', level: 3, prices: { month: 599, quarter: 1499, year: 4980 }, grandfatherYear: 3980 },
  shop_chain: { role: 'shop', level: 4, prices: { year: 9800 } }
};
const PERIOD_MS = { month: 30 * DAY_MS, quarter: 91 * DAY_MS, year: 365 * DAY_MS };
const VALID_ROLES = ['member', 'coach', 'shop'];

// 老客保护价生效截止时间戳：上线前已购 shop_pro 的店主续费按老价 ¥3980/年。
// 0 = 未启用；上线时设为上线日毫秒时间戳。
const GRANDFATHER_CUTOFF = 0;

function normRole(role) {
  return VALID_ROLES.indexOf(role) !== -1 ? role : '';
}
function normPeriod(period) {
  return PERIOD_MS[period] ? period : 'year';
}

// 服务端算价（防篡改）。current 为该角色当前订阅记录(可空)，用于老客价判定。
// 返回 { ok, amount(元), period } 或 { ok:false, code }
function computeAmountYuan({ planKey, role, period, current }) {
  const plan = PLANS[planKey];
  if (!plan) return { ok: false, code: 'INVALID_PLAN' };
  if (plan.role !== role) return { ok: false, code: 'ROLE_MISMATCH' };
  const per = normPeriod(period);
  let amount = plan.prices[per] || plan.prices.year;
  const cur = current || {};
  if (
    planKey === 'shop_pro' && per === 'year' && plan.grandfatherYear &&
    GRANDFATHER_CUTOFF > 0 && cur.plan === 'shop_pro' &&
    cur.upgradedAt && cur.upgradedAt < GRANDFATHER_CUTOFF
  ) {
    amount = plan.grandfatherYear;
  }
  return { ok: true, amount, period: per };
}

// 元 → 分（微信/虚拟支付金额单位为分）
function yuanToFen(yuan) {
  return Math.round((Number(yuan) || 0) * 100);
}

// 计算到期：同档未过期续费在原到期日累加，否则从 now 起算
function computeExpiry({ current, planKey, period, now }) {
  const per = normPeriod(period);
  const cur = current || {};
  const currentExpires = cur.planExpiresAt || 0;
  const base = (cur.plan === planKey && currentExpires > now) ? currentExpires : now;
  return base + PERIOD_MS[per];
}

// 发货：把订阅写入 users.per_role[role]。调用方需先取到 user 与 perRole。
async function applyEntitlement({ db, userId, perRole, role, planKey, period, planExpiresAt, now }) {
  const base = (perRole && typeof perRole === 'object') ? perRole : {};
  const cur = (base[role] && typeof base[role] === 'object') ? base[role] : {};
  const updateData = {
    per_role: Object.assign({}, base, {
      [role]: Object.assign({}, cur, {
        plan: planKey,
        period: normPeriod(period),
        planExpiresAt,
        upgradedAt: now
      })
    }),
    updatedAt: db.serverDate()
  };
  await db.collection('users').doc(userId).update({ data: updateData });
  return planExpiresAt;
}

module.exports = {
  DAY_MS, PLANS, PERIOD_MS, VALID_ROLES, GRANDFATHER_CUTOFF,
  normRole, normPeriod, computeAmountYuan, yuanToFen, computeExpiry, applyEntitlement
};
