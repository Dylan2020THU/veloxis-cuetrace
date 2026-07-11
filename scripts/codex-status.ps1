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
