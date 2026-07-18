const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

global.getApp = () => ({
  globalData: {
    firstLoginAt: 1,
    plan: 'free',
    planExpiresAt: 0
  }
});
global.wx = {};

const billing = require(path.join(root, 'miniprogram/utils/billing.js'));

assert.strictEqual(billing.canUse('shop.report'), true);
assert.strictEqual(billing.hasPlan('shop_pro'), true);
assert.strictEqual(billing.isPlanActive('shop_pro'), true);
assert.deepStrictEqual(billing.getPlanList('shop'), []);
assert.deepStrictEqual(billing.getPlanOptions('shop_basic', 'one_time'), []);
assert.deepStrictEqual(billing.getPlanOptions('shop_basic', 'recurring'), []);

const paywallJs = read('miniprogram/components/paywall/index.js');
assert(paywallJs.includes('onResult(true)'), 'Paywall compatibility API should allow immediately.');
[
  'FORCE_VIRTUAL_PAY_FOR_TEST',
  'createPayOrder',
  'createVirtualPayOrder',
  'createRecurringContract',
  'requestPayment',
  'requestVirtualPayment',
  'navigateToMiniProgram'
].forEach((token) => {
  assert(!paywallJs.includes(token), `Retired paywall should not contain ${token}.`);
});

const appJs = read('miniprogram/app.js');
assert(appJs.includes('cb(true)'), 'Global paywall compatibility entry should allow immediately.');
assert(!appJs.includes("selectComponent('#paywall')"), 'Global paywall must not mount the retired component.');

const appJson = read('miniprogram/app.json');
assert(!appJson.includes('navigateToMiniProgramAppIdList'));
assert(!appJson.includes('wxbd687630cd02ce1d'));

console.log('shopSubscriptionPlans retirement tests passed');
