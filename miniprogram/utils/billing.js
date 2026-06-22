// 收费 / 试用 权限核心
// 设计原则：
//   1) 试用起点：用户首次"完成角色选择并登录成功"的时间戳（firstLoginAt）
//   2) 试期内：canUse() 一律返回 true，不弹任何付费墙
//   3) 试用期外：按 feature key 映射到所需 plan 档位，缺档位则 requirePlan() 弹墙
//   4) 入口统一在 data.js：本文件不直接读写 storage，便于后续切云端

// 30 天 = 30 * 24 * 60 * 60 * 1000
const TRIAL_MS = 30 * 24 * 60 * 60 * 1000;

// 平台对教练课时成交的抽佣费率（低抽佣定位，5%）。
// 轻量实现：成交时按此费率算出平台服务费并记录/展示，暂不接微信真实分账。
const COACH_COMMISSION_RATE = 0.05;

// 套餐档位（与 data.js mock 存储、付费墙展示统一）
// price 为 1 年原价；termOptions 为可选年限与折扣后总价
const PLANS = {
  free: { key: 'free', label: '免费', price: 0, termOptions: [] },
  // 【已停用】球员改免费、教练改低抽佣后，以下两档不再用于付费墙；保留定义仅供回滚。
  player_pro: {
    key: 'player_pro',
    label: '球员会员',
    price: 98,
    role: 'member',
    termOptions: [
      { term: 1, years: 1, price: 98, label: '1 年' },
      { term: 2, years: 2, price: 176, label: '2 年', discount: '9 折' },
      { term: 3, years: 3, price: 235, label: '3 年', discount: '8 折' }
    ]
  },
  coach_pro: {
    key: 'coach_pro',
    label: '教练专业版',
    price: 980,
    role: 'coach',
    termOptions: [
      { term: 1, years: 1, price: 980, label: '1 年' },
      { term: 2, years: 2, price: 1764, label: '2 年', discount: '9 折' },
      { term: 3, years: 3, price: 2352, label: '3 年', discount: '8 折' }
    ]
  },
  shop_basic: {
    key: 'shop_basic',
    label: '店主基础版',
    price: 1980,
    role: 'shop',
    termOptions: [
      { term: 1, years: 1, price: 1980, label: '1 年' },
      { term: 2, years: 2, price: 3564, label: '2 年', discount: '9 折' },
      { term: 3, years: 3, price: 4752, label: '3 年', discount: '8 折' }
    ]
  },
  shop_pro: {
    key: 'shop_pro',
    label: '店主专业版',
    price: 3980,
    role: 'shop',
    termOptions: [
      { term: 1, years: 1, price: 3980, label: '1 年' },
      { term: 2, years: 2, price: 7164, label: '2 年', discount: '9 折' },
      { term: 3, years: 3, price: 9552, label: '3 年', discount: '8 折' }
    ]
  }
};

// 功能 → 所需套餐（缺省即免费；高套餐包含低套餐能力）
// key 命名：<role>.<feature>
// 定价模型：店主付费、球员免费、教练低抽佣。
//   球员端：全部功能免费（作为流量入口，不设墙）；
//   教练端：改为按课时成交抽佣（见 COACH_COMMISSION_RATE），功能不再用订阅墙拦截；
//   故 member.* / coach.* 不再列入收费清单——canUse() 对未列入项一律放行。
const FEATURE_TO_PLAN = {
  // 店主端（唯一订阅付费方）
  'shop.report': 'shop_pro',            // 经营数据报表
  'shop.memberMgmt': 'shop_basic',      // 会员管理
  'shop.coachStats': 'shop_pro',        // 教练学员分析
  'shop.multiStore': 'shop_pro',        // 多门店
  'shop.marketing': 'shop_pro'          // 营销工具
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

// 是否在 7 天试期内
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

// 当前已购套餐是否在有效期内（free 视为"长期有效"返回 false，方便区分）
function isPlanActive(planKey) {
  if (!planKey || planKey === 'free') return true;
  const { plan, planExpiresAt } = getState();
  if (plan === 'free' || !planExpiresAt) return false;
  if (Date.now() >= planExpiresAt) return false;
  // 直接持有
  if (plan === planKey) return true;
  // 升级覆盖：shop_pro 含 shop_basic
  if (planKey === 'shop_basic' && plan === 'shop_pro') return true;
  return false;
}

// 是否已购买某档（高套餐覆盖低套餐：shop_pro 含 shop_basic）
// 关键：会查 planExpiresAt，过期即视为无；让 requirePlan 走自然拦截
function hasPlan(planKey) {
  if (!planKey || planKey === 'free') return true;
  const { plan, planExpiresAt } = getState();
  if (plan === 'free' || !planExpiresAt) return false;
  if (Date.now() >= planExpiresAt) return false;
  if (plan === planKey) return true;
  if (planKey === 'shop_basic' && plan === 'shop_pro') return true;
  return false;
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
    // 通过全局事件 / 自定义组件订阅
    const app = getApp();
    if (app && app.paywall) {
      app.paywall({ feature: opts.feature, planKey, role, title: opts.title, from: from || '' }, (ok) => {
        resolve(!!ok);
      });
    } else {
      // 降级：toast 提示
      wx.showModal({
        title: '该功能需升级',
        content: `${plan.label}（¥${plan.price}/年）后可使用`,
        confirmText: '去看看',
        cancelText: '暂不开通',
        success: (res) => resolve(!!res.confirm),
        fail: () => resolve(false)
      });
    }
  });
}

// 给付费墙组件使用：返回当前端的所有套餐（含价格）
function getPlanList(role) {
  // 球员免费、教练改抽佣：均不再展示订阅档；仅店主有付费套餐。
  if (role === 'shop') return [PLANS.shop_basic, PLANS.shop_pro];
  return [];
}

// 给付费墙组件使用：返回指定套餐的可选年限（默认 1/2/3 年）
function getPlanOptions(planKey) {
  const p = PLANS[planKey];
  if (!p || !p.termOptions || !p.termOptions.length) {
    return [{ term: 1, years: 1, price: p ? p.price : 0, label: '1 年' }];
  }
  return p.termOptions;
}

// 给付费墙组件 / data.js 使用：计算某套餐在某年限下的实付价
// 缺省 term=1 时返回 1 年原价；找不到 planKey 时返回 0
function getPlanPrice(planKey, term) {
  const p = PLANS[planKey];
  if (!p) return 0;
  const t = Number(term) || 1;
  if (p.termOptions && p.termOptions.length) {
    const opt = p.termOptions.find((o) => o.term === t);
    if (opt) return opt.price;
    return p.termOptions[0].price;
  }
  return p.price * t;
}

// 给付费墙组件使用：人类可读的功能名
function getFeatureLabel(feature) {
  const map = {
    'member.bookTable': '在线预约球桌',
    'member.bookCoach': '在线预约教练',
    'member.aiAnalysis': 'AI 训练数据分析',
    'coach.memberMgmt': '学员管理与训练记录',
    'coach.stats': '课时与收入统计',
    'coach.marketing': '营销海报',
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
  COACH_COMMISSION_RATE,
  PLANS,
  FEATURE_TO_PLAN,
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
  getFeatureLabel
};
