# Become Coach Application Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a player-side "Become Coach" flow where a member applies to bind a hall, the shop owner approves it, and only approval opens the coach identity.

**Architecture:** Reuse the existing `coach_shop_applications` and `shop_coach_links` flow. Add a lightweight player application page, show its entry only for member-only accounts, and make the shop approval cloud function append `coach` to `users.roles` without removing `member`.

**Tech Stack:** WeChat Mini Program pages/WXML/WXSS, `miniprogram/services/data.js`, Tencent Cloud Functions, Node static/unit tests.

## Global Constraints

- Application form fields: avatar, coach nickname, selected hall, short intro.
- Applying does not open coach identity.
- Only shop approval opens coach identity by adding `coach` to `users.roles`.
- Keep coach identity backward-compatible with member identity: final roles must include both `member` and `coach`.
- No platform admin coach review, certificate verification, multi-hall applications, coach identity payment, or realtime notifications in this version.
- Do not delete files.

---

### Task 1: Regression Tests For Become Coach Flow

**Files:**
- Create: `tests/becomeCoachApplication.test.js`

**Interfaces:**
- Consumes: existing settings page, app.json, coach apply page path, shop coach list page, data service, and cloud functions.
- Produces: a regression suite that fails until the feature is implemented.

- [ ] **Step 1: Create the failing test file**

Create `tests/becomeCoachApplication.test.js` with assertions:

```js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function valueMatches(actual, expected) {
  if (expected && expected.__op === 'in') return expected.values.indexOf(actual) !== -1;
  return actual === expected;
}

function matches(record, query) {
  return Object.keys(query || {}).every((key) => valueMatches(record[key], query[key]));
}

function createFakeDb(seed) {
  const updates = [];
  const adds = [];

  class Query {
    constructor(name) {
      this.name = name;
      this.query = {};
    }
    where(query) {
      this.query = query || {};
      return this;
    }
    async get() {
      return { data: (seed[this.name] || []).filter((item) => matches(item, this.query)) };
    }
  }

  const db = {
    command: {
      in(values) {
        return { __op: 'in', values: values || [] };
      }
    },
    collection(name) {
      return {
        where(query) {
          return new Query(name).where(query);
        },
        doc(id) {
          return {
            async get() {
              const hit = (seed[name] || []).find((item) => item._id === id);
              if (!hit) throw new Error('not found');
              return { data: hit };
            },
            async update({ data }) {
              updates.push({ collection: name, id, data });
              return { updated: 1 };
            }
          };
        },
        async add({ data }) {
          adds.push({ collection: name, data });
          return { _id: `${name}_new` };
        }
      };
    },
    serverDate() {
      return 'SERVER_DATE';
    },
    __updates: updates,
    __adds: adds
  };
  return db;
}

function withWxServerSdk(fakeCloud, fn) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'wx-server-sdk') return fakeCloud;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return fn();
  } finally {
    Module._load = originalLoad;
  }
}

function loadCloudFunction(relPath, openid, seed) {
  const fnPath = path.join(root, relPath);
  delete require.cache[require.resolve(fnPath)];
  const fakeDb = createFakeDb(seed);
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: 'DYNAMIC_CURRENT_ENV',
    init() {},
    database() {
      return fakeDb;
    },
    getWXContext() {
      return { OPENID: openid };
    }
  };
  const fn = withWxServerSdk(fakeCloud, () => require(fnPath));
  return { fn, fakeDb };
}

function testStaticWiring() {
  const appJson = read('miniprogram/app.json');
  const settingsJs = read('miniprogram/pages/settings/index.js');
  const settingsWxml = read('miniprogram/pages/settings/index.wxml');
  const dataJs = read('miniprogram/services/data.js');
  const shopCoachesWxml = read('miniprogram/pages/shop/coaches/index.wxml');
  const applyBindingCloud = read('cloudfunctions/applyCoachShopBinding/index.js');
  const saveCoachProfileCloud = read('cloudfunctions/saveCoachProfile/index.js');

  assert(appJson.includes('pages/coach/apply/index'), 'app.json should register the become coach application page.');
  assert(settingsJs.includes('canApplyCoach') && settingsJs.includes('goBecomeCoach'), 'Settings page should gate and navigate to become coach.');
  assert(settingsWxml.includes('wx:if="{{canApplyCoach}}"') && settingsWxml.includes('成为教练'), 'Settings page should show 成为教练 only when allowed.');
  assert(dataJs.includes('intro') && dataJs.includes('applyCoachShopBinding({ storeId, coachNickname, coachAvatar, intro })'), 'Data service should submit short intro with binding application.');
  assert(shopCoachesWxml.includes('item.intro') && shopCoachesWxml.includes('申请说明'), 'Shop coach review card should show application intro.');
  assert(applyBindingCloud.includes('intro'), 'applyCoachShopBinding cloud function should persist intro.');
  assert(!saveCoachProfileCloud.includes("role: 'coach'"), 'saveCoachProfile must not directly open coach identity.');
}

function testApplyPageExists() {
  const applyJs = read('miniprogram/pages/coach/apply/index.js');
  const applyWxml = read('miniprogram/pages/coach/apply/index.wxml');
  const applyWxss = read('miniprogram/pages/coach/apply/index.wxss');
  const applyJson = read('miniprogram/pages/coach/apply/index.json');

  assert(applyJson.includes('成为教练'), 'Apply page title should be 成为教练.');
  assert(applyJs.includes('loadStatus') && applyJs.includes('submitApplication'), 'Apply page should load status and submit application.');
  assert(applyJs.includes('data.getMyCoachShopBindingStatus()'), 'Apply page should read current binding status.');
  assert(applyJs.includes('data.applyCoachShopBinding({'), 'Apply page should submit through applyCoachShopBinding.');
  assert(!applyJs.includes("data.login('coach'"), 'Apply page must not login as coach directly.');
  assert(applyWxml.includes('教练昵称') && applyWxml.includes('申请球厅') && applyWxml.includes('申请说明'), 'Apply page should render required fields.');
  assert(/\.submit-btn/.test(applyWxss), 'Apply page should style the submit button.');
}

async function testApprovalAddsCoachRoleWithoutDroppingMember() {
  const { fn, fakeDb } = loadCloudFunction('cloudfunctions/reviewCoachBindingApplication/index.js', 'shop_openid', {
    coach_shop_applications: [
      {
        _id: 'app1',
        shopOpenid: 'shop_openid',
        coachOpenid: 'member_openid',
        storeId: 'store1',
        storeName: 'A厅',
        coachNickname: 'Coach A'
      }
    ],
    shop_coach_links: [],
    coaches: [],
    users: [
      { _id: 'user1', _openid: 'member_openid', roles: ['member'], role: 'member', currentRole: 'member' }
    ]
  });

  const res = await fn.main({ applicationId: 'app1', approve: true });
  assert.strictEqual(res.ok, true);

  const userUpdate = fakeDb.__updates.find((item) => item.collection === 'users' && item.id === 'user1');
  assert(userUpdate, 'Approval should update the applicant user document.');
  assert.deepStrictEqual(userUpdate.data.roles, ['member', 'coach']);
  assert.strictEqual(userUpdate.data.role, 'member');
  assert.strictEqual(userUpdate.data.currentRole, 'member');
}

(async () => {
  testStaticWiring();
  testApplyPageExists();
  await testApprovalAddsCoachRoleWithoutDroppingMember();
})();
```

- [ ] **Step 2: Run the new test to verify failure**

Run: `node tests/becomeCoachApplication.test.js`

Expected: FAIL because the new apply page and role-opening behavior do not exist yet.

### Task 2: Settings Entry And Apply Page

**Files:**
- Modify: `miniprogram/app.json`
- Modify: `miniprogram/pages/settings/index.js`
- Modify: `miniprogram/pages/settings/index.wxml`
- Create: `miniprogram/pages/coach/apply/index.js`
- Create: `miniprogram/pages/coach/apply/index.wxml`
- Create: `miniprogram/pages/coach/apply/index.wxss`
- Create: `miniprogram/pages/coach/apply/index.json`
- Test: `tests/becomeCoachApplication.test.js`

**Interfaces:**
- Consumes: `data.getUserProfile()`, `data.getStores()`, `data.getMyCoachShopBindingStatus()`, `data.applyCoachShopBinding(...)`, `data.uploadImage(...)`.
- Produces: settings method `goBecomeCoach()` and apply page method `submitApplication()`.

- [ ] **Step 1: Add page registration and gated settings entry**

Register `pages/coach/apply/index` in `miniprogram/app.json`.

In `miniprogram/pages/settings/index.js`, add `canApplyCoach` to `data`, compute it from `mock.getRole()` and `profile.roles`, and add:

```js
goBecomeCoach() {
  wx.navigateTo({ url: '/pages/coach/apply/index' });
}
```

In `miniprogram/pages/settings/index.wxml`, add an entry near account settings:

```xml
<view wx:if="{{canApplyCoach}}" class="card">
  <view class="entry" bindtap="goBecomeCoach">
    <text class="entry-title">成为教练</text>
    <text class="arrow">›</text>
  </view>
</view>
```

- [ ] **Step 2: Create the apply page**

Create `miniprogram/pages/coach/apply/index.js` with:

```js
const data = require('../../../services/data');

Page({
  behaviors: [require('../../../utils/themeBehavior')],
  data: {
    avatar: '',
    nickname: '',
    intro: '',
    stores: [],
    selectedStoreId: '',
    selectedStoreName: '',
    selectedStoreIndex: 0,
    status: 'none',
    reason: '',
    submitting: false,
    loading: true
  },
  onLoad() {
    this.loadInitial();
  },
  loadInitial() {
    Promise.all([
      data.getUserProfile().catch(() => null),
      data.getStores().catch(() => []),
      data.getMyCoachShopBindingStatus().catch(() => ({ status: 'none' }))
    ]).then(([profile, stores, binding]) => {
      const application = binding && binding.application;
      const link = binding && binding.link;
      const selectedStoreId = link ? link.storeId : (application ? application.storeId : '');
      const selectedStoreName = link ? link.storeName : (application ? application.storeName : '');
      const list = (stores || []).filter((store) => store && store._openid);
      const selectedStoreIndex = Math.max(0, list.findIndex((store) => store._id === selectedStoreId));
      this.setData({
        avatar: (application && application.coachAvatar) || (profile && profile.avatar) || '',
        nickname: (application && application.coachNickname) || (profile && profile.nickname) || '',
        intro: (application && application.intro) || '',
        stores: list,
        selectedStoreId,
        selectedStoreName,
        selectedStoreIndex,
        status: (binding && binding.status) || 'none',
        reason: application ? (application.reason || '') : '',
        loading: false
      });
    }).catch(() => this.setData({ loading: false }));
  },
  chooseAvatar() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      success: (res) => {
        const tempPath = res.tempFiles[0].tempFilePath;
        wx.showLoading({ title: '上传中' });
        data.uploadImage(tempPath)
          .then((url) => this.setData({ avatar: url }))
          .finally(() => wx.hideLoading());
      }
    });
  },
  onInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },
  onStoreChange(e) {
    const idx = Number(e.detail.value);
    const store = this.data.stores[idx];
    if (!store) return;
    this.setData({
      selectedStoreIndex: idx,
      selectedStoreId: store._id || '',
      selectedStoreName: store.name || ''
    });
  },
  submitApplication() {
    if (this.data.submitting || this.data.status === 'pending' || this.data.status === 'approved') return;
    const nickname = (this.data.nickname || '').trim();
    const intro = (this.data.intro || '').trim();
    if (!nickname) {
      wx.showToast({ title: '请填写教练昵称', icon: 'none' });
      return;
    }
    if (!this.data.selectedStoreId) {
      wx.showToast({ title: '请选择申请球厅', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    data.applyCoachShopBinding({
      storeId: this.data.selectedStoreId,
      coachNickname: nickname,
      coachAvatar: this.data.avatar,
      intro
    }).then((r) => {
      if (r && r.ok === false) {
        wx.showToast({ title: r.msg || '提交失败', icon: 'none' });
        return;
      }
      wx.showToast({ title: '已提交申请', icon: 'success' });
      this.loadInitial();
    }).catch(() => {
      wx.showToast({ title: '提交失败', icon: 'none' });
    }).finally(() => this.setData({ submitting: false }));
  },
  goCoachProfile() {
    wx.navigateTo({ url: '/pages/coach/profile/index' });
  }
});
```

Create WXML with avatar, nickname, hall picker, intro textarea, status card, and submit button. Create WXSS matching existing card/field patterns.

- [ ] **Step 3: Run the test**

Run: `node tests/becomeCoachApplication.test.js`

Expected: still FAIL until data/cloud/shop review support is added.

### Task 3: Data And Cloud Permission Boundary

**Files:**
- Modify: `miniprogram/services/data.js`
- Modify: `cloudfunctions/applyCoachShopBinding/index.js`
- Modify: `cloudfunctions/reviewCoachBindingApplication/index.js`
- Modify: `cloudfunctions/saveCoachProfile/index.js`
- Test: `tests/becomeCoachApplication.test.js`

**Interfaces:**
- Produces: `applyCoachShopBinding({ storeId, coachNickname, coachAvatar, intro })`
- Produces: approval logic that appends `coach` to `users.roles` while keeping `currentRole` and `role` unchanged.

- [ ] **Step 1: Extend application payload**

Update client and cloud `applyCoachShopBinding` to accept and persist `intro`.

- [ ] **Step 2: Open coach identity only on approval**

In `cloudfunctions/reviewCoachBindingApplication/index.js`, after creating `shop_coach_links`, update the applicant user:

```js
async function openCoachRole(coachOpenid) {
  const users = db.collection('users');
  const res = await users.where({ _openid: coachOpenid }).get();
  if (!res.data.length) {
    await users.add({
      data: {
        _openid: coachOpenid,
        roles: ['member', 'coach'],
        currentRole: 'member',
        role: 'member',
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    });
    return;
  }
  const user = res.data[0];
  const roles = Array.from(new Set([].concat(user.roles || [], user.role || 'member', ['member', 'coach'])))
    .filter((role) => ['member', 'coach', 'shop'].indexOf(role) !== -1);
  await users.doc(user._id).update({
    data: {
      roles,
      currentRole: user.currentRole || user.role || 'member',
      role: user.role || user.currentRole || 'member',
      updatedAt: db.serverDate()
    }
  });
}
```

Call `await openCoachRole(application.coachOpenid);` only when `approve` is true.

- [ ] **Step 3: Remove direct coach-role opening from saveCoachProfile**

Update `cloudfunctions/saveCoachProfile/index.js` so it saves the profile and syncs nickname/avatar only. It must not write `role: 'coach'` or append `coach` to `users.roles`.

- [ ] **Step 4: Run the test**

Run: `node tests/becomeCoachApplication.test.js`

Expected: closer to PASS; shop card may still fail until Task 4.

### Task 4: Shop Review Card Shows Application Intro

**Files:**
- Modify: `miniprogram/pages/shop/coaches/index.wxml`
- Test: `tests/becomeCoachApplication.test.js`

**Interfaces:**
- Consumes: application records containing `intro`.
- Produces: visible `申请说明` line on pending cards.

- [ ] **Step 1: Add the intro line**

Inside each pending application card, add:

```xml
<view wx:if="{{item.intro}}" class="muted">申请说明：{{item.intro}}</view>
```

- [ ] **Step 2: Run the targeted test**

Run: `node tests/becomeCoachApplication.test.js`

Expected: PASS.

### Task 5: Verification And Regression Sweep

**Files:**
- Test only.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: evidence that targeted and existing regressions pass.

- [ ] **Step 1: Run focused tests**

Run:

```powershell
node tests\becomeCoachApplication.test.js
node tests\coachProfileSettingsBinding.test.js
node tests\coachMemberCompatibility.test.js
node tests\loginMethods.test.js
```

Expected: all exit 0.

- [ ] **Step 2: Run full test suite**

Run:

```powershell
$failed = @()
Get-ChildItem -LiteralPath 'tests' -Filter '*.test.js' | Sort-Object Name | ForEach-Object {
  Write-Output "Running $($_.Name)"
  node $_.FullName
  if ($LASTEXITCODE -ne 0) { $failed += $_.Name }
}
if ($failed.Count) {
  Write-Output "FAILED: $($failed -join ', ')"
  exit 1
}
Write-Output 'ALL TESTS PASSED'
```

Expected: `ALL TESTS PASSED`.
