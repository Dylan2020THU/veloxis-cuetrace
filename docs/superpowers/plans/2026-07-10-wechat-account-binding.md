# 微信账号 1:1 绑定 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前本地伪微信绑定替换为云端可信的业务账号、密码验证和 `OPENID ↔ account` 严格双向 1:1 绑定，并关闭客户端角色扩权与 mock 假登录。

**Architecture:** 新增单一 `accountAuth` 云函数集中负责注册、密码验证、微信免密、绑定状态与无副作用探针；`accounts` 和 `wechat_bindings` 使用确定性文档 ID，并在数据库事务中同时检查和写入。现有 `login` 只消费服务端 `users.roles` 完成本次角色选择，小程序登录页和账号安全页只读取云端认证结果。

**Tech Stack:** 微信小程序原生 JavaScript/WXML、微信云开发、`wx-server-sdk ~2.6.3`、CloudBase 文档数据库事务、Node.js `crypto.scryptSync`/`timingSafeEqual`、Node `assert` 测试脚本。

## Global Constraints

- 严格保证一个微信 `OPENID` 只绑定一个业务账号，一个业务账号只绑定一个 `OPENID`。
- 当前无生产数据；不迁移本地 `dc_accounts` 或 `dc_wechat_bindings`。
- 不保存、记录或返回明文密码；密码格式为 `scrypt-v1` + 随机盐。
- 微信身份只使用 `cloud.getWXContext()`，禁止接受客户端 `openid`。
- 客户端不得授予 `roles`，普通登录不得创建管理员。
- 云服务不可用或数据库异常时认证失败关闭，禁止 mock 登录成功。
- 不实现解绑、换绑、密码找回、多微信账号或自建 JWT。
- 保持当前登录页视觉布局，不做无关重构。
- 不删除任何仓库文件；如发现确需删除，必须等待张总授权。
- 每个任务只修改列出的范围，并在提交前执行对应聚焦测试。

---

## File Map

### New files

- `cloudfunctions/accountAuth/index.js`：账号凭据、微信绑定、免密恢复、状态查询和健康探针。
- `cloudfunctions/accountAuth/package.json`：云函数依赖声明。
- `tests/accountWechatBinding.test.js`：云端账号与双向绑定状态机测试。

### Core modified files

- `cloudfunctions/login/index.js`：只按绑定和服务端角色登录，关闭客户端扩权与管理员旁路。
- `cloudfunctions/verifySmsCode/index.js`：短信验证只更新已绑定账号，不创建孤立用户。
- `cloudfunctions/saveUserProfile/index.js`：禁止通过资料保存切换到未授权角色。
- `cloudfunctions/adminLogin/index.js`：管理员账号与 OPENID 同样执行双向唯一检查。
- `miniprogram/services/data.js`：新增云端账号认证 API，认证失败不走 mock。
- `miniprogram/app.js`：使用无副作用 `accountAuth.probe` 探测云环境。
- `miniprogram/pages/login/index.js`：移除本地账号鉴权，接入注册、密码、微信和短信云端流程。
- `miniprogram/pages/login/index.wxml`：只调整绑定/注册状态文案，不改布局。
- `miniprogram/pages/settings/account-security/index.js`：显示真实云端安全状态。
- `cloudfunctions/reviewShopApplication/index.js`：审批通过时确保用户角色账本存在。
- `cloudfunctions/saveShopProfile/index.js`：仅在服务端批准后保持 shop 角色。
- `cloudfunctions/addShopCoach/index.js`：只关联已经拥有 coach 角色的用户。
- `project.config.json`：恢复项目实际 AppID。
- `README.md`：记录集合、权限和云函数部署要求。

### Modified tests

- `tests/loginMethods.test.js`
- `tests/registerAccountRules.test.js`
- `tests/smsLogin.test.js`
- `tests/coachMemberCompatibility.test.js`
- `tests/adminVisibility.test.js`
- `tests/adminPortal.test.js`
- `tests/saveUserProfile.test.js`
- `tests/shopQualificationApply.test.js`
- `tests/becomeCoachApplication.test.js`

---

### Task 1: 云端账号与微信绑定状态机

**Files:**
- Create: `cloudfunctions/accountAuth/index.js`
- Create: `cloudfunctions/accountAuth/package.json`
- Create: `tests/accountWechatBinding.test.js`

**Interfaces:**
- Consumes: `cloud.getWXContext() -> { OPENID, UNIONID? }`、CloudBase `db.runTransaction(callback)`。
- Produces: `accountAuth.main(event)`，支持 `probe|register|passwordLogin|wechatLogin|status`；成功统一返回 `{ ok:true, account, roles, currentRole, wechatBound }`，失败返回 `{ ok:false, code, msg }`。
- Produces document IDs: `accountId(account)=sha256('account:'+account.toLowerCase())`、`bindingId(openid)=sha256('wechat:'+openid)`。

- [ ] **Step 1: 写注册、哈希、免密与双向冲突失败测试**

在 `tests/accountWechatBinding.test.js` 中使用 `Module._load` 注入内存 `fakeCloud`。内存数据库必须支持 `collection().doc().get/set/update`、`where().get`、`add` 和 `runTransaction`；事务回调失败时不得提交工作副本。

测试入口与核心断言必须使用以下接口：

```js
const first = await loadAccountAuth('wechat_A', seed).main({
  action: 'register',
  account: 'MemberA',
  password: '123456'
});
assert.strictEqual(first.ok, true);
assert.strictEqual(first.account, 'MemberA');
assert.deepStrictEqual(first.roles, ['member']);
assert.strictEqual(first.wechatBound, true);

const accountDoc = findById(state.accounts, sha256('account:membera'));
assert(accountDoc.passwordHash);
assert(accountDoc.passwordSalt);
assert.strictEqual(accountDoc.password, undefined);
assert.notStrictEqual(accountDoc.passwordHash, '123456');

const resumed = await loadAccountAuth('wechat_A', state).main({ action: 'wechatLogin' });
assert.strictEqual(resumed.ok, true);
assert.strictEqual(resumed.account, 'MemberA');

const wrongPassword = await loadAccountAuth('wechat_A', state).main({
  action: 'passwordLogin', account: 'MemberA', password: 'bad-password'
});
assert.strictEqual(wrongPassword.code, 'INVALID_CREDENTIALS');

const secondWechat = await loadAccountAuth('wechat_B', state).main({
  action: 'passwordLogin', account: 'MemberA', password: '123456'
});
assert.strictEqual(secondWechat.code, 'ACCOUNT_ALREADY_BOUND');

const secondAccount = await loadAccountAuth('wechat_A', state).main({
  action: 'register', account: 'MemberB', password: '123456'
});
assert.strictEqual(secondAccount.code, 'WECHAT_ALREADY_BOUND');

const unknownWechat = await loadAccountAuth('wechat_C', state).main({ action: 'wechatLogin' });
assert.strictEqual(unknownWechat.code, 'WECHAT_NOT_BOUND');
assert.deepStrictEqual(snapshot(state), beforeUnknownLogin);
```

- [ ] **Step 2: 写无副作用探针、保留账号和事务回滚测试**

```js
const probeBefore = snapshot(state);
assert.deepStrictEqual(
  await loadAccountAuth('wechat_probe', state).main({ action: 'probe' }),
  { ok: true, cloudReady: true }
);
assert.deepStrictEqual(snapshot(state), probeBefore);

const reserved = await loadAccountAuth('wechat_X', state).main({
  action: 'register', account: 'admin_zhx', password: '123456'
});
assert.strictEqual(reserved.code, 'INVALID_INPUT');

fakeDb.failNextWrite = true;
const rolledBack = await loadAccountAuth('wechat_D', state).main({
  action: 'register', account: 'MemberD', password: '123456'
});
assert.strictEqual(rolledBack.code, 'AUTH_INTERNAL_ERROR');
assert.strictEqual(findAccount(state, 'MemberD'), undefined);
assert.strictEqual(findBinding(state, 'wechat_D'), undefined);
```

- [ ] **Step 3: 运行测试确认失败**

Run: `node tests/accountWechatBinding.test.js`

Expected: FAIL，原因是 `cloudfunctions/accountAuth/index.js` 不存在。

- [ ] **Step 4: 实现确定性 ID、密码哈希与安全响应**

`cloudfunctions/accountAuth/index.js` 必须包含以下纯函数和常量：

```js
const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const ACCOUNT_RE = /^[A-Za-z][A-Za-z0-9_]{3,19}$/;
const RESERVED_ACCOUNTS = ['admin_zhx'];

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}
function normalizeAccount(value) {
  return String(value || '').trim().toLowerCase();
}
function accountId(account) {
  return sha256(`account:${normalizeAccount(account)}`);
}
function bindingId(openid) {
  return sha256(`wechat:${openid}`);
}
function hashPassword(password, salt) {
  return crypto.scryptSync(password, Buffer.from(salt, 'hex'), 64).toString('hex');
}
function verifyPassword(password, account) {
  const actual = Buffer.from(hashPassword(password, account.passwordSalt), 'hex');
  const expected = Buffer.from(account.passwordHash || '', 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function fail(code, msg) { return { ok: false, code, msg }; }
function authError(code) {
  const error = new Error(code);
  error.authCode = code;
  return error;
}
async function getOptional(ref) {
  try {
    const result = await ref.get();
    return result && result.data ? result.data : null;
  } catch (e) {
    return null;
  }
}
function normalizeServerRoles(user) {
  const source = Array.isArray(user && user.roles) ? user.roles : [];
  const roles = source.filter((role) => ['member', 'coach', 'shop'].indexOf(role) !== -1);
  return Array.from(new Set(roles.length ? roles : ['member']));
}
function validateRegistration(account, password) {
  const display = String(account || '').trim();
  const normalized = normalizeAccount(display);
  if (!ACCOUNT_RE.test(display) || RESERVED_ACCOUNTS.indexOf(normalized) !== -1) {
    return fail('INVALID_INPUT', '账号格式不正确或为保留账号');
  }
  if (typeof password !== 'string' || password.length < 6) {
    return fail('INVALID_INPUT', '密码至少 6 位');
  }
  return null;
}
```

账号响应必须只投影以下安全字段：

```js
function authResult(account, user) {
  const roles = normalizeServerRoles(user);
  return {
    ok: true,
    account: account.account,
    roles,
    currentRole: user.currentRole || user.role || roles[0],
    wechatBound: true
  };
}
```

- [ ] **Step 5: 实现 `probe/register/passwordLogin/wechatLogin/status`**

注册事务使用三个确定性文档，并在同一事务检查两端冲突：

```js
const normalized = normalizeAccount(event.account);
const displayAccount = String(event.account || '').trim();
const accountDocId = accountId(normalized);
const bindingDocId = bindingId(OPENID);
return db.runTransaction(async (transaction) => {
  const accountRef = transaction.collection('accounts').doc(accountDocId);
  const bindingRef = transaction.collection('wechat_bindings').doc(bindingDocId);
  const userRef = transaction.collection('users').doc(bindingDocId);
  const existingAccount = await getOptional(accountRef);
  const existingBinding = await getOptional(bindingRef);
  if (existingAccount) throw authError('ACCOUNT_EXISTS');
  if (existingBinding) throw authError('WECHAT_ALREADY_BOUND');
  const salt = crypto.randomBytes(16).toString('hex');
  const accountData = {
    _id: accountDocId, _openid: OPENID, account: displayAccount,
    accountNormalized: normalized, passwordAlgorithm: 'scrypt-v1',
    passwordSalt: salt, passwordHash: hashPassword(event.password, salt),
    status: 'active', createdAt: db.serverDate(), updatedAt: db.serverDate(),
    boundAt: db.serverDate()
  };
  const bindingData = {
    _id: bindingDocId, _openid: OPENID, accountId: accountDocId,
    account: displayAccount,
    unionidHash: UNIONID ? sha256(`unionid:${UNIONID}`) : '',
    boundAt: db.serverDate(), updatedAt: db.serverDate()
  };
  const defaultMemberData = {
    _id: bindingDocId, _openid: OPENID, roles: ['member'],
    currentRole: 'member', role: 'member', nickname: '', avatar: '',
    createdAt: db.serverDate(), updatedAt: db.serverDate()
  };
  await accountRef.set({ data: accountData });
  await bindingRef.set({ data: bindingData });
  await userRef.set({ data: defaultMemberData });
  return authResult(accountData, defaultMemberData);
});
```

`passwordLogin` 必须先统一返回 `INVALID_CREDENTIALS`，再检查 `accounts._openid` 与 `wechat_bindings.accountId` 是否互相一致；`wechatLogin/status` 只能从 `bindingId(OPENID)` 开始解析，不能按客户端账号猜测绑定。

`main` 必须区分可预期认证冲突与内部错误：

```js
try {
  return await handlers[action](event, { OPENID, UNIONID });
} catch (error) {
  if (error && error.authCode) return fail(error.authCode, messageFor(error.authCode));
  console.error('accountAuth failed', error);
  return fail('AUTH_INTERNAL_ERROR', '认证服务异常，请稍后重试');
}
```

`status` 在安全投影基础上额外返回 `passwordSet: true` 与对应 `users.phone || ''`；不得返回 `passwordHash/passwordSalt/_openid/unionidHash`。

- [ ] **Step 6: 添加云函数依赖声明**

`cloudfunctions/accountAuth/package.json`：

```json
{
  "name": "accountAuth",
  "version": "1.0.0",
  "main": "index.js",
  "dependencies": {
    "wx-server-sdk": "~2.6.3"
  }
}
```

- [ ] **Step 7: 运行聚焦测试确认通过**

Run: `node tests/accountWechatBinding.test.js`

Expected: PASS，exit code 0。

- [ ] **Step 8: 提交**

```powershell
git add cloudfunctions/accountAuth/index.js cloudfunctions/accountAuth/package.json tests/accountWechatBinding.test.js
git commit -m "feat: add cloud wechat account binding"
```

---

### Task 2: 服务端角色授权与管理员旁路收口

**Files:**
- Modify: `cloudfunctions/login/index.js:7-137`
- Modify: `cloudfunctions/saveUserProfile/index.js:16-49`
- Modify: `cloudfunctions/adminLogin/index.js:6-25`
- Modify: `tests/coachMemberCompatibility.test.js:218-293`
- Modify: `tests/adminVisibility.test.js:138-197`
- Modify: `tests/adminPortal.test.js:91-137`
- Modify: `tests/saveUserProfile.test.js:1-280`

**Interfaces:**
- Consumes: `wechat_bindings/{bindingId}`、`accounts/{accountId}`、`users` 服务端角色。
- Produces: `login.main({ role })`；不再支持客户端 `roles/loginName` 授权。
- Produces: `saveUserProfile.main({ role, ...profile })` 仅允许已有角色。

- [ ] **Step 1: 反转客户端角色扩权测试**

将旧的“客户端传入 coach roles 后成功”断言替换为：

```js
const res = await login.main({
  role: 'coach',
  roles: ['member', 'coach', 'shop'],
  loginName: 'admin_zhx'
});
assert.strictEqual(res.ok, false);
assert.strictEqual(res.code, 'ROLE_NOT_ALLOWED');
assert.deepStrictEqual(state.users[0].roles, ['member']);
assert.deepStrictEqual(state.admins || [], []);
```

新增允许服务端已有 coach 角色进入的断言：

```js
state.users[0].roles = ['member', 'coach'];
const allowed = await login.main({ role: 'coach' });
assert.strictEqual(allowed.role, 'coach');
assert.deepStrictEqual(allowed.roles, ['member', 'coach']);
```

- [ ] **Step 2: 写资料保存和管理员双向冲突测试**

```js
const profileDenied = await saveUserProfile.main({ role: 'shop', nickname: 'Member' });
assert.strictEqual(profileDenied.ok, false);
assert.strictEqual(profileDenied.code, 'ROLE_NOT_ALLOWED');

const validAdminPassword = require('../miniprogram/utils/adminAuth').ADMIN_ACCOUNTS[0].password;
const adminOtherWechat = await adminLogin.main({ account: 'admin_zhx', password: validAdminPassword });
assert.strictEqual(adminOtherWechat.code, 'ACCOUNT_ALREADY_BOUND');
```

- [ ] **Step 3: 运行聚焦测试确认失败**

Run: `node tests/coachMemberCompatibility.test.js`

Run: `node tests/adminVisibility.test.js`

Run: `node tests/adminPortal.test.js`

Run: `node tests/saveUserProfile.test.js`

Expected: 至少客户端角色扩权和普通登录播种管理员的断言 FAIL。

- [ ] **Step 4: 重写 `login` 的授权边界**

保留账号注销恢复逻辑，但删除 `requestedRoles`、`mergeRoles` 和 `ensureAdminAccount`。核心流程固定为：

```js
const crypto = require('crypto');
function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}
function bindingId(openid) { return sha256(`wechat:${openid}`); }
function fail(code, msg) { return { ok: false, code, msg }; }
function normalizeServerRoles(user) {
  const source = Array.isArray(user && user.roles) ? user.roles : [];
  const roles = source.filter((role) => VALID_ROLES.indexOf(role) !== -1);
  if (roles.length) return Array.from(new Set(roles));
  if (user && user.role === 'coach') return ['member', 'coach'];
  if (user && user.role === 'shop') return ['shop'];
  return ['member'];
}
async function getBindingByOpenid(openid) {
  const result = await db.collection('wechat_bindings').doc(bindingId(openid)).get().catch(() => null);
  return result && result.data ? result.data : null;
}
function safeUserResult(user, roles, currentRole, binding) {
  return {
    openid: user._openid, account: binding.account,
    role: currentRole, roles, currentRole,
    nickname: user.nickname || '', avatar: user.avatar || ''
  };
}
const { OPENID } = cloud.getWXContext();
const requestedRole = VALID_ROLES.includes(event.role) ? event.role : 'member';
const binding = await getBindingByOpenid(OPENID);
if (!binding) return fail('ACCOUNT_NOT_BOUND', '请先登录或注册账号');
const userRes = await users.where({ _openid: OPENID }).limit(1).get();
if (!userRes.data.length) return fail('ACCOUNT_NOT_BOUND', '账号资料不存在');
const user = userRes.data[0];
const roles = normalizeServerRoles(user);
if (!roles.includes(requestedRole)) return fail('ROLE_NOT_ALLOWED', '该账号未开通此身份');
await users.doc(user._id).update({
  data: { currentRole: requestedRole, role: requestedRole, updatedAt: db.serverDate() }
});
return safeUserResult(user, roles, requestedRole, binding);
```

- [ ] **Step 5: 限制资料保存角色并收紧管理员绑定**

`saveUserProfile` 在构造 profile 前执行：

```js
const roles = normalizeRoles(current.role, current.roles);
const requestedRole = event.role || current.currentRole || current.role || roles[0];
if (roles.indexOf(requestedRole) === -1) {
  return { ok: false, code: 'ROLE_NOT_ALLOWED', msg: '该账号未开通此身份' };
}
```

`adminLogin` 在写入前分别检查：

```js
const byAccount = await admins.where({ account, status: 'active' }).get();
if (byAccount.data.some((item) => item._openid !== OPENID)) {
  return fail('ACCOUNT_ALREADY_BOUND', '管理员账号已绑定其他微信');
}
const byOpenid = await admins.where({ _openid: OPENID, status: 'active' }).get();
if (byOpenid.data.some((item) => item.account !== account)) {
  return fail('WECHAT_ALREADY_BOUND', '当前微信已绑定其他管理员账号');
}
```

- [ ] **Step 6: 运行聚焦测试确认通过**

Run: `node tests/coachMemberCompatibility.test.js`

Run: `node tests/adminVisibility.test.js`

Run: `node tests/adminPortal.test.js`

Run: `node tests/saveUserProfile.test.js`

Expected: 全部 PASS。

- [ ] **Step 7: 提交**

```powershell
git add cloudfunctions/login/index.js cloudfunctions/saveUserProfile/index.js cloudfunctions/adminLogin/index.js tests/coachMemberCompatibility.test.js tests/adminVisibility.test.js tests/adminPortal.test.js tests/saveUserProfile.test.js
git commit -m "fix: enforce server-side login roles"
```

---

### Task 3: 小程序认证服务与无副作用云探针

**Files:**
- Modify: `miniprogram/services/data.js:10-41,190-251,2470-2510`
- Modify: `miniprogram/app.js:8-59`
- Test: `tests/accountWechatBinding.test.js`
- Test: `tests/loginMethods.test.js`

**Interfaces:**
- Consumes: `accountAuth.main({ action, ...payload })`。
- Produces: `registerAccount`、`loginWithPassword`、`loginWithWechat`、`getAccountSecurity`、`probeAuthCloud`。
- Produces: `login(role)` 只发送 `{ role }`。
- Produces: 认证成功后只把 `account/roles/currentRole` 写入 `globalData` 和非敏感展示缓存，不把本地缓存当作后续鉴权依据。

- [ ] **Step 1: 写数据服务失败关闭与探针测试**

```js
const calls = [];
global.wx.cloud.callFunction = ({ name, data }) => {
  calls.push({ name, data });
  return Promise.resolve({ result: { ok: true, cloudReady: true } });
};
await data.probeAuthCloud();
assert.deepStrictEqual(calls[0], { name: 'accountAuth', data: { action: 'probe' } });

getApp().globalData.cloudReady = false;
await assert.rejects(
  () => data.loginWithWechat(),
  (err) => err.code === 'CLOUD_NOT_READY'
);
assert.strictEqual(getApp().globalData.openid || '', '');
```

同时断言 `data.login('coach')` 只发送：

```js
assert.deepStrictEqual(calls[calls.length - 1], {
  name: 'login',
  data: { role: 'coach' }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tests/accountWechatBinding.test.js`

Run: `node tests/loginMethods.test.js`

Expected: FAIL，缺少新的 data service 方法，且旧 `login` 仍发送 roles/loginName 或回退 mock。

- [ ] **Step 3: 实现统一认证调用与错误转换**

```js
function cloudAuth(action, payload) {
  if (!cloudReady()) {
    return Promise.reject(Object.assign(new Error('云服务未连接，无法登录'), {
      code: 'CLOUD_NOT_READY'
    }));
  }
  return callCloud('accountAuth', Object.assign({ action }, payload || {})).then((result) => {
    if (result && result.ok === false) {
      const error = new Error(result.msg || '认证失败');
      error.code = result.code || 'AUTH_FAILED';
      error.result = result;
      throw error;
    }
    return result;
  });
}
function registerAccount(input) { return cloudAuth('register', input); }
function loginWithPassword(input) { return cloudAuth('passwordLogin', input); }
function loginWithWechat() { return cloudAuth('wechatLogin'); }
function getAccountSecurity() { return cloudAuth('status'); }
function probeAuthCloud() {
  if (!wx.cloud) return Promise.reject(Object.assign(new Error('云服务不可用'), { code: 'CLOUD_NOT_READY' }));
  return callCloud('accountAuth', { action: 'probe' });
}
```

所有非 probe 认证成功结果经过同一个状态同步函数：

```js
function applyAuthResult(result) {
  const app = typeof getApp === 'function' ? getApp() : null;
  if (!app || !app.globalData || !result) return result;
  app.globalData.account = result.account || '';
  app.globalData.roles = Array.isArray(result.roles) ? result.roles.slice() : ['member'];
  app.globalData.currentRole = result.currentRole || app.globalData.roles[0] || 'member';
  try { wx.setStorageSync('dc_account_name', app.globalData.account); } catch (e) {}
  return result;
}
```

`registerAccount/loginWithPassword/loginWithWechat/getAccountSecurity` 的 Promise 成功分支调用 `applyAuthResult`；`dc_account_name` 只能用于展示，服务端调用不得读取它来判断身份。

同时在 `app.globalData` 增加 `account: ''`，用于当前运行时展示和身份切换；它不替代云端绑定校验。

`login` 改为 `function login(role)`，云可用时只调用 `callCloud('login', { role })`，云不可用直接拒绝。

- [ ] **Step 4: 将启动探针改为 `accountAuth.probe`**

```js
wx.cloud.callFunction({ name: 'accountAuth', data: { action: 'probe' } })
  .then((res) => {
    if (!res.result || res.result.ok !== true) throw new Error('AUTH_PROBE_FAILED');
    this.globalData.cloudReady = true;
    this.refreshBilling();
  })
  .catch((e) => {
    this.globalData.cloudReady = false;
    console.warn('[CueTrace] 认证云服务探测失败', e);
  });
```

- [ ] **Step 5: 导出新接口并运行测试**

Run: `node tests/accountWechatBinding.test.js`

Run: `node tests/loginMethods.test.js`

Expected: PASS。

- [ ] **Step 6: 提交**

```powershell
git add miniprogram/services/data.js miniprogram/app.js tests/accountWechatBinding.test.js tests/loginMethods.test.js
git commit -m "feat: connect mini program cloud authentication"
```

---

### Task 4: 登录页真实注册、账号登录与微信免密

**Files:**
- Modify: `miniprogram/pages/login/index.js:12-18,123-221,329-440,494-597`
- Modify: `miniprogram/pages/login/index.wxml:7,145-241`
- Modify: `tests/loginMethods.test.js`
- Modify: `tests/registerAccountRules.test.js`

**Interfaces:**
- Consumes: Task 3 的 `data.registerAccount/loginWithPassword/loginWithWechat/login(role)`。
- Produces: `showRolePicker(account, roles)` 只使用服务端响应；`wechatLogin()` 支持已绑定免密和未绑定引导。

- [ ] **Step 1: 写微信免密、注册直达与本地缓存无关测试**

```js
const page = loadLoginPage([], {
  loginWithWechat() {
    return Promise.resolve({ account: 'memberA', roles: ['member'], currentRole: 'member' });
  },
  registerAccount() {
    return Promise.resolve({ account: 'memberA', roles: ['member'], currentRole: 'member' });
  }
});

page.wechatLogin();
await flushPromises();
assert.strictEqual(page.data.step, 'role');
assert.strictEqual(page.data.pendingAccount, 'memberA');
assert.deepStrictEqual(page.data.pendingRoles, ['member']);

page.setData({ regAccount: 'memberA', regPassword: '123456', regConfirm: '123456', agreementChecked: true });
page.register();
await flushPromises();
assert.strictEqual(page.data.step, 'role');
```

未绑定分支：

```js
const notBound = Object.assign(new Error('未绑定'), { code: 'WECHAT_NOT_BOUND' });
fakeData.loginWithWechat = () => Promise.reject(notBound);
page.wechatLogin();
await flushPromises();
assert.strictEqual(page.data.mode, 'wechatBind');
assert.strictEqual(page.data.step, 'auth');
```

测试中的 `wx.getStorageSync('dc_accounts')` 返回任意伪造数据，都不得改变服务端返回账号或角色。

- [ ] **Step 2: 写云失败和密码登录测试**

```js
fakeData.loginWithPassword = () => Promise.reject(Object.assign(new Error('云服务未连接'), {
  code: 'CLOUD_NOT_READY'
}));
page.setData({ account: 'memberA', password: '123456', agreementChecked: true, loginType: 'password' });
page.submit();
await flushPromises();
assert.strictEqual(page.data.step, 'auth');
assert.strictEqual(calls.switchTab.length + calls.reLaunch.length, 0);
assert(toasts.some((item) => item.title.includes('云服务')));
```

- [ ] **Step 3: 运行测试确认失败**

Run: `node tests/loginMethods.test.js`

Run: `node tests/registerAccountRules.test.js`

Expected: FAIL，旧页面仍使用 `findRegisteredAccount`、本地明文密码和本地绑定标记。

- [ ] **Step 4: 移除本地认证源并实现统一成功处理**

删除页面对 `ACCOUNTS_KEY`、`WECHAT_BINDINGS_KEY`、`readRegisteredAccounts`、`findRegisteredAccount`、`saveWechatBinding` 的鉴权依赖；不要删除文件。

新增：

```js
handleAuthenticated(result) {
  const account = (result && result.account) || '';
  const roles = (result && Array.isArray(result.roles) && result.roles.length)
    ? result.roles
    : ['member'];
  try {
    wx.removeStorageSync('dc_accounts');
    wx.removeStorageSync('dc_wechat_bindings');
  } catch (e) {}
  this.showRolePicker(account, roles);
},
handleAuthError(error, fallback) {
  wx.hideLoading();
  wx.showToast({ title: (error && error.message) || fallback, icon: 'none' });
}
```

- [ ] **Step 5: 实现账号、注册与微信动作**

```js
wechatLogin() {
  if (!this.ensureAgreementChecked()) return;
  wx.showLoading({ title: '登录中', mask: true });
  data.loginWithWechat()
    .then((result) => { wx.hideLoading(); this.handleAuthenticated(result); })
    .catch((error) => {
      wx.hideLoading();
      if (error && error.code === 'WECHAT_NOT_BOUND') {
        this.setData({ mode: 'wechatBind', loginType: 'password', password: '', code: '' });
        return;
      }
      this.handleAuthError(error, '微信登录失败');
    });
},
```

`submit()` 的密码分支调用 `data.loginWithPassword({ account, password })`；`bindWechat()` 的密码分支复用同一接口；`register()` 调用 `data.registerAccount({ account, password })`，成功后直接 `handleAuthenticated(result)`。

`currentSessionRoles/openSwitchRolePicker` 删除本地注册账号优先级，只使用 `globalData.account/globalData.roles`；若运行时缺失则调用 `data.getAccountSecurity()` 刷新，不得从 `dc_accounts` 恢复权限。

- [ ] **Step 6: 身份选择只发送角色**

```js
enterSelectedRole() {
  const { role, pendingRoles } = this.data;
  if (pendingRoles.indexOf(role) === -1) return this.promptOpenRole(role);
  this.doLogin(role);
}
```

`doLogin/doShopLogin` 不再传 `loginName/roles`；服务端再次鉴权。

- [ ] **Step 7: 调整绑定文案并运行测试**

WXML 保持现有结构，将绑定说明明确为“验证账号后绑定当前微信；每个账号和微信只能绑定一次”。

Run: `node tests/loginMethods.test.js`

Run: `node tests/registerAccountRules.test.js`

Expected: PASS。

- [ ] **Step 8: 提交**

```powershell
git add miniprogram/pages/login/index.js miniprogram/pages/login/index.wxml tests/loginMethods.test.js tests/registerAccountRules.test.js
git commit -m "feat: enable persistent wechat login"
```

---

### Task 5: 短信验证与账号安全真实状态

**Files:**
- Modify: `cloudfunctions/verifySmsCode/index.js:16-67`
- Modify: `miniprogram/pages/login/index.js:465-492,519-596`
- Modify: `miniprogram/pages/settings/account-security/index.js:1-101`
- Modify: `tests/smsLogin.test.js`
- Modify: `tests/coachProfileSettingsBinding.test.js`

**Interfaces:**
- Consumes: 当前 `OPENID` 的 `wechat_bindings` 和 `users`。
- Produces: `verifySmsCode.main({ phone, code }) -> { ok:true, phone, account, roles }`，仅限已绑定账号。
- Produces: 账号安全页消费 `data.getAccountSecurity()`。

- [ ] **Step 1: 写未绑定不得创建用户和已绑定短信登录测试**

```js
const unbound = await loadVerifySms('wechat_unbound', seedWithValidCode).main({
  phone: '13800138000', code: '123456'
});
assert.strictEqual(unbound.code, 'WECHAT_NOT_BOUND');
assert.strictEqual(state.users.length, 0);

const bound = await loadVerifySms('wechat_bound', seedWithBindingAndCode).main({
  phone: '13800138000', code: '123456'
});
assert.strictEqual(bound.ok, true);
assert.strictEqual(bound.account, 'memberA');
assert.deepStrictEqual(bound.roles, ['member']);
assert.strictEqual(state.users[0].phone, '13800138000');
```

- [ ] **Step 2: 写账号安全页云端状态测试**

```js
fakeData.getAccountSecurity = () => Promise.resolve({
  account: 'memberA', wechatBound: true, passwordSet: true,
  phone: '13800138000', roles: ['member']
});
page.refresh();
await flushPromises();
assert.strictEqual(page.data.accountText, 'memberA');
assert.strictEqual(page.data.passwordText, '已设置');
assert.strictEqual(page.data.phoneText, '138****8000');
assert.strictEqual(page.data.wechatText, '已绑定');
```

- [ ] **Step 3: 运行测试确认失败**

Run: `node tests/smsLogin.test.js`

Run: `node tests/coachProfileSettingsBinding.test.js`

Expected: FAIL，旧短信函数会为未绑定 OPENID 创建 `users`，账号安全页仍读取本地绑定。

- [ ] **Step 4: 收紧短信云函数**

验证码置为 used 前先解析绑定；未绑定直接失败且不得消耗验证码：

```js
const bindingId = sha256(`wechat:${OPENID}`);
const bindingRes = await db.collection('wechat_bindings').doc(bindingId).get().catch(() => null);
const binding = bindingRes && bindingRes.data;
if (!binding) return { ok: false, code: 'WECHAT_NOT_BOUND', msg: '请先绑定或注册账号' };
const accountRes = await db.collection('accounts').doc(binding.accountId).get().catch(() => null);
if (!accountRes || !accountRes.data) return { ok: false, code: 'ACCOUNT_NOT_BOUND', msg: '账号绑定不完整' };
```

验证成功后只更新当前 `users`，不存在时返回 `ACCOUNT_NOT_BOUND`，不再 `users.add()`。

- [ ] **Step 5: 登录页删除本地手机号账号判断**

`sendCode()` 只校验手机号格式和发送状态；短信 `submit/bindWechat` 成功后直接调用 `handleAuthenticated(result)`，不再调用 `findRegisteredAccount(phone)`。

- [ ] **Step 6: 账号安全页改用云端状态**

```js
refresh() {
  data.getAccountSecurity()
    .then((status) => this.setData({
      accountText: status.account || '未设置',
      passwordText: status.passwordSet ? '已设置' : '未设置',
      phoneText: maskPhone(status.phone) || '未绑定',
      wechatText: status.wechatBound ? '已绑定' : '未绑定'
    }))
    .catch(() => this.setData({
      accountText: '未登录', passwordText: '未设置', phoneText: '未绑定', wechatText: '未绑定'
    }));
}
```

- [ ] **Step 7: 运行聚焦测试确认通过**

Run: `node tests/smsLogin.test.js`

Run: `node tests/coachProfileSettingsBinding.test.js`

Run: `node tests/loginMethods.test.js`

Expected: 全部 PASS。

- [ ] **Step 8: 提交**

```powershell
git add cloudfunctions/verifySmsCode/index.js miniprogram/pages/login/index.js miniprogram/pages/settings/account-security/index.js tests/smsLogin.test.js tests/coachProfileSettingsBinding.test.js tests/loginMethods.test.js
git commit -m "fix: use bound account for sms authentication"
```

---

### Task 6: Coach/Shop 授权旁路一致性

**Files:**
- Modify: `cloudfunctions/reviewShopApplication/index.js:66-82`
- Modify: `cloudfunctions/saveShopProfile/index.js:17-65`
- Modify: `cloudfunctions/addShopCoach/index.js:6-31`
- Modify: `tests/shopQualificationApply.test.js`
- Modify: `tests/becomeCoachApplication.test.js`
- Modify: `tests/coachMemberCompatibility.test.js`

**Interfaces:**
- Consumes: `users.roles` 作为唯一业务角色账本。
- Produces: 审批函数 upsert 服务端角色；资料保存和关联函数不能授予未审批角色。

- [ ] **Step 1: 写店主审批 upsert 与教练关联拒绝测试**

```js
const approved = await reviewShop.main({ applicationId: 'shop-app', approve: true, loginName: 'admin_zhx' });
assert.strictEqual(approved.ok, true);
const shopUser = state.users.find((item) => item._openid === 'shop_openid');
assert(shopUser);
assert(shopUser.roles.includes('shop'));

const notCoach = await addShopCoach.main({ coachOpenid: 'member_openid', storeId: 'store1' });
assert.strictEqual(notCoach.ok, false);
assert.strictEqual(notCoach.code, 'COACH_ROLE_REQUIRED');
assert.strictEqual(state.shop_coach_links.length, 0);
```

- [ ] **Step 2: 写资料保存不得旁路授予 shop 测试**

```js
const denied = await saveShopProfile.main({ name: 'Unauthorized Shop' });
assert.strictEqual(denied.ok, false);
assert.strictEqual(denied.code, 'SHOP_NOT_APPROVED');
assert.deepStrictEqual(state.users[0].roles, ['member']);
```

- [ ] **Step 3: 运行测试确认失败**

Run: `node tests/shopQualificationApply.test.js`

Run: `node tests/becomeCoachApplication.test.js`

Run: `node tests/coachMemberCompatibility.test.js`

Expected: FAIL，旧审批不会为缺失 user 建角色账本，旁路函数未统一检查角色。

- [ ] **Step 4: 实现最小服务端角色收口**

店主审批通过时：已有 user 合并 `shop`；无 user 时创建：

```js
await users.add({
  data: {
    _openid: application._openid,
    roles: ['member', 'shop'],
    currentRole: 'member',
    role: 'member',
    nickname: '', avatar: '',
    createdAt: db.serverDate(), updatedAt: db.serverDate()
  }
});
```

`saveShopProfile` 先读取已批准申请或 legacy shop，再允许保持 `shop`；`addShopCoach` 先读取目标 `users` 并检查 `roles.includes('coach')`，不通过即返回 `COACH_ROLE_REQUIRED`。

- [ ] **Step 5: 运行聚焦测试确认通过**

Run: `node tests/shopQualificationApply.test.js`

Run: `node tests/becomeCoachApplication.test.js`

Run: `node tests/coachMemberCompatibility.test.js`

Expected: 全部 PASS。

- [ ] **Step 6: 提交**

```powershell
git add cloudfunctions/reviewShopApplication/index.js cloudfunctions/saveShopProfile/index.js cloudfunctions/addShopCoach/index.js tests/shopQualificationApply.test.js tests/becomeCoachApplication.test.js tests/coachMemberCompatibility.test.js
git commit -m "fix: close business role authorization side paths"
```

---

### Task 7: AppID、部署说明与全量验收

**Files:**
- Modify: `project.config.json:5`
- Modify: `README.md`
- Modify: any test file only if a newly exposed assertion defect is traced to this feature; do not weaken security expectations.

**Interfaces:**
- Produces: 可导入真实小程序 AppID 的项目配置和明确部署清单。
- Consumes: Tasks 1-6 的全部实现。

- [ ] **Step 1: 写配置静态断言**

在 `tests/accountWechatBinding.test.js` 增加：

```js
const projectConfig = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'));
assert.strictEqual(projectConfig.appid, 'wxa7c9920cda26d7ca');
```

- [ ] **Step 2: 运行配置测试确认失败**

Run: `node tests/accountWechatBinding.test.js`

Expected: FAIL，当前 `project.config.json.appid` 为空。

- [ ] **Step 3: 恢复 AppID 并补部署说明**

`project.config.json`：

```json
"appid": "wxa7c9920cda26d7ca"
```

README 必须明确：

```markdown
## 微信账号认证部署

1. 确认项目 AppID 与 `miniprogram/app.js` 的云环境属于同一小程序。
2. 在云数据库创建 `accounts`、`wechat_bindings`、`users`，禁止小程序客户端直接读写前两个集合。
3. 上传并部署 `accountAuth`、`login`、`verifySmsCode`，以及本次修改的角色审批云函数，并选择“云端安装依赖”。
4. 本地测试只验证逻辑；发布前必须在真机完成首次注册、微信免密、清缓存恢复和双向冲突验收。
```

- [ ] **Step 4: 运行所有测试并汇总失败**

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

Expected: `ALL TESTS PASSED`，exit code 0。

- [ ] **Step 5: 对全部改动 JavaScript 做语法检查**

Run:

```powershell
$failed = @()
git diff --name-only 3de6d41..HEAD | Where-Object { $_ -like '*.js' } | ForEach-Object {
  node --check $_
  if ($LASTEXITCODE -ne 0) { $failed += $_ }
}
if ($failed.Count) { Write-Output "SYNTAX FAILED: $($failed -join ', ')"; exit 1 }
Write-Output 'ALL CHANGED JS SYNTAX PASSED'
```

Expected: `ALL CHANGED JS SYNTAX PASSED`，exit code 0。

- [ ] **Step 6: 执行安全静态扫描**

Run:

```powershell
git grep -n -I -E "dc_accounts|dc_wechat_bindings|event\.roles|ensureAdminAccount" -- miniprogram/pages/login miniprogram/pages/settings/account-security cloudfunctions/login
```

Expected: 无生产鉴权命中；允许测试或迁移说明中的文字命中，但必须人工逐条确认不参与认证。

Run: `git diff --check`

Expected: exit code 0，无 whitespace error。

- [ ] **Step 7: 记录真机验收边界**

若当前环境无法启动微信开发者工具或访问云环境，在最终报告中精确列出以下未冒充通过的人工项：

- 真实 OPENID 首次注册；
- 微信图标免密恢复；
- 清除 storage 或更换设备恢复；
- 第二微信/第二账号双向冲突；
- 云函数和集合权限部署。

- [ ] **Step 8: 提交配置与文档**

```powershell
git add project.config.json README.md tests/accountWechatBinding.test.js
git commit -m "docs: add wechat auth deployment setup"
```

- [ ] **Step 9: 最终工作区检查**

Run: `git status --short`

Expected: 无未提交变更。
