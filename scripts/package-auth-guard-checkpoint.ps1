Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($args.Count -ne 0) {
  throw 'This script does not accept path or destination arguments.'
}

$RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$RootPrefix = $RepositoryRoot.TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar
$Utf8 = New-Object Text.UTF8Encoding($false)
$ArtifactRelative = '.superpowers/sdd/auth-v2-guard-v1-compat.zip'
$ArtifactPath = [IO.Path]::GetFullPath((Join-Path $RepositoryRoot $ArtifactRelative))
$SidecarPath = "$ArtifactPath.sha256"
$ManifestName = 'auth-v2-guard-v1-compat-manifest.json'
$FixedZipTime = New-Object DateTimeOffset(
  1980,
  1,
  1,
  0,
  0,
  0,
  [TimeSpan]::Zero
)

function Get-Sha256Hex {
  param(
    [Parameter(Mandatory = $true)]
    [byte[]]$Bytes
  )

  $Hasher = [Security.Cryptography.SHA256]::Create()
  try {
    $Hash = $Hasher.ComputeHash($Bytes)
  } finally {
    $Hasher.Dispose()
  }
  return (($Hash | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Get-CommittedPolicyBytes {
  $StartInfo = New-Object Diagnostics.ProcessStartInfo
  $StartInfo.FileName = 'git'
  $StartInfo.WorkingDirectory = $RepositoryRoot
  $StartInfo.Arguments = 'cat-file blob HEAD:scripts/auth-v2-entry-policy.json'
  $StartInfo.UseShellExecute = $false
  $StartInfo.CreateNoWindow = $true
  $StartInfo.RedirectStandardOutput = $true
  $StartInfo.RedirectStandardError = $true
  $Process = New-Object Diagnostics.Process
  $Process.StartInfo = $StartInfo
  if (-not $Process.Start()) {
    throw 'Cannot start git to read the committed auth policy.'
  }
  $Memory = New-Object IO.MemoryStream
  try {
    $Process.StandardOutput.BaseStream.CopyTo($Memory)
    $ErrorText = $Process.StandardError.ReadToEnd()
    $Process.WaitForExit()
    if ($Process.ExitCode -ne 0) {
      throw "Cannot read committed auth policy: $ErrorText"
    }
    return ,$Memory.ToArray()
  } finally {
    $Memory.Dispose()
    $Process.Dispose()
  }
}

function Assert-SafePolicyRelativePath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if (
    -not $Path -or
    [IO.Path]::IsPathRooted($Path) -or
    $Path.Contains(':') -or
    $Path.Contains('\') -or
    $Path.IndexOfAny([char[]]'*?') -ge 0
  ) {
    throw "Unsafe committed auth policy path: $Path"
  }
  $Segments = $Path.Split('/')
  $UnsafeSegments = @(
    $Segments | Where-Object { -not $_ -or $_ -eq '.' -or $_ -eq '..' }
  )
  if ($Segments.Count -eq 0 -or $UnsafeSegments.Count -gt 0) {
    throw "Unsafe committed auth policy path: $Path"
  }
  return $Path
}

function Assert-SafeExistingRepositoryPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [ValidateSet('Container', 'File')]
    [string]$ExpectedType
  )

  $Target = [IO.Path]::GetFullPath($Path)
  $TargetIsRoot = [string]::Equals(
    $Target,
    $RepositoryRoot,
    [StringComparison]::OrdinalIgnoreCase
  )
  if (
    -not $TargetIsRoot -and
    -not $Target.StartsWith($RootPrefix, [StringComparison]::OrdinalIgnoreCase)
  ) {
    throw 'A checkpoint path escaped the repository root.'
  }

  $RootItem = Get-Item -LiteralPath $RepositoryRoot -Force
  if (
    -not $RootItem.PSIsContainer -or
    (($RootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
  ) {
    throw 'The repository root is not a safe directory.'
  }
  if ($TargetIsRoot) {
    if ($ExpectedType -ne 'Container') {
      throw 'The repository root has an unexpected path type.'
    }
    return $Target
  }

  $Relative = $Target.Substring($RootPrefix.Length)
  $Segments = $Relative.Split(
    [char[]]'\/',
    [System.StringSplitOptions]::RemoveEmptyEntries
  )
  $Current = $RepositoryRoot
  for ($Index = 0; $Index -lt $Segments.Count; $Index += 1) {
    $Current = [IO.Path]::GetFullPath((Join-Path $Current $Segments[$Index]))
    if (-not $Current.StartsWith(
      $RootPrefix,
      [StringComparison]::OrdinalIgnoreCase
    )) {
      throw 'A checkpoint path escaped during ancestor validation.'
    }
    if (-not (Test-Path -LiteralPath $Current)) {
      throw "Missing checkpoint path: $Relative"
    }
    $Item = Get-Item -LiteralPath $Current -Force
    if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'A checkpoint path contains a reparse point.'
    }
    $IsLeaf = $Index -eq ($Segments.Count - 1)
    if (-not $IsLeaf -and -not $Item.PSIsContainer) {
      throw 'A checkpoint ancestor is not a directory.'
    }
    if (
      $IsLeaf -and
      (($ExpectedType -eq 'Container') -ne [bool]$Item.PSIsContainer)
    ) {
      throw 'A checkpoint leaf has an unexpected path type.'
    }
  }
  return $Target
}

function Assert-SafeOutputFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $Target = [IO.Path]::GetFullPath($Path)
  if (-not $Target.StartsWith($RootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'A checkpoint output escaped the repository root.'
  }
  $Parent = Assert-SafeExistingRepositoryPath `
    -Path ([IO.Path]::GetDirectoryName($Target)) `
    -ExpectedType Container
  if (Test-Path -LiteralPath $Target) {
    [void](Assert-SafeExistingRepositoryPath -Path $Target -ExpectedType File)
  }
  return $Target
}

function Get-RepositoryRelativePath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$AbsolutePath
  )

  $FullPath = [IO.Path]::GetFullPath($AbsolutePath)
  if (-not $FullPath.StartsWith($RootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'A checkpoint payload escaped the repository root.'
  }
  return $FullPath.Substring($RootPrefix.Length).Replace('\', '/')
}

function Test-ExcludedDeployPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RelativePath
  )

  $Segments = $RelativePath.Split('/')
  $ExcludedDirectories = @(
    'node_modules',
    '.git',
    'coverage',
    'secrets',
    'private',
    'keys',
    'certs'
  )
  foreach ($Segment in $Segments) {
    if ($ExcludedDirectories -contains $Segment.ToLowerInvariant()) {
      return $true
    }
  }

  $Name = $Segments[$Segments.Count - 1].ToLowerInvariant()
  $Extension = [IO.Path]::GetExtension($Name).ToLowerInvariant()
  if (
    $Name -eq '.ds_store' -or
    $Name -eq '.npmrc' -or
    $Name -eq 'secret.json' -or
    $Name -eq 'secrets.json' -or
    $Name -eq 'credentials.json' -or
    $Name -eq 'credentials' -or
    $Name -eq '.env' -or
    $Name.StartsWith('.env.')
  ) {
    return $true
  }
  return @(
    '.pem',
    '.key',
    '.p12',
    '.pfx',
    '.cer',
    '.crt',
    '.der',
    '.jks',
    '.keystore',
    '.log',
    '.tmp',
    '.zip',
    '.sha256'
  ) -contains $Extension
}

function Get-DeployFiles {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RelativeDirectory
  )

  $Directory = Assert-SafeExistingRepositoryPath `
    -Path ([IO.Path]::GetFullPath((Join-Path $RepositoryRoot $RelativeDirectory))) `
    -ExpectedType Container
  $Pending = New-Object 'Collections.Generic.Stack[string]'
  $Pending.Push($Directory)
  $Files = @()
  while ($Pending.Count -gt 0) {
    $Current = $Pending.Pop()
    foreach ($Item in Get-ChildItem -LiteralPath $Current -Force) {
      if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "A checkpoint payload contains a reparse point: $($Item.FullName)"
      }
      $RelativePath = Get-RepositoryRelativePath -AbsolutePath $Item.FullName
      if (Test-ExcludedDeployPath -RelativePath $RelativePath) {
        continue
      }
      if ($Item.PSIsContainer) {
        $Pending.Push($Item.FullName)
      } elseif ($Item -is [IO.FileInfo]) {
        $Files += $RelativePath
      }
    }
  }
  return $Files
}

$RepositoryRoot = Assert-SafeExistingRepositoryPath `
  -Path $RepositoryRoot `
  -ExpectedType Container
$ArtifactPath = Assert-SafeOutputFile -Path $ArtifactPath
$SidecarPath = Assert-SafeOutputFile -Path $SidecarPath

$PolicyBytes = Get-CommittedPolicyBytes
$PolicySha256 = Get-Sha256Hex -Bytes $PolicyBytes
$Policy = $Utf8.GetString($PolicyBytes) | ConvertFrom-Json
if ($Policy.schemaVersion -ne 1 -or $null -eq $Policy.entries) {
  throw 'The committed auth policy is malformed.'
}
if ($null -eq $Policy.modules.PSObject.Properties['protocol-guard']) {
  throw 'The committed auth policy has no protocol-guard module.'
}
$CanonicalRelative = Assert-SafePolicyRelativePath `
  -Path ([string]$Policy.modules.'protocol-guard'.source)
$CanonicalPath = Assert-SafeExistingRepositoryPath `
  -Path ([IO.Path]::GetFullPath((Join-Path $RepositoryRoot $CanonicalRelative))) `
  -ExpectedType File
$CanonicalBytes = [IO.File]::ReadAllBytes($CanonicalPath)
$CanonicalSha256 = Get-Sha256Hex -Bytes $CanonicalBytes

$ProtocolEntries = @()
foreach ($Entry in @($Policy.entries)) {
  if (
    $null -eq $Entry -or
    [string]$Entry.name -notmatch '^[A-Za-z0-9_]+$' -or
    @('client', 'branch', 'none') -cnotcontains [string]$Entry.protocolGuard
  ) {
    throw 'The committed auth policy contains an invalid protocol entry.'
  }
  if ($Entry.protocolGuard -eq 'none') {
    continue
  }
  $ExpectedDestination = "cloudfunctions/$($Entry.name)/lib/auth/protocol-guard.js"
  $GuardCopies = @(
    @($Entry.copies) | Where-Object { $_.module -ceq 'protocol-guard' }
  )
  if (
    $GuardCopies.Count -ne 1 -or
    [string]$GuardCopies[0].destination -cne $ExpectedDestination
  ) {
    throw "The committed auth policy changed $($Entry.name)'s guard destination."
  }
  $EntryPath = Assert-SafePolicyRelativePath `
    -Path "cloudfunctions/$($Entry.name)/index.js"
  [void](Assert-SafeExistingRepositoryPath `
    -Path ([IO.Path]::GetFullPath((Join-Path $RepositoryRoot $EntryPath))) `
    -ExpectedType File)
  $ProtocolEntries += [pscustomobject]@{
    Name = [string]$Entry.name
    EntryPath = $EntryPath
    Directory = "cloudfunctions/$($Entry.name)"
    GuardDestination = $ExpectedDestination
  }
}
if ($ProtocolEntries.Count -ne 97) {
  throw "The committed auth policy must select exactly 97 guarded functions."
}

$ProtocolClientPaths = [string[]]@(
  $ProtocolEntries | ForEach-Object { $_.EntryPath }
)
[Array]::Sort($ProtocolClientPaths, [StringComparer]::Ordinal)
$ProtocolClientSha256 = Get-Sha256Hex `
  -Bytes $Utf8.GetBytes([string]::Join("`n", $ProtocolClientPaths))

$PayloadSet = @{}
foreach ($Entry in $ProtocolEntries) {
  foreach ($RelativePath in Get-DeployFiles -RelativeDirectory $Entry.Directory) {
    $Key = $RelativePath.ToLowerInvariant()
    if ($PayloadSet.ContainsKey($Key) -and $PayloadSet[$Key] -cne $RelativePath) {
      throw "Checkpoint payload paths collide by case: $RelativePath"
    }
    $PayloadSet[$Key] = $RelativePath
  }
  if (-not $PayloadSet.ContainsKey($Entry.EntryPath.ToLowerInvariant())) {
    throw "Checkpoint payload omitted $($Entry.EntryPath)."
  }
  if (-not $PayloadSet.ContainsKey($Entry.GuardDestination.ToLowerInvariant())) {
    throw "Checkpoint payload omitted $($Entry.GuardDestination)."
  }
  $GuardPath = Assert-SafeExistingRepositoryPath `
    -Path ([IO.Path]::GetFullPath((
      Join-Path $RepositoryRoot $Entry.GuardDestination
    ))) `
    -ExpectedType File
  $GuardBytes = [IO.File]::ReadAllBytes($GuardPath)
  if ((Get-Sha256Hex -Bytes $GuardBytes) -cne $CanonicalSha256) {
    throw "$($Entry.GuardDestination) differs from the canonical guard."
  }
}

$PayloadPaths = [string[]]@($PayloadSet.Values)
[Array]::Sort($PayloadPaths, [StringComparer]::Ordinal)
$PayloadBytes = @{}
$ManifestFiles = @()
foreach ($RelativePath in $PayloadPaths) {
  $AbsolutePath = Assert-SafeExistingRepositoryPath `
    -Path ([IO.Path]::GetFullPath((Join-Path $RepositoryRoot $RelativePath))) `
    -ExpectedType File
  $Bytes = [IO.File]::ReadAllBytes($AbsolutePath)
  $PayloadBytes[$RelativePath] = $Bytes
  $ManifestFiles += [ordered]@{
    path = $RelativePath
    size = [long]$Bytes.Length
    sha256 = Get-Sha256Hex -Bytes $Bytes
  }
}

$Manifest = [ordered]@{
  schemaVersion = 1
  artifact = 'auth-v2-guard-v1-compat.zip'
  guardedFunctionCount = 97
  protocolClientSha256 = $ProtocolClientSha256
  policySha256 = $PolicySha256
  protocolClientPaths = @($ProtocolClientPaths)
  files = @($ManifestFiles)
}
$ManifestJson = $Manifest | ConvertTo-Json -Compress -Depth 8
$ManifestBytes = $Utf8.GetBytes($ManifestJson)

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$ZipPaths = [string[]]@($PayloadPaths + $ManifestName)
[Array]::Sort($ZipPaths, [StringComparer]::Ordinal)
$FileStream = [IO.File]::Open(
  $ArtifactPath,
  [IO.FileMode]::Create,
  [IO.FileAccess]::Write,
  [IO.FileShare]::None
)
try {
  $Archive = New-Object IO.Compression.ZipArchive(
    $FileStream,
    [IO.Compression.ZipArchiveMode]::Create,
    $true
  )
  try {
    foreach ($RelativePath in $ZipPaths) {
      $Bytes = if ($RelativePath -ceq $ManifestName) {
        $ManifestBytes
      } else {
        [byte[]]$PayloadBytes[$RelativePath]
      }
      $Entry = $Archive.CreateEntry(
        $RelativePath,
        [IO.Compression.CompressionLevel]::NoCompression
      )
      $Entry.LastWriteTime = $FixedZipTime
      $Entry.ExternalAttributes = 0
      $EntryStream = $Entry.Open()
      try {
        $EntryStream.Write($Bytes, 0, $Bytes.Length)
      } finally {
        $EntryStream.Dispose()
      }
    }
  } finally {
    $Archive.Dispose()
  }
} finally {
  $FileStream.Dispose()
}

$ZipBytes = [IO.File]::ReadAllBytes($ArtifactPath)
$ZipSha256 = Get-Sha256Hex -Bytes $ZipBytes
[IO.File]::WriteAllText(
  $SidecarPath,
  "$ZipSha256  auth-v2-guard-v1-compat.zip`n",
  $Utf8
)

Write-Output 'STATUS=PASS'
Write-Output "ARTIFACT=$ArtifactRelative"
Write-Output "GUARDED_FUNCTIONS=$($ProtocolEntries.Count)"
Write-Output "PAYLOAD_FILES=$($PayloadPaths.Count)"
Write-Output "PROTOCOL_CLIENT_SHA256=$ProtocolClientSha256"
Write-Output "ZIP_SHA256=$ZipSha256"
