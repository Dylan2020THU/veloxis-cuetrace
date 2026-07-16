const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const packageScript = path.join(root, 'scripts', 'package-auth-guard-checkpoint.ps1');
const artifactRelative = '.superpowers/sdd/auth-v2-guard-v1-compat.zip';
const artifactPath = path.join(root, artifactRelative);
const sidecarPath = `${artifactPath}.sha256`;
const manifestName = 'auth-v2-guard-v1-compat-manifest.json';
const protocolPathSha256 =
  '51587fc66044ea26fb233c78f319d0ad18f563c0a4d47aaac485e3e5207cf56c';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function gitOutput(args) {
  const result = childProcess.spawnSync('git', args, {
    cwd: root,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024
  });
  assert.strictEqual(
    result.status,
    0,
    `git ${args.join(' ')} failed:\n${result.stderr}${result.stdout}`
  );
  return result.stdout;
}

function cachedIndexSnapshot() {
  const names = gitOutput(['diff', '--cached', '--name-only', '-z']);
  return {
    count: names.toString('utf8').split('\0').filter(Boolean).length,
    sha256: sha256(names)
  };
}

function committedPolicy() {
  return JSON.parse(
    gitOutput(['show', 'HEAD:scripts/auth-v2-entry-policy.json']).toString('utf8')
  );
}

function protocolClientPaths() {
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
  assert.strictEqual(lines.at(-2), 'PROTOCOL_CLIENT_COUNT=97');
  assert.strictEqual(
    lines.at(-1),
    `PROTOCOL_CLIENT_SHA256=${protocolPathSha256}`
  );
  return lines.slice(0, -2);
}

function excludedDeployPath(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  const basename = segments.at(-1).toLowerCase();
  const extension = path.extname(basename);
  return segments.some((segment) => (
    [
      'node_modules',
      '.git',
      'coverage',
      'secrets',
      'private',
      'keys',
      'certs'
    ].includes(segment.toLowerCase())
  ))
    || basename === '.ds_store'
    || basename === '.npmrc'
    || basename === 'secret.json'
    || basename === 'secrets.json'
    || basename === 'credentials.json'
    || basename === 'credentials'
    || basename === '.env'
    || basename.startsWith('.env.')
    || [
      '.pem',
      '.key',
      '.p12',
      '.pfx',
      '.cer',
      '.crt',
      '.der',
      '.jks',
      '.keystore'
    ].includes(extension)
    || ['.log', '.tmp', '.zip', '.sha256'].includes(extension);
}

function walkDeployDirectory(relativeDirectory) {
  const files = [];
  const absoluteDirectory = path.join(root, relativeDirectory);
  function walk(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, item.name);
      const relativePath = path.relative(root, absolutePath).replace(/\\/g, '/');
      const stats = fs.lstatSync(absolutePath);
      assert(!stats.isSymbolicLink(), `deploy source contains a symlink: ${relativePath}`);
      if (excludedDeployPath(relativePath)) continue;
      if (item.isDirectory()) {
        walk(absolutePath);
      } else if (item.isFile()) {
        files.push(relativePath);
      }
    }
  }
  walk(absoluteDirectory);
  return files;
}

function expectedDeployFiles(paths) {
  return [...new Set(paths.flatMap((entryPath) => (
    walkDeployDirectory(path.posix.dirname(entryPath))
  )))].sort();
}

function sourceTreeSnapshot(files) {
  return sha256(Buffer.from(files.map((relativePath) => {
    const bytes = fs.readFileSync(path.join(root, relativePath));
    return `${relativePath}\0${bytes.length}\0${sha256(bytes)}`;
  }).join('\n')));
}

function runPackageScript(expectedFiles) {
  const before = cachedIndexSnapshot();
  const beforeSources = sourceTreeSnapshot(expectedFiles);
  const result = childProcess.spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      packageScript
    ],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    }
  );
  assert.strictEqual(
    result.status,
    0,
    `checkpoint package failed:\n${result.stderr}${result.stdout}`
  );
  assert.match(result.stdout, /STATUS=PASS/);
  assert.match(result.stdout, /GUARDED_FUNCTIONS=97/);
  assert.match(result.stdout, new RegExp(`PROTOCOL_CLIENT_SHA256=${protocolPathSha256}`));
  assert.match(result.stdout, /ZIP_SHA256=[0-9a-f]{64}/);
  assert.deepStrictEqual(cachedIndexSnapshot(), before);
  assert.strictEqual(sourceTreeSnapshot(expectedFiles), beforeSources);
  return result.stdout;
}

function inspectZip(zipPath = artifactPath, checkpointManifestName = manifestName) {
  const script = String.raw`
$ZipPath = $env:AUTH_CHECKPOINT_ZIP
$ManifestName = $env:AUTH_CHECKPOINT_MANIFEST
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($ZipPath)
try {
  $payloads = @($archive.Entries | ForEach-Object {
    $entry = $_
    $stream = $entry.Open()
    try {
      $hasher = [Security.Cryptography.SHA256]::Create()
      try {
        $hash = $hasher.ComputeHash($stream)
      } finally {
        $hasher.Dispose()
      }
    } finally {
      $stream.Dispose()
    }
    [pscustomobject]@{
      path = $entry.FullName
      size = $entry.Length
      sha256 = (($hash | ForEach-Object { $_.ToString('x2') }) -join '')
    }
  })
  $manifestEntry = $archive.Entries | Where-Object {
    $_.FullName -ceq $ManifestName
  }
  if (-not $manifestEntry) { throw 'checkpoint manifest is missing' }
  $stream = $manifestEntry.Open()
  try {
    $reader = New-Object IO.StreamReader(
      $stream,
      (New-Object Text.UTF8Encoding($false)),
      $true
    )
    try { $manifest = $reader.ReadToEnd() } finally { $reader.Dispose() }
  } finally {
    $stream.Dispose()
  }
  [pscustomobject]@{
    payloads = $payloads
    manifest = $manifest
  } | ConvertTo-Json -Compress -Depth 6
} finally {
  $archive.Dispose()
}
`;
  const result = childProcess.spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: Object.assign({}, process.env, {
        AUTH_CHECKPOINT_ZIP: zipPath,
        AUTH_CHECKPOINT_MANIFEST: checkpointManifestName
      }),
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    }
  );
  assert.strictEqual(
    result.status,
    0,
    `cannot inspect checkpoint ZIP:\n${result.stderr}${result.stdout}`
  );
  const inspection = JSON.parse(result.stdout.trim());
  inspection.entries = inspection.payloads.map((payload) => payload.path);
  inspection.manifest = JSON.parse(inspection.manifest);
  return inspection;
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

function assertDynamicSecretExclusion() {
  const fixtureRoot = path.join(
    os.tmpdir(),
    `cuetrace-auth-checkpoint-secrets-${process.pid}-${Date.now()}-${crypto
      .randomBytes(4)
      .toString('hex')}`
  );
  fs.mkdirSync(path.join(fixtureRoot, '.superpowers', 'sdd'), {
    recursive: true
  });
  writeFixtureFile(
    fixtureRoot,
    'scripts/package-auth-guard-checkpoint.ps1',
    fs.readFileSync(packageScript)
  );
  const guardBytes = Buffer.from("'use strict';\nmodule.exports = {};\n");
  writeFixtureFile(
    fixtureRoot,
    'cloudfunctions/_shared/auth/protocol-guard.js',
    guardBytes
  );
  const entries = Array.from({ length: 97 }, (_unused, index) => {
    const name = `fixture${String(index).padStart(3, '0')}`;
    writeFixtureFile(
      fixtureRoot,
      `cloudfunctions/${name}/index.js`,
      "'use strict';\nexports.main = async () => ({ ok: true });\n"
    );
    writeFixtureFile(
      fixtureRoot,
      `cloudfunctions/${name}/lib/auth/protocol-guard.js`,
      guardBytes
    );
    return {
      name,
      protocolGuard: 'client',
      copies: [{
        module: 'protocol-guard',
        destination: `cloudfunctions/${name}/lib/auth/protocol-guard.js`
      }]
    };
  });
  const firstDirectory = 'cloudfunctions/fixture000';
  for (const [relativePath, contents] of Object.entries({
    [`${firstDirectory}/config.json`]: '{}\n',
    [`${firstDirectory}/nested/keep.js`]: "'use strict';\n",
    [`${firstDirectory}/.env`]: 'SECRET=1\n',
    [`${firstDirectory}/.env.production`]: 'SECRET=1\n',
    [`${firstDirectory}/.npmrc`]: 'token=secret\n',
    [`${firstDirectory}/secret.json`]: '{}\n',
    [`${firstDirectory}/credentials.json`]: '{}\n',
    [`${firstDirectory}/debug.log`]: 'secret\n',
    [`${firstDirectory}/archive.zip`]: 'secret\n',
    [`${firstDirectory}/secrets/token.pem`]: 'secret\n',
    [`${firstDirectory}/private/info.json`]: '{}\n',
    [`${firstDirectory}/keys/key.der`]: 'secret\n',
    [`${firstDirectory}/certs/cert.crt`]: 'secret\n',
    [`${firstDirectory}/node_modules/pkg/index.js`]: 'secret\n',
    [`${firstDirectory}/coverage/report.json`]: '{}\n'
  })) {
    writeFixtureFile(fixtureRoot, relativePath, contents);
  }
  const policy = {
    schemaVersion: 1,
    modules: {
      'protocol-guard': {
        source: 'cloudfunctions/_shared/auth/protocol-guard.js',
        availableFromTask: 2
      }
    },
    entries
  };
  writeFixtureFile(
    fixtureRoot,
    'scripts/auth-v2-entry-policy.json',
    `${JSON.stringify(policy, null, 2)}\n`
  );
  runFixtureGit(fixtureRoot, ['init', '-q']);
  runFixtureGit(fixtureRoot, ['add', 'scripts/auth-v2-entry-policy.json']);
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

  const result = childProcess.spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(fixtureRoot, 'scripts', 'package-auth-guard-checkpoint.ps1')
    ],
    {
      cwd: fixtureRoot,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    }
  );
  assert.strictEqual(
    result.status,
    0,
    `secret fixture package failed:\n${result.stderr}${result.stdout}`
  );
  const fixtureArtifact = path.join(
    fixtureRoot,
    '.superpowers',
    'sdd',
    'auth-v2-guard-v1-compat.zip'
  );
  const inspection = inspectZip(fixtureArtifact, manifestName);
  assert(inspection.entries.includes(`${firstDirectory}/config.json`));
  assert(inspection.entries.includes(`${firstDirectory}/nested/keep.js`));
  assert(
    inspection.entries.every((entry) => !excludedDeployPath(entry)),
    `secret fixture leaked an excluded entry: ${inspection.entries
      .filter(excludedDeployPath)
      .join(',')}`
  );
}

function main() {
  const policy = committedPolicy();
  const paths = protocolClientPaths();
  assert.strictEqual(paths.length, 97);
  assert.deepStrictEqual(
    paths,
    policy.entries
      .filter((entry) => ['client', 'branch'].includes(entry.protocolGuard))
      .map((entry) => `cloudfunctions/${entry.name}/index.js`)
      .sort()
  );

  assert(
    fs.existsSync(packageScript),
    'missing scripts/package-auth-guard-checkpoint.ps1'
  );
  const packageSource = fs.readFileSync(packageScript, 'utf8');
  assert(
    /git[\s\S]*cat-file blob HEAD:scripts\/auth-v2-entry-policy\.json/i.test(
      packageSource
    ),
    'checkpoint package must read the committed policy'
  );
  assert(
    /ZipArchive/.test(packageSource) && !/\bCompress-Archive\b/.test(packageSource),
    'checkpoint package must use deterministic ZipArchive construction'
  );
  assert(
    /ReparsePoint/.test(packageSource),
    'checkpoint package must reject reparse points'
  );
  assert(
    /1980/.test(packageSource),
    'checkpoint package must fix ZIP entry timestamps'
  );

  const expectedFiles = expectedDeployFiles(paths);
  const firstOutput = runPackageScript(expectedFiles);
  assert(fs.existsSync(artifactPath), `missing ${artifactRelative}`);
  assert(fs.existsSync(sidecarPath), `missing ${artifactRelative}.sha256`);
  const firstZipSha = sha256(fs.readFileSync(artifactPath));
  assert(firstOutput.includes(`ZIP_SHA256=${firstZipSha}`));
  assert.strictEqual(
    fs.readFileSync(sidecarPath, 'utf8'),
    `${firstZipSha}  auth-v2-guard-v1-compat.zip\n`
  );

  const firstInspection = inspectZip();
  const expectedEntries = [...expectedFiles, manifestName].sort();
  assert.deepStrictEqual([...firstInspection.entries].sort(), expectedEntries);
  for (const entry of firstInspection.entries) {
    assert(!excludedDeployPath(entry), `excluded file leaked into checkpoint: ${entry}`);
    if (entry === manifestName) continue;
    assert(
      paths.some((entryPath) => (
        entry.startsWith(`${path.posix.dirname(entryPath)}/`)
      )),
      `unrelated file leaked into checkpoint: ${entry}`
    );
  }

  const manifest = firstInspection.manifest;
  assert.deepStrictEqual(Object.keys(manifest).sort(), [
    'artifact',
    'files',
    'guardedFunctionCount',
    'policySha256',
    'protocolClientPaths',
    'protocolClientSha256',
    'schemaVersion'
  ]);
  assert.strictEqual(manifest.schemaVersion, 1);
  assert.strictEqual(manifest.artifact, 'auth-v2-guard-v1-compat.zip');
  assert.strictEqual(manifest.guardedFunctionCount, 97);
  assert.strictEqual(manifest.protocolClientSha256, protocolPathSha256);
  assert.strictEqual(
    manifest.policySha256,
    sha256(gitOutput(['cat-file', 'blob', 'HEAD:scripts/auth-v2-entry-policy.json']))
  );
  assert.deepStrictEqual(manifest.protocolClientPaths, paths);
  assert.deepStrictEqual(
    manifest.files.map((file) => file.path),
    expectedFiles
  );
  for (const file of manifest.files) {
    assert.deepStrictEqual(Object.keys(file).sort(), ['path', 'sha256', 'size']);
    const bytes = fs.readFileSync(path.join(root, file.path));
    assert.strictEqual(file.size, bytes.length, `${file.path} size changed`);
    assert.strictEqual(file.sha256, sha256(bytes), `${file.path} hash changed`);
    const archived = firstInspection.payloads.find(
      (payload) => payload.path === file.path
    );
    assert(archived, `${file.path} is absent from the ZIP payload`);
    assert.strictEqual(archived.size, bytes.length, `${file.path} ZIP size changed`);
    assert.strictEqual(
      archived.sha256,
      sha256(bytes),
      `${file.path} ZIP bytes changed`
    );
  }
  for (const entryPath of paths) {
    const directory = path.posix.dirname(entryPath);
    assert(manifest.files.some((file) => file.path === entryPath));
    assert(
      manifest.files.some(
        (file) => file.path === `${directory}/lib/auth/protocol-guard.js`
      )
    );
  }

  runPackageScript(expectedFiles);
  const rebuiltZipSha = sha256(fs.readFileSync(artifactPath));
  assert.strictEqual(rebuiltZipSha, firstZipSha, 'checkpoint ZIP must be reproducible');
  assert.strictEqual(
    fs.readFileSync(sidecarPath, 'utf8'),
    `${rebuiltZipSha}  auth-v2-guard-v1-compat.zip\n`
  );
  assertDynamicSecretExclusion();

  console.log(
    `AUTH_GUARD_CHECKPOINT_OK guarded=97 files=${expectedFiles.length} sha256=${rebuiltZipSha}`
  );
}

main();
