const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const inventoryCollator = new Intl.Collator('en-US', { sensitivity: 'base' });
const baselinePath = 'tests/fixtures/auth-v2-identity-baseline.json';
const policyPath = 'scripts/auth-v2-entry-policy.json';
const matrixPath = 'docs/auth-v2-migration-matrix.md';
const printProtocolClientPaths = process.argv.includes('--print-protocol-client-paths');

function readCommittedJson(relativePath) {
  const result = childProcess.spawnSync(
    'git',
    ['show', `HEAD:${relativePath}`],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024
    }
  );
  assert.strictEqual(
    result.status,
    0,
    `cannot read committed ${relativePath}:\n${result.stderr}${result.stdout}`
  );
  return JSON.parse(result.stdout);
}

function getProtocolClientPaths(policy) {
  assert.strictEqual(policy && policy.schemaVersion, 1, 'protocol client CLI requires policy schema 1');
  assert(policy && Array.isArray(policy.entries), 'protocol client CLI requires policy entries');
  return policy.entries
    .map((entry) => {
      assert(
        entry && ['client', 'branch', 'none'].includes(entry.protocolGuard),
        'protocol client CLI encountered an unknown protocolGuard'
      );
      if (entry.protocolGuard === 'none') return null;
      assert.match(entry.name, /^[A-Za-z0-9_]+$/, 'protocol client CLI entry name is invalid');
      const relativePath = `cloudfunctions/${entry.name}/index.js`;
      const expectedDestination =
        `cloudfunctions/${entry.name}/lib/auth/protocol-guard.js`;
      assert(
        fs.existsSync(path.join(root, relativePath)),
        `protocol client CLI entry is missing: ${relativePath}`
      );
      assert.deepStrictEqual(
        entry.copies.filter((copy) => copy.module === 'protocol-guard'),
        [{ module: 'protocol-guard', destination: expectedDestination }],
        `${entry.name} protocol client CLI copy destination changed`
      );
      return relativePath;
    })
    .filter(Boolean)
    .sort();
}

if (printProtocolClientPaths) {
  const cliPolicy = readCommittedJson(policyPath);
  const paths = getProtocolClientPaths(cliPolicy);
  assert.strictEqual(paths.length, 97, 'protocol client CLI must emit exactly 97 paths');
  assert.deepStrictEqual(paths, [...paths].sort(), 'protocol client CLI paths must be sorted');
  assert.strictEqual(new Set(paths).size, paths.length, 'protocol client CLI paths must be unique');
  for (const relativePath of paths) {
    assert.match(
      relativePath,
      /^cloudfunctions\/[^/]+\/index\.js$/,
      `invalid protocol client CLI path: ${relativePath}`
    );
  }
  const sha256 = crypto.createHash('sha256').update(paths.join('\n')).digest('hex');
  process.stdout.write([
    ...paths,
    `PROTOCOL_CLIENT_COUNT=${paths.length}`,
    `PROTOCOL_CLIENT_SHA256=${sha256}`
  ].join('\n') + '\n');
  process.exit(0);
}

const expectedModules = Object.freeze({
  'protocol-guard': Object.freeze({
    source: 'cloudfunctions/_shared/auth/protocol-guard.js',
    availableFromTask: 2
  }),
  keyring: Object.freeze({
    source: 'cloudfunctions/_shared/auth/keyring.js',
    availableFromTask: 3
  }),
  identifiers: Object.freeze({
    source: 'cloudfunctions/_shared/auth/identifiers.js',
    availableFromTask: 3
  }),
  password: Object.freeze({
    source: 'cloudfunctions/_shared/auth/password.js',
    availableFromTask: 3
  }),
  session: Object.freeze({
    source: 'cloudfunctions/_shared/auth/session.js',
    availableFromTask: 3
  }),
  sms: Object.freeze({
    source: 'cloudfunctions/_shared/auth/sms.js',
    availableFromTask: 4
  })
});

const expectedPaymentCopies = Object.freeze([
  'cloudfunctions/_shared/table-payment/payment-transition.js',
  'cloudfunctions/_shared/table-payment/table-payment.js',
  'cloudfunctions/_shared/table-profit-sharing/table-profit-sharing.js',
  'cloudfunctions/_shared/table-refund/cloudbase-refund-store.js',
  'cloudfunctions/_shared/table-refund/table-refund.js',
  'cloudfunctions/createTablePayOrder/lib/payment-transition.js',
  'cloudfunctions/createTablePayOrder/lib/table-payment.js',
  'cloudfunctions/reconcileTablePayments/lib/payment-transition.js',
  'cloudfunctions/reconcileTablePayments/lib/table-payment.js',
  'cloudfunctions/requestTableRefund/lib/table-refund/cloudbase-refund-store.js',
  'cloudfunctions/requestTableRefund/lib/table-refund/table-refund.js',
  'cloudfunctions/settleTableProfitSharing/lib/table-profit-sharing/table-profit-sharing.js',
  'cloudfunctions/tablePayNotifyV3/lib/payment-transition.js',
  'cloudfunctions/tablePayNotifyV3/lib/table-payment.js',
  'cloudfunctions/tableRefundNotifyV3/lib/table-refund/cloudbase-refund-store.js',
  'cloudfunctions/tableRefundNotifyV3/lib/table-refund/table-refund.js'
]);

const requiredAuthCollections = Object.freeze([
  'account_names',
  'accounts',
  'auth_control',
  'auth_proofs',
  'auth_sessions',
  'email_bindings',
  'password_rate_limits',
  'phone_bindings',
  'sms_codes',
  'sms_rate_limits',
  'users',
  'wechat_bindings'
]);

const allowedBoundaries = new Set([
  'session',
  'auth',
  'admin',
  'public',
  'callback',
  'timer',
  'mixed',
  'session_payer',
  'retired'
]);
const allowedProtocolGuards = new Set(['client', 'none', 'branch']);
const allowedSessions = new Set(['required', 'none', 'action', 'purpose', 'branch']);
const expectedBoundaryCounts = Object.freeze({
  session: 71,
  auth: 3,
  retired: 7,
  admin: 7,
  public: 7,
  callback: 6,
  timer: 5,
  mixed: 1,
  session_payer: 1
});
const expectedBoundaryMembers = Object.freeze({
  session: Object.freeze([
    'login', 'deleteAccount', 'getUserBilling', 'getUserProfile', 'markFirstLogin',
    'saveUserProfile', 'addComment', 'createPost', 'getFeed', 'getFollows',
    'getPostDetail', 'toggleFollow', 'toggleLike', 'cancelJoin', 'cancelMatch',
    'createMatchPost', 'getMyJoins', 'getMyMatches', 'joinMatch', 'addTraining',
    'cancelBooking', 'createBooking', 'getMyBookings', 'getCoachBookings',
    'getCoachLessons', 'getCoachProfile', 'getCoachStudents', 'getDayDetail',
    'getHeatmap', 'getMemberCheckins', 'getMembers', 'getMyMembers', 'linkMember',
    'saveCoachProfile', 'addShopCoach', 'applyCoachShopBinding',
    'getCoachBindingApplications', 'getLinkableCoaches',
    'getMyCoachShopBindingStatus', 'getShopCoaches', 'removeShopCoach',
    'reviewCoachBindingApplication', 'getCoachSettlementDetail',
    'getShopApplicationStatus', 'getShopBrands', 'getShopCoachSettlement',
    'getShopMembers', 'getShopProfile', 'getShopStores', 'saveShopBrand',
    'saveShopProfile', 'saveShopStore', 'settleCoach', 'submitShopApplication',
    'createSession', 'createTableOrder', 'genTableCheckoutCode',
    'getMyCheckinStatus', 'getPendingCheckins', 'getSessions',
    'getShopBizOverview', 'getTableParticipants', 'getTodayRevenue',
    'markTableOrderExternalPaid', 'requestCheckin', 'resolveCheckin',
    'cancelRecurringContract', 'closeSession', 'genCheckinCode',
    'getMatchJoiners', 'recordVerifiedTraining'
  ]),
  auth: Object.freeze(['accountAuth', 'sendEmailCode', 'sendSmsCode']),
  retired: Object.freeze([
    'verifySmsCode', 'reconcilePay', 'createPayOrder', 'createRecurringContract',
    'createRecurringDebit', 'createVirtualPayOrder', 'upgradePlan'
  ]),
  admin: Object.freeze([
    'adminLogin', 'getAdminCoaches', 'getAdminMembers', 'getAdminStatus',
    'getAdminStores', 'getPendingShopApplications', 'reviewShopApplication'
  ]),
  public: Object.freeze([
    'getBrands', 'getMemberProfile', 'getStores', 'getTableCheckoutOrder',
    'getCoaches', 'getHalls', 'getMatchPosts'
  ]),
  callback: Object.freeze([
    'payCallback', 'recurringContractCallback', 'recurringDebitCallback',
    'virtualPayCallback', 'tablePayNotifyV3', 'tableRefundNotifyV3'
  ]),
  timer: Object.freeze([
    'purgeDeletedAccounts', 'reconcileTableFinance', 'reconcileTablePayments',
    'settleTableProfitSharing', 'purgeAuthArtifacts'
  ]),
  mixed: Object.freeze(['requestTableRefund']),
  session_payer: Object.freeze(['createTablePayOrder'])
});
const expectedBatchMembers = Object.freeze({
  'auth-core': Object.freeze([
    'accountAuth', 'login', 'purgeAuthArtifacts', 'sendSmsCode', 'verifySmsCode'
  ]),
  'email-recovery': Object.freeze(['sendEmailCode']),
  'personal-social': Object.freeze([
    'addComment', 'cancelJoin', 'cancelMatch', 'createMatchPost', 'createPost',
    'getFeed', 'getFollows', 'getMatchJoiners', 'getMatchPosts',
    'getMemberProfile', 'getMyJoins', 'getMyMatches', 'getPostDetail',
    'getUserProfile', 'joinMatch', 'markFirstLogin', 'saveUserProfile',
    'toggleFollow', 'toggleLike'
  ]),
  'training-booking': Object.freeze([
    'addTraining', 'cancelBooking', 'createBooking', 'getCoachBookings',
    'getCoachLessons', 'getCoachProfile', 'getCoachStudents', 'getDayDetail',
    'getHeatmap', 'getMemberCheckins', 'getMembers', 'getMyBookings',
    'getMyMembers', 'linkMember', 'saveCoachProfile'
  ]),
  'coach-shop-admin': Object.freeze([
    'addShopCoach', 'adminLogin', 'applyCoachShopBinding', 'getAdminCoaches',
    'getAdminMembers', 'getAdminStatus', 'getAdminStores', 'getBrands',
    'getCoachBindingApplications', 'getCoaches', 'getCoachSettlementDetail',
    'getHalls', 'getLinkableCoaches', 'getMyCoachShopBindingStatus',
    'getPendingShopApplications', 'getShopApplicationStatus', 'getShopBrands',
    'getShopCoaches', 'getShopCoachSettlement', 'getShopMembers',
    'getShopProfile', 'getShopStores', 'getStores', 'removeShopCoach',
    'reviewCoachBindingApplication', 'reviewShopApplication', 'saveShopBrand',
    'saveShopProfile', 'saveShopStore', 'settleCoach', 'submitShopApplication'
  ]),
  'table-payment': Object.freeze([
    'closeSession', 'createSession', 'createTableOrder', 'createTablePayOrder',
    'genCheckinCode', 'genTableCheckoutCode', 'getMyCheckinStatus',
    'getPendingCheckins', 'getSessions', 'getShopBizOverview',
    'getTableCheckoutOrder', 'getTableParticipants', 'getTodayRevenue',
    'markTableOrderExternalPaid', 'reconcileTableFinance',
    'reconcileTablePayments', 'recordVerifiedTraining', 'requestCheckin',
    'requestTableRefund', 'resolveCheckin', 'settleTableProfitSharing',
    'tablePayNotifyV3', 'tableRefundNotifyV3'
  ]),
  'account-lifecycle': Object.freeze([
    'cancelRecurringContract', 'createPayOrder', 'createRecurringContract',
    'createRecurringDebit', 'createVirtualPayOrder', 'deleteAccount',
    'getUserBilling', 'payCallback', 'purgeDeletedAccounts', 'reconcilePay',
    'recurringContractCallback', 'recurringDebitCallback', 'upgradePlan',
    'virtualPayCallback'
  ])
});

const anonymousActions = Object.freeze([
  'probe',
  'registerAccountName',
  'loginPassword',
  'loginSms',
  'loginWechat',
  'verifyWechatEntryPhone',
  'completeWechatEntry',
  'resetPasswordByWechat',
  'resetPasswordByEmail'
]);
const sessionActions = Object.freeze([
  'status',
  'reauthenticate',
  'bindPhone',
  'setAccountName',
  'setPassword',
  'bindWechat',
  'logoutCurrent',
  'logoutOthers',
  'bindEmail'
]);
const recentAuthActions = Object.freeze([
  'bindPhone',
  'setAccountName',
  'setPassword',
  'bindWechat',
  'logoutOthers'
]);
const sessionShapeFieldOwners = Object.freeze({
  anonymousActions: Object.freeze(['accountAuth']),
  sessionActions: Object.freeze(['accountAuth']),
  recentAuthActions: Object.freeze(['accountAuth']),
  anonymousPurposes: Object.freeze(['sendEmailCode', 'sendSmsCode']),
  sessionPurposes: Object.freeze(['sendEmailCode', 'sendSmsCode']),
  branches: Object.freeze(['requestTableRefund'])
});
const focusedTestGroups = Object.freeze([
  Object.freeze({
    entries: Object.freeze(['accountAuth']),
    tests: Object.freeze([
      'tests/accountWechatBinding.test.js',
      'tests/registerAccountRules.test.js',
      'tests/emailRecovery.test.js',
      'tests/smsLogin.test.js',
      'tests/loginMethods.test.js'
    ])
  }),
  Object.freeze({
    entries: Object.freeze(['login']),
    tests: Object.freeze([
      'tests/loginMethods.test.js',
      'tests/accountWechatBinding.test.js',
      'tests/coachMemberCompatibility.test.js',
      'tests/accountDeletionGracePeriod.test.js'
    ])
  }),
  Object.freeze({
    entries: Object.freeze(['sendSmsCode', 'verifySmsCode']),
    tests: Object.freeze(['tests/smsLogin.test.js', 'tests/loginMethods.test.js'])
  }),
  Object.freeze({
    entries: Object.freeze(['purgeAuthArtifacts']),
    tests: Object.freeze([
      'tests/authMigrationMatrix.test.js',
      'tests/smsLogin.test.js',
      'tests/accountDeletionGracePeriod.test.js'
    ])
  }),
  Object.freeze({
    entries: Object.freeze(['sendEmailCode']),
    tests: Object.freeze(['tests/emailRecovery.test.js'])
  }),
  Object.freeze({
    entries: Object.freeze(['getUserProfile']),
    tests: Object.freeze(['tests/saveUserProfile.test.js'])
  }),
  Object.freeze({
    entries: Object.freeze(['saveUserProfile']),
    tests: Object.freeze(['tests/saveUserProfile.test.js', 'tests/profileAvatarEdit.test.js'])
  }),
  Object.freeze({
    entries: Object.freeze(['markFirstLogin']),
    tests: Object.freeze(['tests/loginMethods.test.js', 'tests/profileHeaderRole.test.js'])
  }),
  Object.freeze({
    entries: Object.freeze([
      'addComment', 'createPost', 'getFeed', 'getFollows', 'getPostDetail',
      'toggleFollow', 'toggleLike'
    ]),
    tests: Object.freeze(['tests/avatarPropagation.test.js', 'tests/profileHeaderRole.test.js'])
  }),
  Object.freeze({
    entries: Object.freeze([
      'cancelJoin', 'cancelMatch', 'createMatchPost', 'getMyJoins',
      'getMyMatches', 'joinMatch', 'getMatchJoiners', 'getMatchPosts'
    ]),
    tests: Object.freeze([
      'tests/matchGameTypes.test.js',
      'tests/matchCardLayout.test.js',
      'tests/avatarPropagation.test.js'
    ])
  }),
  Object.freeze({
    entries: Object.freeze(['getMemberProfile']),
    tests: Object.freeze(['tests/profileHeaderRole.test.js', 'tests/avatarPropagation.test.js'])
  }),
  Object.freeze({
    entries: Object.freeze([
      'addTraining', 'cancelBooking', 'getCoachBookings', 'getCoachLessons',
      'getDayDetail', 'getHeatmap', 'linkMember'
    ]),
    tests: Object.freeze(['tests/coachMemberCompatibility.test.js'])
  }),
  Object.freeze({
    entries: Object.freeze(['createBooking']),
    tests: Object.freeze([
      'tests/coachMemberCompatibility.test.js',
      'tests/coachCommissionRetirement.test.js'
    ])
  }),
  Object.freeze({
    entries: Object.freeze(['getMyBookings', 'getMemberCheckins']),
    tests: Object.freeze([
      'tests/profileHeaderRole.test.js',
      'tests/coachMemberCompatibility.test.js'
    ])
  }),
  Object.freeze({
    entries: Object.freeze(['getCoachProfile']),
    tests: Object.freeze([
      'tests/coachProfileSettingsBinding.test.js',
      'tests/coachMemberCompatibility.test.js'
    ])
  }),
  Object.freeze({
    entries: Object.freeze(['saveCoachProfile']),
    tests: Object.freeze([
      'tests/becomeCoachApplication.test.js',
      'tests/coachProfileSettingsBinding.test.js'
    ])
  }),
  Object.freeze({
    entries: Object.freeze(['getCoachStudents', 'getMembers', 'getMyMembers']),
    tests: Object.freeze([
      'tests/avatarPropagation.test.js',
      'tests/coachMemberCompatibility.test.js'
    ])
  }),
  Object.freeze({
    entries: Object.freeze([
      'addShopCoach', 'applyCoachShopBinding', 'getCoachBindingApplications',
      'getLinkableCoaches', 'getMyCoachShopBindingStatus', 'removeShopCoach',
      'reviewCoachBindingApplication'
    ]),
    tests: Object.freeze([
      'tests/becomeCoachApplication.test.js',
      'tests/coachMemberCompatibility.test.js'
    ])
  }),
  Object.freeze({
    entries: Object.freeze(['getShopCoaches', 'getShopMembers', 'getShopStores']),
    tests: Object.freeze([
      'tests/profileHeaderRole.test.js',
      'tests/avatarPropagation.test.js',
      'tests/hallStatusCheckoutContract.test.js'
    ])
  }),
  Object.freeze({
    entries: Object.freeze([
      'getCoachSettlementDetail', 'getShopCoachSettlement', 'settleCoach'
    ]),
    tests: Object.freeze(['tests/coachCommissionRetirement.test.js'])
  }),
  Object.freeze({
    entries: Object.freeze([
      'getShopApplicationStatus', 'getShopProfile', 'saveShopProfile',
      'saveShopStore', 'submitShopApplication'
    ]),
    tests: Object.freeze(['tests/shopQualificationApply.test.js'])
  }),
  Object.freeze({
    entries: Object.freeze(['getShopBrands', 'saveShopBrand']),
    tests: Object.freeze([
      'tests/profileHeaderRole.test.js',
      'tests/tableSessionOrderFlow.test.js'
    ])
  }),
  Object.freeze({
    entries: Object.freeze([
      'adminLogin', 'getAdminCoaches', 'getAdminMembers', 'getAdminStatus',
      'getAdminStores', 'getPendingShopApplications', 'reviewShopApplication'
    ]),
    tests: Object.freeze(['tests/adminVisibility.test.js', 'tests/adminPortal.test.js'])
  }),
  Object.freeze({
    entries: Object.freeze(['getBrands', 'getStores']),
    tests: Object.freeze(['tests/adminPortal.test.js', 'tests/shopQualificationApply.test.js'])
  }),
  Object.freeze({
    entries: Object.freeze(['getCoaches', 'getHalls']),
    tests: Object.freeze([
      'tests/coachMemberCompatibility.test.js',
      'tests/hallStatusCheckoutContract.test.js'
    ])
  }),
  Object.freeze({
    entries: Object.freeze(['createSession', 'createTableOrder', 'closeSession', 'getSessions']),
    tests: Object.freeze([
      'tests/tableSessionOrderFlow.test.js',
      'tests/hallStatusCheckoutContract.test.js'
    ])
  }),
  Object.freeze({
    entries: Object.freeze([
      'genTableCheckoutCode', 'getTableCheckoutOrder', 'markTableOrderExternalPaid'
    ]),
    tests: Object.freeze([
      'tests/tableCheckoutToken.test.js',
      'tests/hallStatusCheckoutContract.test.js'
    ])
  }),
  Object.freeze({
    entries: Object.freeze([
      'genCheckinCode', 'getMyCheckinStatus', 'getPendingCheckins',
      'getTableParticipants', 'requestCheckin', 'resolveCheckin'
    ]),
    tests: Object.freeze([
      'tests/tableCheckinAccess.test.js',
      'tests/tableCodeCheckin.test.js',
      'tests/hallStatusCheckoutContract.test.js'
    ])
  }),
  Object.freeze({
    entries: Object.freeze(['recordVerifiedTraining']),
    tests: Object.freeze([
      'tests/coachCommissionRetirement.test.js',
      'tests/hallStatusCheckoutContract.test.js'
    ])
  }),
  Object.freeze({
    entries: Object.freeze(['getShopBizOverview', 'getTodayRevenue']),
    tests: Object.freeze(['tests/tableReporting.test.js'])
  }),
  Object.freeze({
    entries: Object.freeze(['createTablePayOrder']),
    tests: Object.freeze([
      'tests/tablePaymentBackend.test.js',
      'tests/tablePaymentDeployment.test.js'
    ])
  }),
  Object.freeze({
    entries: Object.freeze(['requestTableRefund']),
    tests: Object.freeze(['tests/tableRefunds.test.js', 'tests/tablePaymentDeployment.test.js'])
  }),
  Object.freeze({
    entries: Object.freeze(['reconcileTableFinance']),
    tests: Object.freeze([
      'tests/tableReconciliation.test.js',
      'tests/tablePaymentDeployment.test.js'
    ])
  }),
  Object.freeze({
    entries: Object.freeze(['reconcileTablePayments']),
    tests: Object.freeze([
      'tests/tablePaymentBackend.test.js',
      'tests/tablePaymentDeployment.test.js'
    ])
  }),
  Object.freeze({
    entries: Object.freeze(['settleTableProfitSharing']),
    tests: Object.freeze([
      'tests/tableProfitSharing.test.js',
      'tests/tablePaymentDeployment.test.js'
    ])
  }),
  Object.freeze({
    entries: Object.freeze(['tablePayNotifyV3']),
    tests: Object.freeze([
      'tests/tablePaymentBackend.test.js',
      'tests/tablePaymentDeployment.test.js'
    ])
  }),
  Object.freeze({
    entries: Object.freeze(['tableRefundNotifyV3']),
    tests: Object.freeze(['tests/tableRefunds.test.js', 'tests/tablePaymentDeployment.test.js'])
  }),
  Object.freeze({
    entries: Object.freeze(['deleteAccount', 'purgeDeletedAccounts']),
    tests: Object.freeze(['tests/accountDeletionGracePeriod.test.js'])
  }),
  Object.freeze({
    entries: Object.freeze(['getUserBilling']),
    tests: Object.freeze([
      'tests/legacyBillingRetirement.test.js',
      'tests/shopSubscriptionPlans.test.js'
    ])
  }),
  Object.freeze({
    entries: Object.freeze(['cancelRecurringContract', 'createRecurringContract']),
    tests: Object.freeze([
      'tests/recurringSubscriptionGuard.test.js',
      'tests/recurringCloudFunctions.test.js',
      'tests/legacyBillingRetirement.test.js'
    ])
  }),
  Object.freeze({
    entries: Object.freeze([
      'createRecurringDebit', 'recurringContractCallback', 'recurringDebitCallback'
    ]),
    tests: Object.freeze([
      'tests/recurringCloudFunctions.test.js',
      'tests/legacyBillingRetirement.test.js'
    ])
  }),
  Object.freeze({
    entries: Object.freeze([
      'createPayOrder', 'createVirtualPayOrder', 'upgradePlan', 'payCallback',
      'virtualPayCallback', 'reconcilePay'
    ]),
    tests: Object.freeze([
      'tests/legacyBillingRetirement.test.js',
      'tests/shopSubscriptionPlans.test.js'
    ])
  })
]);

function readJson(relativePath) {
  const absolutePath = path.join(root, relativePath);
  assert(fs.existsSync(absolutePath), `missing ${relativePath}`);
  return JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
}

function assertSortedUniqueForwardPaths(paths, label) {
  assert(Array.isArray(paths), `${label} must be an array`);
  assert.strictEqual(new Set(paths).size, paths.length, `${label} must be unique`);
  assert.deepStrictEqual(
    paths,
    [...paths].sort(inventoryCollator.compare),
    `${label} must be sorted`
  );
  for (const value of paths) {
    assert.strictEqual(typeof value, 'string', `${label} values must be strings`);
    assert(value.length > 0, `${label} values must not be empty`);
    assert(!value.includes('\\'), `${label} must use forward slashes: ${value}`);
    assert(!path.isAbsolute(value), `${label} must be repo-relative: ${value}`);
    const resolved = path.resolve(root, value);
    const relative = path.relative(root, resolved);
    assert(
      relative && !relative.startsWith('..') && !path.isAbsolute(relative),
      `${label} must remain under the repository root: ${value}`
    );
  }
}

function scanIdentityBoundary() {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = (Resolve-Path .).Path
$entryIndexes = @(Get-ChildItem -LiteralPath cloudfunctions -Directory | ForEach-Object {
  $path = Join-Path $_.FullName 'index.js'
  if (Test-Path -LiteralPath $path) { $path.Substring($root.Length + 1) -replace '\\', '/' }
} | Sort-Object)
$directIdentityEntries = @($entryIndexes | Where-Object {
  Select-String -LiteralPath $_ -Pattern 'getWXContext\(|wechat_bindings|_openid' -Quiet
})
$allIdentityJs = @(rg -l --no-ignore --glob '*.js' --glob '!**/node_modules/**' --glob '!**/.agents/**' 'getWXContext\(|wechat_bindings|_openid' cloudfunctions |
  ForEach-Object { $_ -replace '\\', '/' } | Sort-Object)
[pscustomobject]@{
  currentEntryPaths = $entryIndexes
  directIdentityEntryPaths = $directIdentityEntries
  allIdentityJsPaths = $allIdentityJs
} | ConvertTo-Json -Compress -Depth 4
`;
  const result = childProcess.spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024
    }
  );
  assert.strictEqual(
    result.status,
    0,
    `identity inventory scan failed:\n${result.stderr}${result.stdout}`
  );
  return JSON.parse(result.stdout.trim());
}

function entryNameFromPath(relativePath) {
  const match = relativePath.match(/^cloudfunctions\/([^/]+)\/index\.js$/);
  assert(match, `unexpected entry path: ${relativePath}`);
  return match[1];
}

function parseMatrix(markdown) {
  const header = '| entry/collection | current identity key | v2 identity key | boundary | read/write foreign keys | focused tests | release batch | status |';
  assert(markdown.includes(header), 'matrix must use the exact required column header');
  const rows = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (!/^\|\s*(entry|collection):/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    assert.strictEqual(cells.length, 8, `matrix row must have eight cells: ${line}`);
    const match = cells[0].match(/^(entry|collection):([A-Za-z0-9_]+)$/);
    assert(match, `matrix row key must be entry:<name> or collection:<name>: ${cells[0]}`);
    rows.push({
      kind: match[1],
      name: match[2],
      currentIdentityKey: cells[1],
      v2IdentityKey: cells[2],
      boundary: cells[3],
      foreignKeys: cells[4],
      focusedTests: cells[5],
      batch: cells[6],
      status: cells[7]
    });
  }
  return rows;
}

function discoverBusinessCollections(entryPaths) {
  const collections = new Set();
  const patterns = [
    /\.collection\(\s*['"]([a-z0-9_]+)['"]/g,
    /\b(?:gather|fetchAll|readAll)\(\s*['"]([a-z0-9_]+)['"]/g
  ];
  const files = [];
  function walk(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (item.name === 'node_modules' || item.isSymbolicLink()) continue;
      const absolutePath = path.join(directory, item.name);
      if (item.isDirectory()) {
        walk(absolutePath);
      } else if (item.isFile() && item.name.endsWith('.js')) {
        files.push(absolutePath);
      }
    }
  }
  for (const relativePath of entryPaths) {
    walk(path.dirname(path.join(root, relativePath)));
  }
  for (const absolutePath of [...new Set(files)]) {
    const source = fs.readFileSync(absolutePath, 'utf8');
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) collections.add(match[1]);
    }
  }
  return [...collections].sort(inventoryCollator.compare);
}

function splitFocusedTests(value) {
  return value
    .split(/(?:<br\s*\/?>|,\s*)/i)
    .map((item) => item.trim())
    .filter(Boolean);
}

function assertFocusedTests(values, label) {
  assert(Array.isArray(values) && values.length > 0, `${label} must list focused tests`);
  for (const value of values) {
    assert.match(value, /^tests\/[A-Za-z0-9._/-]+\.test\.js$/, `${label} has invalid test path`);
    assert(fs.existsSync(path.join(root, value)), `${label} test does not exist: ${value}`);
  }
}

function assertExactList(actual, expected, label) {
  assert.deepStrictEqual(actual, expected, `${label} must match the frozen list`);
}

function canonicalModulePath(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function literalLocalRequires(source, sourcePath) {
  const requests = [];
  const requirePattern = /\brequire\s*\(\s*(['"])(\.[^'"]*)\1\s*\)/g;
  for (const match of source.matchAll(requirePattern)) {
    const request = match[2];
    assert(
      request.startsWith('./'),
      `${sourcePath} local auth require must stay in the same directory: ${request}`
    );
    requests.push(request);
  }
  return requests;
}

function collectAuthModuleClosure(moduleName, modules, options = {}) {
  const baseDirectory = options.baseDirectory || root;
  const sourceExists = options.sourceExists || fs.existsSync;
  const readSource = options.readSource || ((sourcePath) => fs.readFileSync(sourcePath, 'utf8'));
  const sourceByModule = new Map();
  const moduleBySource = new Map();
  for (const [name, descriptor] of Object.entries(modules)) {
    const sourcePath = path.resolve(baseDirectory, descriptor.source);
    const canonicalSourcePath = canonicalModulePath(sourcePath);
    assert(!moduleBySource.has(canonicalSourcePath), `duplicate auth module source ${descriptor.source}`);
    sourceByModule.set(name, sourcePath);
    moduleBySource.set(canonicalSourcePath, name);
  }

  const closure = new Set();
  const visited = new Set();
  const active = new Set();
  const stack = [];

  function visit(name) {
    assert(sourceByModule.has(name), `unknown auth module ${name}`);
    if (active.has(name)) {
      assert.fail(`auth module dependency cycle: ${[...stack, name].join(' -> ')}`);
    }
    if (visited.has(name)) return;

    const sourcePath = sourceByModule.get(name);
    closure.add(name);
    active.add(name);
    stack.push(name);

    if (sourceExists(sourcePath)) {
      const sourceDirectory = path.dirname(sourcePath);
      const source = readSource(sourcePath);
      for (const request of literalLocalRequires(source, sourcePath)) {
        const unresolvedDependency = path.resolve(sourceDirectory, request);
        const dependencyPath = path.extname(unresolvedDependency)
          ? unresolvedDependency
          : `${unresolvedDependency}.js`;
        assert.strictEqual(
          canonicalModulePath(path.dirname(dependencyPath)),
          canonicalModulePath(sourceDirectory),
          `${sourcePath} local auth require must stay in the same directory: ${request}`
        );
        const dependencyName = moduleBySource.get(canonicalModulePath(dependencyPath));
        assert(
          dependencyName,
          `${sourcePath} requires an unregistered auth module source: ${request}`
        );
        visit(dependencyName);
      }
    }

    stack.pop();
    active.delete(name);
    visited.add(name);
  }

  visit(moduleName);
  return closure;
}

function assertEntryAuthModuleClosure(entry, modules, options = {}) {
  const baseDirectory = options.baseDirectory || root;
  const currentTask = options.currentTask || 1;
  const sourceExists = options.sourceExists || fs.existsSync;
  const copyModules = new Set(entry.copies.map((copy) => copy.module));
  const requiredModules = new Set();

  for (const moduleName of copyModules) {
    const descriptor = modules[moduleName];
    assert(descriptor, `${entry.name} references unknown auth module ${moduleName}`);
    const sourcePath = path.resolve(baseDirectory, descriptor.source);
    if (!sourceExists(sourcePath)) {
      assert(
        descriptor.availableFromTask > currentTask,
        `${entry.name} ${moduleName} source is missing at or after availableFromTask ${descriptor.availableFromTask}`
      );
      continue;
    }
    for (const dependencyName of collectAuthModuleClosure(moduleName, modules, options)) {
      requiredModules.add(dependencyName);
    }
  }

  const missingModules = [...requiredModules]
    .filter((moduleName) => !copyModules.has(moduleName))
    .sort(inventoryCollator.compare);
  assert.strictEqual(
    missingModules.length,
    0,
    `${entry.name} missing auth module copies: ${missingModules.join(', ')}`
  );
}

function selfTestAuthModuleClosureHelper() {
  const graphRoot = path.join(root, '__virtual_auth_module_graph__');
  const modules = {
    entry: { source: 'auth/entry.js', availableFromTask: 1 },
    direct: { source: 'auth/direct.js', availableFromTask: 1 },
    transitive: { source: 'auth/transitive.js', availableFromTask: 1 },
    future: { source: 'auth/future.js', availableFromTask: 2 },
    overdue: { source: 'auth/overdue.js', availableFromTask: 1 },
    escape: { source: 'auth/escape.js', availableFromTask: 1 },
    'cycle-a': { source: 'auth/cycle-a.js', availableFromTask: 1 },
    'cycle-b': { source: 'auth/cycle-b.js', availableFromTask: 1 }
  };
  const sources = new Map([
    ['auth/entry.js', "require('./direct');"],
    ['auth/direct.js', "require('./transitive');"],
    ['auth/transitive.js', 'module.exports = {};'],
    ['auth/escape.js', "require('../outside');"],
    ['auth/cycle-a.js', "require('./cycle-b');"],
    ['auth/cycle-b.js', "require('./cycle-a');"]
  ].map(([relativePath, source]) => [
    canonicalModulePath(path.join(graphRoot, relativePath)),
    source
  ]));
  const options = {
    baseDirectory: graphRoot,
    currentTask: 1,
    sourceExists: (sourcePath) => sources.has(canonicalModulePath(sourcePath)),
    readSource: (sourcePath) => sources.get(canonicalModulePath(sourcePath))
  };
  const entryWithCopies = (name, copyModules) => ({
    name,
    copies: copyModules.map((module) => ({ module }))
  });

  assert.throws(
    () => assertEntryAuthModuleClosure(entryWithCopies('direct omission', ['entry']), modules, options),
    /missing auth module copies: direct, transitive/,
    'dependency closure helper must detect a missing direct dependency'
  );
  assert.throws(
    () => assertEntryAuthModuleClosure(
      entryWithCopies('transitive omission', ['entry', 'direct']),
      modules,
      options
    ),
    /missing auth module copies: transitive/,
    'dependency closure helper must detect a missing transitive dependency'
  );
  assert.doesNotThrow(
    () => assertEntryAuthModuleClosure(
      entryWithCopies('complete closure', ['entry', 'direct', 'transitive']),
      modules,
      options
    ),
    'dependency closure helper must accept the complete recursive closure'
  );
  assert.doesNotThrow(
    () => assertEntryAuthModuleClosure(entryWithCopies('future source', ['future']), modules, options),
    'dependency closure helper must allow a source that is not available yet'
  );
  assert.throws(
    () => assertEntryAuthModuleClosure(entryWithCopies('overdue source', ['overdue']), modules, options),
    /source is missing at or after availableFromTask/,
    'dependency closure helper must reject a source missing after its availability task'
  );
  assert.throws(
    () => assertEntryAuthModuleClosure(entryWithCopies('path escape', ['escape']), modules, options),
    /must stay in the same directory/,
    'dependency closure helper must reject a local require outside the module directory'
  );
  assert.throws(
    () => assertEntryAuthModuleClosure(
      entryWithCopies('dependency cycle', ['cycle-a', 'cycle-b']),
      modules,
      options
    ),
    /auth module dependency cycle/,
    'dependency closure helper must reject dependency cycles instead of recursing indefinitely'
  );
}

selfTestAuthModuleClosureHelper();

const baseline = readJson(baselinePath);
assertSortedUniqueForwardPaths(baseline.currentEntryPaths, 'currentEntryPaths');
assertSortedUniqueForwardPaths(baseline.directIdentityEntryPaths, 'directIdentityEntryPaths');
assertSortedUniqueForwardPaths(baseline.allIdentityJsPaths, 'allIdentityJsPaths');
assertSortedUniqueForwardPaths(baseline.paymentIdentityCopies, 'paymentIdentityCopies');
assert.strictEqual(baseline.currentEntryPaths.length, 107, 'current entry count changed');
assert.strictEqual(baseline.directIdentityEntryPaths.length, 93, 'direct entry identity count changed');
assert.strictEqual(baseline.allIdentityJsPaths.length, 109, 'all identity JavaScript count changed');
assert.strictEqual(baseline.paymentIdentityCopies.length, 16, 'payment identity copy count changed');
assert.deepStrictEqual(
  baseline.paymentIdentityCopies,
  [...expectedPaymentCopies],
  'payment identity copies must match the explicit frozen allowlist'
);
for (const paymentCopy of baseline.paymentIdentityCopies) {
  assert(
    baseline.allIdentityJsPaths.includes(paymentCopy),
    `payment identity copy is outside the all-JavaScript identity scan: ${paymentCopy}`
  );
}

const scanned = scanIdentityBoundary();
assert.deepStrictEqual(
  scanned.currentEntryPaths,
  baseline.currentEntryPaths,
  'current entry paths changed; update the migration inventory deliberately'
);
assert.deepStrictEqual(
  scanned.directIdentityEntryPaths,
  baseline.directIdentityEntryPaths,
  'direct identity entry paths changed; update the migration inventory deliberately'
);
assert.deepStrictEqual(
  scanned.allIdentityJsPaths,
  baseline.allIdentityJsPaths,
  'all identity JavaScript paths changed; update the migration inventory deliberately'
);

const policy = readJson(policyPath);
assert.strictEqual(policy.schemaVersion, 1, 'policy schemaVersion must be 1');
assert.deepStrictEqual(policy.modules, expectedModules, 'auth module manifest changed');
assert(Array.isArray(policy.entries), 'policy entries must be an array');
assert.strictEqual(policy.entries.length, 108, 'target policy must contain 108 entries');

const currentNames = baseline.currentEntryPaths.map(entryNameFromPath);
const targetNames = [...currentNames, 'purgeAuthArtifacts'].sort(inventoryCollator.compare);
const policyNames = policy.entries.map((entry) => entry.name);
assert.strictEqual(new Set(policyNames).size, policyNames.length, 'policy entry names must be unique');
assert.deepStrictEqual(
  policyNames,
  [...policyNames].sort(inventoryCollator.compare),
  'policy entries must be sorted by name'
);
assert.deepStrictEqual(policyNames, targetNames, 'every current entry plus purgeAuthArtifacts must occur once');

const globalCopyDestinations = new Set();
for (const entry of policy.entries) {
  assert(allowedBoundaries.has(entry.boundary), `${entry.name} has invalid boundary`);
  assert(allowedProtocolGuards.has(entry.protocolGuard), `${entry.name} has invalid protocolGuard`);
  assert(allowedSessions.has(entry.session), `${entry.name} has invalid session policy`);
  assert.strictEqual(typeof entry.planned, 'boolean', `${entry.name} planned must be boolean`);
  assert.strictEqual(typeof entry.batch, 'string', `${entry.name} batch must be a string`);
  assert(entry.batch.length > 0, `${entry.name} batch must not be empty`);
  assertFocusedTests(entry.focusedTests, `${entry.name}.focusedTests`);
  assert(Array.isArray(entry.copies), `${entry.name}.copies must be an array`);

  if (entry.name === 'purgeAuthArtifacts') {
    assert.strictEqual(entry.planned, true, 'purgeAuthArtifacts must be planned');
  } else {
    assert.strictEqual(entry.planned, false, `${entry.name} is a current entry`);
  }

  if (entry.boundary === 'callback' || entry.boundary === 'timer') {
    assert.strictEqual(entry.protocolGuard, 'none', `${entry.name} must not trust a client protocol`);
    assert.strictEqual(entry.session, 'none', `${entry.name} must not require a user session`);
  }
  if (entry.boundary === 'retired') {
    assert.strictEqual(entry.session, 'none', `${entry.name} must be a zero-read retired shim`);
  }
  if (entry.protocolGuard === 'branch' || entry.session === 'branch') {
    assert.strictEqual(entry.name, 'requestTableRefund', 'only requestTableRefund may use branch policy');
    assert.strictEqual(entry.boundary, 'mixed', 'branch policy requires a mixed boundary');
  }
  let expectedSession;
  if (entry.name === 'accountAuth') {
    expectedSession = 'action';
  } else if (entry.name === 'sendEmailCode' || entry.name === 'sendSmsCode') {
    expectedSession = 'purpose';
  } else if (entry.name === 'requestTableRefund') {
    expectedSession = 'branch';
  } else if (entry.boundary === 'session' || entry.name === 'createTablePayOrder') {
    expectedSession = 'required';
  } else {
    expectedSession = 'none';
  }
  assert.strictEqual(
    entry.session,
    expectedSession,
    `${entry.name} session mode must match its exact frozen trust boundary`
  );
  for (const [field, owners] of Object.entries(sessionShapeFieldOwners)) {
    if (!owners.includes(entry.name)) {
      assert(
        !Object.prototype.hasOwnProperty.call(entry, field),
        `${entry.name} must not carry unrelated ${field}`
      );
    }
  }

  const copyModules = [];
  for (const copy of entry.copies) {
    assert.deepStrictEqual(
      Object.keys(copy).sort(),
      ['destination', 'module'],
      `${entry.name} copy records must contain only module and destination`
    );
    assert(expectedModules[copy.module], `${entry.name} references unknown module ${copy.module}`);
    assert.strictEqual(
      copy.destination,
      `cloudfunctions/${entry.name}/lib/auth/${copy.module}.js`,
      `${entry.name} must use an explicit canonical auth copy destination`
    );
    assert(!/[*?[\]]/.test(copy.destination), `${entry.name} copy destination must not use wildcards`);
    assert(!globalCopyDestinations.has(copy.destination), `duplicate auth copy destination ${copy.destination}`);
    globalCopyDestinations.add(copy.destination);
    copyModules.push(copy.module);
  }
  assert.strictEqual(new Set(copyModules).size, copyModules.length, `${entry.name} copy modules must be unique`);
  assertEntryAuthModuleClosure(entry, expectedModules);
  if (entry.protocolGuard === 'client' || entry.protocolGuard === 'branch') {
    assert(copyModules.includes('protocol-guard'), `${entry.name} must deploy protocol-guard`);
  } else {
    assert(!copyModules.includes('protocol-guard'), `${entry.name} must not deploy protocol-guard`);
  }
  if (entry.session !== 'none') {
    assert(copyModules.includes('session'), `${entry.name} must deploy session`);
  } else {
    assert(!copyModules.includes('session'), `${entry.name} must not deploy session`);
  }
  if (copyModules.includes('session')) {
    assert(copyModules.includes('keyring'), `${entry.name} session copy requires a local keyring copy`);
  }
  if (copyModules.includes('sms')) {
    assert(copyModules.includes('keyring'), `${entry.name} sms copy requires a local keyring copy`);
  }
  let expectedCopyModules;
  if (entry.name === 'accountAuth') {
    expectedCopyModules = ['protocol-guard', 'keyring', 'identifiers', 'password', 'session', 'sms'];
  } else if (entry.name === 'sendSmsCode') {
    expectedCopyModules = ['protocol-guard', 'keyring', 'identifiers', 'session', 'sms'];
  } else if (entry.name === 'sendEmailCode') {
    expectedCopyModules = ['protocol-guard', 'keyring', 'session'];
  } else if (['callback', 'timer'].includes(entry.boundary)) {
    expectedCopyModules = [];
  } else if (['retired', 'admin', 'public'].includes(entry.boundary)) {
    expectedCopyModules = ['protocol-guard'];
  } else {
    expectedCopyModules = ['protocol-guard', 'keyring', 'session'];
  }
  assert.deepStrictEqual(
    copyModules,
    expectedCopyModules,
    `${entry.name} copies must match the exact final module allowlist`
  );
}

const plannedEntries = policy.entries.filter((entry) => entry.planned);
assert.deepStrictEqual(
  plannedEntries.map((entry) => entry.name),
  ['purgeAuthArtifacts'],
  'only purgeAuthArtifacts may be absent from the current entry scan'
);
assert.deepStrictEqual(
  policy.entries.reduce((counts, entry) => {
    counts[entry.boundary] = (counts[entry.boundary] || 0) + 1;
    return counts;
  }, {}),
  expectedBoundaryCounts,
  'policy boundary counts must match the frozen File Map'
);
for (const [boundary, members] of Object.entries(expectedBoundaryMembers)) {
  assert.deepStrictEqual(
    policy.entries
      .filter((entry) => entry.boundary === boundary)
      .map((entry) => entry.name)
      .sort(inventoryCollator.compare),
    [...members].sort(inventoryCollator.compare),
    `${boundary} boundary membership must match the frozen File Map`
  );
}
assert.strictEqual(
  policy.entries.filter((entry) => entry.protocolGuard !== 'none').length,
  97,
  'all non-callback and non-timer entries must remain protocol guarded'
);
assert.deepStrictEqual(
  policy.entries
    .flatMap((entry) => entry.copies.map((copy) => copy.module))
    .reduce((counts, module) => {
      counts[module] += 1;
      return counts;
    }, {
      'protocol-guard': 0,
      keyring: 0,
      identifiers: 0,
      password: 0,
      session: 0,
      sms: 0
    }),
  {
    'protocol-guard': 97,
    keyring: 76,
    identifiers: 2,
    password: 1,
    session: 76,
    sms: 2
  },
  'module copy totals must match the final deployable closure'
);
assert.strictEqual(
  policy.entries.reduce((total, entry) => total + entry.copies.length, 0),
  254,
  'final policy must contain 254 explicit copy records'
);
for (const [batch, members] of Object.entries(expectedBatchMembers)) {
  assert.deepStrictEqual(
    policy.entries
      .filter((entry) => entry.batch === batch)
      .map((entry) => entry.name)
      .sort(inventoryCollator.compare),
    [...members].sort(inventoryCollator.compare),
    `${batch} batch membership must match the frozen File Map`
  );
}
const expectedFocusedTests = {};
for (const group of focusedTestGroups) {
  for (const name of group.entries) {
    assert(!expectedFocusedTests[name], `focused-test fixture duplicates ${name}`);
    expectedFocusedTests[name] = [...group.tests];
  }
}
assert.deepStrictEqual(
  Object.keys(expectedFocusedTests).sort(inventoryCollator.compare),
  policyNames,
  'focused-test fixture must cover every policy entry exactly once'
);
for (const entry of policy.entries) {
  assert.deepStrictEqual(
    entry.focusedTests,
    expectedFocusedTests[entry.name],
    `${entry.name}.focusedTests must match the frozen focused suite`
  );
}

const byName = Object.fromEntries(policy.entries.map((entry) => [entry.name, entry]));
assert.strictEqual(byName.login.boundary, 'session', 'login remains a session boundary');
assert.strictEqual(expectedBoundaryMembers.session.length, 71, 'session boundary must remain exactly 71 entries');
assert.deepStrictEqual(
  policy.entries
    .filter((entry) => entry.session === 'required')
    .map((entry) => entry.name)
    .sort(inventoryCollator.compare),
  [...expectedBoundaryMembers.session, 'createTablePayOrder'].sort(inventoryCollator.compare),
  'the 71 session entries plus createTablePayOrder must require sessions'
);
assert.deepStrictEqual(
  policy.entries.filter((entry) => entry.session === 'action').map((entry) => entry.name),
  ['accountAuth'],
  'only accountAuth may use action-based session policy'
);
assert.deepStrictEqual(
  policy.entries.filter((entry) => entry.session === 'purpose').map((entry) => entry.name),
  ['sendEmailCode', 'sendSmsCode'],
  'only sendEmailCode and sendSmsCode may use purpose-based session policy'
);
assert.deepStrictEqual(
  policy.entries.filter((entry) => entry.session === 'branch').map((entry) => entry.name),
  ['requestTableRefund'],
  'only requestTableRefund may use branch-based session policy'
);
for (const boundary of ['retired', 'admin', 'public', 'callback', 'timer']) {
  for (const entry of policy.entries.filter((candidate) => candidate.boundary === boundary)) {
    assert.strictEqual(entry.session, 'none', `${entry.name} ${boundary} boundary must have session:none`);
  }
}
for (const name of ['verifySmsCode', 'reconcilePay']) {
  assert.strictEqual(byName[name].boundary, 'retired', `${name} must be retired`);
  assert.strictEqual(byName[name].session, 'none', `${name} must not require a session`);
}

assert.strictEqual(byName.accountAuth.boundary, 'auth');
assert.strictEqual(byName.accountAuth.session, 'action');
assertExactList(byName.accountAuth.anonymousActions, anonymousActions, 'accountAuth.anonymousActions');
assertExactList(byName.accountAuth.sessionActions, sessionActions, 'accountAuth.sessionActions');
assertExactList(byName.accountAuth.recentAuthActions, recentAuthActions, 'accountAuth.recentAuthActions');
assert(
  recentAuthActions.every((action) => sessionActions.includes(action)),
  'recent auth actions must be a subset of session actions'
);

assert.strictEqual(byName.sendSmsCode.session, 'purpose');
assertExactList(
  byName.sendSmsCode.anonymousPurposes,
  ['login', 'wechat_entry'],
  'sendSmsCode.anonymousPurposes'
);
assertExactList(
  byName.sendSmsCode.sessionPurposes,
  ['bind_phone', 'reauth'],
  'sendSmsCode.sessionPurposes'
);
assert.strictEqual(byName.sendEmailCode.session, 'purpose');
assertExactList(byName.sendEmailCode.anonymousPurposes, ['reset'], 'sendEmailCode.anonymousPurposes');
assertExactList(
  byName.sendEmailCode.sessionPurposes,
  ['bind', 'reauth'],
  'sendEmailCode.sessionPurposes'
);

assert.deepStrictEqual(
  byName.requestTableRefund.branches,
  {
    user: {
      selector: { source: 'client' },
      protocolGuard: 'client',
      session: 'required'
    },
    timer: {
      selector: {
        metadata: 'reconcileTableRefundsTimer',
        trustedCallerOpenid: false
      },
      protocolGuard: 'none',
      session: 'none'
    }
  },
  'requestTableRefund must keep mutually exclusive user and timer trust branches'
);

const matrix = fs.readFileSync(path.join(root, matrixPath), 'utf8');
assert(!/\b(?:TODO|TBD|FIXME|XXX)\b|\?\?\?|待补|待定/i.test(matrix), 'matrix has unfinished markers');
const matrixRows = parseMatrix(matrix);
const matrixKeys = matrixRows.map((row) => `${row.kind}:${row.name}`);
assert.strictEqual(new Set(matrixKeys).size, matrixKeys.length, 'matrix rows must be unique');

for (const row of matrixRows) {
  assert(row.currentIdentityKey.length > 0, `${row.kind}:${row.name} must state current identity keys`);
  assert(row.v2IdentityKey.length > 0, `${row.kind}:${row.name} must state v2 identity keys`);
  assert(allowedBoundaries.has(row.boundary), `${row.kind}:${row.name} has invalid boundary`);
  assert(row.foreignKeys.length > 0, `${row.kind}:${row.name} must state foreign-key behavior`);
  assert(row.batch.length > 0, `${row.kind}:${row.name} must state a release batch`);
  const expectedStatus = row.kind === 'entry'
    && byName[row.name]
    && byName[row.name].protocolGuard !== 'none'
    ? 'protocol_guarded'
    : 'pending';
  assert.strictEqual(
    row.status,
    expectedStatus,
    `${row.kind}:${row.name} migration status advanced outside Task 2`
  );
  assert(!/[*?[\]]/.test(row.focusedTests), `${row.kind}:${row.name} focused tests must be explicit`);
  assertFocusedTests(splitFocusedTests(row.focusedTests), `${row.kind}:${row.name} focused tests`);
}

const entryRows = matrixRows.filter((row) => row.kind === 'entry');
assert.deepStrictEqual(
  entryRows.map((row) => row.name).sort(inventoryCollator.compare),
  policyNames,
  'matrix must contain every target policy entry exactly once'
);
for (const row of entryRows) {
  assert.strictEqual(row.boundary, byName[row.name].boundary, `${row.name} matrix boundary differs from policy`);
  assert.strictEqual(row.batch, byName[row.name].batch, `${row.name} matrix batch differs from policy`);
  assert.deepStrictEqual(
    splitFocusedTests(row.focusedTests),
    byName[row.name].focusedTests,
    `${row.name} matrix focused tests differ from policy`
  );
}

const collectionRows = matrixRows.filter((row) => row.kind === 'collection');
const collectionNames = collectionRows.map((row) => row.name);
const discoveredCollections = discoverBusinessCollections(baseline.currentEntryPaths);
const requiredCollections = [...new Set([
  ...requiredAuthCollections,
  ...discoveredCollections
])].sort(inventoryCollator.compare);
assert.deepStrictEqual(
  [...collectionNames].sort(inventoryCollator.compare),
  requiredCollections,
  'matrix collection rows must cover every authentication and discovered business collection'
);

const fieldMappings = Object.freeze({
  authorOpenid: 'authorAccountId',
  memberOpenid: 'memberAccountId',
  coachOpenid: 'coachAccountId',
  shopOpenid: 'shopAccountId',
  targetOpenid: 'targetAccountId',
  payerOpenid: 'payerOpenid',
  reviewedBy: 'admin principal id'
});
const payerOpenidAllowlist = 'allowlist: payerOpenid is platform-only and never authorizes ownership, lookup, refund, or cross-account access';
const collectionSpecificV2Fields = Object.freeze({
  posts: Object.freeze(['authorAccountId']),
  user_follows: Object.freeze(['followerAccountId', 'targetAccountId']),
  matches: Object.freeze(['ownerAccountId']),
  match_joins: Object.freeze(['memberAccountId']),
  post_likes: Object.freeze(['accountId']),
  post_comments: Object.freeze(['authorAccountId'])
});
const expectedCollectionIdentity = Object.freeze({
  account_deletion_requests: Object.freeze([
    '_id=wechat binding id; _openid; accountId',
    '_id=accountId; accountId'
  ]),
  account_names: Object.freeze(['none (new v2 collection)', 'accountId']),
  accounts: Object.freeze([
    '_id=account-name hash; _openid',
    '_id=accountId (random immutable); accountId'
  ]),
  admin_account_bindings: Object.freeze([
    '_openid; admin OPENID',
    'admin principal id; admin OPENID'
  ]),
  admins: Object.freeze([
    '_openid; admin OPENID',
    'admin principal id; admin OPENID'
  ]),
  auth_control: Object.freeze(['none (new singleton config)', 'none']),
  auth_proofs: Object.freeze([
    'none (new v2 collection)',
    'phoneBindingId; appidHash/openidHash scope'
  ]),
  auth_sessions: Object.freeze(['none (new v2 collection)', 'accountId']),
  bookings: Object.freeze([
    '_openid; targetId may contain coach OPENID',
    'ownerAccountId; coachAccountId'
  ]),
  brands: Object.freeze(['_openid', 'ownerAccountId or ownerType=system']),
  checkin_requests: Object.freeze(['memberOpenid', 'memberAccountId']),
  coach_lessons: Object.freeze([
    '_openid; coachOpenid; memberOpenid; OPENID-derived shopId',
    'ownerAccountId; coachAccountId; memberAccountId; shopAccountId'
  ]),
  coach_member_links: Object.freeze([
    'coachOpenid; memberOpenid',
    'coachAccountId; memberAccountId'
  ]),
  coach_settlements: Object.freeze([
    'shopOpenid; coachOpenid',
    'shopAccountId; coachAccountId'
  ]),
  coach_shop_applications: Object.freeze([
    '_openid; coachOpenid; shopOpenid; reviewedBy as shop OPENID',
    'applicantAccountId; coachAccountId; shopAccountId; reviewerAccountId'
  ]),
  coaches: Object.freeze(['_openid/openid', 'accountId']),
  email_bindings: Object.freeze(['_openid; accountId', 'accountId']),
  email_codes: Object.freeze([
    'accountId; emailBindingId; actorHash',
    'accountId; emailBindingId; scopeHash'
  ]),
  finance_anomalies: Object.freeze([
    'none direct; orderId',
    'none direct; owner inherited through orderId'
  ]),
  finance_reconciliation_runs: Object.freeze(['none', 'none']),
  financial_events: Object.freeze([
    'none direct; orderId',
    'none direct; owner inherited through orderId'
  ]),
  fulfill_failures: Object.freeze(['_openid', 'accountId']),
  halls: Object.freeze(['none', 'none']),
  match_joins: Object.freeze(['_openid', 'memberAccountId']),
  matches: Object.freeze(['_openid', 'ownerAccountId']),
  members: Object.freeze([
    '_openid/openid/memberOpenid; targetOpenid query input',
    'accountId; memberAccountId; targetAccountId'
  ]),
  orders: Object.freeze(['_openid; payerOpenid', 'accountId; payerOpenid']),
  password_rate_limits: Object.freeze([
    'none (new v2 collection)',
    'credentialBindingId; contextHash'
  ]),
  phone_bindings: Object.freeze(['none (new v2 collection)', 'accountId']),
  post_comments: Object.freeze(['_openid; authorOpenid', 'authorAccountId']),
  post_likes: Object.freeze(['_openid', 'accountId']),
  posts: Object.freeze(['_openid', 'authorAccountId']),
  sessions: Object.freeze([
    '_openid; shopId/openedBy; memberOpenid; coachOpenid',
    'ownerAccountId; shopAccountId/actorAccountId; memberAccountId; coachAccountId'
  ]),
  shop_applications: Object.freeze([
    '_openid; reviewedBy as admin OPENID',
    'applicantAccountId; admin principal id'
  ]),
  shop_coach_links: Object.freeze([
    'shopOpenid; coachOpenid',
    'shopAccountId; coachAccountId'
  ]),
  shop_orders: Object.freeze([
    '_openid; OPENID-derived shopId; payerOpenid',
    'ownerAccountId; shopAccountId; payerOpenid'
  ]),
  shop_payment_profiles: Object.freeze([
    '_id=shopId; shopId is shop OPENID-derived',
    '_id=shopAccountId; shopAccountId'
  ]),
  shop_refunds: Object.freeze(['shopId as owner OPENID', 'shopAccountId']),
  shops: Object.freeze(['_openid', 'ownerAccountId']),
  sms_codes: Object.freeze([
    '_openid; OPENID+phone-derived document id',
    'phoneBindingId; scopeHash'
  ]),
  sms_rate_limits: Object.freeze([
    'none (new v2 collection)',
    'phoneBindingId; contextHash'
  ]),
  stores: Object.freeze(['_openid', 'ownerAccountId or ownerType=system']),
  subscriptions: Object.freeze([
    '_openid; userId=wechat-binding document id; payerOpenid',
    'accountId; payerOpenid'
  ]),
  table_checkin_slots: Object.freeze(['memberOpenid', 'memberAccountId']),
  table_occupancies: Object.freeze(['OPENID-derived shopId', 'shopAccountId']),
  training_sessions: Object.freeze([
    '_openid; memberOpenid; OPENID-derived shopId',
    'ownerAccountId; memberAccountId; shopAccountId'
  ]),
  user_follows: Object.freeze([
    '_openid; authorOpenid',
    'followerAccountId; targetAccountId'
  ]),
  users: Object.freeze(['_id=wechat-binding id; _openid', '_id=accountId']),
  wechat_bill_artifacts: Object.freeze(['none direct', 'none direct']),
  wechat_bindings: Object.freeze([
    '_id=sha256(wechat:OPENID); _openid; accountId',
    '_id=HMAC(APPID,OPENID); accountId; appidHash/openidHash/unionidHash'
  ]),
  wx_access_token: Object.freeze([
    'none',
    'none; unused after reconcilePay retirement'
  ])
});
assert.strictEqual(collectionRows.length, 51, 'matrix must freeze 51 collection rows');
assert.deepStrictEqual(
  Object.keys(expectedCollectionIdentity).sort(inventoryCollator.compare),
  [...collectionNames].sort(inventoryCollator.compare),
  'exact collection identity fixture must cover every matrix collection'
);
for (const row of collectionRows) {
  assert.deepStrictEqual(
    [row.currentIdentityKey, row.v2IdentityKey],
    expectedCollectionIdentity[row.name],
    `collection:${row.name} old/new identity fields must match the frozen matrix`
  );
  if (
    row.currentIdentityKey.includes('_openid') &&
    row.name !== 'sms_codes' &&
    !/\badmin OPENID\b/i.test(row.v2IdentityKey)
  ) {
    assert(
      /\b(?:accountId|ownerAccountId|applicantAccountId|authorAccountId|followerAccountId|memberAccountId)\b/.test(row.v2IdentityKey),
      `collection:${row.name} must map _openid to an explicit account ownership field`
    );
  }
  for (const [oldField, newField] of Object.entries(fieldMappings)) {
    if (row.currentIdentityKey.includes(oldField)) {
      if (row.name === 'user_follows' && oldField === 'authorOpenid') {
        assert(
          row.v2IdentityKey.includes('targetAccountId'),
          'collection:user_follows must map legacy authorOpenid to targetAccountId'
        );
        continue;
      }
      if (row.name === 'coach_shop_applications' && oldField === 'reviewedBy') {
        assert(
          row.v2IdentityKey.includes('reviewerAccountId'),
          'collection:coach_shop_applications must map reviewedBy to the shop reviewer account'
        );
        continue;
      }
      assert(
        row.v2IdentityKey.includes(newField),
        `collection:${row.name} must map ${oldField} to ${newField}`
      );
    }
  }
  for (const requiredField of collectionSpecificV2Fields[row.name] || []) {
    assert(
      row.v2IdentityKey.includes(requiredField),
      `collection:${row.name} must use semantic v2 field ${requiredField}`
    );
  }
  if (row.v2IdentityKey.includes('payerOpenid')) {
    assert(
      row.foreignKeys.includes(payerOpenidAllowlist),
      `collection:${row.name} must explain retained payerOpenid`
    );
  }
  if (/\badmin OPENID\b/i.test(row.v2IdentityKey)) {
    assert(
      row.foreignKeys.includes('allowlist: admin OPENID remains an independent admin principal'),
      `collection:${row.name} must explain independent admin OPENID`
    );
  }
}
assert.deepStrictEqual(
  collectionRows
    .filter((row) => row.v2IdentityKey.includes('payerOpenid'))
    .map((row) => row.name)
    .sort(inventoryCollator.compare),
  ['orders', 'shop_orders', 'subscriptions'],
  'only the three frozen payment collections may retain payerOpenid'
);
for (const name of ['orders', 'shop_orders', 'subscriptions']) {
  const row = collectionRows.find((candidate) => candidate.name === name);
  assert(row.currentIdentityKey.includes('payerOpenid'), `collection:${name} must inventory legacy payerOpenid`);
  assert(
    row.foreignKeys.includes(payerOpenidAllowlist),
    `collection:${name} must freeze the complete payerOpenid authorization prohibition`
  );
}

const sourceCorpus = baseline.currentEntryPaths
  .map((relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8'))
  .join('\n');
const collectionIdentityInventory = collectionRows
  .map((row) => `${row.currentIdentityKey} ${row.v2IdentityKey}`)
  .join('\n');
for (const identityField of ['_openid', ...Object.keys(fieldMappings)]) {
  if (sourceCorpus.includes(identityField)) {
    assert(
      collectionIdentityInventory.includes(identityField),
      `matrix must inventory the discovered identity field ${identityField}`
    );
  }
}

const unclassifiedEntries = targetNames.filter((name) => !byName[name]);
const unclassifiedCollections = requiredCollections.filter((name) => !collectionNames.includes(name));
const unclassified = unclassifiedEntries.length + unclassifiedCollections.length;
assert.strictEqual(unclassified, 0, 'all entries and collections must be classified');

console.log([
  `CURRENT_ENTRY_TOTAL=${baseline.currentEntryPaths.length}`,
  `TARGET_POLICY_TOTAL=${policy.entries.length}`,
  `PLANNED_MISSING=${plannedEntries.length}`,
  `BASELINE_DIRECT_IDENTITY_ENTRIES=${baseline.directIdentityEntryPaths.length}`,
  `BASELINE_ALL_IDENTITY_JS=${baseline.allIdentityJsPaths.length}`,
  `PAYMENT_COPY_TOTAL=${baseline.paymentIdentityCopies.length}`,
  `UNCLASSIFIED=${unclassified}`
].join(' '));
