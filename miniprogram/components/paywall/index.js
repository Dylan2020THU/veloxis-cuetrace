// 通用付费墙组件
// 使用方式（在 Page 中）：
//   1) 模板引入：<paywall id="paywall" />
//   2) this.selectComponent('#paywall').show({ feature, planKey, role, title, from }, (ok) => {})
//   3) 或者通过 getApp().paywall(...) 全局方法（见 app.js）
//
// 配套：
//   utils/billing.js   权限判断（PLANS / 周期 period / 价格）
//   services/data.js   upgradePlan / getUserBilling

const { getPlanList, getPlanOptions, getPlanPrice, getPlanEntryPrice, getFeatureLabel, trialRemainingMs, planLevel } = require('../../utils/billing');
const { upgradePlan, createVirtualPayOrder, createPayOrder, getUserBilling } = require('../../services/data');

// 场景判定：first 首次 / renew 续费同档 / upgrade 升级 / downgrade 降档(已含) / expired 已到期
function sceneFor(key, ownedPlan, ownedPlanExpired) {
  if (!ownedPlan) return 'first';
  if (key === ownedPlan) return ownedPlanExpired ? 'expired' : 'renew';
  return planLevel(key) > planLevel(ownedPlan) ? 'upgrade' : 'downgrade';
}

// 套餐描述（与 utils/billing.js 的 PLANS 对齐）
const PLAN_DESC = {
  shop_lite: '态势看板 · 球桌计费 · 扫码开台，单店开张即用',
  shop_basic: '完整会员 · 团购对账 · 营销 · 报表导出，中型店利润主力',
  shop_pro: '多门店连锁 · 跨店报表 · AI 陪练 · 硬件集成与顾问'
};

const PLAN_FEATURES = {
  shop_lite: [
    '实时球厅态势看板',
    '球桌智能计费 + 扫码自助开台',
    '桌台灯控联动省电',
    '基础会员建档 + 储值扣费',
    '单门店、无桌数上限'
  ],
  shop_basic: [
    '启航版全部功能',
    '完整会员体系：储值 / 卡券 / 积分',
    '美团团购自动对账 + 防转台',
    '营销：拼桌 / 约球 / 优惠券 / 活动',
    '经营报表 + 一键导出 Excel'
  ],
  shop_pro: [
    '标准版全部功能',
    '多门店 / 连锁总部驾驶舱',
    '角色权限分级 + 跨店会员通存通兑',
    '跨店报表 / 定时推送 / 数据 API',
    'AI 陪练计费 + 硬件集成 + 专属顾问'
  ]
};

const ROLE_LABEL = {
  member: '球员',
  coach: '教练',
  shop: '店主'
};

const EMPTY_PLAN = { key: '', label: '', entryPrice: 0, periodOptions: [] };

Component({
  options: {
    multipleSlots: false,
    styleIsolation: 'apply-shared'
  },

  data: {
    visible: false,
    mode: 'single',
    activeTab: 'shop',
    currentRoleLabel: '',
    plans: [],
    selectedPlan: '',
    selectedPeriod: 'year',     // 当前选中周期：month / quarter / year
    currentPlan: EMPTY_PLAN,    // 选中套餐 + 周期详情（CTA 展示用）
    agreed: false,
    blockedFeatureLabel: '',
    trialRemaining: 0,
    ownedPlan: '',
    ownedPlanExpired: false,
    ownedPlanExpiresAt: 0,
    ownedPlanLabel: '',
    sceneMode: 'first'          // first 首次开通 / renew 续费同档 / upgrade 跨档升级 / expired 已到期需续
  },

  methods: {
    show(opts = {}, onResult) {
      const role = opts.role || 'shop';
      const multi = !!opts.multi;
      const activeTab = role === 'member' || role === 'coach' || role === 'shop' ? role : 'shop';
      const plans = this._buildPlans(activeTab);
      // 无可订阅套餐（球员/教练端）：不渲染空墙，直接回调关闭
      if (!plans.length) {
        if (typeof onResult === 'function') onResult(false);
        wx.showToast({ title: '当前身份暂无可订阅套餐', icon: 'none' });
        return;
      }

      const trialRemaining = trialRemainingMs();

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

      let focusKey = opts.planKey || (plans[0] && plans[0].key) || '';
      let focusPlan = plans.find((p) => p.key === focusKey) || plans[0] || EMPTY_PLAN;

      // 已购+过期+指定了其它档：focus 到目标档
      if (ownedPlan && ownedPlanExpired && opts.planKey && opts.planKey !== ownedPlan) {
        focusKey = opts.planKey;
        focusPlan = plans.find((p) => p.key === focusKey) || focusPlan;
      }
      const sceneMode = sceneFor(focusKey, ownedPlan, ownedPlanExpired);

      const initialPeriod = opts.period || 'year';
      const currentPlan = this._composeCurrentPlan(focusPlan, initialPeriod);

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
        selectedPeriod: currentPlan.period,
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
      const focusPlan = plans[0] || EMPTY_PLAN;
      const period = this.data.selectedPeriod || 'year';
      this.setData({
        activeTab: tab,
        plans,
        selectedPlan: focusKey,
        selectedPeriod: period,
        currentPlan: this._composeCurrentPlan(focusPlan, period)
      });
    },

    onSelectPlan(e) {
      const key = e.currentTarget.dataset.plan;
      const plan = this.data.plans.find((p) => p.key === key);
      if (!plan) return;
      const period = this.data.selectedPeriod || 'year';
      const sceneMode = sceneFor(key, this.data.ownedPlan, this.data.ownedPlanExpired);
      this.setData({
        selectedPlan: key,
        selectedPeriod: period,
        sceneMode,
        currentPlan: this._composeCurrentPlan(plan, period)
      });
    },

    onSelectPeriod(e) {
      const period = e.currentTarget.dataset.period;
      const plan = this.data.plans.find((p) => p.key === this.data.selectedPlan);
      if (!plan || !period) return;
      this.setData({
        selectedPeriod: period,
        currentPlan: this._composeCurrentPlan(plan, period)
      });
    },

    onToggleAgree() {
      this.setData({ agreed: !this.data.agreed });
    },

    onOpenAgreement() {
      wx.navigateTo({ url: '/pages/legal/index?type=membership' });
    },

    async onConfirm() {
      if (!this.data.agreed) {
        wx.showToast({ title: '请先同意服务协议', icon: 'none' });
        return;
      }
      if (this.data.sceneMode === 'downgrade') {
        wx.showToast({ title: '当前套餐已包含该档，无需购买', icon: 'none' });
        return;
      }
      const planKey = this.data.selectedPlan;
      const period = this.data.selectedPeriod || 'year';
      if (!planKey) {
        wx.showToast({ title: '请选择套餐', icon: 'none' });
        return;
      }
      // 按设备分流：iOS → 虚拟支付(苹果 IAP)；安卓/其它 → 基础支付(微信支付 cloudPay)；
      // devtools/mock（cloudReady 为假，下单返回 {mock:true}）→ 演示发货，保证可点测。
      if (this._platform() === 'ios') {
        this._payViaVirtual(planKey, period);
      } else {
        this._payViaWxpay(planKey, period);
      }
    },

    // 当前设备平台：'ios' | 'android' | 'devtools' | 'windows' | 'mac' | ...
    _platform() {
      try {
        const info = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync();
        return (info && info.platform) || '';
      } catch (e) {
        return '';
      }
    },

    // 安卓/其它：基础支付（微信支付 · cloudPay JSAPI）
    async _payViaWxpay(planKey, period) {
      try {
        wx.showLoading({ title: '处理中...', mask: true });
        const order = await createPayOrder(planKey, period);
        wx.hideLoading();
        if (!order || order.mock) return this._fulfillDemo(planKey, period);
        if (!order.ok) {
          wx.showToast({ title: (order && order.msg) || '下单失败', icon: 'none' });
          return;
        }
        if (!wx.requestPayment) {
          wx.showToast({ title: '请升级微信后再支付', icon: 'none' });
          return;
        }
        wx.requestPayment(Object.assign({}, order.payment, {
          success: () => this._afterPaid(),
          fail: (e) => {
            if (e && /cancel/.test(e.errMsg || '')) return; // 用户取消，不提示
            console.error('[paywall] requestPayment fail', e);
            wx.showToast({ title: '支付未完成', icon: 'none' });
          }
        }));
      } catch (err) {
        wx.hideLoading();
        console.error('[paywall] wxpay error', err);
        wx.showToast({ title: '网络异常', icon: 'none' });
      }
    },

    // iOS：虚拟支付（苹果 IAP）
    async _payViaVirtual(planKey, period) {
      try {
        wx.showLoading({ title: '处理中...', mask: true });
        // 取 wx.login 票据，供服务端 code2Session 做用户态签名（mock 路径不需要，传空亦可）
        const loginRes = await new Promise((resolve) => {
          wx.login({ success: resolve, fail: () => resolve({}) });
        });
        const order = await createVirtualPayOrder(planKey, period, loginRes && loginRes.code);
        wx.hideLoading();
        if (!order || order.mock) return this._fulfillDemo(planKey, period);
        if (!order.ok) {
          wx.showToast({ title: (order && order.msg) || '下单失败', icon: 'none' });
          return;
        }
        if (!wx.requestVirtualPayment) {
          wx.showToast({ title: '请升级微信后再开通', icon: 'none' });
          return;
        }
        wx.requestVirtualPayment({
          signData: order.signData,
          paySig: order.paySig,
          signature: order.signature,
          mode: 'short_series_goods',
          success: () => this._afterPaid(),
          fail: (e) => {
            if (e && /cancel/.test(e.errMsg || '')) return; // 用户取消，不提示
            console.error('[paywall] requestVirtualPayment fail', e);
            wx.showToast({ title: '支付未完成', icon: 'none' });
          }
        });
      } catch (err) {
        wx.hideLoading();
        console.error('[paywall] virtual pay error', err);
        wx.showToast({ title: '网络异常', icon: 'none' });
      }
    },

    // 演示发货（devtools/mock）：保持张总演示行为不变（开通成功→关闭→回调）
    _fulfillDemo(planKey, period) {
      wx.showLoading({ title: '开通中...', mask: true });
      return upgradePlan(planKey, period).then((r) => {
        wx.hideLoading();
        if (r && r.ok) {
          wx.showToast({ title: '开通成功', icon: 'success' });
          this.setData({ visible: false });
          if (this._callback) { const cb = this._callback; this._callback = null; cb(true); }
        } else {
          wx.showToast({ title: '开通失败，请重试', icon: 'none' });
        }
      }).catch((err) => {
        wx.hideLoading();
        console.error('[paywall] demo fulfill error', err);
        wx.showToast({ title: '网络异常', icon: 'none' });
      });
    },

    // 支付成功后：发货以服务端回调为准，此处仅重新拉取订阅状态同步 globalData 后收尾。
    _afterPaid() {
      const role = this.data.activeTab || 'shop';
      getUserBilling({ role }).then(() => {
        wx.showToast({ title: '开通成功', icon: 'success' });
        this.setData({ visible: false });
        if (this._callback) { const cb = this._callback; this._callback = null; cb(true); }
      }).catch(() => {
        // 状态拉取失败也提示成功（已付款），引导稍后刷新
        wx.showToast({ title: '开通处理中，稍后刷新', icon: 'none' });
        this.setData({ visible: false });
        if (this._callback) { const cb = this._callback; this._callback = null; cb(true); }
      });
    },

    // 构造指定角色下的套餐列表（含描述/特性/入门价/周期）
    _buildPlans(role) {
      const list = getPlanList(role) || [];
      return list.map((p, idx) => ({
        key: p.key,
        label: p.label,
        entryPrice: getPlanEntryPrice(p.key),
        periodOptions: getPlanOptions(p.key),
        desc: PLAN_DESC[p.key] || '',
        features: PLAN_FEATURES[p.key] || [],
        // 店主端默认推荐标准版（利润主力）；其他端推荐唯一档
        featured: role === 'shop' ? p.key === 'shop_basic' : idx === 0
      }));
    },

    // 组合"当前选中套餐 + 选中周期"，供 CTA / 模板展示实付价
    _composeCurrentPlan(plan, period) {
      const periodOptions = (plan.periodOptions && plan.periodOptions.length)
        ? plan.periodOptions
        : [{ period: 'year', price: plan.entryPrice || 0, label: '包年' }];
      const wanted = period || 'year';
      const cur = periodOptions.find((o) => o.period === wanted) || periodOptions[periodOptions.length - 1];
      const monthly = (periodOptions.find((o) => o.period === 'month') || {}).price || 0;
      const mult = cur.period === 'year' ? 12 : (cur.period === 'quarter' ? 3 : 1);
      return Object.assign({}, plan, {
        period: cur.period,
        price: getPlanPrice(plan.key, cur.period) || cur.price,
        periodLabel: cur.label,
        discountLabel: cur.discount || '',
        originalPrice: monthly * mult, // 划线原价（按月价×周期数）
        periodOptions
      });
    }
  }
});
