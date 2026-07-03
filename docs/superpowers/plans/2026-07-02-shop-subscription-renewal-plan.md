# Shop Subscription Renewal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split shop owner paid plans into one-time purchases and discounted recurring subscriptions, while adding the code-side chain for real WeChat delegated recurring payment.

**Architecture:** Keep the existing one-time payment path intact. Add a payment mode dimension (`one_time` / `recurring`) to billing plans, orders, entitlement state, and paywall UI. Implement recurring subscription entry points as cloud functions that sign WeChat delegated-withholding contract requests and store contract status; actual live charging requires merchant-platform configuration before production use.

**Tech Stack:** WeChat Mini Program WXML/WXSS/JS, WeChat Cloud Functions, `wx-server-sdk`, existing `billing.js`, existing cloudPay JSAPI order flow, WeChat Pay delegated withholding V2 docs.

---

## Files

- Modify: `miniprogram/utils/billing.js`
  - Add one-time and recurring plan options with separate labels, prices, and `paymentMode`.
  - Add helper functions for option lookup and recurring availability.
- Modify: `miniprogram/components/paywall/index.js`
  - Add purchase mode state, switch handlers, and recurring confirmation branch.
  - Preserve current one-time payment flow.
- Modify: `miniprogram/components/paywall/index.wxml`
  - Add "单次购买 / 连续订阅" switch.
  - Render different period labels and CTA copy.
- Modify: `miniprogram/components/paywall/index.wxss`
  - Style the purchase mode switch and subscription explanatory text.
- Modify: `miniprogram/services/data.js`
  - Add recurring cloud service functions and mock fallbacks.
  - Persist local recurring subscription state in mock mode.
- Modify: `miniprogram/pages/legal/index.js`
  - Update membership agreement to distinguish manual purchase and auto-renewal.
- Modify: `miniprogram/app.json`
  - Add WeChat delegated-withholding signing mini program AppID whitelist.
- Modify: `cloudfunctions/_shared/billing/fulfill.js`
  - Add one-time and recurring prices, payment mode validation, and entitlement metadata.
- Modify: `cloudfunctions/createPayOrder/index.js`
  - Carry `paymentMode: 'one_time'` into orders.
- Modify: `cloudfunctions/createVirtualPayOrder/index.js`
  - Carry `paymentMode: 'one_time'` into virtual pay orders.
- Modify: `cloudfunctions/upgradePlan/index.js`
  - Keep demo/manual entitlement as one-time mode.
- Modify copied shared files:
  - `cloudfunctions/createPayOrder/lib/fulfill.js`
  - `cloudfunctions/createVirtualPayOrder/lib/fulfill.js`
  - `cloudfunctions/upgradePlan/lib/fulfill.js`
  - `cloudfunctions/payCallback/lib/fulfill.js`
  - `cloudfunctions/virtualPayCallback/lib/fulfill.js`
- Create: `cloudfunctions/createRecurringContract/index.js`
  - Create a pending subscription record and return mini program signing params.
- Create: `cloudfunctions/createRecurringContract/package.json`
- Create: `cloudfunctions/recurringContractCallback/index.js`
  - Receive signing/termination notifications and update subscription state.
- Create: `cloudfunctions/recurringContractCallback/package.json`
- Create: `cloudfunctions/cancelRecurringContract/index.js`
  - Request delegated-withholding contract termination and mark subscription canceling/canceled.
- Create: `cloudfunctions/cancelRecurringContract/package.json`
- Create: `cloudfunctions/createRecurringDebit/index.js`
  - Create a delegated withholding debit request for a due subscription.
- Create: `cloudfunctions/createRecurringDebit/package.json`
- Create: `cloudfunctions/recurringDebitCallback/index.js`
  - Handle debit result, extend entitlement on success, retain failure status on failure.
- Create: `cloudfunctions/recurringDebitCallback/package.json`
- Create: `tests/shopSubscriptionPlans.test.js`
  - Static tests for plan labels, prices, paywall mode switch, and app whitelist.
- Create: `tests/recurringCloudFunctions.test.js`
  - Static tests for recurring cloud function config, environment variable usage, and no hardcoded secrets.
- Create: `docs/shop-recurring-subscription-setup.md`
  - List external merchant-platform setup tasks Zhang总 must complete.

## External Setup Required From Zhang总

- Open WeChat Pay delegated withholding / periodic charging permission.
- Create and approve recurring payment templates for month, quarter, and year; provide `plan_id` values.
- Confirm merchant mode:
  - Service provider mode needs `mch_id`, `sub_mch_id`, service provider appid, and signing key.
  - Direct merchant mode needs direct merchant equivalents; current local official docs are service-provider V2.
- Provide HTTPS callback URLs for contract and debit callbacks.
- Configure cloud function environment variables:
  - `PAP_APPID`
  - `PAP_MCH_ID`
  - `PAP_SUB_MCH_ID`
  - `PAP_SIGN_KEY`
  - `PAP_CONTRACT_NOTIFY_URL`
  - `PAP_DEBIT_NOTIFY_URL`
  - `PAP_PLAN_ID_MONTH`
  - `PAP_PLAN_ID_QUARTER`
  - `PAP_PLAN_ID_YEAR`

## Task 1: Tests For Billing Plan Split

**Files:**
- Create: `tests/shopSubscriptionPlans.test.js`

- [ ] **Step 1: Write static tests**

```js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

const billingJs = read('miniprogram/utils/billing.js');
const paywallJs = read('miniprogram/components/paywall/index.js');
const paywallWxml = read('miniprogram/components/paywall/index.wxml');
const paywallWxss = read('miniprogram/components/paywall/index.wxss');
const appJson = read('miniprogram/app.json');

assert(
  billingJs.includes("paymentMode: 'one_time'") && billingJs.includes("paymentMode: 'recurring'"),
  'Billing plans should distinguish one-time purchase and recurring subscription options.'
);

assert(
  billingJs.includes("label: '单月'") && billingJs.includes("label: '单季'") && billingJs.includes("label: '单年'"),
  'One-time purchase options should use 单月/单季/单年 labels.'
);

assert(
  billingJs.includes("label: '包月'") && billingJs.includes("label: '包季'") && billingJs.includes("label: '包年'"),
  'Recurring options should use 包月/包季/包年 labels.'
);

assert(
  /recurringOptions:\s*\[/.test(billingJs),
  'Each paid shop plan should expose recurringOptions.'
);

assert(
  paywallJs.includes("purchaseMode: 'one_time'") && paywallJs.includes('onSwitchPurchaseMode'),
  'Paywall should keep purchase mode state and expose a switch handler.'
);

assert(
  paywallWxml.includes('单次购买') && paywallWxml.includes('连续订阅'),
  'Paywall should show one-time and recurring purchase mode tabs.'
);

assert(
  paywallWxml.includes('自动续费') && paywallWxml.includes('可随时取消'),
  'Paywall should explain recurring subscription behavior.'
);

assert(
  /\.pw-mode/.test(paywallWxss) && /\.pw-renewal-note/.test(paywallWxss),
  'Paywall stylesheet should style purchase mode tabs and renewal note.'
);

assert(
  appJson.includes('navigateToMiniProgramAppIdList') && appJson.includes('wxbd687630cd02ce1d'),
  'app.json should whitelist the WeChat delegated-withholding signing mini program.'
);
```

- [ ] **Step 2: Run the failing test**

Run: `node tests/shopSubscriptionPlans.test.js`

Expected before implementation: FAIL with a missing `paymentMode`, `recurringOptions`, or purchase mode assertion.

## Task 2: Billing Model

**Files:**
- Modify: `miniprogram/utils/billing.js`
- Modify: `cloudfunctions/_shared/billing/fulfill.js`
- Modify copied `lib/fulfill.js` files in payment cloud functions

- [ ] **Step 1: Add plan option groups**

Implementation shape in `miniprogram/utils/billing.js`:

```js
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
```

Use the same pattern for:

```js
shop_basic one_time: month 269, quarter 699, year 2388
shop_basic recurring: month 239, quarter 599, year 1980
shop_pro one_time: month 699, quarter 1799, year 5988
shop_pro recurring: month 599, quarter 1499, year 4980
```

- [ ] **Step 2: Add option helpers**

Add:

```js
function getPlanOptions(planKey, paymentMode) {
  const p = PLANS[planKey];
  if (!p) return [];
  if (paymentMode === 'recurring') return p.recurringOptions || [];
  return p.periodOptions || [];
}

function getPlanPrice(planKey, period, paymentMode) {
  const opts = getPlanOptions(planKey, paymentMode);
  if (!opts.length) return 0;
  const wanted = PERIOD_MS[period] ? period : 'year';
  const opt = opts.find((o) => o.period === wanted);
  return opt ? opt.price : opts[0].price;
}

function getPlanEntryPrice(planKey, paymentMode) {
  const opts = getPlanOptions(planKey, paymentMode);
  if (!opts.length) return 0;
  return opts.reduce((min, o) => (o.price < min ? o.price : min), opts[0].price);
}
```

- [ ] **Step 3: Update shared server pricing**

In `cloudfunctions/_shared/billing/fulfill.js`, add:

```js
const PAYMENT_MODES = ['one_time', 'recurring'];
function normPaymentMode(paymentMode) {
  return PAYMENT_MODES.indexOf(paymentMode) !== -1 ? paymentMode : 'one_time';
}
```

Use plan shape:

```js
shop_lite: {
  role: 'shop',
  level: 1,
  prices: {
    one_time: { month: 79, quarter: 219, year: 708 },
    recurring: { month: 69, quarter: 189, year: 588 }
  }
}
```

Update `computeAmountYuan({ planKey, role, period, current, paymentMode })` to select `plan.prices[normPaymentMode(paymentMode)]`.

- [ ] **Step 4: Sync copied shared files**

Copy the updated content from `cloudfunctions/_shared/billing/fulfill.js` into:

```text
cloudfunctions/createPayOrder/lib/fulfill.js
cloudfunctions/createVirtualPayOrder/lib/fulfill.js
cloudfunctions/upgradePlan/lib/fulfill.js
cloudfunctions/payCallback/lib/fulfill.js
cloudfunctions/virtualPayCallback/lib/fulfill.js
```

- [ ] **Step 5: Run test**

Run: `node tests/shopSubscriptionPlans.test.js`

Expected: still FAIL until paywall and app JSON are updated.

## Task 3: Paywall UI And One-Time Flow Preservation

**Files:**
- Modify: `miniprogram/components/paywall/index.js`
- Modify: `miniprogram/components/paywall/index.wxml`
- Modify: `miniprogram/components/paywall/index.wxss`
- Modify: `miniprogram/app.json`

- [ ] **Step 1: Add purchase mode state**

In component data:

```js
purchaseMode: 'one_time',
purchaseModes: [
  { key: 'one_time', label: '单次购买' },
  { key: 'recurring', label: '连续订阅' }
]
```

- [ ] **Step 2: Rebuild options by purchase mode**

Update `_buildPlans(role, paymentMode)` to call:

```js
entryPrice: getPlanEntryPrice(p.key, paymentMode),
periodOptions: getPlanOptions(p.key, paymentMode),
```

Update `_composeCurrentPlan(plan, period, paymentMode)` to call:

```js
price: getPlanPrice(plan.key, cur.period, paymentMode) || cur.price,
paymentMode: paymentMode || 'one_time',
```

- [ ] **Step 3: Add mode switch handler**

```js
onSwitchPurchaseMode(e) {
  const mode = e.currentTarget.dataset.mode;
  if (mode !== 'one_time' && mode !== 'recurring') return;
  const plans = this._buildPlans(this.data.activeTab, mode);
  const selectedPlan = plans.find((p) => p.key === this.data.selectedPlan) || plans[0] || EMPTY_PLAN;
  const currentPlan = this._composeCurrentPlan(selectedPlan, this.data.selectedPeriod || 'year', mode);
  this.setData({
    purchaseMode: mode,
    plans,
    selectedPlan: selectedPlan.key,
    selectedPeriod: currentPlan.period,
    currentPlan
  });
}
```

- [ ] **Step 4: Route recurring confirmation separately**

In `onConfirm()`:

```js
if (this.data.purchaseMode === 'recurring') {
  this._startRecurring(planKey, period);
  return;
}
```

Add `_startRecurring(planKey, period)` to call the new service and navigate to the signing mini program when configured; if mock/unconfigured, show a clear modal.

- [ ] **Step 5: Add WXML mode tabs and note**

Add near period tabs:

```xml
<view class="pw-mode">
  <view wx:for="{{purchaseModes}}" wx:key="key" class="pw-mode__item {{purchaseMode===item.key?'is-active':''}}" data-mode="{{item.key}}" bindtap="onSwitchPurchaseMode">{{item.label}}</view>
</view>
<view class="pw-renewal-note" wx:if="{{purchaseMode === 'recurring'}}">
  自动续费，到期前按所选周期扣款，可随时取消。未完成微信支付签约前不会扣费。
</view>
```

- [ ] **Step 6: Add app whitelist**

Add to `miniprogram/app.json`:

```json
"navigateToMiniProgramAppIdList": ["wxbd687630cd02ce1d"]
```

- [ ] **Step 7: Run test**

Run: `node tests/shopSubscriptionPlans.test.js`

Expected: PASS.

## Task 4: Recurring Service Functions

**Files:**
- Modify: `miniprogram/services/data.js`
- Create recurring cloud functions and package files

- [ ] **Step 1: Write static tests**

Create `tests/recurringCloudFunctions.test.js`:

```js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}
function exists(file) {
  return fs.existsSync(path.join(root, file));
}

[
  'createRecurringContract',
  'recurringContractCallback',
  'cancelRecurringContract',
  'createRecurringDebit',
  'recurringDebitCallback'
].forEach((name) => {
  assert(exists(`cloudfunctions/${name}/index.js`), `${name} cloud function should exist.`);
  assert(exists(`cloudfunctions/${name}/package.json`), `${name} package.json should exist.`);
});

const dataJs = read('miniprogram/services/data.js');
assert(dataJs.includes('createRecurringContract'), 'data.js should export createRecurringContract.');
assert(dataJs.includes('cancelRecurringContract'), 'data.js should export cancelRecurringContract.');
assert(dataJs.includes('getRecurringSubscription'), 'data.js should export getRecurringSubscription.');

const createContract = read('cloudfunctions/createRecurringContract/index.js');
assert(createContract.includes('PAP_PLAN_ID_MONTH'), 'createRecurringContract should read monthly template env.');
assert(createContract.includes('PAP_SIGN_KEY'), 'createRecurringContract should read signing key from env.');
assert(!createContract.includes('123456') && !createContract.includes('mch_secret'), 'createRecurringContract should not hardcode secrets.');
assert(createContract.includes('wxbd687630cd02ce1d'), 'createRecurringContract should return the official signing mini program appid.');

const debit = read('cloudfunctions/createRecurringDebit/index.js');
assert(debit.includes('/pay/partner/pappayapply'), 'createRecurringDebit should call the delegated debit endpoint.');
assert(debit.includes('contract_id'), 'createRecurringDebit should debit by contract id.');

const cancel = read('cloudfunctions/cancelRecurringContract/index.js');
assert(cancel.includes('/papay/deletecontract'), 'cancelRecurringContract should call contract termination endpoint.');
```

- [ ] **Step 2: Run failing test**

Run: `node tests/recurringCloudFunctions.test.js`

Expected before implementation: FAIL because functions do not exist.

- [ ] **Step 3: Add service wrappers**

In `miniprogram/services/data.js`, add:

```js
function createRecurringContract(planKey, period) {
  const app = getApp();
  const role = (app && app.globalData && app.globalData.role) || mock.getRole();
  if (cloudReady()) return callCloud('createRecurringContract', { planKey, period, role });
  return Promise.resolve({ ok: false, mock: true, code: 'RECURRING_NOT_CONFIGURED', msg: '连续订阅需配置微信支付委托代扣后使用' });
}

function cancelRecurringContract() {
  if (cloudReady()) return callCloud('cancelRecurringContract', {});
  return Promise.resolve({ ok: true, mock: true, status: 'canceled' });
}

function getRecurringSubscription() {
  if (cloudReady()) return callCloud('getUserBilling', {}).then((r) => (r && r.billing && r.billing.subscription) || null);
  return Promise.resolve(mock.readObject('dc_recurring_subscription', null));
}
```

Export the functions.

- [ ] **Step 4: Create cloud functions**

Each package uses:

```json
{
  "name": "createRecurringContract",
  "version": "1.0.0",
  "main": "index.js",
  "dependencies": {
    "wx-server-sdk": "~2.6.3"
  }
}
```

Change `name` per function.

- [ ] **Step 5: Implement `createRecurringContract`**

Use Node `crypto` to create V2 MD5 sign. Read env vars only. Return:

```js
{
  ok: true,
  appId: 'wxbd687630cd02ce1d',
  path: 'pages/index/index',
  extraData: {
    appid,
    mch_id,
    sub_mch_id,
    plan_id,
    contract_code,
    request_serial,
    contract_display_account,
    notify_url,
    timestamp,
    sign
  }
}
```

Also write `subscriptions` record with `status: 'pending_contract'`.

- [ ] **Step 6: Implement callbacks and debit skeletons**

Callbacks should parse XML, verify sign when possible, update `subscriptions`, and apply entitlement only after debit success.

- [ ] **Step 7: Run tests**

Run:

```text
node tests/recurringCloudFunctions.test.js
node tests/shopSubscriptionPlans.test.js
```

Expected: PASS.

## Task 5: Agreement And Setup Docs

**Files:**
- Modify: `miniprogram/pages/legal/index.js`
- Create: `docs/shop-recurring-subscription-setup.md`

- [ ] **Step 1: Update agreement**

Replace the current manual-renewal-only paragraph with wording that says:

```text
单次购买到期后不自动续费；连续订阅需另行完成微信支付签约，签约后按所选周期自动扣费。扣费前通知、取消续费、扣费失败处理以微信支付规则和页面提示为准。
```

- [ ] **Step 2: Add setup doc**

Document the exact external setup list from this plan.

- [ ] **Step 3: Run all static tests**

Run:

```text
node tests/loginMethods.test.js
node tests/lightOnlyTheme.test.js
node tests/coachProfileSettingsBinding.test.js
node tests/shopSubscriptionPlans.test.js
node tests/recurringCloudFunctions.test.js
```

Expected: PASS.

## Self Review

- The plan keeps existing one-time payment flow intact.
- Recurring subscription is not faked as one-time payment; it requires contract creation and debit callbacks.
- External merchant setup is explicit.
- No file deletion is required.
- Tests cover static structure, UI mode split, and recurring cloud function presence/config safety.
