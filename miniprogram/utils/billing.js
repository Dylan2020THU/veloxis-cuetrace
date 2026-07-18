// 旧计费兼容接口：店主功能现已全部免费，历史套餐结构仅供旧数据读取。
//   店主：启航版 shop_lite < 标准版 shop_basic < 旗舰版 shop_pro < 连锁版 shop_chain（按 level 链式覆盖）
//   自助三档支持 包月/包季/包年，期越长越优惠（年付约 7 折）；首月免费试用。
//   连锁版含 5 门店、6 店起面议，按年订阅、不进自助付费墙（getPlanList），由商务侧促成下单。

const DAY_MS = 24 * 60 * 60 * 1000;

// 首月免费试用：30 天
const TRIAL_MS = 30 * DAY_MS;

// 新建及当前未结算教练业务不收取平台佣金。
const COACH_COMMISSION_RATE = 0;

// 订阅周期时长（毫秒）：月=30天 / 季=91天 / 年=365天
const PERIOD_MS = {
  month: 30 * DAY_MS,
  quarter: 91 * DAY_MS,
  year: 365 * DAY_MS
};

const PAYMENT_MODES = ['one_time', 'recurring'];

function normPaymentMode(paymentMode) {
  return PAYMENT_MODES.indexOf(paymentMode) !== -1 ? paymentMode : 'one_time';
}

// 店主四档：启航 < 标准 < 旗舰 < 连锁（level 高档含低档全部能力）
// periodOptions：单月 / 单季 / 单年；recurringOptions：包月 / 包季 / 包年，价格更优惠。
const PLANS = {
  free: { key: 'free', label: '免费', role: 'shop', level: 0, periodOptions: [] },
  shop_lite: {
    key: 'shop_lite',
    label: '启航版',
    role: 'shop',
    level: 1,
    periodOptions: [
      { period: 'month', price: 79, label: '单月', paymentMode: 'one_time' },
      { period: 'quarter', price: 219, label: '单季', paymentMode: 'one_time', discount: '约 9.2 折' },
      { period: 'year', price: 708, label: '单年', paymentMode: 'one_time', discount: '约 7.5 折' }
    ],
    recurringOptions: [
      { period: 'month', price: 69, label: '包月', paymentMode: 'recurring', discount: '省 ¥10/月' },
      { period: 'quarter', price: 189, label: '包季', paymentMode: 'recurring', discount: '约 8 折' },
      { period: 'year', price: 588, label: '包年', paymentMode: 'recurring', discount: '约 6.2 折' }
    ]
  },
  shop_basic: {
    key: 'shop_basic',
    label: '标准版',
    role: 'shop',
    level: 2,
    periodOptions: [
      { period: 'month', price: 269, label: '单月', paymentMode: 'one_time' },
      { period: 'quarter', price: 699, label: '单季', paymentMode: 'one_time', discount: '约 8.7 折' },
      { period: 'year', price: 2388, label: '单年', paymentMode: 'one_time', discount: '约 7.4 折' }
    ],
    recurringOptions: [
      { period: 'month', price: 239, label: '包月', paymentMode: 'recurring', discount: '省 ¥30/月' },
      { period: 'quarter', price: 599, label: '包季', paymentMode: 'recurring', discount: '约 7.4 折' },
      { period: 'year', price: 1980, label: '包年', paymentMode: 'recurring', discount: '约 6.1 折' }
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
      { period: 'month', price: 699, label: '单月', paymentMode: 'one_time' },
      { period: 'quarter', price: 1799, label: '单季', paymentMode: 'one_time', discount: '约 8.6 折' },
      { period: 'year', price: 5988, label: '单年', paymentMode: 'one_time', discount: '约 7.1 折' }
    ],
    recurringOptions: [
      { period: 'month', price: 599, label: '包月', paymentMode: 'recurring', discount: '省 ¥100/月' },
      { period: 'quarter', price: 1499, label: '包季', paymentMode: 'recurring', discount: '约 7.1 折' },
      { period: 'year', price: 4980, label: '包年', paymentMode: 'recurring', discount: '约 5.9 折' }
    ]
  },
  shop_chain: {
    key: 'shop_chain',
    label: '连锁版',
    role: 'shop',
    level: 4,
    // 连锁版：含 5 门店，6 店起面议；按年订阅。不进自助付费墙（getPlanList），由商务侧促成下单。
    periodOptions: [
      { period: 'year', price: 11800, label: '单年', paymentMode: 'one_time', discount: '含 5 门店' }
    ],
    recurringOptions: [
      { period: 'year', price: 9800, label: '包年', paymentMode: 'recurring', discount: '含 5 门店' }
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
  'shop.coachStats': 'shop_pro',     // 教练学员深度分析
  'shop.coachSettle': 'shop_basic'   // 教练结算（标准版起）
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
  return true;
}

// 旧套餐判断兼容接口：商品退休后始终放行。
function hasPlan(planKey) {
  return true;
}

// 旧功能权限兼容接口：商品退休后始终放行。
function canUse(feature) {
  return true;
}

// 旧付费墙兼容接口：不展示界面，始终放行。
function requirePlan(opts) {
  return Promise.resolve(true);
}

// 旧套餐列表兼容接口：退休商品不再提供购买选项。
function getPlanList(role) {
  return [];
}

// 旧购买周期兼容接口：退休商品不再提供购买选项。
function getPlanOptions(planKey, paymentMode) {
  return [];
}

// 给付费墙组件 / data.js 使用：计算某套餐在某周期下的实付价
// period 取 month/quarter/year，缺省 year；找不到返回 0
function getPlanPrice(planKey, period, paymentMode) {
  const opts = getPlanOptions(planKey, paymentMode);
  if (!opts.length) return 0;
  const wanted = PERIOD_MS[period] ? period : 'year';
  const opt = opts.find((o) => o.period === wanted);
  if (opt) return opt.price;
  return opts[0].price;
}

// 给付费墙组件使用：套餐入门价（最低周期价，用于卡片"起"展示）
function getPlanEntryPrice(planKey, paymentMode) {
  const opts = getPlanOptions(planKey, paymentMode);
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
    'shop.marketing': '营销工具',
    'shop.coachSettle': '教练结算'
  };
  return map[feature] || feature;
}

// 旧佣金计算兼容接口：新业务始终返回 0。
function calcCoachCommission(amount) {
  const a = Number(amount) || 0;
  if (a <= 0) return 0;
  return Math.round(a * COACH_COMMISSION_RATE * 100) / 100;
}

module.exports = {
  TRIAL_MS,
  PERIOD_MS,
  PAYMENT_MODES,
  COACH_COMMISSION_RATE,
  PLANS,
  FEATURE_TO_PLAN,
  normPaymentMode,
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
