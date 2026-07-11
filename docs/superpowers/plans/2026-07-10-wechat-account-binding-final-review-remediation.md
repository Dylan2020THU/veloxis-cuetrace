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

## 最终验证

- 全量运行 `tests/*.test.js` 并汇总失败。
- `node --check` 所有 `6eb125f..HEAD` 变更的 `.js` 文件。
- `git diff --check 6eb125f..HEAD`。
- 扫描 `event.roles`、随机 `users.add` 角色写、客户端管理员密码、bootstrap 管理员 fallback、本地认证读取。
- 再做一次整分支只读审查；Critical/Important 必须为零。
- 真云、真实 OPENID、短信、跨设备与冲突仍按 README 人工验收，未执行不得勾选。

