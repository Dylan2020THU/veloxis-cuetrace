const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dataPath = path.join(root, 'miniprogram/services/data.js');
const pagePath = path.join(root, 'miniprogram/pages/shop/checkin-qr/index.js');
const scenePath = path.join(root, 'cloudfunctions/genCheckinCode/scene.js');
const tableCodePath = path.join(root, 'miniprogram/utils/tableCode.js');

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function testRouteValuesDecodeOnce() {
  global.wx = {};
  global.Behavior = (definition) => definition;
  global.getApp = () => ({ globalData: { theme: 'light' } });

  const data = require(dataPath);
  const originalGetStoreById = data.getStoreById;
  const originalGenCode = data.genStoreCheckinCode;
  let generatedWith = null;

  data.getStoreById = () => Promise.resolve({ _id: 'store_1750000000000', name: '测试门店' });
  data.genStoreCheckinCode = (storeId, tableId, tableName) => {
    generatedWith = { storeId, tableId, tableName };
    return Promise.resolve('cloud://table-code.png');
  };

  let definition = null;
  global.Page = (value) => { definition = value; };
  delete require.cache[require.resolve(pagePath)];
  require(pagePath);

  const page = Object.assign({}, definition, { data: Object.assign({}, definition.data) });
  page.setData = function setData(patch) {
    this.data = Object.assign({}, this.data, patch);
  };

  page.onLoad({
    storeId: 'store_1750000000000',
    tableId: 'T1',
    tableName: '%E4%B9%94%E6%B0%8F%E9%87%91%E8%85%BF'
  });
  await flushPromises();
  await flushPromises();

  data.getStoreById = originalGetStoreById;
  data.genStoreCheckinCode = originalGenCode;

  assert.strictEqual(page.data.tableName, '乔氏金腿');
  assert.strictEqual(generatedWith.tableName, '乔氏金腿');
  assert(page.data.payload.includes('tn=%E4%B9%94%E6%B0%8F%E9%87%91%E8%85%BF'));
  assert(!page.data.payload.includes('%25E4'));
}

async function run() {
  await testRouteValuesDecodeOnce();

  assert(fs.existsSync(scenePath), 'A testable scene builder should exist for permanent table codes.');
  const { buildScene } = require(scenePath);
  const direct = buildScene('store_1750000000000', 'T1');
  const compact = buildScene('0123456789abcdef0123456789abcdef', 'T1');

  [direct, compact].forEach((scene) => {
    assert(scene.length <= 32, `Table-code scene exceeds 32 characters: ${scene}`);
    assert(!scene.includes('%'), `Table-code scene contains unsupported URL escapes: ${scene}`);
    assert(!scene.includes('tn='), `Table-code scene should not include the display name: ${scene}`);
  });

  const cloudSource = fs.readFileSync(path.join(root, 'cloudfunctions/genCheckinCode/index.js'), 'utf8');
  assert(
    cloudSource.includes("require('./scene')") && cloudSource.includes('buildScene(storeId, tableId)'),
    'The QR cloud function should generate table scenes through the bounded scene builder.'
  );

  assert(fs.existsSync(tableCodePath), 'The mini program should decode compact store IDs from table codes.');
  const { parseTableCode } = require(tableCodePath);
  assert.deepStrictEqual(parseTableCode({ scene: encodeURIComponent(compact) }), {
    storeId: '0123456789abcdef0123456789abcdef',
    tableId: 'T1',
    tableName: ''
  });

  const qrPageSource = fs.readFileSync(pagePath, 'utf8');
  const qrWxml = fs.readFileSync(path.join(root, 'miniprogram/pages/shop/checkin-qr/index.wxml'), 'utf8');
  assert(
    qrPageSource.includes('qrLoading') && qrPageSource.includes('qrError') && qrWxml.includes('qrError'),
    'The table-code page should expose generation progress and errors instead of silently showing a blank placeholder.'
  );

  console.log('table code QR regression ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
