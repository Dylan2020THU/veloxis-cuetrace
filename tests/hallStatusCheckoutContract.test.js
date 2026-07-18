const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pagePath = path.join(root, 'miniprogram/pages/shop/hall-status/index.js');
const dataPath = path.join(root, 'miniprogram/services/data.js');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

function makeData(overrides) {
  return Object.assign({
    getShopStores: () => Promise.resolve([]),
    getSessions: () => Promise.resolve([]),
    getMembers: () => Promise.resolve([]),
    getPendingCheckins: () => Promise.resolve([]),
    resolveCheckin: () => Promise.reject(new Error('unexpected checkin resolution')),
    getShopCoaches: () => Promise.resolve([]),
    createSession: () => Promise.reject(new Error('unexpected session create')),
    addTableOrder: () => Promise.reject(new Error('unexpected quote')),
    genTableCheckoutCode: () => Promise.reject(new Error('unexpected QR')),
    getTableCheckoutOrder: () => Promise.reject(new Error('unexpected status read')),
    markTableOrderExternalPaid: () => Promise.reject(new Error('unexpected external settlement')),
    recordVerifiedTraining: () => Promise.reject(new Error('unexpected training write')),
    closeSession: () => Promise.reject(new Error('unexpected direct session close'))
  }, overrides || {});
}

function makePage(fakeData, wxOverrides) {
  const originalLoad = Module._load;
  const originalPage = global.Page;
  let definition;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../../../services/data') return fakeData;
    if (request === '../../../utils/themeBehavior') return {};
    return originalLoad.call(this, request, parent, isMain);
  };
  global.wx = Object.assign({
    showToast() {},
    showModal() {},
    navigateTo() {}
  }, wxOverrides || {});
  global.Page = (value) => { definition = value; };
  try {
    delete require.cache[require.resolve(pagePath)];
    require(pagePath);
  } finally {
    Module._load = originalLoad;
    global.Page = originalPage;
  }
  assert(definition, 'Hall page should register with Page().');
  const page = Object.assign({}, definition, { data: clone(definition.data) });
  page.setData = function setData(patch, callback) {
    this.data = Object.assign({}, this.data, patch);
    if (callback) callback.call(this);
  };
  return page;
}

function quote() {
  return {
    orderId: 'ord_checkout_1',
    sessionId: 'session_1',
    paidTableFeeFen: 9000,
    quotedTableFeeFen: 9000,
    tableGrossFen: 10000,
    tableDiscountFen: 1000,
    actualDurationMs: 3600000,
    pricePerHourFen: 10000,
    orderStatus: 'awaiting_payment',
    paymentStatus: 'unpaid'
  };
}

async function testServerQuoteAndFirstTokenQrOnly() {
  const quoteCalls = [];
  const qrCalls = [];
  let trainingWrites = 0;
  let directCloses = 0;
  const token = 'AbCdEfGhIjKlMnOpQrStUw';
  const page = makePage(makeData({
    addTableOrder(input) {
      quoteCalls.push(input);
      return Promise.resolve({ ok: true, checkoutToken: token, quote: quote() });
    },
    genTableCheckoutCode(input) {
      qrCalls.push(input);
      return Promise.resolve({ ok: true, imageBase64: 'UE5H', contentType: 'image/png' });
    },
    recordVerifiedTraining() {
      trainingWrites += 1;
      return Promise.resolve();
    },
    closeSession() {
      directCloses += 1;
      return Promise.resolve();
    }
  }));
  page.data.filteredTables = [{
    tableId: 'T1',
    tableName: '一号桌',
    status: 'occupied',
    revenue: 999999,
    session: { _id: 'session_1', status: 'active', startedAt: 1 }
  }];
  page.startCheckoutPolling = function startCheckoutPolling() {
    this.pollStarted = true;
  };

  await page.closeTable(0);

  assert.deepStrictEqual(quoteCalls, [{ sessionId: 'session_1' }]);
  assert.deepStrictEqual(qrCalls, [{ orderId: 'ord_checkout_1', token }]);
  assert.strictEqual(trainingWrites, 0);
  assert.strictEqual(directCloses, 0);
  assert.strictEqual(page.data.checkoutSheet.quoteAmountYuan, '90.00');
  assert.strictEqual(page.data.checkoutSheet.qrSrc, 'data:image/png;base64,UE5H');
  assert.strictEqual(page.pollStarted, true);
  assert(!JSON.stringify(quoteCalls).includes('999999'), 'Local estimated amount must not cross the quote boundary.');
}

async function testStaleQuoteAndQrCannotOverwriteNewCheckout() {
  const firstQuote = deferred();
  const secondQuote = deferred();
  const qrCalls = [];
  const page = makePage(makeData({
    addTableOrder(input) {
      return input.sessionId === 'session_1' ? firstQuote.promise : secondQuote.promise;
    },
    genTableCheckoutCode(input) {
      qrCalls.push(input);
      return Promise.resolve({
        ok: true,
        imageBase64: input.orderId === 'ord_1' ? 'UVIx' : 'UVIy',
        contentType: 'image/png'
      });
    }
  }));
  page.data.filteredTables = [
    { tableName: '一号桌', status: 'occupied', session: { _id: 'session_1' } },
    { tableName: '二号桌', status: 'occupied', session: { _id: 'session_2' } }
  ];
  page.startCheckoutPolling = function startCheckoutPolling() {};

  const first = page.closeTable(0);
  page.closeCheckoutSheet();
  const second = page.closeTable(1);
  secondQuote.resolve({
    ok: true,
    checkoutToken: 'token_2',
    quote: Object.assign({}, quote(), {
      orderId: 'ord_2',
      sessionId: 'session_2',
      quotedTableFeeFen: 200
    })
  });
  await second;

  firstQuote.resolve({
    ok: true,
    checkoutToken: 'token_1',
    quote: Object.assign({}, quote(), {
      orderId: 'ord_1',
      sessionId: 'session_1',
      quotedTableFeeFen: 100
    })
  });
  await first;

  assert.deepStrictEqual(qrCalls, [{ orderId: 'ord_2', token: 'token_2' }]);
  assert.strictEqual(page.data.checkoutSheet.sessionId, 'session_2');
  assert.strictEqual(page.data.checkoutSheet.tableName, '二号桌');
  assert.strictEqual(page.data.checkoutSheet.orderId, 'ord_2');
  assert.strictEqual(page.data.checkoutSheet.token, 'token_2');
  assert.strictEqual(page.data.checkoutSheet.qrSrc, 'data:image/png;base64,UVIy');
  assert.strictEqual(page.data.checkoutSheet.quoteAmountYuan, '2.00');
}

async function testAwaitingSessionRemainsOccupied() {
  const page = makePage(makeData({
    getShopStores() {
      return Promise.resolve([{
        _id: 'store_1',
        tableTypes: [{ tableId: 'T1', name: '一号桌', pricePerHour: 100 }]
      }]);
    },
    getSessions() {
      return Promise.resolve([{
        _id: 'session_1',
        tableId: 'T1',
        status: 'awaiting_payment',
        startedAt: 1000,
        checkoutAt: 3601000,
        orderId: 'ord_checkout_1'
      }]);
    }
  }));
  page.data.currentStoreId = 'store_1';
  page._applyFilters = function applyFilters() {
    this.setData({ filteredTables: this.data.tables.slice() });
  };

  page._loadByStore('store_1');
  await flushPromises();
  await flushPromises();

  assert.strictEqual(page.data.tables[0].status, 'occupied');
  assert.strictEqual(page.data.tables[0].checkoutPending, true);
  assert.strictEqual(page.data.tables[0].session.status, 'awaiting_payment');
}

async function testStatusComesOnlyFromServerPolling() {
  const reads = [];
  const token = 'AbCdEfGhIjKlMnOpQrStUw';
  let reloads = 0;
  const page = makePage(makeData({
    getTableCheckoutOrder(input) {
      reads.push(input);
      return Promise.resolve({
        ok: true,
        order: { orderStatus: 'complete', paymentStatus: 'paid', canPay: false }
      });
    }
  }));
  page.data.checkoutSheet = {
    sessionId: 'session_1',
    orderId: 'ord_checkout_1',
    token,
    status: 'awaiting_payment'
  };
  page.stopCheckoutPolling = function stopCheckoutPolling() {};
  page.loadInit = function loadInit() { reloads += 1; };

  await page._pollCheckoutStatus();

  assert.deepStrictEqual(reads, [{ token }]);
  assert.strictEqual(page.data.checkoutSheet.status, 'complete');
  assert.strictEqual(page.data.checkoutSheet.paymentStatus, 'paid');
  assert.strictEqual(reloads, 1);
}

async function testExternalSettlementIsSeparateAndReasonOnly() {
  const calls = [];
  let trainingWrites = 0;
  const page = makePage(makeData({
    markTableOrderExternalPaid(input) {
      calls.push(input);
      return Promise.resolve({ ok: true, orderStatus: 'external_paid' });
    },
    recordVerifiedTraining() {
      trainingWrites += 1;
      return Promise.resolve();
    }
  }));
  page.data.checkoutSheet = { orderId: 'ord_checkout_1', sessionId: 'session_1' };
  page.loadInit = function loadInit() {};
  page.stopCheckoutPolling = function stopCheckoutPolling() {};
  page.openExternalCheckout();
  page.onExternalReasonInput({ detail: { value: '  现金收款  ' } });

  await page.confirmExternalCheckout();

  assert.deepStrictEqual(calls, [{ orderId: 'ord_checkout_1', reason: '现金收款' }]);
  assert.strictEqual(trainingWrites, 0);
  assert.strictEqual(page.data.externalSheet, null);
}

async function testReadyCheckinStartsSessionWithoutTrainingSideEffects() {
  let trainingWrites = 0;
  let checkinResolutions = 0;
  const sessionCreates = [];
  const toasts = [];
  const page = makePage(makeData({
    createSession(input) {
      sessionCreates.push(clone(input));
      return Promise.resolve({ ok: true, sessionId: 'session-ready' });
    },
    recordVerifiedTraining() {
      trainingWrites += 1;
      return Promise.resolve({ ok: true });
    },
    resolveCheckin() {
      checkinResolutions += 1;
      return Promise.resolve({ ok: true });
    }
  }), {
    showModal(options) {
      options.success({ confirm: true });
    },
    showToast(options) {
      toasts.push(options.title);
    }
  });
  page.data.currentStoreId = 'store-a';
  page.data.pendingCheckins = [
    {
      _id: 'historical-confirmed',
      memberOpenid: 'member-a',
      storeId: 'store-a',
      tableId: 'T1',
      role: 'member',
      ready: true,
      status: 'confirmed'
    },
    {
      _id: 'other-store-ready',
      memberOpenid: 'member-a',
      storeId: 'store-b',
      tableId: 'T1',
      role: 'member',
      ready: true,
      status: 'pending'
    },
    {
      _id: 'checkin-current',
      memberOpenid: 'member-a',
      storeId: 'store-a',
      tableId: 'T1',
      role: 'member',
      ready: true,
      status: 'pending'
    },
    {
      _id: 'coach-checkin-current',
      memberOpenid: 'coach-a',
      storeId: 'store-a',
      tableId: 'T1',
      role: 'coach',
      ready: true,
      status: 'pending'
    }
  ];
  page.data.coaches = [{ _cid: 'coach-a', _linkId: 'coach-link-current' }];
  page.data.filteredTables = [{
    tableId: 'T1',
    tableName: '一号桌',
    pendingVerify: true,
    pendingCheckinIds: ['checkin-current', 'coach-checkin-current'],
    coachOpenid: 'coach-a',
    elapsedMs: 60000,
    players: [{ openid: 'member-a', nickname: '球员', isCoach: false }]
  }];
  page._loadPending = function loadPending() {};
  page.loadInit = function loadInit() {};

  const outcome = await page.verifyTableCheckin({ currentTarget: { dataset: { idx: 0 } } });
  await flushPromises();
  await flushPromises();

  assert.deepStrictEqual(outcome, { ok: true, sessionId: 'session-ready' });
  assert.deepStrictEqual(sessionCreates, [{
    tableId: 'T1',
    storeId: 'store-a',
    memberOpenid: 'member-a',
    memberCheckinId: 'checkin-current',
    coachOpenid: 'coach-a',
    coachCheckinId: 'coach-checkin-current',
    coachLinkId: 'coach-link-current'
  }]);
  assert.strictEqual(trainingWrites, 0);
  assert.strictEqual(checkinResolutions, 0);
  assert(toasts.length > 0);
}

async function testSessionCreationForwardsExactEntitlementAssociations() {
  const createCalls = [];
  let checkinResolutions = 0;
  const page = makePage(makeData({
    createSession(input) {
      createCalls.push(clone(input));
      return Promise.resolve({ ok: true, sessionId: 'session-new' });
    },
    resolveCheckin() {
      checkinResolutions += 1;
      return Promise.resolve({ ok: true });
    }
  }));
  page.data.currentStoreId = 'store-a';
  page.data.filteredTables = [{ tableId: 'table-a', tableName: '涓€鍙锋' }];
  page.loadInit = function loadInit() {};
  page._loadPending = function loadPending() {};

  await page.openTable(0, {
    memberOpenid: 'member-a',
    requestId: 'checkin-current',
    coachOpenid: 'coach-a',
    coachCheckinId: 'coach-checkin-current',
    coachLinkId: 'coach-link-current'
  });

  assert.deepStrictEqual(createCalls, [{
    tableId: 'table-a',
    storeId: 'store-a',
    memberOpenid: 'member-a',
    memberCheckinId: 'checkin-current',
    coachOpenid: 'coach-a',
    coachCheckinId: 'coach-checkin-current',
    coachLinkId: 'coach-link-current'
  }]);
  assert.strictEqual(checkinResolutions, 0, 'createSession must bind and confirm atomically');

  let selected;
  page.openTable = (idx, options) => { selected = { idx, options }; };
  page.data.openSheet = {
    idx: 0,
    tableId: 'table-a',
    selectedMember: 'member-a',
    requests: [{
      _id: 'checkin-current',
      memberOpenid: 'member-a',
      tableId: 'table-a',
      ready: true,
      role: 'member'
    }, {
      _id: 'coach-checkin-current',
      memberOpenid: 'coach-a',
      tableId: 'table-a',
      ready: true,
      role: 'coach',
      status: 'pending'
    }],
    isCoaching: true,
    coachOpenid: 'coach-a'
  };
  page.data.coaches = [{ _cid: 'coach-a', _linkId: 'coach-link-current' }];
  page.confirmUse();
  assert.deepStrictEqual(selected, {
    idx: 0,
    options: {
      memberOpenid: 'member-a',
      request: page.data.openSheet.requests[0],
      coachOpenid: 'coach-a',
      requestId: 'checkin-current',
      coachCheckinId: 'coach-checkin-current',
      coachLinkId: 'coach-link-current'
    }
  });
}

async function testMultipleReadyCheckinsRemainSelectableAndRejectable() {
  const resolutions = [];
  let creates = 0;
  const page = makePage(makeData({
    createSession() {
      creates += 1;
      return Promise.resolve({ ok: true });
    },
    resolveCheckin(requestId, action) {
      resolutions.push([requestId, action]);
      return Promise.resolve({ ok: true, status: 'rejected' });
    }
  }));
  page.data.currentStoreId = 'store-a';
  page.data.pendingCheckins = [
    {
      _id: 'checkin-a', memberOpenid: 'member-a', storeId: 'store-a',
      tableId: 'table-a', role: 'member', ready: true, status: 'pending'
    },
    {
      _id: 'checkin-b', memberOpenid: 'member-b', storeId: 'store-a',
      tableId: 'table-a', role: 'member', ready: true, status: 'pending'
    }
  ];
  page.data.filteredTables = [{
    tableId: 'table-a',
    tableName: 'A',
    status: 'occupied',
    pendingVerify: true,
    pendingCheckinIds: ['checkin-a', 'checkin-b']
  }];
  page._loadPending = () => Promise.resolve();

  page.toggleTable({ currentTarget: { dataset: { idx: 0 } } });
  assert(page.data.openSheet, 'pending check-ins should open the owner selection sheet');
  assert.deepStrictEqual(
    page.data.openSheet.requests.map((item) => item._id),
    ['checkin-a', 'checkin-b']
  );
  assert.strictEqual(creates, 0);

  await page.rejectPendingCheckin({
    currentTarget: { dataset: { requestId: 'checkin-b' } },
    stopPropagation() {}
  });
  assert.deepStrictEqual(resolutions, [['checkin-b', 'reject']]);
}

async function testDataServiceCheckoutCodeBoundary() {
  const calls = [];
  const app = { globalData: { cloudReady: true } };
  global.getApp = () => app;
  global.wx = {
    cloud: {
      callFunction(request) {
        calls.push(request);
        return Promise.resolve({ result: { ok: true, imageBase64: 'UE5H', contentType: 'image/png' } });
      }
    }
  };
  delete require.cache[require.resolve(dataPath)];
  const data = require(dataPath);
  await data.genTableCheckoutCode({ orderId: 'ord_checkout_1', token: 'token', ignored: true });
  await data.genTableCheckoutCode({ orderId: 'ord_checkout_1', rotate: true, token: 'ignored' });
  await data.createSession({
    storeId: 'store-a',
    tableId: 'table-a',
    memberOpenid: 'member-a',
    memberCheckinId: 'checkin-current',
    coachOpenid: 'coach-a',
    coachCheckinId: 'coach-checkin-current',
    coachLinkId: 'coach-link-current'
  });
  assert.deepStrictEqual(calls, [
    { name: 'genTableCheckoutCode', data: { orderId: 'ord_checkout_1', token: 'token' } },
    { name: 'genTableCheckoutCode', data: { orderId: 'ord_checkout_1', rotate: true } },
    {
      name: 'createSession',
      data: {
        tableId: 'table-a',
        storeId: 'store-a',
        memberOpenid: 'member-a',
        memberCheckinId: 'checkin-current',
        coachOpenid: 'coach-a',
        coachCheckinId: 'coach-checkin-current',
        coachLinkId: 'coach-link-current'
      }
    }
  ]);
  app.globalData.cloudReady = false;
  await assert.rejects(
    data.genTableCheckoutCode({ orderId: 'ord_checkout_1', token: 'token' }),
    (error) => error && error.code === 'CLOUD_NOT_READY'
  );
}

function testStaticContractCopyAndOldClosePathRemoval() {
  const js = fs.readFileSync(pagePath, 'utf8');
  const wxml = fs.readFileSync(
    path.join(root, 'miniprogram/pages/shop/hall-status/index.wxml'),
    'utf8'
  );
  const wxss = fs.readFileSync(
    path.join(root, 'miniprogram/pages/shop/hall-status/index.wxss'),
    'utf8'
  );
  for (const text of ['不是微信支付成功', '不收取平台抽成', '不会自动获得已核验训练权益']) {
    assert(wxml.includes(text), `External sheet must disclose: ${text}`);
  }
  assert(wxml.includes('checkoutSheet.qrSrc'));
  assert(wxml.includes('确认开台'));
  assert(wxml.includes("checkoutSheet.status === 'external_paid'"));
  assert(wxml.includes("checkoutSheet.status !== 'external_paid'"));
  assert(wxml.includes('服务端计价'));
  assert(wxss.includes('.checkout-qr'));
  const closeBody = js.slice(js.indexOf('  closeTable(idx) {'), js.indexOf('\n  // 结账同步'));
  assert(!closeBody.includes('table.revenue'));
  assert(!closeBody.includes('closeSession'));
  assert(!closeBody.includes('_syncTrainingOnClose'));
  assert(!js.includes('data.recordVerifiedTraining'));
  assert(!js.includes('_syncTrainingOnClose'));
  assert(!js.includes("getPendingCheckins(autoJump ? ''"));
  assert(wxml.includes('catchtap="rejectPendingCheckin"'));
  assert(!/paymentStatus\s*:\s*['"]paid['"]/.test(js), 'Hall must never declare WeChat payment success locally.');
}

async function main() {
  await testServerQuoteAndFirstTokenQrOnly();
  await testStaleQuoteAndQrCannotOverwriteNewCheckout();
  await testAwaitingSessionRemainsOccupied();
  await testStatusComesOnlyFromServerPolling();
  await testExternalSettlementIsSeparateAndReasonOnly();
  await testReadyCheckinStartsSessionWithoutTrainingSideEffects();
  await testSessionCreationForwardsExactEntitlementAssociations();
  await testMultipleReadyCheckinsRemainSelectableAndRejectable();
  await testDataServiceCheckoutCodeBoundary();
  testStaticContractCopyAndOldClosePathRemoval();
  console.log('hall status checkout contract ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
