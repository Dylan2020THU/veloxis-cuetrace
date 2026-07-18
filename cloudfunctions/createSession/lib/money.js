const STANDARD_POLICY = Object.freeze({
  policyVersion: 'table_commission_v1',
  billingMode: 'table_commission',
  commissionRateBps: 500,
  includesChannelFee: true,
  splitCycle: 'T_PLUS_1'
});

function assertFen(name, value, nullable = false) {
  if (nullable && value === null) return;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer number of fen`);
  }
}

function roundCommission(paidTableFeeFen, commissionRateBps) {
  if (!Number.isSafeInteger(commissionRateBps) || commissionRateBps < 0) {
    throw new TypeError('commissionRateBps must be a non-negative integer');
  }

  const rounded = Number(
    (BigInt(paidTableFeeFen) * BigInt(commissionRateBps) + 5000n) / 10000n
  );
  if (!Number.isSafeInteger(rounded)) {
    throw new RangeError('totalCostFen exceeds the safe integer range');
  }
  return rounded;
}

function calculateSettlement(
  paidTableFeeFen,
  channelFeeFen,
  policy = STANDARD_POLICY
) {
  assertFen('paidTableFeeFen', paidTableFeeFen);
  assertFen('channelFeeFen', channelFeeFen, true);

  const totalCostFen = roundCommission(
    paidTableFeeFen,
    policy.commissionRateBps
  );
  const shopNetFen = paidTableFeeFen - totalCostFen;
  const platformNetFen = channelFeeFen === null
    ? null
    : totalCostFen - channelFeeFen;

  return {
    policyVersion: policy.policyVersion,
    paidTableFeeFen,
    actualChannelFeeFen: channelFeeFen,
    totalCostFen,
    shopNetFen,
    platformNetFen,
    manualReview: platformNetFen !== null && platformNetFen < 0
  };
}

function recalculateAfterRefund(
  originalPaidFen,
  cumulativeRefundFen,
  netChannelFeeFen,
  policy = STANDARD_POLICY
) {
  assertFen('originalPaidFen', originalPaidFen);
  assertFen('cumulativeRefundFen', cumulativeRefundFen);
  assertFen('netChannelFeeFen', netChannelFeeFen, true);
  if (cumulativeRefundFen > originalPaidFen) {
    throw new RangeError('cumulativeRefundFen cannot exceed originalPaidFen');
  }

  const retainedPaidFen = originalPaidFen - cumulativeRefundFen;
  return {
    originalPaidFen,
    cumulativeRefundFen,
    retainedPaidFen,
    ...calculateSettlement(retainedPaidFen, netChannelFeeFen, policy)
  };
}

function yuanTextToFen(value) {
  if (typeof value !== 'string' || !/^[0-9]+(?:\.[0-9]{1,2})?$/.test(value)) {
    throw new TypeError('value must be non-negative decimal yuan text');
  }

  const [yuan, fraction = ''] = value.split('.');
  const fen = BigInt(yuan) * 100n + BigInt(fraction.padEnd(2, '0') || '0');
  if (fen > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('yuan text exceeds the safe integer fen range');
  }
  return Number(fen);
}

module.exports = {
  STANDARD_POLICY,
  calculateSettlement,
  recalculateAfterRefund,
  yuanTextToFen
};
