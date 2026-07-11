const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

const profileJs = read('miniprogram/pages/profile/index.js');
const profileWxml = read('miniprogram/pages/profile/index.wxml');
const profileWxss = read('miniprogram/pages/profile/index.wxss');
const profileEditJs = read('miniprogram/pages/player/profile/edit/index.js');
const profileEditWxml = read('miniprogram/pages/player/profile/edit/index.wxml');

assert(
  /class="head-avatar-wrap"[\s\S]*bindtap="chooseAvatar"/.test(profileWxml),
  'Profile avatar should be a tappable area.'
);

assert(
  profileWxml.includes('head-avatar-edit') && profileWxml.includes('head-avatar-edit-ic'),
  'Profile avatar should render an edit badge in the corner.'
);

assert(
  profileJs.includes('chooseAvatar()') &&
    profileJs.includes('wx.chooseMedia') &&
    /data\s*\.\s*uploadImage/.test(profileJs) &&
    /data\s*\.\s*saveUserProfile/.test(profileJs),
  'Profile page should choose, upload, and save a new avatar.'
);

assert(
  profileJs.includes('data.getUserProfile()') && profileJs.includes('role: profile.role || this.data.role'),
  'Profile avatar save should preserve existing user profile fields and role.'
);

assert(
  /\.head-avatar-wrap\s*\{[\s\S]*?position:\s*relative/.test(profileWxss) &&
    /\.head-avatar-edit\s*\{[\s\S]*?position:\s*absolute/.test(profileWxss) &&
    /\.head-avatar-edit-ic\s*\{[\s\S]*?mask-image/.test(profileWxss),
  'Profile avatar edit badge should be positioned and rendered with an icon mask.'
);

const phoneInput = profileEditWxml.match(/<input[^>]*value="\{\{phone\}\}"[^>]*\/>/);
assert(phoneInput, 'Profile edit should keep the verified phone visible.');
assert(/\bdisabled\b/.test(phoneInput[0]), 'Profile phone should be read-only.');
assert(!/\bbindinput\b/.test(phoneInput[0]), 'Profile phone must not accept direct edits.');
assert(profileEditWxml.includes('短信验证'), 'Profile edit should explain that phone changes require SMS verification.');

const savePayload = profileEditJs.match(/const payload\s*=\s*\{([\s\S]*?)\};\s*data\.saveUserProfile/);
assert(savePayload, 'Profile edit should build a save payload.');
assert(!/\bphone\b/.test(savePayload[1]), 'Profile edit must not submit phone in the save payload.');
