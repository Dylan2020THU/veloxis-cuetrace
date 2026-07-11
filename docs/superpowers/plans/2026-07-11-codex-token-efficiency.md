# CueTrace Codex Token Efficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变 `gpt-5.6-sol + ultra`、测试覆盖、安全审查或权限配置的前提下，用项目级规则和只读摘要脚本减少重复上下文与工具输出。

**Architecture:** 三个独立 PowerShell 脚本分别负责上下文预算、工作树摘要和最终验证；`AGENTS.md` 负责把脚本和最小上下文约束固化为项目惯例，`docs/codex/HANDOFF.md` 提供跨任务交接格式。所有脚本默认只读，失败时保留非零退出和必要详情。

**Tech Stack:** Windows PowerShell 5.1、Git、Node.js、Codex JSONL session、Markdown。

## Global Constraints

- 仅修改当前 CueTrace 仓库，不修改全局 Codex 配置。
- 保持 `gpt-5.6-sol` 与 `model_reasoning_effort = "ultra"`；不得为了节省 token 降级模型或审查能力。
- 不删除任何文件，不修改 `.agents`，不部署业务代码。
- 成功输出必须摘要化；失败输出必须保留可诊断证据并非零退出。
- focused 测试随行为修改运行；全量验证只在最终收口运行一次。

---

### Task 1: 上下文预算摘要

**Files:**
- Create: `scripts/codex-context.ps1`

**Interfaces:**
- Consumes: `%USERPROFILE%\.codex\sessions\**\rollout-*.jsonl` 中最后一条 `payload.type=token_count` 事件。
- Produces: 最多 7 行 `KEY=VALUE`，包含 `STATUS`、session、last input/cached/output、cached 百分比和 context 百分比。

- [ ] **Step 1: 验证脚本尚不存在**

Run:

```powershell
if (Test-Path scripts/codex-context.ps1) { throw 'unexpected existing script' }
```

Expected: PASS，确认不会覆盖用户已有脚本。

- [ ] **Step 2: 创建最小只读实现**

Create `scripts/codex-context.ps1`：

```powershell
[CmdletBinding()]
param(
  [int]$InputThreshold = 80000,
  [double]$ContextThreshold = 0.5,
  [string]$SessionsRoot = (Join-Path $env:USERPROFILE '.codex\sessions')
)

$ErrorActionPreference = 'Stop'

function Write-Unknown([string]$Reason) {
  Write-Output 'STATUS=CONTEXT_UNKNOWN'
  Write-Output ("REASON={0}" -f $Reason)
}

try {
  if (-not (Test-Path -LiteralPath $SessionsRoot)) {
    Write-Unknown 'SESSIONS_ROOT_NOT_FOUND'
    exit 0
  }

  $session = Get-ChildItem -LiteralPath $SessionsRoot -Recurse -File -Filter 'rollout-*.jsonl' |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $session) {
    Write-Unknown 'SESSION_NOT_FOUND'
    exit 0
  }

  $info = $null
  Get-Content -LiteralPath $session.FullName -Tail 5000 -Encoding UTF8 | ForEach-Object {
    if ($_.IndexOf('"type":"token_count"') -lt 0) { return }
    try {
      $event = $_ | ConvertFrom-Json
      if ($event.payload.info -and $event.payload.info.last_token_usage) {
        $info = $event.payload.info
      }
    } catch {}
  }
  if (-not $info) {
    Write-Unknown 'TOKEN_COUNT_NOT_FOUND'
    exit 0
  }

  $usage = $info.last_token_usage
  $contextWindow = [double]$info.model_context_window
  if (-not $contextWindow -or $contextWindow -le 0) {
    Write-Unknown 'CONTEXT_WINDOW_INVALID'
    exit 0
  }

  $inputTokens = [double]$usage.input_tokens
  $cachedTokens = [double]$usage.cached_input_tokens
  $contextRatio = $inputTokens / $contextWindow
  $cachedRatio = if ($inputTokens -gt 0) { $cachedTokens / $inputTokens } else { 0 }
  $status = if ($inputTokens -gt $InputThreshold -or $contextRatio -ge $ContextThreshold) {
    'NEW_TASK_RECOMMENDED'
  } else {
    'CONTEXT_OK'
  }

  Write-Output ("STATUS={0}" -f $status)
  Write-Output ("SESSION={0}" -f $session.BaseName)
  Write-Output ("LAST_INPUT={0}" -f [int64]$inputTokens)
  Write-Output ("LAST_CACHED={0}" -f [int64]$cachedTokens)
  Write-Output ("LAST_OUTPUT={0}" -f [int64]$usage.output_tokens)
  Write-Output ("CACHED_PERCENT={0:N1}" -f ($cachedRatio * 100))
  Write-Output ("CONTEXT_PERCENT={0:N1}" -f ($contextRatio * 100))
} catch {
  Write-Unknown 'READ_FAILED'
  exit 0
}
```

- [ ] **Step 3: 验证当前长线程会给出换任务建议且输出受限**

Run:

```powershell
$output = @(& powershell -NoProfile -ExecutionPolicy Bypass -File scripts/codex-context.ps1 -InputThreshold 1)
if ($LASTEXITCODE -ne 0) { throw 'context script failed' }
if ($output.Count -gt 8) { throw "too many lines: $($output.Count)" }
if ($output -notcontains 'STATUS=NEW_TASK_RECOMMENDED') { throw ($output -join "`n") }
```

Expected: PASS；不出现原始 JSONL。

- [ ] **Step 4: 验证缺失 session 时安全降级**

Run:

```powershell
$output = @(& powershell -NoProfile -ExecutionPolicy Bypass -File scripts/codex-context.ps1 -SessionsRoot "$env:TEMP\missing-codex-sessions")
if ($LASTEXITCODE -ne 0) { throw 'unknown context must not block work' }
if ($output[0] -ne 'STATUS=CONTEXT_UNKNOWN') { throw ($output -join "`n") }
```

Expected: PASS。

- [ ] **Step 5: 提交 Task 1**

```powershell
git add scripts/codex-context.ps1
git commit -m "feat: add Codex context budget summary"
```

---

### Task 2: 工作树与验收摘要

**Files:**
- Create: `scripts/codex-status.ps1`

**Interfaces:**
- Consumes: 当前 Git 工作树与 `README.md` 验收复选框。
- Produces: 固定 10 行 branch、HEAD、业务状态、`.agents` 状态和 README checked/unchecked 计数。

- [ ] **Step 1: 验证脚本尚不存在**

Run:

```powershell
if (Test-Path scripts/codex-status.ps1) { throw 'unexpected existing script' }
```

Expected: PASS。

- [ ] **Step 2: 创建状态摘要实现**

Create `scripts/codex-status.ps1`：

```powershell
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Invoke-Git([string[]]$Arguments) {
  $output = @(& git -c core.quotePath=false -c core.excludesFile= @Arguments 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw (($output | Where-Object { $_ -notmatch '^warning:' }) -join "`n")
  }
  return @($output | Where-Object { $_ -notmatch '^warning:' })
}

function Get-StateCounts([string[]]$Lines) {
  $untracked = @($Lines | Where-Object { $_.Substring(0, 2) -eq '??' }).Count
  $deleted = @($Lines | Where-Object {
    $_.Substring(0, 2) -ne '??' -and $_.Substring(0, 2) -match 'D'
  }).Count
  $modified = $Lines.Count - $untracked - $deleted
  return [PSCustomObject]@{
    Modified = $modified
    Deleted = $deleted
    Untracked = $untracked
  }
}

try {
  $root = (Invoke-Git @('rev-parse', '--show-toplevel') | Select-Object -First 1)
  $branch = (Invoke-Git @('branch', '--show-current') | Select-Object -First 1)
  $head = (Invoke-Git @('rev-parse', '--short', 'HEAD') | Select-Object -First 1)
  $status = @(Invoke-Git @('status', '--short'))
  $agents = @($status | Where-Object { $_ -match '(^|[" ])\.agents/' })
  $business = @($status | Where-Object { $_ -notmatch '(^|[" ])\.agents/' })
  $businessCounts = Get-StateCounts $business
  $agentCounts = Get-StateCounts $agents
  $readme = Join-Path $root 'README.md'
  if (-not (Test-Path -LiteralPath $readme)) { throw 'README.md not found' }
  $checked = @(Select-String -Path $readme -Encoding UTF8 -Pattern '^- \[[xX]\]').Count
  $unchecked = @(Select-String -Path $readme -Encoding UTF8 -Pattern '^- \[ \]').Count

  Write-Output ("BRANCH={0}" -f $branch)
  Write-Output ("HEAD={0}" -f $head)
  Write-Output ("BUSINESS_MODIFIED={0}" -f $businessCounts.Modified)
  Write-Output ("BUSINESS_DELETED={0}" -f $businessCounts.Deleted)
  Write-Output ("BUSINESS_UNTRACKED={0}" -f $businessCounts.Untracked)
  Write-Output ("AGENTS_MODIFIED={0}" -f $agentCounts.Modified)
  Write-Output ("AGENTS_DELETED={0}" -f $agentCounts.Deleted)
  Write-Output ("AGENTS_UNTRACKED={0}" -f $agentCounts.Untracked)
  Write-Output ("README_CHECKED={0}" -f $checked)
  Write-Output ("README_UNCHECKED={0}" -f $unchecked)
} catch {
  Write-Output 'STATUS_ERROR=CODEX_STATUS_FAILED'
  Write-Error $_.Exception.Message
  exit 1
}
```

- [ ] **Step 3: 验证摘要与直接状态计数一致**

Run:

```powershell
$output = @(& powershell -NoProfile -ExecutionPolicy Bypass -File scripts/codex-status.ps1)
if ($LASTEXITCODE -ne 0) { throw 'status script failed' }
if ($output.Count -ne 10) { throw "expected 10 lines, got $($output.Count)" }
$summary = @{}
$output | ForEach-Object { $key, $value = $_ -split '=', 2; $summary[$key] = $value }
$raw = @(git -c core.quotePath=false -c core.excludesFile= status --short)
$agents = @($raw | Where-Object { $_ -match '(^|[" ])\.agents/' })
$business = @($raw | Where-Object { $_ -notmatch '(^|[" ])\.agents/' })
function DirectCounts([string[]]$lines) {
  $untracked = @($lines | Where-Object { $_.Substring(0, 2) -eq '??' }).Count
  $deleted = @($lines | Where-Object { $_.Substring(0, 2) -ne '??' -and $_.Substring(0, 2) -match 'D' }).Count
  [PSCustomObject]@{ Modified = $lines.Count - $untracked - $deleted; Deleted = $deleted; Untracked = $untracked }
}
$rawBusiness = DirectCounts $business
$rawAgents = DirectCounts $agents
foreach ($name in @('MODIFIED', 'DELETED', 'UNTRACKED')) {
  if ([int]$summary["BUSINESS_$name"] -ne [int]$rawBusiness.$name) { throw "business $name mismatch" }
  if ([int]$summary["AGENTS_$name"] -ne [int]$rawAgents.$name) { throw "agents $name mismatch" }
}
```

Expected: PASS；输出中不列出路径。

- [ ] **Step 4: 提交 Task 2**

```powershell
git add scripts/codex-status.ps1
git commit -m "feat: add concise Codex workspace status"
```

---

### Task 3: 单入口最终验证

**Files:**
- Create: `scripts/codex-verify.ps1`

**Interfaces:**
- Consumes: `tests/*.test.js`、`main` merge-base、当前 tracked/untracked 业务文件。
- Produces: 成功时最多 10 行摘要；失败时非零退出，并只展开失败测试、语法、diff、文本或未引用测试详情。

- [ ] **Step 1: 验证脚本尚不存在**

Run:

```powershell
if (Test-Path scripts/codex-verify.ps1) { throw 'unexpected existing script' }
```

Expected: PASS。

- [ ] **Step 2: 创建完整验证实现**

Create `scripts/codex-verify.ps1`：

```powershell
[CmdletBinding()]
param([string]$Baseline = 'main')

$ErrorActionPreference = 'Stop'

function Invoke-Git([string[]]$Arguments, [switch]$AllowFailure) {
  $output = @(& git -c core.quotePath=false -c core.excludesFile= @Arguments 2>&1)
  $exitCode = $LASTEXITCODE
  $clean = @($output | Where-Object { $_ -notmatch '^warning:' })
  if ($exitCode -ne 0 -and -not $AllowFailure) {
    throw ($clean -join "`n")
  }
  return [PSCustomObject]@{ ExitCode = $exitCode; Output = $clean }
}

$testFailures = @()
$jsFailures = @()
$textFailures = @()
$unreferenced = @()
$diffOutput = @()

try {
  $root = ((Invoke-Git @('rev-parse', '--show-toplevel')).Output | Select-Object -First 1)
  Push-Location $root
  try {
    $testFiles = @(Get-ChildItem -LiteralPath tests -Filter '*.test.js' | Sort-Object Name)
    foreach ($file in $testFiles) {
      $output = @(& node $file.FullName 2>&1)
      if ($LASTEXITCODE -ne 0) {
        $testFailures += [PSCustomObject]@{ File = $file.Name; Output = $output }
      }
    }

    $mergeBase = ((Invoke-Git @('merge-base', 'HEAD', $Baseline)).Output | Select-Object -First 1)
    $tracked = (Invoke-Git @('diff', '--name-only', $mergeBase, '--', '.', ':(exclude).agents/**')).Output
    $untracked = (Invoke-Git @('ls-files', '--others', '--exclude-standard', '--', '.', ':(exclude).agents/**')).Output
    $changed = @($tracked + $untracked | Sort-Object -Unique)
    $jsFiles = @($changed | Where-Object { $_ -match '\.js$' -and (Test-Path -LiteralPath $_ -PathType Leaf) })
    foreach ($file in $jsFiles) {
      $output = @(& node --check $file 2>&1)
      if ($LASTEXITCODE -ne 0) {
        $jsFailures += [PSCustomObject]@{ File = $file; Output = $output }
      }
    }

    $diff = Invoke-Git @('diff', '--check', $mergeBase, '--', '.', ':(exclude).agents/**') -AllowFailure
    if ($diff.ExitCode -ne 0) { $diffOutput = $diff.Output }

    $textExtensions = @('.js', '.json', '.md', '.wxml', '.wxss', '.css', '.html', '.toml', '.ps1')
    $textFiles = @($changed | Where-Object {
      (Test-Path -LiteralPath $_ -PathType Leaf) -and $textExtensions -contains [IO.Path]::GetExtension($_).ToLowerInvariant()
    })
    $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
    foreach ($file in $textFiles) {
      try {
        $text = $utf8.GetString([IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $file)))
        if ($text -match '(?m)[ \t]+$') { $textFailures += "$file`:trailing-whitespace" }
        if ($text -match '(?m)^(<<<<<<<|=======|>>>>>>>)') { $textFailures += "$file`:conflict-marker" }
      } catch {
        $textFailures += "$file`:invalid-utf8"
      }
    }

    $namedTests = 0
    foreach ($file in $testFiles) {
      $text = [IO.File]::ReadAllText($file.FullName)
      $definitions = [regex]::Matches($text, '(?:async\s+)?function\s+(test[A-Za-z0-9_]+)\s*\(')
      foreach ($definition in $definitions) {
        $namedTests += 1
        $name = $definition.Groups[1].Value
        if ([regex]::Matches($text, ('\b' + [regex]::Escape($name) + '\b')).Count -lt 2) {
          $unreferenced += "$($file.Name)`:$name"
        }
      }
    }

    foreach ($failure in $testFailures) {
      Write-Output ("FAIL_TEST={0}" -f $failure.File)
      $failure.Output | Write-Output
    }
    foreach ($failure in $jsFailures) {
      Write-Output ("FAIL_JS={0}" -f $failure.File)
      $failure.Output | Write-Output
    }
    $diffOutput | ForEach-Object { Write-Output ("FAIL_DIFF={0}" -f $_) }
    $textFailures | ForEach-Object { Write-Output ("FAIL_TEXT={0}" -f $_) }
    $unreferenced | ForEach-Object { Write-Output ("FAIL_UNREFERENCED={0}" -f $_) }

    $failed = $testFailures.Count + $jsFailures.Count + $diffOutput.Count + $textFailures.Count + $unreferenced.Count
    Write-Output ("TESTS_TOTAL={0}" -f $testFiles.Count)
    Write-Output ("TESTS_FAILED={0}" -f $testFailures.Count)
    Write-Output ("JS_TOTAL={0}" -f $jsFiles.Count)
    Write-Output ("JS_FAILED={0}" -f $jsFailures.Count)
    Write-Output ("DIFF_CHECK={0}" -f $(if ($diffOutput.Count) { 'FAIL' } else { 'PASS' }))
    Write-Output ("TEXT_FILES={0}" -f $textFiles.Count)
    Write-Output ("TEXT_ERRORS={0}" -f $textFailures.Count)
    Write-Output ("NAMED_TESTS={0}" -f $namedTests)
    Write-Output ("UNREFERENCED_TESTS={0}" -f $unreferenced.Count)
    Write-Output ("STATUS={0}" -f $(if ($failed) { 'FAIL' } else { 'PASS' }))
    if ($failed) { exit 1 }
  } finally {
    Pop-Location
  }
} catch {
  Write-Output 'STATUS=FAIL'
  Write-Error $_.Exception.Message
  exit 1
}
```

- [ ] **Step 3: 验证脚本可解析且包含全部质量门槛**

Run:

```powershell
$source = Get-Content -LiteralPath scripts/codex-verify.ps1 -Raw -Encoding UTF8
[void][scriptblock]::Create($source)
foreach ($required in @('tests', 'node --check', 'diff', 'invalid-utf8', 'UNREFERENCED_TESTS', 'STATUS={0}')) {
  if ($source -notmatch [regex]::Escape($required)) { throw "missing verification gate: $required" }
}
```

Expected: PASS。此处不提前运行全量测试；完整行为验证只在 Task 4 最终收口执行一次。

- [ ] **Step 4: 提交 Task 3**

```powershell
git add scripts/codex-verify.ps1
git commit -m "feat: add summarized Codex verification"
```

---

### Task 4: 项目规则与交接模板

**Files:**
- Modify: `AGENTS.md`
- Create: `docs/codex/HANDOFF.md`

**Interfaces:**
- Consumes: Tasks 1–3 的三个脚本入口。
- Produces: 对后续 Codex 任务自动生效的项目级 token 规则，以及不超过 50 行的交接模板。

- [ ] **Step 1: 写入项目级规则**

Append to `AGENTS.md` before `# Strict Rules`：

```markdown
## 5. Token 效率且不降能力

- 保持项目默认主模型与最高推理能力；不得为了节省 token 降级实现、审查或安全模型。
- 任务开始优先运行 `scripts/codex-context.ps1` 和 `scripts/codex-status.ps1`；机械检查使用脚本摘要，失败时才展开详情。
- 业务状态默认排除 `.agents/**`；任务未明确涉及技能或缓存时，不读取、同步或修改 `.agents`。
- 禁止打印完整 session、模型缓存、全量配置或大型状态列表，只选择当前任务需要的字段。
- 行为修改后运行 focused 测试；全量测试、全分支语法、diff 和文本检查只由根任务在最终收口运行一次。
- 子代理仅用于真正独立且值得并行的高风险工作；使用短 brief 或 `fork_turns: "none"`，不得默认复制完整线程或嵌套派生。
- commentary 只在里程碑、风险变化或持续工作接近 60 秒时发送，保持两句以内。
- `scripts/codex-context.ps1` 输出 `NEW_TASK_RECOMMENDED` 时，完成当前小阶段后更新 `docs/codex/HANDOFF.md`，并建议在新 Codex 任务继续下一独立目标。
- 上述规则只压缩重复上下文和成功输出，不减少 brainstorming、TDD、独立复审、失败详情或最终验证。
```

- [ ] **Step 2: 创建交接模板**

Create `docs/codex/HANDOFF.md`：

```markdown
# Codex Task Handoff

> 阶段边界更新；保持 50 行以内。正式需求仍以 spec、plan、README 和 Git 历史为准。

## 当前目标

用一句话说明下一任务需要完成的唯一结果，并列出明确非目标。

## 已确认决策

记录只会改变实现方向的决策、约束和用户授权，不复制讨论过程。

## 工作树

记录 branch、HEAD、已改文件、未提交状态，以及必须排除的非业务目录。

## 验证证据

记录最近一次 focused/full 命令、通过数量和仍未执行的真实外部验收。

## 风险与阻断

只列未关闭的 Critical/Important、权限依赖和外部状态；已关闭问题不重复展开。

## 下一入口

给出下一任务应先读取的文件和第一条只读命令。
```

- [ ] **Step 3: 验证规则、模板和脚本引用**

Run:

```powershell
$agents = Get-Content -LiteralPath AGENTS.md -Raw -Encoding UTF8
foreach ($required in @('codex-context.ps1', 'codex-status.ps1', 'codex-verify.ps1', 'fork_turns: "none"', '不减少 brainstorming')) {
  if ($agents -notmatch [regex]::Escape($required)) { throw "missing AGENTS rule: $required" }
}
$handoffLines = @(Get-Content -LiteralPath docs/codex/HANDOFF.md -Encoding UTF8).Count
if ($handoffLines -gt 50) { throw "handoff too long: $handoffLines" }
```

Expected: PASS。

- [ ] **Step 4: 运行状态和上下文摘要**

Run:

```powershell
& powershell -NoProfile -ExecutionPolicy Bypass -File scripts/codex-context.ps1
& powershell -NoProfile -ExecutionPolicy Bypass -File scripts/codex-status.ps1
```

Expected: 每个脚本都以零退出；输出分别不超过 8 行和 10 行。

- [ ] **Step 5: 运行一次最终全量验证**

Run:

```powershell
& powershell -NoProfile -ExecutionPolicy Bypass -File scripts/codex-verify.ps1
```

Expected: `TESTS_TOTAL=24`、`TESTS_FAILED=0`、`STATUS=PASS`。

- [ ] **Step 6: 提交 Task 4**

```powershell
git add AGENTS.md docs/codex/HANDOFF.md
git commit -m "docs: adopt token-efficient Codex workflow"
```

---

## Final Review

- [ ] `git status --short` 只包含用户已有改动或为空，不包含意外文件。
- [ ] `git log -5 --oneline` 能看到四个独立、可回退的实现提交。
- [ ] 全局 `C:\Users\Administrator\.codex\config.toml` 的 model、reasoning、sandbox 和 approval 未被修改。
- [ ] 未删除文件，未触碰 `.agents`。
