# 账号错误提示、密码找回与邮箱绑定设计

## 状态与授权

- 日期：2026-07-12
- 状态：按张总此前“后续选项均采用推荐方案”的授权完成 brainstorming，可进入实施计划与执行
- 本设计合并处理：注册 `_id` 写入故障、登录错误区分、微信找回密码、邮箱找回密码、邮箱绑定
- 本设计不授权删除任何仓库文件或生产数据

## 背景与根因

当前 `accountAuth` 已使用确定性文档 ID 建立账号、微信绑定和用户三方关系，但还有四类缺口：

1. 注册和首次密码绑定把 `_id` 同时放进 `doc(id).set({ data })` 的 `data`，微信云数据库拒绝更新 `_id`，因此生产环境报 `-501007 不能更新_id的值`。
2. 密码登录把“账号不存在”和“密码错误”统一映射为 `INVALID_CREDENTIALS`，无法按产品要求给出不同引导。
3. 登录页没有密码找回入口；当前微信虽然是可信身份，但没有用于重置密码的服务端动作。
4. 账号没有已验证邮箱关系，也没有邮件验证码发送、绑定和找回链路。

## 目标

1. 所有 `doc(id).set()` 只在文档路径传递 ID，`data` 不再包含 `_id`。
2. 未注册账号返回 `ACCOUNT_NOT_FOUND / 账号未注册`，登录页弹窗并可一键进入注册；密码错误返回 `INVALID_PASSWORD / 账号密码错误`。
3. 登录页增加“忘记密码”，支持：
   - 当前微信已绑定账号时，凭可信 `OPENID` 重置密码；
   - 通过已绑定邮箱验证码重置密码。
4. “设置 → 账号与安全”增加“邮箱绑定”，通过验证码完成首次绑定或更换绑定。
5. 邮箱、验证码、密码和微信身份均只在云函数中校验；客户端不能自行声明绑定关系。
6. 为验证码加入有效期、重发冷却、尝试次数限制和一次性消费。

## 非目标

- 不实现短信找回、人工客服工单或邮箱解绑。
- 不允许一个邮箱绑定多个业务账号；每个业务账号最多一个有效邮箱。
- 不修改现有账号与微信 `1:1` 约束。
- 不把腾讯云密钥、验证码或密码写入小程序代码、响应、日志或仓库。
- 不自动删除旧邮箱文档；更换后将旧关系标记为 `revoked`。

## 方案比较与结论

### 邮件渠道

采用腾讯云 SES `SendEmail` API 和官方按产品拆分的 Node.js SDK `tencentcloud-sdk-nodejs-ses`：

- 与现有微信云开发/腾讯云部署体系一致；
- 官方接口明确支持验证码等触发类邮件，并默认使用审核模板；
- SDK 只运行在云函数服务端，密钥通过环境变量提供；
- 不采用 SMTP。腾讯云已限制部分新开通个人账户的 SMTP 能力，API 也是更稳定的推荐路径。

官方参考：

- [SendEmail API](https://cloud.tencent.com/document/api/1288/51034)
- [腾讯云 Node.js SDK](https://github.com/TencentCloud/tencentcloud-sdk-nodejs)
- [SMTP 权限说明](https://cloud.tencent.com/document/product/1288/65749)

### 云函数边界

采用“`sendEmailCode` 负责发信，`accountAuth` 负责最终认证写入”：

- `sendEmailCode` 独立持有 SES 依赖和发信凭据，负责目标预校验、限流、生成验证码、写入挑战记录和调用 SES；
- `accountAuth` 继续作为账号安全唯一写入口，负责验证码校验、邮箱绑定和密码重置事务；
- 两个云函数共享同一 `CUETRACE_EMAIL_CODE_SECRET` 环境变量，仅保存 HMAC 后的验证码。

不把 SES SDK直接放入 `accountAuth`，以免认证主函数加载不必要的网络 SDK，也避免干扰当前本地生成的 `accountAuth/node_modules`。不把密码重置放入发信函数，以免密码规则和账号写入分散到两个服务端入口。

## 数据模型

### `email_bindings`

文档 ID：`sha256('email:' + emailNormalized)`，以确定性 ID 保证邮箱唯一。

```js
{
  _id,
  _openid,
  accountId,
  account,
  email,
  emailNormalized,
  status,       // active | revoked
  boundAt,
  updatedAt,
  revokedAt
}
```

`accounts` 增加：

```js
{
  emailBindingId,
  emailVerifiedAt,
  updatedAt
}
```

邮箱明文只保存在云端受限的 `email_bindings` 集合中，用于投递和严格匹配；账号仅保存绑定指针，状态接口读取有效绑定后即时计算掩码，不冗余保存掩码或明文。

### `email_codes`

文档 ID：`sha256('email-code:' + purpose + ':' + emailNormalized)`。

```js
{
  _id,
  purpose,          // bind | reset
  accountId,
  emailBindingId,
  targetHash,       // 绑定目标的不可逆摘要，不重复保存邮箱明文
  codeHash,         // HMAC-SHA256(code, CUETRACE_EMAIL_CODE_SECRET + challenge identity)
  requestId,        // 防止并发发送覆盖状态
  status,           // sending | active | failed | used | locked
  attemptsLeft,     // 初始 5
  expiresAt,        // Date.now() + 10 分钟
  nextSendAt,       // 60 秒重发冷却
  sentAt,
  usedAt,
  updatedAt
}
```

不保存明文验证码。新验证码覆盖同用途同邮箱的旧挑战；成功消费后标记 `used`，不能复用。

## 服务端接口

### `accountAuth`

新增或调整以下 action：

- `register`
  - 修复所有 `set()` 数据中的 `_id`；响应与角色规则不变。
- `passwordLogin`
  - 确定性账号文档不存在：`ACCOUNT_NOT_FOUND`；
  - 文档存在但身份结构损坏：`ACCOUNT_NOT_BOUND`；
  - 密码不匹配：`INVALID_PASSWORD`。
- `resetPasswordByWechat`
  - 仅从 `cloud.getWXContext().OPENID` 解析账号；
  - 事务内重新核对账号、微信绑定、用户三方身份；
  - 生成新 salt/hash，更新密码，不接受客户端传入的账号作为授权依据。
- `bindEmail`
  - 从当前可信微信解析账号；
  - 事务内验证 `bind` 挑战、邮箱唯一性和账号现有邮箱；
  - 新关系设为 `active`，旧关系存在时设为 `revoked`，更新账号邮箱字段并消费验证码。
- `resetPasswordByEmail`
  - 校验账号、邮箱、`active` 邮箱绑定和 `reset` 挑战严格对应；
  - 在同一事务中消费验证码并更新密码 hash/salt。
- `status`
  - 增加 `emailBound` 与 `emailMasked`，不返回邮箱明文。

### `sendEmailCode`

输入：

```js
{ action: 'send', purpose: 'bind' | 'reset', account?, email }
```

- `bind`：只允许当前微信已绑定且账号状态正常时发送；若邮箱已绑定其他账号，返回 `EMAIL_ALREADY_BOUND`。
- `reset`：账号与邮箱是否匹配、是否处于目标冷却、真实投递是否失败，一律返回相同的“若信息匹配，验证码将发送至绑定邮箱”文案；仅真实匹配的有效绑定尝试投递，具体失败只写脱敏服务端日志，避免增加账号—邮箱绑定枚举面。全局配置缺失在查找账号前统一返回 `EMAIL_NOT_CONFIGURED`，不依赖目标是否存在。
- 发信前检查配置和邮箱格式；事务同时检查“用途+目标”与“用途+当前 OPENID/账号”两类 60 秒冷却，再预留 `sending` 挑战。绑定请求可明确返回冷却/投递错误；公开找回请求保持通用响应。
- SES 模板变量使用 `code` 和 `minutes`，`TriggerType=1`。

## 客户端交互

### 登录错误

- `ACCOUNT_NOT_FOUND`：显示标题“账号未注册”，正文“未找到该账号，是否现在注册？”，确认后进入注册模式并预填账号。
- `INVALID_PASSWORD`：toast “账号密码错误”。
- 其他错误继续走现有统一错误处理。

按产品明确要求区分账号是否存在会暴露“账号存在性”。本设计只暴露这一项，不返回绑定邮箱、手机号、角色或其他资料。

### 忘记密码

登录密码输入区域增加“忘记密码”链接，进入恢复模式：

- 默认“微信找回”（推荐）：输入新密码和确认密码，服务端使用当前微信身份重置。
- 可切换“邮箱找回”：输入账号、已绑定邮箱、验证码、新密码和确认密码；可发送/倒计时重发验证码。
- 成功后回到账号登录，预填服务端返回的账号并提示使用新密码登录。
- 当前微信未绑定时提示改用已绑定邮箱；邮箱也不可用时提示联系管理员。

恢复模式不要求重新勾选用户协议，因为它不创建账号或建立登录会话。

### 邮箱绑定页

“设置 → 账号与安全”新增邮箱行：

- 未绑定显示“未绑定”，已绑定显示服务端掩码；
- 点击进入独立“邮箱绑定”页面；
- 页面输入邮箱和验证码，支持 60 秒倒计时；
- 已绑定账号可验证新邮箱后更换，成功后返回并刷新状态。

## 错误码

| 错误码 | 用户文案/处理 |
|---|---|
| `ACCOUNT_NOT_FOUND` | 账号未注册，引导注册 |
| `INVALID_PASSWORD` | 账号密码错误 |
| `WECHAT_NOT_BOUND` | 当前微信未绑定，改用邮箱或先登录绑定 |
| `EMAIL_INVALID` | 邮箱格式不正确 |
| `EMAIL_NOT_BOUND` | 邮箱未绑定该账号；恢复请求仍使用通用受理文案 |
| `EMAIL_ALREADY_BOUND` | 该邮箱已绑定其他账号 |
| `EMAIL_CODE_COOLDOWN` | 请等待倒计时后重发 |
| `EMAIL_CODE_INVALID` | 验证码错误 |
| `EMAIL_CODE_EXPIRED` | 验证码已过期，请重新获取 |
| `EMAIL_CODE_LOCKED` | 尝试次数过多，请重新获取 |
| `EMAIL_NOT_CONFIGURED` | 邮件服务尚未配置 |
| `EMAIL_SEND_FAILED` | 邮件发送失败，请稍后重试 |

## 安全约束

1. 密码继续使用随机盐和 `scrypt-v1`，重置后旧密码立即失效。
2. 微信找回不接受客户端 OPENID/账号作为授权身份。
3. 邮箱验证码为 6 位加密安全随机数，有效 10 分钟、最多尝试 5 次、60 秒内不可重发、成功后一次性失效。
4. 验证码只保存 HMAC；生产环境缺少验证码密钥或 SES 配置时失败关闭。
5. `email_bindings`、`email_codes`、`accounts` 均禁止小程序端直接读写。
6. 日志只记录错误类型和服务端 request ID，不打印邮箱、验证码、密码或密钥。
7. 所有 `doc(id).set()` 必须通过统一去 `_id` 边界，测试 fake 同步拒绝 `_id`，防止再次出现只在生产暴露的问题。

## 部署配置

新增云函数 `sendEmailCode`，配置：

- `CUETRACE_SES_SECRET_ID`
- `CUETRACE_SES_SECRET_KEY`
- `CUETRACE_SES_REGION`（只允许 SES 支持地域，默认 `ap-guangzhou`）
- `CUETRACE_SES_FROM_EMAIL`
- `CUETRACE_SES_TEMPLATE_ID`
- `CUETRACE_SES_SUBJECT`（可选，默认“强化杆迹验证码”）
- `CUETRACE_SES_REPLY_TO`（可选）
- `CUETRACE_EMAIL_CODE_SECRET`

`accountAuth` 同样配置 `CUETRACE_EMAIL_CODE_SECRET`。部署前还需在腾讯云 SES 完成服务开通、发信域名验证、发信地址创建和验证码模板审核。

新增集合并设置为仅云函数访问：

- `email_bindings`
- `email_codes`

隐私政策同步增加“已验证邮箱、邮件验证码发送记录用于账户安全与密码找回”的收集目的、使用范围和保护说明；不把验证码明文或 SES 密钥列为收集数据。

## 测试与验收

### 自动化

1. fake 数据库在 `.set({data:{_id}})` 时模拟生产错误；注册和首次绑定仍成功，证明实现已去除 `_id`。
2. 未注册账号与错误密码返回不同错误码，且无写入。
3. 微信找回只重置当前微信绑定账号，错误/缺失绑定零写入。
4. 邮箱绑定覆盖首次绑定、同邮箱冲突、更换后旧邮箱失效、状态仅返回掩码。
5. 邮箱验证码覆盖格式、配置、冷却、过期、错误次数、一次性消费、SES 失败状态。
6. 邮箱找回覆盖正确重置、账号邮箱不匹配、旧验证码复用失败、旧密码失效新密码生效。
7. 登录页覆盖未注册引导、密码错误、两种找回方式和成功回填。
8. 账号与安全页覆盖邮箱状态和绑定页入口；邮箱绑定页覆盖发送、倒计时与提交。

### 真机/云端验收

1. 重新部署 `accountAuth` 和 `sendEmailCode` 并安装云端依赖。
2. 云函数环境变量与两个集合权限配置完成。
3. 注册新账号不再出现 `_id` 错误。
4. 未注册账号可一键进入注册；错误密码文案准确。
5. 当前微信可以重置其绑定账号密码。
6. 在账号与安全页绑定邮箱，能收到 SES 模板验证码并显示掩码邮箱。
7. 退出后通过该邮箱验证码重置密码，旧密码失败、新密码成功。

自动化测试不能替代真实 SES 投递、云函数环境变量、集合权限与微信 `OPENID` 的真机验证；这些保留为部署验收项。

## Final review remediation addendum

最终跨任务审查补充以下必须保持一致的契约：

1. `resetPasswordByWechat` 与 `resetPasswordByEmail` 成功响应必须返回服务端规范账号名 `{ ok: true, account }`，使登录页能回填账号；测试同时验证服务端返回与页面消费，不能只由页面 fake 虚构字段。
2. 重置提交本身与验证码发送一样必须具有请求代次和页面生命周期保护：重复点击只发起一次请求，切换方式、返回登录或卸载后，迟到的 resolve/reject 不得更新状态、弹提示或改变页面模式。
3. 账号到期清理必须同时删除该账号全部 `email_bindings`（包括 active/revoked）和 `email_codes` 挑战，并删除当前 `OPENID` 对应的 actor 限流记录；其他账号/其他 OPENID 的邮箱数据必须保留。任一邮箱集合查询或清理失败时，最终 account/微信绑定/user 认证链不得删除。`users.deletionStatus === 'purging'` 还是所有邮箱写事务的服务端写屏障：bind 发码、reset 发码和 `bindEmail` 必须在各自事务内重读 user，命中时零邮箱写入；reset 发码继续返回统一公开结果。
4. 隐私政策第三方清单必须披露腾讯云 SES 通过 API 接收完整收件邮箱用于验证码投递，并更新政策日期；仍不得披露或保存验证码明文/密钥。
