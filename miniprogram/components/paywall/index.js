// 通用付费墙组件
// 使用方式（在 Page 中）：
//   1) 模板引入：<paywall id="paywall" />
//   2) this.selectComponent('#paywall').show({ feature, planKey, role, title, from }, (ok) => {})
//   3) 或者通过 getApp().paywall(...) 全局方法（见 app.js）
//
// 配套：
//   utils/billing.js   权限判断
//   services/data.js   upgradePlan / getUserBilling

const { getPlanList, getPlanOptions, getPlanPrice, getFeatureLabel, isInTrial, trialRemainingMs, getPlanExpiry } = require('../../utils/billing');
const { upgradePlan, getUserBilling } = require('../../services/data');

// 套餐的描述文案（与 utils/billing.js 的 PLANS 对齐）
const PLAN_DESC = {
  player_pro: '解锁约球桌、约教练、训练数据分析等全部会员能力',
  coach_pro: '学员管理 · 课时统计 · 营销海报，一站式执教工具',
  shop_basic: '会员管理 · 基础经营看板，单店适用',
  shop_pro: '多门店连锁 · 经营报表 · 教练学员分析'
};

const PLAN_FEATURES = {
  player_pro: [
    '在线预约球桌与教练',
    '专属训练数据分析',
    '社区发帖、约球、组队',
    '优先客服支持'
  ],
  coach_pro: [
    '学员档案与训练记录',
    '课时收入统计与导出',
    '营销海报与约课工具',
    '学员画像与训练反馈'
  ],
  shop_basic: [
    '球房会员管理',
    '基础经营看板',
    '球桌与台型维护'
  ],
  shop_pro: [
    '多门店与连锁管理',
    '经营数据深度报表',
    '教练学员联动分析',
    '营销活动与卡券工具'
  ]
};

const ROLE_LABEL = {
  member: '球员',
  coach: '教练',
  shop: '店主'
};

Component({
  options: {
    multipleSlots: false,
    styleIsolation: 'apply-shared'
  },

  data: {
    visible: false,
    mode: 'single',           // 'single' 仅显示当前角色档位 / 'multi' 多端 tab 切换
    activeTab: 'member',
    currentRoleLabel: '',
    plans: [],                // 当前展示的套餐（含 termOptions）
    selectedPlan: '',         // 用户选中的套餐 key
    selectedTerm: 1,          // 当前选中套餐的年限（1/2/3）
    currentPlan: { key: '', label: '', price: 0, termOptions: [] }, // 选中套餐详情（CTA 展示用）
    agreed: false,
    blockedFeatureLabel: '',
    trialRemaining: 0,
    // 续费/升级/首次开通 三态区分
    ownedPlan: '',            // 用户当前已购套餐 key（free 表示未购）
    ownedPlanExpired: false,  // 已购套餐是否已过期
    ownedPlanExpiresAt: 0,    // 已购套餐到期时间戳
    ownedPlanLabel: '',       // 已购套餐的名称
    sceneMode: 'first'        // 'first' 首次开通 / 'renew' 续费同档 / 'upgrade' 跨档升级 / 'expired' 已到期需续
  },

  methods: {
    /**
     * 显示付费墙
     * @param {object} opts { feature, planKey, role, title, from, multi, onResult }
     *   feature      - 被拦的功能 key（可选；为 undefined 时为主动开通入口）
     *   planKey      - 期望购买的套餐 key
     *   role         - 当前用户角色 member/coach/shop
     *   title        - 触发场景标题
     *   from         - 来源（用于埋点）
     *   multi        - 是否多端 tab 模式（默认 false）
     *   onResult(ok) - 回调：true 开通成功 / false 用户关闭或失败
     */
    show(opts = {}, onResult) {
      const role = opts.role || 'member';
      const multi = !!opts.multi;
      const activeTab = role === 'member' || role === 'coach' || role === 'shop' ? role : 'member';
      const plans = this._buildPlans(activeTab);

      // 试期剩余毫秒
      const trialRemaining = trialRemainingMs();

      // 读取"已购 + 有效期"三态（确保 globalData.planExpiresAt 已同步）
      const app = getApp();
      const gd = (app && app.globalData) || {};
      const ownedPlan = gd.plan && gd.plan !== 'free' ? gd.plan : '';
      const ownedExpiresAt = gd.planExpiresAt || 0;
      const now = Date.now();
      const ownedPlanExpired = !!ownedPlan && (!ownedExpiresAt || now >= ownedExpiresAt);
      const ownedPlanLabel = (() => {
        const all = [].concat(...['member', 'coach', 'shop'].map((r) => getPlanList(r)));
        const p = all.find((x) => x.key === ownedPlan);
        return p ? p.label : '';
      })();

      // 被拦场景：focus 到对应 plan
      let focusKey = opts.planKey || (plans[0] && plans[0].key) || '';
      let focusPlan = (plans.find((p) => p.key === focusKey) || plans[0] || { key: '', label: '', price: 0, termOptions: [] });

      // 三态场景判定：
      //   - 已购 + 未到期：默认 focus 同档（续费场景）
      //   - 已购 + 已到期：默认 focus 同档 + sceneMode='expired'
      //   - 未购：sceneMode='first'，focus 用户想买的 planKey
      //   - 已购 → 切到更高档：sceneMode='upgrade'
      let sceneMode = 'first';
      if (ownedPlan && !ownedPlanExpired) {
        if (opts.planKey && opts.planKey !== ownedPlan) sceneMode = 'upgrade';
        else sceneMode = 'renew';
      } else if (ownedPlan && ownedPlanExpired) {
        sceneMode = 'expired';
        if (opts.planKey && opts.planKey !== ownedPlan) {
          sceneMode = 'upgrade';
          focusKey = opts.planKey;
        }
      }

      const initialTerm = Number(opts.term) || 1;
      const currentPlan = this._composeCurrentPlan(focusPlan, initialTerm);

      this._callback = typeof onResult === 'function' ? onResult : null;
      this._feature = opts.feature || '';
      this._from = opts.from || '';

      this.setData({
        visible: true,
        mode: multi ? 'multi' : 'single',
        activeTab,
        currentRoleLabel: ROLE_LABEL[role] || '用户',
        plans,
        selectedPlan: focusKey,
        selectedTerm: currentPlan.term,
        currentPlan,
        agreed: false,
        blockedFeatureLabel: opts.feature ? getFeatureLabel(opts.feature) : '',
        trialRemaining,
        ownedPlan,
        ownedPlanExpired,
        ownedPlanExpiresAt: ownedExpiresAt,
        ownedPlanLabel,
        sceneMode
      });
    },

    hide() {
      this.setData({ visible: false });
      if (this._callback) {
        const cb = this._callback;
        this._callback = null;
        cb(false);
      }
    },

    onClose() {
      this.hide();
    },

    onSwitchTab(e) {
      const tab = e.currentTarget.dataset.tab;
      if (!tab) return;
      const plans = this._buildPlans(tab);
      const focusKey = (plans[0] && plans[0].key) || '';
      const focusPlan = plans[0] || { key: '', label: '', price: 0, termOptions: [] };
      this.setData({
        activeTab: tab,
        plans,
        selectedPlan: focusKey,
        selectedTerm: focusPlan.termOptions && focusPlan.termOptions[0] ? focusPlan.termOptions[0].term : 1,
        currentPlan: this._composeCurrentPlan(focusPlan, 1)
      });
    },

    onSelectPlan(e) {
      const key = e.currentTarget.dataset.plan;
      const plan = this.data.plans.find((p) => p.key === key);
      if (!plan) return;
      const term = plan.termOptions && plan.termOptions[0] ? plan.termOptions[0].term : 1;
      // 切换套餐时同步更新 sceneMode
      let sceneMode = this.data.sceneMode;
      if (this.data.ownedPlan && !this.data.ownedPlanExpired) {
        sceneMode = key === this.data.ownedPlan ? 'renew' : 'upgrade';
      } else if (this.data.ownedPlan && this.data.ownedPlanExpired) {
        sceneMode = key === this.data.ownedPlan ? 'expired' : 'upgrade';
      } else {
        sceneMode = 'first';
      }
      this.setData({
        selectedPlan: key,
        selectedTerm: term,
        sceneMode,
        currentPlan: this._composeCurrentPlan(plan, term)
      });
    },

    onSelectTerm(e) {
      const term = Number(e.currentTarget.dataset.term) || 1;
      const plan = this.data.plans.find((p) => p.key === this.data.selectedPlan);
      if (!plan) return;
      this.setData({
        selectedTerm: term,
        currentPlan: this._composeCurrentPlan(plan, term)
      });
    },

    onToggleAgree() {
      this.setData({ agreed: !this.data.agreed });
    },

    async onConfirm() {
      if (!this.data.agreed) {
        wx.showToast({ title: '请先同意服务协议', icon: 'none' });
        return;
      }
      const planKey = this.data.selectedPlan;
      const term = this.data.selectedTerm || 1;
      if (!planKey) {
        wx.showToast({ title: '请选择套餐', icon: 'none' });
        return;
      }
      // 演示阶段：调 upgradePlan（mock 直接落盘，云端走云函数）
      // TODO: 接 wx.requestPayment 后改为：创建订单 → 调起支付 → 支付回调成功再 upgradePlan
      try {
        wx.showLoading({ title: '开通中...', mask: true });
        const r = await upgradePlan(planKey, term);
        wx.hideLoading();
        if (r && r.ok) {
          wx.showToast({ title: '开通成功', icon: 'success' });
          this.setData({ visible: false });
          if (this._callback) {
            const cb = this._callback;
            this._callback = null;
            cb(true);
          }
        } else {
          wx.showToast({ title: '开通失败，请重试', icon: 'none' });
        }
      } catch (err) {
        wx.hideLoading();
        console.error('[paywall] upgradePlan error', err);
        wx.showToast({ title: '网络异常', icon: 'none' });
      }
    },

    // 构造指定角色下的套餐列表（含描述/特性/价格/年限）
    _buildPlans(role) {
      const list = getPlanList(role) || [];
      return list.map((p, idx) => ({
        key: p.key,
        label: p.label,
        price: p.price,
        termOptions: getPlanOptions(p.key),
        desc: PLAN_DESC[p.key] || '',
        features: PLAN_FEATURES[p.key] || [],
        // 默认推荐 shop_pro（最贵档），其他端推荐唯一档
        featured: role === 'shop' ? p.key === 'shop_pro' : idx === 0
      }));
    },

    // 组合"当前选中套餐 + 选中年限"的对象，供 CTA / 模板展示实付价
    _composeCurrentPlan(plan, term) {
      const t = Number(term) || 1;
      const price = getPlanPrice(plan.key, t);
      const termOptions = plan.termOptions && plan.termOptions.length
        ? plan.termOptions
        : [{ term: 1, years: 1, price: plan.price || 0, label: '1 年' }];
      const currentTerm = termOptions.find((o) => o.term === t) || termOptions[0];
      return Object.assign({}, plan, {
        term: currentTerm.term,
        years: currentTerm.years,
        price: currentTerm.price, // 实付价
        originalPrice: (plan.price || 0) * currentTerm.years, // 划线原价
        termLabel: currentTerm.label,
        discountLabel: currentTerm.discount || '',
        termOptions
      });
    }
  }
});
