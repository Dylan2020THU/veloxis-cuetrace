# Codex Task Handoff

> 2026-07-17 手机号独立账号与客户端可撤销会话已完成 Task 1-9；Task 9 已精确提交并通过最终独立规格与质量复审，下一独立目标为 Task 10 的个人资料、社交与约球 ownership 迁移；尚未云端部署或清理测试数据。

## 2026-07-15 当前状态

- 已批准规格：`docs/superpowers/specs/2026-07-15-phone-account-session-login-design.md`。
- 规格独立提交：`22e0a2e docs: design independent account login`；该提交仅包含规格文档，未带入既有大规模暂存内容。
- 可执行计划：`docs/superpowers/plans/2026-07-15-phone-account-session-login-implementation.md`，共 14 个 TDD 任务、92 个可验收步骤；Task 1/2 开工澄清（部署闭包、语义映射、retired 边界、精确策略哨兵及 97 路径 CLI）后的 SHA-256 为 `767F92A01F18C797DC76C3855AE3D08A1D4956F1D9C7A53EDC61620306D7D508`。规格、客户端流程和业务边界三条独立复审均为 PASS，无剩余 Critical/Important 阻断。
- 只读盘点确认：107 个现有云函数入口全部需要分类；最终策略为 108 个入口（新增 `purgeAuthArtifacts`）。其中 93 个入口直接命中 `getWXContext()`、`wechat_bindings` 或 `_openid`，所有符合固定扫描边界的 JavaScript 命中 109 个，另有 16 个支付共享/部署副本必须同步迁移。
- 已锁定的边界：93 文件基线内 67 个会话入口，加上基线外 4 个会话入口，最终共 71 个 `requireSession` 入口；全部策略中有 96 个客户端协议守卫入口，另加 `requestTableRefund` 用户分支，共 97 条协议守卫路径。认证、公共、管理员、签名回调、定时任务、混合退款和“会话所有者 + payerOpenid”保持独立信任边界。
- Task 1 已完成迁移矩阵和机器可读入口策略，独立复审无 Critical/Important。
- Task 2 已完成 v1 兼容协议/维护守卫和不可变检查点：97 条路径、329 个载荷文件，检查点 SHA-256 为 `3599b1b52ee801392c0e440a74fda8ef9702faffe2e85dacafedd8615c041743`。
- Task 2 提交为 `2a954d8`，原子同步修复提交为 `49f538f`；最终复审 Critical 0 / Important 0。提交后同步、矩阵、CLI、协议守卫、共享副本和检查点测试均通过。
- Task 3 提交为 `7feea12`，精确包含 162 个密码学/会话原语与策略副本路径；两路独立复审均为 Critical 0 / Important 0。
- Task 3 提交后四模块同步 155 份，密码学、会话和共享副本测试通过；事务外令牌准备、typed transaction abort、live `authVersion` 校验和 CloudBase `_id` 写入边界均已锁定。
- Task 4 提交为 `00e0889`，精确包含共享短信原语、两份策略副本、`sendSmsCode` v2 入口及两项测试共 6 个路径；两路独立复审均为 Critical 0 / Important 0。
- Task 4 提交后短信同步 2 份，SMS、共享副本、6 项语法、8 项严格文本、3 个受保护文件哈希及隔离检查全部通过；绝对供应商总超时、用途/范围/代次、密钥轮换限流、终态、五次锁定、一次性消费和真实事务冲突重试均已锁定。
- Task 5 提交为 `9337a7104feb`，精确包含 20 个账号/会话/微信证明/角色/清理入口、合同和测试路径；最终独立复审为 `Critical 0 / Important 0 / Minor 0 / Ready`。
- Task 5 根验证通过 9 个 focused 测试、15 个 JavaScript 语法检查、3 个 JSON 解析、`108/108/0` 迁移矩阵和 97 份认证副本一致性；三维密码限流、短信/证明密钥轮换、101+ 会话游标分页、删除宽限取消与事务回滚均已锁定。
- Task 5 精确提交后零路径残留、零删除；无关暂存区保持 `11,381` 路径，SHA-256 仍为 `BFBB6D7823BAFAB8F7C447C0D5F0EA54DED0058B007081D07AEBBF027709630F`。
- Task 6 提交为 `7d1ea60f73d9`，精确包含 8 个邮箱发送、账号安全动作与聚焦测试路径；发送端和账号端最终独立复审均为 `Critical 0 / Important 0 / Ready`。
- Task 6 根验证通过 `emailRecovery`、`authSessions`、`accountWechatBinding`、`authSharedParity`、`authMigrationMatrix`、`loginMethods` 六个 focused 测试和 8 项 JavaScript 语法检查；schema 2 严格 union、9.5 秒抗枚举、双向唯一 reverse、精确 10 分钟 TTL、删除申请一致性、多端会话失效和 6 小时复验字段边界均已锁定。
- Task 6 精确提交后零路径残留、零删除；无关暂存区保持 `11,380` 路径，staged-entry SHA-256 为 `090265A0821B08A9B4EC24B836B93FBD92FC4434878757E2430D49EAF8754420`。
- Task 7 客户端提交为 `b8416ef`，精确包含协议常量、会话/CAS、App 启动、typed data facade 和 focused 测试 5 个路径；角色选择兼容修正单独提交为 `29f8ca1`。
- Task 7 根验证通过 `authClientSession`、`accountWechatBinding`、5 项 JavaScript 语法和 scoped diff；两路最终复审均为 `Critical 0 / Important 0 / Ready`。
- Task 7 精确提交后零路径残留、零删除；排除 5 个目标路径后的无关暂存区保持 `11,378` 项，SHA-256 为 `5833167E415F6F208F339D69FAB4C669358F6BFECE49AE429445296B57F611DA`。
- Task 8 提交为 `d6a6d37`，精确包含登录页三文件、typed data facade 和两份 focused 测试共 6 个路径；最终独立复审为 `Critical 0 / Important 0 / Minor 0 / Ready`。
- Task 8 根验证通过 `loginMethods`、`registerAccountRules`、`authClientSession`、`accountWechatBinding`、2 项 JavaScript 语法和 scoped diff；验证码即注册、密码登录、账号名注册、显式微信绑定确认、公开找回非枚举、会话 CAS 和生命周期竞态均已锁定。
- Task 8 精确提交后目标路径零残留；排除 6 个目标路径后的无关索引保持 `11,374` 个 staged 路径、`11,759` 个索引项，SHA-256 为 `CF199C9361DF0BB715CDEB63A67F26DC0D50CE6B2F7206FD26C2E4855807E016`。
- 当前未部署云函数、未改数据库权限、未清理云端测试数据、未删除仓库文件。

### 2026-07-17 Task 9 完成状态

- Task 9 已在 `main` 精确提交为 `1acc5e3 feat: add account security credential controls`，提交严格包含 29 个目标路径；未执行 reset、clean、checkout、部署、数据清理或文件删除。
- 实施范围完成账号安全主页、近期认证组件、账号名/密码/手机号凭证页、当前/其他设备会话控制，并补入邮箱深链失败关闭 WXML 与真实短信/邮箱/status 响应 fixture 两个必要范围扩展。
- 最终独立规格复审为 `PASS`，最终独立质量复审为 `APPROVED`；两者均为 `Critical 0 / Important 0 / Minor 0`。
- 根任务新鲜验证通过 `accountSecurityPage`、`coachProfileSettingsBinding`、`loginMethods`、`registerAccountRules`、`authClientSession`、`accountWechatBinding` 六个测试文件，JavaScript 语法 `11/11`、JSON 解析 `6/6`、目标范围 diff/空白检查全部通过。
- 严格 `security_status` 合同、成功/拒绝双路径 captured-token 门禁、近期认证真实生命周期、敏感动作 retry-once、邮箱直接深链失败关闭、退出单飞、精确缓存保留和 live `currentRole` 路由均已锁定。
- 提交后 29 个目标路径零残留、零删除；总索引路径 `11,782`，排除目标后的无关索引路径保持 `11,753`，SHA-256 为 `A5BCEA38FA9C0FE1AE246D43C11CA1111A29B30DFB30C30E2CB87DA050B0C458`。
- 实施报告：`.superpowers/sdd/auth-v2-task-9-report.md`。全量 `scripts/codex-verify.ps1` 仍按计划只在 Task 14 最终收口运行；本阶段未做云端部署、数据库权限/索引变更或真机验收。

## 2026-07-17 下一任务入口

- 下一独立目标为计划 Task 10：将个人资料、社交和约球的 ownership/foreign key 从 `_openid`、`authorOpenid`、`targetOpenid` 迁移为 `accountId` 字段，并把对应客户端协议守卫从 schema `[1]` 切换到 `[2]`。
- 开工顺序：完整阅读规格、实现计划与本 HANDOFF，先快照大型索引；创建 `tests/socialSessionAuth.test.js`、`tests/matchSessionAuth.test.js`，并补齐既有个人资料/约球测试，取得跨手机号、账号名、微信登录同一数据集以及横向越权拒绝的 RED 证据。
- 实施时每个受保护入口必须先调用本地 `requireSession`；schemaVersion 2 记录只写计划中的 v2 字段，不得静默双读旧 owner key。旧测试记录在统一测试数据重置前保持不可访问。
- Task 10 完成完整 focused 集、身份字段扫描、共享副本校验及独立复审后，才可按精确 pathspec 使用计划提交消息 `refactor: key social ownership by account id`；不得提前进入 Task 11。
- 当前仓库存在大量既有暂存内容，不能从 `HEAD` 建出包含完整业务代码的干净 worktree；实施必须留在当前工作区，使用精确 pathspec 提交，禁止 `git add -A`、裸 `git commit`、reset 或清理用户索引。
- 协议守卫的 v1 兼容提交和 `.superpowers/sdd/auth-v2-guard-v1-compat.zip` 必须独立保留，以支持先部署守卫、再进入维护窗口的发布顺序。
- 任何测试数据清理前，仍需先用只读查询提交“集合 + 文档数量 + 旧身份字段 + 影响范围”的精确清单，并再次获得张总确认。
- 生产部署还需要 CloudBase 集合/索引/私有权限、认证密钥环、腾讯云短信配置、维护窗口和真机条件；这些均属于计划 Task 14 的外部门禁。

---

## 2026-07-14 历史交接

> 2026-07-14 Task 8 本地代码最终收口；生产部署与真实资金 UAT 仍是外部门禁。

## 当前状态

- 按桌抽成本地实现已经完成，最终独立复审为 `Critical 0 / Important 0 / Minor 0`。
- 标准费率为总成本 5%（含通道费），抽成基数仅为最终留存的顾客实付球桌费；球厅目标为该现金的 95% 加留存券补贴，外部现金/POS 不抽成。
- 支付恢复、迟到成功、可信权益、T+1 官方账单、分账/解冻 24 小时熔断、含券退款、报表、旧收费退役和精确签到槽位均已实现。
- 本地代码完成不等于生产可发布；真实商户资质、密钥、回调、财税审批和真实资金验收尚未执行。

## 最终验证

- 张总授权的替代性最终 verifier：43/43 测试通过，307/307 JavaScript 语法通过，619/619 文本通过。
- `DIFF_CHECK=PASS`，419 个命名测试，0 个未引用，最终 `STATUS=PASS`。
- 首次运行发现 README 并发退役说明缺失，并暴露旧 verifier 在 unborn + populated index 下误报 `JS_TOTAL=0/TEXT_FILES=0`；两项均经 TDD 修复和独立复审后才执行替代运行。
- 169 个业务 JSON 全部通过 Node 严格解析；167 个原样通过 Windows PowerShell 5.1 `ConvertFrom-Json`。两个 npm lockfile仅因标准 `packages[""]` 空键触发 PowerShell 5.1 限制，已通过兼容结构检查，未改写文件。
- 共享库同步 68 份；对账 36 项、退款 36 项、微信支付适配器 48 项及关键 focused 测试均通过。

## 最终文件清单

- Git 仍为 unborn `main`，没有 `HEAD`；未执行 Git 初始化、暂存、提交、推送或合并。
- 现有索引排除 `.agents/**` 后共 7,179 项；最终业务范围为 640 个 cached 文件、0 个未跟踪文件。
- 工作树覆盖 18 个业务文件；索引删除 0、工作树删除 0。
- 最终收口没有删除文件。此前仅按张总明确授权删除 3 个误建 `getPublicTableOrder` 文件，空 `lib` 目录继续保留。

## 外部发布门禁

- 普通服务商申请、AppID/MchID 绑定、特约商户进件、合同和分账授权完成。
- 生产私钥、APIv3 密钥、可信平台证书/公钥、加密公钥 ID、回调 URL 和接收方配置进入密钥存储。
- 在目标 CloudBase 创建权限、索引、定时器和私有账单存储，并验证 HTTPS 原始 body 与四个 `Wechatpay-*` 头的转发。
- 财务、法务、税务、发票、退款责任、投诉和数据留存完成审批。
- 真机完成小额支付、T+1 账单、分账、解冻、部分/全额退款、重试、回调和逐笔对账。

## 交接入口

- 最终报告：`.superpowers/sdd/table-commission-task-8-report.md`。
- 部署手册：`docs/table-commission-deployment.md`。
- 批准规格与计划：`docs/superpowers/specs/2026-07-14-table-commission-billing-design.md`、`docs/superpowers/plans/2026-07-14-table-commission-billing-implementation.md`。
- 阶段 ZIP 是最终修正前的历史检查点，不能作为最终发布包。

下一独立目标应是有商户资质和密钥条件下的生产配置审查与真实资金 UAT，不再是本地功能开发。
