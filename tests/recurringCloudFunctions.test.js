const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function exists(file) {
  return fs.existsSync(path.join(root, file));
}

[
  'createRecurringContract',
  'recurringContractCallback',
  'cancelRecurringContract',
  'createRecurringDebit',
  'recurringDebitCallback'
].forEach((name) => {
  assert(exists(`cloudfunctions/${name}/index.js`), `${name} cloud function should exist.`);
  assert(exists(`cloudfunctions/${name}/package.json`), `${name} package.json should exist.`);
});

const dataJs = read('miniprogram/services/data.js');
assert(dataJs.includes('createRecurringContract'), 'data.js should export createRecurringContract.');
assert(dataJs.includes('cancelRecurringContract'), 'data.js should export cancelRecurringContract.');
assert(dataJs.includes('getRecurringSubscription'), 'data.js should export getRecurringSubscription.');

const createContract = read('cloudfunctions/createRecurringContract/index.js');
assert(createContract.includes('PAP_PLAN_ID_MONTH'), 'createRecurringContract should read monthly template env.');
assert(createContract.includes('PAP_SIGN_KEY'), 'createRecurringContract should read signing key from env.');
assert(!createContract.includes('123456') && !createContract.includes('mch_secret'), 'createRecurringContract should not hardcode secrets.');
assert(createContract.includes('wxbd687630cd02ce1d'), 'createRecurringContract should return the official signing mini program appid.');
assert(createContract.includes('/papay/entrustweb'), 'createRecurringContract should document the delegated contract signing target.');
assert(!createContract.includes('sub_mch_id'), 'Direct merchant contract signing should not send sub_mch_id.');

const debit = read('cloudfunctions/createRecurringDebit/index.js');
assert(debit.includes('/pay/pappayapply'), 'createRecurringDebit should call the direct merchant delegated debit endpoint.');
assert(!debit.includes('/pay/partner/pappayapply'), 'Direct merchant debit should not call the partner endpoint.');
assert(!debit.includes('sub_mch_id'), 'Direct merchant debit should not send sub_mch_id.');
assert(debit.includes('contract_id'), 'createRecurringDebit should debit by contract id.');

const cancel = read('cloudfunctions/cancelRecurringContract/index.js');
assert(cancel.includes('/papay/deletecontract'), 'cancelRecurringContract should call contract termination endpoint.');
assert(!cancel.includes('sub_mch_id'), 'Direct merchant cancellation should not send sub_mch_id.');

const contractCallback = read('cloudfunctions/recurringContractCallback/index.js');
assert(contractCallback.includes('contract_id'), 'recurringContractCallback should persist contract id.');

const debitCallback = read('cloudfunctions/recurringDebitCallback/index.js');
assert(debitCallback.includes('applyEntitlement'), 'recurringDebitCallback should apply entitlement after successful debit.');
