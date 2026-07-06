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

const wechatButtonMatch = loginWxml.match(/<button[^>]*class="wechat-icon-btn"[^>]*bindtap="wechatLogin"[^>]*>([\s\S]*?)<\/button>/);
assert(wechatButtonMatch, 'WeChat login icon button should exist.');
const wechatButtonText = wechatButtonMatch[1].replace(/<[^>]+>/g, '').trim();
assert(
  !wechatButtonText,
  'The WeChat login button should not display a text label.'
);

assert(
  /<image[^>]+class="wechat-logo-img"[^>]+src="\/images\/login\/WeChat_logo\.ico"/.test(loginWxml),
  'The WeChat login button should render the configured official WeChat icon image.'
);

assert(
  !loginWxml.includes('wechat-logo-bubble') && !loginWxss.includes('wechat-logo-bubble') && !loginWxss.includes('wechat-dot'),
  'The WeChat login button should not use the old hand-drawn logo.'
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
  /\.wechat-icon-btn\s*\{[\s\S]*?min-width:\s*74rpx[\s\S]*?max-width:\s*74rpx/.test(loginWxss) &&
    /\.wechat-logo-img\s*\{[\s\S]*?width:\s*74rpx[\s\S]*?height:\s*74rpx/.test(loginWxss),
  'The WeChat logo icon should be locked to 80% of the previous 92rpx size.'
);
