# Coach Shop Binding Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let coaches request to bind to a shop store, and only create the active shop-coach relationship after the shop owner approves it.

**Architecture:** Add a pending application collection `coach_shop_applications` as the workflow source of truth. Keep `shop_coach_links` as the active relationship table after approval. Frontend pages call data service methods that route to cloud functions in cloud mode and local mock arrays in demo mode.

**Tech Stack:** WeChat Mini Program JavaScript, WeChat Cloud Functions, cloud database collections `stores`, `coaches`, `coach_shop_applications`, and `shop_coach_links`.

---

### Task 1: Binding Status Helper

**Files:**
- Create: `miniprogram/utils/coachBinding.js`

- [ ] **Step 1: Red test**

Run:

```powershell
node -e "const b=require('./miniprogram/utils/coachBinding'); if(b.statusLabel({status:'pending'})!=='待店家确认') throw new Error('pending label'); if(b.statusLabel({status:'approved'})!=='已绑定') throw new Error('approved label'); if(b.statusLabel({status:'rejected'})!=='已驳回') throw new Error('rejected label');"
```

Expected: FAIL because `coachBinding` does not exist.

- [ ] **Step 2: Implement helper**

Create `statusLabel(application)` and `isPending(application)`.

### Task 2: Cloud Functions

**Files:**
- Create: `cloudfunctions/applyCoachShopBinding/index.js`
- Create: `cloudfunctions/applyCoachShopBinding/package.json`
- Create: `cloudfunctions/getMyCoachShopBindingStatus/index.js`
- Create: `cloudfunctions/getMyCoachShopBindingStatus/package.json`
- Create: `cloudfunctions/getCoachBindingApplications/index.js`
- Create: `cloudfunctions/getCoachBindingApplications/package.json`
- Create: `cloudfunctions/reviewCoachBindingApplication/index.js`
- Create: `cloudfunctions/reviewCoachBindingApplication/package.json`
- Modify: `cloudfunctions/getShopCoaches/index.js`
- Modify: `cloudfunctions/addShopCoach/index.js`

- [ ] **Step 1: Coach applies**

`applyCoachShopBinding` validates `storeId`, loads the target store, stores `shopOpenid = store._openid`, and upserts a pending application for the same coach and store.

- [ ] **Step 2: Coach reads status**

`getMyCoachShopBindingStatus` returns the current active link first, then latest application.

- [ ] **Step 3: Shop reviews**

`getCoachBindingApplications` returns pending applications for the current shop owner. `reviewCoachBindingApplication` updates application status and writes `shop_coach_links.active` on approval.

- [ ] **Step 4: Existing shop add remains direct**

`addShopCoach` keeps shop-initiated direct addition but stamps `storeId/storeName/source`.

### Task 3: Data Service And Mock

**Files:**
- Modify: `miniprogram/utils/mock.js`
- Modify: `miniprogram/services/data.js`

- [ ] **Step 1: Add mock key**

Add `KEY_COACH_SHOP_APPLICATIONS`.

- [ ] **Step 2: Add service methods**

Add `applyCoachShopBinding`, `getMyCoachShopBindingStatus`, `getCoachBindingApplications`, and `reviewCoachBindingApplication`.

### Task 4: Coach Profile UI

**Files:**
- Modify: `miniprogram/pages/coach/profile/index.js`
- Modify: `miniprogram/pages/coach/profile/index.wxml`
- Modify: `miniprogram/pages/coach/profile/index.wxss`

- [ ] **Step 1: Store picker uses stores**

Load stores, let coach select a target store, and save normal profile data separately from the binding request.

- [ ] **Step 2: Submit request**

After saving profile, if a store is selected, call `applyCoachShopBinding`.

- [ ] **Step 3: Show status**

Show pending, approved, or rejected status under the selected store.

### Task 5: Shop Coach Review UI

**Files:**
- Modify: `miniprogram/pages/shop/coaches/index.js`
- Modify: `miniprogram/pages/shop/coaches/index.wxml`
- Modify: `miniprogram/pages/shop/coaches/index.wxss`

- [ ] **Step 1: Load applications**

Load pending coach binding applications for the current shop.

- [ ] **Step 2: Approve/reject**

Call `reviewCoachBindingApplication` and refresh the list.

### Task 6: Verification

Run:

```powershell
node -e "const b=require('./miniprogram/utils/coachBinding'); if(b.statusLabel({status:'pending'})!=='待店家确认') throw new Error('pending label'); if(b.statusLabel({status:'approved'})!=='已绑定') throw new Error('approved label'); if(b.statusLabel({status:'rejected'})!=='已驳回') throw new Error('rejected label');"
node --check miniprogram\utils\coachBinding.js
node --check miniprogram\services\data.js
node --check miniprogram\pages\coach\profile\index.js
node --check miniprogram\pages\shop\coaches\index.js
node --check cloudfunctions\applyCoachShopBinding\index.js
node --check cloudfunctions\getMyCoachShopBindingStatus\index.js
node --check cloudfunctions\getCoachBindingApplications\index.js
node --check cloudfunctions\reviewCoachBindingApplication\index.js
node --check cloudfunctions\getShopCoaches\index.js
node --check cloudfunctions\addShopCoach\index.js
```
