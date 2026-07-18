const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const secretScanExcludedDirectories = Object.freeze([
  '.git',
  '.agents',
  '.codex',
  '.worktrees',
  'node_modules',
  'artifacts'
]);
const secretScanBusinessDirectories = Object.freeze([
  'cloudfunctions',
  'miniprogram',
  'scripts',
  'docs',
  'tests'
]);

const cloudFunctions = Object.freeze([
  'saveShopStore',
  'createSession',
  'getSessions',
  'closeSession',
  'createTableOrder',
  'markTableOrderExternalPaid',
  'getTableCheckoutOrder',
  'genTableCheckoutCode',
  'createTablePayOrder',
  'tablePayNotifyV3',
  'reconcileTablePayments',
  'settleTableProfitSharing',
  'requestTableRefund',
  'tableRefundNotifyV3',
  'reconcileTableFinance',
  'getTodayRevenue',
  'getShopBizOverview'
]);

const timerContracts = Object.freeze({
  reconcileTablePayments: {
    name: 'reconcileTablePaymentsTimer',
    config: '0 */5 * * * * *'
  },
  settleTableProfitSharing: {
    name: 'settleTableProfitSharingTimer',
    config: '0 */5 * * * * *'
  },
  requestTableRefund: {
    name: 'reconcileTableRefundsTimer',
    config: '0 */5 * * * * *'
  },
  reconcileTableFinance: {
    name: 'reconcileTableFinanceTimer',
    config: '0 15 10 * * * *'
  }
});

const requiredEnvironmentVariables = Object.freeze([
  'WXPAY_V3_ENABLED',
  'WXPAY_SP_APPID',
  'WXPAY_SP_MCHID',
  'WXPAY_MERCHANT_SERIAL_NO',
  'WXPAY_MERCHANT_PRIVATE_KEY',
  'WXPAY_API_V3_KEY',
  'WXPAY_PLATFORM_CERTS_JSON',
  'WXPAY_TABLE_NOTIFY_URL',
  'WXPAY_TABLE_REFUND_NOTIFY_URL',
  'WXPAY_PLATFORM_RECEIVER_NAME',
  'WXPAY_ENCRYPTION_KEY_ID'
]);

const requiredCollections = Object.freeze([
  'accounts',
  'wechat_bindings',
  'users',
  'sessions',
  'table_occupancies',
  'stores',
  'shop_orders',
  'shop_payment_profiles',
  'financial_events',
  'shop_refunds',
  'wechat_bill_artifacts',
  'finance_reconciliation_runs',
  'finance_anomalies',
  'billing_policies'
]);

function full(relativePath) {
  return path.join(root, relativePath);
}

function read(relativePath) {
  return fs.readFileSync(full(relativePath), 'utf8');
}

function parseJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function walkFiles(directory, predicate, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (secretScanExcludedDirectories.includes(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) walkFiles(filename, predicate, files);
    else if (predicate(filename)) files.push(filename);
  }
  return files;
}

function secretScanFileKind(filename) {
  const basename = path.basename(filename);
  if (/\.(?:pem|key|crt|cer|p12|pfx)$/i.test(filename)) return 'credential file';
  if (
    /\.(?:c?js|mjs|ts|json|ps1|md|ya?ml|txt|wxml|wxss|css|html)$/i.test(filename)
    || /^\.env(?:\.|$)/i.test(basename)
  ) {
    return 'text';
  }
  return null;
}

function isSecretScanFile(filename) {
  return secretScanFileKind(filename) !== null;
}

function collectSecretScanFiles() {
  const files = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(root, entry.name))
    .filter(isSecretScanFile);
  for (const relativeDirectory of secretScanBusinessDirectories) {
    const directory = full(relativeDirectory);
    if (fs.existsSync(directory)) walkFiles(directory, isSecretScanFile, files);
  }
  return files.sort();
}

function isApprovedSecretPlaceholder(value) {
  const normalized = value.trim();
  return /^<[^<>\r\n]+>$/.test(normalized)
    || /^\$\{[^{}\r\n]+\}$/.test(normalized)
    || /^process\.env(?:\.[A-Za-z_][A-Za-z0-9_]*|\[['"][A-Za-z_][A-Za-z0-9_]*['"]\])$/.test(normalized)
    || /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)
    || /^\$env:[A-Za-z_][A-Za-z0-9_]*$/i.test(normalized)
    || /^%[A-Za-z_][A-Za-z0-9_]*%$/.test(normalized);
}

function isUnquotedColonSecret(value) {
  const normalized = value.trim();
  if (isApprovedSecretPlaceholder(normalized)) return false;
  if (/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\s*}?\s*$/.test(normalized)) {
    return false;
  }
  return /^[A-Za-z0-9+/=_-]{16,}$/.test(normalized);
}

function hasRealAssignedValue(source, variableName, filename = '') {
  const assignment = new RegExp(
    `(?:(['"])${variableName}\\1|${variableName})\\s*([=:])\\s*(?:"((?:\\\\.|[^"\\\\\\r\\n])*)"|'((?:\\\\.|[^'\\\\\\r\\n])*)'|([^\\r\\n,;]+))`,
    'g'
  );
  let match;
  while ((match = assignment.exec(source)) !== null) {
    const quotedValue = match[3] !== undefined || match[4] !== undefined;
    let value = match[3] !== undefined
      ? match[3]
      : (match[4] !== undefined ? match[4] : match[5]);
    if (match[3] !== undefined) {
      try {
        value = JSON.parse(`"${value}"`);
      } catch (_error) {
        // Invalid JSON string syntax is still treated as a non-placeholder value.
      }
    }
    const yamlConfiguration = /\.(?:ya?ml)$/i.test(filename);
    if (
      match[2] === ':'
      && !quotedValue
      && !yamlConfiguration
      && !isUnquotedColonSecret(value)
    ) continue;
    if (!isApprovedSecretPlaceholder(value)) return true;
  }
  return false;
}

function embeddedSecretKind(source, filename = '') {
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(source)) return 'a private key';
  if (/-----BEGIN [A-Z0-9 ]*CERTIFICATE-----/.test(source)) return 'a certificate';
  if (/\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}\b/.test(source)) {
    return 'a bearer credential';
  }
  for (const [variableName, kind] of [
    ['WXPAY_API_V3_KEY', 'an APIv3 key'],
    ['WXPAY_MERCHANT_PRIVATE_KEY', 'a merchant private key'],
    ['WXPAY_PLATFORM_CERTS_JSON', 'platform certificates']
  ]) {
    if (hasRealAssignedValue(source, variableName, filename)) return kind;
  }
  return null;
}

function inspectSecretScanFile(filename, readText) {
  if (secretScanFileKind(filename) === 'credential file') return 'a credential file';
  return embeddedSecretKind(readText(filename, 'utf8'), filename);
}

function assertAllBusinessJsonParses() {
  const jsonFiles = [
    full('project.config.json'),
    full('project.private.config.json'),
    ...walkFiles(full('cloudfunctions'), (filename) => filename.endsWith('.json')),
    ...walkFiles(full('miniprogram'), (filename) => filename.endsWith('.json'))
  ];
  for (const filename of jsonFiles) {
    JSON.parse(fs.readFileSync(filename, 'utf8'));
  }
}

function assertProductionArtifactsAndJson() {
  for (const name of cloudFunctions) {
    const directory = full(path.join('cloudfunctions', name));
    assert(fs.statSync(directory).isDirectory(), `${name} cloud function must exist.`);
    assert(fs.statSync(path.join(directory, 'index.js')).isFile(), `${name}/index.js must exist.`);
    const packageJson = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    assert.strictEqual(packageJson.main, 'index.js', `${name} package main must be index.js.`);
    assert(packageJson.dependencies && packageJson.dependencies['wx-server-sdk'], `${name} must declare wx-server-sdk.`);
  }

  const pageDirectory = full('miniprogram/pages/table-checkout');
  for (const extension of ['js', 'json', 'wxml', 'wxss']) {
    assert(fs.statSync(path.join(pageDirectory, `index.${extension}`)).isFile());
  }
  const app = parseJson('miniprogram/app.json');
  assert(app.pages.includes('pages/table-checkout/index'));
  for (const page of ['shop/hall-status', 'shop/biz-data']) {
    for (const extension of ['js', 'json', 'wxml', 'wxss']) {
      assert(fs.statSync(full(`miniprogram/pages/${page}/index.${extension}`)).isFile());
    }
  }

  const jsonFiles = [
    'miniprogram/app.json',
    'miniprogram/pages/table-checkout/index.json',
    ...cloudFunctions.map((name) => `cloudfunctions/${name}/package.json`),
    ...Object.keys(timerContracts).map((name) => `cloudfunctions/${name}/config.json`)
  ];
  for (const filename of jsonFiles) parseJson(filename);
}

function assertDeployedImportsStayInsideFunction() {
  for (const name of cloudFunctions) {
    const directory = full(path.join('cloudfunctions', name));
    const prefix = directory.toLowerCase() + path.sep;
    const scripts = walkFiles(directory, (filename) => filename.endsWith('.js'));
    for (const filename of scripts) {
      const source = fs.readFileSync(filename, 'utf8');
      const imports = source.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g);
      for (const match of imports) {
        const resolved = path.resolve(path.dirname(filename), match[1]);
        assert(
          (resolved.toLowerCase() + path.sep).startsWith(prefix),
          `${path.relative(root, filename)} imports outside its deployment directory: ${match[1]}`
        );
        assert(
          fs.existsSync(resolved) || fs.existsSync(`${resolved}.js`) || fs.existsSync(path.join(resolved, 'index.js')),
          `${path.relative(root, filename)} has an unresolved local import: ${match[1]}`
        );
      }
    }
  }
}

function assertCanonicalCopyGate() {
  const sync = read('scripts/sync-table-finance-libs.ps1');
  const parity = read('tests/cloudSharedParity.test.js');
  assert(sync.includes('$CopyAllowlist'));
  assert(sync.includes('This script does not accept destination or path arguments.'));
  assert(parity.includes('must byte-match'));
  for (const name of [
    'createTablePayOrder',
    'tablePayNotifyV3',
    'reconcileTablePayments',
    'settleTableProfitSharing',
    'requestTableRefund',
    'tableRefundNotifyV3',
    'reconcileTableFinance'
  ]) {
    assert(sync.includes(`cloudfunctions/${name}/lib/`), `${name} must be in the literal sync allowlist.`);
    assert(parity.includes(`cloudfunctions/${name}/lib/`), `${name} must be in the parity allowlist.`);
  }

  const adapter = read('cloudfunctions/_shared/wechatpay-v3/client.js');
  assert(adapter.includes('AI 参考官方 Java 翻译生成，非官方维护。'));
  assert(adapter.includes('上线前充分测试'));
}

function assertExactTimersAndRetiredTriggers() {
  for (const [name, expected] of Object.entries(timerContracts)) {
    const config = parseJson(`cloudfunctions/${name}/config.json`);
    assert.deepStrictEqual(config.triggers, [{
      name: expected.name,
      type: 'timer',
      config: expected.config
    }]);
  }

  for (const name of ['createRecurringDebit', 'reconcilePay']) {
    const config = parseJson(`cloudfunctions/${name}/config.json`);
    assert.deepStrictEqual(config.triggers || [], [], `${name} must have no active trigger.`);
    const source = read(`cloudfunctions/${name}/index.js`);
    assert(source.includes('PRODUCT_RETIRED'), `${name} must fail closed as retired.`);
  }
}

function assertNoEmbeddedSecrets() {
  const extensionFixtures = [
    ['pem', 'credential file'],
    ['key', 'credential file'],
    ['crt', 'credential file'],
    ['cer', 'credential file'],
    ['p12', 'credential file'],
    ['pfx', 'credential file']
  ];
  for (const [extension, expectedKind] of extensionFixtures) {
    const fixturePath = path.join('isolated-fixture', `credential.${extension}`);
    assert.strictEqual(isSecretScanFile(fixturePath), true, `.${extension} must be scanned.`);
    assert.strictEqual(
      secretScanFileKind(fixturePath),
      expectedKind,
      `.${extension} must use the correct scanner mode.`
    );
    for (const [contentKind, content] of [
      ['text', ['synthetic', 'text', 'content'].join('-')],
      ['binary', Buffer.from([0, 255, 1, 254])]
    ]) {
      let reads = 0;
      assert.strictEqual(
        inspectSecretScanFile(fixturePath, () => {
          reads += 1;
          return content;
        }),
        'a credential file',
        `.${extension} ${contentKind} content must be blocked by path.`
      );
      assert.strictEqual(reads, 0, `.${extension} ${contentKind} content must not be read.`);
    }
  }
  const sensitiveNames = {
    apiKey: ['WXPAY', 'API', 'V3', 'KEY'].join('_'),
    merchantPrivateKey: ['WXPAY', 'MERCHANT', 'PRIVATE', 'KEY'].join('_'),
    platformCertificates: ['WXPAY', 'PLATFORM', 'CERTS', 'JSON'].join('_')
  };
  const credentialMaterial = [
    'fixture',
    'nonproduction',
    'credential',
    'material',
    '0123456789'
  ].join('-');
  const pemHeader = (label) => ['-----', 'BEGIN ', label, '-----'].join('');
  const environmentAssignment = (name, value) => [name, '=', value].join('');
  const jsonAssignment = (name, value) => JSON.stringify({ [name]: value });
  const colonAssignment = (name, value, quote = '') => (
    [name, ': ', quote, value, quote].join('')
  );
  for (const filename of ['isolated-fixture.yml', 'isolated-fixture.yaml']) {
    assert.strictEqual(
      embeddedSecretKind(
        colonAssignment(sensitiveNames.apiKey, 'A'.repeat(32)),
        filename
      ),
      'an APIv3 key',
      `${filename} must treat a 32-character scalar as configuration.`
    );
  }
  const secretFixtures = [
    ['unquoted APIv3 environment value', environmentAssignment(sensitiveNames.apiKey, credentialMaterial), 'an APIv3 key'],
    ['quoted APIv3 JSON value', jsonAssignment(sensitiveNames.apiKey, credentialMaterial), 'an APIv3 key'],
    ['generic PEM private key', pemHeader('PRIVATE KEY'), 'a private key'],
    ['RSA PEM private key', pemHeader('RSA PRIVATE KEY'), 'a private key'],
    ['EC PEM private key', pemHeader('EC PRIVATE KEY'), 'a private key'],
    ['encrypted PEM private key', pemHeader('ENCRYPTED PRIVATE KEY'), 'a private key'],
    ['OpenSSH PEM private key', pemHeader('OPENSSH PRIVATE KEY'), 'a private key'],
    ['PEM certificate', pemHeader('CERTIFICATE'), 'a certificate'],
    ['merchant private-key environment value', environmentAssignment(sensitiveNames.merchantPrivateKey, credentialMaterial), 'a merchant private key'],
    ['merchant private-key JSON value', jsonAssignment(sensitiveNames.merchantPrivateKey, credentialMaterial), 'a merchant private key'],
    ['platform certificates environment value', environmentAssignment(sensitiveNames.platformCertificates, credentialMaterial), 'platform certificates'],
    [
      'platform certificates JSON value',
      jsonAssignment(
        sensitiveNames.platformCertificates,
        JSON.stringify({ serial: 'fixture-serial', data: credentialMaterial })
      ),
      'platform certificates'
    ],
    ['unquoted-key double-quoted APIv3 value', colonAssignment(sensitiveNames.apiKey, credentialMaterial, '"'), 'an APIv3 key'],
    ['unquoted-key single-quoted APIv3 value', colonAssignment(sensitiveNames.apiKey, credentialMaterial, "'"), 'an APIv3 key'],
    ['unquoted-key merchant private-key literal', colonAssignment(sensitiveNames.merchantPrivateKey, credentialMaterial, '"'), 'a merchant private key'],
    ['unquoted-key platform certificates literal', colonAssignment(sensitiveNames.platformCertificates, credentialMaterial, "'"), 'platform certificates'],
    ['unquoted-key long scalar APIv3 value', colonAssignment(sensitiveNames.apiKey, credentialMaterial), 'an APIv3 key']
  ];
  for (const [name, source, expectedKind] of secretFixtures) {
    assert.strictEqual(embeddedSecretKind(source), expectedKind, `${name} must be detected.`);
  }
  const safeColonFixtures = [
    [sensitiveNames.apiKey, 'apiV3Key', ','],
    [sensitiveNames.apiKey, 'config.apiV3Key', ','],
    [sensitiveNames.apiKey, 'string', ';'],
    [['"', sensitiveNames.apiKey, '"'].join(''), 'string', ';']
  ].map(([name, value, terminator]) => [name, ': ', value, terminator].join(''));
  safeColonFixtures.push(
    ['const { ', sensitiveNames.apiKey, ': apiV3Key } = environment;'].join(''),
    ['const { ', sensitiveNames.apiKey, ' } = environment;'].join('')
  );
  for (const source of safeColonFixtures) {
    for (const filename of ['isolated.js', 'isolated.cjs', 'isolated.mjs', 'isolated.ts']) {
      assert.strictEqual(
        embeddedSecretKind(source, filename),
        null,
        `${filename} code references and no-value colon syntax must remain allowed.`
      );
    }
  }
  for (const [filename, source, expectedKind] of [
    ['isolated.js', colonAssignment(sensitiveNames.apiKey, credentialMaterial, '"'), 'an APIv3 key'],
    ['isolated.cjs', colonAssignment(sensitiveNames.apiKey, credentialMaterial, "'"), 'an APIv3 key'],
    ['isolated.mjs', colonAssignment(sensitiveNames.merchantPrivateKey, credentialMaterial, '"'), 'a merchant private key'],
    ['isolated.ts', colonAssignment(sensitiveNames.platformCertificates, credentialMaterial, "'"), 'platform certificates']
  ]) {
    assert.strictEqual(
      embeddedSecretKind(source, filename),
      expectedKind,
      `${filename} string literals must be detected.`
    );
  }
  const placeholders = [
    '<set-in-environment>',
    ['${', sensitiveNames.apiKey, '}'].join(''),
    ['process', '.env.', sensitiveNames.apiKey].join(''),
    ['$', 'SOURCE_VAR'].join(''),
    ['$', 'env:', 'SOURCE_VAR'].join(''),
    ['%', 'SOURCE_VAR', '%'].join('')
  ];
  for (const sensitiveName of Object.values(sensitiveNames)) {
    for (const placeholder of placeholders) {
      assert.strictEqual(
        embeddedSecretKind(environmentAssignment(sensitiveName, placeholder)),
        null,
        'An exact environment placeholder must be allowed.'
      );
      assert.strictEqual(
        embeddedSecretKind(jsonAssignment(sensitiveName, placeholder)),
        null,
        'An exact JSON placeholder must be allowed.'
      );
      assert.notStrictEqual(
        embeddedSecretKind(environmentAssignment(
          sensitiveName,
          [placeholder, credentialMaterial].join('')
        )),
        null,
        'A placeholder with appended material must be detected.'
      );
      assert.strictEqual(
        embeddedSecretKind(
          colonAssignment(sensitiveName, placeholder),
          'isolated-fixture.yml'
        ),
        null,
        'An exact YAML placeholder must be allowed.'
      );
      assert.notStrictEqual(
        embeddedSecretKind(
          colonAssignment(sensitiveName, [placeholder, credentialMaterial].join('')),
          'isolated-fixture.yml'
        ),
        null,
        'A YAML placeholder with appended material must be detected.'
      );
    }
  }
  const files = collectSecretScanFiles();
  const scannedPaths = files.map((filename) => path.relative(root, filename).replace(/\\/g, '/'));
  assert(scannedPaths.includes('project.config.json'), 'Secret scan must include root configuration.');
  assert(
    scannedPaths.some((filename) => (
      filename.startsWith('docs/') && filename !== 'docs/table-commission-deployment.md'
    )),
    'Secret scan must include docs beyond the deployment guide.'
  );
  assert(
    scannedPaths.includes('tests/tablePaymentDeployment.test.js'),
    'Secret scan must include its dynamically constructed fixture source.'
  );
  for (const excluded of ['.git', '.agents', '.codex', '.worktrees', 'node_modules', 'artifacts']) {
    assert(
      !scannedPaths.some((filename) => filename.split('/').includes(excluded)),
      `Secret scan must exclude ${excluded}.`
    );
  }
  const jsonFixture = JSON.stringify({
    ['WXPAY_' + 'API_V3_KEY']: ['fixture', 'only', 'not', 'a', 'credential'].join('-')
  });
  assert.strictEqual(
    embeddedSecretKind(jsonFixture),
    'an APIv3 key',
    'JSON APIv3-key assignments must be detected.'
  );
  assert.strictEqual(
    embeddedSecretKind(JSON.stringify({ ['WXPAY_' + 'API_V3_KEY']: '<set-in-environment>' })),
    null,
    'Documented environment placeholders must remain allowed.'
  );
  for (const filename of files) {
    const secretKind = inspectSecretScanFile(filename, fs.readFileSync);
    assert(!secretKind, `${path.relative(root, filename)} embeds ${secretKind}.`);
  }
}

function assertClientAndCallbackBoundaries() {
  const data = read('miniprogram/services/data.js');
  const checkout = read('miniprogram/pages/table-checkout/index.js');
  const hall = read('miniprogram/pages/shop/hall-status/index.js');
  const client = `${data}\n${checkout}\n${hall}`;
  assert(!client.includes("collection('financial_events')"));
  assert(!client.includes("collection('shop_refunds')"));
  assert(!/paymentStatus\s*:\s*['"]paid['"]/.test(checkout));
  assert(!/createTableOrder\(\s*\{[^}]*\b(?:amount|price|storeId|tableId|payerOpenid|subMchid)\b/s.test(hall));

  for (const name of ['tablePayNotifyV3', 'tableRefundNotifyV3']) {
    const callback = read(`cloudfunctions/${name}/index.js`);
    assert(callback.includes('extractWechatPayEvent'));
    assert(callback.includes('rawBody'));
    assert(callback.includes('verifyWechatPaySignature'));
    const httpEvent = read(`cloudfunctions/${name}/lib/wechatpay-v3/http-event.js`);
    for (const header of [
      'wechatpay-timestamp',
      'wechatpay-nonce',
      'wechatpay-serial',
      'wechatpay-signature'
    ]) {
      assert(httpEvent.includes(header), `${name} must preserve ${header}.`);
    }
  }
}

function assertOperatorDocumentation() {
  const deployment = read('docs/table-commission-deployment.md');
  const legacyReportingQueries = [
    {
      name: 'getTodayRevenue',
      source: read('cloudfunctions/getTodayRevenue/index.js'),
      pattern: /fetchAll\(\{\s*_openid:\s*OPENID,\s*date:\s*today\.key\s*\}\)/
    },
    {
      name: 'getShopBizOverview',
      source: read('cloudfunctions/getShopBizOverview/index.js'),
      pattern: /fetchAll\(\s*['"]shop_orders['"],\s*\{\s*_openid:\s*OPENID,\s*date:\s*dateRange\s*\}\s*\)/
    }
  ];
  for (const query of legacyReportingQueries) {
    assert(query.pattern.test(query.source), `${query.name} legacy reporting query changed.`);
    assert(!query.source.includes('.orderBy('), `${query.name} unexpectedly sorts legacy orders.`);
  }
  const legacyReportingIndex = deployment.split(/\r?\n/).find((line) => (
    line.includes('getTodayRevenue')
      && line.includes('getShopBizOverview')
      && line.includes('_openid')
  ));
  assert(legacyReportingIndex, 'Legacy reporting composite index must document both queries.');
  assert(legacyReportingIndex.includes('_openid ASC, date ASC'));
  assert(legacyReportingIndex.includes('orderBy'));
  for (const token of requiredEnvironmentVariables) assert(deployment.includes(token), `Missing ${token} documentation.`);
  for (const token of requiredCollections) assert(deployment.includes(`\`${token}\``), `Missing ${token} collection documentation.`);
  for (const expected of Object.values(timerContracts)) {
    assert(deployment.includes(`\`${expected.name}\``));
    assert(deployment.includes(`\`${expected.config}\``));
  }
  for (const token of [
    '普通服务商',
    '特约商户',
    '分账授权',
    'SERVICE_PROVIDER',
    'HTTPS',
    'Wechatpay-Timestamp',
    'Wechatpay-Nonce',
    'Wechatpay-Serial',
    'Wechatpay-Signature',
    'finance/bills/{date}/{subMchid}/trade.csv',
    'finance/bills/**',
    'storageVisibility',
    '最小权限',
    '回滚',
    '5%',
    'T+1',
    '真实小额支付',
    '真实资金验收'
  ]) {
    assert(deployment.includes(token), `Deployment guide must document ${token}.`);
  }
  assert(/finance\/bills\/\*\*[^\n]*客户端读取拒绝[^\n]*客户端写入拒绝/.test(deployment));
  assert(/shop_payment_profiles[^\n]*paymentEnabled[^\n]*profitSharingEnabled[^\n]*tradeBillModeVerified/.test(deployment));
  assert(/shop_payment_profiles[^\n]*subMchid ASC[^\n]*唯一/.test(deployment));
  assert(deployment.includes('历史订单的缺失/空值不能用于唯一索引'));
  assert(deployment.includes('启用支付档案总数不得超过 100'));
  assert(deployment.includes('每个 `subMchid` 每个北京时间自然日的订单数和退款数分别不得超过 100'));
  assert(deployment.includes('超过任一门槛前必须先上线游标分页'));
  assert(/shop_orders` token[^\n]*checkoutTokenHash ASC[^\n]*普通/.test(deployment));
  assert(/shop_orders` 商户支付单号[^\n]*outTradeNo ASC[^\n]*普通/.test(deployment));
  assert(!/shop_orders` (?:token|商户支付单号)[^\n]*\| 唯一/.test(deployment));
  assert(/schemaVersion ASC[^\n]*orderStatus ASC[^\n]*paymentStatus ASC[^\n]*paymentBillFeeEvidence ASC[^\n]*paymentBillDiscoveryCompletedAt ASC[^\n]*paidAt ASC[^\n]*_id ASC/.test(deployment));
  assert(/checkoutTokenHash[^\n]*outTradeNo[^\n]*wechatTransactionId/.test(deployment));
  assert(/schemaVersion[^\n]*orderStatus[^\n]*checkoutAt/.test(deployment));
  assert(/subMchid[^\n]*paymentStatus[^\n]*splitStatus[^\n]*paidAt/.test(deployment));
  assert(/orderId[^\n]*status[^\n]*refundNo/.test(deployment));
  assert(/orderId[^\n]*eventType[^\n]*createdAt/.test(deployment));
  assert(/status[^\n]*billDate[^\n]*severity/.test(deployment));
  assert(/shopId[^\n]*storeId[^\n]*status/.test(deployment));

  const readme = read('README.md');
  assert(readme.includes('docs/table-commission-deployment.md'));
  assert(readme.includes('按桌抽成'));
  assert(readme.includes('真实资金'));
  assert(readme.includes('连续订阅创建与扣费已退役'));

  const recurringArchive = read('docs/shop-recurring-subscription-setup.md');
  assert(recurringArchive.startsWith('# 历史归档'));
  assert(recurringArchive.includes('PRODUCT_RETIRED'));
  assert(recurringArchive.includes('禁止部署'));
}

function main() {
  assertAllBusinessJsonParses();
  assertProductionArtifactsAndJson();
  assertDeployedImportsStayInsideFunction();
  assertCanonicalCopyGate();
  assertExactTimersAndRetiredTriggers();
  assertNoEmbeddedSecrets();
  assertClientAndCallbackBoundaries();
  assertOperatorDocumentation();
  console.log('table payment deployment contract ok');
}

main();
