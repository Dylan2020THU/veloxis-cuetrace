# 账号先行登录 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将登录页从“先选身份再登录”改为“先账号登录/注册，成功后再选择可用身份”。

**Architecture:** 登录页保留一个 Page，通过 `step: 'auth' | 'role'` 切换账号表单和身份选择。账号验证成功只进入身份选择，不调用 `data.login`；用户选择身份后再调用现有 `doLogin(role, loginName, roles)` 落地到对应端口。

**Tech Stack:** 微信小程序 WXML/WXSS/Page JS，Node.js `assert` 测试。

## Global Constraints

- 不新增身份类型。
- 注册新账号默认 `roles: ['member']`。
- 教练账号可选球员/教练。
- 管理员 `admin_zhx` 可选球员/教练/店主。
- 普通店主继续走资质审核网关，管理员店主继续绕过审核。

---

### Task 1: 登录页账号验证后再选身份

**Files:**
- Modify: `tests/loginMethods.test.js`
- Modify: `miniprogram/pages/login/index.js`

**Steps:**

- [ ] 写失败测试：初始 `step` 应为 `auth`；账号密码通过后只设置 `pendingAccount/pendingRoles/step='role'`，不立即调用 `data.login`。
- [ ] 运行 `node tests/loginMethods.test.js`，确认失败。
- [ ] 实现 `showRolePicker(account, roles)` 和 `chooseRole(e)`；`submit()` 与 `bindWechat()` 验证账号后调用 `showRolePicker()`。
- [ ] 重跑 `node tests/loginMethods.test.js`，确认通过。

### Task 2: 注册默认球员账号

**Files:**
- Modify: `tests/registerAccountRules.test.js`
- Modify: `miniprogram/pages/login/index.js`

**Steps:**

- [ ] 写失败测试：注册时不依赖当前身份，新账号保存为 `role: 'member'`、`roles: ['member']`。
- [ ] 运行 `node tests/registerAccountRules.test.js`，确认失败。
- [ ] 修改 `register()` 默认写入球员基础账号。
- [ ] 重跑 `node tests/registerAccountRules.test.js`，确认通过。

### Task 3: 页面结构与展示身份过滤

**Files:**
- Modify: `tests/loginMethods.test.js`
- Modify: `miniprogram/pages/login/index.wxml`
- Modify: `miniprogram/pages/login/index.wxss`

**Steps:**

- [ ] 写失败测试：WXML 初始账号表单在 `step === 'auth'`，身份选择在 `step === 'role'`，身份列表使用 `availableRoles`。
- [ ] 修改 WXML/WXSS 文案和条件渲染。
- [ ] 重跑聚焦测试。

### Task 4: 全量验证

**Steps:**

- [ ] 运行 `node tests/loginMethods.test.js`。
- [ ] 运行 `node tests/registerAccountRules.test.js`。
- [ ] 运行全量 `tests/*.test.js`。
