const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

const appJs = read('miniprogram/app.js');
const settingsJs = read('miniprogram/pages/settings/index.js');
const settingsWxml = read('miniprogram/pages/settings/index.wxml');

assert(
  !settingsWxml.includes('背景模式') && !settingsWxml.includes('switchTheme') && !settingsWxml.includes('themeModeLabel'),
  'Settings page should not show a background mode entry.'
);

assert(
  !settingsJs.includes('THEME_LABEL') && !settingsJs.includes('switchTheme()') && !settingsJs.includes('themeModeLabel'),
  'Settings page script should not keep background mode state or switch logic.'
);

assert(
  /themeMode:\s*'light'/.test(appJs),
  'Global themeMode should default to light.'
);

assert(
  !/wx\.getStorageSync\('dc_theme_mode'\)\s*\|\|\s*'system'/.test(appJs),
  'App startup should not restore old system/dark theme mode from cache.'
);

const initThemeBlock = appJs.match(/\n  initTheme\(\) \{[\s\S]*?\n  \},/);
assert(initThemeBlock, 'app.js should define initTheme().');
assert(
  initThemeBlock[0].includes("themeMode = 'light'") && initThemeBlock[0].includes("theme = 'light'"),
  'initTheme() should force light theme.'
);

const setThemeModeBlock = appJs.match(/\n  setThemeMode\(mode\) \{[\s\S]*?\n  \},/);
assert(setThemeModeBlock, 'app.js should define setThemeMode().');
assert(
  setThemeModeBlock[0].includes("themeMode = 'light'") && !setThemeModeBlock[0].includes("indexOf(mode)"),
  'setThemeMode() should ignore requested modes and keep light theme.'
);
