# Veloxis · CueTrace

A WeChat Mini Program for billiards training data management.

Built on WeChat Cloud Development.

## Run

Import this directory in WeChat DevTools, then compile and run.

## 微信账号认证部署

### 1. 项目与云环境

- `project.config.json` 已配置小程序 AppID `wxa7c9920cda26d7ca`。
- `miniprogram/app.js` 当前使用云环境 `cloud1-d4g2abcud02b40531`。导入项目后，先确认该云环境与上述 AppID 属于同一个小程序；如果实际部署到其他环境，先同步修改 `CLOUD_ENV`，不要让客户端与云函数落在不同环境。
- 本次账号系统按 B 方案“仅测试数据、可重建”实施，不包含生产数据迁移，也不会迁移旧的本地 `dc_accounts` / `dc_wechat_bindings`。部署前清空下表所列测试集合中的旧测试数据，再按当前结构重建；清空仅适用于纯测试环境，不能用于生产环境或任何需要保留的数据。

### 2. 集合与权限

先进入云开发控制台的数据库，在上传云函数前按下表逐一创建或确认集合已经存在。以下是本次认证和角色链路必须创建或确认存在的集合：核心集合 `accounts`、`wechat_bindings`、`users`、`admins`、`admin_account_bindings`、`sms_codes`，角色业务集合 `shop_applications`、`shops`、`stores`、`shop_coach_links`、`coach_shop_applications`、`coaches`，以及登录链路使用的 `account_deletion_requests`。

| 集合 | 当前用途与关键字段 |
| --- | --- |
| `accounts` | 业务账号；确定性 `_id`、`_openid`、`account`、`accountNormalized`、`passwordAlgorithm`、`passwordSalt`、`passwordHash`、`status`、绑定时间。密码只保存 scrypt 派生值和盐。 |
| `wechat_bindings` | 微信到业务账号的唯一映射；确定性 `_id`、`_openid`、`accountId`、`account`、`unionidHash`、绑定时间。 |
| `users` | 服务端角色与资料；与微信绑定一致的 `_id` / `_openid`、`roles`、`currentRole`、`role` 及昵称、头像、手机号等资料。 |
| `admins` | 已绑定管理员微信；确定性 `_id`、`_openid`、管理员账号和状态。 |
| `admin_account_bindings` | 管理员账号到微信的反向唯一锁。 |
| `sms_codes` | 每个 `_openid` / 手机号组合仅保留一份最新验证码；确定性 `_id = sha256(sms:OPENID:phone)`，并记录散列、原子发送冷却、错误次数、锁定/使用状态和有效期。 |
| `shop_applications` | 店主资质申请及审核状态。 |
| `shops` | 已授权店主维护的店铺资料。 |
| `stores` | 店主名下门店；添加教练时用于校验门店归属。 |
| `shop_coach_links` | 店主与已授权教练的关联。 |
| `coach_shop_applications` | 教练绑定门店申请。 |
| `coaches` | 教练资料及审核后的门店绑定状态。 |
| `account_deletion_requests` | 登录时处理待注销账号恢复/锁定状态。 |

账号到期清理不会在集合缺失时跳过。部署 `purgeDeletedAccounts` 前，除上述认证集合外，必须预先创建全部清理依赖集合：`training_sessions`、`posts`、`post_likes`、`post_comments`、`matches`、`match_joins`、`bookings`、`checkin_requests`、`sessions`、`coach_lessons`、`brands`、`members`、`coach_member_links`、`user_follows`，并确认已有的 `sms_codes`、`shop_applications`、`shops`、`stores`、`shop_coach_links`、`coach_shop_applications`、`coaches`、`subscriptions` 均存在。任一依赖集合读取或清理失败时，该账号的 `accounts`、`wechat_bindings`、`users` 与确定性注销请求会保留供重试。

确认所有集合存在后，再配置云数据库安全规则，然后才按第 3 节上传云函数。`accounts`、`wechat_bindings`、`users`、`admins`、`admin_account_bindings`、`sms_codes` 以及角色申请/关联集合都承载认证或授权依据。建议在安全规则中禁止小程序客户端直接读写，由云函数通过可信 `OPENID` 完成访问；尤其不要允许客户端直接修改 `users.roles`。业务展示集合若需开放读取，应按页面的最小字段和最小权限单独配置，不要复用认证集合权限。

### 3. 上传云函数

在微信开发者工具中，对以下云函数逐个选择“上传并部署：云端安装依赖”，并确认它们部署到 `miniprogram/app.js` 指定的同一云环境：

- 核心认证：`accountAuth`、`login`、`adminLogin`。
- 手机号验证：`sendSmsCode`、`verifySmsCode`。
- 角色与资料：`reviewShopApplication`、`reviewCoachBindingApplication`、`saveUserProfile`、`getUserProfile`、`saveShopProfile`、`addShopCoach`。
- 完整申请入口同时部署：`submitShopApplication`、`applyCoachShopBinding`。
- 账号生命周期：`deleteAccount`，以及 `purgeDeletedAccounts`（按 `cloudfunctions/purgeDeletedAccounts/config.json` 部署，定时触发器名称必须为 `dailyAccountDeletionPurge`）。
- 连续订阅：`createRecurringContract`、`recurringContractCallback`、`cancelRecurringContract`；三者必须与账号生命周期函数同时更新，不能混用旧版本。

部署后检查每个函数均已安装其目录内 `package.json` 声明的依赖。不要仅上传客户端代码，否则账号登录会因认证探测失败而保持关闭。

### 4. 管理员认证配置

本项目的管理员登录只在云端校验。客户端只保留公开账号名用于路由，不保存密码、散列或首次绑定白名单。在 `adminLogin` 云函数配置下列四个环境变量，任意一项缺失或格式错误都会以 `CONFIG_MISSING` 拒绝登录：

- `CUETRACE_ADMIN_ACCOUNT`：公开的管理员账号名。
- `CUETRACE_ADMIN_PASSWORD_SALT`：为本次新密码单独生成的随机盐，使用偶数长度十六进制字符串。
- `CUETRACE_ADMIN_PASSWORD_HASH`：使用上述盐对新密码执行 scrypt，输出 64 字节后转为 128 位十六进制字符串。
- `CUETRACE_ADMIN_BOOTSTRAP_OPENIDS`：允许首次建立管理员双向绑定的真实 OPENID，多个值用英文逗号分隔。

按 B 方案部署到纯测试环境前，先在云控制台清空 `admins` 与 `admin_account_bindings` 的旧测试记录，再生成一个全新管理员密码及其盐和派生值；不要沿用仓库历史密码，也不要把新密码或它的真实配置值写入代码、README 或测试日志。此清空操作仅适用于可重建的纯测试环境。

首次登录只在 `admins` 和 `admin_account_bindings` 两把确定性锁都不存在时使用白名单；双锁已绑定同一账号和微信后可重复登录。不完整的单边锁、第二个微信或第二个账号都会被拒绝，不会通过空集合或读取异常回退到硬编码管理员。

### 5. 短信配置

`users.phone` 只接受 `verifySmsCode` 在校验当前可信 `OPENID`、账号绑定和有效短信验证码后写入，并同时记录 `phoneVerifiedAt`。资料保存接口与资料编辑页均不能直接修改手机号；`accountAuth.status` 也只返回带有 `phoneVerifiedAt` 的已验证号码。

在 `sendSmsCode` 云函数环境变量中配置 `CUETRACE_SMS_SECRET_ID`、`CUETRACE_SMS_SECRET_KEY`、`CUETRACE_SMS_SDK_APP_ID`、`CUETRACE_SMS_SIGN_NAME`、`CUETRACE_SMS_TEMPLATE_ID`；可按实际地域和模板参数配置 `CUETRACE_SMS_REGION`、`CUETRACE_SMS_TEMPLATE_PARAMS`。在 `sendSmsCode` 与 `verifySmsCode` 中设置相同的 `SMS_CODE_HASH_SECRET`，用于验证码散列校验。

所有值都必须来自实际腾讯云短信配置；仓库不提供示例密钥，也不要把 SecretId、SecretKey 或散列密钥提交到代码中。

本次 B 方案不迁移旧的随机 ID 验证码记录。仅在可重建的纯测试环境中，部署新版 `sendSmsCode` / `verifySmsCode` 前清空 `sms_codes` 旧测试记录，再由新版函数创建确定性最新码文档；生产环境或任何需要保留的数据不得执行该清空操作。

### 6. 身份约束

- 注册会把当前可信 `OPENID` 与新业务账号绑定；已存在但尚未绑定的账号只能在密码校验成功后绑定。
- 微信图标只对已绑定微信执行免密恢复。未绑定微信不会被静默创建为用户。
- 一个业务账号只能绑定一个微信，一个微信也只能绑定一个业务账号。当前版本不提供解绑、换绑或覆盖绑定入口；不要通过控制台手工改一侧映射来规避限制。
- 角色只认云端 `users.roles`。会员注册不会自动获得教练或店主角色，必须走对应审核流程。

### 7. 注销清理与数据保留矩阵

`createRecurringContract`、`deleteAccount` 与定时清理在确定性 `users/{sha256(wechat:OPENID)}` 上共享原子 guard：签约事务写入 `subscriptionStatus=pending_contract`，注销写入 `deletionStatus=pending`，清理先通过事务把状态抢占为 `purging`。任一方看到对方的 active / pending 状态都会拒绝；清理失败会保留带过期时间的 `purging` 租约，只有原租约或租约到期后的新任务可以继续。存在 `active`、`pending_contract` 或 `cancel_required` 连续订阅状态时，必须先通过 `cancelRecurringContract` 完成微信侧解约；微信侧解约失败不会释放本地订阅 guard。`cancel_required` 表示旧合约的迟到 ADD 回调与当前新合约发生冲突，取消接口会优先处理该旧合约。该协议已由本地事务回归测试覆盖，但真实 CloudBase 写冲突与回调并发仍须按下方清单验收。

| 数据类别 | 注销处理 |
| --- | --- |
| 非财务个人数据 | 删除 `users` 认证资料及 `sms_codes`、`shop_applications`、`coach_shop_applications`、`checkin_requests`、`sessions`、`brands`、`members` 等个人记录；按 owned store/post/match 继续清理关联记录。 |
| 云存储个人文件 | 仅收集清理时仍可从数据库记录发现、且符合 `user-content/{sha256(wechat:OPENID)}/...` 严格 namespace 与安全路径/文件名规则的头像、证书、营业执照、帖子媒体、门店封面等 `cloud://` 引用，再调用 `cloud.deleteFile`；任一结果不是 `SUCCESS`（文件已不存在除外）或调用异常时保留认证链。旧 namespace、非规范路径以及已失去数据库引用的历史孤儿对象不会被自动发现或删除，部署方需通过上传清单或后台存储盘点另行清理；按本项目 B 方案部署纯测试环境前，还需先清空这些旧测试存储对象，且不得把该操作用于生产数据。 |
| 教练课时 | 无金额或结算字段的 `coach_lessons` 可作为个人活动数据清理；含金额、订单或结算依据的课时保留。 |
| 财务与支付依据 | `orders`、`subscriptions`、`shop_orders`、`coach_settlements`、`fulfill_failures` 以及财务课时不由注销任务擅自删除。部署方必须依据适用法律、支付审计和争议处理要求确定并记录具体留存期限。 |

### 8. 发布前真机验收

本地 Node 测试只验证代码逻辑，不能代替真实微信身份、云环境和集合权限验收。发布前在已部署环境逐项完成并保留记录：

- [ ] 使用真实 `OPENID` 完成首次账号注册，并确认 `accounts`、`wechat_bindings`、`users` 三份记录一致。
- [ ] 退出后点击微信图标，确认已绑定账号可以免密恢复，未绑定微信明确失败且不创建用户。
- [ ] 清除小程序 storage 后恢复登录；再换一台设备登录同一微信，确认结果来自云端绑定而不是本地缓存。
- [ ] 用第二个微信登录已绑定账号，确认返回账号已绑定冲突；再用已绑定微信尝试另一账号，确认返回微信已绑定冲突，且两次失败都不改写原绑定。
- [ ] 验证账号密码、手机号验证码、管理员登录、店主审核、教练/门店关联的成功与拒绝路径。
- [ ] 在开发者工具和真机确认所有云函数均部署到目标环境，认证/角色集合禁止客户端直写，且短信密钥只存在于云函数环境变量中。
- [ ] 在真实云数据库验证 `purgeDeletedAccounts` 的 transaction.delete 任一写入失败会整体回滚 account/binding/user/request。
- [ ] 在真实云存储验证 `deleteFile` 全部 `SUCCESS` 才进入认证事务，异常或非成功状态会保留认证链。
- [ ] 验证只有空 `OPENID`、`Type=Timer` 且触发器名为 `dailyAccountDeletionPurge` 的定时调用可执行；客户端伪造 Timer 必须零数据库访问。
- [ ] 对 `active`、`pending_contract` 或 `cancel_required` 连续订阅先调用 `cancelRecurringContract` 并确认微信侧解约成功，再申请注销；确认未解约时认证链不被清理，且存在 `conflictingSubscriptionId` 时优先取消冲突旧合约。
- [ ] 在真实云并发触发 `createRecurringContract` 与 `deleteAccount` / `purgeDeletedAccounts`，确认共享用户文档的事务写冲突只允许一方成功，并确认未过期 `purging` 租约阻止重复清理、过期租约可安全接管；当前真实云验收尚未完成。

## License

Proprietary. All rights reserved.
