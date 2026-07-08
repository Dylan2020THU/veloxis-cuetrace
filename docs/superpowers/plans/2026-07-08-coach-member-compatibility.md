# Coach Member Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make coach accounts inherit player access, preserve one user subject across player/coach ports, and show a coach's teaching lessons in their own player-side training timeline.

**Architecture:** Keep `openid/account` as the user subject. Store durable entitlements in `roles` and the selected port in `currentRole`, while retaining old `role` for compatibility. Player-side training APIs merge `training_sessions` and `coach_lessons` only when the current user views their own trail.

**Tech Stack:** WeChat Mini Program JavaScript, Tencent Cloud Functions, local mock storage, Node.js assertion-based tests.

## Global Constraints

- 教练天然拥有球员身份，可直接登录球员端。
- 店主保持经营主体定位，不向下兼容球员身份。
- 不把教学课时复制写入 `training_sessions`。
- 底部栏、首页、端口权限判断看 `currentRole`；用户主体资料看同一个用户主体。
- 自查杆迹合并 `training_sessions` 和 `coach_lessons`；查别人只看普通训练。

---

### Task 1: Identity Entitlements

**Files:**
- Modify: `cloudfunctions/login/index.js`
- Modify: `cloudfunctions/getUserProfile/index.js`
- Modify: `cloudfunctions/saveUserProfile/index.js`
- Modify: `miniprogram/services/data.js`
- Modify: `miniprogram/pages/login/index.js`
- Test: `tests/coachMemberCompatibility.test.js`

**Interfaces:**
- Produces `roles: string[]` and `currentRole: string` from `login`, `getUserProfile`, and app global state.
- `roles` contains durable account capabilities.
- `currentRole` is the selected port for this login session.

- [ ] **Step 1: Write failing identity tests**

Create `tests/coachMemberCompatibility.test.js` with tests that assert:

```js
// cloud login: old role coach + member login => roles ['member','coach'], currentRole 'member'
// cloud login: shop login has roles ['shop'] and cannot satisfy member entitlement
// page login: coach account can login as member; member account cannot login as coach; shop account cannot login as member
```

- [ ] **Step 2: Run identity test to verify RED**

Run: `node tests\coachMemberCompatibility.test.js`

Expected: FAIL because `roles/currentRole` compatibility is not fully implemented.

- [ ] **Step 3: Implement minimal identity compatibility**

Add local helpers in cloud/user and page/data modules:

```js
function normalizeRoles(role, roles) {
  const list = Array.isArray(roles) ? roles.filter(Boolean) : [];
  if (list.length) return Array.from(new Set(list));
  if (role === 'coach') return ['member', 'coach'];
  if (role === 'shop') return ['shop'];
  return ['member'];
}

function canEnterRole(roles, targetRole) {
  return normalizeRoles('', roles).indexOf(targetRole) !== -1;
}
```

Use `currentRole` for selected port and never collapse `roles` to a single role when changing ports.

- [ ] **Step 4: Verify identity GREEN**

Run: `node tests\coachMemberCompatibility.test.js`

Expected: PASS.

### Task 2: Own Trail Merges Coach Lessons

**Files:**
- Modify: `cloudfunctions/getHeatmap/index.js`
- Modify: `cloudfunctions/getDayDetail/index.js`
- Modify: `miniprogram/services/data.js`
- Test: `tests/coachMemberCompatibility.test.js`

**Interfaces:**
- `getHeatmap({ startKey, endKey })` returns `{ date, totalMinutes, sessionCount, personalMinutes, coachMinutes, kind, hasVerified }`.
- `getDayDetail(dateKey)` returns personal rows with `kind: 'personal'` and coach rows with `kind: 'coach'`.
- Calls with `targetOpenid` only return the target member's `training_sessions`.

- [ ] **Step 1: Add failing merge tests**

Extend `tests/coachMemberCompatibility.test.js` to assert:

```js
// own heatmap combines one 60-min training session and one 90-min coach lesson into 150 minutes, kind 'coach'
// target heatmap does not include target user's coach_lessons
// own day detail includes personal and coach rows; target day detail excludes coach rows
```

- [ ] **Step 2: Run merge test to verify RED**

Run: `node tests\coachMemberCompatibility.test.js`

Expected: FAIL because cloud `getHeatmap/getDayDetail` only read `training_sessions`.

- [ ] **Step 3: Implement cloud merge**

Update `getHeatmap` and `getDayDetail`:

- Determine `isSelf = !targetOpenid || targetOpenid === OPENID`.
- Always load `training_sessions` for `queryOpenid`.
- Only when `isSelf`, load `coach_lessons` for `coachOpenid = OPENID`.
- Merge by date for heatmap and tag detail rows with `kind`.

- [ ] **Step 4: Verify merge GREEN**

Run: `node tests\coachMemberCompatibility.test.js`

Expected: PASS.

### Task 3: Player Trail Detail Filter

**Files:**
- Modify: `miniprogram/pages/checkin/index.js`
- Modify: `miniprogram/pages/checkin/index.wxml`
- Modify: `miniprogram/pages/checkin/index.wxss`
- Test: `tests/coachMemberCompatibility.test.js`

**Interfaces:**
- Page data includes `detailFilter`, `detailFilters`, `allDetailList`, `detailList`.
- `switchDetailFilter(e)` changes filter by `e.currentTarget.dataset.filter`.
- `applyDetailFilter(list, filter)` returns filtered detail rows.

- [ ] **Step 1: Add failing UI/static tests**

Extend `tests/coachMemberCompatibility.test.js` to assert:

```js
// checkin page has detailFilters with all/personal/coach
// WXML renders filter buttons and bindtap="switchDetailFilter"
// coach rows display 教学课时 label, not only old 教练计时 copy
```

- [ ] **Step 2: Run UI test to verify RED**

Run: `node tests\coachMemberCompatibility.test.js`

Expected: FAIL because filter controls do not exist yet.

- [ ] **Step 3: Implement filter UI**

Add filter data and methods in `checkin/index.js`, filter controls in WXML, and compact segmented-control styles in WXSS.

- [ ] **Step 4: Verify UI GREEN**

Run: `node tests\coachMemberCompatibility.test.js`

Expected: PASS.

### Task 4: Regression Suite

**Files:**
- Test: all `tests/*.test.js`

- [ ] **Step 1: Run full test suite**

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
