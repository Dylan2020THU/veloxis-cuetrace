# Admins Collection Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move shop-owner qualification review permissions from hard-coded admin openid lists to an `admins` cloud database collection while keeping the current owner openid as the first bootstrap administrator.

**Architecture:** Add one shared pure admin authorization helper for frontend/mock and local Node verification. Add one `getAdminStatus` cloud function for frontend entry visibility. Update the two sensitive review cloud functions to query `admins` first and fall back to the bootstrap openid only when the `admins` collection has no active admin records.

**Tech Stack:** WeChat Mini Program JavaScript, WeChat Cloud Functions, cloud database collections `admins` and `shop_applications`, local mock storage.

---

### Task 1: Shared Admin Authorization Helper

**Files:**
- Create: `miniprogram/utils/adminAuth.js`
- Modify: `miniprogram/utils/admin.js`

- [ ] **Step 1: Write red verification**

Run:

```powershell
node -e "const a=require('./miniprogram/utils/adminAuth'); const rows=[{_openid:'admin_1',status:'active'}]; if(!a.isActiveAdmin('admin_1',rows)) throw new Error('active admin must be allowed'); if(a.isActiveAdmin('admin_2',rows)) throw new Error('unknown openid must be denied'); if(!a.shouldBootstrapAdmin('seed_1',[],['seed_1'])) throw new Error('bootstrap seed must be allowed when no active admins exist'); if(a.shouldBootstrapAdmin('seed_1',rows,['seed_1'])) throw new Error('bootstrap seed must stop once active admins exist');"
```

Expected: FAIL with module not found or missing function.

- [ ] **Step 2: Implement helper**

Create `miniprogram/utils/adminAuth.js` with `BOOTSTRAP_ADMIN_OPENIDS`, `isActiveAdmin(openid, admins)`, `hasActiveAdmins(admins)`, and `shouldBootstrapAdmin(openid, admins, bootstrapOpenids)`.

- [ ] **Step 3: Re-run verification**

Run the command from Step 1.

Expected: exit code 0.

### Task 2: Cloud Admin Status

**Files:**
- Create: `cloudfunctions/getAdminStatus/index.js`
- Create: `cloudfunctions/getAdminStatus/package.json`
- Modify: `miniprogram/services/data.js`

- [ ] **Step 1: Add cloud function**

Implement `getAdminStatus` to return `{ ok: true, isAdmin, bootstrap }`. It queries `admins` records with `status:'active'`; if none exist, bootstrap openids are accepted.

- [ ] **Step 2: Add data service method**

Add `getAdminStatus()` in `miniprogram/services/data.js`. In cloud mode it calls the cloud function; in mock mode it reads `mock.KEY_ADMINS` and uses the shared helper.

- [ ] **Step 3: Export method**

Export `getAdminStatus` from `module.exports`.

### Task 3: Review Cloud Functions Use Admins Collection

**Files:**
- Modify: `cloudfunctions/getPendingShopApplications/index.js`
- Modify: `cloudfunctions/reviewShopApplication/index.js`

- [ ] **Step 1: Replace hard-coded checks**

Add local helper functions in each cloud function: `getActiveAdmins()` and `isAdminOpenid(openid)`. They query `admins`; if active admins exist, only those records are allowed. If none exist, use bootstrap openids.

- [ ] **Step 2: Keep existing review behavior**

Do not change application list, approve, reject, or `users.role='shop'` behavior.

### Task 4: Frontend Entry Visibility

**Files:**
- Modify: `miniprogram/pages/settings/index.js`
- Modify: `miniprogram/pages/shop/apply/index.js`

- [ ] **Step 1: Replace sync client whitelist**

Remove direct `isAdmin(openid)` page checks and call `data.getAdminStatus()` after page state loads. Keep `isAdmin:false` as default until the async result returns.

- [ ] **Step 2: Keep navigation unchanged**

Keep `/pages/shop/admin/review/index` as the review backend route.

### Task 5: Verification

**Files:**
- Check all modified JavaScript files.

- [ ] **Step 1: Node behavior verification**

Run the Task 1 Node command.

- [ ] **Step 2: Syntax checks**

Run:

```powershell
node --check miniprogram\utils\adminAuth.js
node --check miniprogram\utils\admin.js
node --check miniprogram\services\data.js
node --check miniprogram\pages\settings\index.js
node --check miniprogram\pages\shop\apply\index.js
node --check cloudfunctions\getAdminStatus\index.js
node --check cloudfunctions\getPendingShopApplications\index.js
node --check cloudfunctions\reviewShopApplication\index.js
```

Expected: all exit code 0.

- [ ] **Step 3: Diff check**

Run:

```powershell
git diff --check -- miniprogram\utils\adminAuth.js miniprogram\utils\admin.js miniprogram\services\data.js miniprogram\pages\settings\index.js miniprogram\pages\shop\apply\index.js cloudfunctions\getAdminStatus\index.js cloudfunctions\getAdminStatus\package.json cloudfunctions\getPendingShopApplications\index.js cloudfunctions\reviewShopApplication\index.js
```

Expected: exit code 0, ignoring line-ending warnings.
