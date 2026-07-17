const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const policyPath = 'scripts/auth-v2-entry-policy.json';
const syncScriptPath = path.join(root, 'scripts', 'sync-auth-libs.ps1');
const expectedProtocolPathSha256 =
  '51587fc66044ea26fb233c78f319d0ad18f563c0a4d47aaac485e3e5207cf56c';

function gitOutput(args, encoding) {
  const result = childProcess.spawnSync('git', args, {
    cwd: root,
    encoding: encoding || 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024
  });
  assert.strictEqual(
    result.status,
    0,
    `git ${args.join(' ')} failed:\n${result.stderr || ''}${result.stdout || ''}`
  );
  return result.stdout;
}

function committedPolicy() {
  return JSON.parse(gitOutput(['show', `HEAD:${policyPath}`], 'utf8'));
}

function workingPolicy() {
  return JSON.parse(read(policyPath));
}

function protocolCli() {
  const result = childProcess.spawnSync(
    process.execPath,
    [path.join(root, 'tests', 'authMigrationMatrix.test.js'), '--print-protocol-client-paths'],
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
    `protocol path CLI failed:\n${result.stderr}${result.stdout}`
  );
  const lines = result.stdout.trim().split(/\r?\n/);
  const countLine = lines.at(-2);
  const shaLine = lines.at(-1);
  const paths = lines.slice(0, -2);
  assert.strictEqual(countLine, 'PROTOCOL_CLIENT_COUNT=97');
  assert.strictEqual(
    shaLine,
    `PROTOCOL_CLIENT_SHA256=${expectedProtocolPathSha256}`
  );
  return paths;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function cachedIndexSnapshot() {
  const names = gitOutput(['diff', '--cached', '--name-only', '-z'], null);
  return {
    count: names.toString('utf8').split('\0').filter(Boolean).length,
    sha256: sha256(names)
  };
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function discoverAuthCopies(moduleName) {
  const copies = [];
  const cloudfunctions = path.join(root, 'cloudfunctions');
  for (const item of fs.readdirSync(cloudfunctions, { withFileTypes: true })) {
    if (!item.isDirectory() || item.isSymbolicLink()) continue;
    const relativePath =
      `cloudfunctions/${item.name}/lib/auth/${moduleName}.js`;
    if (fs.existsSync(path.join(root, relativePath))) copies.push(relativePath);
  }
  return copies.sort();
}

function pathSnapshot(paths) {
  return paths.map((relativePath) => {
    const absolutePath = path.join(root, relativePath);
    if (!fs.existsSync(absolutePath)) return `${relativePath}\0missing`;
    const bytes = fs.readFileSync(absolutePath);
    return `${relativePath}\0${bytes.length}\0${sha256(bytes)}`;
  });
}

function writeFixtureFile(fixtureRoot, relativePath, contents) {
  const absolutePath = path.join(fixtureRoot, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents);
}

function runFixtureGit(fixtureRoot, args) {
  const result = childProcess.spawnSync('git', args, {
    cwd: fixtureRoot,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024
  });
  assert.strictEqual(
    result.status,
    0,
    `fixture git ${args.join(' ')} failed:\n${result.stderr}${result.stdout}`
  );
}

function createSyncFixture(label, policy, options) {
  const settings = options || {};
  const fixtureRoot = path.join(
    os.tmpdir(),
    `cuetrace-auth-sync-${label}-${process.pid}-${Date.now()}-${crypto
      .randomBytes(4)
      .toString('hex')}`
  );
  fs.mkdirSync(fixtureRoot, { recursive: true });
  writeFixtureFile(
    fixtureRoot,
    'scripts/sync-auth-libs.ps1',
    fs.readFileSync(syncScriptPath)
  );
  writeFixtureFile(
    fixtureRoot,
    policyPath,
    `${JSON.stringify(policy, null, 2)}\n`
  );
  if (settings.writeSource !== false) {
    writeFixtureFile(
      fixtureRoot,
      policy.modules['protocol-guard'].source,
      "'use strict';\nmodule.exports = {};\n"
    );
  }
  runFixtureGit(fixtureRoot, ['init', '-q']);
  runFixtureGit(fixtureRoot, ['add', policyPath]);
  runFixtureGit(fixtureRoot, [
    '-c',
    'user.name=Codex Fixture',
    '-c',
    'user.email=codex-fixture@example.invalid',
    'commit',
    '-q',
    '-m',
    'fixture policy'
  ]);
  return fixtureRoot;
}

function runFixtureSync(fixtureRoot, options) {
  const settings = options || {};
  return childProcess.spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(fixtureRoot, 'scripts', 'sync-auth-libs.ps1'),
      '-Modules',
      'protocol-guard'
    ],
    {
      cwd: fixtureRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...(settings.env || {})
      },
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024
    }
  );
}

function minimalSyncPolicy(
  destination,
  source = 'cloudfunctions/_shared/auth/protocol-guard.js'
) {
  return {
    schemaVersion: 1,
    modules: {
      'protocol-guard': {
        source,
        availableFromTask: 2
      }
    },
    entries: [{
      name: 'fixtureEntry',
      copies: [{
        module: 'protocol-guard',
        destination
      }]
    }]
  };
}

function workingTreeFileSnapshot(fixtureRoot) {
  const files = [];
  function visit(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (directory === fixtureRoot && item.name === '.git') continue;
      const absolutePath = path.join(directory, item.name);
      if (item.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      const relativePath = path
        .relative(fixtureRoot, absolutePath)
        .split(path.sep)
        .join('/');
      const bytes = fs.readFileSync(absolutePath);
      files.push(`${relativePath}\0${bytes.length}\0${sha256(bytes)}`);
    }
  }
  visit(fixtureRoot);
  return files.sort();
}

function assertAtomicSyncRollback() {
  const source = 'cloudfunctions/_shared/auth/protocol-guard.js';
  const destinations = [
    'cloudfunctions/fixtureOne/lib/auth/protocol-guard.js',
    'cloudfunctions/fixtureTwo/lib/auth/protocol-guard.js',
    'cloudfunctions/fixtureThree/lib/auth/protocol-guard.js'
  ];
  const policy = {
    schemaVersion: 1,
    modules: {
      'protocol-guard': {
        source,
        availableFromTask: 2
      }
    },
    entries: destinations.map((destination, index) => ({
      name: `fixture${index + 1}`,
      copies: [{
        module: 'protocol-guard',
        destination
      }]
    }))
  };
  const fixtureRoot = createSyncFixture('atomic-rollback', policy);
  writeFixtureFile(fixtureRoot, destinations[0], 'original-one\n');
  fs.mkdirSync(path.dirname(path.join(fixtureRoot, destinations[1])), {
    recursive: true
  });
  writeFixtureFile(fixtureRoot, destinations[2], 'original-three\n');

  const before = workingTreeFileSnapshot(fixtureRoot);
  const failed = runFixtureSync(fixtureRoot, {
    env: {
      AUTH_SYNC_TEST_FAIL_BEFORE_REPLACE_INDEX: '3'
    }
  });
  assert.notStrictEqual(
    failed.status,
    0,
    'an injected later replacement failure must fail the sync'
  );
  assert.match(
    `${failed.stderr}${failed.stdout}`,
    /injected auth sync commit failure/i
  );
  assert.deepStrictEqual(
    workingTreeFileSnapshot(fixtureRoot),
    before,
    'a failed sync must restore every target byte and leave no transaction files'
  );
}

function assertDynamicSyncSafety() {
  const escapeName = `escaped-${process.pid}-${Date.now()}.js`;
  const escapeRoot = createSyncFixture(
    'escape',
    minimalSyncPolicy(`../${escapeName}`)
  );
  const escapedPath = path.resolve(escapeRoot, '..', escapeName);
  assert(!fs.existsSync(escapedPath));
  const escaped = runFixtureSync(escapeRoot);
  assert.notStrictEqual(escaped.status, 0, 'policy path escape must fail');
  assert.match(`${escaped.stderr}${escaped.stdout}`, /unsafe committed auth policy path/i);
  assert(!fs.existsSync(escapedPath), 'path escape wrote outside the fixture repository');

  const reparseRoot = createSyncFixture(
    'reparse',
    minimalSyncPolicy(
      'cloudfunctions/fixtureEntry/lib/auth/protocol-guard.js'
    )
  );
  const outside = path.join(
    os.tmpdir(),
    `cuetrace-auth-sync-outside-${process.pid}-${Date.now()}-${crypto
      .randomBytes(4)
      .toString('hex')}`
  );
  fs.mkdirSync(outside, { recursive: true });
  const entryRoot = path.join(reparseRoot, 'cloudfunctions', 'fixtureEntry');
  fs.mkdirSync(entryRoot, { recursive: true });
  fs.symlinkSync(outside, path.join(entryRoot, 'lib'), 'junction');
  const escapedCopy = path.join(outside, 'auth', 'protocol-guard.js');
  assert(!fs.existsSync(escapedCopy));
  const reparse = runFixtureSync(reparseRoot);
  assert.notStrictEqual(reparse.status, 0, 'destination reparse point must fail');
  assert.match(`${reparse.stderr}${reparse.stdout}`, /reparse point/i);
  assert(!fs.existsSync(escapedCopy), 'reparse destination received a copied guard');

  const sourceReparseRoot = createSyncFixture(
    'source-reparse',
    minimalSyncPolicy(
      'cloudfunctions/fixtureEntry/lib/auth/protocol-guard.js',
      'cloudfunctions/_shared/auth-link/protocol-guard.js'
    ),
    { writeSource: false }
  );
  const sourceOutside = path.join(
    os.tmpdir(),
    `cuetrace-auth-sync-source-${process.pid}-${Date.now()}-${crypto
      .randomBytes(4)
      .toString('hex')}`
  );
  writeFixtureFile(
    sourceOutside,
    'protocol-guard.js',
    "'use strict';\nmodule.exports = {};\n"
  );
  fs.mkdirSync(path.join(sourceReparseRoot, 'cloudfunctions', '_shared'), {
    recursive: true
  });
  fs.symlinkSync(
    sourceOutside,
    path.join(sourceReparseRoot, 'cloudfunctions', '_shared', 'auth-link'),
    'junction'
  );
  const sourceDestination = path.join(
    sourceReparseRoot,
    'cloudfunctions',
    'fixtureEntry',
    'lib',
    'auth',
    'protocol-guard.js'
  );
  assert(!fs.existsSync(sourceDestination));
  const sourceReparse = runFixtureSync(sourceReparseRoot);
  assert.notStrictEqual(sourceReparse.status, 0, 'source reparse point must fail');
  assert.match(`${sourceReparse.stderr}${sourceReparse.stdout}`, /reparse point/i);
  assert(!fs.existsSync(sourceDestination), 'source reparse fixture wrote a destination');
}

const clientWrapperPattern = /const protocolGuardedMain = exports\.main;\s*exports\.main = async \(event = \{\}, \.\.\.args\) => \{\s*const gate = await guardClientRequest\(\{\s*db,\s*event,\s*supportedSchemaVersions: \[(1|2)\]\s*\}\);\s*if \(!gate\.ok\) return gate;\s*let businessEvent = event;\s*if \(\s*Object\.prototype\.hasOwnProperty\.call\(\s*event,\s*'authProtocol'\s*\)\s*\) \{\s*businessEvent = \{ \.\.\.event \};\s*delete businessEvent\.authProtocol;\s*\}\s*return protocolGuardedMain\(\s*businessEvent,\s*\.\.\.args\s*\);\s*\};\s*$/;
const schemaTwoClientEntries = new Set([
  'accountAuth',
  'login',
  'sendSmsCode',
  'verifySmsCode'
]);

function assertClientEntry(entry, source, canonicalBytes) {
  const relativePath = `cloudfunctions/${entry.name}/index.js`;
  assert(
    source.includes(
      "const { guardClientRequest } = require('./lib/auth/protocol-guard');"
    ),
    `${relativePath} must require its local protocol guard`
  );
  assert(
    clientWrapperPattern.test(source),
    `${relativePath} must guard the exported client handler before legacy behavior`
  );
  const wrapper = source.match(clientWrapperPattern);
  assert(wrapper, relativePath + ' must match the guard wrapper');
  assert.strictEqual(
    Number(wrapper[1]),
    schemaTwoClientEntries.has(entry.name) ? 2 : 1,
    relativePath + ' has the wrong supported schema version'
  );
  assert(
    /\b(?:const|let|var)\s+db\s*=/.test(source),
    `${relativePath} must provide the guard database`
  );
  assert.strictEqual(
    (source.match(/\bguardClientRequest\b/g) || []).length,
    2,
    `${relativePath} must import and call guardClientRequest exactly once`
  );
  assert(
    !/\bevent\s*\.\s*authProtocol\b/.test(source),
    `${relativePath} must leave protocol interpretation to the local guard`
  );

  const copy = entry.copies.find((candidate) => candidate.module === 'protocol-guard');
  assert(copy, `${entry.name} must have an explicit protocol-guard copy`);
  const absoluteCopy = path.join(root, copy.destination);
  assert(fs.existsSync(absoluteCopy), `missing ${copy.destination}`);
  assert(!fs.lstatSync(absoluteCopy).isSymbolicLink(), `${copy.destination} is a symlink`);
  assert(
    fs.readFileSync(absoluteCopy).equals(canonicalBytes),
    `${copy.destination} differs from the shared protocol guard`
  );
}

function assertNoneEntry(entry) {
  const relativePath = `cloudfunctions/${entry.name}/index.js`;
  const absolutePath = path.join(root, relativePath);
  if (entry.planned) {
    assert(!fs.existsSync(absolutePath), `${relativePath} must remain planned`);
    return;
  }
  const source = fs.readFileSync(absolutePath, 'utf8');
  assert(!/\bauthProtocol\b/.test(source), `${relativePath} must not accept authProtocol`);
  assert(!/\bguardClientRequest\b/.test(source), `${relativePath} must not call the client guard`);
  assert(
    !/protocol-guard/.test(source),
    `${relativePath} must not deploy or load the client guard`
  );
}

async function assertRefundBranch(entry, source, canonicalBytes) {
  const relativePath = 'cloudfunctions/requestTableRefund/index.js';
  assert.strictEqual(entry.protocolGuard, 'branch');
  assert(
    source.includes(
      "const { guardClientRequest } = require('./lib/auth/protocol-guard');"
    ),
    `${relativePath} must require its local guard`
  );
  assert(
    /function isTrustedRefundTimer\(event, context\)/.test(source),
    `${relativePath} must expose a pure trusted-timer classifier`
  );
  const mainStart = source.indexOf('exports.main = async (event = {}) => {');
  const timerBranch = source.indexOf(
    'if (!isTrustedRefundTimer(event, context)) {',
    mainStart
  );
  const guardCall = source.indexOf('const gate = await guardClientRequest({', timerBranch);
  const legacyCall = source.indexOf(
    'return getProductionHandler()(businessEvent);',
    guardCall
  );
  assert(mainStart >= 0, `${relativePath} must use an async client/timer entry wrapper`);
  assert(timerBranch > mainStart, `${relativePath} must classify the timer before guarding`);
  assert(guardCall > timerBranch, `${relativePath} must guard only the user branch`);
  assert(legacyCall > guardCall, `${relativePath} must guard before business handler creation`);
  assert(
    source.slice(timerBranch, legacyCall).includes('supportedSchemaVersions: [1]'),
    `${relativePath} user branch must support only schema 1`
  );
  assert(
    source.slice(timerBranch, legacyCall).includes('delete candidate.authProtocol;')
      && source.slice(timerBranch, legacyCall).includes(
        "if (exactRefundTimer(candidate)) return result('INVALID_ARGUMENT', false);"
      )
      && source.slice(timerBranch, legacyCall).includes('businessEvent = candidate;'),
    `${relativePath} must keep protocol metadata out of legacy business validation`
  );
  assert(
    !/\bevent\s*\.\s*authProtocol\b/.test(source),
    `${relativePath} must leave protocol interpretation to the guard`
  );

  const copy = entry.copies.find((candidate) => candidate.module === 'protocol-guard');
  assert(copy, 'requestTableRefund needs an explicit local guard copy');
  assert(
    fs.readFileSync(path.join(root, copy.destination)).equals(canonicalBytes),
    `${copy.destination} differs from the shared protocol guard`
  );

  const modulePath = path.join(root, relativePath);
  delete require.cache[require.resolve(modulePath)];
  const refundModule = require(modulePath);
  assert.strictEqual(typeof refundModule.isTrustedRefundTimer, 'function');
  assert.strictEqual(
    refundModule.isTrustedRefundTimer(
      { Type: 'Timer', TriggerName: 'reconcileTableRefundsTimer' },
      {}
    ),
    true
  );
  assert.strictEqual(
    refundModule.isTrustedRefundTimer(
      { Type: 'Timer', TriggerName: 'reconcileTableRefundsTimer' },
      { OPENID: '' }
    ),
    true
  );
  for (const [event, context] of [
    [{ Type: 'Timer', TriggerName: 'reconcileTableRefundsTimer' }, { OPENID: 'caller' }],
    [{ Type: 'Timer', TriggerName: 'other' }, {}],
    [{ Type: 'Timer', TriggerName: 'reconcileTableRefundsTimer', authProtocol: 1 }, {}],
    [{ TriggerName: 'reconcileTableRefundsTimer' }, {}],
    [null, {}],
    [{ Type: 'Timer', TriggerName: 'reconcileTableRefundsTimer' }, null]
  ]) {
    assert.strictEqual(
      refundModule.isTrustedRefundTimer(event, context),
      false,
      `unexpected trusted refund timer: ${JSON.stringify({ event, context })}`
    );
  }

  let databaseCalls = 0;
  const fakeCloud = {
    DYNAMIC_CURRENT_ENV: 'DYNAMIC_CURRENT_ENV',
    init() {},
    database() {
      databaseCalls += 1;
      return {
        collection(name) {
          assert.strictEqual(name, 'auth_control');
          return {
            doc(id) {
              assert.strictEqual(id, 'main');
              return {
                async get() {
                  return {
                    data: {
                      _id: 'main',
                      maintenance: false,
                      schemaVersion: 1,
                      minClientProtocol: 1
                    }
                  };
                }
              };
            }
          };
        }
      };
    },
    getWXContext() {
      return {};
    }
  };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'wx-server-sdk') return fakeCloud;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(modulePath)];
    const protocolAwareRefund = require(modulePath);
    const pseudoTimer = await protocolAwareRefund.main({
      Type: 'Timer',
      TriggerName: 'reconcileTableRefundsTimer',
      authProtocol: 1
    });
    assert.deepStrictEqual(pseudoTimer, {
      ok: false,
      code: 'INVALID_ARGUMENT',
      retryable: false
    });
    assert.strictEqual(
      databaseCalls,
      1,
      'protocol-bearing pseudo timer must read only auth_control'
    );
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(modulePath)];
  }
}

async function main() {
  const committed = committedPolicy();
  const policy = workingPolicy();
  const paths = protocolCli();
  const expectedPaths = committed.entries
    .filter((entry) => entry.protocolGuard !== 'none')
    .map((entry) => `cloudfunctions/${entry.name}/index.js`)
    .sort();
  assert.deepStrictEqual(paths, expectedPaths);
  assert.strictEqual(
    sha256(Buffer.from(paths.join('\n'))),
    expectedProtocolPathSha256
  );

  assert(fs.existsSync(syncScriptPath), 'missing scripts/sync-auth-libs.ps1');
  const syncScript = fs.readFileSync(syncScriptPath, 'utf8');
  const copyIndex = syncScript.indexOf('Copy-Item');
  assert(copyIndex > 0, 'sync script must perform explicit copies');
  const beforeCopy = syncScript.slice(0, copyIndex);
  assert(
    /git[\s\S]*show[\s\S]*HEAD:scripts\/auth-v2-entry-policy\.json/i.test(beforeCopy),
    'sync script must read the committed policy through git show'
  );
  assert(
    /ReparsePoint/.test(beforeCopy),
    'sync script must reject reparse points before copying'
  );
  assert(
    /Assert-SafeRepositoryPath/.test(beforeCopy),
    'sync script must validate source and destination containment'
  );
  assert(
    beforeCopy.includes('$ValidatedCopyPlan')
      && /foreach \(\$Copy in \$ValidatedCopyPlan\)/.test(syncScript),
    'sync script must validate the complete copy plan before writing'
  );
  assert(
    !/\bGet-ChildItem\b/.test(syncScript),
    'sync script must not infer copy destinations by directory scanning'
  );
  assert(
    !/Copy-Item[^\r\n]*[*?]/.test(syncScript),
    'sync script must not use wildcard copies'
  );

  const beforeUnknownModule = cachedIndexSnapshot();
  const allCopyDestinations = policy.entries.flatMap((entry) => (
    entry.copies.map((copy) => copy.destination)
  ));
  const beforeUnknownDestinations = pathSnapshot(allCopyDestinations);
  const unknownModule = childProcess.spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      syncScriptPath,
      '-Modules',
      'not-a-policy-module'
    ],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024
    }
  );
  assert.notStrictEqual(unknownModule.status, 0, 'unknown auth modules must be rejected');
  assert.match(
    `${unknownModule.stderr}${unknownModule.stdout}`,
    /unknown|policy module/i
  );
  assert.deepStrictEqual(cachedIndexSnapshot(), beforeUnknownModule);
  assert.deepStrictEqual(
    pathSnapshot(allCopyDestinations),
    beforeUnknownDestinations
  );

  const missingSourceRoot = createSyncFixture(
    'missing-source',
    minimalSyncPolicy(
      'cloudfunctions/fixtureEntry/lib/auth/protocol-guard.js'
    ),
    { writeSource: false }
  );
  const beforeMissingSource = workingTreeFileSnapshot(missingSourceRoot);
  const missingSource = runFixtureSync(missingSourceRoot);
  assert.notStrictEqual(missingSource.status, 0, 'missing known module sources must fail');
  assert.match(`${missingSource.stderr}${missingSource.stdout}`, /missing auth library path/i);
  assert.deepStrictEqual(
    workingTreeFileSnapshot(missingSourceRoot),
    beforeMissingSource
  );
  assertDynamicSyncSafety();
  assertAtomicSyncRollback();

  const canonicalPath = policy.modules['protocol-guard'].source;
  const canonicalAbsolute = path.join(root, canonicalPath);
  assert(fs.existsSync(canonicalAbsolute), `missing ${canonicalPath}`);
  const canonicalBytes = fs.readFileSync(canonicalAbsolute);
  const protocolEntries = policy.entries.filter(
    (entry) => entry.protocolGuard !== 'none'
  );
  assert.strictEqual(protocolEntries.length, 97);
  const expectedCopies = protocolEntries
    .map((entry) => {
      const copies = entry.copies.filter((copy) => copy.module === 'protocol-guard');
      assert.strictEqual(copies.length, 1, `${entry.name} must have one guard copy`);
      return copies[0].destination;
    })
    .sort();
  assert.deepStrictEqual(discoverAuthCopies('protocol-guard'), expectedCopies);

  for (const entry of policy.entries) {
    if (entry.protocolGuard === 'none') {
      assertNoneEntry(entry);
      continue;
    }
    const source = read(`cloudfunctions/${entry.name}/index.js`);
    if (entry.protocolGuard === 'branch') {
      await assertRefundBranch(entry, source, canonicalBytes);
    } else {
      assertClientEntry(entry, source, canonicalBytes);
    }
  }

  const task3And4CopyCounts = {
    keyring: 76,
    identifiers: 2,
    password: 1,
    session: 76,
    sms: 2
  };
  for (const [moduleName, expectedCount] of Object.entries(task3And4CopyCounts)) {
    const definition = policy.modules[moduleName];
    assert(definition, `policy must define ${moduleName}`);
    const canonicalModulePath = path.join(root, definition.source);
    assert(fs.existsSync(canonicalModulePath), `missing ${definition.source}`);
    const canonicalModuleBytes = fs.readFileSync(canonicalModulePath);
    const destinations = policy.entries.flatMap((entry) => (
      entry.copies
        .filter((copy) => copy.module === moduleName)
        .map((copy) => copy.destination)
    )).sort();
    assert.strictEqual(destinations.length, expectedCount);
    assert.deepStrictEqual(discoverAuthCopies(moduleName), destinations);
    for (const destination of destinations) {
      const absoluteDestination = path.join(root, destination);
      assert(fs.existsSync(absoluteDestination), `missing ${destination}`);
      assert(
        !fs.lstatSync(absoluteDestination).isSymbolicLink(),
        `${destination} is a symlink`
      );
      assert(
        fs.readFileSync(absoluteDestination).equals(canonicalModuleBytes),
        `${destination} differs from ${definition.source}`
      );
    }
  }

  console.log(
    `AUTH_SHARED_PARITY_OK guarded=${protocolEntries.length}`
    + ` copies=${expectedCopies.length}`
    + ' task3=keyring:76,identifiers:2,password:1,session:76'
    + ' task4=sms:2'
  );
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
