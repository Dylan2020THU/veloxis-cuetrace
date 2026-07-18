const assert = require('assert');
const fs = require('fs');
const path = require('path');

const modulePath = path.resolve(
  __dirname,
  '../cloudfunctions/_shared/table-finance/state.js'
);

assert(fs.existsSync(modulePath), 'table finance state module should exist');

const {
  assertTransition,
  orderIdForSession,
  outTradeNoForOrder,
  splitNoForOrder,
  refundNoForOrder,
  financialEventId
} = require(modulePath);

function testSessionTransitions() {
  assert.strictEqual(
    assertTransition('session', 'active', 'awaiting_payment'),
    true
  );
  assert.strictEqual(
    assertTransition('session', 'awaiting_payment', 'closed'),
    true
  );
  assert.strictEqual(assertTransition('session', 'closed', 'closed'), true);
  assert.throws(
    () => assertTransition('session', 'active', 'closed'),
    /transition/
  );
}

function testOrderTransitions() {
  ['complete', 'external_paid', 'canceled', 'manual_review'].forEach((to) => {
    assert.strictEqual(assertTransition('order', 'awaiting_payment', to), true);
  });
  assert.strictEqual(
    assertTransition('order', 'complete', 'manual_review'),
    true
  );
  assert.strictEqual(
    assertTransition('order', 'manual_review', 'complete'),
    true
  );
  assert.strictEqual(
    assertTransition('order', 'manual_review', 'canceled'),
    true
  );
  assert.throws(
    () => assertTransition('order', 'external_paid', 'complete'),
    /transition/
  );
  assert.throws(
    () => assertTransition('order', 'canceled', 'awaiting_payment'),
    /transition/
  );
}

function testPaymentTransitions() {
  assert.strictEqual(assertTransition('payment', 'unpaid', 'paid'), true);
  assert.strictEqual(assertTransition('payment', 'unpaid', 'closed'), true);
  assert.strictEqual(
    assertTransition('payment', 'paid', 'partially_refunded'),
    true
  );
  assert.strictEqual(assertTransition('payment', 'paid', 'refunded'), true);
  assert.strictEqual(
    assertTransition('payment', 'partially_refunded', 'partially_refunded'),
    true
  );
  assert.strictEqual(
    assertTransition('payment', 'partially_refunded', 'refunded'),
    true
  );
  ['not_applicable', 'refunded', 'closed'].forEach((from) => {
    assert.throws(
      () => assertTransition('payment', from, 'paid'),
      /transition/
    );
  });
}

function testSplitTransitions() {
  assert.strictEqual(assertTransition('split', 'pending', 'processing'), true);
  assert.strictEqual(assertTransition('split', 'pending', 'failed'), true);
  assert.strictEqual(assertTransition('split', 'processing', 'succeeded'), true);
  assert.strictEqual(assertTransition('split', 'processing', 'failed'), true);
  assert.strictEqual(assertTransition('split', 'failed', 'processing'), true);
  assert.strictEqual(assertTransition('split', 'succeeded', 'reversed'), true);
  ['not_applicable', 'reversed'].forEach((from) => {
    assert.throws(
      () => assertTransition('split', from, 'processing'),
      /transition/
    );
  });
}

function testUnknownKindsAndStatesThrow() {
  assert.throws(
    () => assertTransition('unknown', 'active', 'active'),
    /kind/
  );
  assert.throws(
    () => assertTransition('session', 'unknown', 'unknown'),
    /state/
  );
  assert.throws(
    () => assertTransition('session', 'active', 'unknown'),
    /state/
  );
}

function testEveryKindAllowsKnownStateIdempotency() {
  [
    ['session', 'active'],
    ['order', 'complete'],
    ['payment', 'paid'],
    ['split', 'processing']
  ].forEach(([kind, state]) => {
    assert.strictEqual(assertTransition(kind, state, state), true);
  });
}

function testBusinessIdentifiersAreDeterministicAndWechatSafe() {
  const longUnsafeId = `桌台/订单:${'x'.repeat(100)}`;
  const ids = {
    orderId: orderIdForSession(longUnsafeId),
    outTradeNo: outTradeNoForOrder(longUnsafeId),
    splitNo: splitNoForOrder(longUnsafeId),
    refundNo: refundNoForOrder(longUnsafeId, '重试/key'),
    eventId: financialEventId('payment.succeeded', longUnsafeId)
  };

  assert.strictEqual(ids.orderId, orderIdForSession(longUnsafeId));
  assert.strictEqual(ids.outTradeNo, outTradeNoForOrder(longUnsafeId));
  assert.strictEqual(ids.splitNo, splitNoForOrder(longUnsafeId));
  assert.strictEqual(ids.refundNo, refundNoForOrder(longUnsafeId, '重试/key'));
  assert.strictEqual(
    ids.eventId,
    financialEventId('payment.succeeded', longUnsafeId)
  );

  Object.values(ids).forEach((id) => {
    assert(/^[0-9A-Za-z_@*-]+$/.test(id), `${id} should use WeChat-safe characters`);
  });
  assert(ids.orderId.length <= 32, 'order ID should fit the 32-character limit');
  assert(ids.outTradeNo.length <= 32, 'out_trade_no should fit the 32-character limit');
  assert(ids.splitNo.length <= 64, 'split number should fit the 64-character limit');
  assert(ids.refundNo.length <= 64, 'refund number should fit the 64-character limit');
  assert(ids.eventId.length <= 64, 'event ID should fit the 64-character limit');
}

function testBusinessIdentifierInputsAffectIdentity() {
  const orderId = orderIdForSession('session-1');

  assert.notStrictEqual(orderId, orderIdForSession('session-2'));
  assert.notStrictEqual(
    refundNoForOrder(orderId, 'attempt-1'),
    refundNoForOrder(orderId, 'attempt-2')
  );
  assert.notStrictEqual(
    financialEventId('payment', orderId),
    financialEventId('refund', orderId)
  );
}

function testMultiPartIdentifiersEncodeTupleBoundaries() {
  assert.notStrictEqual(
    financialEventId('a', 'b\0c'),
    financialEventId('a\0b', 'c'),
    'financial event IDs should distinguish tuple boundaries'
  );
  assert.notStrictEqual(
    refundNoForOrder('a', 'b\0c'),
    refundNoForOrder('a\0b', 'c'),
    'refund IDs should distinguish tuple boundaries'
  );
}

testSessionTransitions();
testOrderTransitions();
testPaymentTransitions();
testSplitTransitions();
testUnknownKindsAndStatesThrow();
testEveryKindAllowsKnownStateIdempotency();
testBusinessIdentifiersAreDeterministicAndWechatSafe();
testBusinessIdentifierInputsAffectIdentity();
testMultiPartIdentifiersEncodeTupleBoundaries();

console.log('table finance state ok');
