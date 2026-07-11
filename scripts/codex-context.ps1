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
