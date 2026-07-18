Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($args.Count -ne 0) {
  throw 'This script does not accept destination or path arguments.'
}

$RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$RootPrefix = $RepositoryRoot.TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar

function Assert-SafeRepositoryPath {
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
    throw 'A table-finance path escaped the repository root.'
  }

  $RootItem = Get-Item -LiteralPath $RepositoryRoot
  $RootIsReparsePoint = (
    ($RootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  )
  if (-not $RootItem.PSIsContainer -or $RootIsReparsePoint) {
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
    throw 'A table-finance path has no repository segments.'
  }

  $Current = $RepositoryRoot
  foreach ($Segment in $Segments) {
    if ($Segment -eq '.' -or $Segment -eq '..') {
      throw 'A table-finance path contains an unsafe segment.'
    }
    $Current = [IO.Path]::GetFullPath((Join-Path $Current $Segment))
    if (-not $Current.StartsWith(
      $RootPrefix,
      [StringComparison]::OrdinalIgnoreCase
    )) {
      throw 'A table-finance path escaped during ancestor validation.'
    }

    $Item = Get-Item -LiteralPath $Current
    $IsReparsePoint = (
      ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    )
    if ($IsReparsePoint) {
      throw 'A table-finance path contains a reparse point.'
    }
    $IsLeaf = [string]::Equals(
      $Current,
      $Target,
      [StringComparison]::OrdinalIgnoreCase
    )
    if (-not $IsLeaf -and -not $Item.PSIsContainer) {
      throw 'A table-finance ancestor is not a directory.'
    }
    if (
      $IsLeaf -and
      (($ExpectedType -eq 'Container') -ne [bool]$Item.PSIsContainer)
    ) {
      throw 'A table-finance leaf has an unexpected path type.'
    }
  }
  return $Target
}

$RepositoryRoot = Assert-SafeRepositoryPath -Path $RepositoryRoot -ExpectedType Container
$CanonicalDirectory = [IO.Path]::GetFullPath((
  Join-Path $RepositoryRoot 'cloudfunctions/_shared/table-finance'
))
$CanonicalDirectory = Assert-SafeRepositoryPath `
  -Path $CanonicalDirectory `
  -ExpectedType Container
$CanonicalPrefix = $CanonicalDirectory.TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar
$PaymentCanonicalDirectory = [IO.Path]::GetFullPath((
  Join-Path $RepositoryRoot 'cloudfunctions/_shared/table-payment'
))
$PaymentCanonicalDirectory = Assert-SafeRepositoryPath `
  -Path $PaymentCanonicalDirectory `
  -ExpectedType Container
$PaymentCanonicalPrefix = $PaymentCanonicalDirectory.TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar
$WechatPayCanonicalDirectory = [IO.Path]::GetFullPath((
  Join-Path $RepositoryRoot 'cloudfunctions/_shared/wechatpay-v3'
))
$WechatPayCanonicalDirectory = Assert-SafeRepositoryPath `
  -Path $WechatPayCanonicalDirectory `
  -ExpectedType Container
$WechatPayCanonicalPrefix = $WechatPayCanonicalDirectory.TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar
$ProfitSharingCanonicalDirectory = [IO.Path]::GetFullPath((
  Join-Path $RepositoryRoot 'cloudfunctions/_shared/table-profit-sharing'
))
$ProfitSharingCanonicalDirectory = Assert-SafeRepositoryPath `
  -Path $ProfitSharingCanonicalDirectory `
  -ExpectedType Container
$ProfitSharingCanonicalPrefix = $ProfitSharingCanonicalDirectory.TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar
$RefundCanonicalDirectory = [IO.Path]::GetFullPath((
  Join-Path $RepositoryRoot 'cloudfunctions/_shared/table-refund'
))
$RefundCanonicalDirectory = Assert-SafeRepositoryPath `
  -Path $RefundCanonicalDirectory `
  -ExpectedType Container
$RefundCanonicalPrefix = $RefundCanonicalDirectory.TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar
$ReconciliationCanonicalDirectory = [IO.Path]::GetFullPath((
  Join-Path $RepositoryRoot 'cloudfunctions/_shared/table-reconciliation'
))
$ReconciliationCanonicalDirectory = Assert-SafeRepositoryPath `
  -Path $ReconciliationCanonicalDirectory `
  -ExpectedType Container
$ReconciliationCanonicalPrefix = $ReconciliationCanonicalDirectory.TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar
$CopyAllowlist = @(
  @{ Source = 'cloudfunctions/_shared/table-finance/money.js'; Destination = 'cloudfunctions/createSession/lib/money.js' },
  @{ Source = 'cloudfunctions/_shared/table-finance/state.js'; Destination = 'cloudfunctions/createSession/lib/state.js' },
  @{ Source = 'cloudfunctions/_shared/table-finance/money.js'; Destination = 'cloudfunctions/createTableOrder/lib/money.js' },
  @{ Source = 'cloudfunctions/_shared/table-finance/state.js'; Destination = 'cloudfunctions/createTableOrder/lib/state.js' },
  @{ Source = 'cloudfunctions/_shared/table-finance/state.js'; Destination = 'cloudfunctions/markTableOrderExternalPaid/lib/state.js' },
  @{ Source = 'cloudfunctions/_shared/table-payment/checkout-token.js'; Destination = 'cloudfunctions/createTableOrder/lib/checkout-token.js' },
  @{ Source = 'cloudfunctions/_shared/table-payment/checkout-token.js'; Destination = 'cloudfunctions/getTableCheckoutOrder/lib/checkout-token.js' },
  @{ Source = 'cloudfunctions/_shared/table-payment/checkout-token.js'; Destination = 'cloudfunctions/genTableCheckoutCode/lib/checkout-token.js' },
  @{ Source = 'cloudfunctions/_shared/table-payment/table-payment.js'; Destination = 'cloudfunctions/createTablePayOrder/lib/table-payment.js' },
  @{ Source = 'cloudfunctions/_shared/table-payment/payment-transition.js'; Destination = 'cloudfunctions/createTablePayOrder/lib/payment-transition.js' },
  @{ Source = 'cloudfunctions/_shared/table-payment/cloudbase-payment-store.js'; Destination = 'cloudfunctions/createTablePayOrder/lib/cloudbase-payment-store.js' },
  @{ Source = 'cloudfunctions/_shared/table-finance/money.js'; Destination = 'cloudfunctions/createTablePayOrder/lib/table-finance/money.js' },
  @{ Source = 'cloudfunctions/_shared/table-finance/state.js'; Destination = 'cloudfunctions/createTablePayOrder/lib/table-finance/state.js' },
  @{ Source = 'cloudfunctions/_shared/wechatpay-v3/client.js'; Destination = 'cloudfunctions/createTablePayOrder/lib/wechatpay-v3/client.js' },
  @{ Source = 'cloudfunctions/_shared/wechatpay-v3/config.js'; Destination = 'cloudfunctions/createTablePayOrder/lib/wechatpay-v3/config.js' },
  @{ Source = 'cloudfunctions/_shared/wechatpay-v3/http-event.js'; Destination = 'cloudfunctions/createTablePayOrder/lib/wechatpay-v3/http-event.js' },
  @{ Source = 'cloudfunctions/_shared/wechatpay-v3/bill-parser.js'; Destination = 'cloudfunctions/createTablePayOrder/lib/wechatpay-v3/bill-parser.js' },
  @{ Source = 'cloudfunctions/_shared/table-payment/table-payment.js'; Destination = 'cloudfunctions/tablePayNotifyV3/lib/table-payment.js' },
  @{ Source = 'cloudfunctions/_shared/table-payment/payment-transition.js'; Destination = 'cloudfunctions/tablePayNotifyV3/lib/payment-transition.js' },
  @{ Source = 'cloudfunctions/_shared/table-payment/cloudbase-payment-store.js'; Destination = 'cloudfunctions/tablePayNotifyV3/lib/cloudbase-payment-store.js' },
  @{ Source = 'cloudfunctions/_shared/table-finance/money.js'; Destination = 'cloudfunctions/tablePayNotifyV3/lib/table-finance/money.js' },
  @{ Source = 'cloudfunctions/_shared/table-finance/state.js'; Destination = 'cloudfunctions/tablePayNotifyV3/lib/table-finance/state.js' },
  @{ Source = 'cloudfunctions/_shared/wechatpay-v3/client.js'; Destination = 'cloudfunctions/tablePayNotifyV3/lib/wechatpay-v3/client.js' },
  @{ Source = 'cloudfunctions/_shared/wechatpay-v3/config.js'; Destination = 'cloudfunctions/tablePayNotifyV3/lib/wechatpay-v3/config.js' },
  @{ Source = 'cloudfunctions/_shared/wechatpay-v3/http-event.js'; Destination = 'cloudfunctions/tablePayNotifyV3/lib/wechatpay-v3/http-event.js' },
  @{ Source = 'cloudfunctions/_shared/wechatpay-v3/bill-parser.js'; Destination = 'cloudfunctions/tablePayNotifyV3/lib/wechatpay-v3/bill-parser.js' },
  @{ Source = 'cloudfunctions/_shared/table-payment/table-payment.js'; Destination = 'cloudfunctions/reconcileTablePayments/lib/table-payment.js' },
  @{ Source = 'cloudfunctions/_shared/table-payment/payment-transition.js'; Destination = 'cloudfunctions/reconcileTablePayments/lib/payment-transition.js' },
  @{ Source = 'cloudfunctions/_shared/table-payment/cloudbase-payment-store.js'; Destination = 'cloudfunctions/reconcileTablePayments/lib/cloudbase-payment-store.js' },
  @{ Source = 'cloudfunctions/_shared/table-finance/money.js'; Destination = 'cloudfunctions/reconcileTablePayments/lib/table-finance/money.js' },
  @{ Source = 'cloudfunctions/_shared/table-finance/state.js'; Destination = 'cloudfunctions/reconcileTablePayments/lib/table-finance/state.js' },
  @{ Source = 'cloudfunctions/_shared/wechatpay-v3/client.js'; Destination = 'cloudfunctions/reconcileTablePayments/lib/wechatpay-v3/client.js' },
  @{ Source = 'cloudfunctions/_shared/wechatpay-v3/config.js'; Destination = 'cloudfunctions/reconcileTablePayments/lib/wechatpay-v3/config.js' },
  @{ Source = 'cloudfunctions/_shared/wechatpay-v3/http-event.js'; Destination = 'cloudfunctions/reconcileTablePayments/lib/wechatpay-v3/http-event.js' },
  @{ Source = 'cloudfunctions/_shared/wechatpay-v3/bill-parser.js'; Destination = 'cloudfunctions/reconcileTablePayments/lib/wechatpay-v3/bill-parser.js' },
  @{ Source = 'cloudfunctions/_shared/table-profit-sharing/table-profit-sharing.js'; Destination = 'cloudfunctions/settleTableProfitSharing/lib/table-profit-sharing/table-profit-sharing.js' },
  @{ Source = 'cloudfunctions/_shared/table-finance/money.js'; Destination = 'cloudfunctions/settleTableProfitSharing/lib/table-finance/money.js' },
  @{ Source = 'cloudfunctions/_shared/table-finance/state.js'; Destination = 'cloudfunctions/settleTableProfitSharing/lib/table-finance/state.js' },
  @{ Source = 'cloudfunctions/_shared/wechatpay-v3/client.js'; Destination = 'cloudfunctions/settleTableProfitSharing/lib/wechatpay-v3/client.js' },
  @{ Source = 'cloudfunctions/_shared/wechatpay-v3/config.js'; Destination = 'cloudfunctions/settleTableProfitSharing/lib/wechatpay-v3/config.js' },
  @{ Source = 'cloudfunctions/_shared/wechatpay-v3/http-event.js'; Destination = 'cloudfunctions/settleTableProfitSharing/lib/wechatpay-v3/http-event.js' },
  @{ Source = 'cloudfunctions/_shared/wechatpay-v3/bill-parser.js'; Destination = 'cloudfunctions/settleTableProfitSharing/lib/wechatpay-v3/bill-parser.js' },
  @{ Source = 'cloudfunctions/_shared/table-refund/table-refund.js'; Destination = 'cloudfunctions/requestTableRefund/lib/table-refund/table-refund.js' },
  @{ Source = 'cloudfunctions/_shared/table-refund/refund-transition.js'; Destination = 'cloudfunctions/requestTableRefund/lib/table-refund/refund-transition.js' },
  @{ Source = 'cloudfunctions/_shared/table-refund/cloudbase-refund-store.js'; Destination = 'cloudfunctions/requestTableRefund/lib/table-refund/cloudbase-refund-store.js' },
  @{ Source = 'cloudfunctions/_shared/table-finance/money.js'; Destination = 'cloudfunctions/requestTableRefund/lib/table-finance/money.js' },
  @{ Source = 'cloudfunctions/_shared/table-finance/state.js'; Destination = 'cloudfunctions/requestTableRefund/lib/table-finance/state.js' },
  @{ Source = 'cloudfunctions/_shared/wechatpay-v3/client.js'; Destination = 'cloudfunctions/requestTableRefund/lib/wechatpay-v3/client.js' },
  @{ Source = 'cloudfunctions/_shared/wechatpay-v3/config.js'; Destination = 'cloudfunctions/requestTableRefund/lib/wechatpay-v3/config.js' },
  @{ Source = 'cloudfunctions/_shared/wechatpay-v3/http-event.js'; Destination = 'cloudfunctions/requestTableRefund/lib/wechatpay-v3/http-event.js' },
  @{ Source = 'cloudfunctions/_shared/wechatpay-v3/bill-parser.js'; Destination = 'cloudfunctions/requestTableRefund/lib/wechatpay-v3/bill-parser.js' },
  @{ Source = 'cloudfunctions/_shared/table-refund/table-refund.js'; Destination = 'cloudfunctions/tableRefundNotifyV3/lib/table-refund/table-refund.js' },
  @{ Source = 'cloudfunctions/_shared/table-refund/refund-transition.js'; Destination = 'cloudfunctions/tableRefundNotifyV3/lib/table-refund/refund-transition.js' },
  @{ Source = 'cloudfunctions/_shared/table-refund/cloudbase-refund-store.js'; Destination = 'cloudfunctions/tableRefundNotifyV3/lib/table-refund/cloudbase-refund-store.js' },
  @{ Source = 'cloudfunctions/_shared/table-finance/money.js'; Destination = 'cloudfunctions/tableRefundNotifyV3/lib/table-finance/money.js' },
  @{ Source = 'cloudfunctions/_shared/table-finance/state.js'; Destination = 'cloudfunctions/tableRefundNotifyV3/lib/table-finance/state.js' },
  @{ Source = 'cloudfunctions/_shared/wechatpay-v3/client.js'; Destination = 'cloudfunctions/tableRefundNotifyV3/lib/wechatpay-v3/client.js' },
  @{ Source = 'cloudfunctions/_shared/wechatpay-v3/config.js'; Destination = 'cloudfunctions/tableRefundNotifyV3/lib/wechatpay-v3/config.js' },
  @{ Source = 'cloudfunctions/_shared/wechatpay-v3/http-event.js'; Destination = 'cloudfunctions/tableRefundNotifyV3/lib/wechatpay-v3/http-event.js' },
  @{ Source = 'cloudfunctions/_shared/wechatpay-v3/bill-parser.js'; Destination = 'cloudfunctions/tableRefundNotifyV3/lib/wechatpay-v3/bill-parser.js' },
  @{ Source = 'cloudfunctions/_shared/table-reconciliation/table-reconciliation.js'; Destination = 'cloudfunctions/reconcileTableFinance/lib/table-reconciliation/table-reconciliation.js' },
  @{ Source = 'cloudfunctions/_shared/table-reconciliation/cloudbase-reconciliation-store.js'; Destination = 'cloudfunctions/reconcileTableFinance/lib/table-reconciliation/cloudbase-reconciliation-store.js' },
  @{ Source = 'cloudfunctions/_shared/table-finance/money.js'; Destination = 'cloudfunctions/reconcileTableFinance/lib/table-finance/money.js' },
  @{ Source = 'cloudfunctions/_shared/table-finance/state.js'; Destination = 'cloudfunctions/reconcileTableFinance/lib/table-finance/state.js' },
  @{ Source = 'cloudfunctions/_shared/wechatpay-v3/client.js'; Destination = 'cloudfunctions/reconcileTableFinance/lib/wechatpay-v3/client.js' },
  @{ Source = 'cloudfunctions/_shared/wechatpay-v3/config.js'; Destination = 'cloudfunctions/reconcileTableFinance/lib/wechatpay-v3/config.js' },
  @{ Source = 'cloudfunctions/_shared/wechatpay-v3/http-event.js'; Destination = 'cloudfunctions/reconcileTableFinance/lib/wechatpay-v3/http-event.js' },
  @{ Source = 'cloudfunctions/_shared/wechatpay-v3/bill-parser.js'; Destination = 'cloudfunctions/reconcileTableFinance/lib/wechatpay-v3/bill-parser.js' }
)

$Copied = 0
foreach ($Copy in $CopyAllowlist) {
  $SourceCandidate = [IO.Path]::GetFullPath((Join-Path $RepositoryRoot $Copy.Source))
  $DestinationCandidate = [IO.Path]::GetFullPath((
    Join-Path $RepositoryRoot $Copy.Destination
  ))
  $Source = Assert-SafeRepositoryPath -Path $SourceCandidate -ExpectedType File
  $Destination = Assert-SafeRepositoryPath `
    -Path $DestinationCandidate `
    -ExpectedType File
  $SourceUnderCanonical = (
    $Source.StartsWith(
      $CanonicalPrefix,
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    $Source.StartsWith(
      $PaymentCanonicalPrefix,
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    $Source.StartsWith(
      $WechatPayCanonicalPrefix,
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    $Source.StartsWith(
      $ProfitSharingCanonicalPrefix,
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    $Source.StartsWith(
      $RefundCanonicalPrefix,
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    $Source.StartsWith(
      $ReconciliationCanonicalPrefix,
      [StringComparison]::OrdinalIgnoreCase
    )
  )
  $SourceUnderRoot = $Source.StartsWith($RootPrefix, [StringComparison]::OrdinalIgnoreCase)
  $DestinationUnderRoot = $Destination.StartsWith(
    $RootPrefix,
    [StringComparison]::OrdinalIgnoreCase
  )
  if (
    (-not $SourceUnderCanonical) -or
    (-not $SourceUnderRoot) -or
    (-not $DestinationUnderRoot)
  ) {
    throw 'A table-finance copy escaped its explicit repository allowlist.'
  }
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
  $Copied += 1
}

Write-Output "TABLE_FINANCE_SYNC_OK copied=$Copied"
