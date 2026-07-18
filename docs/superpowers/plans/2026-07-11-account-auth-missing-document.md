# Account Auth Missing Document Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make missing account and binding documents follow normal authentication outcomes instead of becoming `AUTH_INTERNAL_ERROR`.

**Architecture:** Configure the existing `wx-server-sdk` database instance to return `{ data: null }` for absent deterministic documents. Update the test database fake to reproduce the SDK's default throw behavior unless the production option is explicitly supplied.

**Tech Stack:** Node.js 16, `wx-server-sdk@2.6.3`, JavaScript, built-in `assert` test harness

## Global Constraints

- Do not migrate legacy local accounts or mutate cloud data.
- Do not touch `project.config.json`, `cloudfunctions/accountAuth/package-lock.json`, or `cloudfunctions/accountAuth/node_modules/`.
- Preserve genuine database failures as `AUTH_INTERNAL_ERROR`.
- Do not delete files.

---

### Task 1: Match Real Missing-Document Semantics and Fix Database Configuration

**Files:**
- Modify: `tests/accountWechatBinding.test.js:59-89,167-175`
- Modify: `cloudfunctions/accountAuth/index.js:6`

**Interfaces:**
- Consumes: `cloud.database(options)` and `DocumentReference.get()` from `wx-server-sdk@2.6.3`.
- Produces: absent documents resolve as `{ data: null }`; all other SDK errors still reject.

- [ ] **Step 1: Make the fake reproduce the SDK default**

Change the fake database root and document read to:

```javascript
function makeDatabase(state, options) {
  const root = {
    failNextRead: false,
    failNextWrite: false,
    throwOnNotFound: !options || options.throwOnNotFound !== false
  };

  // inside doc(id).get()
  async get() {
    maybeFailRead();
    const document = findById(documents, id);
    if (!document && root.throwOnNotFound) {
      throw new Error(`document with _id ${id} does not exist`);
    }
    return { data: clone(document || null) };
  }
```

Change `loadAccountAuth` so the fake observes the production database options:

```javascript
function loadAccountAuth(openid, seed, unionid) {
  const state = makeState(seed);
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database(options) {
      fakeDb = makeDatabase(state, options);
      return fakeDb;
    },
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node tests/accountWechatBinding.test.js`

Expected: FAIL before reaching a successful first registration because the production module calls `cloud.database()` without disabling missing-document exceptions.

- [ ] **Step 3: Apply the minimal production fix**

Change the database initialization to:

```javascript
const db = cloud.database({ throwOnNotFound: false });
```

- [ ] **Step 4: Run focused verification and verify GREEN**

Run: `node tests/accountWechatBinding.test.js`

Expected: `accountWechatBinding tests passed` with exit code 0. Existing read-failure and transaction-rollback assertions must continue to pass.

- [ ] **Step 5: Run final repository verification**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/codex-verify.ps1`

Expected: `TESTS_FAILED=0`, `JS_FAILED=0`, `TEXT_ERRORS=0`, and `STATUS=PASS`.

- [ ] **Step 6: Commit only the repair**

```powershell
git add cloudfunctions/accountAuth/index.js tests/accountWechatBinding.test.js docs/superpowers/plans/2026-07-11-account-auth-missing-document.md
git commit -m "fix: handle missing account documents"
```
