// 共享计费 / 发货逻辑 —— 复制自 cloudfunctions/_shared/billing/fulfill.js（改动改源再同步，勿单独改）。
const DAY_MS = 24 * 60 * 60 * 1000;

const PLANS = {
  shop_lite: { role: 'shop', level: 1, prices: { month: 69, quarter: 189, year: 588 } },
  shop_basic: { role: 'shop', level: 2, prices: { month: 239, quarter: 599, year: 1980 } },
  shop_pro: { role: 'shop', level: 3, prices: { month: 599, quarter: 1499, year: 4980 }, grandfatherYear: 3980 },
  shop_chain: { role: 'shop', level: 4, prices: { year: 9800 } }
};
const PERIOD_MS = { month: 30 * DAY_MS, quarter: 91 * DAY_MS, year: 365 * DAY_MS };
const VALID_ROLES = ['member', 'coach', 'shop'];
const GRANDFATHER_CUTOFF = 0;

function normRole(role) {
  return VALID_ROLES.indexOf(role) !== -1 ? role : '';
}
function normPeriod(period) {
  return PERIOD_MS[period] ? period : 'year';
}

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

function yuanToFen(yuan) {
  return Math.round((Number(yuan) || 0) * 100);
}

function computeExpiry({ current, planKey, period, now }) {
  const per = normPeriod(period);
  const cur = current || {};
  const currentExpires = cur.planExpiresAt || 0;
  const base = (cur.plan === planKey && currentExpires > now) ? currentExpires : now;
  return base + PERIOD_MS[per];
}

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
