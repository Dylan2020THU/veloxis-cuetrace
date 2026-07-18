const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const scriptPath = path.join(root, 'scripts/sync-table-finance-libs.ps1');
const copyAllowlist = Object.freeze([
  Object.freeze({
    source: 'cloudfunctions/_shared/table-finance/money.js',
    destination: 'cloudfunctions/createSession/lib/money.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-finance/state.js',
    destination: 'cloudfunctions/createSession/lib/state.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-finance/money.js',
    destination: 'cloudfunctions/createTableOrder/lib/money.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-finance/state.js',
    destination: 'cloudfunctions/createTableOrder/lib/state.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-finance/state.js',
    destination: 'cloudfunctions/markTableOrderExternalPaid/lib/state.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-payment/checkout-token.js',
    destination: 'cloudfunctions/createTableOrder/lib/checkout-token.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-payment/checkout-token.js',
    destination: 'cloudfunctions/getTableCheckoutOrder/lib/checkout-token.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-payment/checkout-token.js',
    destination: 'cloudfunctions/genTableCheckoutCode/lib/checkout-token.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-payment/table-payment.js',
    destination: 'cloudfunctions/createTablePayOrder/lib/table-payment.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-payment/payment-transition.js',
    destination: 'cloudfunctions/createTablePayOrder/lib/payment-transition.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-payment/cloudbase-payment-store.js',
    destination: 'cloudfunctions/createTablePayOrder/lib/cloudbase-payment-store.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-finance/money.js',
    destination: 'cloudfunctions/createTablePayOrder/lib/table-finance/money.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-finance/state.js',
    destination: 'cloudfunctions/createTablePayOrder/lib/table-finance/state.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/wechatpay-v3/client.js',
    destination: 'cloudfunctions/createTablePayOrder/lib/wechatpay-v3/client.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/wechatpay-v3/config.js',
    destination: 'cloudfunctions/createTablePayOrder/lib/wechatpay-v3/config.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/wechatpay-v3/http-event.js',
    destination: 'cloudfunctions/createTablePayOrder/lib/wechatpay-v3/http-event.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/wechatpay-v3/bill-parser.js',
    destination: 'cloudfunctions/createTablePayOrder/lib/wechatpay-v3/bill-parser.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-payment/table-payment.js',
    destination: 'cloudfunctions/tablePayNotifyV3/lib/table-payment.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-payment/payment-transition.js',
    destination: 'cloudfunctions/tablePayNotifyV3/lib/payment-transition.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-payment/cloudbase-payment-store.js',
    destination: 'cloudfunctions/tablePayNotifyV3/lib/cloudbase-payment-store.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-finance/money.js',
    destination: 'cloudfunctions/tablePayNotifyV3/lib/table-finance/money.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-finance/state.js',
    destination: 'cloudfunctions/tablePayNotifyV3/lib/table-finance/state.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/wechatpay-v3/client.js',
    destination: 'cloudfunctions/tablePayNotifyV3/lib/wechatpay-v3/client.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/wechatpay-v3/config.js',
    destination: 'cloudfunctions/tablePayNotifyV3/lib/wechatpay-v3/config.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/wechatpay-v3/http-event.js',
    destination: 'cloudfunctions/tablePayNotifyV3/lib/wechatpay-v3/http-event.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/wechatpay-v3/bill-parser.js',
    destination: 'cloudfunctions/tablePayNotifyV3/lib/wechatpay-v3/bill-parser.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-payment/table-payment.js',
    destination: 'cloudfunctions/reconcileTablePayments/lib/table-payment.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-payment/payment-transition.js',
    destination: 'cloudfunctions/reconcileTablePayments/lib/payment-transition.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-payment/cloudbase-payment-store.js',
    destination: 'cloudfunctions/reconcileTablePayments/lib/cloudbase-payment-store.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-finance/money.js',
    destination: 'cloudfunctions/reconcileTablePayments/lib/table-finance/money.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-finance/state.js',
    destination: 'cloudfunctions/reconcileTablePayments/lib/table-finance/state.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/wechatpay-v3/client.js',
    destination: 'cloudfunctions/reconcileTablePayments/lib/wechatpay-v3/client.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/wechatpay-v3/config.js',
    destination: 'cloudfunctions/reconcileTablePayments/lib/wechatpay-v3/config.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/wechatpay-v3/http-event.js',
    destination: 'cloudfunctions/reconcileTablePayments/lib/wechatpay-v3/http-event.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/wechatpay-v3/bill-parser.js',
    destination: 'cloudfunctions/reconcileTablePayments/lib/wechatpay-v3/bill-parser.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-profit-sharing/table-profit-sharing.js',
    destination: 'cloudfunctions/settleTableProfitSharing/lib/table-profit-sharing/table-profit-sharing.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-finance/money.js',
    destination: 'cloudfunctions/settleTableProfitSharing/lib/table-finance/money.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-finance/state.js',
    destination: 'cloudfunctions/settleTableProfitSharing/lib/table-finance/state.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/wechatpay-v3/client.js',
    destination: 'cloudfunctions/settleTableProfitSharing/lib/wechatpay-v3/client.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/wechatpay-v3/config.js',
    destination: 'cloudfunctions/settleTableProfitSharing/lib/wechatpay-v3/config.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/wechatpay-v3/http-event.js',
    destination: 'cloudfunctions/settleTableProfitSharing/lib/wechatpay-v3/http-event.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/wechatpay-v3/bill-parser.js',
    destination: 'cloudfunctions/settleTableProfitSharing/lib/wechatpay-v3/bill-parser.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-refund/table-refund.js',
    destination: 'cloudfunctions/requestTableRefund/lib/table-refund/table-refund.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-refund/refund-transition.js',
    destination: 'cloudfunctions/requestTableRefund/lib/table-refund/refund-transition.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-refund/cloudbase-refund-store.js',
    destination: 'cloudfunctions/requestTableRefund/lib/table-refund/cloudbase-refund-store.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-finance/money.js',
    destination: 'cloudfunctions/requestTableRefund/lib/table-finance/money.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-finance/state.js',
    destination: 'cloudfunctions/requestTableRefund/lib/table-finance/state.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/wechatpay-v3/client.js',
    destination: 'cloudfunctions/requestTableRefund/lib/wechatpay-v3/client.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/wechatpay-v3/config.js',
    destination: 'cloudfunctions/requestTableRefund/lib/wechatpay-v3/config.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/wechatpay-v3/http-event.js',
    destination: 'cloudfunctions/requestTableRefund/lib/wechatpay-v3/http-event.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/wechatpay-v3/bill-parser.js',
    destination: 'cloudfunctions/requestTableRefund/lib/wechatpay-v3/bill-parser.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-refund/table-refund.js',
    destination: 'cloudfunctions/tableRefundNotifyV3/lib/table-refund/table-refund.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-refund/refund-transition.js',
    destination: 'cloudfunctions/tableRefundNotifyV3/lib/table-refund/refund-transition.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-refund/cloudbase-refund-store.js',
    destination: 'cloudfunctions/tableRefundNotifyV3/lib/table-refund/cloudbase-refund-store.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-finance/money.js',
    destination: 'cloudfunctions/tableRefundNotifyV3/lib/table-finance/money.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-finance/state.js',
    destination: 'cloudfunctions/tableRefundNotifyV3/lib/table-finance/state.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/wechatpay-v3/client.js',
    destination: 'cloudfunctions/tableRefundNotifyV3/lib/wechatpay-v3/client.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/wechatpay-v3/config.js',
    destination: 'cloudfunctions/tableRefundNotifyV3/lib/wechatpay-v3/config.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/wechatpay-v3/http-event.js',
    destination: 'cloudfunctions/tableRefundNotifyV3/lib/wechatpay-v3/http-event.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/wechatpay-v3/bill-parser.js',
    destination: 'cloudfunctions/tableRefundNotifyV3/lib/wechatpay-v3/bill-parser.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-reconciliation/table-reconciliation.js',
    destination: 'cloudfunctions/reconcileTableFinance/lib/table-reconciliation/table-reconciliation.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-reconciliation/cloudbase-reconciliation-store.js',
    destination: 'cloudfunctions/reconcileTableFinance/lib/table-reconciliation/cloudbase-reconciliation-store.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-finance/money.js',
    destination: 'cloudfunctions/reconcileTableFinance/lib/table-finance/money.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/table-finance/state.js',
    destination: 'cloudfunctions/reconcileTableFinance/lib/table-finance/state.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/wechatpay-v3/client.js',
    destination: 'cloudfunctions/reconcileTableFinance/lib/wechatpay-v3/client.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/wechatpay-v3/config.js',
    destination: 'cloudfunctions/reconcileTableFinance/lib/wechatpay-v3/config.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/wechatpay-v3/http-event.js',
    destination: 'cloudfunctions/reconcileTableFinance/lib/wechatpay-v3/http-event.js'
  }),
  Object.freeze({
    source: 'cloudfunctions/_shared/wechatpay-v3/bill-parser.js',
    destination: 'cloudfunctions/reconcileTableFinance/lib/wechatpay-v3/bill-parser.js'
  })
]);

assert(fs.existsSync(scriptPath), 'table-finance sync script should exist');

const script = fs.readFileSync(scriptPath, 'utf8');
const allowlistBlock = script.match(
  /\$CopyAllowlist\s*=\s*@\(([\s\S]*?)\r?\n\s*\)/
);
assert(allowlistBlock, 'sync script should declare a literal per-file copy allowlist');
const scriptCopies = [...allowlistBlock[1].matchAll(
  /@\{\s*Source\s*=\s*'([^']+)'\s*;\s*Destination\s*=\s*'([^']+)'\s*\}/g
)].map((match) => ({
  source: match[1].replace(/\\/g, '/'),
  destination: match[2].replace(/\\/g, '/')
}));

assert.deepStrictEqual(
  scriptCopies,
  copyAllowlist.map((entry) => ({ ...entry })),
  'sync script and parity test per-file allowlists must match exactly'
);
assert.strictEqual(
  new Set(scriptCopies.map((entry) => entry.destination)).size,
  scriptCopies.length,
  'sync destination file allowlist must not contain duplicates'
);
assert.match(script, /if\s*\(\$args\.Count\s*-ne\s*0\)/i);
const firstFunctionIndex = script.search(/^function\s+/im);
const topLevelPrefix = firstFunctionIndex === -1
  ? script
  : script.slice(0, firstFunctionIndex);
assert.doesNotMatch(topLevelPrefix, /^\s*param\s*\(/im);
assert.doesNotMatch(script, /\bRemove-Item\b/i);

const guardStart = script.search(/function\s+Assert-SafeRepositoryPath\s*\{/i);
assert.notStrictEqual(
  guardStart,
  -1,
  'sync script should define a reusable ancestor-chain guard'
);
const firstGuardCall = script.indexOf(
  '$RepositoryRoot = Assert-SafeRepositoryPath',
  guardStart
);
assert(firstGuardCall > guardStart, 'ancestor-chain guard should be called after its definition');
const guardBody = script.slice(guardStart, firstGuardCall);
assert.match(guardBody, /foreach\s*\(\$Segment\s+in\s+\$Segments\)/i);
assert.match(guardBody, /Get-Item\s+-LiteralPath\s+\$Current/i);
assert.match(guardBody, /ReparsePoint/i);
assert.match(guardBody, /PSIsContainer/i);

const beforeCopy = script.slice(0, script.indexOf('Copy-Item'));
for (const variable of [
  'RepositoryRoot',
  'CanonicalDirectory',
  'PaymentCanonicalDirectory',
  'WechatPayCanonicalDirectory',
  'ProfitSharingCanonicalDirectory',
  'RefundCanonicalDirectory',
  'ReconciliationCanonicalDirectory',
  'Source',
  'Destination'
]) {
  assert.match(
    beforeCopy,
    new RegExp(`\\$${variable}\\s*=\\s*Assert-SafeRepositoryPath\\b`, 'i'),
    `sync script should guard ${variable} before Copy-Item`
  );
}

const escapedScriptPath = scriptPath.replace(/'/g, "''");
const syntaxCheck = childProcess.spawnSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    [
      '$tokens = $null',
      '$errors = $null',
      `[void][System.Management.Automation.Language.Parser]::ParseFile('${escapedScriptPath}', [ref]$tokens, [ref]$errors)`,
      "if ($errors.Count -ne 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }"
    ].join('; ')
  ],
  { encoding: 'utf8', windowsHide: true }
);
assert.strictEqual(
  syntaxCheck.status,
  0,
  `sync script must parse in Windows PowerShell:\n${syntaxCheck.stderr}${syntaxCheck.stdout}`
);

for (const copy of copyAllowlist) {
  for (const [label, relativePath] of Object.entries(copy)) {
    const resolved = path.resolve(root, relativePath);
    const relative = path.relative(root, resolved);
    assert(
      relative && !relative.startsWith('..') && !path.isAbsolute(relative),
      `${label} ${relativePath} should remain under the repository root`
    );
  }
  const source = fs.readFileSync(path.join(root, copy.source));
  const deployed = fs.readFileSync(path.join(root, copy.destination));
  assert(
    source.equals(deployed),
    `${copy.destination} must byte-match ${copy.source}`
  );
}

console.log(`cloud shared parity ok (${copyAllowlist.length} explicit copies)`);
