const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');
const ADMIN_LABEL = '\u7ba1\u7406\u5458';
const SHOP_REVIEW_LABEL = '\u5e97\u4e3b\u8d44\u8d28\u5ba1\u6838';

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

const profileWxml = read('miniprogram/pages/profile/index.wxml');
const shopProfileWxml = read('miniprogram/pages/shop/profile/index.wxml');
const settingsJs = read('miniprogram/pages/settings/index.js');
const settingsWxml = read('miniprogram/pages/settings/index.wxml');
const SHOP_OWNER_LABEL = '\u5e97\u4e3b';
const SHOP_MERCHANT_LABEL = '\u5e97\u5bb6';
const SWITCH_ROLE_LABEL = '\u5207\u6362\u8eab\u4efd';

assert(
  !profileWxml.includes(SHOP_REVIEW_LABEL) && !profileWxml.includes('bindtap="goShopReview"'),
  'The shared profile page should not show shop qualification review entry; it belongs in settings only.'
);

assert(
  shopProfileWxml.includes(SHOP_OWNER_LABEL) && !shopProfileWxml.includes(SHOP_MERCHANT_LABEL),
  'The shop profile header should label the current identity as 店主, not 店家.'
);

assert(
  settingsWxml.includes(SWITCH_ROLE_LABEL) && settingsWxml.includes('bindtap="switchIdentity"'),
  'Settings should expose a 切换身份 entry for every role.'
);

assert(
  settingsJs.includes('switchIdentity()') && settingsJs.includes('/pages/login/index?switchRole=1'),
  'The settings 切换身份 entry should return to the post-login role picker.'
);

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

function loadProfilePage(role, isAdmin) {
  const profilePath = path.join(root, 'miniprogram/pages/profile/index.js');
  const dataPath = path.join(root, 'miniprogram/services/data.js');
  const mockPath = path.join(root, 'miniprogram/utils/mock.js');
  const rankPath = path.join(root, 'miniprogram/utils/rank.js');
  const billingPath = path.join(root, 'miniprogram/utils/billing.js');
  const accountPath = path.join(root, 'miniprogram/utils/account.js');
  [
    profilePath,
    dataPath,
    mockPath,
    rankPath,
    billingPath,
    accountPath
  ].forEach((file) => {
    delete require.cache[require.resolve(file)];
  });

  const fakeData = {
    getUserProfile() {
      return Promise.resolve({ role, nickname: 'admin_zhx', avatar: '' });
    },
    getAdminStatus() {
      return Promise.resolve({ ok: true, isAdmin });
    },
    getMemberCheckins() {
      return Promise.resolve([]);
    },
    getMyMatches() {
      return Promise.resolve([]);
    },
    getMyJoins() {
      return Promise.resolve([]);
    },
    getMyBookings() {
      return Promise.resolve([]);
    },
    getShopBrands() {
      return Promise.resolve([]);
    },
    getShopStores() {
      return Promise.resolve([]);
    },
    getShopCoaches() {
      return Promise.resolve([]);
    },
    getShopMembers() {
      return Promise.resolve([]);
    },
    getUserBilling() {
      return Promise.resolve(null);
    },
    getTodayShopRevenue() {
      return Promise.resolve(0);
    }
  };
  const fakeMock = {
    MOCK_OPENID: 'openid',
    getRole() {
      return role;
    }
  };
  const fakeRank = {
    summarize() {
      return { totalDays: 0, totalHoursText: '0.0', streak: 0 };
    }
  };
  const fakeBilling = {
    isInTrial() {
      return false;
    },
    isPlanActive() {
      return false;
    },
    getPlanExpiry() {
      return 0;
    },
    requirePlan() {
      return Promise.resolve(true);
    }
  };
  const fakeAccount = {
    codeOf() {
      return 'CT-TEST';
    }
  };

  let page;
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../../services/data') return fakeData;
    if (request === '../../utils/mock') return fakeMock;
    if (request === '../../utils/rank') return fakeRank;
    if (request === '../../utils/billing.js') return fakeBilling;
    if (request === '../../utils/account') return fakeAccount;
    return originalLoad.call(this, request, parent, isMain);
  };
  global.Page = (def) => {
    page = def;
  };
  global.Behavior = (def) => def;
  global.getApp = () => ({
    globalData: {
      openid: 'openid',
      role,
      currentRole: role,
      userProfile: { role, nickname: 'admin_zhx', avatar: '' }
    }
  });
  global.wx = {
    switchTab() {},
    navigateTo() {},
    showToast() {}
  };

  try {
    require(profilePath);
  } finally {
    Module._load = originalLoad;
  }
  page.data = JSON.parse(JSON.stringify(page.data));
  page.setData = function setData(next) {
    Object.keys(next || {}).forEach((key) => {
      if (key.indexOf('.') === -1) {
        this.data[key] = next[key];
        return;
      }
      const parts = key.split('.');
      let target = this.data;
      for (let i = 0; i < parts.length - 1; i += 1) {
        if (!target[parts[i]]) target[parts[i]] = {};
        target = target[parts[i]];
      }
      target[parts[parts.length - 1]] = next[key];
    });
  };
  return page;
}

assert(
  !profileWxml.includes('强化杆迹 · {{roleLabel}}') && !profileWxml.includes('强化杆迹 ·'),
  'The shared 我的 page header should not show 强化杆迹 under the nickname.'
);

async function testAdminProfileHeaderShowsAdminForEveryRole() {
  for (const role of ['member', 'coach', 'shop']) {
    const page = loadProfilePage(role, true);
    page.onShow();
    await flushPromises();
    await flushPromises();

    assert.strictEqual(page.data.isAdmin, true);
    assert.strictEqual(page.data.roleLabel, ADMIN_LABEL);
  }
}

async function testNormalProfileHeaderDoesNotShowAdmin() {
  for (const role of ['member', 'coach', 'shop']) {
    const page = loadProfilePage(role, false);
    page.onShow();
    await flushPromises();
    await flushPromises();

    assert.strictEqual(page.data.isAdmin, false);
    assert.notStrictEqual(page.data.roleLabel, ADMIN_LABEL);
  }
}

(async () => {
  await testAdminProfileHeaderShowsAdminForEveryRole();
  await testNormalProfileHeaderDoesNotShowAdmin();
})();

assert(
  /<view class="head-role">\{\{roleLabel\}\}<\/view>/.test(profileWxml),
  'The shared 我的 page header should still show the current identity label.'
);
