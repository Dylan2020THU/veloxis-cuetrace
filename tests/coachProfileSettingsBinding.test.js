const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

function loadAccountSecurityPage(fakeData) {
  const pagePath = path.join(root, 'miniprogram/pages/settings/account-security/index.js');
  delete require.cache[require.resolve(pagePath)];
  let page;
  const storageReads = [];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../../../services/data') return fakeData;
    if (request === '../../../utils/mock') return { getRole: () => 'member' };
    return originalLoad.call(this, request, parent, isMain);
  };
  global.Page = (definition) => {
    page = definition;
  };
  global.Behavior = (definition) => definition;
  global.getApp = () => ({ globalData: { userProfile: { nickname: 'forgedLocal' } } });
  global.wx = {
    getStorageSync(key) {
      storageReads.push(key);
      if (key === 'dc_accounts') {
        return [{ account: 'forgedLocal', password: 'plaintext', wechatBound: true, role: 'member' }];
      }
      if (key === 'dc_wechat_bindings') return [{ account: 'forgedLocal', role: 'member' }];
      return '';
    },
    setClipboardData() {},
    showToast() {},
    navigateTo() {}
  };
  try {
    require(pagePath);
  } finally {
    Module._load = originalLoad;
  }
  page.data = Object.assign({}, page.data);
  page.setData = function setData(next) {
    this.data = Object.assign({}, this.data, next);
  };
  page._storageReads = storageReads;
  return page;
}

const settingsJs = read('miniprogram/pages/settings/index.js');
const profileWxml = read('miniprogram/pages/profile/index.wxml');
const coachProfileJs = read('miniprogram/pages/coach/profile/index.js');
const coachProfileWxml = read('miniprogram/pages/coach/profile/index.wxml');
const coachProfileWxss = read('miniprogram/pages/coach/profile/index.wxss');
const coachProfileJson = read('miniprogram/pages/coach/profile/index.json');
const textareaRule = coachProfileWxss.match(/\.field\.column \.field-input,\s*\.field-textarea\s*\{([\s\S]*?)\}/);

assert(
  /coach:\s*\{[^}]*edit:\s*'编辑教练资料'/.test(settingsJs),
  'Coach settings should label the edit entry as 编辑教练资料.'
);

assert(
  /mock\.getRole\(\)\s*===\s*'coach'[\s\S]*?wx\.navigateTo\(\{\s*url:\s*'\/pages\/coach\/profile\/index'/.test(settingsJs),
  'Coach settings edit entry should open the coach profile editor.'
);

assert(
  !profileWxml.includes('我的教练资料'),
  'The old 我的 page coach profile entry should be removed.'
);

assert(
  coachProfileJson.includes('"navigationBarTitleText": "编辑教练资料"'),
  'Coach profile page title should be 编辑教练资料.'
);

assert(
  /bindtap="applyBinding"[\s\S]*申请绑定/.test(coachProfileWxml),
  'Coach profile page should expose a standalone 申请绑定 button near the hall field.'
);

assert(
  !coachProfileWxml.includes('binding-action-row'),
  'The binding button should sit inside the status row instead of occupying a separate row.'
);

assert(
  /\.binding-apply-btn\s*\{[\s\S]*?width:\s*132rpx/.test(coachProfileWxss),
  'The binding button should use a compact fixed width.'
);

assert(
  textareaRule && /(^|\n)\s*height:\s*40rpx\s*;/.test(textareaRule[1]),
  'The coach intro textarea should set explicit height because min-height does not override the native textarea default.'
);

assert(
  !/approvedStoreId:\s*p\.hallId/.test(coachProfileJs),
  'Saved coach profile hallId must not be treated as an approved shop binding.'
);

assert(
  !coachProfileWxml.includes('保存并申请绑定'),
  'The save button should not submit binding applications.'
);

const submitBlock = coachProfileJs.match(/\n  submit\(\) \{[\s\S]*?\n  applyBinding\(\) \{/);
assert(submitBlock, 'submit() should be followed by a standalone applyBinding() method.');
assert(
  !submitBlock[0].includes('applyCoachShopBinding'),
  'submit() must save profile only and not automatically apply for binding.'
);

async function testAccountSecurityUsesCloudStatus() {
  let statusCalls = 0;
  const page = loadAccountSecurityPage({
    getAccountSecurity() {
      statusCalls += 1;
      return Promise.resolve({
        account: 'memberA',
        wechatBound: true,
        passwordSet: true,
        phone: '13800138000',
        roles: ['member']
      });
    },
    getUserProfile() {
      return Promise.resolve({ phone: '13900139000' });
    }
  });

  page.refresh();
  await flushPromises();

  assert.strictEqual(statusCalls, 1);
  assert.strictEqual(page.data.accountText, 'memberA');
  assert.strictEqual(page.data.passwordText, '\u5df2\u8bbe\u7f6e');
  assert.strictEqual(page.data.phoneText, '138****8000');
  assert.strictEqual(page.data.wechatText, '\u5df2\u7ed1\u5b9a');
  assert.deepStrictEqual(page._storageReads, [], 'Account security must not read legacy local authentication stores.');
}

async function testAccountSecurityFailsClosed() {
  const page = loadAccountSecurityPage({
    getAccountSecurity() {
      return Promise.reject(new Error('cloud unavailable'));
    },
    getUserProfile() {
      return Promise.resolve({ phone: '13900139000' });
    }
  });

  page.refresh();
  await flushPromises();

  assert.strictEqual(page.data.accountText, '\u672a\u767b\u5f55');
  assert.strictEqual(page.data.passwordText, '\u672a\u8bbe\u7f6e');
  assert.strictEqual(page.data.phoneText, '\u672a\u7ed1\u5b9a');
  assert.strictEqual(page.data.wechatText, '\u672a\u7ed1\u5b9a');
  assert.deepStrictEqual(page._storageReads, [], 'Cloud failure must not fall back to local authentication records.');
}

(async () => {
  await testAccountSecurityUsesCloudStatus();
  await testAccountSecurityFailsClosed();
})();
