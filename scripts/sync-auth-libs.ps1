param(
  [Parameter(Mandatory = $true)]
  [string[]]$Modules
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$RootPrefix = $RepositoryRoot.TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar

function Assert-SafeRepositoryPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [ValidateSet('Container', 'File')]
    [string]$ExpectedType,

    [bool]$AllowMissing = $false
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
    throw 'An auth library path escaped the repository root.'
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
  if ($Segments.Count -eq 0) {
    throw 'An auth library path has no repository segments.'
  }

  $Current = $RepositoryRoot
  for ($Index = 0; $Index -lt $Segments.Count; $Index += 1) {
    $Segment = $Segments[$Index]
    if ($Segment -eq '.' -or $Segment -eq '..') {
      throw 'An auth library path contains an unsafe segment.'
    }
    $Current = [IO.Path]::GetFullPath((Join-Path $Current $Segment))
    if (-not $Current.StartsWith(
      $RootPrefix,
      [StringComparison]::OrdinalIgnoreCase
    )) {
      throw 'An auth library path escaped during ancestor validation.'
    }

    $IsLeaf = $Index -eq ($Segments.Count - 1)
    if (-not (Test-Path -LiteralPath $Current)) {
      if (-not $AllowMissing) {
        throw "Missing auth library path: $Relative"
      }
      continue
    }

    $Item = Get-Item -LiteralPath $Current -Force
    if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'An auth library path contains a reparse point.'
    }
    if (-not $IsLeaf -and -not $Item.PSIsContainer) {
      throw 'An auth library ancestor is not a directory.'
    }
    if (
      $IsLeaf -and
      (($ExpectedType -eq 'Container') -ne [bool]$Item.PSIsContainer)
    ) {
      throw 'An auth library leaf has an unexpected path type.'
    }
  }

  return $Target
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
  if (
    $Segments.Count -eq 0 -or
    $UnsafeSegments.Count -gt 0
  ) {
    throw "Unsafe committed auth policy path: $Path"
  }
  return $Path
}

$RepositoryRoot = Assert-SafeRepositoryPath `
  -Path $RepositoryRoot `
  -ExpectedType Container

$PolicyOutput = @(
  & git -C $RepositoryRoot show 'HEAD:scripts/auth-v2-entry-policy.json' 2>&1
)
if ($LASTEXITCODE -ne 0) {
  throw "Cannot read committed auth policy: $($PolicyOutput -join [Environment]::NewLine)"
}
$Policy = ($PolicyOutput -join [Environment]::NewLine) | ConvertFrom-Json
if ($Policy.schemaVersion -ne 1) {
  throw 'The committed auth policy schema is unsupported.'
}

$KnownModuleNames = @($Policy.modules.PSObject.Properties.Name)
if ($KnownModuleNames.Count -eq 0) {
  throw 'The committed auth policy contains no modules.'
}
$RequestedModules = @(
  $Modules |
    ForEach-Object { [string]$_ } |
    Where-Object { $_.Length -gt 0 }
)
$SelectedModules = @($RequestedModules | Select-Object -Unique)
if ($SelectedModules.Count -eq 0) {
  throw 'At least one policy module is required.'
}
if ($RequestedModules.Count -ne $SelectedModules.Count) {
  throw 'Policy modules must not be duplicated.'
}
foreach ($ModuleName in $SelectedModules) {
  if ($KnownModuleNames -cnotcontains $ModuleName) {
    throw "Unknown policy module: $ModuleName"
  }
}

$CopyAllowlist = @()
$SeenDestinations = @{}
foreach ($Entry in @($Policy.entries)) {
  if (
    -not $Entry.name -or
    [string]$Entry.name -notmatch '^[A-Za-z0-9_]+$' -or
    $null -eq $Entry.copies
  ) {
    throw 'The committed auth policy contains an invalid entry.'
  }
  foreach ($Copy in @($Entry.copies)) {
    $ModuleName = [string]$Copy.module
    if ($KnownModuleNames -cnotcontains $ModuleName) {
      throw "The committed auth policy references an unknown module: $ModuleName"
    }
    if ($SelectedModules -cnotcontains $ModuleName) {
      continue
    }
    $Destination = [string]$Copy.destination
    if (-not $Destination) {
      throw "The committed auth policy has an empty destination for $($Entry.name)."
    }
    $DestinationKey = $Destination.ToLowerInvariant()
    if ($SeenDestinations.ContainsKey($DestinationKey)) {
      throw "The committed auth policy duplicates destination: $Destination"
    }
    $SeenDestinations[$DestinationKey] = $true
    $ModuleDefinition = $Policy.modules.PSObject.Properties[$ModuleName].Value
    $CopyAllowlist += [pscustomobject]@{
      Module = $ModuleName
      Source = Assert-SafePolicyRelativePath -Path ([string]$ModuleDefinition.source)
      Destination = Assert-SafePolicyRelativePath -Path $Destination
    }
  }
}
if ($CopyAllowlist.Count -eq 0) {
  throw 'The selected policy modules have no explicit destinations.'
}

$ValidatedCopyPlan = @()
foreach ($Copy in $CopyAllowlist) {
  $SourceCandidate = [IO.Path]::GetFullPath((
    Join-Path $RepositoryRoot $Copy.Source
  ))
  $DestinationCandidate = [IO.Path]::GetFullPath((
    Join-Path $RepositoryRoot $Copy.Destination
  ))
  $Source = Assert-SafeRepositoryPath `
    -Path $SourceCandidate `
    -ExpectedType File
  $Destination = Assert-SafeRepositoryPath `
    -Path $DestinationCandidate `
    -ExpectedType File `
    -AllowMissing $true
  $DestinationDirectory = Assert-SafeRepositoryPath `
    -Path ([IO.Path]::GetDirectoryName($Destination)) `
    -ExpectedType Container `
    -AllowMissing $true

  $ValidatedCopyPlan += [pscustomobject]@{
    Source = $Source
    Destination = $Destination
    DestinationDirectory = $DestinationDirectory
  }
}

$Copied = 0
foreach ($Copy in $ValidatedCopyPlan) {
  $Source = $Copy.Source
  $Destination = $Copy.Destination
  $DestinationDirectory = $Copy.DestinationDirectory
  if (-not (Test-Path -LiteralPath $DestinationDirectory)) {
    [void][IO.Directory]::CreateDirectory($DestinationDirectory)
  }
  $DestinationDirectory = Assert-SafeRepositoryPath `
    -Path $DestinationDirectory `
    -ExpectedType Container
  if (Test-Path -LiteralPath $Destination) {
    $Destination = Assert-SafeRepositoryPath `
      -Path $Destination `
      -ExpectedType File
  }

  Copy-Item -LiteralPath $Source -Destination $Destination -Force
  $Copied += 1
}

Write-Output "STATUS=PASS MODULES=$($SelectedModules -join ',') COPIED=$Copied"
