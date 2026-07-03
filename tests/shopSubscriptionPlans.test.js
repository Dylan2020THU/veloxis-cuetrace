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
  /getPlanOptions\(planKey,\s*paymentMode\)/.test(billingJs),
  'Plan option lookup should accept paymentMode.'
);

assert(
  paywallJs.includes("purchaseMode: 'one_time'") && paywallJs.includes('onSwitchPurchaseMode'),
  'Paywall should keep purchase mode state and expose a switch handler.'
);

assert(
  paywallJs.includes('_startRecurring') && paywallJs.includes('createRecurringContract'),
  'Paywall should route recurring purchases through the recurring contract service.'
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
