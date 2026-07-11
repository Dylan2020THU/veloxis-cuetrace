[CmdletBinding()]
param([string]$Baseline = 'main')

$ErrorActionPreference = 'Stop'

function Invoke-Git([string[]]$Arguments, [switch]$AllowFailure) {
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = @(& git -c core.quotePath=false -c core.excludesFile= @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  $clean = @($output | Where-Object { $_ -notmatch '^warning:' })
  if ($exitCode -ne 0 -and -not $AllowFailure) {
    throw ($clean -join "`n")
  }
  return [PSCustomObject]@{ ExitCode = $exitCode; Output = $clean }
}

function Invoke-Node([string[]]$Arguments) {
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = @(& node @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  return [PSCustomObject]@{ ExitCode = $exitCode; Output = $output }
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
      $result = Invoke-Node @($file.FullName)
      if ($result.ExitCode -ne 0) {
        $testFailures += [PSCustomObject]@{ File = $file.Name; Output = $result.Output }
      }
    }

    $mergeBase = ((Invoke-Git @('merge-base', 'HEAD', $Baseline)).Output | Select-Object -First 1)
    $tracked = (Invoke-Git @('diff', '--name-only', $mergeBase, '--', '.', ':(exclude).agents/**')).Output
    $untracked = (Invoke-Git @('ls-files', '--others', '--exclude-standard', '--', '.', ':(exclude).agents/**')).Output
    $changed = @($tracked + $untracked | Sort-Object -Unique)
    $jsFiles = @($changed | Where-Object { $_ -match '\.js$' -and (Test-Path -LiteralPath $_ -PathType Leaf) })
    foreach ($file in $jsFiles) {
      $result = Invoke-Node @('--check', $file)
      if ($result.ExitCode -ne 0) {
        $jsFailures += [PSCustomObject]@{ File = $file; Output = $result.Output }
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
