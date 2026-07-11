const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const hallWxml = read('miniprogram/pages/shop/hall-status/index.wxml');
const hallWxss = read('miniprogram/pages/shop/hall-status/index.wxss');
const tabWxss = read('miniprogram/custom-tab-bar/index.wxss');

function zIndex(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  const value = block && block[1].match(/z-index:\s*(\d+)/);
  return value ? Number(value[1]) : 0;
}

assert(
  zIndex(hallWxss, '.use-mask') > zIndex(tabWxss, '.tab-bar'),
  'The open-table sheet mask must render above the custom tab bar.'
);

assert(
  /<view class="use-scroll">[\s\S]*<\/view>\s*<view class="use-actions">/.test(hallWxml),
  'Scrollable open-table content must be separated from the always-visible action buttons.'
);

assert(
  /\.use-scroll\s*\{[\s\S]*overflow-y:\s*auto;[\s\S]*\}/.test(hallWxss) &&
    /\.use-actions\s*\{[\s\S]*flex-shrink:\s*0;[\s\S]*\}/.test(hallWxss),
  'The sheet content should scroll while the action row remains visible.'
);

console.log('hall status sheet layout ok');
