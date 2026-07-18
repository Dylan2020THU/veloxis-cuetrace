const assert = require('assert');
const fs = require('fs');
const path = require('path');

const modulePath = path.resolve(
  __dirname,
  '../cloudfunctions/_shared/table-finance/money.js'
);

assert(fs.existsSync(modulePath), 'table finance money module should exist');

const {
  STANDARD_POLICY,
  calculateSettlement,
  recalculateAfterRefund,
  yuanTextToFen
} = require(modulePath);

function testStandardPolicy() {
  assert.deepStrictEqual(STANDARD_POLICY, {
    policyVersion: 'table_commission_v1',
    billingMode: 'table_commission',
    commissionRateBps: 500,
    includesChannelFee: true,
    splitCycle: 'T_PLUS_1'
  });
  assert(Object.isFrozen(STANDARD_POLICY), 'standard policy should be immutable');
}

function testIntegerFenValidation() {
  assert.throws(
    () => calculateSettlement(100.5, 1),
    /integer number of fen/
  );
  assert.throws(
    () => calculateSettlement(100, 1.5),
    /integer number of fen/
  );
  assert.throws(
    () => recalculateAfterRefund(100, 0.5, 0),
    /integer number of fen/
  );
}

function testFiveHundredBpsRounding() {
  assert.strictEqual(calculateSettlement(101, 0).totalCostFen, 5);
  assert.strictEqual(calculateSettlement(110, 0).totalCostFen, 6);
}

function testShopReceivesNinetyFivePercent() {
  const settlement = calculateSettlement(10000, 100);

  assert.strictEqual(settlement.totalCostFen, 500);
  assert.strictEqual(settlement.shopNetFen, 9500);
}

function testUnknownChannelFee() {
  const settlement = calculateSettlement(10000, null);

  assert.strictEqual(settlement.actualChannelFeeFen, null);
  assert.strictEqual(settlement.platformNetFen, null);
  assert.strictEqual(settlement.manualReview, false);
}

function testChannelFeeOverTotalCost() {
  const settlement = calculateSettlement(10000, 550);

  assert.strictEqual(settlement.shopNetFen, 9500);
  assert.strictEqual(settlement.platformNetFen, -50);
  assert.strictEqual(settlement.manualReview, true);
}

function testZeroAndFullRefund() {
  const zeroSettlement = calculateSettlement(0, 0);
  const refunded = recalculateAfterRefund(1000, 1000, 0);

  assert.strictEqual(zeroSettlement.totalCostFen, 0);
  assert.strictEqual(zeroSettlement.shopNetFen, 0);
  assert.strictEqual(refunded.retainedPaidFen, 0);
  assert.strictEqual(refunded.totalCostFen, 0);
  assert.strictEqual(refunded.shopNetFen, 0);
}

function testMultiplePartialRefundsRecomputeFromRetainedAmount() {
  const firstRefund = recalculateAfterRefund(110, 10, 0);
  const secondRefund = recalculateAfterRefund(110, 20, 0);
  const independentlyRoundedDeltaWouldDiffer = recalculateAfterRefund(101, 10, 0);

  assert.strictEqual(firstRefund.retainedPaidFen, 100);
  assert.strictEqual(firstRefund.totalCostFen, 5);
  assert.strictEqual(secondRefund.retainedPaidFen, 90);
  assert.strictEqual(secondRefund.totalCostFen, 5);
  assert.strictEqual(independentlyRoundedDeltaWouldDiffer.retainedPaidFen, 91);
  assert.strictEqual(independentlyRoundedDeltaWouldDiffer.totalCostFen, 5);
}

function testDecimalYuanTextConversion() {
  assert.strictEqual(yuanTextToFen('0'), 0);
  assert.strictEqual(yuanTextToFen('0.01'), 1);
  assert.strictEqual(yuanTextToFen('12.3'), 1230);
  assert.strictEqual(yuanTextToFen('001.20'), 120);
  assert.throws(() => yuanTextToFen('1.234'), /yuan text/);
  assert.throws(() => yuanTextToFen(1.23), /yuan text/);
}

testStandardPolicy();
testIntegerFenValidation();
testFiveHundredBpsRounding();
testShopReceivesNinetyFivePercent();
testUnknownChannelFee();
testChannelFeeOverTotalCost();
testZeroAndFullRefund();
testMultiplePartialRefundsRecomputeFromRetainedAmount();
testDecimalYuanTextConversion();

console.log('table commission math ok');
