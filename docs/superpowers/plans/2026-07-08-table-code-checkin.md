# Table Code Checkin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a stable table-code based checkin flow where players/coaches scan a table code, join/start on the table page, and shop owners verify the session from the hall-status table card.

**Architecture:** Reuse the existing checkin request queue as the pre-verification table session source. A new table checkin page writes `joined/ready` request state; the shop hall-status page merges ready checkins into table cards and writes verified training through the existing `recordVerifiedTraining` path.

**Tech Stack:** WeChat Mini Program pages/WXML/WXSS, existing `miniprogram/services/data.js`, Tencent Cloud Functions, Node-based static tests.

## Global Constraints

- Stable printed table code payload is `s=<storeId>&t=<tableId>` with optional `tn=<tableName>`.
- First version supports one player and one coach per table session.
- Shop owner clicking “核验有效” ends timing and writes verified training.
- Do not add payment settlement or WebSocket real-time sync in this version.
- Keep changes surgical and follow existing page/service/cloud-function patterns.

---

### Task 1: Data And Cloud Support For Table Codes

**Files:**
- Modify: `miniprogram/services/data.js`
- Modify: `cloudfunctions/requestCheckin/index.js`
- Modify: `cloudfunctions/genCheckinCode/index.js`
- Test: `tests/tableCodeCheckin.test.js`

**Interfaces:**
- Produces: `data.requestCheckin({ storeId, storeName, tableId, tableName, nickname, avatar, role, ready, readyAt })`
- Produces: `data.genStoreCheckinCode(storeId, tableId, tableName)` with old store-only call still supported.

- [ ] **Step 1: Write failing static tests**

Create `tests/tableCodeCheckin.test.js` asserting:

```js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const dataJs = read('miniprogram/services/data.js');
const requestCheckin = read('cloudfunctions/requestCheckin/index.js');
const genCheckinCode = read('cloudfunctions/genCheckinCode/index.js');
const appJson = read('miniprogram/app.json');

assert(dataJs.includes('role: role ||'), 'requestCheckin should persist participant role.');
assert(dataJs.includes('ready: !!ready'), 'requestCheckin should persist ready state.');
assert(dataJs.includes('readyAt'), 'requestCheckin should persist readyAt timing.');
assert(dataJs.includes('function genStoreCheckinCode(storeId, tableId, tableName)'), 'genStoreCheckinCode should accept table fields.');
assert(genCheckinCode.includes("sceneParts.push('t=' + tableId)"), 'table code scene should include tableId.');
assert(genCheckinCode.includes("page: page || (tableId ? 'pages/table/checkin/index' : 'pages/match/index')"), 'table code should target the table checkin page.');
assert(requestCheckin.includes('role') && requestCheckin.includes('ready') && requestCheckin.includes('readyAt'), 'cloud requestCheckin should store table-session fields.');
assert(appJson.includes('pages/table/checkin/index'), 'app.json should register table checkin page.');
```

- [ ] **Step 2: Run test to verify failure**

Run: `node tests/tableCodeCheckin.test.js`
Expected: FAIL on missing table code support.

- [ ] **Step 3: Implement data/cloud fields**

Extend `requestCheckin` in both client and cloud to store `role`, `ready`, `readyAt`, and `joinedAt`. Extend `genStoreCheckinCode` to accept table fields and generate `s/t/tn` scene.

- [ ] **Step 4: Run test to verify pass**

Run: `node tests/tableCodeCheckin.test.js`
Expected: PASS.

### Task 2: Player/Coach Table Checkin Page

**Files:**
- Create: `miniprogram/pages/table/checkin/index.js`
- Create: `miniprogram/pages/table/checkin/index.wxml`
- Create: `miniprogram/pages/table/checkin/index.wxss`
- Create: `miniprogram/pages/table/checkin/index.json`
- Modify: `miniprogram/app.json`
- Test: `tests/tableCodeCheckin.test.js`

**Interfaces:**
- Consumes: `data.getStoreById(storeId)`, `data.getPendingCheckins(storeId)`, `data.requestCheckin(...)`.
- Produces: page methods `joinTable()`, `startPlay()`, `refreshParticipants()`.

- [ ] **Step 1: Extend tests**

Assert the new page exists and includes `joinTable`, `startPlay`, `getPendingCheckins`, and `ready: true`.

- [ ] **Step 2: Run test to verify failure**

Run: `node tests/tableCodeCheckin.test.js`
Expected: FAIL on missing page.

- [ ] **Step 3: Create minimal table page**

The page parses `scene` and query params, loads store/table info, shows participant avatars, writes joined state on “加入”, writes ready state on “开打”.

- [ ] **Step 4: Run test to verify pass**

Run: `node tests/tableCodeCheckin.test.js`
Expected: PASS.

### Task 3: Shop Hall-Status Verification

**Files:**
- Modify: `miniprogram/pages/shop/hall-status/index.js`
- Modify: `miniprogram/pages/shop/hall-status/index.wxml`
- Modify: `miniprogram/pages/shop/hall-status/index.wxss`
- Test: `tests/tableCodeCheckin.test.js`

**Interfaces:**
- Consumes: ready checkin records from `data.getPendingCheckins(storeId)`.
- Produces: `verifyTableCheckin(e)` that calls `_syncTrainingOnClose(table, order)` and resolves related checkins.

- [ ] **Step 1: Extend tests**

Assert hall-status merges pending checkins, shows “核验有效”, and exposes `goTableQr`/`verifyTableCheckin`.

- [ ] **Step 2: Run test to verify failure**

Run: `node tests/tableCodeCheckin.test.js`
Expected: FAIL on missing shop verification hooks.

- [ ] **Step 3: Implement table card merge and verification**

Merge ready pending checkins into table cards when no active session exists. Show participants and timer. Make the occupied action read “核验有效” for pending verification sessions. Verification records training and clears pending requests.

- [ ] **Step 4: Run test to verify pass**

Run: `node tests/tableCodeCheckin.test.js`
Expected: PASS.

### Task 4: Table QR Entry From Shop UI

**Files:**
- Modify: `miniprogram/pages/shop/checkin-qr/index.js`
- Modify: `miniprogram/pages/shop/checkin-qr/index.wxml`
- Modify: `miniprogram/pages/shop/hall-status/index.wxml`
- Test: `tests/tableCodeCheckin.test.js`

**Interfaces:**
- Consumes: `goTableQr(e)` from hall-status.
- Produces: table-specific QR display with payload `s=<storeId>&t=<tableId>&tn=<tableName>`.

- [ ] **Step 1: Extend tests**

Assert checkin-qr handles `tableId/tableName` options and hall-status has a “桌码” action.

- [ ] **Step 2: Run test to verify failure**

Run: `node tests/tableCodeCheckin.test.js`
Expected: FAIL on missing QR entry.

- [ ] **Step 3: Implement QR entry**

Add a card-level “桌码” action that opens checkin-qr with table params. Update checkin-qr payload and copy text for table-specific codes.

- [ ] **Step 4: Run targeted and full tests**

Run: `node tests/tableCodeCheckin.test.js`
Expected: PASS.

Run all tests:

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
