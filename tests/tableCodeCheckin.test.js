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

const dataJs = read('miniprogram/services/data.js');
const appJson = read('miniprogram/app.json');
const hallJs = read('miniprogram/pages/shop/hall-status/index.js');
const hallWxml = read('miniprogram/pages/shop/hall-status/index.wxml');
const hallWxss = read('miniprogram/pages/shop/hall-status/index.wxss');
const qrJs = read('miniprogram/pages/shop/checkin-qr/index.js');
const qrWxml = read('miniprogram/pages/shop/checkin-qr/index.wxml');
const requestCheckin = read('cloudfunctions/requestCheckin/index.js');
const genCheckinCode = read('cloudfunctions/genCheckinCode/index.js');

assert(
  dataJs.includes('role: role ||') &&
    dataJs.includes('ready: !!ready') &&
    dataJs.includes('readyAt'),
  'requestCheckin should persist participant role, ready state, and readyAt timing.'
);

assert(
  dataJs.includes('function genStoreCheckinCode(storeId, tableId, tableName)'),
  'genStoreCheckinCode should accept table fields while preserving store-only calls.'
);

assert(
  genCheckinCode.includes("require('./scene')") &&
    genCheckinCode.includes('buildScene(storeId, tableId)') &&
    genCheckinCode.includes("page: page || (tableId ? 'pages/table/checkin/index' : 'pages/match/index')"),
  'genCheckinCode should generate stable table-code scenes and route table codes to the table checkin page.'
);

assert(
  requestCheckin.includes('role') && requestCheckin.includes('ready') && requestCheckin.includes('readyAt'),
  'cloud requestCheckin should store table-session fields.'
);

assert(appJson.includes('pages/table/checkin/index'), 'app.json should register the table checkin page.');
assert(exists('miniprogram/pages/table/checkin/index.js'), 'table checkin JS page should exist.');
assert(exists('miniprogram/pages/table/checkin/index.wxml'), 'table checkin WXML page should exist.');
assert(exists('miniprogram/pages/table/checkin/index.wxss'), 'table checkin WXSS page should exist.');
assert(exists('miniprogram/pages/table/checkin/index.json'), 'table checkin JSON page should exist.');

const tableJs = exists('miniprogram/pages/table/checkin/index.js')
  ? read('miniprogram/pages/table/checkin/index.js')
  : '';
const tableWxml = exists('miniprogram/pages/table/checkin/index.wxml')
  ? read('miniprogram/pages/table/checkin/index.wxml')
  : '';

assert(
  tableJs.includes('joinTable()') &&
    tableJs.includes('startPlay()') &&
    tableJs.includes('refreshParticipants()') &&
    tableJs.includes('ready: true') &&
    tableJs.includes('data.getPendingCheckins'),
  'table checkin page should support joining, starting, and participant refresh.'
);

assert(
  tableWxml.includes('bindtap="joinTable"') &&
    tableWxml.includes('bindtap="startPlay"') &&
    tableWxml.includes('participants'),
  'table checkin page should render join/start actions and participant avatars.'
);

assert(
  hallJs.includes('mergeCheckinTables') &&
    hallJs.includes('verifyTableCheckin') &&
    hallJs.includes('goTableQr') &&
    hallJs.includes('pendingVerify'),
  'hall-status should merge ready table checkins, expose table QR, and verify pending sessions.'
);

assert(
  hallWxml.includes('核验有效') &&
    hallWxml.includes('bindtap="verifyTableCheckin"') &&
    hallWxml.includes('bindtap="goTableQr"') &&
    hallWxml.includes('桌码'),
  'hall-status UI should show table QR and verify-valid actions.'
);

assert(
  hallWxss.includes('.action-btn.secondary') || hallWxss.includes('.btn-qr'),
  'hall-status styles should include a secondary QR action.'
);

assert(
  qrJs.includes('tableId') &&
    qrJs.includes('tableName') &&
    qrJs.includes('genStoreCheckinCode(store._id, tableId, tableName)') &&
    qrWxml.includes('tableName'),
  'checkin QR page should generate and display table-specific QR payloads.'
);
