const assert = require('assert');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

function loadShopApplyPage(fakeData) {
  const pagePath = path.join(root, 'miniprogram/pages/shop/apply/index.js');
  delete require.cache[require.resolve(pagePath)];

  let page;
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (fakeData && request === '../../../services/data') return fakeData;
    return originalLoad.call(this, request, parent, isMain);
  };
  global.Page = (def) => {
    page = def;
  };
  global.Behavior = (def) => def;
  global.getApp = () => ({ globalData: { cloudReady: false } });
  global.wx = {
    showToast() {},
    showLoading() {},
    hideLoading() {},
    reLaunch() {},
    navigateTo() {}
  };

  try {
    require(pagePath);
  } finally {
    Module._load = originalLoad;
  }
  page.data = JSON.parse(JSON.stringify(page.data));
  page.setData = function setData(next) {
    this.data = Object.assign({}, this.data, next);
  };
  return page;
}

async function testRolePickerApplyDoesNotTreatLegacyShopAsApproved() {
  const calls = { reLaunch: [] };
  const fakeData = {
    getAdminStatus() {
      return Promise.resolve({ isAdmin: false });
    },
    getShopApplicationStatus() {
      return Promise.resolve({ status: 'approved', legacy: true, application: null });
    }
  };
  const page = loadShopApplyPage(fakeData);
  global.wx.reLaunch = (args) => calls.reLaunch.push(args);

  page.onLoad({ source: 'rolePicker' });
  await flushPromises();
  await flushPromises();

  assert.strictEqual(calls.reLaunch.length, 0, 'Role-picker shop application should not enter shop home from legacy mock shop data.');
  assert.strictEqual(page.data.status, 'none', 'Role-picker shop application should render the qualification form.');
  assert.strictEqual(page.data.loading, false);
}

async function testRolePickerApplyDoesNotAutoEnterShopWhenStatusApproved() {
  const calls = { reLaunch: [] };
  const fakeData = {
    getAdminStatus() {
      return Promise.resolve({ isAdmin: false });
    },
    getShopApplicationStatus() {
      return Promise.resolve({ status: 'approved', application: { _id: 'app1' } });
    }
  };
  const page = loadShopApplyPage(fakeData);
  global.wx.reLaunch = (args) => calls.reLaunch.push(args);

  page.onLoad({ source: 'rolePicker' });
  await flushPromises();
  await flushPromises();

  assert.strictEqual(calls.reLaunch.length, 0, 'Role-picker shop application should not auto-enter shop home even if openid has approved shop status.');
  assert.strictEqual(page.data.status, 'none', 'Role-picker shop application should still render the qualification form for the selected account.');
  assert.strictEqual(page.data.loading, false);
}

async function testRolePickerApplyNeverShowsAdminReviewEntry() {
  const fakeData = {
    getAdminStatus() {
      return Promise.resolve({ isAdmin: true });
    },
    getShopApplicationStatus() {
      return Promise.resolve({ status: 'pending', application: { _id: 'app1' } });
    }
  };
  const page = loadShopApplyPage(fakeData);

  page.onLoad({ source: 'rolePicker' });
  await flushPromises();
  await flushPromises();

  assert.strictEqual(page.data.isAdmin, false, 'Role-picker shop application must not expose admin review entry.');
  assert.strictEqual(page.data.status, 'pending');
}

(async () => {
  await testRolePickerApplyDoesNotTreatLegacyShopAsApproved();
  await testRolePickerApplyDoesNotAutoEnterShopWhenStatusApproved();
  await testRolePickerApplyNeverShowsAdminReviewEntry();
})();
