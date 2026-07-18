const crypto = require('crypto');

const STATES = Object.freeze({
  session: Object.freeze(['active', 'awaiting_payment', 'closed']),
  order: Object.freeze([
    'awaiting_payment',
    'complete',
    'external_paid',
    'canceled',
    'manual_review'
  ]),
  payment: Object.freeze([
    'not_applicable',
    'unpaid',
    'paid',
    'partially_refunded',
    'refunded',
    'closed'
  ]),
  split: Object.freeze([
    'not_applicable',
    'pending',
    'processing',
    'succeeded',
    'failed',
    'reversed'
  ])
});

const TRANSITIONS = Object.freeze({
  session: Object.freeze({
    active: Object.freeze(['awaiting_payment']),
    awaiting_payment: Object.freeze(['closed'])
  }),
  order: Object.freeze({
    awaiting_payment: Object.freeze([
      'complete',
      'external_paid',
      'canceled',
      'manual_review'
    ]),
    complete: Object.freeze(['manual_review']),
    manual_review: Object.freeze(['complete', 'canceled'])
  }),
  payment: Object.freeze({
    unpaid: Object.freeze(['paid', 'closed']),
    paid: Object.freeze(['partially_refunded', 'refunded']),
    partially_refunded: Object.freeze(['partially_refunded', 'refunded'])
  }),
  split: Object.freeze({
    pending: Object.freeze(['processing', 'failed']),
    processing: Object.freeze(['succeeded', 'failed']),
    failed: Object.freeze(['processing']),
    succeeded: Object.freeze(['reversed'])
  })
});

function assertTransition(kind, from, to) {
  const states = STATES[kind];
  if (!states) {
    throw new Error(`unknown transition kind: ${kind}`);
  }
  if (!states.includes(from)) {
    throw new Error(`unknown ${kind} state: ${from}`);
  }
  if (!states.includes(to)) {
    throw new Error(`unknown ${kind} state: ${to}`);
  }
  if (from === to) return true;

  const allowed = TRANSITIONS[kind][from] || [];
  if (!allowed.includes(to)) {
    throw new Error(`invalid ${kind} transition: ${from} -> ${to}`);
  }
  return true;
}

function assertIdentifierPart(name, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function digest(namespace, parts, length) {
  const hash = crypto.createHash('sha256');
  [namespace, ...parts].forEach((part) => {
    const bytes = Buffer.from(part, 'utf8');
    hash.update(`${bytes.length}:`).update(bytes);
  });
  return hash.digest('hex').slice(0, length);
}

function orderIdForSession(sessionId) {
  assertIdentifierPart('sessionId', sessionId);
  return `ord_${digest('order', [sessionId], 28)}`;
}

function outTradeNoForOrder(orderId) {
  assertIdentifierPart('orderId', orderId);
  return `pay_${digest('payment', [orderId], 28)}`;
}

function outTradeNoForOrderAttempt(orderId, attemptNo) {
  assertIdentifierPart('orderId', orderId);
  if (!Number.isSafeInteger(attemptNo) || attemptNo < 0) {
    throw new TypeError('attemptNo must be a non-negative safe integer');
  }
  if (attemptNo === 0) return outTradeNoForOrder(orderId);
  return `pay_${digest('payment-attempt', [orderId, String(attemptNo)], 28)}`;
}

function splitNoForOrder(orderId) {
  assertIdentifierPart('orderId', orderId);
  return `split_${digest('split', [orderId], 58)}`;
}

function refundNoForOrder(orderId, idempotencyKey) {
  assertIdentifierPart('orderId', orderId);
  assertIdentifierPart('idempotencyKey', idempotencyKey);
  return `refund_${digest('refund', [orderId, idempotencyKey], 57)}`;
}

function financialEventId(type, businessId) {
  assertIdentifierPart('type', type);
  assertIdentifierPart('businessId', businessId);
  return `event_${digest('financial-event', [type, businessId], 58)}`;
}

module.exports = {
  assertTransition,
  orderIdForSession,
  outTradeNoForOrderAttempt,
  outTradeNoForOrder,
  splitNoForOrder,
  refundNoForOrder,
  financialEventId
};
