# 管理员跨身份登录 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让内置管理员账号 `admin_zhx` 可以以球员、教练、店主任一身份登录，并在各身份「我的」页显示「管理员」。

**Architecture:** 管理员状态继续作为权限叠加在当前业务身份上。登录页负责把内置管理员账号补齐为三身份权限，并在店主登录网关中跳过普通店主资质审核；个人页通过现有 `data.getAdminStatus()` 判断是否显示「管理员」标签。设置页已有 `isAdmin` 守卫，本次用测试覆盖任一身份下管理员入口可见。

**Tech Stack:** 微信小程序 Page JS/WXML、本地 mock 存储、Node.js `assert` 测试。

## Global Constraints

- 不新增第四种 `admin` 业务身份。
- 不改变普通球员、教练、店主登录规则。
- 不新增管理员管理页面。
- 不删除文件。
- 只触碰登录页、个人页、管理员相关测试和本计划文件。

---

### Task 1: 管理员三身份登录与店主端绕过

**Files:**
- Modify: `tests/adminVisibility.test.js`
- Modify: `miniprogram/pages/login/index.js`

**Interfaces:**
- Consumes: `adminAuth.ADMIN_ACCOUNTS`, `adminAuth.isAdminAccount(account)`
- Produces: `readRegisteredAccounts()` 返回的内置管理员账号包含 `roles: ['member', 'coach', 'shop']`
- Produces: `doShopLogin(loginName, roles)` 对管理员账号调用 `data.login('shop', roles, loginName)` 后直接进入店主端

- [ ] **Step 1: Write failing tests**

Add tests to `tests/adminVisibility.test.js` that load the login page with an old cached `admin_zhx` record and assert:

```js
const page = loadLoginPage([
  { role: 'member', roles: ['member'], account: 'admin_zhx', password: '2612694' }
]);
assert(page.findRegisteredAccount('admin_zhx', 'member'));
assert(page.findRegisteredAccount('admin_zhx', 'coach'));
assert(page.findRegisteredAccount('admin_zhx', 'shop'));
```

Add a second test that stubs `data.login`, `data.markFirstLogin`, `wx.switchTab`, and calls:

```js
page.doShopLogin('admin_zhx', ['member', 'coach', 'shop']);
```

Assert that `data.login` receives `('shop', ['member', 'coach', 'shop'], 'admin_zhx')`, `data.getShopApplicationStatus()` is not called, and navigation goes to `/pages/shop/hall-status/index`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/adminVisibility.test.js`

Expected: FAIL because cached `admin_zhx` only supports `member`, and `doShopLogin` still checks shop application status.

- [ ] **Step 3: Write minimal implementation**

In `miniprogram/pages/login/index.js`:

```js
const ADMIN_ROLES = ['member', 'coach', 'shop'];
```

Update `readRegisteredAccounts()` so every built-in admin account is inserted or merged with:

```js
role: 'member',
roles: ADMIN_ROLES,
builtInAdmin: true
```

Update `doLogin(role, loginName, roles)` so the shop path calls:

```js
this.doShopLogin(loginName, roles);
```

Update `doShopLogin(loginName, roles)` so it computes `const isAdmin = adminAuth.isAdminAccount(loginName);`, calls `data.login('shop', roles, loginName)`, remembers the login nickname, and if `isAdmin` skips `data.getShopApplicationStatus()` and enters shop home after `data.markFirstLogin('shop')`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/adminVisibility.test.js`

Expected: PASS.

---

### Task 2: 我的页管理员标签

**Files:**
- Modify: `tests/profileHeaderRole.test.js`
- Modify: `miniprogram/pages/profile/index.js`

**Interfaces:**
- Consumes: `data.getAdminStatus(): Promise<{ isAdmin: boolean }>`
- Produces: `profile.data.isAdmin`
- Produces: `roleLabel` is `管理员` when `isAdmin` is true, otherwise existing role label

- [ ] **Step 1: Write failing tests**

Extend `tests/profileHeaderRole.test.js` to load `miniprogram/pages/profile/index.js` with a stubbed `data.getAdminStatus()` returning `{ isAdmin: true }`, call `page.onShow()`, wait for promises, and assert:

```js
assert.strictEqual(page.data.roleLabel, '管理员');
assert.strictEqual(page.data.isAdmin, true);
```

Add a normal user variant returning `{ isAdmin: false }` and assert existing labels still resolve to `会员` / `教练` / `店家` by current role.

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/profileHeaderRole.test.js`

Expected: FAIL because profile page does not call `data.getAdminStatus()` and has no `isAdmin` state.

- [ ] **Step 3: Write minimal implementation**

In `miniprogram/pages/profile/index.js`:

```js
const ADMIN_LABEL = '管理员';
```

Add `isAdmin: false` to `data`.

Add helper:

```js
resolveRoleLabel(role, isAdmin) {
  return isAdmin ? ADMIN_LABEL : (ROLE_LABEL[role] || ROLE_LABEL.member);
}
```

In `onShow()`, set the initial role label through `resolveRoleLabel(role, this.data.isAdmin)`, then call `data.getAdminStatus()` and set:

```js
isAdmin: !!(r && r.isAdmin),
roleLabel: this.resolveRoleLabel(this.data.role, !!(r && r.isAdmin))
```

When `getUserProfile()` resolves, keep using `this.data.isAdmin` so an admin label is not overwritten by profile loading.

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/profileHeaderRole.test.js`

Expected: PASS.

---

### Task 3: Final verification

**Files:**
- Verify: `tests/adminVisibility.test.js`
- Verify: `tests/profileHeaderRole.test.js`
- Verify: all tests under `tests/*.test.js`

- [ ] **Step 1: Run focused tests**

Run:

```powershell
node tests/adminVisibility.test.js
node tests/profileHeaderRole.test.js
```

Expected: both exit 0.

- [ ] **Step 2: Run full local test suite**

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
