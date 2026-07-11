# 微信账号绑定最终审查修复计划

> 追加于整分支审查 `6eb125f..aae4349`。原 7 个任务均已完成逐任务审查，但最终跨任务审查发现 2 个 Critical 与 2 个 Important，合并前必须闭环。

## 全局约束

- 继续执行严格 1:1 微信 `OPENID` ↔ 业务账号；身份只信 `cloud.getWXContext()`。
- `users/{bindingId(OPENID)}` 是唯一业务用户与角色账本；不得按 `_openid` 任取记录、不得从 legacy `user.role` 推导授权、不得由业务辅助函数创建随机 user。
- `users.roles` 只能由注册默认 member 或可信审批事务授予；客户端 `event.role/event.roles/loginName` 不产生业务授权。
- 管理员必须在线走云端凭据与确定性 admin 记录；云、数据库或密钥配置失败一律关闭。
- 手机号只有短信验证码事务成功后才是认证手机号；普通资料接口不能写认证手机号。
- 仍按 B 方案：无生产数据，部署前清空测试集合后重建，不做旧随机 user/admin 迁移。
- 不实现解绑、换绑、密码重置、JWT；不删除任何文件。
- 每项使用 TDD：先观察 RED，再最小 GREEN；聚焦测试后跑一次全量。

## Task 8：确定性用户边界与辅助写入口收口

**Files**

- Modify: `cloudfunctions/login/index.js`
- Modify: `cloudfunctions/markFirstLogin/index.js`
- Modify: `cloudfunctions/saveCoachProfile/index.js`
- Modify: `tests/coachMemberCompatibility.test.js`
- Modify: `tests/becomeCoachApplication.test.js`
- Modify: `tests/adminVisibility.test.js`（仅同步确定性 user 夹具）

### RED

1. 同一 OPENID 同时存在 legacy 随机 coach user 与确定性 member user，`login({ role:'coach' })` 必须拒绝，member 登录必须只命中确定性 user。
2. 未绑定 OPENID 调 `markFirstLogin({ role:'coach' })` 返回 `ACCOUNT_NOT_BOUND` 且 users 零写。
3. 已绑定 member 调 `markFirstLogin({ role:'coach' })` 返回 `ROLE_NOT_ALLOWED`；允许角色只写 `firstLoginAt/per_role`，不写 `role/roles`，时间使用服务端时间。
4. 未绑定 OPENID 调 `saveCoachProfile` 返回 `ACCOUNT_NOT_BOUND`，不得创建 coaches/users。
5. 已绑定 member 可保存申请所需 coach profile，但只更新确定性 user 的昵称/头像，不授 coach、不创建 user。

### GREEN

- `login` 使用已经验证的 `binding._id` 读取 `users.doc(binding._id)` 并校验 `_id/_openid`；角色只清洗 `user.roles`，空列表安全回退 member，不读取 legacy `user.role` 授权。
- `markFirstLogin` 先验证 binding/account/确定性 user；请求角色必须已存在于 `user.roles`；永不 `users.add()`，永不写角色授权字段。
- `saveCoachProfile` 先验证完整绑定和确定性 user；允许已绑定 member 保存申请资料；profile 使用确定性 `coaches/{bindingId}`，只同步既有 user 昵称/头像。

### Verify / Commit

```powershell
node tests/coachMemberCompatibility.test.js
node tests/becomeCoachApplication.test.js
node tests/adminVisibility.test.js
git commit -m "fix: enforce deterministic user identity"
```

## Task 9：门店与教练申请/审批全链路事务

**Files**

- Modify: `cloudfunctions/saveShopStore/index.js`
- Modify: `cloudfunctions/applyCoachShopBinding/index.js`
- Modify: `cloudfunctions/reviewCoachBindingApplication/index.js`
- Modify: `tests/shopQualificationApply.test.js`
- Modify: `tests/becomeCoachApplication.test.js`
- Modify: `tests/coachMemberCompatibility.test.js`

### RED

1. 非 shop 或未绑定用户创建门店必须失败；shop 更新他人门店必须 `STORE_NOT_OWNED` 且零写。
2. 未绑定用户申请 coach、申请到非权威 shop 门店、申请自己的门店均失败。
3. 非 shop、非门店所有者、自审、申请人身份链损坏、非 pending 申请均不能审核。
4. approve 的 application、确定性 link、coach roles、coach profile 任一后续写失败时全部回滚。
5. 正常审批只从申请人现有 `users.roles` 合并 coach，不从 legacy `role/currentRole` 回灌授权。

### GREEN

- `saveShopStore` 验证调用者 binding/account/确定性 user 且 roles 含 shop；带 `_id` 更新时读取并验证门店 `_openid`，任何读取/更新错误不得回退为新建。
- `applyCoachShopBinding` 验证申请人确定性身份、门店所有者确定性身份与 shop 角色，并拒绝自己申请自己的门店；使用服务端门店字段。
- `reviewCoachBindingApplication` 在一个 `db.runTransaction` 中重读 pending application、store、审核者与申请人的 binding/account/user；拒绝自审；原子更新 application、确定性 `shop_coach_links`、申请人 roles 与确定性 coach profile。

### Verify / Commit

```powershell
node tests/shopQualificationApply.test.js
node tests/becomeCoachApplication.test.js
node tests/coachMemberCompatibility.test.js
git commit -m "fix: secure coach approval workflow"
```

## Task 10：管理员只在线、服务端密钥与确定性授权

**Files**

- Modify: `miniprogram/services/data.js`
- Modify: `miniprogram/utils/adminAuth.js`
- Modify: `cloudfunctions/adminLogin/index.js`
- Modify: `cloudfunctions/getAdminStatus/index.js`
- Modify: `cloudfunctions/getAdminStores/index.js`
- Modify: `cloudfunctions/getAdminCoaches/index.js`
- Modify: `cloudfunctions/getAdminMembers/index.js`
- Modify: `cloudfunctions/getPendingShopApplications/index.js`
- Modify: `cloudfunctions/reviewShopApplication/index.js`
- Modify: `README.md`
- Modify: `tests/adminPortal.test.js`
- Modify: `tests/adminVisibility.test.js`
- Modify: `tests/shopQualificationApply.test.js`

### RED

1. `cloudReady=false` 时 `loginAdmin` 必须以 `CLOUD_NOT_READY` 拒绝，不能建立 admin session。
2. 小程序源码不得包含管理员密码；云函数缺少密码 hash/salt 或首次绑定白名单配置时 fail-closed。
3. 密码错误、非白名单首次 OPENID、同账号第二 OPENID、同 OPENID 第二账号均拒绝。
4. `admins` 读取失败或为空时，所有管理员状态、列表和审批入口均不得回退硬编码 bootstrap OPENID。
5. 所有管理员授权入口只接受 `admins/{sha256('admin-openid:'+OPENID)}` 的 active、account 匹配记录。

### GREEN

- 客户端仅保留公开管理员账号名用于路由；删除密码和离线成功路径。
- `adminLogin` 使用环境变量 `CUETRACE_ADMIN_ACCOUNT`、`CUETRACE_ADMIN_PASSWORD_SALT`、`CUETRACE_ADMIN_PASSWORD_HASH`（scrypt 64-byte hex）及 `CUETRACE_ADMIN_BOOTSTRAP_OPENIDS`；配置缺失返回 `CONFIG_MISSING`。
- 首次确定性 admin/admin_account_bindings 创建仅允许白名单 OPENID；已绑定同一身份可重复登录。
- 所有管理云函数以确定性 admin doc 校验；移除 server/client bootstrap fallback，数据库错误传播或返回失败。
- README 增加新密码轮换、hash/salt/首绑白名单配置；不得记录真实值。

### Verify / Commit

```powershell
node tests/adminPortal.test.js
node tests/adminVisibility.test.js
node tests/shopQualificationApply.test.js
git commit -m "fix: fail closed administrator authentication"
```

## Task 11：手机号仅以短信验证结果为准

**Files**

- Modify: `cloudfunctions/saveUserProfile/index.js`
- Modify: `cloudfunctions/verifySmsCode/index.js`
- Modify: `cloudfunctions/accountAuth/index.js`
- Modify: `miniprogram/services/data.js`
- Modify: `miniprogram/pages/player/profile/edit/index.js`
- Modify: `miniprogram/pages/player/profile/edit/index.wxml`
- Modify: `README.md`
- Modify: `tests/saveUserProfile.test.js`
- Modify: `tests/smsLogin.test.js`
- Modify: `tests/accountWechatBinding.test.js`
- Modify: `tests/profileAvatarEdit.test.js`（仅必要 UI 合同）

### RED

1. 客户端或直接云调用 `saveUserProfile({phone})` 不能修改 `users.phone/phoneVerifiedAt`。
2. 已绑定账号即使 user.phone 为空/不同，只要当前 OPENID 的短信验证码有效，事务成功后应设置 phone 与 phoneVerifiedAt。
3. `accountAuth.status` 对无 phoneVerifiedAt 的旧/伪造 phone 返回空；验证后才返回手机号。
4. 资料编辑页手机号只读并提示通过短信验证，保存 payload 不再提交 phone。

### GREEN

- `saveUserProfile` 从可写 profile 投影移除 phone；客户端 service 同样不发送 phone。
- `verifySmsCode` 保留 binding/account/user/code 全事务校验，但移除“必须预先等于 user.phone”的鸡生蛋检查；成功事务设置 phone/phoneVerifiedAt。
- `accountAuth.status` 仅在 `phoneVerifiedAt` 存在时投影 phone。
- 资料编辑手机号输入改为只读/禁用，保持可见与隐私开关，不新增大表单。

### Verify / Commit

```powershell
node tests/saveUserProfile.test.js
node tests/smsLogin.test.js
node tests/accountWechatBinding.test.js
node tests/profileAvatarEdit.test.js
git commit -m "fix: trust only verified phone numbers"
```

## Task 12：账户生命周期与资料入口确定性收口

**Files**

- Modify: `cloudfunctions/deleteAccount/index.js`
- Modify: `cloudfunctions/purgeDeletedAccounts/index.js`
- Modify: `cloudfunctions/saveUserProfile/index.js`
- Modify: `cloudfunctions/getUserProfile/index.js`
- Modify: `miniprogram/services/data.js`
- Modify: `README.md`
- Modify: `tests/accountDeletionGracePeriod.test.js`
- Modify: `tests/saveUserProfile.test.js`

### RED

1. 未绑定 OPENID 调用 `deleteAccount` 返回 `ACCOUNT_NOT_BOUND`，不得创建随机 user 或注销请求。
2. 已绑定账号只更新 `users/{bindingId}`，注销请求使用确定性文档；同 OPENID 的伪 legacy user 不得被修改；重复提交不得延后已存在的到期时间。
3. `saveUserProfile/getUserProfile` 只读取确定性 user；随机 legacy coach/shop 记录不得影响资料与角色视图。
4. 到期清理必须移除确定性 account、binding、user，并把请求标记 purged；任一辅助集合清理失败时保留认证链供重试，任一认证文档删除失败时事务整体回滚。
5. 部署文档必须明确上传 `getUserProfile`、`deleteAccount` 和带定时触发器的 `purgeDeletedAccounts`，避免云端继续运行旧生命周期逻辑。
6. 客户端注销 service 遇到 `{ok:false}` 必须 reject，设置页不得把未绑定或服务端失败误显示为注销成功。

### GREEN

- `deleteAccount` 在一个事务内验证 binding/account/user/request，更新确定性 user 并 set `account_deletion_requests/{bindingId}`；永不 `users.add()`，已有一致 pending 请求沿用原到期时间。
- `saveUserProfile/getUserProfile` 验证 binding/account/确定性 user，角色只来自 `user.roles`，不读取 legacy `user.role` 授权。
- `purgeDeletedAccounts` 只处理 `_id===bindingId(_openid)` 的到期 user；先预检完整身份/request 链，辅助清理列表移除 `users`、补入 `stores` 且失败即停止当前账号；随后在事务内重读并使用事务 `delete` 原子删除 account、binding、user，同时更新确定性注销请求。
- `data.deleteAccount` 将云端业务失败转换成带 `code/result` 的异常，保持设置页现有成功/失败分支可靠。
- README 的云函数上传清单加入资料读取、账号注销与定时清理函数，并保留真实云端验收为未完成状态。
- B 方案不迁移旧随机文档；测试环境部署前按 README 清空重建。

### Verify / Commit

```powershell
node tests/accountDeletionGracePeriod.test.js
node tests/saveUserProfile.test.js
node tests/coachMemberCompatibility.test.js
git commit -m "fix: enforce deterministic account lifecycle"
```

## Task 13：定时清理隐私边界与审查补救

**Files**

- Modify: `cloudfunctions/deleteAccount/index.js`
- Modify: `cloudfunctions/purgeDeletedAccounts/index.js`
- Modify: `cloudfunctions/saveUserProfile/index.js`
- Modify: `cloudfunctions/createRecurringContract/index.js`
- Modify: `cloudfunctions/recurringContractCallback/index.js`
- Modify: `cloudfunctions/cancelRecurringContract/index.js`
- Modify: `cloudfunctions/login/index.js`
- Modify: `README.md`
- Modify: `tests/accountDeletionGracePeriod.test.js`
- Modify: `tests/saveUserProfile.test.js`
- Create: `tests/recurringSubscriptionGuard.test.js`

### RED

1. 带真实微信 `OPENID` 的客户端即使伪造 Timer event，也不得运行清理；响应不得包含其他用户 OPENID、原始错误或逐集合删除明细。
2. pending user/request 的时间缺失、非数字或不一致时不得延后期限或删除认证链；purged/canceled tombstone 不得阻塞同微信新账号的后续注销。
3. 超过 100 个到期候选时必须稳定分页；畸形候选要计为失败，不能让合法候选永久饥饿。
4. 资料保存与角色撤销并发时不得把旧 `roles` 快照写回；资料测试必须实际执行全字段、部分更新、手机号门控和确定性读取回归。
5. account、binding、user 删除或 request 更新任一事务步骤失败时全部回滚；云文件删除失败时保留认证链。
6. 注销必须覆盖明确列出的非财务个人数据与云文件；支付、订单、订阅、结算数据不得无依据删除，README 要记录依法留存边界与部署方确认责任。
7. 注销事务与新建连续订阅并发时，二者必须竞争同一个确定性 user guard；pending 注销账号不得创建订阅，未解约订阅不得删除认证链。
8. 到期清理必须先在事务内领取带过期时间的 `purging` lease，再做任何不可逆辅助清理；登录拒绝 purging，崩溃后可由下一轮定时任务接管。

### GREEN

- 清理函数同时验证无用户 OPENID、平台 Timer 类型和固定触发器名；返回值仅保留聚合计数，失败明细只写脱敏服务端日志。
- 到期查询使用稳定排序和分页预取；完整校验 binding/account/user/request 及有限数时间字段，所有跳过计入失败。
- terminal tombstone 可由完整新身份覆盖；pending 身份或时间矛盾失败关闭且不改写原期限。
- 资料接口只更新资料字段，不写 `roles/currentRole/role`；并发撤销回归证明角色不会复活。
- 非财务个人集合按明确查询规则清理，并删除已收集的 `cloud://` 用户文件；缺集合或文件删除错误不进入认证删除事务。
- README 列出清理依赖集合、非财务删除范围、依法留存集合，以及真实 Timer、transaction delete、deleteFile 和权限验收。
- 连续订阅创建、状态回调和解约在确定性 user 上维护 `subscriptionStatus/subscriptionId` guard；创建与注销事务都写同一 user 文档，由事务冲突和重读关闭竞态。
- purge 在辅助清理前事务化写入 user/request 的 `purging` lease；只有 lease 持有者可执行最终认证删除，未过期 lease 不被并发任务抢占，登录对 purging 一律锁定。

### Verify

```powershell
node tests/accountDeletionGracePeriod.test.js
node tests/saveUserProfile.test.js
node tests/coachMemberCompatibility.test.js
node tests/recurringSubscriptionGuard.test.js
```

## Task 14：管理员客户端与短信验证码最终审计补救

**Files**

- Modify: `miniprogram/services/data.js`
- Modify: `cloudfunctions/sendSmsCode/index.js`
- Modify: `cloudfunctions/verifySmsCode/index.js`
- Modify: `tests/adminPortal.test.js`
- Modify: `tests/smsLogin.test.js`
- Modify: `README.md`

### RED

1. 管理员云端响应为空、缺少 `isAdmin` 或明确返回 `isAdmin:false` 时，客户端不得建立管理员会话。
2. 同一可信 `OPENID` / 手机号的两个并发发送请求只能有一个触达短信提供商；失败发送仍需保留冷却，避免重试轰炸。
3. 新验证码必须覆盖旧验证码；验证码使用加密安全随机数，错误五次后锁定，错误与正确并发不得绕过计数或双消费。
4. 缺少有限时间、失败次数或锁定字段的验证码文档必须失败关闭。
5. 短信认证必须重读完整的确定性 binding/account/user 链；缺失账号名、规范名不一致或非确定性 account ID 均不得消费验证码或写手机号。

### GREEN

- `data.loginAdmin` 仅在云端明确返回 `{ok:true,isAdmin:true}` 后写管理员会话。
- `sendSmsCode` 使用 `sms_codes/{sha256(sms:OPENID:phone)}` 单一最新码文档；事务先 claim 60 秒发送冷却，再以 `crypto.randomInt` 生成验证码并调用带 8 秒超时的腾讯短信，最后只由同一 claim 落库。
- `verifySmsCode` 在事务内校验最新码、有限时间、0–4 次失败计数和完整确定性账号链；错误原子计数，第五次锁定，正确消费与 `phoneVerifiedAt` 写入同事务完成。
- B 方案不迁移随机 ID 旧验证码；README 只允许在可重建纯测试环境清空旧 `sms_codes`。

### Verify

```powershell
node tests/smsLogin.test.js
node tests/adminPortal.test.js
node tests/accountWechatBinding.test.js
node tests/saveUserProfile.test.js
```

## 最终验证

- 全量运行 `tests/*.test.js` 并汇总失败。
- `node --check` 所有 `6eb125f` 到当前工作树变更的 `.js` 文件。
- `git diff --check 6eb125f -- . ':(exclude).agents/**'`。
- 扫描 `event.roles`、随机 `users.add` 角色写、客户端管理员密码、bootstrap 管理员 fallback、本地认证读取。
- 再做一次整分支只读审查；Critical/Important 必须为零。
- 真云、真实 OPENID、短信、跨设备与冲突仍按 README 人工验收，未执行不得勾选。
