# 账号找回与邮箱绑定 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复云端注册 `_id` 故障，准确提示未注册/密码错误，并交付微信与邮箱密码找回、邮箱绑定及腾讯云 SES 验证码链路。

**Architecture:** `accountAuth` 继续作为账号安全唯一写入口，在事务内完成身份重验、验证码消费、邮箱绑定和 scrypt 密码更新；独立 `sendEmailCode` 负责 SES 投递、挑战状态及双维限流。小程序登录页承载两种找回方式，账号与安全页跳转到独立邮箱绑定页。

**Tech Stack:** 微信小程序 WXML/WXSS/JavaScript、微信云开发 `wx-server-sdk ~2.6.3`、Node.js 16.13、Node `crypto`、腾讯云 SES SDK `tencentcloud-sdk-nodejs-ses 4.1.265`、Node `assert` 测试。

## Global Constraints

- 不删除任何仓库文件或生产数据。
- 不触碰或提交用户现有的 `project.config.json`、`cloudfunctions/accountAuth/node_modules/`、`cloudfunctions/accountAuth/package-lock.json`。
- 每个 `doc(id).set()` 的 `data` 禁止包含 `_id`。
- 微信找回只信任 `cloud.getWXContext().OPENID`，不信任客户端账号或 OPENID。
- 邮箱找回对账号/邮箱不匹配、目标冷却和真实投递失败使用同一公开响应。
- 邮件验证码有效 10 分钟、重发冷却 60 秒、最多错误 5 次、成功后一次性消费。
- 邮箱验证码只保存 `CUETRACE_EMAIL_CODE_SECRET` HMAC；密钥、验证码和密码不得进入仓库、客户端响应或日志。
- `accounts` 只保存 `emailBindingId/emailVerifiedAt`；邮箱明文只在受限 `email_bindings`，状态接口即时计算掩码。
- 行为修改先跑 focused 测试；全量验证只在最终收口运行一次。

---

## File Map

**Create**

- `cloudfunctions/sendEmailCode/index.js`：目标验证、双维限流、验证码挑战和 SES 投递。
- `cloudfunctions/sendEmailCode/package.json`：固定云 SDK 依赖。
- `cloudfunctions/sendEmailCode/package-lock.json`：锁定实际安装依赖。
- `miniprogram/pages/settings/email-binding/index.js`：邮箱绑定表单、倒计时和提交。
- `miniprogram/pages/settings/email-binding/index.json`：页面标题。
- `miniprogram/pages/settings/email-binding/index.wxml`：绑定表单。
- `miniprogram/pages/settings/email-binding/index.wxss`：复用设置页视觉语言的局部样式。
- `tests/emailRecovery.test.js`：服务端验证码投递与邮箱绑定/找回聚焦测试。

**Modify**

- `cloudfunctions/accountAuth/index.js`：去 `_id`、错误拆分、微信/邮箱重置、邮箱绑定和状态。
- `tests/accountWechatBinding.test.js`：真实 `.set()` 语义与账号错误/微信找回回归。
- `miniprogram/services/data.js`：无会话副作用的恢复/绑定 API。
- `miniprogram/pages/login/index.js`、`index.wxml`、`index.wxss`：未注册引导和两种找回 UI。
- `tests/loginMethods.test.js`：登录和恢复交互。
- `miniprogram/pages/settings/account-security/index.js`、`index.wxml`：邮箱状态与入口。
- `miniprogram/app.json`：注册邮箱绑定页。
- `tests/coachProfileSettingsBinding.test.js`：账号安全页与邮箱绑定页回归。
- `miniprogram/pages/legal/index.js`：隐私政策披露邮箱用途。
- `README.md`：集合、云函数、环境变量和真机验收说明。

---

### Task 1: 修复 `_id` 写入并拆分登录错误

**Files:**

- Modify: `tests/accountWechatBinding.test.js`
- Modify: `cloudfunctions/accountAuth/index.js`

**Interfaces:**

- Produces: `withoutDocumentId(document): object`
- Produces errors: `ACCOUNT_NOT_FOUND`, `INVALID_PASSWORD`

- [ ] **Step 1: 让 fake 数据库复现生产 `.set()` 限制并写失败断言**

在 fake `set` 中加入：

```js
if (data && Object.prototype.hasOwnProperty.call(data, '_id')) {
  throw new Error('document.set:fail -501007 invalid parameters. 不能更新_id的值');
}
target.push(Object.assign({ _id: id }, clone(data || {})));
```

新增断言：未知账号返回 `ACCOUNT_NOT_FOUND`；已存在账号错误密码返回 `INVALID_PASSWORD`；两者都不改变 state。

- [ ] **Step 2: 运行测试确认红灯**

Run: `node tests/accountWechatBinding.test.js`

Expected: FAIL，注册命中 fake 的 `_id` 错误，且旧 `INVALID_CREDENTIALS` 断言不匹配。

- [ ] **Step 3: 最小修复 `accountAuth`**

新增：

```js
function withoutDocumentId(document) {
  const data = Object.assign({}, document || {});
  delete data._id;
  return data;
}
```

所有新文档写入改为：

```js
await ref.set({ data: withoutDocumentId(document) });
```

密码登录读取顺序固定为：

```js
if (!account) throw authError('ACCOUNT_NOT_FOUND');
if (!isAccountIdentity(account, accountDocId)) throw authError('ACCOUNT_NOT_BOUND');
if (typeof event.password !== 'string' || !verifyPassword(event.password, account)) {
  throw authError('INVALID_PASSWORD');
}
```

事务内重验使用相同区分，并在 `messageFor` 加入“账号未注册”“账号密码错误”。

- [ ] **Step 4: 运行 focused 测试确认绿灯**

Run: `node tests/accountWechatBinding.test.js`

Expected: PASS；注册和首次绑定成功，fake 未再接收到 `_id`。

- [ ] **Step 5: 提交**

```powershell
git add -- cloudfunctions/accountAuth/index.js tests/accountWechatBinding.test.js
git commit -m "fix: handle registration ids and login errors"
```

---

### Task 2: 实现微信找回与邮箱安全事务

**Files:**

- Modify: `tests/accountWechatBinding.test.js`
- Create: `tests/emailRecovery.test.js`
- Modify: `cloudfunctions/accountAuth/index.js`

**Interfaces:**

- Consumes: 设计 spec 锁定的 `email_codes` active challenge schema；Task 3 的发送器必须写出同一字段
- Produces: `resetPasswordByWechat({ password })`
- Produces: `bindEmail({ email, code })`
- Produces: `resetPasswordByEmail({ account, email, code, password })`
- Produces status: `{ emailBound, emailMasked }`

- [ ] **Step 1: 写微信找回和邮箱事务失败测试**

覆盖以下精确行为：

```js
assert.strictEqual((await main({ action: 'resetPasswordByWechat', password: 'newpass1' })).ok, true);
assert.strictEqual((await main({ action: 'passwordLogin', account: 'MemberA', password: 'oldpass' })).code, 'INVALID_PASSWORD');
assert.strictEqual((await main({ action: 'passwordLogin', account: 'MemberA', password: 'newpass1' })).ok, true);
```

并覆盖：未绑定微信零写入、邮箱首次绑定、同邮箱绑定第二账号失败、换绑撤销旧邮箱、错误/过期/锁定/已用验证码失败、邮箱重置后旧密码失效。

- [ ] **Step 2: 运行测试确认红灯**

Run: `node tests/accountWechatBinding.test.js; node tests/emailRecovery.test.js`

Expected: FAIL，三个 action 尚不存在，status 尚无邮箱字段。

- [ ] **Step 3: 增加邮箱规范化、掩码和挑战校验**

实现固定接口：

```js
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_RE = /^\d{6}$/;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function emailBindingId(email) {
  return sha256(`email:${normalizeEmail(email)}`);
}

function emailCodeId(purpose, email) {
  return sha256(`email-code:${purpose}:${normalizeEmail(email)}`);
}

function hashEmailCode(challengeId, code) {
  const secret = process.env.CUETRACE_EMAIL_CODE_SECRET || '';
  if (!secret) throw authError('EMAIL_NOT_CONFIGURED');
  return crypto.createHmac('sha256', secret).update(`${challengeId}:${code}`).digest('hex');
}

function maskEmail(email) {
  const parts = normalizeEmail(email).split('@');
  const local = parts[0] || '';
  return `${local.slice(0, Math.min(2, local.length))}${'*'.repeat(Math.max(2, local.length - 2))}@${parts[1] || ''}`;
}
```

- [ ] **Step 4: 实现三项事务**

共同规则：事务内重新读取并验证 account/binding/user；挑战必须 `_id/purpose/accountId/emailBindingId/status/expiresAt/attemptsLeft` 全匹配；错误码不通过异常回滚需要保留的失败次数，而是先更新次数再返回 `{ok:false,...}`；成功时同一事务消费 code。

密码更新固定为：

```js
const salt = crypto.randomBytes(16).toString('hex');
await accountRef.update({ data: {
  passwordAlgorithm: 'scrypt-v1',
  passwordSalt: salt,
  passwordHash: hashPassword(password, salt),
  updatedAt: db.serverDate()
} });
```

邮箱换绑固定为：旧 binding `status:'revoked'`，新 binding 用 `withoutDocumentId` 写为 `active`，account 只更新 `emailBindingId/emailVerifiedAt/updatedAt`。

- [ ] **Step 5: 扩展 handler、消息和 status**

```js
const handlers = {
  probe: async () => ({ ok: true, cloudReady: true }),
  register,
  passwordLogin,
  wechatLogin,
  resetPasswordByWechat,
  bindEmail,
  resetPasswordByEmail,
  status
};
```

`status` 只在 account 指针对应 active binding 且身份字段一致时返回 `emailMasked: maskEmail(binding.email)`；否则 `emailBound:false, emailMasked:''`。

- [ ] **Step 6: 运行 focused 测试确认绿灯**

Run: `node tests/accountWechatBinding.test.js; node tests/emailRecovery.test.js`

Expected: PASS。

- [ ] **Step 7: 提交**

```powershell
git add -- cloudfunctions/accountAuth/index.js tests/accountWechatBinding.test.js tests/emailRecovery.test.js
git commit -m "feat: add password recovery and email security transactions"
```

---

### Task 3: 实现腾讯云 SES 验证码发送

**Files:**

- Create: `cloudfunctions/sendEmailCode/index.js`
- Create: `cloudfunctions/sendEmailCode/package.json`
- Create: `cloudfunctions/sendEmailCode/package-lock.json`
- Modify: `tests/emailRecovery.test.js`

**Interfaces:**

- Produces cloud call: `sendEmailCode({ purpose:'bind'|'reset', account?, email })`
- Produces challenge consumed by Task 2: `email_codes` document with `status:'active'`

- [ ] **Step 1: 写发送函数红灯测试**

模拟 `wx-server-sdk`、数据库和 `tencentcloud-sdk-nodejs-ses`，覆盖：缺配置、邮箱格式、bind 身份、邮箱冲突、目标冷却、actor 冷却、SES 参数、发送失败状态、reset 不匹配/冷却/SES 失败均同一公开响应。

SES 期望参数：

```js
{
  FromEmailAddress: '强化杆迹 <noreply@example.com>',
  Destination: ['member@example.com'],
  Subject: '强化杆迹验证码',
  Template: { TemplateID: 12345, TemplateData: '{"code":"123456","minutes":"10"}' },
  TriggerType: 1
}
```

- [ ] **Step 2: 运行测试确认红灯**

Run: `node tests/emailRecovery.test.js`

Expected: FAIL，`cloudfunctions/sendEmailCode/index.js` 不存在。

- [ ] **Step 3: 创建固定依赖并安装 lock**

`package.json`：

```json
{
  "name": "sendEmailCode",
  "version": "1.0.0",
  "main": "index.js",
  "dependencies": {
    "tencentcloud-sdk-nodejs-ses": "4.1.265",
    "wx-server-sdk": "~2.6.3"
  }
}
```

Run: `npm.cmd install --package-lock-only --ignore-scripts`

Working directory: `cloudfunctions/sendEmailCode`

Expected: exit 0，生成 package-lock，且不提交 node_modules。

- [ ] **Step 4: 实现配置与 SES 客户端**

```js
const { ses } = require('tencentcloud-sdk-nodejs-ses');
const SesClient = ses.v20201002.Client;

function getConfig() {
  return {
    secretId: process.env.CUETRACE_SES_SECRET_ID || '',
    secretKey: process.env.CUETRACE_SES_SECRET_KEY || '',
    region: process.env.CUETRACE_SES_REGION || 'ap-guangzhou',
    fromEmail: process.env.CUETRACE_SES_FROM_EMAIL || '',
    templateId: Number(process.env.CUETRACE_SES_TEMPLATE_ID || 0),
    subject: process.env.CUETRACE_SES_SUBJECT || '强化杆迹验证码',
    replyTo: process.env.CUETRACE_SES_REPLY_TO || '',
    codeSecret: process.env.CUETRACE_EMAIL_CODE_SECRET || ''
  };
}
```

客户端超时 8 秒，`SendEmail` 使用审核模板和 `TriggerType:1`。

- [ ] **Step 5: 实现双维限流和挑战状态机**

目标挑战 ID：`sha256('email-code:'+purpose+':'+emailNormalized)`；actor 限流 ID：`sha256('email-rate:'+purpose+':'+sha256(OPENID/accountId))`。同一事务检查两个文档的 `nextSendAt`，预留 `sending/requestId`；SES 成功后只在 requestId 未变时转 `active` 并写 HMAC、10 分钟期限、5 次；失败转 `failed`。

`reset` 的公开成功结果固定：

```js
{ ok: true, accepted: true, msg: '若信息匹配，验证码将发送至绑定邮箱' }
```

- [ ] **Step 6: 运行 focused 测试和语法检查**

Run: `node tests/emailRecovery.test.js; node --check cloudfunctions/sendEmailCode/index.js`

Expected: PASS / exit 0。

- [ ] **Step 7: 提交**

```powershell
git add -- cloudfunctions/sendEmailCode/index.js cloudfunctions/sendEmailCode/package.json cloudfunctions/sendEmailCode/package-lock.json tests/emailRecovery.test.js
git commit -m "feat: send account email verification codes"
```

---

### Task 4: 接入数据服务和登录页找回

**Files:**

- Modify: `miniprogram/services/data.js`
- Modify: `miniprogram/pages/login/index.js`
- Modify: `miniprogram/pages/login/index.wxml`
- Modify: `miniprogram/pages/login/index.wxss`
- Modify: `tests/accountWechatBinding.test.js`
- Modify: `tests/loginMethods.test.js`

**Interfaces:**

- Consumes account actions from Task 2 and `sendEmailCode` from Task 3
- Produces data methods: `sendEmailCode`, `resetPasswordByWechat`, `resetPasswordByEmail`, `bindEmail`

- [ ] **Step 1: 写 data service 与登录交互红灯测试**

验证四个 public method 固定 action，且恢复/绑定成功不调用 `applyAuthResult`、不改变 `globalData.account/roles/currentRole`。登录页验证：未注册 modal 确认后 `mode:'register'` 且预填；错误密码 toast；忘记密码入口；微信/邮箱切换；验证码发送；成功后回到 login 并预填服务端账号；切换/卸载清理倒计时。

- [ ] **Step 2: 运行测试确认红灯**

Run: `node tests/accountWechatBinding.test.js; node tests/loginMethods.test.js`

Expected: FAIL，新 API 和恢复 UI 不存在。

- [ ] **Step 3: 增加无会话副作用的服务方法**

```js
function cloudAuth(action, payload, applySession = true) {
  if (!cloudReady()) return Promise.reject(cloudNotReadyError());
  return callCloud('accountAuth', Object.assign({}, payload || {}, { action })).then((result) => {
    if (result && result.ok === false) throw resultError(result, '认证失败');
    return applySession ? applyAuthResult(result) : result;
  });
}

function resultError(result, fallback) {
  const error = new Error((result && result.msg) || fallback);
  error.code = (result && result.code) || 'AUTH_FAILED';
  error.result = result;
  return error;
}

function callCheckedCloud(name, input) {
  if (!cloudReady()) return Promise.reject(cloudNotReadyError());
  return callCloud(name, input || {}).then((result) => {
    if (result && result.ok === false) throw resultError(result, '操作失败');
    return result;
  });
}

function resetPasswordByWechat(input) { return cloudAuth('resetPasswordByWechat', input, false); }
function resetPasswordByEmail(input) { return cloudAuth('resetPasswordByEmail', input, false); }
function bindEmail(input) { return cloudAuth('bindEmail', input, false); }
function sendEmailCode(input) { return callCheckedCloud('sendEmailCode', input); }
```

`resultError/callCheckedCloud` 复用现有错误对象字段 `{code,result}`，云未就绪失败关闭。

- [ ] **Step 4: 实现登录错误分支**

`ACCOUNT_NOT_FOUND` 使用 `wx.showModal`：标题“账号未注册”，正文“未找到该账号，是否现在注册？”，确认后：

```js
this.setData({ mode: 'register', regAccount: this.data.account, regPassword: '', regConfirm: '' });
```

`INVALID_PASSWORD` 只显示“账号密码错误”。

- [ ] **Step 5: 实现 recover 模式**

data 增加 `recoveryType:'wechat'`、`recoveryAccount/email/code/password/confirm`、`recoveryCounting/sending/countdown`。WXML 在密码框下增加“忘记密码”，并把原注册 `else` 改为明确 `wx:elif="{{mode === 'register'}}"`，最后新增 recover block。邮箱验证码按钮与微信/邮箱 tab 使用独立状态，避免复用手机号倒计时。

- [ ] **Step 6: 运行 focused 测试确认绿灯**

Run: `node tests/accountWechatBinding.test.js; node tests/loginMethods.test.js`

Expected: PASS。

- [ ] **Step 7: 提交**

```powershell
git add -- miniprogram/services/data.js miniprogram/pages/login/index.js miniprogram/pages/login/index.wxml miniprogram/pages/login/index.wxss tests/accountWechatBinding.test.js tests/loginMethods.test.js
git commit -m "feat: add password recovery login flows"
```

---

### Task 5: 增加账号安全邮箱绑定页和隐私披露

**Files:**

- Create: `miniprogram/pages/settings/email-binding/index.js`
- Create: `miniprogram/pages/settings/email-binding/index.json`
- Create: `miniprogram/pages/settings/email-binding/index.wxml`
- Create: `miniprogram/pages/settings/email-binding/index.wxss`
- Modify: `miniprogram/pages/settings/account-security/index.js`
- Modify: `miniprogram/pages/settings/account-security/index.wxml`
- Modify: `miniprogram/app.json`
- Modify: `miniprogram/pages/legal/index.js`
- Modify: `tests/coachProfileSettingsBinding.test.js`

**Interfaces:**

- Consumes: `data.getAccountSecurity`, `data.sendEmailCode`, `data.bindEmail`
- Produces page URL: `/pages/settings/email-binding/index`

- [ ] **Step 1: 写账号安全与绑定页红灯测试**

断言状态页显示 `emailMasked || '未绑定'`，点击导航至新页；绑定页校验邮箱、发送 bind code、60 秒倒计时、提交 code、成功 navigateBack；失败时不伪造成功。静态断言 app.json 注册页面且隐私政策包含“邮箱/验证码/账号安全与密码找回”。

- [ ] **Step 2: 运行测试确认红灯**

Run: `node tests/coachProfileSettingsBinding.test.js`

Expected: FAIL，邮箱字段/页面不存在。

- [ ] **Step 3: 扩展账号安全页**

```js
emailText: '未绑定'
```

`refresh()` 赋值 `emailText: result.emailBound ? result.emailMasked : '未绑定'`；`onEmail()` 导航新页；`onShow()` 继续调用 refresh，使返回后自动刷新。

- [ ] **Step 4: 创建邮箱绑定页**

页面 state：`email/code/sending/counting/countdown/currentEmail`。发送前用与服务端一致的基础格式校验；成功启动 60 秒计时。提交调用：

```js
data.bindEmail({ email: this.data.email.trim(), code: this.data.code.trim() })
```

成功 modal 后 `wx.navigateBack()`；`onUnload()` 清 timer。

- [ ] **Step 5: 注册页面并更新隐私政策**

在 `miniprogram/app.json` 的账号安全页后加入 `pages/settings/email-binding/index`。隐私政策说明仅收集用户主动绑定并已验证码验证的邮箱，用于账号安全、验证码投递与密码找回，不向客户端展示完整邮箱。

- [ ] **Step 6: 运行 focused 测试确认绿灯**

Run: `node tests/coachProfileSettingsBinding.test.js`

Expected: PASS。

- [ ] **Step 7: 提交**

```powershell
git add -- miniprogram/pages/settings/email-binding miniprogram/pages/settings/account-security/index.js miniprogram/pages/settings/account-security/index.wxml miniprogram/app.json miniprogram/pages/legal/index.js tests/coachProfileSettingsBinding.test.js
git commit -m "feat: add verified email binding settings"
```

---

### Task 6: 部署文档、独立复审和最终验证

**Files:**

- Modify: `README.md`

- [ ] **Step 1: 更新部署说明**

明确新增集合 `email_bindings/email_codes` 仅云函数访问；部署 `sendEmailCode/accountAuth`；两个函数配置相同 `CUETRACE_EMAIL_CODE_SECRET`；列出全部 `CUETRACE_SES_*`；要求 SES 服务开通、域名验证、发信地址、审核模板；说明 reset 公开响应不代表实际匹配或送达。

- [ ] **Step 2: 运行所有 focused 测试**

Run:

```powershell
node tests/accountWechatBinding.test.js
node tests/emailRecovery.test.js
node tests/loginMethods.test.js
node tests/coachProfileSettingsBinding.test.js
```

Expected: 全部 PASS。

- [ ] **Step 3: 提交文档**

```powershell
git add -- README.md
git commit -m "docs: add email recovery deployment guide"
```

- [ ] **Step 4: 请求独立代码复审**

使用 `superpowers:requesting-code-review`，审查 spec、计划与自 `f84a25f` 起的业务 diff；重点检查认证绕过、枚举泄露、验证码竞争/复用、PII/secret 日志和 `.set()` `_id`。

- [ ] **Step 5: 运行最终验证**

先确保最终验证排除用户未跟踪的 `accountAuth/node_modules` vendor 噪声但不删除它；只由根任务运行一次：

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/codex-verify.ps1`

Expected: 业务测试全部通过。若脚本仍只因用户未跟踪 vendor 扫描失败，另运行等价业务范围验证并原样记录 vendor 失败，不宣称原脚本通过。

- [ ] **Step 6: 云端验收清单**

通知张总完成：部署两个函数及依赖、设置环境变量/集合权限、真实邮箱收码、绑定/换绑、微信重置、邮箱重置、旧密码失效/新密码成功。明确本地测试不能验证真实 SES 投递与微信 OPENID。

---

### Task 7: Final whole-branch review remediation

**Files:**

- Modify: `cloudfunctions/accountAuth/index.js`
- Modify: `cloudfunctions/purgeDeletedAccounts/index.js`
- Modify: `miniprogram/pages/login/index.js`
- Modify: `miniprogram/pages/login/index.wxml`
- Modify: `miniprogram/pages/legal/index.js`
- Modify: `README.md`
- Modify: `tests/emailRecovery.test.js`
- Modify: `tests/loginMethods.test.js`
- Modify: `tests/accountDeletionGracePeriod.test.js`
- Modify: `tests/coachProfileSettingsBinding.test.js`

**Interfaces:**

- Produces reset success: `{ ok: true, account: string }`
- Extends purge ownership: `email_bindings.accountId` and `email_codes.accountId/actorHash`
- Produces UI state: `recoverySubmitting: boolean` with stale-request cancellation

- [ ] **Step 1: 写重置响应与提交竞态 RED**

`emailRecovery.test.js` 断言两种 reset 返回服务端规范账号；`loginMethods.test.js` 用 deferred Promise 断言微信/邮箱重复点击各只调用一次，切换、返回或卸载后迟到 resolve/reject 不 setData/toast/切 mode。

- [ ] **Step 2: 实现响应契约和提交 token**

服务端成功返回：

```js
return { ok: true, account: account.account };
```

登录页增加独立 submit token：

```js
beginRecoverySubmission(type)
isRecoverySubmissionCurrent(token, type)
cancelRecoverySubmission()
```

所有 reset then/catch 在 UI 操作前校验 token、disposed、`mode==='recover'` 和恢复方式；按钮以 `recoverySubmitting` 禁用并显示提交中。切换、返回、成功和卸载均失效 token。

- [ ] **Step 3: 运行重置 focused GREEN**

Run: `node tests/emailRecovery.test.js; node tests/loginMethods.test.js`

Expected: PASS。

- [ ] **Step 4: 写邮箱注销清理 RED**

在到期账号 state 中加入：账号 active/revoked 邮箱绑定、账号 challenge、当前 OPENID actor rate、foreign binding/challenge/rate。断言 purge 删除前三类 owned 数据，保留 foreign；模拟邮箱集合缺失或删除失败时认证链保留。

- [ ] **Step 5: 接入稳定清理扫描**

`buildCleanupPlan` 解构 `accountId` 并加入：

```js
await gather('email_bindings', { accountId });
await gather('email_codes', _.or(
  { accountId },
  { actorHash: sha256(openid) }
));
```

邮箱数据继续通过现有 lease、批量事务、重复稳定扫描删除；不绕过 `executeStableCleanup`，因此任一失败都会阻止最终认证链删除。

- [ ] **Step 6: 运行注销 focused GREEN**

Run: `node tests/accountDeletionGracePeriod.test.js`

Expected: PASS。

- [ ] **Step 7: 补隐私清单和部署生命周期说明**

将隐私政策日期更新为 `2026-07-12`，在第三方清单披露“腾讯云 SES / 收件邮箱 / 邮件验证码投递 / API”；README 将 `email_bindings/email_codes` 列入 purge 必备集合并说明认证链删除前清理。测试不得出现真实邮箱或密钥。

- [ ] **Step 8: 运行隐私 focused GREEN 与语法检查**

Run: `node tests/coachProfileSettingsBinding.test.js`

Run: `node --check cloudfunctions/accountAuth/index.js; node --check cloudfunctions/purgeDeletedAccounts/index.js; node --check miniprogram/pages/login/index.js; node --check miniprogram/pages/legal/index.js`

Expected: PASS / exit 0。

- [ ] **Step 9: 提交与最终复审**

```powershell
git add -- cloudfunctions/accountAuth/index.js cloudfunctions/purgeDeletedAccounts/index.js miniprogram/pages/login/index.js miniprogram/pages/login/index.wxml miniprogram/pages/legal/index.js README.md tests/emailRecovery.test.js tests/loginMethods.test.js tests/accountDeletionGracePeriod.test.js tests/coachProfileSettingsBinding.test.js
git commit -m "fix: close account recovery lifecycle gaps"
```

重新生成 whole-branch review package，要求 Critical/Important 为 0 后才进入最终全量验证。
