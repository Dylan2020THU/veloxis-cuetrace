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

const activeEndpoints = [
  'upgradePlan',
  'createPayOrder',
  'createVirtualPayOrder',
  'createRecurringContract',
  'createRecurringDebit'
];

(async () => {
  for (const name of activeEndpoints) {
    const file = `cloudfunctions/${name}/index.js`;
    assert(exists(file), `${name} compatibility cloud function should remain.`);
    const resolved = require.resolve(path.join(root, file));
    delete require.cache[resolved];
    const result = await require(resolved).main({});
    assert.strictEqual(result && result.ok, false, `${name} should fail closed.`);
    assert.strictEqual(result && result.code, 'PRODUCT_RETIRED', `${name} should report PRODUCT_RETIRED.`);
  }

  [
    'recurringContractCallback',
    'cancelRecurringContract',
    'recurringDebitCallback'
  ].forEach((name) => {
    assert(exists(`cloudfunctions/${name}/index.js`), `${name} history/cancellation function should remain.`);
    assert(exists(`cloudfunctions/${name}/package.json`), `${name} package.json should remain.`);
  });

  const config = JSON.parse(read('cloudfunctions/createRecurringDebit/config.json'));
  assert.deepStrictEqual(config.triggers || [], [], 'Retired recurring debit must have no active trigger.');

  const dataJs = read('miniprogram/services/data.js');
  assert(dataJs.includes('createRecurringContract'), 'Compatibility createRecurringContract export should remain.');
  assert(dataJs.includes('cancelRecurringContract'), 'Cancellation helper should remain.');
  assert(dataJs.includes('getRecurringSubscription'), 'Historical subscription read helper should remain.');

  console.log('recurringCloudFunctions retirement tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
