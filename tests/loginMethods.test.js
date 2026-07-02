const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

const loginJs = read('miniprogram/pages/login/index.js');
const loginWxml = read('miniprogram/pages/login/index.wxml');
const loginWxss = read('miniprogram/pages/login/index.wxss');

const goNextBlock = loginJs.match(/\n  goNext\(\) \{[\s\S]*?\n  \},/);
assert(goNextBlock, 'Login page should define goNext().');

assert(
  !goNextBlock[0].includes('doLogin'),
  'Choosing a role should always continue to account/phone login, not auto-trigger WeChat login.'
);

assert(
  loginJs.includes('wechatLogin()'),
  'Login page should expose a dedicated WeChat login handler.'
);

assert(
  !loginWxml.includes('微信登录 ·'),
  'Primary role button should not switch to WeChat login copy when cloud is ready.'
);

assert(
  loginWxml.includes('登录 · {{roleLabel}}') && !loginWxml.includes('账号/手机号登录 · {{roleLabel}}'),
  'Primary role button should only read 登录 · 当前身份.'
);

assert(
  loginWxml.includes('账号登录') && loginWxml.includes('手机号登录'),
  'Login page should show account login and phone login for every role.'
);

assert(
  loginWxml.includes('其他登录方式') && /class="wechat-icon-btn"[\s\S]*bindtap="wechatLogin"/.test(loginWxml),
  'WeChat login should be presented as an icon button under 其他登录方式.'
);

assert(
  !/<button[^>]*bindtap="wechatLogin"[\s\S]*(微信登录|微)[\s\S]*<\/button>/.test(loginWxml),
  'The WeChat login button should not display a text label.'
);

assert(
  loginWxml.includes('wechat-logo-bubble main') && loginWxml.includes('wechat-logo-bubble sub'),
  'The WeChat login button should render a two-bubble WeChat-style logo.'
);

assert(
  /\.wechat-icon-btn\s*\{[\s\S]*?background:\s*#07c160/.test(loginWxss),
  'The WeChat logo icon should use the official green circular background.'
);

assert(
  /\.wechat-logo-bubble\s*\{[\s\S]*?background:\s*#fff/.test(loginWxss),
  'The WeChat logo bubbles should be white.'
);

assert(
  /\.wechat-logo-bubble\.main::after\s*\{[\s\S]*?background:\s*#fff/.test(loginWxss) &&
    /\.wechat-logo-bubble\.sub::after\s*\{[\s\S]*?background:\s*#fff/.test(loginWxss),
  'The WeChat logo bubble tails should be white.'
);

assert(
  /\.wechat-dot\s*\{[\s\S]*?background:\s*#07c160/.test(loginWxss),
  'The WeChat logo eyes should match the green background.'
);

assert(
  !/\.theme-dark \.wechat-icon-btn/.test(loginWxss),
  'The WeChat icon background should not vary by theme.'
);

assert(
  /\.wechat-icon-btn::after\s*\{[\s\S]*?border:\s*none/.test(loginWxss),
  'The WeChat logo icon should remove the native button pseudo-border.'
);

assert(
  /\.wechat-icon-btn\s*\{[\s\S]*?min-width:\s*92rpx[\s\S]*?max-width:\s*92rpx/.test(loginWxss),
  'The WeChat logo icon should lock min/max width so native button styles cannot stretch it.'
);
