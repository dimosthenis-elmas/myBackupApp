#!/usr/bin/env node
'use strict';

/**
 * Exercises partition-backup-to-optical-media (the "how many discs, which files on which disc" bin-packing
 * logic) through the app's REAL worker IPC - no app source touched, no UI clicking.
 *
 * With splitLargeFiles left false and every generated file kept under the test capacity, this never WRITES
 * split-file data into the app's shared temp/cache directory (see app/workers/worker.ts - that only happens
 * inside the `if (splitLargeFiles)` branch). It DOES still touch that directory in one narrow way, discovered
 * while running this for real: partitionBackupToOpticalMedia unconditionally calls the app's own
 * ensureTempDataDirectoryIsAppOwned ownership check near its top, regardless of splitLargeFiles - which will
 * create (and mark as owned) the real temp directory the first time it doesn't exist yet, and will correctly
 * REFUSE to run at all if that directory exists but was never created by the app (no ownership marker) -
 * exactly the app's own intended safety behavior. So this uses the same temp-dir guard as test-merge.js.
 *
 * NOTE: this needs a real Windows desktop/window session (see call-worker.js's top comment) - run it from your
 * own interactive terminal, not from a headless/remote sandbox.
 *
 * Usage:
 *   node test-harness/worker-ipc/test-partitioning.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { launchApp, callWorker } = require('./call-worker');
const { assertRealTempDataDirectoryIsSafeToUse } = require('./temp-dir-guard');
const { MARKER_FILE_NAME } = require('../lib/safety'); // generate-random-tree.js's own ownership marker (unrelated to temp-dir-guard's)
const { FIXTURES_ROOT } = require('../lib/fixtures-root');
const { printTree } = require('../lib/print-tree');

const TEST_DISC_CAPACITY_BYTES = 200_000; // small & fast on purpose - this test is about the bin-packing math, not real disc sizes

async function main() {
  console.log('Checking the app\'s real temp/cache directory is safe to use...');
  const tempDir = assertRealTempDataDirectoryIsSafeToUse();
  console.log(`OK - using: ${tempDir}\n`);

  const appDataDir = path.resolve(__dirname, '../../appData');
  const config = JSON.parse(fs.readFileSync(path.join(appDataDir, 'config.json'), 'utf8'));
  const repletionRatio = config.maxOpticalMediumRepletionRatio;
  if (typeof repletionRatio !== 'number') {
    throw new Error('appData/config.json is missing maxOpticalMediumRepletionRatio - cannot compute expected per-disc limits.');
  }
  const effectiveCapacity = TEST_DISC_CAPACITY_BYTES * repletionRatio;

  // 1. Generate a small random tree, with every file safely under the test capacity (so nothing needs splitting).
  const root = path.join(FIXTURES_ROOT, `partitioning-${Date.now()}`);
  console.log(`Generating test tree at ${root} ...`);
  execFileSync(process.execPath, [
    path.join(__dirname, '../generate-random-tree.js'),
    '--root', root,
    '--files', '25',
    '--max-depth', '3',
    '--min-size', '0',
    '--max-size', String(Math.floor(effectiveCapacity / 6)), // keep individual files well under one disc's worth
    '--seed', '12345',
  ], { stdio: 'inherit' });

  const manifest = JSON.parse(fs.readFileSync(`${root}.manifest.json`, 'utf8'));
  console.log(`\nGenerated ${manifest.fileCount} files, ${manifest.totalSizeBytes.toLocaleString()} bytes total.`);
  printTree(root, 'Source tree (before)');

  // 2. Launch the real app and call the real worker.
  console.log('\nLaunching the app...');
  const { app, win } = await launchApp();
  let response;
  try {
    console.log('Calling partition-backup-to-optical-media over real IPC...');
    response = await callWorker(win, 'partition-backup-to-optical-media', {
      rootPath: root,
      mediaCapacityInBytes: TEST_DISC_CAPACITY_BYTES,
      splitLargeFiles: false,
      sessionId: 'session-' + Date.now(),
    });
  } finally {
    await app.close();
  }

  // 3. Verify the result.
  const partitioning = response.res; // ColdStorageMetadata: Array<Array<{path, stats}>>
  console.log(`\nApp reports ${partitioning.length} disc(s) needed.`);

  // The computed partitioning IS this test's "after" - there's no destination directory to printTree against
  // (nothing gets copied anywhere; this is a bin-packing PLAN, not a copy), so list each disc's assigned files
  // individually, not just the per-disc totals.
  console.log('\nComputed partitioning (after):');
  const seenPaths = new Set();
  let allFilesAccountedFor = true;
  let allDiscsWithinCapacity = true;

  partitioning.forEach((disc, discIndex) => {
    const discTotal = disc.reduce((sum, f) => sum + f.stats.size, 0);
    const withinCapacity = discTotal <= effectiveCapacity;
    if (!withinCapacity) { allDiscsWithinCapacity = false; }
    console.log(`  Disc ${discIndex + 1}: ${disc.length} files, ${discTotal.toLocaleString()} bytes ` +
      `(limit ${Math.floor(effectiveCapacity).toLocaleString()}) ${withinCapacity ? 'OK' : 'OVER CAPACITY - FAIL'}`);
    disc.forEach((f) => {
      console.log(`    ${path.relative(root, f.path)} (${f.stats.size.toLocaleString()} bytes)`);
      seenPaths.add(f.path);
    });
  });

  const expectedPaths = new Set(manifest.files.map((f) => path.join(root, f.relativePath.split('/').join(path.sep))));
  const missing = [...expectedPaths].filter((p) => !seenPaths.has(p));
  // Two kinds of "extra" entries are legitimate, not bugs: (1) generate-random-tree.js's own ownership-marker
  // file, which really does sit in the source folder and the app is right to back it up - the manifest just
  // deliberately excludes it as harness bookkeeping (see lib/safety.js), same as verify-manifest.js already
  // does; (2) directory entries - the app correctly tracks empty directories too (see the "It also takes into
  // account empty directories" comment on getAllFilesSet in worker.ts), so it can recreate the folder structure
  // on recovery, but this manifest only ever tracks files, never directories.
  const unexpected = [...seenPaths].filter((p) => {
    if (!expectedPaths.has(p)) {
      if (path.basename(p) === MARKER_FILE_NAME) { return false; }
      try { if (fs.statSync(p).isDirectory()) { return false; } } catch { /* fall through - stat failing on an unexpected path is itself worth flagging */ }
      return true;
    }
    return false;
  });
  if (missing.length > 0 || unexpected.length > 0) { allFilesAccountedFor = false; }

  console.log(`\nFiles from manifest missing from the partitioning result: ${missing.length}`);
  missing.forEach((p) => console.log(`  - ${p}`));
  console.log(`Paths in the partitioning result not in the manifest: ${unexpected.length}`);
  unexpected.forEach((p) => console.log(`  - ${p}`));

  const pass = allFilesAccountedFor && allDiscsWithinCapacity;
  console.log(`\n${pass ? 'PASS' : 'FAIL'} - partition-backup-to-optical-media ${pass ? 'correctly assigned every file within capacity.' : 'produced an incorrect result, see above.'}`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => {
  console.error('\nTEST ERRORED:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
