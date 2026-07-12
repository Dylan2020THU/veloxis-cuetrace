# Account Auth Missing Document Fix Design

## Problem

`wx-server-sdk@2.6.3` defaults `throwOnNotFound` to `true`. `accountAuth` assumes `doc().get()` returns `{ data: null }` for an absent document, so a first registration or an unknown-account login is converted into `AUTH_INTERNAL_ERROR`. The local database fake returns `null` and therefore hides the production behavior.

The observed document ID is exactly `sha256("account:zhx1")`, proving the failure occurs while loading the absent `zhx1` account document.

## Approaches

1. **Configure the database with `throwOnNotFound: false` (selected).** This uses the SDK's supported behavior, preserves genuine read failures, and fixes every existing `getOptional` call with one production change.
2. Catch and classify the SDK error inside `getOptional`. This depends on error-message or error-code compatibility and is easier to get wrong across SDK versions.
3. Replace document reads with collection queries. This changes more code, complicates transaction paths, and provides no benefit for deterministic document IDs.

## Design

- Initialize the `accountAuth` database with `{ throwOnNotFound: false }`.
- Change the test database fake so an absent document throws unless that option is explicitly disabled, matching the installed SDK.
- Keep all existing authentication results unchanged: an unknown account remains `INVALID_CREDENTIALS`; registration may create its three deterministic documents; genuine database errors remain `AUTH_INTERNAL_ERROR`.
- Do not migrate legacy local accounts, alter database collections, or touch developer-tool generated files.

## Verification

1. RED: the realistic fake makes the existing first-registration path fail before the production change.
2. GREEN: `node tests/accountWechatBinding.test.js` passes after the database option is added.
3. Final: the repository verification script passes, with no changes to `project.config.json`, `package-lock.json`, or `node_modules` from this task.
