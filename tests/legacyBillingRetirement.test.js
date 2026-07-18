const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function exists(file) {
  return fs.existsSync(path.join(root, file));
}

function freshRequire(file) {
  const resolved = require.resolve(path.join(root, file));
  delete require.cache[resolved];
  return require(resolved);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function retired(result, label) {
  assert.strictEqual(result && result.ok, false, `${label} should fail closed.`);
  assert.strictEqual(result && result.code, 'PRODUCT_RETIRED', `${label} should report PRODUCT_RETIRED.`);
}

async function testFreeBillingCompatibility() {
  let modalCalls = 0;
  let paywallCalls = 0;
  global.wx = {
    showModal() { modalCalls += 1; }
  };
  global.getApp = () => ({
    globalData: {
      firstLoginAt: 1,
      plan: 'free',
      planExpiresAt: 0
    },
    paywall() { paywallCalls += 1; }
  });

  const billing = freshRequire('miniprogram/utils/billing.js');
  assert.strictEqual(billing.canUse('shop.report'), true);
  assert.strictEqual(billing.hasPlan('shop_pro'), true);
  assert.strictEqual(billing.isPlanActive('shop_pro'), true);
  assert.strictEqual(await billing.requirePlan({ feature: 'shop.multiStore' }), true);
  assert.deepStrictEqual(billing.getPlanList('shop'), []);
  assert.deepStrictEqual(billing.getPlanOptions('shop_basic', 'one_time'), []);
  assert.deepStrictEqual(billing.getPlanOptions('shop_basic', 'recurring'), []);
  assert.strictEqual(modalCalls, 0);
  assert.strictEqual(paywallCalls, 0);
}

async function testClientPurchaseHelpersFailWithoutMutation() {
  const storage = new Map();
  const cloudCalls = [];
  const app = {
    globalData: {
      role: 'shop',
      openid: 'legacy-client-openid',
      cloudReady: false,
      plan: 'free',
      planExpiresAt: 0
    }
  };
  global.getApp = () => app;
  global.wx = {
    getStorageSync(key) { return storage.has(key) ? clone(storage.get(key)) : ''; },
    setStorageSync(key, value) { storage.set(key, clone(value)); },
    removeStorageSync(key) { storage.delete(key); },
    cloud: {
      callFunction(request) {
        cloudCalls.push(clone(request));
        return Promise.resolve({ result: { ok: true, planExpiresAt: Date.now() + 1000 } });
      }
    }
  };

  const data = freshRequire('miniprogram/services/data.js');
  const helpers = [
    ['upgradePlan', () => data.upgradePlan('shop_basic', 'year')],
    ['createPayOrder', () => data.createPayOrder('shop_basic', 'year')],
    ['createVirtualPayOrder', () => data.createVirtualPayOrder('shop_basic', 'year', 'code')],
    ['createRecurringContract', () => data.createRecurringContract('shop_basic', 'year')]
  ];

  const initialGlobalData = clone(app.globalData);
  for (const [name, invoke] of helpers) retired(await invoke(), name);
  assert.deepStrictEqual(app.globalData, initialGlobalData, 'Retired local helpers must not grant local entitlements.');
  assert.strictEqual(storage.size, 0, 'Retired local helpers must not mutate storage.');

  app.globalData.cloudReady = true;
  const cloudGlobalData = clone(app.globalData);
  for (const [name, invoke] of helpers) retired(await invoke(), `${name} cloud mode`);
  assert.deepStrictEqual(app.globalData, cloudGlobalData, 'Retired cloud-mode helpers must not mutate local state.');
  assert.strictEqual(cloudCalls.length, 0, 'Retired client helpers must not call cloud functions.');
}

function bindingId(openid) {
  return crypto.createHash('sha256').update(`wechat:${openid}`).digest('hex');
}

function makeCloudFixture() {
  const OPENID = 'legacy-cloud-openid';
  const userId = bindingId(OPENID);
  const writes = [];
  const network = [];
  const user = {
    _id: userId,
    _openid: OPENID,
    roles: ['shop'],
    per_role: {},
    subscriptionStatus: ''
  };
  const binding = {
    _id: userId,
    _openid: OPENID,
    accountId: 'legacy-account-id',
    account: 'legacy-account'
  };
  const account = {
    _id: binding.accountId,
    _openid: OPENID,
    account: binding.account,
    status: 'active'
  };
  const subscription = {
    _id: 'legacy-subscription-id',
    _openid: OPENID,
    userId,
    role: 'shop',
    planKey: 'shop_basic',
    period: 'month',
    contractId: 'legacy-contract-id',
    status: 'active',
    nextRenewAt: 0
  };

  function records(name) {
    if (name === 'users') return [user];
    if (name === 'wechat_bindings') return [binding];
    if (name === 'accounts') return [account];
    if (name === 'subscriptions') return [subscription];
    return [];
  }

  function ref(name, docId) {
    const api = {
      where() { return api; },
      orderBy() { return api; },
      limit() { return api; },
      skip() { return api; },
      doc(id) { return ref(name, id); },
      async get() {
        const list = records(name);
        if (docId !== undefined) {
          return { data: list.find((item) => item._id === docId) || null };
        }
        return { data: list.slice() };
      },
      async add(payload) {
        writes.push({ collection: name, method: 'add', payload: clone(payload) });
        return { _id: `${name}-added-id` };
      },
      async update(payload) {
        writes.push({ collection: name, method: 'update', payload: clone(payload) });
        return { stats: { updated: 1 } };
      }
    };
    return api;
  }

  const db = {
    command: {
      lte(value) { return { lte: value }; }
    },
    serverDate() { return 123456789; },
    collection(name) { return ref(name); },
    runTransaction(handler) {
      return handler({ collection(name) { return ref(name); } });
    }
  };
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'test',
    init() {},
    database() { return db; },
    getWXContext() { return { OPENID }; },
    cloudPay: {
      async unifiedOrder() {
        network.push({ type: 'cloudPay' });
        return { payment: { timeStamp: '1' } };
      }
    }
  };
  const https = {
    get(url, callback) {
      network.push({ type: 'https.get', url: String(url) });
      const handlers = {};
      const response = {
        on(name, handler) {
          handlers[name] = handler;
          if (name === 'end') {
            if (handlers.data) handlers.data(JSON.stringify({ session_key: 'session-key' }));
            handler();
          }
          return response;
        }
      };
      callback(response);
      return { on() { return this; } };
    },
    request(options, callback) {
      network.push({ type: 'https.request', options: clone(options) });
      const responseHandlers = {};
      const response = {
        on(name, handler) {
          responseHandlers[name] = handler;
          return response;
        }
      };
      callback(response);
      return {
        on() { return this; },
        write() {},
        end() {
          if (responseHandlers.data) responseHandlers.data('<return_code>SUCCESS</return_code>');
          if (responseHandlers.end) responseHandlers.end();
        }
      };
    }
  };
  return { cloud, https, writes, network };
}

function loadCloudFunction(file, fixture) {
  const resolved = require.resolve(path.join(root, file));
  delete require.cache[resolved];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'wx-server-sdk') return fixture.cloud;
    if (request === 'https') return fixture.https;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(resolved);
  } finally {
    Module._load = originalLoad;
  }
}

async function testCloudEndpointsFailBeforeWritesOrNetwork() {
  const envKeys = [
    'WX_APPSECRET', 'VIRTUAL_PAY_APPKEY', 'PAP_APPID', 'PAP_MCH_ID',
    'PAP_SIGN_KEY', 'PAP_CONTRACT_NOTIFY_URL', 'PAP_PLAN_ID_MONTH',
    'PAP_DEBIT_NOTIFY_URL'
  ];
  const before = {};
  envKeys.forEach((key) => {
    before[key] = process.env[key];
    process.env[key] = `test-${key.toLowerCase()}`;
  });
  const endpoints = [
    ['upgradePlan', 'cloudfunctions/upgradePlan/index.js', { planKey: 'shop_basic', role: 'shop', period: 'month' }],
    ['createPayOrder', 'cloudfunctions/createPayOrder/index.js', { planKey: 'shop_basic', role: 'shop', period: 'month' }],
    ['createVirtualPayOrder', 'cloudfunctions/createVirtualPayOrder/index.js', { planKey: 'shop_basic', role: 'shop', period: 'month', code: 'code' }],
    ['createRecurringContract', 'cloudfunctions/createRecurringContract/index.js', { planKey: 'shop_basic', role: 'shop', period: 'month' }],
    ['createRecurringDebit', 'cloudfunctions/createRecurringDebit/index.js', { subscriptionId: 'legacy-subscription-id' }],
    ['reconcilePay', 'cloudfunctions/reconcilePay/index.js', { Type: 'Timer', TriggerName: 'reconcilePayTimer' }]
  ];
  try {
    for (const [name, file, event] of endpoints) {
      const fixture = makeCloudFixture();
      const fn = loadCloudFunction(file, fixture);
      retired(await fn.main(event), name);
      assert.strictEqual(fixture.writes.length, 0, `${name} must return before database writes.`);
      assert.strictEqual(fixture.network.length, 0, `${name} must return before payment/network calls.`);
    }
  } finally {
    envKeys.forEach((key) => {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    });
  }
}

function testPaywallCompatibilityAllowsImmediately() {
  let appDefinition;
  let componentDefinition;
  let selectedComponents = 0;
  global.App = (definition) => { appDefinition = definition; };
  global.Component = (definition) => { componentDefinition = definition; };
  global.getCurrentPages = () => [{
    selectComponent() {
      selectedComponents += 1;
      return { show(_opts, callback) { callback(false); } };
    }
  }];

  freshRequire('miniprogram/app.js');
  freshRequire('miniprogram/components/paywall/index.js');

  let appAllowed = null;
  appDefinition.paywall({}, (ok) => { appAllowed = ok; });
  assert.strictEqual(appAllowed, true, 'Global paywall compatibility entry should allow immediately.');
  assert.strictEqual(selectedComponents, 0, 'Global paywall must not mount a payment component.');

  const instance = {
    data: { visible: false },
    setData(next) { Object.assign(instance.data, next); }
  };
  let componentAllowed = null;
  componentDefinition.methods.show.call(instance, {}, (ok) => { componentAllowed = ok; });
  assert.strictEqual(componentAllowed, true, 'Paywall component compatibility API should allow immediately.');
  assert.strictEqual(instance.data.visible, false, 'Retired paywall component must remain hidden.');
}

function testRetiredUiAndHistoricalFiles() {
  const paywallJs = read('miniprogram/components/paywall/index.js');
  [
    'FORCE_VIRTUAL_PAY_FOR_TEST', 'createPayOrder', 'createVirtualPayOrder',
    'createRecurringContract', 'requestPayment', 'requestVirtualPayment',
    'navigateToMiniProgram'
  ].forEach((token) => assert(!paywallJs.includes(token), `Paywall must not contain active ${token} behavior.`));

  const retiredUi = [
    'miniprogram/pages/shop/dashboard/index.js',
    'miniprogram/pages/shop/dashboard/index.wxml',
    'miniprogram/pages/profile/index.js',
    'miniprogram/pages/profile/index.wxml',
    'miniprogram/pages/shop/brand-add/index.js'
  ].map(read).join('\n');
  ['paywall', '续费', '试用期', '开通店主版', 'requirePlan'].forEach((token) => {
    assert(!retiredUi.includes(token), `Shop/profile paths must not expose retired ${token} hooks.`);
  });

  const appJson = read('miniprogram/app.json');
  assert(!appJson.includes('wxbd687630cd02ce1d'));
  assert(!appJson.includes('navigateToMiniProgramAppIdList'));

  const legal = read('miniprogram/pages/legal/index.js');
  ['店主版订阅', '连续订阅', '首月免费试用', '停止续费', '成交额的 5%'].forEach((copy) => {
    assert(!legal.includes(copy), `Legal copy must not advertise retired ${copy}.`);
  });

  const debitConfig = JSON.parse(read('cloudfunctions/createRecurringDebit/config.json'));
  assert.deepStrictEqual(debitConfig.triggers || [], [], 'Recurring debit config must have no active trigger.');
  const reconcileConfig = JSON.parse(read('cloudfunctions/reconcilePay/config.json'));
  assert.deepStrictEqual(reconcileConfig.triggers || [], [], 'Legacy payment reconciliation must have no active trigger.');

  [
    'cloudfunctions/payCallback/index.js',
    'cloudfunctions/virtualPayCallback/index.js',
    'cloudfunctions/recurringContractCallback/index.js',
    'cloudfunctions/recurringDebitCallback/index.js',
    'cloudfunctions/cancelRecurringContract/index.js'
  ].forEach((file) => assert(exists(file), `${file} must remain for history/cancellation compatibility.`));
}

(async () => {
  await testFreeBillingCompatibility();
  await testClientPurchaseHelpersFailWithoutMutation();
  await testCloudEndpointsFailBeforeWritesOrNetwork();
  testPaywallCompatibilityAllowsImmediately();
  testRetiredUiAndHistoricalFiles();
  console.log('legacyBillingRetirement tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
