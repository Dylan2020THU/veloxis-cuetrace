# Account Deletion Grace Period Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deletion-reason survey and replace immediate account deletion with a 7-day cancelable deletion flow.

**Architecture:** The settings page collects a reason and submits a deletion request. `deleteAccount` marks the user as pending deletion instead of removing data. `login` cancels pending deletion if the user returns within 7 days; a scheduled purge cloud function removes data after the grace period.

**Tech Stack:** WeChat Mini Program JS, WeChat Cloud Functions, existing static Node tests.

---

### Task 1: Red Test

**Files:**
- Create: `tests/accountDeletionGracePeriod.test.js`

- [ ] Write a static test that verifies settings collects a reason, `deleteAccount` stores pending deletion fields, `login` cancels pending deletion, and a scheduled purge function exists.
- [ ] Run `node tests/accountDeletionGracePeriod.test.js`; expected result is FAIL before implementation.

### Task 2: Client Flow

**Files:**
- Modify: `miniprogram/pages/settings/index.js`
- Modify: `miniprogram/services/data.js`

- [ ] Replace the immediate delete confirmation with `wx.showActionSheet` reason collection.
- [ ] Call `data.deleteAccount({ reason })`.
- [ ] In mock mode, store a pending deletion request with `deletionScheduledAt`.
- [ ] In cloud mode, surface `deletionCanceled` toast when login cancels a pending deletion.

### Task 3: Cloud Data Flow

**Files:**
- Modify: `cloudfunctions/deleteAccount/index.js`
- Modify: `cloudfunctions/login/index.js`
- Create: `cloudfunctions/purgeDeletedAccounts/index.js`
- Create: `cloudfunctions/purgeDeletedAccounts/package.json`
- Create: `cloudfunctions/purgeDeletedAccounts/config.json`

- [ ] Change `deleteAccount` to mark `users.deletionStatus = 'pending'` and record reason.
- [ ] Change `login` to cancel pending deletion within 7 days.
- [ ] Add scheduled purge to remove records after `deletionScheduledAt`.

### Task 4: Verification

- [ ] Run `node tests/accountDeletionGracePeriod.test.js`.
- [ ] Run existing static tests touched by settings/login/data.
- [ ] Run `node --check` on changed JS files.
