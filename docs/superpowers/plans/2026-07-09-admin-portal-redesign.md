# Admin Portal Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an independent admin portal where the configured admin account logs in directly to platform-level Store, Coach, and Member dashboards without choosing a normal identity.

**Architecture:** Keep normal member/coach/shop login behavior intact. Add an admin-only session mode, admin-only tab configuration, admin-only pages, and admin-only cloud aggregation functions. Cloud admin data functions must authorize by current openid plus admin login name before returning platform-wide data.

**Tech Stack:** WeChat Mini Program pages (`.js/.wxml/.wxss/.json`), custom tab bar, Tencent Cloud Functions using `wx-server-sdk`, existing Node assertion tests.

## Global Constraints

- 管理员账号输入正确账号密码后，跳过身份选择页，直接进入管理员端。
- 管理员端底栏只包含「门店」「教练」「会员」。
- 管理员端使用独立权限判断和独立聚合数据接口，不复用店主端的当前门店数据范围。
- 当前只有一个管理员账号：`admin_zhx`。
- 不改变球员、教练、店主的正常登录和身份选择逻辑。
- 店主资质审核入口仍只在管理员可访问位置出现，并从管理员「门店」页进入。
- 不删除任何文件。

---

## File Structure

- Modify `miniprogram/pages/login/index.js`: detect admin credentials before normal account role selection and enter admin portal.
- Modify `miniprogram/services/data.js`: add admin session helpers and admin data service functions.
- Modify `miniprogram/custom-tab-bar/index.js`: add admin tab list.
- Modify `miniprogram/app.json`: register admin pages and admin tabBar paths.
- Create `miniprogram/pages/admin/stores/index.{js,wxml,wxss,json}`: store overview, filters, list, review entry.
- Create `miniprogram/pages/admin/coaches/index.{js,wxml,wxss,json}`: coach overview, filters, list.
- Create `miniprogram/pages/admin/members/index.{js,wxml,wxss,json}`: member overview, filters, list.
- Create `cloudfunctions/adminLogin/index.js`: server-side admin credential and openid binding check.
- Create `cloudfunctions/getAdminStores/index.js`: platform store aggregation.
- Create `cloudfunctions/getAdminCoaches/index.js`: platform coach aggregation.
- Create `cloudfunctions/getAdminMembers/index.js`: platform member aggregation.
- Create `tests/adminPortal.test.js`: regression coverage for routing, tab bar, services, and cloud authorization.
- Modify `tests/adminVisibility.test.js`: replace old “admin can enter every role” expectation with new independent admin portal expectation.

---

### Task 1: Admin Login Session And Tab Routing

**Files:**
- Modify: `miniprogram/pages/login/index.js`
- Modify: `miniprogram/services/data.js`
- Modify: `miniprogram/custom-tab-bar/index.js`
- Modify: `miniprogram/app.json`
- Test: `tests/adminPortal.test.js`
- Test: `tests/adminVisibility.test.js`

**Interfaces:**
- Produces: `data.loginAdmin({ account, password }): Promise<{ ok: true }>`
- Produces: `data.logoutAdmin(): void`
- Produces: admin session storage key `dc_admin_login_name`
- Consumes: existing `adminAuth.ADMIN_ACCOUNTS`

- [ ] **Step 1: Write failing login and tab tests**

Create `tests/adminPortal.test.js` with these checks:

```js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

function loadLoginPage(accounts, fakeData) {
  const loginPath = path.join(root, 'miniprogram/pages/login/index.js');
  delete require.cache[require.resolve(loginPath)];

  let page;
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (fakeData && request === '../../services/data') return fakeData;
    return originalLoad.call(this, request, parent, isMain);
  };

  global.Page = (def) => { page = def; };
  global.Behavior = (def) => def;
  global.getApp = () => ({ globalData: { cloudReady: false } });
  global.wx = {
    getStorageSync(key) {
      if (key === 'dc_accounts') return accounts;
      return '';
    },
    setStorageSync() {},
    removeStorageSync() {},
    showToast() {},
    showLoading() {},
    hideLoading() {},
    switchTab() {},
    reLaunch() {},
    navigateTo() {}
  };

  try {
    require(loginPath);
  } finally {
    Module._load = originalLoad;
  }
  page.data = JSON.parse(JSON.stringify(page.data));
  page.setData = function setData(next) {
    this.data = Object.assign({}, this.data, next);
  };
  return page;
}

async function testAdminPasswordLoginBypassesRolePicker() {
  const calls = { loginAdmin: [], switchTab: [] };
  const fakeData = {
    loginAdmin(args) {
      calls.loginAdmin.push(args);
      return Promise.resolve({ ok: true });
    }
  };
  const page = loadLoginPage([], fakeData);
  global.wx.switchTab = (args) => calls.switchTab.push(args);

  page.setData({
    account: 'admin_zhx',
    password: '2612694',
    agreementChecked: true,
    loginType: 'password'
  });
  page.submit();
  await flushPromises();
  await flushPromises();

  assert.deepStrictEqual(calls.loginAdmin[0], { account: 'admin_zhx', password: '2612694' });
  assert.strictEqual(page.data.step, 'auth', 'Admin login must not enter the normal role picker.');
  assert.deepStrictEqual(calls.switchTab[0], { url: '/pages/admin/stores/index' });
}

function testStaticAdminWiring() {
  const appJson = read('miniprogram/app.json');
  const tabJs = read('miniprogram/custom-tab-bar/index.js');
  const dataJs = read('miniprogram/services/data.js');

  assert(appJson.includes('pages/admin/stores/index'), 'app.json should register admin stores page.');
  assert(appJson.includes('pages/admin/coaches/index'), 'app.json should register admin coaches page.');
  assert(appJson.includes('pages/admin/members/index'), 'app.json should register admin members page.');
  assert(tabJs.includes('admin: [') && tabJs.includes("text: '门店'") && tabJs.includes("text: '教练'") && tabJs.includes("text: '会员'"), 'Custom tab bar should have admin tabs.');
  assert(dataJs.includes('function loginAdmin({ account, password })'), 'Data service should expose loginAdmin.');
  assert(dataJs.includes("mock.setRole('admin')"), 'Admin login should persist admin role for custom tab rendering.');
}

(async () => {
  await testAdminPasswordLoginBypassesRolePicker();
  testStaticAdminWiring();
})();
```

Update `tests/adminVisibility.test.js`:

```js
function testAdminLoginBypassesRoleSelectionInsteadOfRoleCompatibility() {
  const data = {
    loginAdmin() {
      return Promise.resolve({ ok: true });
    }
  };
  const page = loadLoginPage([
    { role: 'member', roles: ['member'], account: 'admin_zhx', password: '2612694' }
  ], data);
  assert.strictEqual(typeof page.doAdminLogin, 'function', 'Admin login should use a dedicated admin entry path.');
}
```

Remove the old assertions that require admin to enter `member`, `coach`, and `shop` as normal roles.

- [ ] **Step 2: Run tests to verify failure**

Run:

```powershell
node tests/adminPortal.test.js
node tests/adminVisibility.test.js
```

Expected: `tests/adminPortal.test.js` fails because `loginAdmin`, admin pages, and admin tabs do not exist yet. `tests/adminVisibility.test.js` fails until old role-compatibility assertions are updated.

- [ ] **Step 3: Implement admin session service**

In `miniprogram/services/data.js`, add:

```js
const ADMIN_LOGIN_NAME_KEY = 'dc_admin_login_name';
```

Add helper functions:

```js
function setAdminSession(loginName) {
  const app = typeof getApp === 'function' ? getApp() : null;
  const name = (loginName || '').trim();
  try {
    wx.setStorageSync(ADMIN_LOGIN_NAME_KEY, name);
  } catch (e) {}
  mock.setRole('admin');
  if (app && app.globalData) {
    app.globalData.role = 'admin';
    app.globalData.currentRole = 'admin';
    app.globalData.adminMode = true;
    app.globalData.adminLoginName = name;
  }
}

function readAdminLoginName() {
  try {
    return wx.getStorageSync(ADMIN_LOGIN_NAME_KEY) || '';
  } catch (e) {
    return '';
  }
}

function logoutAdmin() {
  try {
    wx.removeStorageSync(ADMIN_LOGIN_NAME_KEY);
  } catch (e) {}
  mock.setRole('member');
  const app = typeof getApp === 'function' ? getApp() : null;
  if (app && app.globalData) {
    app.globalData.role = 'member';
    app.globalData.currentRole = 'member';
    app.globalData.adminMode = false;
    app.globalData.adminLoginName = '';
  }
}
```

Update `currentLoginName()` so admin pages authorize with the admin account:

```js
function currentLoginName() {
  const app = getApp();
  const role = (app && app.globalData && (app.globalData.currentRole || app.globalData.role)) || mock.getRole() || 'member';
  if (role === 'admin') return readAdminLoginName();
  return readLoginNickname(role);
}
```

Add:

```js
function loginAdmin({ account, password }) {
  const loginName = (account || '').trim();
  if (cloudReady()) {
    return callCloud('adminLogin', { account: loginName, password }).then((r) => {
      if (r && r.ok === false) {
        const err = new Error(r.msg || '管理员登录失败');
        err.code = r.code || '';
        throw err;
      }
      setAdminSession(loginName);
      return r || { ok: true };
    });
  }
  const admin = adminAuth.ADMIN_ACCOUNTS.find((item) => item.account === loginName);
  if (!admin || admin.password !== password) {
    return Promise.reject(new Error('管理员账号或密码错误'));
  }
  setAdminSession(loginName);
  return Promise.resolve({ ok: true, isAdmin: true });
}
```

Export `loginAdmin` and `logoutAdmin`.

- [ ] **Step 4: Implement admin login branch**

In `miniprogram/pages/login/index.js`, add:

```js
const ADMIN_HOME = '/pages/admin/stores/index';
```

Add method:

```js
doAdminLogin(account, password) {
  wx.showLoading({ title: '登录中', mask: true });
  data
    .loginAdmin({ account, password })
    .then(() => {
      wx.hideLoading();
      wx.switchTab({ url: ADMIN_HOME });
    })
    .catch((e) => {
      wx.hideLoading();
      wx.showToast({ title: (e && e.message) || '管理员登录失败', icon: 'none' });
    });
}
```

In password `submit()`, before `findRegisteredAccount(account)`:

```js
if (adminAuth.isAdminAccount(account)) {
  this.doAdminLogin(account, this.data.password);
  return;
}
```

- [ ] **Step 5: Add admin tab routing**

In `miniprogram/custom-tab-bar/index.js`, add an `admin` tab list:

```js
admin: [
  { path: '/pages/admin/stores/index', text: '门店', icon: icon('layoutgrid') },
  { path: '/pages/admin/coaches/index', text: '教练', icon: icon('necktie') },
  { path: '/pages/admin/members/index', text: '会员', icon: icon('students') }
]
```

In `miniprogram/app.json`, add pages:

```json
"pages/admin/stores/index",
"pages/admin/coaches/index",
"pages/admin/members/index"
```

Add tabBar list entries for the three admin pages.

- [ ] **Step 6: Run Task 1 tests**

Run:

```powershell
node tests/adminPortal.test.js
node tests/adminVisibility.test.js
```

Expected: both pass.

---

### Task 2: Admin Cloud Authorization And Aggregation APIs

**Files:**
- Create: `cloudfunctions/adminLogin/index.js`
- Create: `cloudfunctions/getAdminStores/index.js`
- Create: `cloudfunctions/getAdminCoaches/index.js`
- Create: `cloudfunctions/getAdminMembers/index.js`
- Modify: `miniprogram/services/data.js`
- Test: `tests/adminPortal.test.js`

**Interfaces:**
- Produces: cloud `adminLogin({ account, password })`
- Produces: cloud `getAdminStores({ loginName })`
- Produces: cloud `getAdminCoaches({ loginName })`
- Produces: cloud `getAdminMembers({ loginName })`
- Produces: service `getAdminStores(filters?)`, `getAdminCoaches(filters?)`, `getAdminMembers(filters?)`

- [ ] **Step 1: Add failing API and cloud auth tests**

Append to `tests/adminPortal.test.js`:

```js
function testAdminDataServiceExports() {
  const dataJs = read('miniprogram/services/data.js');
  assert(dataJs.includes('getAdminStores'), 'Data service should expose getAdminStores.');
  assert(dataJs.includes('getAdminCoaches'), 'Data service should expose getAdminCoaches.');
  assert(dataJs.includes('getAdminMembers'), 'Data service should expose getAdminMembers.');
  assert(dataJs.includes("callCloud('getAdminStores', { loginName })"), 'getAdminStores should pass admin loginName.');
  assert(dataJs.includes("callCloud('getAdminCoaches', { loginName })"), 'getAdminCoaches should pass admin loginName.');
  assert(dataJs.includes("callCloud('getAdminMembers', { loginName })"), 'getAdminMembers should pass admin loginName.');
}
```

Add a cloud-function fake-db test:

```js
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

async function testAdminStoresCloudRequiresAdminLoginName() {
  const fakeDb = {
    collection(name) {
      return {
        where(query) {
          return {
            orderBy() { return this; },
            limit() { return this; },
            async get() {
              if (name === 'admins') return { data: [{ _openid: 'admin_openid', account: 'admin_zhx', status: 'active' }] };
              if (name === 'stores') return { data: [{ _id: 'store1', _openid: 'shop_openid', name: 'A厅', checkinEnabled: true }] };
              if (name === 'shop_applications') return { data: [] };
              if (name === 'shops') return { data: [] };
              if (name === 'users') return { data: [] };
              return { data: [] };
            }
          };
        },
        orderBy() { return this; },
        limit() { return this; },
        async get() {
          if (name === 'stores') return { data: [{ _id: 'store1', _openid: 'shop_openid', name: 'A厅', checkinEnabled: true }] };
          if (name === 'shop_applications') return { data: [] };
          if (name === 'shops') return { data: [] };
          if (name === 'users') return { data: [] };
          return { data: [] };
        }
      };
    }
  };
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: 'DYNAMIC_CURRENT_ENV',
    init() {},
    database() { return fakeDb; },
    getWXContext() { return { OPENID: 'admin_openid' }; }
  };
  const fnPath = path.join(root, 'cloudfunctions/getAdminStores/index.js');
  delete require.cache[require.resolve(fnPath)];
  const getAdminStores = withWxServerSdk(fakeCloud, () => require(fnPath));

  const denied = await getAdminStores.main({ loginName: 'zhx1' });
  assert.strictEqual(denied.ok, false);
  assert.strictEqual(denied.code, 'FORBIDDEN');

  const allowed = await getAdminStores.main({ loginName: 'admin_zhx' });
  assert.strictEqual(allowed.ok, true);
  assert.strictEqual(allowed.summary.totalStores, 1);
}
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```powershell
node tests/adminPortal.test.js
```

Expected: fails because admin cloud functions and service functions do not exist.

- [ ] **Step 3: Create adminLogin cloud function**

Create `cloudfunctions/adminLogin/index.js`:

```js
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const ADMIN_CREDENTIALS = [
  { account: 'admin_zhx', password: '2612694' }
];

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const account = (event.account || '').trim();
  const password = event.password || '';
  const hit = ADMIN_CREDENTIALS.find((item) => item.account === account && item.password === password);
  if (!hit) return { ok: false, code: 'INVALID_ADMIN', msg: '管理员账号或密码错误' };

  const admins = db.collection('admins');
  const res = await admins.where({ _openid: OPENID, account }).get().catch(() => ({ data: [] }));
  const data = { _openid: OPENID, account, status: 'active', updatedAt: db.serverDate() };
  if (res.data && res.data.length) {
    await admins.doc(res.data[0]._id).update({ data });
  } else {
    await admins.add({ data: Object.assign({}, data, { createdAt: db.serverDate() }) });
  }
  return { ok: true, isAdmin: true, account };
};
```

- [ ] **Step 4: Create shared admin auth block inside each admin cloud function**

In every `getAdmin*` cloud function, include:

```js
const ADMIN_ACCOUNTS = ['admin_zhx'];

async function isAdminOpenid(openid, loginName) {
  if (ADMIN_ACCOUNTS.indexOf(loginName) === -1) return false;
  const res = await db.collection('admins').where({ status: 'active' }).get().catch(() => ({ data: [] }));
  return (res.data || []).some((item) => item._openid === openid && item.account === loginName);
}
```

Return this on failure:

```js
return { ok: false, code: 'FORBIDDEN', msg: '无管理员权限' };
```

- [ ] **Step 5: Implement getAdminStores**

Create `cloudfunctions/getAdminStores/index.js` with aggregation over `stores`, `shop_applications`, `shops`, and `users`. Return:

```js
{
  ok: true,
  summary: {
    totalStores,
    approvedStores,
    pendingApplications,
    rejectedApplications,
    checkinEnabledStores
  },
  stores
}
```

Each store row must contain:

```js
{
  storeId,
  storeName,
  ownerOpenid,
  ownerName,
  region,
  address,
  applicationStatus,
  checkinEnabled,
  createdAt
}
```

- [ ] **Step 6: Implement getAdminCoaches**

Create `cloudfunctions/getAdminCoaches/index.js` aggregating `coaches`, `users`, `shop_coach_links`, `coach_shop_applications`, and `stores`. Return summary keys:

```js
totalCoaches, boundCoaches, pendingApplications, unboundCoaches, activeCoaches
```

Each row contains:

```js
coachOpenid, coachName, avatar, boundStoreName, bindingStatus, studentCount, createdAt
```

- [ ] **Step 7: Implement getAdminMembers**

Create `cloudfunctions/getAdminMembers/index.js` aggregating `users`, `members`, `training_sessions`, `sessions`, and `stores`. Return summary keys:

```js
totalMembers, newToday, newThisWeek, trainedMembers, activeMembers
```

Each row contains:

```js
memberOpenid, memberName, avatar, accountName, totalTrainingHours, trainingDays, lastTrainingAt, lastStoreName, createdAt
```

- [ ] **Step 8: Add data service wrappers and local fallback**

In `miniprogram/services/data.js`, add:

```js
function getAdminStores() {
  const loginName = readAdminLoginName();
  if (cloudReady()) {
    return callCloud('getAdminStores', { loginName }).then((r) => {
      if (r && r.ok === false) throw Object.assign(new Error(r.msg || '无管理员权限'), { code: r.code || '' });
      return r || { summary: {}, stores: [] };
    });
  }
  const stores = mock.readArray(mock.KEY_STORES);
  const applications = mock.readArray(mock.KEY_SHOP_APPLICATIONS);
  return Promise.resolve(buildLocalAdminStores(stores, applications));
}
```

Add analogous wrappers for `getAdminCoaches()` and `getAdminMembers()`. Local fallback can summarize mock data arrays with empty strings for fields that do not exist locally.

- [ ] **Step 9: Run Task 2 tests**

Run:

```powershell
node tests/adminPortal.test.js
```

Expected: pass.

---

### Task 3: Admin Portal Pages

**Files:**
- Create: `miniprogram/pages/admin/stores/index.js`
- Create: `miniprogram/pages/admin/stores/index.wxml`
- Create: `miniprogram/pages/admin/stores/index.wxss`
- Create: `miniprogram/pages/admin/stores/index.json`
- Create: `miniprogram/pages/admin/coaches/index.js`
- Create: `miniprogram/pages/admin/coaches/index.wxml`
- Create: `miniprogram/pages/admin/coaches/index.wxss`
- Create: `miniprogram/pages/admin/coaches/index.json`
- Create: `miniprogram/pages/admin/members/index.js`
- Create: `miniprogram/pages/admin/members/index.wxml`
- Create: `miniprogram/pages/admin/members/index.wxss`
- Create: `miniprogram/pages/admin/members/index.json`
- Test: `tests/adminPortal.test.js`

**Interfaces:**
- Consumes: `data.getAdminStores(): Promise<{ summary, stores }>`
- Consumes: `data.getAdminCoaches(): Promise<{ summary, coaches }>`
- Consumes: `data.getAdminMembers(): Promise<{ summary, members }>`
- Consumes: `data.logoutAdmin()`

- [ ] **Step 1: Add failing static page tests**

Append to `tests/adminPortal.test.js`:

```js
function testAdminPagesExistAndRenderRequiredSections() {
  const storesJs = read('miniprogram/pages/admin/stores/index.js');
  const storesWxml = read('miniprogram/pages/admin/stores/index.wxml');
  const coachesJs = read('miniprogram/pages/admin/coaches/index.js');
  const coachesWxml = read('miniprogram/pages/admin/coaches/index.wxml');
  const membersJs = read('miniprogram/pages/admin/members/index.js');
  const membersWxml = read('miniprogram/pages/admin/members/index.wxml');

  assert(storesJs.includes('data.getAdminStores()') && storesWxml.includes('数据总览') && storesWxml.includes('门店明细'), 'Stores admin page should load and render overview/list.');
  assert(storesWxml.includes('店主资质审核'), 'Stores admin page should expose shop qualification review entry.');
  assert(coachesJs.includes('data.getAdminCoaches()') && coachesWxml.includes('数据总览') && coachesWxml.includes('教练明细'), 'Coaches admin page should load and render overview/list.');
  assert(membersJs.includes('data.getAdminMembers()') && membersWxml.includes('数据总览') && membersWxml.includes('会员明细'), 'Members admin page should load and render overview/list.');
}
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```powershell
node tests/adminPortal.test.js
```

Expected: fails because admin page files do not exist.

- [ ] **Step 3: Implement stores admin page**

Create `miniprogram/pages/admin/stores/index.json`:

```json
{ "navigationBarTitleText": "门店" }
```

Create `index.js` with:

```js
const data = require('../../../services/data');

Page({
  data: {
    loading: true,
    error: '',
    keyword: '',
    status: 'all',
    checkin: 'all',
    summary: {},
    stores: [],
    filteredStores: []
  },
  onShow() {
    this.load();
  },
  load() {
    this.setData({ loading: true, error: '' });
    data.getAdminStores()
      .then((res) => {
        const stores = (res && res.stores) || [];
        this.setData({ stores, loading: false });
        this.applyFilters();
      })
      .catch(() => this.setData({ loading: false, error: '数据加载失败，请稍后重试' }));
  },
  onKeyword(e) {
    this.setData({ keyword: e.detail.value || '' });
    this.applyFilters();
  },
  chooseStatus(e) {
    this.setData({ status: e.currentTarget.dataset.value });
    this.applyFilters();
  },
  chooseCheckin(e) {
    this.setData({ checkin: e.currentTarget.dataset.value });
    this.applyFilters();
  },
  applyFilters() {
    const keyword = (this.data.keyword || '').trim().toLowerCase();
    const filteredStores = (this.data.stores || []).filter((item) => {
      const statusOk = this.data.status === 'all' || item.applicationStatus === this.data.status;
      const checkinOk = this.data.checkin === 'all' || (this.data.checkin === 'enabled' ? item.checkinEnabled : !item.checkinEnabled);
      const text = `${item.storeName || ''} ${item.ownerName || ''} ${item.address || ''} ${item.region || ''}`.toLowerCase();
      return statusOk && checkinOk && (!keyword || text.indexOf(keyword) !== -1);
    });
    this.setData({ filteredStores, summary: this.buildSummary(filteredStores) });
  },
  buildSummary(list) {
    const rows = list || [];
    return {
      totalStores: rows.length,
      approvedStores: rows.filter((item) => item.applicationStatus === 'approved').length,
      pendingApplications: rows.filter((item) => item.applicationStatus === 'pending').length,
      checkinEnabledStores: rows.filter((item) => item.checkinEnabled).length
    };
  },
  goReview() {
    wx.navigateTo({ url: '/pages/shop/admin/review/index' });
  },
  logout() {
    data.logoutAdmin();
    wx.reLaunch({ url: '/pages/login/index' });
  }
});
```

WXML must include header, logout button, `数据总览`, filter chips, `门店明细`, empty/error states, and a `店主资质审核` button.

- [ ] **Step 4: Implement coaches admin page**

Create analogous files under `miniprogram/pages/admin/coaches/`. The page must call `data.getAdminCoaches()`, provide status and keyword filters, compute filtered summary, and display `教练明细`.

- [ ] **Step 5: Implement members admin page**

Create analogous files under `miniprogram/pages/admin/members/`. The page must call `data.getAdminMembers()`, provide training status and keyword filters, compute filtered summary, and display `会员明细`.

- [ ] **Step 6: Run Task 3 tests**

Run:

```powershell
node tests/adminPortal.test.js
```

Expected: pass.

---

### Task 4: Full Regression And Cleanup

**Files:**
- Modify only files touched by Tasks 1-3 if tests expose gaps.

**Interfaces:**
- Consumes all interfaces from Tasks 1-3.
- Produces passing regression suite for admin portal and related login/admin behavior.

- [ ] **Step 1: Run focused tests**

Run:

```powershell
node tests/adminPortal.test.js
node tests/adminVisibility.test.js
node tests/loginMethods.test.js
node tests/registerAccountRules.test.js
node tests/becomeCoachApplication.test.js
```

Expected: all pass.

- [ ] **Step 2: Run all test files**

Run:

```powershell
Get-ChildItem tests -Filter *.test.js | ForEach-Object { node $_.FullName }
```

Expected: command exits successfully.

- [ ] **Step 3: Check changed files**

Run:

```powershell
git status --short
git diff --stat
```

Expected: only intended admin portal, cloud function, test, plan, and earlier existing uncommitted files appear. Do not revert unrelated user changes.

- [ ] **Step 4: Final manual acceptance notes**

Report:

```text
管理员账号 admin_zhx 登录后直接进入 门店 页。
管理员底栏显示 门店 / 教练 / 会员。
普通账号仍进入身份选择页。
门店、教练、会员页均有总览、筛选、明细列表。
店主资质审核入口在管理员门店页。
测试命令已通过。
```

