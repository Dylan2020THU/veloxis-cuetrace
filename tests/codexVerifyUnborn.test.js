const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const verifierPath = path.resolve(__dirname, '../scripts/codex-verify.ps1');
const verifier = fs.readFileSync(verifierPath, 'utf8');
const powershellPath = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32/WindowsPowerShell/v1.0/powershell.exe'
);

const expectedUnbornCollection = {
  tracked: [
    'miniprogram/app.js',
    'miniprogram/pages/staged-worktree-modified.js'
  ],
  untracked: ['miniprogram/pages/new-page.js'],
  changed: [
    'miniprogram/app.js',
    'miniprogram/pages/new-page.js',
    'miniprogram/pages/staged-worktree-modified.js'
  ],
  diffOutput: []
};

function extractUnbornCollectionSnippet(source) {
  const start = source.indexOf('$businessPathspec = @(');
  const changedLine = '$changed = @($tracked + $untracked | Sort-Object -Unique)';
  const changedStart = source.indexOf(changedLine, start);

  assert(start >= 0, 'behavior test should find the complete business pathspec');
  assert(changedStart >= 0, 'behavior test should find the changed-path union');
  return source.slice(start, changedStart + changedLine.length);
}

function insertTrackedResetBeforeChanged(source) {
  const marker = '    $changed = @($tracked + $untracked | Sort-Object -Unique)';
  const markerIndex = source.indexOf(marker);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';

  assert(markerIndex >= 0, 'mutation should find the changed-path union');
  return `${source.slice(0, markerIndex)}    $tracked = @()${newline}${source.slice(markerIndex)}`;
}

function runUnbornCollection(source) {
  const snippet = extractUnbornCollectionSnippet(source);
  const command = String.raw`
$ErrorActionPreference = 'Stop'
$script:collectionCalls = @()
$script:expectedExcludes = @(
  ':(exclude).agents/**',
  ':(exclude).codex/**',
  ':(exclude).worktrees/**',
  ':(exclude)artifacts/**',
  ':(exclude)**/node_modules/**'
)

function Assert-BusinessPathspec([string[]]$GitArguments) {
  foreach ($excluded in $script:expectedExcludes) {
    if ($GitArguments -notcontains $excluded) {
      throw "missing business pathspec: $excluded"
    }
  }
}

function Select-BusinessPaths([string[]]$Paths) {
  return @($Paths | Where-Object {
    $_ -notmatch '^(?:\.agents|\.codex|\.worktrees|artifacts)/' -and
    $_ -notmatch '(?:^|/)node_modules/'
  })
}

function Invoke-Git([string[]]$Arguments, [switch]$AllowFailure) {
  if ($Arguments[0] -eq 'rev-parse' -and $Arguments[1] -eq '--verify' -and $Arguments[2] -eq 'HEAD') {
    return [PSCustomObject]@{ ExitCode = 1; Output = @() }
  }
  if ($Arguments[0] -eq 'ls-files' -and $Arguments -contains '--cached') {
    Assert-BusinessPathspec $Arguments
    $script:collectionCalls += 'cached'
    $candidates = @(
      'miniprogram/app.js',
      'miniprogram/pages/staged-worktree-modified.js',
      '.agents/internal.js',
      '.codex/cache.js',
      '.worktrees/other/app.js',
      'artifacts/report.js',
      'miniprogram/node_modules/vendor/index.js'
    )
    return [PSCustomObject]@{ ExitCode = 0; Output = @(Select-BusinessPaths $candidates) }
  }
  if ($Arguments[0] -eq 'ls-files' -and $Arguments -contains '--others') {
    Assert-BusinessPathspec $Arguments
    $script:collectionCalls += 'untracked'
    $candidates = @(
      'miniprogram/pages/new-page.js',
      '.agents/untracked.js',
      'miniprogram/node_modules/new-vendor/index.js'
    )
    return [PSCustomObject]@{ ExitCode = 0; Output = @(Select-BusinessPaths $candidates) }
  }
  throw "unexpected git invocation: $($Arguments -join ' ')"
}

${snippet}

if (($script:collectionCalls -join ',') -ne 'cached,untracked') {
  throw "unexpected collection calls: $($script:collectionCalls -join ',')"
}
[PSCustomObject]@{
  tracked = @($tracked)
  untracked = @($untracked)
  changed = @($changed)
  diffOutput = @($diffOutput)
} | ConvertTo-Json -Compress -Depth 3
`;
  const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');
  const result = spawnSync(
    powershellPath,
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
    { encoding: 'utf8', windowsHide: true }
  );

  assert.strictEqual(
    result.status,
    0,
    `PowerShell behavior harness failed: ${result.error || result.stderr}`
  );
  return JSON.parse(result.stdout.trim());
}

function testVerifierDetectsHeadWithoutFailing() {
  assert(
    verifier.includes("Invoke-Git @('rev-parse', '--verify', 'HEAD') -AllowFailure"),
    'verifier should probe HEAD with an allowed failure for unborn repositories'
  );
}

function getHeadBranches() {
  const branch = verifier.match(
    /if \(\$headResult\.ExitCode -eq 0\)\s*\{([\s\S]*?)\}\s*else\s*\{([\s\S]*?)\}/
  );

  assert(
    branch,
    'verifier should keep separate normal and unborn repository branches'
  );

  return { normal: branch[1], unborn: branch[2] };
}

function testVerifierCollectsCachedAndUntrackedInUnbornRepositories() {
  const { unborn } = getHeadBranches();

  assert(
    /\$tracked\s*=\s*\(Invoke-Git \(@\('ls-files', '--cached'\) \+ \$businessPathspec\)\)\.Output/.test(unborn),
    'unborn repositories should collect cached index paths with the business pathspec'
  );
  assert(
    !/\$tracked\s*=\s*@\(\)/.test(unborn),
    'unborn repositories should not discard cached index paths'
  );
  assert(
    /\$diffOutput\s*=\s*@\(\)/.test(unborn) && !/Invoke-Git[^\r\n]*@\('diff'/.test(unborn),
    'unborn repositories should leave diff checking empty without inventing a baseline'
  );
  assert(
    /\$changed\s*=\s*@\(\$tracked \+ \$untracked \| Sort-Object -Unique\)/.test(verifier),
    'cached and untracked paths should be merged into the changed set'
  );
}

function testVerifierUsesOneBusinessPathspecForEveryCollection() {
  const pathspec = verifier.match(/\$businessPathspec\s*=\s*@\(([\s\S]*?)\)\r?\n/);

  assert(pathspec, 'verifier should define one reusable business pathspec');
  for (const excluded of [
    "':(exclude).agents/**'",
    "':(exclude).codex/**'",
    "':(exclude).worktrees/**'",
    "':(exclude)artifacts/**'",
    "':(exclude)**/node_modules/**'"
  ]) {
    assert(pathspec[1].includes(excluded), `business pathspec should include ${excluded}`);
  }

  const { normal } = getHeadBranches();
  assert(
    /Invoke-Git \(@\('diff', '--name-only', \$mergeBase\) \+ \$businessPathspec\)/.test(normal),
    'normal tracked-path collection should use the business pathspec'
  );
  assert(
    /Invoke-Git \(@\('diff', '--check', \$mergeBase\) \+ \$businessPathspec\) -AllowFailure/.test(normal),
    'normal diff checking should keep merge-base behavior and use the business pathspec'
  );
  assert(
    /\$untracked\s*=\s*\(Invoke-Git \(@\('ls-files', '--others', '--exclude-standard'\) \+ \$businessPathspec\)\)\.Output/.test(verifier),
    'untracked-path collection should use the business pathspec'
  );
}

function testVerifierKeepsNormalHeadDiffFlow() {
  const { normal } = getHeadBranches();

  assert(
    /Invoke-Git @\('merge-base', 'HEAD', \$Baseline\)/.test(normal) &&
      /@\('diff', '--name-only', \$mergeBase\)/.test(normal) &&
      /@\('diff', '--check', \$mergeBase\)/.test(normal),
    'normal repositories should keep merge-base name and whitespace diff checks'
  );
}

function testVerifierPreservesCachedAndUntrackedBehavior() {
  const actual = runUnbornCollection(verifier);

  assert.deepStrictEqual(actual.tracked, expectedUnbornCollection.tracked);
  assert.deepStrictEqual(actual.untracked, expectedUnbornCollection.untracked);
  assert.deepStrictEqual(
    actual.changed,
    expectedUnbornCollection.changed,
    'unborn changed paths should contain the exact cached and untracked union'
  );
  assert(
    actual.changed.includes('miniprogram/pages/staged-worktree-modified.js'),
    'a cached path with later worktree modifications should not be lost'
  );
  assert.deepStrictEqual(
    actual.diffOutput,
    expectedUnbornCollection.diffOutput,
    'unborn repositories should keep diff output empty without a baseline'
  );
}

function testBehaviorHarnessKillsTrackedResetMutation() {
  const mutatedVerifier = insertTrackedResetBeforeChanged(verifier);
  const actual = runUnbornCollection(mutatedVerifier);

  assert.notDeepStrictEqual(
    actual.changed,
    expectedUnbornCollection.changed,
    'behavior harness should kill a post-branch reset that drops cached paths'
  );
  assert(
    !actual.changed.includes('miniprogram/pages/staged-worktree-modified.js'),
    'the mutation proof should demonstrate the cached worktree path was dropped'
  );
}

testVerifierDetectsHeadWithoutFailing();
testVerifierCollectsCachedAndUntrackedInUnbornRepositories();
testVerifierUsesOneBusinessPathspecForEveryCollection();
testVerifierKeepsNormalHeadDiffFlow();
testVerifierPreservesCachedAndUntrackedBehavior();
testBehaviorHarnessKillsTrackedResetMutation();

console.log('codex verifier unborn support ok');
