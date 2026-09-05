#!/usr/bin/env node
'use strict';

/**
 * Exercises the two rare reconciliation paths in materializeOpticalMediaDiscPieces (worker.ts) that
 * worker-ipc/test-large-file-split.js's own file size never happens to hit, because it isn't near the boundary
 * that triggers them:
 *
 *  1. The "surplus piece" case: a file whose remainder over a full 500 MiB volume is close enough to the volume
 *     size that 7-Zip's own small per-archive overhead pushes it over, producing one MORE real piece than
 *     estimateLargeFileSplitPieces predicted (see that function's own comment for the full reasoning - this is
 *     by design, not a bug). Confirmed empirically while designing this feature: a file exactly 50 bytes short
 *     of an even 2-volume split real-splits into 3 pieces, not 2. This test uses that exact, known-to-trigger
 *     file size (2*500MiB - 50 bytes) and asserts materializeOpticalMediaDiscPieces correctly returns the
 *     surplus piece rather than silently dropping it.
 *
 *  2. The "genuinely unexpected" throw path: if a real split ever produces MORE than one extra piece beyond the
 *     estimate, materializeOpticalMediaDiscPieces treats that as a real problem and throws, rather than quietly
 *     reconciling it the same way as case 1. No real 7-Zip run can be coaxed into misbehaving this way on
 *     demand, so this half instead temporarily redirects the app's own configured 7-Zip path to a stub batch
 *     script that deliberately produces 5 dummy pieces for a file whose estimate predicts only 2 - proving the
 *     throw actually fires, not just that the code reads as if it should.
 *
 * Content doesn't matter for either check (piece COUNT and SIZE, not reassembled data, are what's under test),
 * so both source files are written as sparse/zero-filled, avoiding the need to generate or stream real random
 * data for ~1GB.
 *
 * NOTE: needs a real Windows desktop/window session (see worker-ipc/call-worker.js's top comment) - run from
 * your own interactive terminal.
 *
 * Usage:
 *   node test-harness/worker-ipc/test-large-file-split-boundary.js
 */

const fs = require('fs');
const path = require('path');
const { launchApp, callWorker } = require('./call-worker');
const { assertRealTempDataDirectoryIsSafeToUse } = require('./temp-dir-guard');
const { printTree } = require('../lib/print-tree');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');
const { backupAndRedirectConfigField, restoreConfig } = require('../lib/ibb-tools');

// Must match LARGE_FILE_SPLIT_VOLUME_SIZE_MIB in app/workers/worker.ts (500 MiB).
const VOLUME_SIZE_BYTES = 500 * 1024 * 1024; // 524,288,000

/** Writes a file of exactly `sizeBytes` with no real content (a sparse file on NTFS) - fast regardless of size,
 *  since nothing here reads the file's actual bytes back. */
function writeExactSizeFile(filePath, sizeBytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, 'w');
  fs.ftruncateSync(fd, sizeBytes);
  fs.closeSync(fd);
}

/** Deletes any real temp-dir files matching `${baseName}.part.NNN`, directly under `tempDir` (both source files
 *  in this test live at the root of their own source tree, so their real pieces land directly under tempDir too
 *  - no subdirectory to also clean up, unlike a large file nested under e.g. "large-files/"). */
function cleanupRealPieces(tempDir, baseName) {
  const pattern = new RegExp(`^${baseName.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}\\.part\\.\\d+$`, 'i');
  for (const f of fs.readdirSync(tempDir)) {
    if (pattern.test(f)) { fs.rmSync(path.join(tempDir, f), { force: true }); }
  }
}

async function main() {
  console.log('Checking the app\'s real temp/cache directory is safe to use...');
  const tempDir = assertRealTempDataDirectoryIsSafeToUse();
  fs.mkdirSync(tempDir, { recursive: true });
  console.log(`OK - using: ${tempDir}`);

  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `large-file-split-boundary-${runId}`);
  const results = {};

  // ============================================================================================================
  // Part 1: the surplus-piece reconciliation case, against a REAL 7-Zip split.
  // ============================================================================================================
  console.log('\n=== Part 1: surplus-piece boundary case (real 7-Zip) ===');
  const boundarySourceRoot = path.join(scratchRoot, 'boundary-source');
  const boundaryFilePath = path.join(boundarySourceRoot, 'boundary-file.bin');
  const boundaryFileSize = 2 * VOLUME_SIZE_BYTES - 50; // empirically confirmed trigger for the surplus case
  console.log(`Writing a boundary-case file of exactly ${boundaryFileSize.toLocaleString()} bytes (2 volumes minus 50 bytes)...`);
  writeExactSizeFile(boundaryFilePath, boundaryFileSize);

  let app, win;
  try {
    console.log('\nLaunching the app...');
    ({ app, win } = await launchApp());

    // Avoid racing app.component.ts's own startup housekeeping IPC call - see test-large-file-split.js's
    // identical pause for the full explanation.
    await new Promise((r) => setTimeout(r, 3000));

    console.log('\nCalling partition-backup-to-optical-media (planning only - no 7-Zip yet)...');
    const planResponse = await callWorker(win, 'partition-backup-to-optical-media', {
      rootPath: boundarySourceRoot,
      mediaCapacityInBytes: 600_000_000,
      splitLargeFiles: true,
    }, 60 * 1000);

    const predictedPieces = planResponse.res.flat().filter((e) => /\.part\.\d+$/i.test(e.path));
    results.estimatedExactlyTwoPieces = predictedPieces.length === 2;
    console.log(`  estimated piece count: ${predictedPieces.length} (expected 2) - ${results.estimatedExactlyTwoPieces ? 'OK' : 'WRONG'}`);

    const bareRelativePaths = predictedPieces.map((e) => path.relative(tempDir, e.path));
    console.log('\nCalling materialize-optical-media-disc-pieces (runs the real 7-Zip split)...');
    const materializeResponse = await callWorker(win, 'materialize-optical-media-disc-pieces', {
      dirPath: boundarySourceRoot,
      paths: bareRelativePaths,
    }, 5 * 60 * 1000);

    const realPieces = materializeResponse.res;
    results.realThreePiecesReturned = realPieces.length === 3;
    console.log(`  real piece count returned: ${realPieces.length} (expected 3 - the surplus piece included) - ${results.realThreePiecesReturned ? 'OK' : 'WRONG'}`);
    for (const p of realPieces) { console.log(`    ${p.path} - ${p.stats.size.toLocaleString()} bytes`); }

    const totalRealBytes = realPieces.reduce((sum, p) => sum + p.stats.size, 0);
    results.realTotalMatchesOriginalPlusOverhead = totalRealBytes > boundaryFileSize && totalRealBytes <= boundaryFileSize + 4096;
    console.log(`  total real bytes: ${totalRealBytes.toLocaleString()} vs original ${boundaryFileSize.toLocaleString()} (+ up to 4096 bytes real 7z overhead allowed): ${results.realTotalMatchesOriginalPlusOverhead ? 'OK' : 'WRONG'}`);

    printTree(tempDir, 'App temp dir after Part 1\'s materialize');
  } finally {
    if (app) { await app.close().catch(() => {}); }
    try { cleanupRealPieces(tempDir, 'boundary-file.bin'); } catch { /* best effort */ }
  }

  // ============================================================================================================
  // Part 2: the "genuinely unexpected" throw path, via a stub 7-Zip that deliberately produces the wrong count.
  // ============================================================================================================
  console.log('\n=== Part 2: forcing a >1 piece-count mismatch via a stub 7-Zip ===');
  const throwSourceRoot = path.join(scratchRoot, 'throw-source');
  const throwFilePath = path.join(throwSourceRoot, 'throw-file.bin');
  // Must exceed the EFFECTIVE capacity (mediaCapacityInBytes * the app's own ratio, 600,000,000 * 0.95 =
  // 570,000,000 here) to be classified as "too large for a single disc" at all and routed into the split path -
  // NOT just the raw 600,000,000 or the 524,288,000 volume size, both of which are under that effective
  // threshold and would silently be treated as an ordinary, unsplit file instead (found for real: an earlier
  // version of this file used VOLUME_SIZE_BYTES + 1,000,000 = 525,288,000, under the 570,000,000 effective
  // capacity, so partition-backup-to-optical-media never split it at all and materialize was called with an
  // empty piece list - "passing" without the stub ever running). Reusing the same proven-safe 700,000,000 /
  // 600,000,000 combination worker-ipc/test-large-file-split.js already uses avoids inventing a second
  // untested one.
  const throwFileSize = 700_000_000; // estimate predicts 2 pieces (same arithmetic as test-large-file-split.js)
  writeExactSizeFile(throwFilePath, throwFileSize);

  const stub7zPath = path.join(scratchRoot, 'stub-7z-wrong-count.bat');
  fs.mkdirSync(scratchRoot, { recursive: true });
  // Deliberately produces 5 dummy pieces regardless of what's asked for. "a" is 7-Zip's own "add" verb (argv
  // position 3 after -v500m/-mx0), the destination archive prefix is argv 4 - %~4 strips the quotes exec()
  // wraps it in. Content doesn't matter - the mismatch check only looks at the COUNT of files matching the
  // expected ".part.NNN" naming convention.
  fs.writeFileSync(stub7zPath, [
    '@echo off',
    'setlocal',
    'set "DEST=%~4"',
    'for /L %%i in (1,1,5) do (',
    '  echo dummy> "%DEST%.00%%i"',
    ')',
    '',
  ].join('\r\n'));

  let originalConfigContent;
  let app2, win2;
  try {
    originalConfigContent = backupAndRedirectConfigField('_7zipExecutablePath', stub7zPath);

    console.log('\nLaunching the app...');
    ({ app: app2, win: win2 } = await launchApp());
    await new Promise((r) => setTimeout(r, 3000));

    console.log('\nCalling partition-backup-to-optical-media (planning only)...');
    const planResponse2 = await callWorker(win2, 'partition-backup-to-optical-media', {
      rootPath: throwSourceRoot,
      mediaCapacityInBytes: 600_000_000,
      splitLargeFiles: true,
    }, 60 * 1000);
    const predictedPieces2 = planResponse2.res.flat().filter((e) => /\.part\.\d+$/i.test(e.path));
    console.log(`  estimated piece count: ${predictedPieces2.length}`);

    const bareRelativePaths2 = predictedPieces2.map((e) => path.relative(tempDir, e.path));
    console.log('\nCalling materialize-optical-media-disc-pieces (stub 7-Zip will produce 5 pieces, not 2)...');
    let threwAsExpected = false;
    let errorMessage = '';
    try {
      await callWorker(win2, 'materialize-optical-media-disc-pieces', {
        dirPath: throwSourceRoot,
        paths: bareRelativePaths2,
      }, 60 * 1000);
    } catch (err) {
      threwAsExpected = true;
      errorMessage = (err && err.message) || String(err);
    }
    results.throwsOnGenuineMismatch = threwAsExpected;
    console.log(`  materialize call rejected as expected: ${threwAsExpected}`);
    if (threwAsExpected) { console.log(`    error: ${errorMessage}`); }
  } finally {
    if (app2) { await app2.close().catch(() => {}); }
    if (originalConfigContent !== undefined) { restoreConfig(originalConfigContent); }
    try { cleanupRealPieces(tempDir, 'throw-file.bin'); } catch { /* best effort */ }
  }

  // ============================================================================================================
  // Summary
  // ============================================================================================================
  const pass = Object.values(results).every(Boolean);
  console.log('\nSummary:');
  for (const [check, ok] of Object.entries(results)) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${check}`);
  }

  if (pass) {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  } else {
    console.log(`\nLeaving scratch files in place for inspection: ${scratchRoot}`);
  }

  console.log(`\n${pass ? 'PASS' : 'FAIL'} - large-file-split boundary/mismatch reconciliation ${pass ? 'behaved exactly as designed.' : 'did not behave as expected, see above.'}`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => {
  console.error('\nTEST ERRORED:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
