const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dataPath = path.join(root, 'miniprogram/services/data.js');
const pagePath = path.join(root, 'miniprogram/pages/table-checkout/index.js');
const token = 'AbCdEfGhIjKlMnOpQrStUw';

function freshRequire(filename) {
  delete require.cache[require.resolve(filename)];
  return require(filename);
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function publicOrder(overrides) {
  return Object.assign({
    storeName: '测试球厅',
    tableName: '一号桌',
    startedAt: 1000,
    checkoutAt: 3601000,
    billedDurationMs: 3600000,
    pricePerHourFen: 10000,
    tableGrossFen: 10000,
    tableDiscountFen: 1000,
    quotedTableFeeFen: 9000,
    orderStatus: 'awaiting_payment',
    paymentStatus: 'unpaid',
    canPay: true
  }, overrides || {});
}

function makePage(options) {
  const app = {
    globalData: { cloudReady: true, theme: 'light' },
    watchTheme() {},
    unwatchTheme() {}
  };
  global.getApp = () => app;
  global.Behavior = (definition) => definition;
  global.wx = Object.assign({
    setNavigationBarColor() {},
    showToast() {},
    requestPayment() {}
  }, options.wx || {});

  const data = freshRequire(dataPath);
  data.getTableCheckoutOrder = options.getTableCheckoutOrder;
  data.createTablePayOrder = options.createTablePayOrder || (() => Promise.reject(new Error('unexpected pay')));

  let definition = null;
  global.Page = (value) => { definition = value; };
  const helpers = freshRequire(pagePath);
  assert(definition, 'Checkout page should register itself with Page().');
  const page = Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data))
  });
  page.setData = function setData(patch) {
    this.data = Object.assign({}, this.data, patch);
  };
  return { app, data, helpers, page };
}

function makeFakeTimers() {
  let nextId = 1;
  const callbacks = new Map();
  const cleared = [];
  return {
    setTimeout(callback) {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      cleared.push(id);
      callbacks.delete(id);
    },
    runNext() {
      const entry = callbacks.entries().next();
      if (entry.done) return false;
      const [id, callback] = entry.value;
      callbacks.delete(id);
      callback();
      return true;
    },
    get size() {
      return callbacks.size;
    },
    cleared
  };
}

async function testDataServiceUsesOnlyFailClosedCloudCalls() {
  const calls = [];
  const app = { globalData: { cloudReady: true } };
  global.getApp = () => app;
  global.wx = {
    cloud: {
      callFunction(request) {
        calls.push(request);
        if (request.name === 'getTableCheckoutOrder') {
          return Promise.resolve({ result: { ok: true, order: publicOrder() } });
        }
        return Promise.resolve({
          result: {
            timeStamp: '1',
            nonceStr: 'nonce',
            package: 'prepay_id=wx',
            signType: 'RSA',
            paySign: 'signature'
          }
        });
      }
    }
  };

  const data = freshRequire(dataPath);
  await data.getTableCheckoutOrder({ token, ignored: 'must-not-cross-boundary' });
  await data.createTablePayOrder({ token, amount: 1, orderId: 'forbidden' });
  assert.deepStrictEqual(calls, [
    { name: 'getTableCheckoutOrder', data: { token } },
    { name: 'createTablePayOrder', data: { token } }
  ]);

  app.globalData.cloudReady = false;
  await assert.rejects(
    data.getTableCheckoutOrder({ token }),
    (error) => error && error.code === 'CLOUD_NOT_READY'
  );
  await assert.rejects(
    data.createTablePayOrder({ token }),
    (error) => error && error.code === 'CLOUD_NOT_READY'
  );
  assert.strictEqual(calls.length, 2, 'Cloud-not-ready mode must not call cloud or use mock payment data.');
}

async function testOnlyDirectTokenOrExactSceneLoadsPublicOrder() {
  const calls = [];
  const harness = makePage({
    getTableCheckoutOrder(input) {
      calls.push(input);
      return Promise.resolve({
        ok: true,
        order: Object.assign(publicOrder(), {
          _id: 'internal-order',
          shopNetFen: 8550,
          outTradeNo: 'internal-trade-number'
        })
      });
    }
  });

  assert.strictEqual(harness.helpers.parseCheckoutToken({ token }), token);
  assert.strictEqual(harness.helpers.parseCheckoutToken({ scene: encodeURIComponent('t=' + token) }), token);
  for (const suffix of ['A', 'Q', 'g', 'w']) {
    const canonical = 'A'.repeat(21) + suffix;
    assert.strictEqual(harness.helpers.parseCheckoutToken({ token: canonical }), canonical);
    assert.strictEqual(harness.helpers.parseCheckoutToken({ scene: 't=' + canonical }), canonical);
  }
  for (const invalid of [
    {},
    { t: token },
    { token: 'A'.repeat(21) },
    { token: 'A'.repeat(21) + '+' },
    { token: 'A'.repeat(21) + 'B' },
    { token: 'AbCdEfGhIjKlMnOpQrStUv' },
    { scene: 'x=' + token },
    { scene: 't=' + 'A'.repeat(21) + 'B' },
    { scene: 't=' + token + '&orderId=internal' },
    { scene: '%E0%A4%A' }
  ]) {
    assert.strictEqual(harness.helpers.parseCheckoutToken(invalid), '');
  }

  harness.page.onLoad({ scene: encodeURIComponent('t=' + token) });
  await flushPromises();
  assert.deepStrictEqual(calls, [{ token }]);
  assert.deepStrictEqual(Object.keys(harness.page.data.order), [
    'storeName',
    'tableName',
    'startedAt',
    'checkoutAt',
    'billedDurationMs',
    'pricePerHourFen',
    'tableGrossFen',
    'tableDiscountFen',
    'quotedTableFeeFen',
    'orderStatus',
    'paymentStatus',
    'canPay'
  ]);
  assert(!JSON.stringify(harness.page.data).includes('internal-order'));
  assert(!JSON.stringify(harness.page.data).includes('internal-trade-number'));
  assert(!JSON.stringify(harness.page.data).includes('8550'));

  const invalidHarness = makePage({
    getTableCheckoutOrder() {
      throw new Error('invalid tokens must stop before the service layer');
    }
  });
  invalidHarness.page.onLoad({ orderId: 'internal-order' });
  await flushPromises();
  assert.strictEqual(invalidHarness.page.data.loading, false);
  assert(invalidHarness.page.data.error);
}

async function testAllOrderReadsUseOneNewestResponseGeneration() {
  const timers = makeFakeTimers();
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  global.setTimeout = timers.setTimeout;
  global.clearTimeout = timers.clearTimeout;
  try {
    const staleOrder = { ok: true, order: publicOrder() };
    const paidOrder = {
      ok: true,
      order: publicOrder({ orderStatus: 'complete', paymentStatus: 'paid', canPay: false })
    };

    const firstLoad = deferred();
    const retryLoad = deferred();
    let loadReads = 0;
    const loadHarness = makePage({
      getTableCheckoutOrder() {
        loadReads += 1;
        return loadReads === 1 ? firstLoad.promise : retryLoad.promise;
      }
    });
    loadHarness.page.onLoad({ token });
    loadHarness.page.retryLoad();
    retryLoad.resolve(paidOrder);
    await flushPromises();
    firstLoad.resolve(staleOrder);
    await flushPromises();

    const hiddenLoad = deferred();
    const shownLoad = deferred();
    let lifecycleReads = 0;
    const lifecycleHarness = makePage({
      getTableCheckoutOrder() {
        lifecycleReads += 1;
        return lifecycleReads === 1 ? hiddenLoad.promise : shownLoad.promise;
      }
    });
    lifecycleHarness.page.onLoad({ token });
    lifecycleHarness.page.onHide();
    lifecycleHarness.page.onShow();
    shownLoad.resolve(paidOrder);
    await flushPromises();
    hiddenLoad.resolve(staleOrder);
    await flushPromises();

    const stalePoll = deferred();
    const freshRetry = deferred();
    let pollReads = 0;
    const pollingHarness = makePage({
      getTableCheckoutOrder() {
        pollReads += 1;
        if (pollReads === 1) return Promise.resolve(staleOrder);
        if (pollReads === 2) return stalePoll.promise;
        return freshRetry.promise;
      }
    });
    pollingHarness.page.onLoad({ token });
    await flushPromises();
    pollingHarness.page.startStatusPolling();
    pollingHarness.page.retryLoad();
    freshRetry.resolve(paidOrder);
    await flushPromises();
    stalePoll.resolve(staleOrder);
    await flushPromises();
    await flushPromises();

    const unloadedLoad = deferred();
    const unloadedHarness = makePage({
      getTableCheckoutOrder() { return unloadedLoad.promise; }
    });
    unloadedHarness.page.onLoad({ token });
    unloadedHarness.page.onUnload();
    unloadedLoad.resolve(staleOrder);
    await flushPromises();

    const observed = [
      loadHarness.page.data.order && loadHarness.page.data.order.paymentStatus,
      lifecycleHarness.page.data.order && lifecycleHarness.page.data.order.paymentStatus,
      pollingHarness.page.data.order && pollingHarness.page.data.order.paymentStatus,
      unloadedHarness.page.data.order
    ];
    pollingHarness.page.onUnload();
    assert.deepStrictEqual(observed, [
      'paid',
      'paid',
      'paid',
      null
    ], 'Only the newest ordinary, retry, hide/show, or polling response may update page state.');
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
}

async function testPaymentCallbacksPollServerWithoutLocalSuccessAndPreventDoubleTap() {
  const pay = deferred();
  const poll = deferred();
  const paymentRequests = [];
  let orderReads = 0;
  let payCalls = 0;
  const harness = makePage({
    getTableCheckoutOrder() {
      orderReads += 1;
      if (orderReads === 1) return Promise.resolve({ ok: true, order: publicOrder() });
      return poll.promise;
    },
    createTablePayOrder(input) {
      payCalls += 1;
      assert.deepStrictEqual(input, { token });
      return pay.promise;
    },
    wx: {
      requestPayment(request) {
        paymentRequests.push(request);
      }
    }
  });

  harness.page.onLoad({ token });
  await flushPromises();
  harness.page.pay();
  harness.page.pay();
  assert.strictEqual(payCalls, 1, 'A second tap must not create another payment request.');

  pay.resolve({
    timeStamp: '1',
    nonceStr: 'nonce',
    package: 'prepay_id=wx',
    signType: 'RSA',
    paySign: 'signature',
    outTradeNo: 'must-not-be-forwarded'
  });
  await flushPromises();
  assert.strictEqual(paymentRequests.length, 1);
  assert.deepStrictEqual(Object.keys(paymentRequests[0]).sort(), [
    'complete', 'fail', 'nonceStr', 'package', 'paySign', 'signType', 'success', 'timeStamp'
  ]);
  assert.strictEqual(paymentRequests[0].success, paymentRequests[0].fail);
  assert.strictEqual(paymentRequests[0].fail, paymentRequests[0].complete);

  paymentRequests[0].fail({ errMsg: 'requestPayment:fail cancel' });
  assert.strictEqual(harness.page.data.order.paymentStatus, 'unpaid');
  assert.strictEqual(orderReads, 2, 'Any requestPayment callback should begin server polling.');
  poll.resolve({
    ok: true,
    order: publicOrder({ orderStatus: 'complete', paymentStatus: 'paid', canPay: false })
  });
  await flushPromises();
  await flushPromises();
  assert.strictEqual(harness.page.data.order.paymentStatus, 'paid', 'Paid state may only arrive from the server read.');
  assert.strictEqual(harness.page.data.polling, false);
}

async function testPollingIsBoundedAndLifecycleClearsTimers() {
  const timers = makeFakeTimers();
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  global.setTimeout = timers.setTimeout;
  global.clearTimeout = timers.clearTimeout;
  try {
    let reads = 0;
    let paymentRequest = null;
    const harness = makePage({
      getTableCheckoutOrder() {
        reads += 1;
        return Promise.resolve({ ok: true, order: publicOrder() });
      },
      createTablePayOrder() {
        return Promise.resolve({
          timeStamp: '1',
          nonceStr: 'nonce',
          package: 'prepay_id=wx',
          signType: 'RSA',
          paySign: 'signature'
        });
      },
      wx: {
        requestPayment(request) { paymentRequest = request; }
      }
    });

    harness.page.onLoad({ token });
    await flushPromises();
    harness.page.pay();
    await flushPromises();
    paymentRequest.success({ errMsg: 'requestPayment:ok' });
    await flushPromises();
    await flushPromises();

    let timerRuns = 0;
    while (timers.runNext()) {
      timerRuns += 1;
      assert(timerRuns <= harness.helpers.MAX_POLL_ATTEMPTS, 'Polling must have a hard upper bound.');
      await flushPromises();
      await flushPromises();
    }
    assert.strictEqual(reads - 1, harness.helpers.MAX_POLL_ATTEMPTS);
    assert.strictEqual(harness.page.data.polling, false);
    assert.strictEqual(timers.size, 0);

    harness.page.startStatusPolling();
    await flushPromises();
    await flushPromises();
    assert.strictEqual(timers.size, 1);
    harness.page.onHide();
    assert.strictEqual(timers.size, 0, 'onHide must clear the pending poll timer.');
    assert(timers.cleared.length > 0);

    harness.page.onShow();
    await flushPromises();
    harness.page.startStatusPolling();
    await flushPromises();
    await flushPromises();
    assert.strictEqual(timers.size, 1);
    harness.page.onUnload();
    assert.strictEqual(timers.size, 0, 'onUnload must clear the pending poll timer.');
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
}

function testStaticPageContract() {
  const app = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8'));
  assert(app.pages.includes('pages/table-checkout/index'));

  const js = fs.readFileSync(pagePath, 'utf8');
  const wxml = fs.readFileSync(path.join(root, 'miniprogram/pages/table-checkout/index.wxml'), 'utf8');
  const joined = js + '\n' + wxml;
  for (const forbidden of [
    '_id',
    'orderId',
    'shopId',
    'payerOpenid',
    'outTradeNo',
    'subMchid',
    'checkoutTokenHash',
    'transactionId',
    'paymentProfileSnapshot',
    'shopNetFen',
    'platformNetFen'
  ]) {
    assert(!joined.includes(forbidden), `Checkout page must not expose internal field ${forbidden}.`);
  }
  assert(!/paymentStatus\s*:\s*['\"]paid['\"]/.test(js), 'The page must never set paid locally.');
  assert(!joined.includes('markTableOrderExternalPaid'));
  assert(wxml.includes('quotedTableFeeText'));
  assert(wxml.includes('paymentStatusText'));
}

async function main() {
  await testDataServiceUsesOnlyFailClosedCloudCalls();
  await testOnlyDirectTokenOrExactSceneLoadsPublicOrder();
  await testAllOrderReadsUseOneNewestResponseGeneration();
  await testPaymentCallbacksPollServerWithoutLocalSuccessAndPreventDoubleTap();
  await testPollingIsBoundedAndLifecycleClearsTimers();
  testStaticPageContract();
  console.log('table checkout page contract ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
