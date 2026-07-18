# 手机号独立账号与可撤销会话 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有 `OPENID -> 账号` 认证改为不可变内部 `accountId`、独立手机号/账号名/微信凭证和服务端可撤销会话，使手机号验证码首次登录直接建号，手机号或账号名可共用同一密码登录，微信只在用户明确确认后绑定。

**Architecture:** `accountAuth` 作为唯一凭证写入口，`sendSmsCode` 负责带用途、代次和限流的挑战发送；共享认证模块提供版本化 HMAC、固定 scrypt、协议守卫与 `requireSession`，再通过显式同步清单复制到独立部署的 CloudBase 云函数。所有用户业务所有权迁移为 `accountId`，微信 `OPENID` 只保留为可信微信绑定输入或支付 `payerOpenid`。小程序使用原始随机会话令牌调用受保护入口，公共、管理员、回调和定时任务继续走各自独立信任边界。

**Tech Stack:** 微信小程序原生 JavaScript/WXML/WXSS、微信云开发、CloudBase 文档数据库事务、`wx-server-sdk ~2.6.3`、Node.js `crypto`/`https`、PowerShell 同步与验证脚本、Node `assert` 测试。

## Global Constraints

- 以已批准规格 `docs/superpowers/specs/2026-07-15-phone-account-session-login-design.md` 为唯一产品事实源；本计划不得重新解释其中已确认的账号、绑定、会话、近期认证和发布规则。
- 新主体 ID 为加密安全随机且不可变的 `accountId`；`users._id === accountId`。账号名、手机号、微信和邮箱只是凭证或恢复关系，不得成为第二套业务主体。
- 手机号验证码或手机号密码登录不创建微信绑定；账号名密码注册不创建手机号或微信绑定；微信绑定只发生在微信入口确认或设置页明确确认。
- 所有新账号只有 `member`。角色只读取服务端 `users.roles`，客户端输入不能授权角色。
- 会话令牌至少 256 位随机，数据库只保存 HMAC；空闲 30 天、绝对 90 天、账号 `authVersion`、停用状态、撤销状态和实时角色每次受保护请求均生效。
- 绑定手机号、绑定微信、设置账号名、设置或修改密码、退出其他设备必须具有最近 10 分钟的有效认证；普通业务活跃请求不能刷新 `authenticatedAt`。
- 密码规则固定为 6–64 字符；`scrypt-v1` 固定 `N=16384,r=8,p=1,keylen=64,salt=16 bytes,maxmem=64 MiB`，未知账号、未设密码、损坏哈希和错误密码均执行同参数虚拟 scrypt 并返回 `INVALID_CREDENTIALS`。
- 认证 HMAC 只读取 `CUETRACE_AUTH_KEY_ACTIVE_VERSION`、`CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS` 和对应的 `CUETRACE_AUTH_KEY_<VERSION>`；禁止回退到腾讯云短信 SecretKey。通过 HKDF-SHA256 为手机号、微信、会话、短信代码、挑战、证明和限流派生不同子密钥。
- 所有可选文档读取只把经过验证的“文档不存在”视为空；权限、网络、事务和其他数据库错误必须失败关闭。
- 小程序端不能直接读写 `accounts`、`account_names`、`phone_bindings`、`wechat_bindings`、`email_bindings`、`email_codes`、`auth_sessions`、`sms_codes`、`sms_rate_limits`、`password_rate_limits`、`auth_proofs`、`auth_control`、`users`。
- CloudBase 每个函数独立部署；共享源码必须通过显式 allowlist 同步到函数目录并由 parity 测试逐字节校验，禁止直接 `require('../_shared/...')`。
- 当前账号与业务数据均为测试数据，但本地实现阶段不清理任何云端数据。部署前必须生成精确清理清单并再次取得张总确认。
- 不删除任何仓库文件；旧 `verifySmsCode` 保留为失败关闭的 v1 退役入口。若实施中发现必须删除文件，先停止并询问张总。
- 当前索引包含大量用户既有暂存内容。禁止 `git add -A`、裸 `git commit`、reset 或清理索引；任务提交必须使用精确 pathspec，并在提交前核对 `git diff --cached --name-only`。
- 行为修改先运行本任务 focused 测试；全量测试、全量语法、diff 和文本检查只由根任务在 Task 14 运行一次 `scripts/codex-verify.ps1`。
- 协议守卫、认证核心、业务迁移和客户端可以分任务开发，但不得把不兼容的中间状态分别开放给生产用户。
- Task 2 的可部署兼容快照固定 `supportedSchemaVersions:[1]`；此后每个入口在其 v2 迁移任务中改为 `[2]`。最终源码不得仍允许 schema 1，生产只能通过保存的 Task 2 快照先部署兼容守卫。

---

## File Map

### New files

- `docs/auth-v2-migration-matrix.md`：107 个当前入口基线、1 个计划新增定时入口、16 个支付共享/部署副本、认证集合与业务外键的逐项迁移账本。
- `docs/auth-v2-deployment.md`：维护窗口、集合/索引/权限、密钥环、部署、回滚、云端冒烟和真机验收手册。
- `docs/auth-v2-acceptance-report.md`：自动化、独立复审、云端预检、部署哈希、真机证据与回滚点。
- `scripts/auth-v2-entry-policy.json`：机器可读的入口信任边界、协议守卫、会话要求、发布批次和同步 allowlist。
- `tests/fixtures/auth-v2-identity-baseline.json`：Task 1 固化的 107 个当前入口、93 个直接入口命中、109 个全部 JavaScript 命中和 16 个支付副本基线。
- `scripts/sync-auth-libs.ps1`：把共享认证源码复制到明确允许的云函数目录。
- `scripts/package-auth-guard-checkpoint.ps1`：在 v1 兼容阶段打包可延后部署的协议守卫函数快照并记录 SHA-256。
- `scripts/auth-v2-cloud-preflight.js`：只读统计目标 CloudBase 集合与旧身份字段并输出带哈希的预检报告。
- `cloudfunctions/_shared/auth/keyring.js`
- `cloudfunctions/_shared/auth/identifiers.js`
- `cloudfunctions/_shared/auth/password.js`
- `cloudfunctions/_shared/auth/protocol-guard.js`
- `cloudfunctions/_shared/auth/session.js`
- `cloudfunctions/_shared/auth/sms.js`
- `cloudfunctions/accountAuth/lib/account-actions.js`
- `cloudfunctions/accountAuth/lib/wechat-actions.js`
- `cloudfunctions/accountAuth/lib/security-actions.js`
- `cloudfunctions/accountAuth/lib/store.js`
- `cloudfunctions/purgeAuthArtifacts/index.js`
- `cloudfunctions/purgeAuthArtifacts/package.json`
- `cloudfunctions/purgeAuthArtifacts/config.json`
- `miniprogram/config/auth.js`
- `miniprogram/services/auth-session.js`
- `miniprogram/components/recent-auth/index.js`
- `miniprogram/components/recent-auth/index.json`
- `miniprogram/components/recent-auth/index.wxml`
- `miniprogram/components/recent-auth/index.wxss`
- `miniprogram/pages/settings/account-security/account-name/index.js`
- `miniprogram/pages/settings/account-security/account-name/index.json`
- `miniprogram/pages/settings/account-security/account-name/index.wxml`
- `miniprogram/pages/settings/account-security/account-name/index.wxss`
- `miniprogram/pages/settings/account-security/password/index.js`
- `miniprogram/pages/settings/account-security/password/index.json`
- `miniprogram/pages/settings/account-security/password/index.wxml`
- `miniprogram/pages/settings/account-security/password/index.wxss`
- `miniprogram/pages/settings/account-security/phone-binding/index.js`
- `miniprogram/pages/settings/account-security/phone-binding/index.json`
- `miniprogram/pages/settings/account-security/phone-binding/index.wxml`
- `miniprogram/pages/settings/account-security/phone-binding/index.wxss`
- `tests/authMigrationMatrix.test.js`
- `tests/authProtocolGuard.test.js`
- `tests/authSharedParity.test.js`
- `tests/authGuardCheckpoint.test.js`
- `tests/authPrimitives.test.js`
- `tests/authSessions.test.js`
- `tests/authClientSession.test.js`
- `tests/accountSecurityPage.test.js`
- `tests/socialSessionAuth.test.js`
- `tests/matchSessionAuth.test.js`
- `tests/coachShopSessionAuth.test.js`
- `tests/tableAccountOwnership.test.js`
- `tests/authCallbackBoundary.test.js`
- `tests/legalAuthPrivacy.test.js`
- `tests/authDeployment.test.js`
- `tests/authPreflight.test.js`

### Modified authentication and client files

- `cloudfunctions/accountAuth/index.js`
- `cloudfunctions/login/index.js`
- `cloudfunctions/sendSmsCode/index.js`
- `cloudfunctions/sendEmailCode/index.js`
- `cloudfunctions/verifySmsCode/index.js`
- `cloudfunctions/deleteAccount/index.js`
- `cloudfunctions/purgeDeletedAccounts/index.js`
- `miniprogram/app.js`
- `miniprogram/app.json`
- `miniprogram/services/data.js`
- `miniprogram/pages/login/index.js`
- `miniprogram/pages/login/index.wxml`
- `miniprogram/pages/login/index.wxss`
- `miniprogram/pages/settings/index.js`
- `miniprogram/pages/settings/index.wxml`
- `miniprogram/pages/settings/account-security/index.js`
- `miniprogram/pages/settings/account-security/index.json`
- `miniprogram/pages/settings/account-security/index.wxml`
- `miniprogram/pages/settings/account-security/index.wxss`
- `miniprogram/pages/settings/email-binding/index.js`
- `miniprogram/pages/legal/index.js`
- `miniprogram/utils/admin.js`
- `README.md`
- `docs/codex/HANDOFF.md`

### Cloud-function entry policy

Every name below means the exact path `cloudfunctions/<name>/index.js`. Task 1 records the same names in `scripts/auth-v2-entry-policy.json`; generated shared copies use `cloudfunctions/<name>/lib/auth/<module>.js` only when that entry's policy enables the module.

- **Session-protected target entries in the 93-file identity baseline (67):** `login`, `deleteAccount`, `getUserBilling`, `getUserProfile`, `markFirstLogin`, `saveUserProfile`, `addComment`, `createPost`, `getFeed`, `getFollows`, `getPostDetail`, `toggleFollow`, `toggleLike`, `cancelJoin`, `cancelMatch`, `createMatchPost`, `getMyJoins`, `getMyMatches`, `joinMatch`, `addTraining`, `cancelBooking`, `createBooking`, `getMyBookings`, `getCoachBookings`, `getCoachLessons`, `getCoachProfile`, `getCoachStudents`, `getDayDetail`, `getHeatmap`, `getMemberCheckins`, `getMembers`, `getMyMembers`, `linkMember`, `saveCoachProfile`, `addShopCoach`, `applyCoachShopBinding`, `getCoachBindingApplications`, `getLinkableCoaches`, `getMyCoachShopBindingStatus`, `getShopCoaches`, `removeShopCoach`, `reviewCoachBindingApplication`, `getCoachSettlementDetail`, `getShopApplicationStatus`, `getShopBrands`, `getShopCoachSettlement`, `getShopMembers`, `getShopProfile`, `getShopStores`, `saveShopBrand`, `saveShopProfile`, `saveShopStore`, `settleCoach`, `submitShopApplication`, `createSession`, `createTableOrder`, `genTableCheckoutCode`, `getMyCheckinStatus`, `getPendingCheckins`, `getSessions`, `getShopBizOverview`, `getTableParticipants`, `getTodayRevenue`, `markTableOrderExternalPaid`, `requestCheckin`, `resolveCheckin`, `cancelRecurringContract`.
- **Action/purpose-aware authentication entries (3):** `accountAuth`, `sendEmailCode`, `sendSmsCode`.
- **Retired target entries in the 93-file identity baseline (2):** `verifySmsCode`, `reconcilePay`.
- **Independent admin boundary (7):** `adminLogin`, `getAdminCoaches`, `getAdminMembers`, `getAdminStatus`, `getAdminStores`, `getPendingShopApplications`, `reviewShopApplication`.
- **Public read boundary (4):** `getBrands`, `getMemberProfile`, `getStores`, `getTableCheckoutOrder`.
- **Signed payment/subscription callbacks in the 93-file scan (4):** `payCallback`, `recurringContractCallback`, `recurringDebitCallback`, `virtualPayCallback`.
- **Timer boundary in the 93-file scan (4):** `purgeDeletedAccounts`, `reconcileTableFinance`, `reconcileTablePayments`, `settleTableProfitSharing`.
- **Mixed user/timer boundary (1):** `requestTableRefund`.
- **Session owner plus platform payer OPENID (1):** `createTablePayOrder`.
- **Additional current entries absent from the 93-file scan (14):** session/guarded `closeSession`, `genCheckinCode`, `getMatchJoiners`, `recordVerifiedTraining`; public/guarded `getCoaches`, `getHalls`, `getMatchPosts`; retired/guarded `createPayOrder`, `createRecurringContract`, `createRecurringDebit`, `createVirtualPayOrder`, `upgradePlan`; signed callbacks `tablePayNotifyV3`, `tableRefundNotifyV3`.
- **Planned new timer entry (1):** `purgeAuthArtifacts`, present in policy/matrix from Task 1 with `planned:true`, then created and flipped to `planned:false` in Task 5.

The immutable baseline records 107 current entry directories. The target policy covers 108 entries, including the planned cleanup timer; after Task 5 the actual directory total is 108. The 93/109 values remain historical baseline evidence and are never reinterpreted as final residual-scan counts.

### Payment shared/deployed files requiring account ownership migration

- `cloudfunctions/_shared/table-payment/table-payment.js`
- `cloudfunctions/_shared/table-payment/payment-transition.js`
- `cloudfunctions/_shared/table-refund/table-refund.js`
- `cloudfunctions/_shared/table-refund/cloudbase-refund-store.js`
- `cloudfunctions/_shared/table-profit-sharing/table-profit-sharing.js`
- `cloudfunctions/createTablePayOrder/lib/table-payment.js`
- `cloudfunctions/createTablePayOrder/lib/payment-transition.js`
- `cloudfunctions/reconcileTablePayments/lib/table-payment.js`
- `cloudfunctions/reconcileTablePayments/lib/payment-transition.js`
- `cloudfunctions/requestTableRefund/lib/table-refund/table-refund.js`
- `cloudfunctions/requestTableRefund/lib/table-refund/cloudbase-refund-store.js`
- `cloudfunctions/tablePayNotifyV3/lib/table-payment.js`
- `cloudfunctions/tablePayNotifyV3/lib/payment-transition.js`
- `cloudfunctions/tableRefundNotifyV3/lib/table-refund/table-refund.js`
- `cloudfunctions/tableRefundNotifyV3/lib/table-refund/cloudbase-refund-store.js`
- `cloudfunctions/settleTableProfitSharing/lib/table-profit-sharing/table-profit-sharing.js`

### Existing tests modified

- `tests/accountWechatBinding.test.js`
- `tests/smsLogin.test.js`
- `tests/loginMethods.test.js`
- `tests/registerAccountRules.test.js`
- `tests/emailRecovery.test.js`
- `tests/coachMemberCompatibility.test.js`
- `tests/accountDeletionGracePeriod.test.js`
- `tests/adminVisibility.test.js`
- `tests/adminPortal.test.js`
- `tests/saveUserProfile.test.js`
- `tests/profileAvatarEdit.test.js`
- `tests/profileHeaderRole.test.js`
- `tests/matchGameTypes.test.js`
- `tests/matchCardLayout.test.js`
- `tests/becomeCoachApplication.test.js`
- `tests/avatarPropagation.test.js`
- `tests/coachProfileSettingsBinding.test.js`
- `tests/coachCommissionRetirement.test.js`
- `tests/shopQualificationApply.test.js`
- `tests/shopSubscriptionPlans.test.js`
- `tests/tableCheckinAccess.test.js`
- `tests/tableCodeCheckin.test.js`
- `tests/tableCheckoutToken.test.js`
- `tests/tableSessionOrderFlow.test.js`
- `tests/tablePaymentBackend.test.js`
- `tests/tableReporting.test.js`
- `tests/tableRefunds.test.js`
- `tests/tableProfitSharing.test.js`
- `tests/tableReconciliation.test.js`
- `tests/cloudSharedParity.test.js`
- `tests/tablePaymentDeployment.test.js`
- `tests/recurringCloudFunctions.test.js`
- `tests/recurringSubscriptionGuard.test.js`
- `tests/legacyBillingRetirement.test.js`

---

### Task 1: Freeze the migration matrix and trust-boundary manifest

**Files:**

- Create: `docs/auth-v2-migration-matrix.md`
- Create: `scripts/auth-v2-entry-policy.json`
- Create: `tests/fixtures/auth-v2-identity-baseline.json`
- Create: `tests/authMigrationMatrix.test.js`

**Interfaces:**

- `scripts/auth-v2-entry-policy.json` schema:

```json
{
  "schemaVersion": 1,
  "modules": {
    "protocol-guard": {
      "source": "cloudfunctions/_shared/auth/protocol-guard.js",
      "availableFromTask": 2
    },
    "keyring": {
      "source": "cloudfunctions/_shared/auth/keyring.js",
      "availableFromTask": 3
    },
    "identifiers": {
      "source": "cloudfunctions/_shared/auth/identifiers.js",
      "availableFromTask": 3
    },
    "password": {
      "source": "cloudfunctions/_shared/auth/password.js",
      "availableFromTask": 3
    },
    "session": {
      "source": "cloudfunctions/_shared/auth/session.js",
      "availableFromTask": 3
    },
    "sms": {
      "source": "cloudfunctions/_shared/auth/sms.js",
      "availableFromTask": 4
    }
  },
  "entries": [
    {
      "name": "getUserProfile",
      "boundary": "session",
      "protocolGuard": "client",
      "session": "required",
      "planned": false,
      "copies": [
        {
          "module": "protocol-guard",
          "destination": "cloudfunctions/getUserProfile/lib/auth/protocol-guard.js"
        },
        {
          "module": "keyring",
          "destination": "cloudfunctions/getUserProfile/lib/auth/keyring.js"
        },
        {
          "module": "session",
          "destination": "cloudfunctions/getUserProfile/lib/auth/session.js"
        }
      ],
      "batch": "personal-social",
      "focusedTests": ["tests/saveUserProfile.test.js"]
    }
  ]
}
```

- Allowed `boundary`: `session | auth | admin | public | callback | timer | mixed | session_payer | retired`.
- Allowed `protocolGuard`: `client | none | branch`; callbacks and timers must be `none`, and only a branch-described mixed entry may use `branch`.
- Allowed `session`: `required | none | action | purpose | branch`. `accountAuth` uses action lists, `sendSmsCode/sendEmailCode` use purpose lists, and `requestTableRefund` uses mutually exclusive user/timer branches.
- Every deployed copy is an explicit `{module,destination}` record; sync code may not infer destinations from a wildcard or an unlisted directory.
- Copy lists must include the actual local dependency closure: every `session` or `sms` destination also has the corresponding same-directory `keyring` destination. Tests derive this from the implemented `require()` graph and reject a deployable copy with a missing local dependency.
- `availableFromTask` allows Task 1 to freeze the final copy allowlist before every source exists. The sync script requires an explicit `-Modules` list and rejects a requested module whose source is not yet present; parity tests check every module whose availability task has been completed.
- `requestTableRefund.branches.user` is `protocolGuard:client/session:required`; `branches.timer` is `protocolGuard:none/session:none` and selects only exact `reconcileTableRefundsTimer` metadata with no trusted caller OPENID.
- `accountAuth.anonymousActions`: `probe`, `registerAccountName`, `loginPassword`, `loginSms`, `loginWechat`, `verifyWechatEntryPhone`, `completeWechatEntry`, `resetPasswordByWechat`, `resetPasswordByEmail`.
- `accountAuth.sessionActions`: `status`, `reauthenticate`, `bindPhone`, `setAccountName`, `setPassword`, `bindWechat`, `logoutCurrent`, `logoutOthers`, `bindEmail`; `recentAuthActions`: `bindPhone`, `setAccountName`, `setPassword`, `bindWechat`, `logoutOthers`.
- `sendSmsCode.anonymousPurposes`: `login`, `wechat_entry`; `sessionPurposes`: `bind_phone`, `reauth`. `sendEmailCode.anonymousPurposes`: `reset`; `sessionPurposes`: `bind`, `reauth`.
- `login` is `boundary:session`; `verifySmsCode` and `reconcilePay` are `boundary:retired`.
- All seven `retired` entries use `session:none` and copy only `protocol-guard`: old/missing protocols receive `CLIENT_UPDATE_REQUIRED`, while protocol-v2 calls return the fixed retirement response with zero business reads/writes.
- `docs/auth-v2-migration-matrix.md` columns: entry/collection, current identity key, v2 identity key, boundary, read/write foreign keys, focused tests, release batch, status.

- [ ] **Step 1: Write the inventory contract test**

First capture the exact current lists in `tests/fixtures/auth-v2-identity-baseline.json`: 107 current entry paths, the 93 entry hits and 109 total JavaScript hits for `getWXContext\(|wechat_bindings|_openid`, plus the 16 payment copies. `tests/authMigrationMatrix.test.js` asserts the fixture counts and uniqueness, asserts every current entry occurs exactly once in policy, permits only the one planned missing entry `purgeAuthArtifacts`, validates all action/purpose/branch rules and explicit copy destinations, and verifies every matrix collection row contains exact old fields, exact new fields and an allowlist reason for any retained `payerOpenid` or independent admin OPENID. It freezes the exact member set of all nine boundaries, every entry's exact module allowlist/release batch/focused tests, and policy-to-matrix consistency; aggregate copy sentinels are `protocol-guard=97`, `keyring=76`, `identifiers=2`, `password=1`, `session=76`, `sms=2`, total `254`, so neither missing nor surplus deployed modules can pass.

Generate those three path lists from the repository root with this exact boundary and store sorted forward-slash repo-relative paths in the fixture:

```powershell
$root = (Resolve-Path .).Path
$entryIndexes = @(Get-ChildItem -LiteralPath cloudfunctions -Directory | ForEach-Object {
  $path = Join-Path $_.FullName 'index.js'
  if (Test-Path -LiteralPath $path) { $path.Substring($root.Length + 1) -replace '\\', '/' }
} | Sort-Object)
$directIdentityEntries = @($entryIndexes | Where-Object {
  Select-String -LiteralPath $_ -Pattern 'getWXContext\(|wechat_bindings|_openid' -Quiet
})
$allIdentityJs = @(rg -l --no-ignore --glob '*.js' --glob '!**/node_modules/**' --glob '!**/.agents/**' 'getWXContext\(|wechat_bindings|_openid' cloudfunctions |
  ForEach-Object { $_ -replace '\\', '/' } | Sort-Object)
```

The 109-file boundary includes every current `.js` file below `cloudfunctions`, including checked-in shared and deployed generated copies; it excludes `node_modules`, `.agents`, tests, docs and files outside `cloudfunctions`, does not follow symlinks, and does not depend on ignore-file contents. The fixture test reruns this exact scan and compares the complete path arrays, not counts alone. The separate 16-payment-copy allowlist is also stored as exact sorted paths.

- [ ] **Step 2: Run the test and confirm RED**

Run: `node tests/authMigrationMatrix.test.js`

Expected: FAIL because the baseline fixture, policy and matrix do not exist.

- [ ] **Step 3: Create the exact policy and matrix**

Use the File Map classifications. Add collection rows for every authentication collection and every business collection discovered from the 107 entries. Use these fixed ownership mappings:

```text
_openid          -> semantic per-collection account field
authorOpenid     -> authorAccountId
memberOpenid     -> memberAccountId
coachOpenid      -> coachAccountId
shopOpenid       -> shopAccountId
targetOpenid     -> targetAccountId
payerOpenid      -> payerOpenid (platform-only, never ownership)
reviewedBy       -> semantic reviewer principal
```

The matrix must name the field by its business role, not mechanically by the legacy spelling. Fixed social/match cases are: `posts._openid -> authorAccountId`; `post_comments.authorOpenid -> authorAccountId`; `post_likes._openid -> accountId`; `user_follows._openid -> followerAccountId`; `user_follows.authorOpenid -> targetAccountId`; `matches._openid -> ownerAccountId`; `match_joins._openid -> memberAccountId`. Elsewhere `_openid` becomes the exact semantic field such as `accountId`, `ownerAccountId`, `applicantAccountId`, `coachAccountId`, `shopAccountId` or `memberAccountId` according to the collection's authorization role.

Reviewer and payer fields are also context-bound: `coach_shop_applications.reviewedBy -> reviewerAccountId` because a shop-owner session performs that review, while `shop_applications.reviewedBy -> independent admin principal id`. `orders`, `subscriptions` and `shop_orders` retain `payerOpenid` only for WeChat platform payment parameters or signed historical callback reconciliation; the matrix allowlist must state that it never authorizes ownership, lookup, refund or cross-account access.

Collection discovery recursively follows checked-in JavaScript below each of the 107 entry directories, excluding `node_modules`, so local `lib/**` access paths are not lost. This includes `finance_reconciliation_runs`, `shop_payment_profiles`, `shop_refunds` and `wechat_bill_artifacts` when present in the current call graph.

Every row begins `pending`; no row may contain an unfinished-work marker, a wildcard path, or an empty focused-test cell. Add `purgeAuthArtifacts` as `timer / protocolGuard:none / session:none / planned:true` even though its directory is created later.

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run: `node tests/authMigrationMatrix.test.js`

Expected: PASS with `CURRENT_ENTRY_TOTAL=107`, `TARGET_POLICY_TOTAL=108`, `PLANNED_MISSING=1`, `BASELINE_DIRECT_IDENTITY_ENTRIES=93`, `BASELINE_ALL_IDENTITY_JS=109`, `UNCLASSIFIED=0`.

- [ ] **Step 5: Commit only the inventory files**

```powershell
git add -- docs/auth-v2-migration-matrix.md scripts/auth-v2-entry-policy.json tests/fixtures/auth-v2-identity-baseline.json tests/authMigrationMatrix.test.js
git diff --cached --name-only
git commit --only -m "docs: inventory auth v2 trust boundaries" -- docs/auth-v2-migration-matrix.md scripts/auth-v2-entry-policy.json tests/fixtures/auth-v2-identity-baseline.json tests/authMigrationMatrix.test.js
```

---

### Task 2: Add a backward-compatible protocol and maintenance guard

**Files:**

- Create: `cloudfunctions/_shared/auth/protocol-guard.js`
- Create: `scripts/sync-auth-libs.ps1`
- Create: `scripts/package-auth-guard-checkpoint.ps1`
- Create: `tests/authProtocolGuard.test.js`
- Create: `tests/authSharedParity.test.js`
- Create: `tests/authGuardCheckpoint.test.js`
- Modify: `tests/authMigrationMatrix.test.js` to implement the committed-policy `--print-protocol-client-paths` CLI consumed by this task
- Modify: the exact entry paths emitted by `node tests/authMigrationMatrix.test.js --print-protocol-client-paths`; the command reads the committed policy, prints one concrete path per line plus count/SHA-256, and includes mixed-entry user branches without adding callback/timer paths

**Interfaces:**

```js
const AUTH_CONTROL_ID = 'main';

async function guardClientRequest({ db, event, supportedSchemaVersions }) {
  // -> { ok:true, clientProtocol, control }
  // -> { ok:false, code:'AUTH_MAINTENANCE'|'CLIENT_UPDATE_REQUIRED'|'AUTH_INTERNAL_ERROR', msg }
}
```

- Missing `event.authProtocol` is protocol 1 only while `minClientProtocol <= 1`.
- `auth_control/main` is mandatory; missing/malformed configuration fails closed.
- `maintenance:true` blocks client authentication, public, session, admin and retired client entry calls before database reads or writes other than `auth_control`.
- Outside maintenance, the effective client protocol must equal `auth_control.schemaVersion` and be present in `supportedSchemaVersions`; protocol 2 can never execute schema-1 business behavior merely by claiming a higher number.
- Signed callbacks and timers do not accept client protocol and do not call this guard.
- A `protocolGuard:"branch"` entry first classifies the trusted timer branch without a business database access; only its user branch calls `guardClientRequest` before the first business read or write.

- [ ] **Step 1: Write protocol and parity RED tests**

Cover missing/malformed control, v1 compatibility, v2 acceptance, maintenance, minimum protocol, exact protocol/schema equality, unsupported schema version, database failure, and exact error projection. Static assertions must prove each `client` policy entry calls the local copied guard before its first business database read or write, each `none` entry does not trust `event.authProtocol`, and the mixed refund entry has separately tested user/timer control flow. The checkpoint test must prove packaging reads the same 97-path policy allowlist, excludes `node_modules`, secrets and unrelated files, contains each guarded function's complete deployable source directory, and writes a file manifest plus SHA-256 for the ZIP.

Before touching entry files, add a RED CLI contract for `--print-protocol-client-paths`: flag mode must emit the 97 sorted repo-relative `cloudfunctions/<entry>/index.js` paths, then exactly `PROTOCOL_CLIENT_COUNT=97` and `PROTOCOL_CLIENT_SHA256=<64 lowercase hex>` computed from the newline-joined path list. Normal test mode keeps the existing inventory summary.

Run: `node tests/authMigrationMatrix.test.js --print-protocol-client-paths`

Expected: 97 concrete entry paths, `PROTOCOL_CLIENT_COUNT=97` and a nonempty `PROTOCOL_CLIENT_SHA256`; this comprises 96 `client` entries plus the mixed refund entry's user branch. Save the output in the Task 2 review record and modify no path outside it.

- [ ] **Step 2: Run tests and confirm RED**

Run: `node tests/authProtocolGuard.test.js`

Run: `node tests/authSharedParity.test.js`

Run: `node tests/authGuardCheckpoint.test.js`

Expected: FAIL because the shared module, sync/package scripts and deployed copies do not exist.

- [ ] **Step 3: Implement and sync the guard**

`scripts/sync-auth-libs.ps1` must read only the committed policy, validate every source/destination remains under the repository without reparse points, reject unknown module names, and copy only explicit destinations. Update each client entry with this ordering:

```js
const { guardClientRequest } = require('./lib/auth/protocol-guard');

exports.main = async (event = {}) => {
  const gate = await guardClientRequest({ db, event, supportedSchemaVersions: [1] });
  if (!gate.ok) return gate;
  // existing v1-compatible behavior follows until its migration task
};
```

For `requestTableRefund`, keep timer detection in a pure helper that validates exact timer metadata plus absent caller OPENID. The timer branch bypasses the client guard; every other request is the user branch and must pass the guard. Task 12 later adds `requireSession` to that user branch.

Do not alter ownership semantics in this task. Mark only `protocol_guarded` rows complete in the matrix.

Because the current `HEAD` intentionally does not contain the repository's full staged business baseline, a Task 2 Git commit alone is not a reconstructable deployable tree. After the tests pass and before Task 3 changes any v1 behavior, run `scripts/package-auth-guard-checkpoint.ps1`; it writes `.superpowers/sdd/auth-v2-guard-v1-compat.zip` and `.sha256` without modifying source or the Git index. Preserve that immutable artifact for Task 14, or deploy the compatibility guard immediately if the target environment is available.

- [ ] **Step 4: Run sync and focused tests**

Run: `& .\scripts\sync-auth-libs.ps1 -Modules protocol-guard`

Expected: `STATUS=PASS` and an exact copy count equal to policy destinations.

Run: `node tests/authProtocolGuard.test.js`

Run: `node tests/authSharedParity.test.js`

Run: `node tests/authGuardCheckpoint.test.js`

Run: `& .\scripts\package-auth-guard-checkpoint.ps1`

Expected: tests PASS and the script reports the artifact path, guarded-function count and SHA-256.

- [ ] **Step 5: Commit the compatibility checkpoint with exact pathspecs**

Stage the shared module, policy-generated copies, the exact modified entry files, tests, scripts, and matrix. Verify the staged list contains no unrelated path, then use `git commit --only`. Treat the commit as a review checkpoint; use only the verified Task 2 ZIP (or an immediate Task 2 deployment) as the later deployable v1-compatible source snapshot.

---

### Task 3: Implement keyring, identifiers, password, and session primitives

**Files:**

- Create: `cloudfunctions/_shared/auth/keyring.js`
- Create: `cloudfunctions/_shared/auth/identifiers.js`
- Create: `cloudfunctions/_shared/auth/password.js`
- Create: `cloudfunctions/_shared/auth/session.js`
- Create: `tests/authPrimitives.test.js`
- Create: `tests/authSessions.test.js`
- Modify: `scripts/sync-auth-libs.ps1`
- Modify: `tests/authSharedParity.test.js`

**Interfaces:**

```js
// keyring.js
loadKeyring(env) // -> {activeVersion,historicalVersions,keys}; throws AUTH_CONFIG_INVALID
deriveKey(keyring, version, purpose) // -> Buffer(32)
versionedHmacId(keyring, purpose, value, prefix) // -> '<prefix>.<version>.<hmac>'
candidateHmacIds(keyring, purpose, value, prefix) // -> [{id,keyVersion,isActive}]

// identifiers.js
normalizePhone(value)              // mainland input -> +86 E.164 or throws INVALID_PHONE
normalizeAccountName(value)        // ASCII 4-20, letter first, lowercase lookup
newAccountId(randomBytes)           // internal only, acct_<base64url>, >=128 random bits
wechatIdentity(wxContext)           // trusted APPID + OPENID, optional UNIONID audit hash input

// password.js
hashPassword(password, randomBytes)
verifyPasswordOrDummy(password, account)

// session.js
issueSession({ transaction, account, clientInstanceId, method, now, keyring }) // -> {sessionToken,sessionRecord}
requireSession({ db, event, now, keyring }) // -> SessionContext | SESSION_REQUIRED | SESSION_EXPIRED
revokeCurrentSession({ transaction, session, now, reason }) // -> {kind:'session_revoked'}
rotateCurrentSession({ transaction, account, session, now, keyring, reason }) // -> {kind:'session_rotated',sessionToken}
revokeOtherSessions({ transaction, account, currentSession, now, keyring }) // -> rotated response
requireRecentAuthentication(session, now) // -> true | RECENT_AUTH_REQUIRED
```

- [ ] **Step 1: Write pure primitive RED tests**

Test phone and account-name normalization, namespace separation, at least 32-byte decoded master keys, HKDF purpose separation, active plus historical candidate IDs, unsafe historical key removal rejection, random account IDs, fixed scrypt parameters, malformed hashes, constant-length dummy verification and absence of raw secrets in serialized results.

- [ ] **Step 2: Write session RED tests**

Test that only token HMAC is stored; raw token is returned once; valid sessions load live `accounts` and `users`; missing, revoked, idle-expired, absolute-expired, disabled, auth-version-mismatched and malformed sessions fail closed; roles are live; activity updates `lastSeenAt/idleExpiresAt` without changing `authenticatedAt/absoluteExpiresAt`; current logout, other-session revocation and current rotation use the authenticated session document rather than `clientInstanceId`.

- [ ] **Step 3: Run tests and confirm RED**

Run: `node tests/authPrimitives.test.js`

Run: `node tests/authSessions.test.js`

Expected: FAIL because the primitive modules do not exist.

- [ ] **Step 4: Implement the exact cryptographic formats**

Use environment format; versions must match `^[A-Z0-9_]+$`, every decoded key is at least 32 random bytes, and the historical list is explicit:

```text
CUETRACE_AUTH_KEY_ACTIVE_VERSION=K2
CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS=K1
CUETRACE_AUTH_KEY_K2=<base64-encoded 32+ random bytes>
CUETRACE_AUTH_KEY_K1=<historical base64-encoded 32+ random bytes>
```

Use `crypto.hkdfSync('sha256', masterKey, Buffer.from('cuetrace-auth-v2'), Buffer.from(purpose), 32)`. Persistent phone/WeChat resolvers try active then configured historical IDs inside a transaction and, only after the corresponding credential is freshly verified plus full relationship validation, create the active binding, update the account reverse reference and mark the historical binding inactive. Session tokens use `v2.<keyVersion>.<base64url(32 random bytes)>`; the version prefix contains no claims and only selects the HMAC key.

- [ ] **Step 5: Implement session semantics**

`requireSession` returns exactly `{ accountId, account, user, roles, session, sessionRef }`; it never returns the raw token. Idle expiry is `lastSeenAt + 30 days`, absolute expiry is creation + 90 days, and activity writes are throttled to once per 6 hours. Any integrity mismatch returns `SESSION_EXPIRED` except a missing token, which returns `SESSION_REQUIRED`.

- [ ] **Step 6: Sync, test, and commit**

Run: `& .\scripts\sync-auth-libs.ps1 -Modules keyring,identifiers,password,session`

Run: `node tests/authPrimitives.test.js`

Run: `node tests/authSessions.test.js`

Run: `node tests/authSharedParity.test.js`

Expected: PASS. Commit only the listed sources, deployed copies, sync script and tests with message `feat: add auth v2 cryptographic primitives`.

---

### Task 4: Rebuild SMS challenges, delivery claims, and rate limits

**Files:**

- Create: `cloudfunctions/_shared/auth/sms.js`
- Modify: `cloudfunctions/sendSmsCode/index.js`
- Modify: `tests/smsLogin.test.js`
- Modify: `scripts/sync-auth-libs.ps1`
- Modify: `tests/authSharedParity.test.js`

**Interfaces:**

```js
sendSmsCode({ phone, purpose, clientInstanceId, authProtocol, sessionToken? })
// -> { ok:true, challengeId, expiresIn:300, resendAfter:60 }

claimSmsChallenge({ transaction, phone, purpose, scope, wxIdentity, now, keyring })
finalizeSmsSend({ transaction, claim, providerResult, now, keyring })
consumeSmsChallenge({ transaction, challengeId, code, expectedPurpose, expectedScope, now, keyring })
```

- [ ] **Step 1: Replace old SMS assumptions with RED tests**

Keep and adapt concurrency tests for atomic cooldown, failed provider delivery, replacement, five wrong attempts and consume-once. Add first-missing-document throwing semantics, random 128-bit challenge IDs, HMAC document IDs, E.164 normalization, four purposes, scope mismatch, global phone cooldown, phone 10/24h, trusted WeChat 30/24h, global generation, `pending/failed/superseded` rejection, provider timeout and no raw phone/code/secret in database, response or logs.

Replace these old expectations:

- Unbound WeChat consuming a login code now creates/restores a phone account in Task 5.
- SMS login never writes `users.phone`.
- `verifySmsCode` is no longer the v2 consumer.

- [ ] **Step 2: Run the SMS test and confirm RED**

Run: `node tests/smsLogin.test.js`

Expected: FAIL against the old deterministic `OPENID + phone` record and missing-document bug.

- [ ] **Step 3: Implement action authorization and atomic claims**

`login` is anonymous after protocol/consent checks; `wechat_entry` must bind trusted `(APPID,OPENID)` and client instance; `bind_phone` requires a session and current `accountId`; `reauth` requires a session, the entered phone HMAC to equal the account's existing `phoneBindingId`, and the current session ID in scope. A single transaction increments global phone generation and both 24-hour counters before supplier I/O.

Change `sendSmsCode` from the Task 2 `[1]` compatibility declaration to `supportedSchemaVersions:[2]`; the saved guard ZIP remains the only v1 source.

- [ ] **Step 4: Implement provider finalization**

Write a `pending` challenge before calling Tencent Cloud SMS. On confirmed `sent`, write the code HMAC and 5-minute expiry only if claim/generation is still current. On provider failure, mark `failed`, keep the counted attempt and cooldown, remove `codeHash`, and return only `SMS_SEND_FAILED`.

- [ ] **Step 5: Run sync and focused tests**

Run: `& .\scripts\sync-auth-libs.ps1 -Modules sms`

Run: `node tests/smsLogin.test.js`

Run: `node tests/authSharedParity.test.js`

Expected: PASS.

- [ ] **Step 6: Commit only the SMS task files**

Use exact pathspecs and message `feat: add scoped sms auth challenges`.

---

### Task 5: Rebuild account actions, sessions, WeChat consent, and role selection

**Files:**

- Modify: `cloudfunctions/accountAuth/index.js`
- Create: `cloudfunctions/accountAuth/lib/account-actions.js`
- Create: `cloudfunctions/accountAuth/lib/wechat-actions.js`
- Create: `cloudfunctions/accountAuth/lib/security-actions.js`
- Create: `cloudfunctions/accountAuth/lib/store.js`
- Modify: `cloudfunctions/login/index.js`
- Modify: `cloudfunctions/verifySmsCode/index.js`
- Create: `cloudfunctions/purgeAuthArtifacts/index.js`
- Create: `cloudfunctions/purgeAuthArtifacts/package.json`
- Create: `cloudfunctions/purgeAuthArtifacts/config.json`
- Modify: `scripts/auth-v2-entry-policy.json`
- Modify: `docs/auth-v2-migration-matrix.md`
- Modify: `tests/authMigrationMatrix.test.js`
- Modify: `tests/accountWechatBinding.test.js`
- Modify: `tests/registerAccountRules.test.js`
- Modify: `tests/coachMemberCompatibility.test.js`
- Modify: `tests/accountDeletionGracePeriod.test.js`
- Modify: `tests/authSessions.test.js`

**Interfaces:**

`accountAuth` action map is fixed to:

```text
probe
registerAccountName
loginPassword
loginSms
loginWechat
verifyWechatEntryPhone
completeWechatEntry
status
reauthenticate
bindPhone
setAccountName
setPassword
bindWechat
logoutCurrent
logoutOthers
resetPasswordByWechat
resetPasswordByEmail
bindEmail
```

`login` becomes session-backed role selection: `{ role, authProtocol:2, sessionToken } -> RoleSelectedResponse`. `verifySmsCode` always returns `CLIENT_UPDATE_REQUIRED` after the protocol gate and performs zero business reads/writes.

Client response unions are exact:

```js
// Internal accountId never appears in a client response.
SessionIssuedResponse = {
  ok: true, kind: 'session_issued', sessionToken,
  account: '', accountDisplay: '', roles: [], currentRole: 'member',
  authenticatedAt: 0, authenticationMethod: 'sms|password|wechat'
};
SessionRotatedResponse = {
  ok: true, kind: 'session_rotated', sessionToken,
  account: '', accountDisplay: '', roles: [], currentRole: 'member'
};
WechatPhoneProofResponse = {
  ok: true, kind: 'wechat_phone_proof', proofToken, expiresIn: 300
};
SecurityStatusResponse = {
  ok: true, kind: 'security_status',
  account: '', accountNameSet: false, passwordSet: false,
  phoneBound: false, phoneMasked: '', emailBound: false, emailMasked: '',
  wechatBound: false,
  roles: [], currentRole: 'member',
  reauthMethods: [],
  currentSession: {
    authenticatedAt: 0, authenticationMethod: '', createdAt: 0,
    lastSeenAt: 0, idleExpiresAt: 0, absoluteExpiresAt: 0
  },
  otherSessionCount: 0
};
ProbeResponse = { ok: true, kind: 'probe' };
ReauthenticatedResponse = {
  ok: true, kind: 'reauthenticated', authenticatedAt: 0,
  authenticationMethod: 'sms|password|email|wechat'
};
SecurityMutationResponse = {
  ok: true, kind: 'security_mutation',
  operation: 'bind_phone|set_account_name|bind_wechat|bind_email',
  account: '', accountDisplay: '', accountNameSet: false, passwordSet: false,
  phoneBound: false, phoneMasked: '', emailBound: false, emailMasked: '',
  wechatBound: false
};
PasswordResetResponse = { ok: true, kind: 'password_reset', next: 'login' };
RoleSelectedResponse = {
  ok: true, kind: 'role_selected', account: '', accountDisplay: '',
  roles: [], currentRole: 'member'
};
LogoutResponse = { ok: true, kind: 'session_revoked' };
```

`account` is always the account-name string or `''`; `accountDisplay` is the account name, otherwise masked phone, otherwise `手机号用户`. Database `account_names` continues to store `account/accountNormalized`; client action parameters may use the clearer name `accountName`.

The action-to-response map is closed: `probe -> ProbeResponse`; `registerAccountName|loginPassword|loginSms|completeWechatEntry -> SessionIssuedResponse`; bound `loginWechat -> SessionIssuedResponse`; unbound `loginWechat -> {ok:false,code:'WECHAT_NOT_BOUND',next:'wechat_phone'}`; `verifyWechatEntryPhone -> WechatPhoneProofResponse`; `status -> SecurityStatusResponse`; `reauthenticate -> ReauthenticatedResponse`; `bindPhone|setAccountName|bindWechat|bindEmail -> SecurityMutationResponse` with the matching fixed `operation`; first-time and replacement `setPassword`, plus `logoutOthers`, always return `SessionRotatedResponse`; `logoutCurrent -> LogoutResponse`; `resetPasswordByWechat|resetPasswordByEmail -> PasswordResetResponse`. `login` alone returns `RoleSelectedResponse`. No action may return an unlisted shape or a free-form object.

Only `session_issued` and `session_rotated` return a raw session token. `status`, reauthentication, binding, set-account-name and role selection never return or reconstruct one. `loginWechat` on an unbound trusted WeChat performs zero account/session writes.

- [ ] **Step 1: Write the account-state RED matrix**

Cover random `accountId`, phone OTP auto-create, existing phone restore, account-name/password registration without phone/WeChat, phone or account-name password lookup, uniform invalid credentials, all password rate-limit dimensions, consent versions, disabled/malformed/single-sided relationships, concurrent phone/account-name/WeChat uniqueness and rollback.

Before creating `purgeAuthArtifacts`, change `authMigrationMatrix.test.js` to require the final state `CURRENT_ENTRY_TOTAL=108`, `TARGET_POLICY_TOTAL=108`, `PLANNED_MISSING=0`. This assertion must be RED while the directory is absent and its policy row still has `planned:true`.

- [ ] **Step 2: Write the WeChat proof RED matrix**

Cover bound direct login; unbound `wechat_entry` phone verification returning only a 256-bit five-minute proof; proof bound to purpose, `(APPID,OPENID)`, client instance and the actually accepted terms/privacy versions; cancel (`bindWechat:false`) creating/restoring phone account and session with zero WeChat writes; confirm creating complete bidirectional binding and session; replay/expiry/context/consent mismatch/conflicting account/conflicting WeChat/UnionID conflict all fail closed. Missing UnionID is valid; first trusted UnionID may fill an empty audit hash; a later mismatch records only a redacted security event and never overwrites or merges.

- [ ] **Step 3: Write security and role RED tests**

Cover `status`, set-once account name, bind-once phone/WeChat, password set/change, recent-auth methods, current logout, logout others with current rotation, password authVersion increment, live server roles, and role selection. `clientInstanceId` must not choose which session survives.

Assert the full `SecurityStatusResponse`, exact `reauthMethods` enum (`password | phone | email | wechat`), no token on non-rotation responses, and no internal accountId anywhere in serialized client output. Add a complete scenario in which an account-name/password account binds a phone, then account-name/password, phone/password and phone/SMS all resolve the same server account and business fixture.

- [ ] **Step 4: Run focused tests and confirm RED**

Run: `node tests/accountWechatBinding.test.js`

Run: `node tests/registerAccountRules.test.js`

Run: `node tests/authSessions.test.js`

Run: `node tests/coachMemberCompatibility.test.js`

Run: `node tests/accountDeletionGracePeriod.test.js`

Run: `node tests/authMigrationMatrix.test.js`

Expected: FAIL because v2 actions, collections and session semantics are absent.

- [ ] **Step 5: Implement atomic account and session transactions**

Pre-generate raw session/proof tokens outside transactions. Every action that creates a credential/account and session writes all persistent records plus the session HMAC in one transaction. New documents never include `_id` inside `set({data})`. Map each handler to one response union above; no response returns internal accountId, raw phone, OPENID, password metadata, HMAC IDs or database documents.

Change `accountAuth`, `login` and `verifySmsCode` to `supportedSchemaVersions:[2]`.

Every successful session issuance also cancels a pending account-deletion grace request for that same internal account in the same transaction. Role selection does not perform that cancellation a second time.

- [ ] **Step 6: Implement password rate limiting and recent authentication**

Pure numeric password identifiers enter only the phone namespace; valid letter-leading identifiers enter only the account-name namespace; invalid forms still select a synthetic rate-limit key, execute dummy scrypt and return `INVALID_CREDENTIALS`. Use deterministic HMAC records for `(identifier,wxContext)` 5 failures/15 minutes then 15-minute pause, trusted wxContext 20 failures/15 minutes, and identifier across contexts 30 failures/24 hours then 60-minute pause. `reauthenticate` supports current-account password, `reauth` SMS, bound WeChat and bound email proof; successful reauth updates only the authenticated session and never extends absolute expiry.

- [ ] **Step 7: Implement artifact cleanup and v1 retirement**

`purgeAuthArtifacts` accepts only its named timer event and deletes already-expired SMS challenges, proofs and sessions in bounded pages; authorization expiry remains enforced synchronously even before cleanup. It does not delete accounts, bindings, users or business data. Keep `verifySmsCode` as a zero-write shim.

Create the planned timer directory, change its policy row to `planned:false`, mark its matrix entry implemented, and make `authMigrationMatrix.test.js` assert `CURRENT_ENTRY_TOTAL=108`, `TARGET_POLICY_TOTAL=108`, `PLANNED_MISSING=0` while retaining the immutable 107/93/109 baseline fixture.

- [ ] **Step 8: Run focused regression and commit**

Run: `node tests/accountWechatBinding.test.js`

Run: `node tests/registerAccountRules.test.js`

Run: `node tests/authSessions.test.js`

Run: `node tests/coachMemberCompatibility.test.js`

Run: `node tests/accountDeletionGracePeriod.test.js`

Run: `node tests/authMigrationMatrix.test.js`

Expected: PASS, including `CURRENT_ENTRY_TOTAL=108`, `TARGET_POLICY_TOTAL=108` and `PLANNED_MISSING=0`. Commit only Task 5 files and synced auth copies with message `feat: add independent account and session auth`.

---

### Task 6: Preserve email recovery on internal account IDs

**Files:**

- Modify: `cloudfunctions/sendEmailCode/index.js`
- Modify: `cloudfunctions/accountAuth/lib/security-actions.js`
- Modify: `cloudfunctions/accountAuth/index.js`
- Modify: `tests/emailRecovery.test.js`
- Modify: `tests/authSessions.test.js`

**Interfaces:**

```text
sendEmailCode({ purpose:'reset', email })   // anonymous
sendEmailCode({ purpose:'bind', email })    // session
sendEmailCode({ purpose:'reauth' })         // session; existing binding only
accountAuth.bindEmail({ email, code })
accountAuth.resetPasswordByEmail({ email, code, password })
accountAuth.resetPasswordByWechat({ password })
accountAuth.reauthenticate({ method:'email', code })
```

These are closed request shapes: `reset` and `bind` require exactly one normalized email, while `reauth` forbids an email field or replacement target. Client and server reject missing, surplus or cross-purpose fields before sending or consuming a challenge.

- [ ] **Step 1: Write RED compatibility and revocation tests**

Keep existing email masking, uniqueness, cooldown, five-attempt lock, anti-enumeration, SES timeout and secret-leak tests. Change ownership to internal `accountId`; add session-required binding, bound-email reauth, password reset incrementing `authVersion`, all old sessions invalid after public reset, and WeChat recovery resolving only a complete active v2 binding. Add a phone-only account with no account name, bind its email, then reset by unique verified email and prove the same internal account is updated.

- [ ] **Step 2: Run and confirm RED**

Run: `node tests/emailRecovery.test.js`

Run: `node tests/authSessions.test.js`

Expected: FAIL because current email documents/recovery resolve through old account/OPENID links and do not revoke v2 sessions.

- [ ] **Step 3: Implement v2 email relationships**

`email_bindings.accountId` and the account reverse reference must agree transactionally. Because active email bindings are unique, public reset resolves the target from the verified email challenge and does not require an account name; unknown/inactive targets still use uniform public timing/response. Binding uses the current session account; reauth derives its target only from that account's already bound email and rejects any client-supplied email. Password reset never returns a session and invalidates every existing token through `authVersion`.

Change `sendEmailCode` to `supportedSchemaVersions:[2]`.

- [ ] **Step 4: Run focused tests and commit**

Run: `node tests/emailRecovery.test.js`

Run: `node tests/authSessions.test.js`

Expected: PASS. Commit only Task 6 paths with message `feat: migrate email recovery to account ids`.

---

### Task 7: Add client protocol, session storage, and typed cloud-call boundaries

**Files:**

- Create: `miniprogram/config/auth.js`
- Create: `miniprogram/services/auth-session.js`
- Modify: `miniprogram/app.js`
- Modify: `miniprogram/services/data.js`
- Create: `tests/authClientSession.test.js`

**Interfaces:**

```js
// miniprogram/config/auth.js
AUTH_PROTOCOL = 2
TERMS_VERSION = '2026-07-15'
PRIVACY_VERSION = '2026-07-15'
SESSION_STORAGE_KEY = 'cuetrace_auth_v2_session'
CLIENT_INSTANCE_STORAGE_KEY = 'cuetrace_auth_v2_client'
MIGRATION_STORAGE_KEY = 'cuetrace_auth_v2_migrated'

// miniprogram/services/auth-session.js
getClientInstanceId()
getSession()
beginAuthAttempt(kind)                  // -> { generation, kind }
cancelAuthAttempt(attempt)
commitAuthResult(attempt, result)       // only session_issued, CAS on generation
commitSessionRotation(expectedToken, result) // only session_rotated, CAS on current token
applySessionProjection(expectedToken, result) // CAS on request token; never changes token
clearSessionIfCurrent(expectedToken)    // stale response cannot clear a newer login
migrateLegacyAuthOnce()
sessionEnvelope(payload)
anonymousEnvelope(payload)
```

`data.js` exposes four non-interchangeable wrappers:

```js
callAnonymousAuth(name, payload)
callSessionCloud(name, payload)
callPublicCloud(name, payload)
callAdminCloud(name, payload)
```

Purpose routing is fixed:

```text
sendSmsCode(login|wechat_entry) -> callAnonymousAuth
sendSmsCode(bind_phone|reauth)   -> callSessionCloud
sendEmailCode(reset)             -> callAnonymousAuth
sendEmailCode(bind|reauth)       -> callSessionCloud
```

Email requests are a strict discriminated union: `{purpose:'reset',email}`, `{purpose:'bind',email}` or `{purpose:'reauth'}`. Both client and server reject a missing required email and reject every extra `email` on `reauth`; the latter always targets the current account's existing verified binding. Any other purpose or surplus field fails locally with `INVALID_INPUT`. Wrapper-controlled fields are written after validated payload construction; callers may not supply or overwrite `authProtocol`, `sessionToken`, `clientInstanceId` or the cloud action. `callSessionCloud` snapshots the current token before the request and returns local `SESSION_REQUIRED` without a network call when no token exists.

- [ ] **Step 1: Write client-session RED tests**

Test 256-bit token persistence without logging, stable random client instance ID, one-time removal of exactly `openid`, `role`, `dc_role`, `dc_account_name`, `dc_accounts`, `dc_wechat_bindings`, preservation of theme/subscription/`firstLoginAt`/unrelated settings, v2 protocol on every client wrapper, explicit purpose routing, token only on session calls, no token on admin/public calls, rotated token replacement, and app bootstrap never treating `openid` or cached role as authentication.

Add an integration test with two real data-service auth Promises resolving out of order: attempt B begins after attempt A, B commits first, A resolves last, and A must neither persist its token nor overwrite account/roles. Repeat with mode/tab cancellation. Every session request captures its send-time token: an old status/role response cannot project account/roles into a newer login, an old `SESSION_REQUIRED|SESSION_EXPIRED|ACCOUNT_DISABLED` or logout response cannot clear a newer token, and an old mutation cannot refresh current state. A current status/role response without `sessionToken` preserves the token; a rotation replaces it only when the expected token still matches.

Test centralized error behavior against the request's captured token: `SESSION_REQUIRED`, `SESSION_EXPIRED` and `ACCOUNT_DISABLED` call `clearSessionIfCurrent(expectedToken)` and re-launch login only if that token is still current; `ROLE_NOT_ALLOWED` preserves the token, refreshes server roles and opens the role picker only for the current session; `AUTH_CONFLICT` preserves the token and refreshes status without replaying the write; `CLIENT_UPDATE_REQUIRED` preserves the token and uses `wx.getUpdateManager()` plus a non-cancelable update modal; `AUTH_MAINTENANCE` preserves the token, sets an app-level write block and shows a non-cancelable maintenance modal; `AUTH_INTERNAL_ERROR` fails closed with no mock or state mutation.

- [ ] **Step 2: Run and confirm RED**

Run: `node tests/authClientSession.test.js`

Expected: FAIL because v2 config/storage/wrappers do not exist.

- [ ] **Step 3: Implement storage and app bootstrap**

`migrateLegacyAuthOnce()` removes only the six exact legacy authentication keys listed in Step 1 and records protocol 2 completion. It must not clear theme, subscription, billing display, drafts, `firstLoginAt` or unrelated business settings. `app.globalData.account` remains a string, `accountDisplay` is separate, and roles/currentRole are projections; no internal accountId is stored in global data and authentication is never derived from `openid`.

- [ ] **Step 4: Implement the four call wrappers**

Every client-facing call sends `authProtocol:2` and `clientInstanceId`; only `callSessionCloud` sends `sessionToken`. `anonymousEnvelope` never adds consent fields: login/register methods receive actual consent versions only from a checked page action. Session-issuing methods require an auth attempt and call `commitAuthResult`; ordinary status/role/mutation responses call `applySessionProjection(expectedToken,result)`; password change/logout-others call `commitSessionRotation(expectedToken,result)`; logout and centralized invalid-session handling call `clearSessionIfCurrent(expectedToken)`. Responses/errors are sanitized before logging. Preserve existing demo data helpers, but no cloud authentication failure may switch to a local authenticated state.

- [ ] **Step 5: Run focused tests and syntax checks**

Run: `node tests/authClientSession.test.js`

Run: `node --check miniprogram/config/auth.js`

Run: `node --check miniprogram/services/auth-session.js`

Run: `node --check miniprogram/app.js`

Run: `node --check miniprogram/services/data.js`

Expected: PASS.

- [ ] **Step 6: Commit only the client transport files**

Use message `feat: add mini program auth sessions`.

---

### Task 8: Rebuild the login page around OTP, password, and explicit WeChat consent

**Files:**

- Modify: `miniprogram/pages/login/index.js`
- Modify: `miniprogram/pages/login/index.wxml`
- Modify: `miniprogram/pages/login/index.wxss`
- Modify: `miniprogram/services/data.js`
- Modify: `tests/loginMethods.test.js`
- Modify: `tests/registerAccountRules.test.js`

**Interfaces:**

```js
data.beginAuthAttempt(kind)
data.cancelAuthAttempt(authAttempt)
data.sendSmsCode({ phone, purpose })
data.loginWithSms({ phone, challengeId, code, termsVersion, privacyVersion }, authAttempt)
data.loginWithPassword({ identifier, password, termsVersion, privacyVersion }, authAttempt)
data.registerAccountName({ accountName, password, termsVersion, privacyVersion }, authAttempt)
data.loginWithWechat({ termsVersion, privacyVersion }, authAttempt)
data.verifyWechatEntryPhone({ phone, challengeId, code, termsVersion, privacyVersion })
data.completeWechatEntry({ proofToken, bindWechat, termsVersion, privacyVersion }, authAttempt)
data.sendEmailCode({ purpose:'reset', email })
data.resetPasswordByEmail({ email, code, password })
data.selectRole(role)
```

The login page uses only the data facade to begin and cancel attempts; `data.js` delegates those two calls to `auth-session.js`. It begins an attempt before each of the five session-issuing methods above and passes that exact object as the second argument. A method returns `AUTH_ATTEMPT_STALE` without committing storage if the attempt is absent, mismatched or no longer current. `loginWithWechat` uses the exact unbound contract `{ok:false,code:'WECHAT_NOT_BOUND',next:'wechat_phone'}`.

- [ ] **Step 1: Write login-flow RED tests**

Cover default `验证码登录`, tab labels exactly `验证码登录 / 密码登录`, the auto-create notice, password placeholder `手机号或账号`, fixed “未设置密码可使用验证码登录”, account-name registration, agreement required before OTP send and every login/register/WeChat entry, server roles only, and unified `INVALID_CREDENTIALS` without account enumeration. The page submits exact config versions only after a real checked state; merely importing the config is not consent.

Cover WeChat bound direct login and unbound flow: switch to phone form, send `wechat_entry`, verify to proof, then modal text `是否绑定当前微信？绑定后，后续可直接使用微信登录。`; cancel calls `completeWechatEntry(bindWechat:false)` and logs in, confirm calls `bindWechat:true` and shows the success text.

Every send/login/register/complete button must be single-flight. Starting a newer auth attempt, switching login tab, changing page mode, entering/leaving the WeChat-phone flow, hiding, navigating back or unloading invalidates both page request tokens and the data-layer auth attempt so late success/error cannot mutate page state, show a toast or overwrite a newer session.

- [ ] **Step 2: Run tests and confirm RED**

Run: `node tests/loginMethods.test.js`

Run: `node tests/registerAccountRules.test.js`

Expected: FAIL against the old `账号登录 / 手机号登录`, `verifySmsCode` and automatic WeChat-binding assumptions.

- [ ] **Step 3: Implement the minimal page state machine**

Use modes `login | register | recover | wechatPhone | rolePicker` and login types `sms | password`. Keep the existing visual language and role picker; remove local account lookup and every reference to `dc_wechat_bindings`. A new OTP request replaces the stored `challengeId`; submit is disabled without the current challenge. Treat `result.account` as a string and render `result.accountDisplay` for phone-only accounts, never stringify the response object.

- [ ] **Step 4: Preserve password recovery without leaking identity**

Keep the existing WeChat/email recovery modes but remove the account-name requirement from email recovery: the user submits verified unique email, code and new password. Map all public server failures to non-enumerating copy. Successful public reset clears any local v2 session and returns to password login. Existing email request-token/lifecycle guards remain.

- [ ] **Step 5: Run focused tests and syntax check**

Run: `node tests/loginMethods.test.js`

Run: `node tests/registerAccountRules.test.js`

Run: `node --check miniprogram/pages/login/index.js`

Expected: PASS.

- [ ] **Step 6: Commit only login task paths**

Use message `feat: add phone first account login flows`.

---

### Task 9: Deliver account security, recent authentication, and session controls

**Files:**

- Create: `miniprogram/components/recent-auth/index.js`
- Create: `miniprogram/components/recent-auth/index.json`
- Create: `miniprogram/components/recent-auth/index.wxml`
- Create: `miniprogram/components/recent-auth/index.wxss`
- Create: `miniprogram/pages/settings/account-security/account-name/index.js`
- Create: `miniprogram/pages/settings/account-security/account-name/index.json`
- Create: `miniprogram/pages/settings/account-security/account-name/index.wxml`
- Create: `miniprogram/pages/settings/account-security/account-name/index.wxss`
- Create: `miniprogram/pages/settings/account-security/password/index.js`
- Create: `miniprogram/pages/settings/account-security/password/index.json`
- Create: `miniprogram/pages/settings/account-security/password/index.wxml`
- Create: `miniprogram/pages/settings/account-security/password/index.wxss`
- Create: `miniprogram/pages/settings/account-security/phone-binding/index.js`
- Create: `miniprogram/pages/settings/account-security/phone-binding/index.json`
- Create: `miniprogram/pages/settings/account-security/phone-binding/index.wxml`
- Create: `miniprogram/pages/settings/account-security/phone-binding/index.wxss`
- Modify: `miniprogram/app.json`
- Modify: `miniprogram/pages/settings/account-security/index.js`
- Modify: `miniprogram/pages/settings/account-security/index.json`
- Modify: `miniprogram/pages/settings/account-security/index.wxml`
- Modify: `miniprogram/pages/settings/account-security/index.wxss`
- Modify: `miniprogram/pages/settings/email-binding/index.js`
- Modify: `miniprogram/pages/settings/index.js`
- Modify: `miniprogram/pages/settings/index.wxml`
- Modify: `miniprogram/services/data.js`
- Create: `tests/accountSecurityPage.test.js`
- Modify: `tests/coachProfileSettingsBinding.test.js`

**Interfaces:**

```js
data.getAccountSecurity()
data.sendSmsCode({ phone, purpose:'bind_phone|reauth' })
data.sendEmailCode({ purpose:'bind', email })
data.sendEmailCode({ purpose:'reauth' })
data.reauthenticate({ method, password?, phone?, challengeId?, code? })
data.setAccountName({ accountName })
data.setPassword({ password })
data.bindPhone({ phone, challengeId, code })
data.bindWechat()
data.logoutCurrentSession()
data.logoutOtherSessions()
```

- [ ] **Step 1: Write page and recent-auth RED tests**

Status uses `accountNameSet`, `phoneBound/phoneMasked`, `passwordSet`, `emailBound/emailMasked`, `wechatBound`, `reauthMethods` and device/session summary; the client never masks a raw phone. Test one-time account-name page, password set/change page, one-time phone binding page, explicit WeChat modal, bound credentials becoming display-only, and “退出其他设备”.

Test `RECENT_AUTH_REQUIRED` recovery through current-account password, reauth SMS, bound email and bound WeChat; do not offer a method that depends on the credential currently being added. SMS reauth first calls the session-routed `sendSmsCode({purpose:'reauth'})`; email reauth first calls the session-routed `sendEmailCode({purpose:'reauth'})` to the existing binding without accepting a replacement email. All requests are single-flight and lifecycle guarded.

Use a real `Component` harness to cover `lifetimes.detached`, `pageLifetimes.hide`, a `visible:true -> false` observer, successful `authenticated`, and user `cancel`: every path calls the same `resetSensitiveState()` before hiding or emitting, clears password/code/phone input, cancels active attempt generations and suppresses late callbacks. Reopen after success, cancel and parent-driven close and assert all sensitive fields are empty.

Test settings cache clearing separately: it may remove ordinary cache but must preserve the three v2 auth keys and theme key, while current logout removes only the session/auth projection and retains the stable client instance ID.

- [ ] **Step 2: Run and confirm RED**

Run: `node tests/accountSecurityPage.test.js`

Run: `node tests/coachProfileSettingsBinding.test.js`

Expected: FAIL because password/phone/WeChat actions are toast stubs and pages do not exist.

- [ ] **Step 3: Implement the reusable recent-auth component**

The component accepts only the server-provided method list (`password|phone|email|wechat`), collects the necessary proof, calls the exact purpose-routed send API where needed, calls `data.reauthenticate`, and emits `authenticated` or `cancel`. Its single `resetSensitiveState()` clears password/code/phone, invalidates request generations and runs before either event is emitted, whenever visibility closes, and on hide/detach; reopening must never restore sensitive input. Register it in `pages/settings/account-security/index.json`; the three child pages register it only if they render it directly.

- [ ] **Step 4: Implement credential pages and settings actions**

On `RECENT_AUTH_REQUIRED`, open the component and retry the original action once after success. A password change or logout-others response may rotate the session token; commit the rotation with the expected current token before refreshing status. Current logout calls the server first, then clears local state and re-launches login. “切换身份” uses the current session and role picker rather than signing out. Register exactly `pages/settings/account-security/account-name/index`, `pages/settings/account-security/password/index` and `pages/settings/account-security/phone-binding/index` in `app.json`. `settings.clearCache()` must preserve `cuetrace_auth_v2_session`, `cuetrace_auth_v2_client`, `cuetrace_auth_v2_migrated` and the theme key. `email-binding/index.js` changes only to use the session-routed bind APIs and centralized session-error/lifecycle behavior already covered by its request-token tests.

- [ ] **Step 5: Run focused tests and syntax checks**

Run: `node tests/accountSecurityPage.test.js`

Run: `node tests/coachProfileSettingsBinding.test.js`

Run: `node --check miniprogram/components/recent-auth/index.js`

Run: `node --check miniprogram/pages/settings/account-security/account-name/index.js`

Run: `node --check miniprogram/pages/settings/account-security/password/index.js`

Run: `node --check miniprogram/pages/settings/account-security/phone-binding/index.js`

Run: `node --check miniprogram/pages/settings/account-security/index.js`

Run: `node --check miniprogram/pages/settings/email-binding/index.js`

Run: `node --check miniprogram/pages/settings/index.js`

Expected: PASS.

- [ ] **Step 6: Commit only Task 9 paths**

Use message `feat: add account security credential controls`.

---

### Task 10: Migrate personal profile, social, and match ownership to accountId

**Files:**

- Modify: `cloudfunctions/getUserProfile/index.js`
- Modify: `cloudfunctions/markFirstLogin/index.js`
- Modify: `cloudfunctions/saveUserProfile/index.js`
- Modify: `cloudfunctions/addComment/index.js`
- Modify: `cloudfunctions/createPost/index.js`
- Modify: `cloudfunctions/getFeed/index.js`
- Modify: `cloudfunctions/getFollows/index.js`
- Modify: `cloudfunctions/getPostDetail/index.js`
- Modify: `cloudfunctions/toggleFollow/index.js`
- Modify: `cloudfunctions/toggleLike/index.js`
- Modify: `cloudfunctions/cancelJoin/index.js`
- Modify: `cloudfunctions/cancelMatch/index.js`
- Modify: `cloudfunctions/createMatchPost/index.js`
- Modify: `cloudfunctions/getMyJoins/index.js`
- Modify: `cloudfunctions/getMyMatches/index.js`
- Modify: `cloudfunctions/joinMatch/index.js`
- Modify: `cloudfunctions/getMatchJoiners/index.js`
- Modify: `cloudfunctions/getMatchPosts/index.js`
- Modify: `cloudfunctions/getMemberProfile/index.js`
- Modify: `miniprogram/services/data.js`
- Modify: `miniprogram/pages/community/detail.js`
- Modify: `miniprogram/pages/match/index.js`
- Modify: `miniprogram/pages/match/index.wxml`
- Modify: `miniprogram/pages/match/detail/index.wxml`
- Modify: `miniprogram/pages/player/profile/index.js`
- Modify: `miniprogram/pages/profile/index.js`
- Modify: `miniprogram/pages/profile/qrcode/index.js`
- Modify: `miniprogram/utils/account.js`
- Create: `tests/socialSessionAuth.test.js`
- Create: `tests/matchSessionAuth.test.js`
- Modify: `tests/saveUserProfile.test.js`
- Modify: `tests/profileAvatarEdit.test.js`
- Modify: `tests/profileHeaderRole.test.js`
- Modify: `tests/matchGameTypes.test.js`
- Modify: `tests/matchCardLayout.test.js`

**Interfaces:**

```text
posts.authorAccountId
post_comments.authorAccountId
post_likes.accountId
user_follows.followerAccountId + targetAccountId
matches.ownerAccountId
match_joins.memberAccountId
public profile targetAccountId
```

- [ ] **Step 1: Write cross-credential and horizontal-access RED tests**

For each write/read pair, log the same account in through phone, account-name and WeChat fixtures and assert one shared profile/feed/match record set. Reject absent/forged/expired sessions and another account editing/deleting/liking/canceling owner-only records. Public member profile accepts only `targetAccountId` and projects an explicit safe field allowlist.

- [ ] **Step 2: Run and confirm RED**

Run: `node tests/socialSessionAuth.test.js`

Run: `node tests/matchSessionAuth.test.js`

Run: `node tests/saveUserProfile.test.js`

Run: `node tests/profileAvatarEdit.test.js`

Run: `node tests/profileHeaderRole.test.js`

Run: `node tests/matchGameTypes.test.js`

Run: `node tests/matchCardLayout.test.js`

Expected: FAIL because current ownership uses `_openid/authorOpenid`.

- [ ] **Step 3: Replace authorization and foreign keys**

Every protected entry calls local `requireSession` before business reads/writes. Store only the v2 field names above on schemaVersion 2 records. Do not silently read both owner keys; old test records remain inaccessible until the coordinated test-data reset. Change page navigation/query parameters and `data.js` arguments from openid names to accountId names.

Change every Task 10 client-guarded entry from `[1]` to `supportedSchemaVersions:[2]`.

- [ ] **Step 4: Run the complete personal/social/match focused set**

Run: `node tests/socialSessionAuth.test.js`

Run: `node tests/matchSessionAuth.test.js`

Run: `node tests/saveUserProfile.test.js`

Run: `node tests/profileAvatarEdit.test.js`

Run: `node tests/profileHeaderRole.test.js`

Run: `node tests/matchGameTypes.test.js`

Run: `node tests/matchCardLayout.test.js`

Run: `node tests/authSharedParity.test.js`

Expected: PASS, and `rg -n '_openid|authorOpenid|targetOpenid'` across the modified production files finds no authorization path. Demo-only fixtures are excluded from that assertion.

- [ ] **Step 5: Update matrix rows and commit**

Mark only the corresponding entry/collection rows complete. Commit exact paths with message `refactor: key social ownership by account id`.

---

### Task 11: Migrate training, coach, shop, and admin targets to accountId

**Files:**

- Modify: `cloudfunctions/addTraining/index.js`
- Modify: `cloudfunctions/cancelBooking/index.js`
- Modify: `cloudfunctions/createBooking/index.js`
- Modify: `cloudfunctions/getMyBookings/index.js`
- Modify: `cloudfunctions/getCoachBookings/index.js`
- Modify: `cloudfunctions/getCoachLessons/index.js`
- Modify: `cloudfunctions/getCoachProfile/index.js`
- Modify: `cloudfunctions/getCoachStudents/index.js`
- Modify: `cloudfunctions/getDayDetail/index.js`
- Modify: `cloudfunctions/getHeatmap/index.js`
- Modify: `cloudfunctions/getMemberCheckins/index.js`
- Modify: `cloudfunctions/getMembers/index.js`
- Modify: `cloudfunctions/getMyMembers/index.js`
- Modify: `cloudfunctions/linkMember/index.js`
- Modify: `cloudfunctions/saveCoachProfile/index.js`
- Modify: `cloudfunctions/addShopCoach/index.js`
- Modify: `cloudfunctions/applyCoachShopBinding/index.js`
- Modify: `cloudfunctions/getCoachBindingApplications/index.js`
- Modify: `cloudfunctions/getLinkableCoaches/index.js`
- Modify: `cloudfunctions/getMyCoachShopBindingStatus/index.js`
- Modify: `cloudfunctions/getShopCoaches/index.js`
- Modify: `cloudfunctions/removeShopCoach/index.js`
- Modify: `cloudfunctions/reviewCoachBindingApplication/index.js`
- Modify: `cloudfunctions/getCoachSettlementDetail/index.js`
- Modify: `cloudfunctions/getShopApplicationStatus/index.js`
- Modify: `cloudfunctions/getShopBrands/index.js`
- Modify: `cloudfunctions/getShopCoachSettlement/index.js`
- Modify: `cloudfunctions/getShopMembers/index.js`
- Modify: `cloudfunctions/getShopProfile/index.js`
- Modify: `cloudfunctions/getShopStores/index.js`
- Modify: `cloudfunctions/saveShopBrand/index.js`
- Modify: `cloudfunctions/saveShopProfile/index.js`
- Modify: `cloudfunctions/saveShopStore/index.js`
- Modify: `cloudfunctions/settleCoach/index.js`
- Modify: `cloudfunctions/submitShopApplication/index.js`
- Modify: `cloudfunctions/adminLogin/index.js`
- Modify: `cloudfunctions/getAdminCoaches/index.js`
- Modify: `cloudfunctions/getAdminMembers/index.js`
- Modify: `cloudfunctions/getAdminStatus/index.js`
- Modify: `cloudfunctions/getAdminStores/index.js`
- Modify: `cloudfunctions/getPendingShopApplications/index.js`
- Modify: `cloudfunctions/reviewShopApplication/index.js`
- Modify: `cloudfunctions/getBrands/index.js`
- Modify: `cloudfunctions/getStores/index.js`
- Modify: `cloudfunctions/getCoaches/index.js`
- Modify: `cloudfunctions/getHalls/index.js`
- Modify: `miniprogram/services/data.js`
- Modify: `miniprogram/pages/admin/coaches/index.wxml`
- Modify: `miniprogram/pages/admin/members/index.wxml`
- Modify: `miniprogram/pages/coach/apply/index.js`
- Modify: `miniprogram/pages/coach/member/index.js`
- Modify: `miniprogram/pages/coach/members/index.js`
- Modify: `miniprogram/pages/coach/members/index.wxml`
- Modify: `miniprogram/pages/coach/profile/index.js`
- Modify: `miniprogram/pages/shop/admin/review/index.js`
- Modify: `miniprogram/pages/shop/apply/index.js`
- Modify: `miniprogram/pages/shop/coaches/index.js`
- Modify: `miniprogram/pages/shop/coaches/index.wxml`
- Modify: `miniprogram/pages/shop/coach-settlement/index.js`
- Modify: `miniprogram/pages/shop/coach-settlement/index.wxml`
- Modify: `miniprogram/pages/shop/coach-students/index.js`
- Modify: `miniprogram/pages/shop/coach-students/index.wxml`
- Modify: `miniprogram/pages/shop/dashboard/index.js`
- Modify: `miniprogram/pages/shop/members/index.js`
- Modify: `miniprogram/pages/shop/members/index.wxml`
- Modify: `miniprogram/utils/admin.js`
- Create: `tests/coachShopSessionAuth.test.js`
- Modify: `tests/coachMemberCompatibility.test.js`
- Modify: `tests/becomeCoachApplication.test.js`
- Modify: `tests/avatarPropagation.test.js`
- Modify: `tests/coachProfileSettingsBinding.test.js`
- Modify: `tests/coachCommissionRetirement.test.js`
- Modify: `tests/shopQualificationApply.test.js`
- Modify: `tests/adminVisibility.test.js`
- Modify: `tests/adminPortal.test.js`

**Interfaces:**

```text
training ownerAccountId / coachAccountId / memberAccountId
coach_member_links coachAccountId + memberAccountId
shop_coach_links shopAccountId + coachAccountId
shop_applications applicantAccountId
coach_shop_applications coachAccountId + shopAccountId
settlements shopAccountId + coachAccountId
admin review target accountId; reviewedBy = independent admin id
```

- [ ] **Step 1: Write RED role, scope, and target tests**

Test server-live member/coach/shop roles, own-versus-target access, explicit coach/member/shop relationships, store scope, revoked roles, unrelated account denial and same-account access through all credentials. Admin endpoints keep independent admin authentication but grant/revoke roles and review applications by target `accountId`, never by target OPENID.

Public `getBrands/getStores/getCoaches/getHalls` must project public data only. Replace `ot_test_dachuan_official` ownership with explicit `ownerType:'system'` or an internal configured system account ID; tests must not accept a magic OPENID as authorization. Remove client-side `ADMIN_OPENIDS` as an authorization signal; visibility comes from server admin status and server authorization remains decisive.

- [ ] **Step 2: Run and confirm RED**

Run: `node tests/coachShopSessionAuth.test.js`

Run: `node tests/coachMemberCompatibility.test.js`

Run: `node tests/becomeCoachApplication.test.js`

Run: `node tests/avatarPropagation.test.js`

Run: `node tests/coachProfileSettingsBinding.test.js`

Run: `node tests/coachCommissionRetirement.test.js`

Run: `node tests/shopQualificationApply.test.js`

Run: `node tests/adminVisibility.test.js`

Run: `node tests/adminPortal.test.js`

Expected: FAIL on old coach/member/shop OPENID relations.

- [ ] **Step 3: Migrate server entries and client identifiers by domain**

Apply `requireSession` to user entries and retain admin/public boundaries from the manifest. Change data-service parameters, returned keys, WXML `wx:key/data-*`, page queries and local state from `*Openid` to `*AccountId`. This naming change is required in production paths; demo mock objects may keep their isolated fixture keys and must never be passed to cloud v2 calls.

Change every Task 11 client-guarded session, admin and public entry from `[1]` to `supportedSchemaVersions:[2]`.

- [ ] **Step 4: Run the exact Task 11 focused tests and parity**

Run: `node tests/coachShopSessionAuth.test.js`

Run: `node tests/coachMemberCompatibility.test.js`

Run: `node tests/becomeCoachApplication.test.js`

Run: `node tests/avatarPropagation.test.js`

Run: `node tests/coachProfileSettingsBinding.test.js`

Run: `node tests/coachCommissionRetirement.test.js`

Run: `node tests/shopQualificationApply.test.js`

Run: `node tests/adminVisibility.test.js`

Run: `node tests/adminPortal.test.js`

Run: `node tests/authSharedParity.test.js`

Expected: PASS. Static scan is policy-aware: user/public production paths have no OPENID-based role or resource authorization; only the seven manifest-listed admin entries may retain their independent trusted admin OPENID check, and even those target applicants/coaches/members/shops by accountId.

- [ ] **Step 5: Update matrix and commit**

Commit exact paths with message `refactor: key coach and shop ownership by account id`.

---

### Task 12: Separate table/payment account ownership from payer OPENID

**Files:**

- Modify: `cloudfunctions/createSession/index.js`
- Modify: `cloudfunctions/createTableOrder/index.js`
- Modify: `cloudfunctions/genTableCheckoutCode/index.js`
- Modify: `cloudfunctions/genCheckinCode/index.js`
- Modify: `cloudfunctions/getMyCheckinStatus/index.js`
- Modify: `cloudfunctions/getPendingCheckins/index.js`
- Modify: `cloudfunctions/getSessions/index.js`
- Modify: `cloudfunctions/getShopBizOverview/index.js`
- Modify: `cloudfunctions/getTableParticipants/index.js`
- Modify: `cloudfunctions/getTodayRevenue/index.js`
- Modify: `cloudfunctions/markTableOrderExternalPaid/index.js`
- Modify: `cloudfunctions/requestCheckin/index.js`
- Modify: `cloudfunctions/resolveCheckin/index.js`
- Modify: `cloudfunctions/recordVerifiedTraining/index.js`
- Modify: `cloudfunctions/closeSession/index.js`
- Modify: `cloudfunctions/createTablePayOrder/index.js`
- Modify: `cloudfunctions/getTableCheckoutOrder/index.js`
- Modify: `cloudfunctions/requestTableRefund/index.js`
- Modify: `cloudfunctions/reconcileTableFinance/index.js`
- Modify: `cloudfunctions/reconcileTablePayments/index.js`
- Modify: `cloudfunctions/settleTableProfitSharing/index.js`
- Modify: `cloudfunctions/tablePayNotifyV3/index.js`
- Modify: `cloudfunctions/tableRefundNotifyV3/index.js`
- Modify: `cloudfunctions/_shared/table-payment/table-payment.js`
- Modify: `cloudfunctions/_shared/table-payment/payment-transition.js`
- Modify: `cloudfunctions/_shared/table-refund/table-refund.js`
- Modify: `cloudfunctions/_shared/table-refund/cloudbase-refund-store.js`
- Modify: `cloudfunctions/_shared/table-profit-sharing/table-profit-sharing.js`
- Modify: `cloudfunctions/createTablePayOrder/lib/table-payment.js`
- Modify: `cloudfunctions/createTablePayOrder/lib/payment-transition.js`
- Modify: `cloudfunctions/reconcileTablePayments/lib/table-payment.js`
- Modify: `cloudfunctions/reconcileTablePayments/lib/payment-transition.js`
- Modify: `cloudfunctions/requestTableRefund/lib/table-refund/table-refund.js`
- Modify: `cloudfunctions/requestTableRefund/lib/table-refund/cloudbase-refund-store.js`
- Modify: `cloudfunctions/tablePayNotifyV3/lib/table-payment.js`
- Modify: `cloudfunctions/tablePayNotifyV3/lib/payment-transition.js`
- Modify: `cloudfunctions/tableRefundNotifyV3/lib/table-refund/table-refund.js`
- Modify: `cloudfunctions/tableRefundNotifyV3/lib/table-refund/cloudbase-refund-store.js`
- Modify: `cloudfunctions/settleTableProfitSharing/lib/table-profit-sharing/table-profit-sharing.js`
- Modify: `scripts/sync-table-finance-libs.ps1`
- Modify: `miniprogram/services/data.js`
- Modify: `miniprogram/pages/shop/hall-status/index.js`
- Modify: `miniprogram/pages/shop/hall-status/index.wxml`
- Create: `tests/tableAccountOwnership.test.js`
- Create: `tests/authCallbackBoundary.test.js`
- Modify: `tests/tableCheckinAccess.test.js`
- Modify: `tests/tableCodeCheckin.test.js`
- Modify: `tests/tableCheckoutToken.test.js`
- Modify: `tests/tableSessionOrderFlow.test.js`
- Modify: `tests/tablePaymentBackend.test.js`
- Modify: `tests/tableReporting.test.js`
- Modify: `tests/tableRefunds.test.js`
- Modify: `tests/tableProfitSharing.test.js`
- Modify: `tests/tableReconciliation.test.js`
- Modify: `tests/cloudSharedParity.test.js`
- Modify: `tests/tablePaymentDeployment.test.js`

**Interfaces:**

```text
session/order owner: ownerAccountId | shopAccountId | memberAccountId | coachAccountId
authenticated actor from requireSession: actorAccountId
WeChat JSAPI field from cloud.getWXContext(): payerOpenid
callbacks: signed platform transaction -> order/account fields, never callback OPENID authorization
```

- [ ] **Step 1: Write RED owner/payer separation tests**

Prove only the session account can open/operate/refund its authorized resources; a different account using the same current WeChat context cannot gain access. `createTablePayOrder` must require the business session, then use trusted current `OPENID` only as `payerOpenid`; it cannot infer order owner from that OPENID. Checkout-token public reads stay token-scoped and field-limited.

- [ ] **Step 2: Write callback/timer boundary RED tests**

Signed payment/refund callbacks and named timers must work without a user session and reject client-shaped spoof events. `requestTableRefund` keeps one entry but enforces mutually exclusive branches: user branch requires session and rejects timer fields; timer branch requires exact timer metadata and rejects a present user `OPENID/sessionToken`. No callback/timer reads `event.authProtocol` as authority.

- [ ] **Step 3: Run and confirm RED**

Run: `node tests/tableAccountOwnership.test.js`

Run: `node tests/authCallbackBoundary.test.js`

Run: `node tests/tablePaymentBackend.test.js`

Run: `node tests/tableCheckinAccess.test.js`

Run: `node tests/tableCodeCheckin.test.js`

Run: `node tests/tableCheckoutToken.test.js`

Run: `node tests/tableSessionOrderFlow.test.js`

Run: `node tests/tableReporting.test.js`

Run: `node tests/tableRefunds.test.js`

Run: `node tests/tableProfitSharing.test.js`

Run: `node tests/tableReconciliation.test.js`

Run: `node tests/cloudSharedParity.test.js`

Run: `node tests/tablePaymentDeployment.test.js`

Expected: FAIL because current order ownership still contains OPENID-derived fields.

- [ ] **Step 4: Migrate canonical payment modules first, then sync copies**

Change the five canonical `_shared` files, update `sync-table-finance-libs.ps1`, run it, and let `cloudSharedParity` verify every deployed copy. Do not hand-edit a generated payment copy without the canonical change.

- [ ] **Step 5: Migrate table/check-in entries and hall UI**

Use `memberAccountId/coachAccountId/shopAccountId` throughout server records, data-service payloads and hall-status page state. Preserve the existing exact table commission, checkout-token, APIv3 signature, callback idempotency, refund and reconciliation rules.

Change every Task 12 client/branch-user entry from `[1]` to `supportedSchemaVersions:[2]`; callback/timer branches continue to ignore client protocol as authority.

- [ ] **Step 6: Run the full Task 12 focused set**

Run: `node tests/tableAccountOwnership.test.js`

Run: `node tests/authCallbackBoundary.test.js`

Run: `node tests/tableCheckinAccess.test.js`

Run: `node tests/tableCodeCheckin.test.js`

Run: `node tests/tableCheckoutToken.test.js`

Run: `node tests/tableSessionOrderFlow.test.js`

Run: `node tests/tablePaymentBackend.test.js`

Run: `node tests/tableReporting.test.js`

Run: `node tests/tableRefunds.test.js`

Run: `node tests/tableProfitSharing.test.js`

Run: `node tests/tableReconciliation.test.js`

Run: `node tests/cloudSharedParity.test.js`

Run: `node tests/tablePaymentDeployment.test.js`

Run: `node tests/authSharedParity.test.js`

Expected: PASS; a production scan may still find `payerOpenid` and trusted `getWXContext()` in payment creation, but no business owner check may depend on them.

- [ ] **Step 7: Update matrix and commit**

Commit exact paths with message `refactor: separate payment owner from payer openid`.

---

### Task 13: Migrate account deletion and retire legacy subscription identity paths

**Files:**

- Modify: `cloudfunctions/deleteAccount/index.js`
- Modify: `cloudfunctions/purgeDeletedAccounts/index.js`
- Modify: `cloudfunctions/getUserBilling/index.js`
- Modify: `cloudfunctions/cancelRecurringContract/index.js`
- Modify: `cloudfunctions/createPayOrder/index.js`
- Modify: `cloudfunctions/createRecurringContract/index.js`
- Modify: `cloudfunctions/createRecurringDebit/index.js`
- Modify: `cloudfunctions/createVirtualPayOrder/index.js`
- Modify: `cloudfunctions/upgradePlan/index.js`
- Modify: `cloudfunctions/payCallback/index.js`
- Modify: `cloudfunctions/recurringContractCallback/index.js`
- Modify: `cloudfunctions/recurringDebitCallback/index.js`
- Modify: `cloudfunctions/virtualPayCallback/index.js`
- Modify: `cloudfunctions/reconcilePay/index.js`
- Modify: `miniprogram/services/data.js`
- Modify: `miniprogram/pages/settings/index.js`
- Modify: `tests/accountDeletionGracePeriod.test.js`
- Modify: `tests/recurringCloudFunctions.test.js`
- Modify: `tests/recurringSubscriptionGuard.test.js`
- Modify: `tests/legacyBillingRetirement.test.js`
- Modify: `tests/shopSubscriptionPlans.test.js`

**Interfaces:**

- User deletion request is session/accountId based.
- Seven-day grace-period cancellation is triggered only by the successful v2 session-issuance transaction for the same `accountId`, implemented and tested in Task 5.
- `purgeDeletedAccounts` deletes/anonymouses by `accountId` family foreign keys and never accepts a client actor.
- Retired charge creators remain `PRODUCT_RETIRED` after protocol guard; signed historical callbacks preserve history by `accountId` without reopening charges. `reconcilePay` remains a zero-read/write `PRODUCT_RETIRED` entry with no timer configuration; it is not revived as a callable timer.

- [ ] **Step 1: Write lifecycle and legacy-boundary RED tests**

Test delete request, grace login cancellation, all-session revocation at final purge, every accountId-owned collection from the migration matrix, bounded/idempotent timer pages, and no deletion of another account. Test retired user endpoints reject old/missing client protocols at the guard, return `PRODUCT_RETIRED` to protocol-v2 requests without requiring or trusting a session, perform zero business reads/writes, and leave signed callbacks on their independent boundary.

- [ ] **Step 2: Run and confirm RED**

Run: `node tests/accountDeletionGracePeriod.test.js`

Run: `node tests/recurringCloudFunctions.test.js`

Run: `node tests/recurringSubscriptionGuard.test.js`

Run: `node tests/legacyBillingRetirement.test.js`

Run: `node tests/shopSubscriptionPlans.test.js`

Expected: FAIL on old `_openid` purge/cancellation relationships.

- [ ] **Step 3: Implement accountId lifecycle without broadening deletion**

Only replace identity keys already listed in the matrix. Keep existing retention/anonymization decisions unchanged. Do not add a data-clear shortcut to `purgeDeletedAccounts`; the one-time test reset remains a separately confirmed deployment operation.

Change every Task 13 client-guarded lifecycle/retired entry from `[1]` to `supportedSchemaVersions:[2]`; signed callbacks remain outside the client guard and `reconcilePay` remains retired.

- [ ] **Step 4: Run focused tests, update matrix, and commit**

Run: `node tests/accountDeletionGracePeriod.test.js`

Run: `node tests/recurringCloudFunctions.test.js`

Run: `node tests/recurringSubscriptionGuard.test.js`

Run: `node tests/legacyBillingRetirement.test.js`

Run: `node tests/shopSubscriptionPlans.test.js`

Expected: PASS. Commit exact paths with message `refactor: migrate account lifecycle to account ids`.

---

### Task 14: Document, verify, and execute the coordinated release gate

**Files:**

- Create: `docs/auth-v2-deployment.md`
- Create: `docs/auth-v2-acceptance-report.md`
- Create: `scripts/auth-v2-cloud-preflight.js`
- Create: `tests/authDeployment.test.js`
- Create: `tests/authPreflight.test.js`
- Modify: `docs/auth-v2-migration-matrix.md`
- Modify: `miniprogram/pages/legal/index.js`
- Modify: `README.md`
- Create: `tests/legalAuthPrivacy.test.js`
- Modify: `docs/codex/HANDOFF.md`

**Interfaces:**

`docs/auth-v2-deployment.md` must contain exact CloudBase actions for:

```text
auth_control/main = { maintenance, schemaVersion, minClientProtocol }
CUETRACE_AUTH_KEY_ACTIVE_VERSION
CUETRACE_AUTH_KEY_HISTORICAL_VERSIONS
CUETRACE_AUTH_KEY_<VERSION>
CUETRACE_SMS_SECRET_ID / CUETRACE_SMS_SECRET_KEY
CUETRACE_SMS_SDK_APP_ID / CUETRACE_SMS_SIGN_NAME / CUETRACE_SMS_TEMPLATE_ID
CUETRACE_EMAIL_CODE_SECRET
CUETRACE_SES_SECRET_ID / CUETRACE_SES_SECRET_KEY / CUETRACE_SES_REGION
CUETRACE_SES_FROM_EMAIL / CUETRACE_SES_TEMPLATE_ID / CUETRACE_SES_SUBJECT / CUETRACE_SES_REPLY_TO
all private auth collection permissions
required compound/expiry indexes
purgeAuthArtifacts timer
guard -> maintenance -> schema -> all functions -> client -> smoke -> v2 switch order
rollback before and after maintenance release
```

Read-only preflight command and output are fixed:

```powershell
$env:CUETRACE_CLOUDBASE_ENV_ID='<target-environment-id>'
$env:CUETRACE_CLOUDBASE_SECRET_ID='<read-only-or-approved-operator-secret-id>'
$env:CUETRACE_CLOUDBASE_SECRET_KEY='<secret-key>'
node scripts/auth-v2-cloud-preflight.js --output .superpowers/sdd/auth-v2-cloud-preflight.json
```

The script resolves `@cloudbase/node-sdk` from `cloudfunctions/accountAuth/node_modules` without modifying dependencies, reads collection names and old/new fields from the matrix, performs count/existence queries only, never returns document bodies, writes `{environmentId,generatedAt,collections:[{name,total,legacyFieldCounts}],sha256}`, and contains no `add/set/update/remove/delete` path. If the SDK is absent, it exits with `PREFLIGHT_SDK_MISSING` and the external preflight remains gated; it must not install packages implicitly. `tests/authPreflight.test.js` injects a fake SDK to enforce the read-only contract.

- [ ] **Step 1: Write documentation, privacy, preflight, and acceptance-report RED tests**

`tests/authDeployment.test.js` asserts every collection, index, environment variable, guard stage, staging gate, maintenance transition, rollback, cleanup/deployment approval checkpoint, cloud smoke, real-device case and exact evidence path is present. `tests/legalAuthPrivacy.test.js` asserts disclosures for OTP auto-create, explicit WeChat binding, login session/device records, phone/SMS processing, Tencent Cloud SMS, retention and user rights, and cross-checks legal `updatedAt` against `TERMS_VERSION/PRIVACY_VERSION` in `miniprogram/config/auth.js`. `tests/authPreflight.test.js` enforces the read-only output contract above.

- [ ] **Step 2: Run and confirm RED**

Run: `node tests/authDeployment.test.js`

Run: `node tests/legalAuthPrivacy.test.js`

Run: `node tests/authPreflight.test.js`

Expected: FAIL because deployment/preflight/acceptance artifacts and disclosures are not yet v2-complete.

- [ ] **Step 3: Write deployment, privacy, and README contracts**

Replace README's old deterministic OPENID/`verifySmsCode` instructions with an auth-v2 summary and deployment link. The deployment document must list at least these indexes:

```text
auth_sessions(accountId, authVersion, revokedAt, _id)
auth_sessions(idleExpiresAt)
auth_sessions(absoluteExpiresAt)
sms_codes(expiresAt, status)
auth_proofs(expiresAt, used)
```

Document key rotation exactly: deploy dual-read code first; add the new root key; switch `ACTIVE_VERSION`; migrate persistent phone/WeChat bindings only inside a freshly verified credential transaction; merge historical rate-limit windows into the active 24-hour counter; retain old SMS/proof keys for maximum TTL plus deployment buffer; retain old session keys for 90 days or deliberately invalidate all old sessions through `authVersion`; write redacted audit events; prove zero persistent binding references and all retention windows complete; only then remove the old key. Never put real keys or phone numbers in the repository.

- [ ] **Step 4: Implement and test the read-only cloud preflight**

Implement `scripts/auth-v2-cloud-preflight.js` with dependency injection for tests and production credentials only from environment variables. It exits nonzero on a missing matrix row, query failure, unexpected document body, or an output path outside `.superpowers/sdd`. It prints only `STATUS`, collection count, legacy-field count and output SHA-256.

- [ ] **Step 5: Run focused documentation/preflight tests**

Run: `node tests/authDeployment.test.js`

Run: `node tests/legalAuthPrivacy.test.js`

Run: `node tests/authMigrationMatrix.test.js`

Run: `node tests/authProtocolGuard.test.js`

Run: `node tests/authSharedParity.test.js`

Run: `node tests/authPreflight.test.js`

Expected: PASS and every code/migration row is `complete`; only named staging/production operations may be `external-gate`.

- [ ] **Step 6: Produce the real cloud preflight and stop for two explicit pre-staging decisions**

Run the fixed preflight command against the target environment and attach `.superpowers/sdd/auth-v2-cloud-preflight.json` plus its SHA-256 to `docs/auth-v2-acceptance-report.md`. Present separately:

1. the exact authentication/business collection clear-or-rebuild list with counts, legacy fields and a hash, for explicit data-operation confirmation; and
2. the non-production staging environment ID and exact staging deployment sequence, for explicit staging-deployment authorization.

Stop until 张总 confirms the exact data list and separately authorizes staging deployment. Read-only preflight is neither cleanup approval nor production-deployment approval. If either decision is absent, mark the corresponding matrix row `external-gate` and do not mutate cloud state. Production authorization is deliberately deferred until the staging, review and frozen-hash gates below are complete.

- [ ] **Step 7: Deploy to a non-production staging environment and complete cloud/device smoke**

The staging environment ID must differ from the production ID. Deploy the verified Task 2 guard artifact, create schema-2 collections/indexes/private permissions, configure non-production auth/SMS/SES keys, deploy all v2 functions and the dev-build client, then run cloud smoke and real-device cases while no production user traffic is present. Automated `tests/authSessions.test.js` supplies the trusted injected server clock for exact 30/90-day expiry; production/client code has no clock override. Real-device testing covers immediate expiry/revocation behavior using server-prepared staging records, never a client timestamp.

If staging reveals a code defect, restore staging maintenance, fix it with TDD, run affected focused tests and repeat this step. Do not run the root full verifier yet.

- [ ] **Step 8: Perform independent final code review**

Use `superpowers:requesting-code-review`. Review must inspect the 108-entry target policy, immutable 107/93/109 baseline, 16 payment copies, action/purpose/branch rules, generated-copy parity, auth-attempt CAS, response unions, raw secret/token/internal-ID leakage, public field projection, callback/timer isolation and accountId ownership. Resolve every Critical/Important finding and rerun only affected focused tests and staging smoke.

- [ ] **Step 9: Freeze the release manifest, run the single root verifier, and obtain production authorization**

After staging and independent review are clean, generate a deterministic release manifest containing the immutable Task 2 guard ZIP SHA-256, every production cloud-function package/source SHA-256, client package SHA-256, preflight SHA-256, approved data-list SHA-256, production environment ID, and exact `auth_control` transition sequence. Finalize all code, generated copies, packages, deployment/privacy documents and the pre-production sections of `docs/auth-v2-acceptance-report.md`; record the review disposition and staging evidence; then rerun `tests/authDeployment.test.js`, `tests/authPreflight.test.js`, `tests/authMigrationMatrix.test.js` and the package/hash checks.

Run the root verifier exactly once for this frozen release candidate:

Run: `& .\scripts\codex-verify.ps1`

Expected: all named tests, changed JavaScript syntax, diff, UTF-8, whitespace, conflict-marker and unreferenced-test checks PASS. Preserve the immutable command output with exact totals as the verifier evidence. If it fails, do not request production authorization; diagnose with focused checks, repeat staging/review as needed, freeze a new candidate and make a new final-verification attempt.

After PASS, present the exact frozen manifest, verifier evidence, production environment ID, data-list hash and coordinated sequence to 张总 for a separate production-deployment authorization. The authorization is valid only for those exact hashes, verifier result, environment ID, data list and sequence. Any code, generated copy, client package, configuration template, preflight result, data list or target-environment change invalidates it and returns execution to staging/review/re-freeze/re-verification before a new authorization.

- [ ] **Step 10: Execute the exact authorized coordinated production sequence without changing files**

1. Create `auth_control/main` at schema 1/min protocol 1, verify the saved SHA-256, and publish the immutable Task 2 compatibility-guard ZIP (or verify the already-completed immediate Task 2 deployment).
2. Prove every client entry obeys maintenance, then set `maintenance:true`.
3. Create v2 collections/indexes/private permissions, configure auth/SMS/SES secrets and deploy the exact staging-verified v2 function/client hashes while maintenance remains on.
4. Run cloud smoke for phone normalization, SMS first-send missing doc, OTP auto-create, password login, WeChat cancel/confirm, session expiry/revocation, public/admin/callback/timer boundaries and payment owner/payer separation.
5. After the separate data-clear approval, clear/rebuild only the approved test collections.
6. Publish the v2 client, set `schemaVersion:2,minClientProtocol:2`, then disable maintenance.
7. Verify cached v1 clients receive `CLIENT_UPDATE_REQUIRED` and cannot write.

If any step fails before release, keep maintenance on and roll back the unopened packages. If a failure occurs after release, restore maintenance first, preserve data and prefer a forward fix; never run mixed v1/v2 ownership.

- [ ] **Step 11: Run production real-device acceptance and record evidence**

Verify at minimum: with the agreement unchecked, OTP send, password login, account registration and WeChat entry each make zero cloud calls; new phone OTP auto-account; existing phone OTP; phone+password; account-name+password; no auto-WeChat binding; an unbound WeChat must finish `wechat_entry` OTP/proof before the binding modal appears; cancel yields `phoneBound:true,wechatBound:false`; confirm yields `phoneBound:true,wechatBound:true`; next WeChat direct login; set account name/password; bind phone/WeChat; recent-auth expiration; two-device coexistence; current logout; logout others; password-change rotation; email recovery; SMS cooldown/lock/re-send; role selection; same business data through every credential; and one table payment proving `ownerAccountId` differs in purpose from `payerOpenid`. Reference the automated trusted-clock evidence for exact 30/90-day expiry rather than adding a client clock override.

- [ ] **Step 12: Finalize external evidence, run documentation-focused verification, then commit**

After production execution, do not change code, generated copies, configuration templates, deployment packages or the frozen manifest. Complete only the reserved external-evidence fields in `docs/auth-v2-acceptance-report.md`: verifier output reference, authorization reference, deployed-hash equality, auth-control transitions, cloud smoke, real-device results and rollback point. Update `docs/codex/HANDOFF.md` with the same final state.

Run: `node tests/authDeployment.test.js`

Run: `node tests/legalAuthPrivacy.test.js`

Run: `node tests/authPreflight.test.js`

Expected: PASS with every populated evidence field matching the frozen manifest and production observations. A documentation-only failure may be corrected and these focused tests rerun. If any correction requires a source, configuration, generated copy, package or manifest change, the existing production authorization is invalid: restore maintenance as appropriate and repeat staging, review, root verification, freeze and authorization before redeployment. After focused PASS, commit the exact Task 14 paths with message `docs: add auth v2 deployment and acceptance` and notify 张总 for验收.

---

## Plan Self-Review Checklist

- [ ] Every one of the 17 acceptance criteria in the approved design maps to the audit table below.
- [ ] The immutable baseline contains 107 current entries, 93 direct entry hits, 109 total JavaScript hits and 16 payment copies; the target policy/matrix contains all 108 final entries including `purgeAuthArtifacts`.
- [ ] Anonymous auth, session, public, admin, callback, timer, mixed and session+payer boundaries are distinct and type-consistent.
- [ ] Internal `accountId`, business `*AccountId`, platform `payerOpenid`, session token, challenge ID and proof token are not interchanged or leaked through the wrong response union.
- [ ] No plan section contains unfinished-work markers, wildcard file ownership, placeholder code or an unspecified error-handling step.
- [ ] No task deletes a repository file or cloud test data without the required separate approval.
- [ ] Focused tests precede implementation in every behavior task; the full verifier runs only at final root closure.

## Acceptance Traceability

| # | Approved acceptance | Automated evidence | Cloud/device evidence |
|---|---|---|---|
| 1 | New phone OTP creates account directly | `smsLogin`, `accountWechatBinding` | New-number real-device login |
| 2 | Phone account supports phone+password after set | `accountWechatBinding`, `accountSecurityPage` | Set password then phone/password login |
| 3 | Setting account name enables account-name+password too | `accountWechatBinding`, `accountSecurityPage` | Set name then both password identifiers |
| 4 | Account-name account binds phone and supports all three paths | `accountWechatBinding` full three-path scenario | Same profile after all three logins |
| 5 | Phone/account-name/WeChat remain strict 1:1 | `authPrimitives`, `accountWechatBinding` | Conflict smoke cases |
| 6 | Phone/password paths never auto-bind WeChat | `accountWechatBinding`, `loginMethods` | Inspect security status after login |
| 7 | Unbound WeChat phone proof cancel/confirm branches | `accountWechatBinding`, `loginMethods` | Both modal branches and next direct login |
| 8 | New accounts are member only | `accountWechatBinding`, `coachMemberCompatibility` | Role picker contains server roles only |
| 9 | Multi-device, logout, rotation, 30/90 expiry | `authSessions` trusted clock | Two-device logout/rotation smoke |
| 10 | Protected business functions no longer infer owner from OPENID | domain session-auth tests, `authMigrationMatrix` | Cross-account denial smoke |
| 11 | First SMS send handles missing document | `smsLogin` CloudBase-accurate fake | First-send staging/real-device SMS |
| 12 | No plaintext password/code/token and auth collections private | `authPrimitives`, `smsLogin`, `authDeployment` | Console/DB permission inspection |
| 13 | Email binding/recovery works and revokes sessions | `emailRecovery`, `authSessions` | Email reset and old-device rejection |
| 14 | All credentials read the same profile/roles/business data | domain cross-credential tests | Same profile/feed/order after each login |
| 15 | Permanent credential changes require recent auth | `authSessions`, `accountSecurityPage` | Expired-recent-auth prompt and retry |
| 16 | Key rotation dual-reads and safely retires history | `authPrimitives`, `authDeployment` | Staging rotation drill and audit evidence |
| 17 | Automated, final verifier, cloud and real-device evidence recorded | Task 14 tests and `codex-verify` | `docs/auth-v2-acceptance-report.md` |

## Execution Handoff

Plan complete and saved at `docs/superpowers/plans/2026-07-15-phone-account-session-login-implementation.md`.

Execution options:

1. **Subagent-Driven (recommended):** start a fresh Codex task, use `superpowers:subagent-driven-development`, implement one task at a time with two-stage review, and keep Task 14 as the coordinated release gate.
2. **Inline Execution:** start a fresh Codex task, use `superpowers:executing-plans`, implement in batches with explicit review checkpoints.

The current repository's large pre-existing staged index makes a normal clean worktree unavailable from `HEAD`; either option must work in the current workspace with exact pathspec commits and must not disturb unrelated staged content.
