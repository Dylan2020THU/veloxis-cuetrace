const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const root = path.resolve(__dirname, '..');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function matchesCondition(value, condition) {
  if (!condition || typeof condition !== 'object' || !condition.__op) {
    return value === condition;
  }
  if (condition.__op === 'range') {
    return value >= condition.from
      && (condition.includeTo ? value <= condition.to : value < condition.to);
  }
  if (condition.__op === 'in') return condition.values.includes(value);
  return false;
}

function matches(document, query) {
  return Object.keys(query || {}).every((key) => matchesCondition(document[key], query[key]));
}

function makeHarness(orders, options) {
  const settings = options || {};
  const ownerOpenid = 'owner-openid';
  const ownerUserId = crypto.createHash('sha256')
    .update(`wechat:${ownerOpenid}`)
    .digest('hex');
  const queries = [];
  const command = {
    aggregate: { sum: (field) => ({ __sum: field }) },
    gte(from) {
      return {
        and(other) {
          return {
            __op: 'range',
            from,
            to: other.to,
            includeTo: other.__op === 'lte'
          };
        }
      };
    },
    lte(to) {
      return { __op: 'lte', to };
    },
    lt(to) {
      return { __op: 'lt', to };
    },
    in(values) {
      return { __op: 'in', values };
    }
  };
  const collections = {
    shop_orders: orders,
    stores: [],
    shop_coach_links: [],
    training_sessions: [],
    coach_lessons: [],
    wechat_bindings: settings.missingBinding ? [] : [{
      _id: ownerUserId,
      _openid: ownerOpenid,
      accountId: 'report-account-id',
      account: settings.brokenBinding ? 'wrong-report-account' : 'report-account'
    }],
    accounts: [{
      _id: 'report-account-id',
      _openid: ownerOpenid,
      account: 'report-account',
      status: settings.accountStatus || 'active'
    }],
    users: [{
      _id: ownerUserId,
      _openid: ownerOpenid,
      roles: settings.roles || ['shop']
    }]
  };
  const db = {
    command,
    collection(name) {
      const documents = collections[name];
      if (!documents) throw new Error('Unexpected collection: ' + name);
      return {
        doc(id) {
          return {
            async get() {
              return { data: clone(documents.find((item) => item._id === id) || null) };
            }
          };
        },
        aggregate() {
          let query = {};
          const chain = {
            match(next) {
              query = next;
              return chain;
            },
            group() {
              return chain;
            },
            async end() {
              const total = documents
                .filter((item) => matches(item, query))
                .reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
              return { list: total ? [{ total }] : [] };
            }
          };
          return chain;
        },
        where(query) {
          queries.push({ collection: name, query: clone(query) });
          let offset = 0;
          let maximum = Number.POSITIVE_INFINITY;
          const chain = {
            skip(value) {
              offset = value;
              return chain;
            },
            limit(value) {
              maximum = value;
              return chain;
            },
            async get() {
              if (name === 'shop_orders' && settings.failShopOrderQuery) {
                throw new Error('sensitive database failure');
              }
              return {
                data: clone(documents.filter((item) => matches(item, query)).slice(offset, offset + maximum))
              };
            }
          };
          return chain;
        }
      };
    }
  };
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database() {
      return db;
    },
    getWXContext() {
      return { OPENID: ownerOpenid };
    }
  };

  return {
    queries,
    load(relativeFile) {
      const originalLoad = Module._load;
      Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'wx-server-sdk') return cloud;
        return originalLoad.call(this, request, parent, isMain);
      };
      try {
        const filename = path.join(root, relativeFile);
        delete require.cache[require.resolve(filename)];
        return require(filename);
      } finally {
        Module._load = originalLoad;
      }
    }
  };
}

function assertReport(actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    assert.strictEqual(actual[key], value, key);
  }
}

function loadBizPage(fakeData) {
  const filename = path.join(root, 'miniprogram/pages/shop/biz-data/index.js');
  const originalLoad = Module._load;
  const originalPage = global.Page;
  let page;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../../../services/data') return fakeData;
    if (request === '../../../utils/themeBehavior') return {};
    return originalLoad.call(this, request, parent, isMain);
  };
  global.Page = (definition) => { page = definition; };
  try {
    delete require.cache[require.resolve(filename)];
    require(filename);
  } finally {
    Module._load = originalLoad;
    global.Page = originalPage;
  }
  page.data = clone(page.data);
  page.setData = function setData(next) {
    this.data = Object.assign({}, this.data, next);
  };
  return page;
}

function loadDataService(mockOrders) {
  const filename = path.join(root, 'miniprogram/services/data.js');
  const originalLoad = Module._load;
  const fakeMock = {
    getRole() { return 'shop'; },
    readArray(key) { return key === 'dc_shop_orders' ? (mockOrders || []) : []; },
    readObject() { return null; },
    writeArray() {},
    writeObject() {}
  };
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../utils/mock') return fakeMock;
    if (request === '../utils/color') return { levelFromMinutes() { return 0; } };
    if (request === '../utils/billing') return {};
    if (request === '../utils/adminAuth') return {};
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(filename)];
    return require(filename);
  } finally {
    Module._load = originalLoad;
  }
}

async function atTime(value, callback) {
  const originalNow = Date.now;
  Date.now = () => value;
  try {
    return await callback();
  } finally {
    Date.now = originalNow;
  }
}

async function run() {
  const today = '2026-07-14';
  const yesterday = '2026-07-13';
  const todayStartMs = Date.UTC(2026, 6, 13, 16, 0, 0);
  const orders = [
    { _id: 'legacy_today', _openid: 'owner-openid', date: today, amount: 12.34 },
    { _id: 'legacy_yesterday', _openid: 'owner-openid', date: yesterday, amount: 1.5 },
    {
      _id: 'platform_today_without_date',
      schemaVersion: 2,
      _openid: 'owner-openid',
      checkoutAt: todayStartMs,
      orderStatus: 'complete',
      paymentStatus: 'partially_refunded',
      paidTableFeeFen: 10000,
      refundedTableFeeFen: 1000,
      totalCostFen: 500,
      channelFeeFen: 40,
      platformNetFen: 460
    },
    {
      _id: 'platform_yesterday_with_stale_date',
      schemaVersion: 2,
      _openid: 'owner-openid',
      date: today,
      checkoutAt: todayStartMs - 1,
      orderStatus: 'complete',
      paymentStatus: 'paid',
      paidTableFeeFen: 1000,
      refundedTableFeeFen: 0,
      totalCostFen: 50,
      channelFeeFen: 5,
      platformNetFen: 45
    },
    {
      _id: 'external_today_without_date',
      schemaVersion: 2,
      _openid: 'owner-openid',
      checkoutAt: todayStartMs + 2 * 60 * 60 * 1000,
      orderStatus: 'external_paid',
      paymentStatus: 'not_applicable',
      paidTableFeeFen: 3000,
      refundedTableFeeFen: 0,
      externalPaidReason: '现金'
    },
    {
      _id: 'awaiting_today_without_date',
      schemaVersion: 2,
      _openid: 'owner-openid',
      checkoutAt: todayStartMs + 3 * 60 * 60 * 1000,
      orderStatus: 'awaiting_payment',
      paymentStatus: 'unpaid',
      paidTableFeeFen: 5000,
      refundedTableFeeFen: 0
    }
  ];
  const harness = makeHarness(orders);
  const timestamp = Date.UTC(2026, 6, 14, 3, 0, 0);

  const todayResult = await atTime(timestamp, () =>
    harness.load('cloudfunctions/getTodayRevenue/index.js').main()
  );
  assertReport(todayResult, {
    legacyRevenueYuan: 12.34,
    platformPaidFen: 10000,
    externalPaidFen: 3000,
    platformCoverageBps: 7692,
    shopNetTargetFen: 9500,
    totalCostFen: 500,
    channelFeeFen: 40,
    platformNetFen: 460,
    total: 142.34
  });
  const unavailable = await atTime(timestamp, () =>
    makeHarness(orders, { failShopOrderQuery: true })
      .load('cloudfunctions/getTodayRevenue/index.js')
      .main()
  );
  assert.deepStrictEqual(unavailable, {
    ok: false,
    code: 'REVENUE_UNAVAILABLE'
  });
  for (const authCase of [
    [{ accountStatus: 'disabled' }, 'ACCOUNT_NOT_BOUND'],
    [{ roles: ['member'] }, 'SHOP_ROLE_REQUIRED'],
    [{ brokenBinding: true }, 'ACCOUNT_NOT_BOUND']
  ]) {
    const deniedHarness = makeHarness(orders, authCase[0]);
    assert.deepStrictEqual(
      await atTime(timestamp, () => (
        deniedHarness.load('cloudfunctions/getTodayRevenue/index.js').main()
      )),
      { ok: false, code: authCase[1] }
    );
    assert.deepStrictEqual(
      await atTime(timestamp, () => (
        deniedHarness.load('cloudfunctions/getShopBizOverview/index.js').main({ rangeDays: 7 })
      )),
      { ok: false, code: authCase[1] }
    );
    assert.strictEqual(
      deniedHarness.queries.some((entry) => entry.collection === 'shop_orders'),
      false,
      'denied reporting must not read financial orders'
    );
  }
  const todayOrderQueries = harness.queries.filter((entry) => entry.collection === 'shop_orders');
  assert.strictEqual(todayOrderQueries.length, 2, 'today reporting must use exactly two bounded order queries');
  assert(todayOrderQueries.some((entry) => entry.query.date === today));
  assert(todayOrderQueries.some((entry) => (
    entry.query.schemaVersion === 2
      && entry.query.checkoutAt
      && entry.query.checkoutAt.from === todayStartMs
      && entry.query.checkoutAt.to === todayStartMs + 24 * 60 * 60 * 1000
      && entry.query.checkoutAt.includeTo === false
  )), 'schema-v2 today query must be checkoutAt-bounded in Beijing time');

  const overview = await atTime(timestamp, () =>
    harness.load('cloudfunctions/getShopBizOverview/index.js').main({ rangeDays: 7 })
  );
  assertReport(overview.today, {
    legacyRevenueYuan: 12.34,
    platformPaidFen: 10000,
    externalPaidFen: 3000,
    platformCoverageBps: 7692,
    shopNetTargetFen: 9500,
    total: 142.34
  });
  assertReport(overview.range, {
    legacyRevenueYuan: 13.84,
    platformPaidFen: 11000,
    externalPaidFen: 3000,
    platformCoverageBps: 7857,
    shopNetTargetFen: 10450,
    total: 153.84
  });
  assert.strictEqual(overview.today.opens, 3, 'legacy finalized orders remain part of the open-table count');
  assert.strictEqual(overview.range.opens, 5, 'range open-table count keeps legacy compatibility');

  assert.strictEqual(
    overview.today.platformPaidFen + overview.today.externalPaidFen,
    13000,
    'awaiting-payment amount must not enter realized revenue'
  );
  assert.strictEqual(
    overview.range.platformOrderCount,
    2,
    'orders returned by both date and checkoutAt queries must be deduplicated'
  );
  assertReport(overview.trend.find((item) => item.date === today), {
    platformPaidFen: 10000,
    externalPaidFen: 3000
  });
  assertReport(overview.trend.find((item) => item.date === yesterday), {
    legacyRevenueYuan: 1.5,
    platformPaidFen: 1000
  });
  const allOrderQueries = harness.queries.filter((entry) => entry.collection === 'shop_orders');
  assert.strictEqual(allOrderQueries.length, 4, 'each reporting function must use legacy-date plus schema-v2 checkout queries');
  allOrderQueries.forEach((entry) => {
    assert(entry.query.date || entry.query.checkoutAt, 'shop order queries must never scan all history');
  });

  const manualPaidOrders = [
    {
      _id: 'manual_paid',
      schemaVersion: 2,
      _openid: 'owner-openid',
      checkoutAt: todayStartMs,
      orderStatus: 'manual_review',
      paymentStatus: 'paid',
      paidTableFeeFen: 10000,
      totalCostFen: 500,
      channelFeeFen: 100,
      platformNetFen: 400
    },
    {
      _id: 'external_paid',
      schemaVersion: 2,
      _openid: 'owner-openid',
      checkoutAt: todayStartMs + 1,
      orderStatus: 'external_paid',
      paymentStatus: 'not_applicable',
      paidTableFeeFen: 10000,
      externalPaidReason: 'cash'
    }
  ];
  const manualHarness = makeHarness(manualPaidOrders);
  const manualToday = await atTime(timestamp, () => (
    manualHarness.load('cloudfunctions/getTodayRevenue/index.js').main()
  ));
  assertReport(manualToday, {
    platformPaidFen: 10000,
    externalPaidFen: 10000,
    platformCoverageBps: 5000,
    shopNetTargetFen: 9500,
    totalCostFen: 500,
    platformNetFen: 400,
    manualReviewFen: 10000,
    platformOrderCount: 1,
    manualReviewOrderCount: 1,
    total: 200
  });
  const manualOverview = await atTime(timestamp, () => (
    manualHarness.load('cloudfunctions/getShopBizOverview/index.js').main({ rangeDays: 7 })
  ));
  assertReport(manualOverview.today, {
    platformPaidFen: 10000,
    externalPaidFen: 10000,
    platformCoverageBps: 5000,
    shopNetTargetFen: 9500,
    manualReviewFen: 10000,
    platformOrderCount: 1,
    manualReviewOrderCount: 1,
    total: 200
  });

  const retainedCouponOrders = [{
    _id: 'coupon_partially_refunded',
    schemaVersion: 2,
    _openid: 'owner-openid',
    checkoutAt: todayStartMs,
    orderStatus: 'complete',
    paymentStatus: 'partially_refunded',
    paidTableFeeFen: 8000,
    retainedCouponSubsidyFen: 2000,
    totalCostFen: 400,
    channelFeeFen: 80,
    platformNetFen: 320
  }];
  const retainedCouponHarness = makeHarness(retainedCouponOrders);
  const retainedCouponToday = await atTime(timestamp, () => (
    retainedCouponHarness.load('cloudfunctions/getTodayRevenue/index.js').main()
  ));
  assertReport(retainedCouponToday, {
    platformPaidFen: 8000,
    shopNetTargetFen: 9600
  });
  const retainedCouponOverview = await atTime(timestamp, () => (
    retainedCouponHarness
      .load('cloudfunctions/getShopBizOverview/index.js')
      .main({ rangeDays: 7 })
  ));
  assertReport(retainedCouponOverview.today, {
    platformPaidFen: 8000,
    shopNetTargetFen: 9600
  });

  const page = loadBizPage({
    getShopBizOverview() {
      return Promise.resolve(overview);
    }
  });
  await page.load();
  assert.deepStrictEqual(page.data.todayFinance, {
    legacyRevenueYuan: '12.34',
    platformPaidYuan: '100.00',
    externalPaidYuan: '30.00',
    platformCoverage: '76.92%',
    shopNetTargetYuan: '95.00',
    totalCostYuan: '5.00',
    channelFeeYuan: '0.40',
    platformNetYuan: '4.60',
    manualReviewYuan: '0.00'
  });

  const requests = [];
  const racePage = loadBizPage({
    getShopBizOverview(rangeDays) {
      return new Promise((resolve, reject) => {
        requests.push({ rangeDays, resolve, reject });
      });
    }
  });
  const firstLoad = racePage.load();
  racePage.onRange({ currentTarget: { dataset: { key: 30 } } });
  assert.deepStrictEqual(requests.map((request) => request.rangeDays), [7, 30]);
  requests[1].resolve({
    today: { revenue: 30 },
    range: { revenue: 300 },
    trend: []
  });
  await Promise.resolve();
  await Promise.resolve();
  requests[0].resolve({
    today: { revenue: 7 },
    range: { revenue: 70 },
    trend: []
  });
  await firstLoad;
  assert.strictEqual(racePage.data.rangeDays, 30);
  assert.strictEqual(racePage.data.range.revenue, 300);

  const failureRequests = [];
  const failurePage = loadBizPage({
    getShopBizOverview(rangeDays) {
      return new Promise((resolve, reject) => {
        failureRequests.push({ rangeDays, resolve, reject });
      });
    }
  });
  const staleFailure = failurePage.load();
  failurePage.onRange({ currentTarget: { dataset: { key: 30 } } });
  failureRequests[0].reject(new Error('stale seven-day failure'));
  await staleFailure;
  assert.strictEqual(failurePage.data.loading, true);
  failureRequests[1].resolve({
    today: { revenue: 30 },
    range: { revenue: 300 },
    trend: []
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.strictEqual(failurePage.data.range.revenue, 300);

  const wxml = fs.readFileSync(
    path.join(root, 'miniprogram/pages/shop/biz-data/index.wxml'),
    'utf8'
  );
  assert(wxml.includes('平台支付实收'), 'business page should label platform cash separately');
  assert(wxml.includes('外部结账'), 'business page should label external settlement separately');
  assert(wxml.includes('历史记账'), 'business page should label legacy yuan separately');
  assert(wxml.includes('球厅净收入目标'), 'business page must not call the 95% target settled cash');

  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  let todayRevenueResult = { ok: false, code: 'REVENUE_UNAVAILABLE' };
  global.getApp = () => ({ globalData: { cloudReady: true } });
  global.wx = {
    cloud: {
      async callFunction(request) {
        return {
          result: request.name === 'getTodayRevenue' ? todayRevenueResult : null
        };
      }
    }
  };
  try {
    const service = loadDataService();
    await assert.rejects(
      service.getTodayShopRevenue(),
      (error) => error && error.code === 'REVENUE_UNAVAILABLE'
    );
    todayRevenueResult = { ok: true, total: 12.34 };
    assert.strictEqual(await service.getTodayShopRevenue(), 12.34);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }

  global.getApp = () => ({ globalData: { cloudReady: true } });
  global.wx = {
    cloud: {
      async callFunction() {
        return { result: null };
      }
    }
  };
  try {
    const empty = await loadDataService().getShopBizOverview(7);
    assertReport(empty.today, {
      legacyRevenueYuan: 0,
      platformPaidFen: 0,
      externalPaidFen: 0,
      platformCoverageBps: 0,
      shopNetTargetFen: 0
    });
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }

  const localNow = new Date();
  const localKey = [
    localNow.getFullYear(),
    String(localNow.getMonth() + 1).padStart(2, '0'),
    String(localNow.getDate()).padStart(2, '0')
  ].join('-');
  global.getApp = () => ({ globalData: { cloudReady: false } });
  global.wx = {};
  try {
    const local = await loadDataService([{ date: localKey, amount: 2.5 }]).getShopBizOverview(7);
    assertReport(local.today, {
      legacyRevenueYuan: 2.5,
      platformPaidFen: 0,
      externalPaidFen: 0,
      platformCoverageBps: 0,
      shopNetTargetFen: 0,
      total: 2.5
    });
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
}

run().then(() => {
  console.log('table reporting ok');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
