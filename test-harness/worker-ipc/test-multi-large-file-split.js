#!/usr/bin/env node
'use strict';

/**
 * Exercises a scenario no other test here covers: TWO large files whose real split pieces end up sharing a
 * single disc's plan, rather than each large file simply getting its own separate disc(s). Every other
 * large-file test uses exactly one large file, so "a disc can be assigned pieces from more than one source
 * file" - explicitly part of this feature's design (partitionBackupToOpticalMedia pools ALL large-file pieces
 * from every large file together before bin-packing, never one file at a time) - has never actually been
 * observed happening for real.
 *
 * Sizing: two files, each exactly 600,000,000 bytes (2 pieces: one full 500 MiB volume + a ~75.7 MB remainder),
 * with mediaCapacityInBytes also 600,000,000 (the same proven-safe constant worker-ipc/test-large-file-split.js
 * already uses - effective capacity after the app's own 0.95 ratio is 570,000,000, comfortably above one full
 * volume but below two). Worked out by hand-tracing the actual first-fit-decreasing packing loop in
 * partitionBackupToOpticalMedia: sorted largest-first, the two FULL pieces (524,288,000 bytes each, tied in
 * size) each fill their own disc alone (524,288,000 + 524,288,000 would exceed the 570,000,000 effective
 * capacity), but the two REMAINDER pieces (75,712,000 bytes each) both fit together on a third disc
 * (75,712,000 * 2 = 151,424,000, comfortably under capacity) - producing exactly 3 large-file discs, the third
 * one genuinely mixing pieces from both source files.
 *
 * What this proves, beyond just "planning pools files correctly":
 *  1. materialize-optical-media-disc-pieces, asked for only the MIXED disc's two pieces, correctly splits BOTH
 *     source files for real (not just one) and returns both real pieces.
 *  2. As a side effect - because splitting a file always produces ALL of its pieces at once, never just the one
 *     requested - the OTHER two discs' pieces (each file's full-volume piece) end up physically materialized on
 *     disk too, even though they were never explicitly requested. This is expected, documented behavior, not a
 *     bug - see materializeOpticalMediaDiscPieces's own comment in worker.ts.
 *  3. delete-materialized-pieces-for-disc, given only the mixed disc's two real piece paths, deletes exactly
 *     those two files and nothing else - the other two files' still-pending pieces (from step 2's side effect)
 *     must survive untouched, since they belong to different, not-yet-confirmed discs.
 *
 * NOTE: needs a real Windows desktop/window session (see worker-ipc/call-worker.js's top comment) - run from
 * your own interactive terminal.
 *
 * Usage:
 *   node test-harness/worker-ipc/test-multi-large-file-split.js
 */

const fs = require('fs');
const path = require('path');
const { launchApp, callWorker } = require('./call-worker');
const { assertRealTempDataDirectoryIsSafeToUse } = require('./temp-dir-guard');
const { printTree } = require('../lib/print-tree');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');

const VOLUME_SIZE_BYTES = 500 * 1024 * 1024; // 524,288,000 - must match LARGE_FILE_SPLIT_VOLUME_SIZE_MIB in worker.ts
const LARGE_FILE_BYTES = 600_000_000; // both files - see sizing comment above
const REMAINDER_BYTES = LARGE_FILE_BYTES - VOLUME_SIZE_BYTES; // 75,712,000
const MEDIA_CAPACITY_BYTES = 600_000_000; // same proven-safe constant as test-large-file-split.js

function writeExactSizeFile(filePath, sizeBytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, 'w');
  fs.ftruncateSync(fd, sizeBytes);
  fs.closeSync(fd);
}

async function main() {
  console.log('Checking the app\'s real temp/cache directory is safe to use...');
  const tempDir = assertRealTempDataDirectoryIsSafeToUse();
  fs.mkdirSync(tempDir, { recursive: true });
  console.log(`OK - using: ${tempDir}`);

  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `multi-large-file-split-${runId}`);
  const sourceRoot = path.join(scratchRoot, 'source');
  const fileAPath = path.join(sourceRoot, 'large-files', 'file-a.bin');
  const fileBPath = path.join(sourceRoot, 'large-files', 'file-b.bin');

  console.log(`\nWriting two ${LARGE_FILE_BYTES.toLocaleString()}-byte files (file-a.bin, file-b.bin)...`);
  writeExactSizeFile(fileAPath, LARGE_FILE_BYTES);
  writeExactSizeFile(fileBPath, LARGE_FILE_BYTES);
  printTree(sourceRoot, 'Source tree (before)');

  const results = {};
  let app, win;
  try {
    console.log('\nLaunching the app...');
    ({ app, win } = await launchApp());

    // Avoid racing app.component.ts's own startup housekeeping IPC call - see test-large-file-split.js's
    // identical pause for the full explanation.
    await new Promise((r) => setTimeout(r, 3000));

    console.log('\nCalling partition-backup-to-optical-media (planning only - no 7-Zip yet)...');
    const planResponse = await callWorker(win, 'partition-backup-to-optical-media', {
      rootPath: sourceRoot,
      mediaCapacityInBytes: MEDIA_CAPACITY_BYTES,
      splitLargeFiles: true,
    }, 60 * 1000);

    // Only the large-file-piece discs matter here - isolate discs that contain at least one predicted ".part."
    // path (there are no "normal" files in this fixture at all, so every disc should qualify, but filtering
    // explicitly keeps this test's assumptions self-documenting rather than implicit).
    const discs = planResponse.res;
    const partDiscs = discs
      .map((disc, index) => ({ index, entries: disc.filter((e) => /\.part\.\d+$/i.test(e.path)) }))
      .filter((d) => d.entries.length > 0);

    results.exactlyThreeLargeFileDiscs = partDiscs.length === 3;
    console.log(`  large-file-piece discs planned: ${partDiscs.length} (expected 3)`);
    for (const d of partDiscs) {
      console.log(`    disc[${d.index}]: ${d.entries.map((e) => `${path.basename(e.path)} (${e.stats.size.toLocaleString()} bytes)`).join(', ')}`);
    }

    const mixedDisc = partDiscs.find((d) => d.entries.length === 2);
    results.exactlyOneMixedDiscFound = !!mixedDisc
      && new Set(mixedDisc.entries.map((e) => path.basename(e.path).startsWith('file-a') ? 'a' : 'b')).size === 2;
    console.log(`  a disc mixing pieces from both files was found: ${results.exactlyOneMixedDiscFound}`);

    const soloDiscs = partDiscs.filter((d) => d.entries.length === 1);
    results.twoSoloDiscsFound = soloDiscs.length === 2;
    const soloSizesCorrect = soloDiscs.every((d) => d.entries[0].stats.size === VOLUME_SIZE_BYTES);
    results.soloDiscPiecesAreFullVolumes = soloSizesCorrect;
    console.log(`  two solo (one-file) discs, each exactly one full volume: ${results.twoSoloDiscsFound && soloSizesCorrect}`);

    if (mixedDisc) {
      const mixedRemainderSizesCorrect = mixedDisc.entries.every((e) => e.stats.size === REMAINDER_BYTES);
      results.mixedDiscPiecesAreBothRemainders = mixedRemainderSizesCorrect;
      console.log(`  mixed disc's two pieces are both exactly the ${REMAINDER_BYTES.toLocaleString()}-byte remainder: ${mixedRemainderSizesCorrect}`);

      // 1 & 2: materialize ONLY the mixed disc's pieces - this should real-split BOTH files, so the two solo
      // discs' pieces should come into existence too, as a side effect, without ever being requested.
      const mixedBarePaths = mixedDisc.entries.map((e) => path.relative(tempDir, e.path));
      console.log('\nCalling materialize-optical-media-disc-pieces for ONLY the mixed disc\'s two pieces (runs real 7-Zip on BOTH files)...');
      const materializeResponse = await callWorker(win, 'materialize-optical-media-disc-pieces', {
        dirPath: sourceRoot,
        paths: mixedBarePaths,
      }, 5 * 60 * 1000);
      const realMixedPieces = materializeResponse.res;
      results.materializeReturnedExactlyTwoRealPieces = realMixedPieces.length === 2;
      console.log(`  real pieces returned: ${realMixedPieces.length} (expected 2)`);
      for (const p of realMixedPieces) { console.log(`    ${p.path} - ${p.stats.size.toLocaleString()} bytes`); }
      const realSizesWithinOverheadTolerance = realMixedPieces.every((p) =>
        p.stats.size >= REMAINDER_BYTES && p.stats.size <= REMAINDER_BYTES + 4096);
      results.materializedPiecesAreCorrectSize = realSizesWithinOverheadTolerance;

      printTree(tempDir, 'App temp dir after materializing only the mixed disc');

      // Both solo pieces' real names are predictable (file-a.bin.part.001 / file-b.bin.part.001, the only
      // full-volume piece each file has), and they land in the same temp subdirectory the mixed disc's own
      // pieces were just materialized into.
      const expectedSoloRealPaths = [
        path.join(tempDir, 'large-files', 'file-a.bin.part.001'),
        path.join(tempDir, 'large-files', 'file-b.bin.part.001'),
      ];
      const soloSideEffectExists = expectedSoloRealPaths.every((p) => fs.existsSync(p));
      results.soloDiscPiecesMaterializedAsSideEffect = soloSideEffectExists;
      console.log(`  the two solo discs' pieces exist too, as a side effect of splitting both whole files: ${soloSideEffectExists}`);

      // 3: delete ONLY the mixed disc's real pieces, then confirm the solo pieces (from the side effect above)
      // were NOT touched - scoped deletion must never remove a different, not-yet-confirmed disc's own pieces.
      console.log('\nCalling delete-materialized-pieces-for-disc for ONLY the mixed disc\'s two real pieces...');
      const deleteResponse = await callWorker(win, 'delete-materialized-pieces-for-disc', {
        pieceAbsolutePaths: realMixedPieces.map((p) => path.join(tempDir, p.path)),
      }, 30 * 1000);
      results.deleteReportedCleared = deleteResponse.res && deleteResponse.res.cleared === true;
      console.log(`  delete reported cleared: ${results.deleteReportedCleared}`);

      const mixedPiecesGone = realMixedPieces.every((p) => !fs.existsSync(path.join(tempDir, p.path)));
      results.mixedDiscPiecesActuallyDeleted = mixedPiecesGone;
      console.log(`  mixed disc's own two real pieces are gone: ${mixedPiecesGone}`);

      const soloPiecesSurvived = expectedSoloRealPaths.every((p) => fs.existsSync(p));
      results.soloDiscPiecesSurvivedUntouched = soloPiecesSurvived;
      console.log(`  the OTHER two discs' pieces survived untouched: ${soloPiecesSurvived}`);

      printTree(tempDir, 'App temp dir after deleting only the mixed disc\'s pieces');

      // Clean up the two solo pieces this test's own scoped-delete call deliberately left behind (this test
      // never "confirms" the other two discs - nothing else would clean them up).
      for (const p of expectedSoloRealPaths) { if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); } }
      const largeFilesDir = path.join(tempDir, 'large-files');
      try { if (fs.existsSync(largeFilesDir) && fs.readdirSync(largeFilesDir).length === 0) { fs.rmdirSync(largeFilesDir); } } catch { /* not empty, or already gone - fine */ }
    } else {
      results.mixedDiscPiecesAreBothRemainders = false;
      results.materializeReturnedExactlyTwoRealPieces = false;
      results.materializedPiecesAreCorrectSize = false;
      results.soloDiscPiecesMaterializedAsSideEffect = false;
      results.deleteReportedCleared = false;
      results.mixedDiscPiecesActuallyDeleted = false;
      results.soloDiscPiecesSurvivedUntouched = false;
      console.log('  Skipping materialize/delete checks - no mixed disc was found to test against.');
    }
  } finally {
    if (app) { await app.close().catch(() => {}); }
  }

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

  console.log(`\n${pass ? 'PASS' : 'FAIL'} - multiple large files sharing a disc's plan ${pass ? 'were pooled, materialized, and scoped-deleted correctly.' : 'did not behave as expected, see above.'}`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => {
  console.error('\nTEST ERRORED:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
