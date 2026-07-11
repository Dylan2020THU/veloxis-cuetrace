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
| `sms_codes` | 短信验证码散列、所属 `_openid` / 手机号、使用状态和有效期。 |
| `shop_applications` | 店主资质申请及审核状态。 |
| `shops` | 已授权店主维护的店铺资料。 |
| `stores` | 店主名下门店；添加教练时用于校验门店归属。 |
| `shop_coach_links` | 店主与已授权教练的关联。 |
| `coach_shop_applications` | 教练绑定门店申请。 |
| `coaches` | 教练资料及审核后的门店绑定状态。 |
| `account_deletion_requests` | 登录时处理待注销账号恢复/锁定状态。 |

确认所有集合存在后，再配置云数据库安全规则，然后才按第 3 节上传云函数。`accounts`、`wechat_bindings`、`users`、`admins`、`admin_account_bindings`、`sms_codes` 以及角色申请/关联集合都承载认证或授权依据。建议在安全规则中禁止小程序客户端直接读写，由云函数通过可信 `OPENID` 完成访问；尤其不要允许客户端直接修改 `users.roles`。业务展示集合若需开放读取，应按页面的最小字段和最小权限单独配置，不要复用认证集合权限。

### 3. 上传云函数

在微信开发者工具中，对以下云函数逐个选择“上传并部署：云端安装依赖”，并确认它们部署到 `miniprogram/app.js` 指定的同一云环境：

- 核心认证：`accountAuth`、`login`、`adminLogin`。
- 手机号验证：`sendSmsCode`、`verifySmsCode`。
- 角色与资料：`reviewShopApplication`、`reviewCoachBindingApplication`、`saveUserProfile`、`saveShopProfile`、`addShopCoach`。
- 完整申请入口同时部署：`submitShopApplication`、`applyCoachShopBinding`。

部署后检查每个函数均已安装其目录内 `package.json` 声明的依赖。不要仅上传客户端代码，否则账号登录会因认证探测失败而保持关闭。

### 4. 短信配置

在 `sendSmsCode` 云函数环境变量中配置 `CUETRACE_SMS_SECRET_ID`、`CUETRACE_SMS_SECRET_KEY`、`CUETRACE_SMS_SDK_APP_ID`、`CUETRACE_SMS_SIGN_NAME`、`CUETRACE_SMS_TEMPLATE_ID`；可按实际地域和模板参数配置 `CUETRACE_SMS_REGION`、`CUETRACE_SMS_TEMPLATE_PARAMS`。在 `sendSmsCode` 与 `verifySmsCode` 中设置相同的 `SMS_CODE_HASH_SECRET`，用于验证码散列校验。

所有值都必须来自实际腾讯云短信配置；仓库不提供示例密钥，也不要把 SecretId、SecretKey 或散列密钥提交到代码中。

### 5. 身份约束

- 注册会把当前可信 `OPENID` 与新业务账号绑定；已存在但尚未绑定的账号只能在密码校验成功后绑定。
- 微信图标只对已绑定微信执行免密恢复。未绑定微信不会被静默创建为用户。
- 一个业务账号只能绑定一个微信，一个微信也只能绑定一个业务账号。当前版本不提供解绑、换绑或覆盖绑定入口；不要通过控制台手工改一侧映射来规避限制。
- 角色只认云端 `users.roles`。会员注册不会自动获得教练或店主角色，必须走对应审核流程。

### 6. 发布前真机验收

本地 Node 测试只验证代码逻辑，不能代替真实微信身份、云环境和集合权限验收。发布前在已部署环境逐项完成并保留记录：

- [ ] 使用真实 `OPENID` 完成首次账号注册，并确认 `accounts`、`wechat_bindings`、`users` 三份记录一致。
- [ ] 退出后点击微信图标，确认已绑定账号可以免密恢复，未绑定微信明确失败且不创建用户。
- [ ] 清除小程序 storage 后恢复登录；再换一台设备登录同一微信，确认结果来自云端绑定而不是本地缓存。
- [ ] 用第二个微信登录已绑定账号，确认返回账号已绑定冲突；再用已绑定微信尝试另一账号，确认返回微信已绑定冲突，且两次失败都不改写原绑定。
- [ ] 验证账号密码、手机号验证码、管理员登录、店主审核、教练/门店关联的成功与拒绝路径。
- [ ] 在开发者工具和真机确认所有云函数均部署到目标环境，认证/角色集合禁止客户端直写，且短信密钥只存在于云函数环境变量中。

## License

Proprietary. All rights reserved.
