# CueTrace Codex Token 效率设计

## 状态与授权

- 日期：2026-07-11
- 范围：仅当前 CueTrace 仓库
- 用户已确认采用“项目规则 + 摘要脚本 + 新任务交接”方案。
- 硬约束：不得降低主模型、推理强度、安全审查、TDD、独立复审或最终验证能力；不得删除任何文件。

## 背景与证据

当前全局配置使用 `gpt-5.6-sol`、`model_reasoning_effort = "ultra"`；本地模型元数据表明该模型默认输出 verbosity 已是 low。因此降低输出 verbosity 没有可观空间，降低模型或推理强度反而可能损失能力。

本次会话记录显示：主长线程累计约 2.145 亿 input token，其中约 2.116 亿为 cached input，缓存占 input 约 98.6%；最近单次普通工具调用仍携带约 24.8 万 input token。其他并行会话的单次 input 也常在 10 万至 27 万之间。该数据说明主要消耗不是新生成的答案或推理，而是长线程历史、系统指令和并行代理上下文被反复送入模型。

过去运行中的主要放大器：

1. 一个功能跨越大量设计、实现、审查和修复回合，后续每个小工具调用继续携带完整长历史。
2. 子代理多次使用完整上下文 fork，导致同一长历史在多个会话重复输入。
3. implementer、reviewer 和根代理重复运行相同全量测试与语法检查。
4. 原始 `git status`、大型配置对象、缓存目录和日志被整段打印，工具输出又进入后续上下文。
5. `.agents` 文档同步漂移污染状态输出，使每次工作树检查产生大量无关文本。

## 目标

1. 将机械状态检查和验证改为确定性脚本，模型只消费短摘要和失败详情。
2. 在长线程达到阈值时形成小型交接记录，并在下一个独立功能中使用新 Codex 任务。
3. 子代理只接收完成任务所需的最小 brief，不复制完整线程。
4. focused 测试保留随改随跑；全量测试、全分支语法和安全扫描只由根代理在最终收口运行一次。
5. 保持现有模型、ultra 推理、测试覆盖、权限边界和审查质量不变。

## 非目标

- 不修改全局 `C:\Users\Administrator\.codex\config.toml`。
- 不切换到更小模型，不降低 reasoning effort，不关闭安全或审批机制。
- 不创建插件或通用 Skill；当前项目级脚本已经足够，避免新增 Skill 指令开销。
- 不自动创建、归档或删除 Codex 任务。
- 不修改或清理 `.agents`，不处理现有业务工作树改动。

## 方案比较

### 方案 A：项目规则、摘要脚本与交接模板（采用）

优点是直接消除重复工具编排与输出噪声，不改变模型能力；规则随仓库生效，脚本可由人和 Codex 共同复用。成本是需要维护少量 PowerShell 脚本。

### 方案 B：创建自定义 Skill

可跨仓库复用，但每次发现和读取 Skill 都会增加上下文，且需要额外版本与安装流程。当前仅优化一个仓库，收益不足。

### 方案 C：降低模型或 reasoning effort

可以减少部分 reasoning token，但本次绝大多数消耗来自重复 input；该方案命中错误瓶颈，并违反“不牺牲能力”的约束，因此不采用。

## 设计

### 1. `AGENTS.md` 项目规则

新增“Token 效率且不降能力”章节：

- 保持项目默认主模型与最高推理能力；不得为了节省 token 降级实现或审查模型。
- 搜索、状态、测试和差异检查优先调用仓库脚本；只有失败时才展开原始详情。
- 默认排除 `.agents/**` 的业务 diff；只有任务明确涉及技能或缓存时才读取该目录。
- 禁止打印完整会话、模型缓存、全量配置或大型状态列表；只选择任务相关字段。
- focused 测试在每次行为修改后运行；全量测试、全分支 JS 语法与 diff 检查在最终收口运行一次。
- 子代理仅用于真正独立且值得并行的高风险工作；使用短 brief 或 `fork_turns: "none"`，不得默认复制完整线程，不得默认嵌套派生代理。
- commentary 只在里程碑、风险变化或持续工作接近 60 秒时发送，保持两句以内。
- 当上下文脚本给出 `NEW_TASK_RECOMMENDED` 时，在当前阶段完成后写交接摘要，并建议用户在新任务继续下一独立目标。

这些规则只压缩重复过程，不减少设计、实现、测试或审查步骤。

### 2. `scripts/codex-context.ps1`

职责：只读分析最新 Codex session 的最后一条 `token_count`，输出：

- session ID
- last input / cached input / output token
- 模型上下文占用比例
- 建议状态

阈值：last input 超过 80,000，或达到模型上下文的 50%，输出 `NEW_TASK_RECOMMENDED`；否则输出 `CONTEXT_OK`。无法读取 session 时返回明确的 `CONTEXT_UNKNOWN`，不阻塞开发。

输出不超过 8 行，不打印原始 JSONL。脚本不得修改 Codex session 或配置。

### 3. `scripts/codex-status.ps1`

职责：以固定短格式汇总：

- 当前 branch 与 HEAD
- 排除 `.agents/**` 后的业务 modified/deleted/untracked 数量
- `.agents` 的 collapsed modified/deleted/untracked 数量
- README 真实环境验收 checked/unchecked 数量

正常输出不超过 12 行，不列出全部路径。Git 或 README 读取失败时非零退出并只输出失败步骤。

### 4. `scripts/codex-verify.ps1`

职责：复用当前质量门槛并只输出摘要：

1. 顺序运行 `tests/*.test.js`，保留每个失败文件的原始输出；成功文件只计数。
2. 对 `main` merge-base 到当前工作树的全部变更 `.js`（包括未跟踪业务 JS，排除 `.agents/**`）运行 `node --check`。
3. 运行 `git diff --check`。
4. 对全部变更和未跟踪业务文本执行严格 UTF-8、尾空白与冲突标记检查，覆盖 `git diff --check` 不包含的未跟踪文件。
5. 检查命名 `test*` 函数至少出现定义和执行引用。
6. 汇总 tests、JS、diff、文本和未引用测试数量；任何一项失败即非零退出。

脚本不会部署、暂存、提交、恢复或删除文件。它保留完整验证能力，只压缩成功输出。

### 5. `docs/codex/HANDOFF.md`

提供不超过 50 行的交接模板：

- 当前目标与明确非目标
- 已确认决策
- 已改文件与未提交状态
- 最新 focused / full 验证证据
- 未解决的 Critical / Important 与真实外部验收
- 下一步唯一入口

交接只在阶段边界更新；它不替代正式 spec、plan、README 或 Git 历史。

## 工作流

1. 任务开始先运行 `codex-context.ps1` 和 `codex-status.ps1`。
2. 若建议新任务，先用 HANDOFF 模板压缩必要状态；完成当前小阶段后再切换，不在修改中途换线程。
3. 实现阶段只运行相关 focused 测试。
4. 独立 reviewer 读取 spec、diff 和短 brief，不读取完整对话历史。
5. 根代理在所有实现与审查完成后运行一次 `codex-verify.ps1`。
6. 最终回复引用脚本摘要、真实环境未验收项和工作树状态。

## 错误处理与安全

- 所有脚本默认只读；验证脚本运行现有测试，但不执行部署或 Git 写操作。
- 任一测试、语法或 diff 检查失败时保持非零退出，不能为了短输出吞掉错误。
- 脚本不得输出配置密钥、认证信息或 session 原文。
- `.agents` 始终单独计数，不自动恢复或删除。
- 模型、reasoning effort、sandbox、approval 和权限配置保持不变。

## 验收标准

1. 当前 24 个测试文件仍全部通过。
2. `codex-status.ps1` 的业务状态计数与同一时刻直接过滤 `.agents/**` 的 `git status --short` 一致；`.agents` 三类计数同样与原始状态一致，不依赖历史硬编码数字。
3. `codex-context.ps1` 对当前长线程输出 `NEW_TASK_RECOMMENDED`，且不打印原始 session 内容。
4. `codex-verify.ps1` 能重现完整测试、JS 语法、diff 与命名测试检查，成功时输出不超过 20 行。
5. `AGENTS.md` 明确保持模型能力和全部质量门槛。
6. 不修改全局 Codex 配置，不删除文件，不触碰现有 `.agents` 漂移。

## 变更边界

- Modify: `AGENTS.md`
- Create: `scripts/codex-context.ps1`
- Create: `scripts/codex-status.ps1`
- Create: `scripts/codex-verify.ps1`
- Create: `docs/codex/HANDOFF.md`
- Create: `docs/superpowers/plans/2026-07-11-codex-token-efficiency.md`

除上述文件与本设计文档外，不修改业务代码、测试、全局配置或缓存。
