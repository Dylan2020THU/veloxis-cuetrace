// 收费 / 试用 权限核心
// 设计原则：
//   1) 试用起点：用户首次"完成角色选择并登录成功"的时间戳（firstLoginAt）
//   2) 试期内：canUse() 一律返回 true，不弹任何付费墙
//   3) 试用期外：按 feature key 映射到所需 plan 档位，缺档位则 requirePlan() 弹墙
//   4) 入口统一在 data.js：本文件不直接读写 storage，便于后续切云端
//
// 定价模型（2026 矩阵）：店主三档订阅、球员免费、教练 5% 低抽佣。
//   店主：启航版 shop_lite < 标准版 shop_basic < 旗舰版 shop_pro（按 level 链式覆盖）
//   每档支持 包月/包季/包年，期越长越优惠（年付约 8.3 折）；首月免费试用。

const DAY_MS = 24 * 60 * 60 * 1000;

// 首月免费试用：30 天
const TRIAL_MS = 30 * DAY_MS;

// 平台对教练课时成交的抽佣费率（低抽佣定位，5%）
const COACH_COMMISSION_RATE = 0.05;

// 订阅周期时长（毫秒）：月=30天 / 季=91天 / 年=365天
const PERIOD_MS = {
  month: 30 * DAY_MS,
  quarter: 91 * DAY_MS,
  year: 365 * DAY_MS
};

// 店主三档：启航 < 标准 < 旗舰（level 高档含低档全部能力）
// periodOptions：包月 / 包季 / 包年；年付约 8.3 折（送约 2 个月）。
const PLANS = {
  free: { key: 'free', label: '免费', role: 'shop', level: 0, periodOptions: [] },
  shop_lite: {
    key: 'shop_lite',
    label: '启航版',
    role: 'shop',
    level: 1,
    periodOptions: [
      { period: 'month', price: 59, label: '包月' },
      { period: 'quarter', price: 159, label: '包季', discount: '约 9 折' },
      { period: 'year', price: 588, label: '包年', discount: '约 8.3 折' }
    ]
  },
  shop_basic: {
    key: 'shop_basic',
    label: '标准版',
    role: 'shop',
    level: 2,
    periodOptions: [
      { period: 'month', price: 199, label: '包月' },
      { period: 'quarter', price: 549, label: '包季', discount: '约 9 折' },
      { period: 'year', price: 1980, label: '包年', discount: '约 8.3 折' }
    ]
  },
  shop_pro: {
    key: 'shop_pro',
    label: '旗舰版',
    role: 'shop',
    level: 3,
    // 老客保护价：上线前已购 shop_pro 的店主续费仍按 ¥3980/年。
    // 由云端 upgradePlan 按 upgradedAt 与上线日判定生效，前端统一展示新价。
    grandfatherYearPrice: 3980,
    periodOptions: [
      { period: 'month', price: 499, label: '包月' },
      { period: 'quarter', price: 1350, label: '包季', discount: '约 9 折' },
      { period: 'year', price: 4980, label: '包年', discount: '约 8.3 折' }
    ]
  }
};

// 功能 → 所需套餐（缺省即免费；按 level 高档覆盖低档）
// key 命名：<role>.<feature>
//   球员端：全部功能免费（不列入 = 自动放行）
//   教练端：改为按课时成交抽佣，功能不再用订阅墙拦截（不列入 = 自动放行）
const FEATURE_TO_PLAN = {
  'shop.checkin': 'shop_lite',       // 到店打卡核验（启航版起，含）
  'shop.memberMgmt': 'shop_basic',   // 完整会员体系
  'shop.report': 'shop_basic',       // 经营报表导出（标准版起，含）
  'shop.marketing': 'shop_basic',    // 营销工具
  'shop.multiStore': 'shop_pro',     // 多门店 / 连锁
  'shop.coachStats': 'shop_pro'      // 教练学员深度分析
};

// 读取全局状态：firstLoginAt / plan / planExpiresAt 由 app.js / data.js 维护
function getState() {
  const app = getApp();
  const gd = (app && app.globalData) || {};
  return {
    firstLoginAt: gd.firstLoginAt || 0,
    plan: gd.plan || 'free',
    planExpiresAt: gd.planExpiresAt || 0
  };
}

// 档位等级（用于"高档覆盖低档"判定）
function planLevel(key) {
  const p = PLANS[key];
  return p ? (p.level || 0) : 0;
}

// 是否在首月（30 天）试期内
function isInTrial() {
  const { firstLoginAt } = getState();
  if (!firstLoginAt) return false;
  return Date.now() - firstLoginAt < TRIAL_MS;
}

// 试期剩余毫秒数（用于 UI 倒计时展示）
function trialRemainingMs() {
  const { firstLoginAt } = getState();
  if (!firstLoginAt) return 0;
  const remain = TRIAL_MS - (Date.now() - firstLoginAt);
  return remain > 0 ? remain : 0;
}

// 读取当前套餐的到期时间戳（0 表示 free / 未开通）
function getPlanExpiry() {
  return getState().planExpiresAt || 0;
}

// 当前已购套餐是否在有效期内（free 视为"长期有效"返回 true）
function isPlanActive(planKey) {
  if (!planKey || planKey === 'free') return true;
  const { plan, planExpiresAt } = getState();
  if (plan === 'free' || !planExpiresAt) return false;
  if (Date.now() >= planExpiresAt) return false;
  // 高档覆盖低档：持有的档位 level ≥ 目标 level 即视为有效
  return planLevel(plan) >= planLevel(planKey);
}

// 是否已购买某档（按 level 高档覆盖低档；过期即视为无）
function hasPlan(planKey) {
  if (!planKey || planKey === 'free') return true;
  const { plan, planExpiresAt } = getState();
  if (plan === 'free' || !planExpiresAt) return false;
  if (Date.now() >= planExpiresAt) return false;
  return planLevel(plan) >= planLevel(planKey);
}

// 核心入口：判断某功能是否可用
// 规则：试期内 OR 持有该功能所需套餐 → true
function canUse(feature) {
  if (!feature) return true;
  if (isInTrial()) return true;
  const required = FEATURE_TO_PLAN[feature];
  if (!required) return true; // 未列入收费清单 = 免费
  return hasPlan(required);
}

// 用不了时，弹付费墙（仅在非试期触发）。
// 返回 Promise<boolean>：用户点了"开通"返回 true，"暂不开通"返回 false
function requirePlan(opts) {
  if (!opts || !opts.feature) return Promise.resolve(true);
  if (canUse(opts.feature)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const { role, from } = getState();
    const planKey = FEATURE_TO_PLAN[opts.feature];
    const plan = PLANS[planKey] || PLANS.free;
    const app = getApp();
    if (app && app.paywall) {
      app.paywall({ feature: opts.feature, planKey, role, title: opts.title, from: from || '' }, (ok) => {
        resolve(!!ok);
      });
    } else {
      // 降级：toast 提示（用包年价展示）
      wx.showModal({
        title: '该功能需升级',
        content: `${plan.label}（¥${getPlanPrice(planKey, 'year')}/年）后可使用`,
        confirmText: '去看看',
        cancelText: '暂不开通',
        success: (res) => resolve(!!res.confirm),
        fail: () => resolve(false)
      });
    }
  });
}

// 给付费墙组件使用：返回当前端的所有套餐（仅店主有付费档）
function getPlanList(role) {
  if (role === 'shop') return [PLANS.shop_lite, PLANS.shop_basic, PLANS.shop_pro];
  return [];
}

// 给付费墙组件使用：返回指定套餐的可选周期（包月/包季/包年）
function getPlanOptions(planKey) {
  const p = PLANS[planKey];
  if (!p || !p.periodOptions || !p.periodOptions.length) return [];
  return p.periodOptions;
}

// 给付费墙组件 / data.js 使用：计算某套餐在某周期下的实付价
// period 取 month/quarter/year，缺省 year；找不到返回 0
function getPlanPrice(planKey, period) {
  const p = PLANS[planKey];
  if (!p || !p.periodOptions || !p.periodOptions.length) return 0;
  const wanted = PERIOD_MS[period] ? period : 'year';
  const opt = p.periodOptions.find((o) => o.period === wanted);
  if (opt) return opt.price;
  return p.periodOptions[0].price;
}

// 给付费墙组件使用：套餐入门价（最低周期价，用于卡片"起"展示）
function getPlanEntryPrice(planKey) {
  const opts = getPlanOptions(planKey);
  if (!opts.length) return 0;
  return opts.reduce((min, o) => (o.price < min ? o.price : min), opts[0].price);
}

// 给付费墙组件使用：人类可读的功能名
function getFeatureLabel(feature) {
  const map = {
    'shop.checkin': '到店打卡核验',
    'shop.report': '经营数据报表',
    'shop.memberMgmt': '会员管理',
    'shop.coachStats': '教练学员分析',
    'shop.multiStore': '多门店与连锁',
    'shop.marketing': '营销工具'
  };
  return map[feature] || feature;
}

// 计算教练课时成交的平台服务费（佣金）。
// amount 为该笔课时订单总额（元）；返回四舍五入到分的佣金额（元）。
function calcCoachCommission(amount) {
  const a = Number(amount) || 0;
  if (a <= 0) return 0;
  return Math.round(a * COACH_COMMISSION_RATE * 100) / 100;
}

module.exports = {
  TRIAL_MS,
  PERIOD_MS,
  COACH_COMMISSION_RATE,
  PLANS,
  FEATURE_TO_PLAN,
  planLevel,
  calcCoachCommission,
  isInTrial,
  trialRemainingMs,
  getPlanExpiry,
  isPlanActive,
  hasPlan,
  canUse,
  requirePlan,
  getPlanList,
  getPlanOptions,
  getPlanPrice,
  getPlanEntryPrice,
  getFeatureLabel
};
