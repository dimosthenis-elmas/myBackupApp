#!/usr/bin/env node
'use strict';

/**
 * Exercises merge-file-parts (reassembling split large-file parts back into the original file) through the
 * app's REAL worker IPC - no app source touched, no UI clicking.
 *
 * The app always splits with 7-Zip's `-v500m` (500 MB volumes - see partitionBackupToOpticalMedia in
 * app/workers/worker.ts), so genuinely exercising THAT split step needs a 500MB+ source file, which is a
 * separate, opt-in, heavier scenario (see test-harness/worker-ipc/README.md). This script instead produces its
 * own small multi-volume 7-Zip split directly (same 7-Zip binary the app itself uses, from
 * appData/config.json's _7zipExecutablePath, just with a much smaller volume size) - this exercises the exact
 * same merge/verify/cleanup code the app runs, just arriving at the "here are some split parts" starting point
 * a faster way.
 *
 * Touches the app's REAL shared temp/cache directory (no per-test override exists - see temp-dir-guard.js) -
 * refuses to run unless that directory is currently empty (besides the app's own ownership marker).
 *
 * NOTE: this needs a real Windows desktop/window session (see call-worker.js's top comment) - run it from your
 * own interactive terminal, not from a headless/remote sandbox.
 *
 * Usage:
 *   node test-harness/worker-ipc/test-merge.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { launchApp, callWorker } = require('./call-worker');
const { assertRealTempDataDirectoryIsSafeToUse } = require('./temp-dir-guard');
const { printTree } = require('../lib/print-tree');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function main() {
  console.log('Checking the app\'s real temp/cache directory is safe to use...');
  const tempDir = assertRealTempDataDirectoryIsSafeToUse();
  fs.mkdirSync(tempDir, { recursive: true });
  console.log(`OK - using: ${tempDir}`);

  const appDataDir = path.resolve(__dirname, '../../appData');
  const config = JSON.parse(fs.readFileSync(path.join(appDataDir, 'config.json'), 'utf8'));
  const sevenZipPath = config._7zipExecutablePath;
  if (!sevenZipPath || !fs.existsSync(sevenZipPath)) {
    throw new Error(`_7zipExecutablePath in appData/config.json ("${sevenZipPath}") does not exist - 7-Zip must be installed and configured for this test (same requirement the app itself has for merging).`);
  }

  // 1. Build a small source file with known, verifiable content.
  const scratchRoot = path.join(FIXTURES_ROOT, `merge-test-${Date.now()}`);
  fs.mkdirSync(scratchRoot, { recursive: true });
  const originalFileName = 'merge-test-source.bin';
  const originalPath = path.join(scratchRoot, originalFileName);
  const originalBytes = crypto.randomBytes(50_000); // 50 KB - small and fast
  fs.writeFileSync(originalPath, originalBytes);
  const originalHash = sha256(originalPath);
  console.log(`\nCreated a ${originalBytes.length}-byte test file (sha256 ${originalHash}).`);

  // 2. Split it into several small volumes directly into the (guarded, empty) temp dir, using the app's own
  //    7-Zip binary, the same store-mode flag the app uses (-mx0), just with a tiny volume size so we get
  //    several real parts out of a small file instead of needing 500MB+.
  console.log('Splitting into multiple 7-Zip volumes (store mode, 10 KB each)...');
  execFileSync(sevenZipPath, ['-v10k', '-mx0', 'a', path.join(tempDir, `${originalFileName}.part`), originalPath]);
  const partFileNames = fs.readdirSync(tempDir)
    .filter((f) => f.startsWith(`${originalFileName}.part`))
    .sort();
  const partFilePaths = partFileNames.map((f) => path.join(tempDir, f));
  console.log(`Created ${partFilePaths.length} part file(s): ${partFileNames.join(', ')}`);
  if (partFilePaths.length < 2) {
    throw new Error('Expected at least 2 part files from a 50KB file split into 10KB volumes - something is off with the 7-Zip invocation.');
  }
  printTree(tempDir, 'App temp dir (before merge - the split parts)');

  // 3. Launch the real app and call the real worker to merge them back together.
  console.log('\nLaunching the app...');
  const { app, win } = await launchApp();
  let response;
  try {
    console.log('Calling merge-file-parts over real IPC...');
    response = await callWorker(win, 'merge-file-parts', {
      partFilePaths,
      originalFileName,
    });
  } finally {
    await app.close();
  }

  console.log(`\nWorker response: ${JSON.stringify(response.res)}`);
  printTree(tempDir, 'App temp dir (after merge)');

  // 4. Verify: merged flag true, reassembled file present with the correct hash, part files cleaned up by the
  //    app itself (mergeFileParts deletes them on success - see app/workers/worker.ts).
  const reassembledPath = path.join(tempDir, originalFileName);
  const reassembledExists = fs.existsSync(reassembledPath);
  const reassembledHash = reassembledExists ? sha256(reassembledPath) : null;
  const hashMatches = reassembledHash === originalHash;
  const partsWereCleanedUp = partFilePaths.every((p) => !fs.existsSync(p));

  console.log(`  merged flag           : ${response.res.merged}`);
  console.log(`  reassembled file exists: ${reassembledExists}`);
  console.log(`  hash matches original  : ${hashMatches} ${hashMatches ? '' : `(expected ${originalHash}, got ${reassembledHash})`}`);
  console.log(`  part files cleaned up  : ${partsWereCleanedUp}`);

  const pass = response.res.merged === true && reassembledExists && hashMatches && partsWereCleanedUp;

  // Clean up our own scratch/temp output regardless of pass/fail (only files this script itself created/knows
  // about - never a directory-wide clear).
  fs.rmSync(scratchRoot, { recursive: true, force: true });
  if (reassembledExists) { fs.rmSync(reassembledPath, { force: true }); }
  partFilePaths.forEach((p) => { if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); } });

  console.log(`\n${pass ? 'PASS' : 'FAIL'} - merge-file-parts ${pass ? 'correctly reassembled the split file with matching content.' : 'did not behave as expected, see above.'}`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => {
  console.error('\nTEST ERRORED:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
