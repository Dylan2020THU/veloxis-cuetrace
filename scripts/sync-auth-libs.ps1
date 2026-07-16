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

$InjectedFailureIndex = 0
$InjectedFailureValue = [Environment]::GetEnvironmentVariable(
  'AUTH_SYNC_TEST_FAIL_BEFORE_REPLACE_INDEX'
)
if ($InjectedFailureValue) {
  $ParsedFailureIndex = 0
  if (
    -not [int]::TryParse(
      $InjectedFailureValue,
      [Globalization.NumberStyles]::None,
      [Globalization.CultureInfo]::InvariantCulture,
      [ref]$ParsedFailureIndex
    ) -or
    $ParsedFailureIndex -lt 1 -or
    $ParsedFailureIndex -gt $ValidatedCopyPlan.Count
  ) {
    throw 'Invalid auth sync test failure index.'
  }
  $InjectedFailureIndex = $ParsedFailureIndex
}

function New-OwnedSiblingFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Directory,

    [Parameter(Mandatory = $true)]
    [string]$DestinationLeaf,

    [Parameter(Mandatory = $true)]
    [string]$TransactionId,

    [Parameter(Mandatory = $true)]
    [int]$CopyIndex,

    [Parameter(Mandatory = $true)]
    [ValidateSet('stage', 'backup', 'rollback')]
    [string]$Kind
  )

  for ($Attempt = 0; $Attempt -lt 32; $Attempt += 1) {
    $Nonce = [Guid]::NewGuid().ToString('N')
    $Leaf = ".$DestinationLeaf.auth-sync-$TransactionId-$CopyIndex-$Kind-$Nonce"
    $Candidate = Assert-SafeRepositoryPath `
      -Path (Join-Path $Directory $Leaf) `
      -ExpectedType File `
      -AllowMissing $true
    try {
      $Stream = [IO.File]::Open(
        $Candidate,
        [IO.FileMode]::CreateNew,
        [IO.FileAccess]::Write,
        [IO.FileShare]::None
      )
      $Stream.Dispose()
      return $Candidate
    } catch [IO.IOException] {
      if (Test-Path -LiteralPath $Candidate) {
        continue
      }
      throw
    }
  }

  throw 'Unable to reserve a unique auth sync sibling file.'
}

function Remove-OwnedFile {
  param(
    [string]$Path,
    [System.Collections.Generic.List[string]]$Errors
  )

  if (-not $Path) {
    return
  }
  try {
    [IO.File]::Delete($Path)
  } catch {
    $Errors.Add("$Path`: $($_.Exception.Message)")
  }
}

$TransactionId = [Guid]::NewGuid().ToString('N')
$Transaction = @()
$CreatedDirectories = @()
$Copied = 0
$CommitFailure = $null

try {
  $CopyIndex = 0
  foreach ($Copy in $ValidatedCopyPlan) {
    $Source = $Copy.Source
    $Destination = $Copy.Destination
    $DestinationDirectory = $Copy.DestinationDirectory

    if (-not (Test-Path -LiteralPath $DestinationDirectory)) {
      $MissingDirectories = @()
      $CandidateDirectory = $DestinationDirectory
      while (
        -not (Test-Path -LiteralPath $CandidateDirectory) -and
        -not [string]::Equals(
          $CandidateDirectory,
          $RepositoryRoot,
          [StringComparison]::OrdinalIgnoreCase
        )
      ) {
        $MissingDirectories += $CandidateDirectory
        $CandidateDirectory = [IO.Path]::GetDirectoryName($CandidateDirectory)
      }
      [void][IO.Directory]::CreateDirectory($DestinationDirectory)
      $CreatedDirectories += $MissingDirectories
    }
    $DestinationDirectory = Assert-SafeRepositoryPath `
      -Path $DestinationDirectory `
      -ExpectedType Container

    $OriginalExists = Test-Path -LiteralPath $Destination
    if ($OriginalExists) {
      $Destination = Assert-SafeRepositoryPath `
        -Path $Destination `
        -ExpectedType File
    }

    $State = [pscustomobject]@{
      Destination = $Destination
      OriginalExists = [bool]$OriginalExists
      Stage = $null
      Backup = $null
      RollbackDiscard = $null
      Committed = $false
    }
    $Transaction += $State

    $State.Stage = New-OwnedSiblingFile `
      -Directory $DestinationDirectory `
      -DestinationLeaf ([IO.Path]::GetFileName($Destination)) `
      -TransactionId $TransactionId `
      -CopyIndex ($CopyIndex + 1) `
      -Kind stage
    if ($OriginalExists) {
      $State.Backup = New-OwnedSiblingFile `
        -Directory $DestinationDirectory `
        -DestinationLeaf ([IO.Path]::GetFileName($Destination)) `
        -TransactionId $TransactionId `
        -CopyIndex ($CopyIndex + 1) `
        -Kind backup
    }

    Copy-Item -LiteralPath $Source -Destination $State.Stage -Force
    $CopyIndex += 1
  }

  for ($CopyIndex = 0; $CopyIndex -lt $Transaction.Count; $CopyIndex += 1) {
    if ($InjectedFailureIndex -eq ($CopyIndex + 1)) {
      throw "Injected auth sync commit failure before replacement $InjectedFailureIndex."
    }

    $State = $Transaction[$CopyIndex]
    if ($State.OriginalExists) {
      [IO.File]::Replace(
        $State.Stage,
        $State.Destination,
        $State.Backup,
        $true
      )
    } else {
      [IO.File]::Move($State.Stage, $State.Destination)
    }
    $State.Committed = $true
    $Copied += 1
  }
} catch {
  $CommitFailure = $_
}

if ($CommitFailure) {
  $RollbackErrors = New-Object 'System.Collections.Generic.List[string]'
  for ($Index = $Transaction.Count - 1; $Index -ge 0; $Index -= 1) {
    $State = $Transaction[$Index]
    if (-not $State.Committed) {
      continue
    }

    try {
      if ($State.OriginalExists) {
        if (-not (Test-Path -LiteralPath $State.Backup)) {
          throw 'The auth sync rollback backup is missing.'
        }
        if (Test-Path -LiteralPath $State.Destination) {
          $State.RollbackDiscard = New-OwnedSiblingFile `
            -Directory ([IO.Path]::GetDirectoryName($State.Destination)) `
            -DestinationLeaf ([IO.Path]::GetFileName($State.Destination)) `
            -TransactionId $TransactionId `
            -CopyIndex ($Index + 1) `
            -Kind rollback
          [IO.File]::Replace(
            $State.Backup,
            $State.Destination,
            $State.RollbackDiscard,
            $true
          )
        } else {
          [IO.File]::Move($State.Backup, $State.Destination)
        }
      } elseif (Test-Path -LiteralPath $State.Destination) {
        [IO.File]::Delete($State.Destination)
      }
      $State.Committed = $false
    } catch {
      $RollbackErrors.Add(
        "$($State.Destination): $($_.Exception.Message)"
      )
    }
  }

  foreach ($State in $Transaction) {
    Remove-OwnedFile -Path $State.Stage -Errors $RollbackErrors
    if (-not $State.Committed) {
      Remove-OwnedFile -Path $State.Backup -Errors $RollbackErrors
    }
    Remove-OwnedFile -Path $State.RollbackDiscard -Errors $RollbackErrors
  }
  foreach ($Directory in @(
    $CreatedDirectories |
      Sort-Object { $_.Length } -Descending |
      Select-Object -Unique
  )) {
    try {
      if (Test-Path -LiteralPath $Directory) {
        [IO.Directory]::Delete($Directory, $false)
      }
    } catch {
      $RollbackErrors.Add("$Directory`: $($_.Exception.Message)")
    }
  }

  if ($RollbackErrors.Count -gt 0) {
    Write-Warning (
      'Auth sync rollback cleanup encountered errors: ' +
      ($RollbackErrors -join '; ')
    )
  }
  throw $CommitFailure
}

$CleanupErrors = New-Object 'System.Collections.Generic.List[string]'
foreach ($State in $Transaction) {
  Remove-OwnedFile -Path $State.Stage -Errors $CleanupErrors
  Remove-OwnedFile -Path $State.Backup -Errors $CleanupErrors
  Remove-OwnedFile -Path $State.RollbackDiscard -Errors $CleanupErrors
}
if ($CleanupErrors.Count -gt 0) {
  throw (
    'Auth sync committed but transaction cleanup failed: ' +
    ($CleanupErrors -join '; ')
  )
}

Write-Output "STATUS=PASS MODULES=$($SelectedModules -join ',') COPIED=$Copied"
