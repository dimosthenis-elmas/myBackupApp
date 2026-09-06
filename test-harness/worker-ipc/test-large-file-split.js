#!/usr/bin/env node
'use strict';

/**
 * Exercises the REAL "split a too-large-for-any-disc file" path through the app's REAL worker IPC - no app
 * source touched, no UI clicking. This is the one piece worker-ipc/test-partitioning.js and worker-ipc/
 * test-merge.js deliberately don't cover for real:
 *  - test-partitioning.js never sets splitLargeFiles, so it never exercises this code path at all.
 *  - test-merge.js proves the REASSEMBLY side thoroughly, but produces its own small multi-volume 7-Zip split
 *    directly (bypassing this app's own splitting code) to avoid needing a 500MB+ file.
 *
 * partitionBackupToOpticalMedia PLANS using pure arithmetic only (estimateLargeFileSplitPieces in worker.ts) -
 * it never invokes 7-Zip itself any more. The real split only happens later, lazily, when
 * materialize-optical-media-disc-pieces is called for a disc that actually needs one of a large file's pieces -
 * mirroring exactly how the real burn wizards call it (see backup-to-optical-media.component.ts /
 * add-missing-files-to-optical-media-cold-storage.component.ts). This script exercises BOTH steps in that same
 * order: partition (fast, no filesystem side effects for the split path) then materialize (the real
 * `7z -v500m -mx0 a ...` call), then feeds the REAL resulting part files into the already-proven
 * merge-file-parts to confirm the whole real round trip is byte-for-byte correct.
 *
 * Heavier than every other worker-ipc script here: generates 700 MB of random data, splits it, then reassembles
 * it (~700 MB read+write again) - temporarily uses a bit over 1.5 GB of scratch/temp disk space, all cleaned up
 * on success.
 *
 * MEDIA_CAPACITY_BYTES below is NOT an arbitrary choice - see its own comment. Getting this wrong (specifically:
 * too small) triggers a REAL infinite loop in partitionBackupToOpticalMedia, found the hard way while building
 * this test (2026-08-27) - see that comment for the full story, and see git history for this file if you ever
 * need the account of how it was actually diagnosed (ruled out disk speed and Windows Defender first, both red
 * herrings, before finding the real cause by re-reading the partitioning loop's own logic).
 *
 * Splitting itself is fast on reasonable hardware (confirmed: `7z -v500m -mx0` on a ~700 MB file takes well
 * under a second standalone). Windows Defender (or whatever real-time antivirus is active) MAY still add real,
 * one-time delay the first time a *different* process touches freshly-written large files afterward - if this
 * runs unexpectedly slowly despite the fix above, that's the next thing to suspect (an exclusion for this repo's
 * `appData\tempFilesCanBeDeleted\` folder removes that specific cost - your call, this script does not touch
 * antivirus settings itself). The heartbeat below keeps printing throughout either way.
 *
 * Touches the app's REAL shared temp/cache directory (no per-test override exists - see temp-dir-guard.js) -
 * refuses to run unless that directory is currently empty (besides the app's own ownership marker), same as
 * test-merge.js.
 *
 * NOTE: needs a real Windows desktop/window session (see call-worker.js's top comment) - run from your own
 * interactive terminal.
 *
 * Usage:
 *   node test-harness/worker-ipc/test-large-file-split.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { launchApp, callWorker } = require('./call-worker');
const { assertRealTempDataDirectoryIsSafeToUse } = require('./temp-dir-guard');
const { printTree } = require('../lib/print-tree');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');

// Must match LARGE_FILE_SPLIT_VOLUME_SIZE_MIB in app/workers/worker.ts (500 MiB) - not importable across the
// Electron/plain-Node boundary, so restated here with a comment pointing back at the source of truth.
const EXPECTED_VOLUME_SIZE_BYTES = 500 * 1024 * 1024; // 524,288,000 - see LARGE_FILE_SPLIT_VOLUME_SIZE_MIB
// 700 MB (not MiB) - comfortably over one full volume, so the real split produces exactly 2 real pieces (one
// full 500 MiB volume + a remainder), the minimum needed to genuinely prove multi-piece splitting.
const LARGE_FILE_BYTES = 700_000_000;
// IMPORTANT - MUST stay strictly above EXPECTED_VOLUME_SIZE_BYTES even after the app's own 0.95
// maxOpticalMediumRepletionRatio margin (see appData/config.json), i.e. MEDIA_CAPACITY_BYTES * 0.95 must exceed
// EXPECTED_VOLUME_SIZE_BYTES. Found the hard way (2026-08-27): partitionBackupToOpticalMedia's second
// partitioning pass - the one that assigns each real SPLIT PIECE to a "disc" - has no guard for "this one piece
// alone is bigger than the disc capacity" (unlike the equivalent, earlier pass for ordinary files, which
// explicitly detects that and stops). If a single split piece can never fit under mediaCapacityInBytes, the
// while loop that is supposed to remove already-assigned pieces from the remaining list removes NOTHING (nothing
// ever gets assigned), so it spins forever - a real, if narrow/latent, app bug (unreachable through the real UI,
// since the smallest real medium - a 700MB CD - is always bigger than a 500 MiB piece; only reachable by calling
// partitionBackupToOpticalMedia directly, the way this test does, with too small a capacity). At the same time
// this constant must stay BELOW LARGE_FILE_BYTES (after the same ratio) so the large file still gets classified
// as "too large for a single disc" and routed through the split path at all. 600 MB satisfies both: 600,000,000
// * 0.95 = 570,000,000, which is > EXPECTED_VOLUME_SIZE_BYTES (524,288,000 - each piece fits) and < 700,000,000
// (the whole file still doesn't).
const MEDIA_CAPACITY_BYTES = 600_000_000;

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** Prints a periodic "still working" line while `promise` is pending - the real 7-Zip split/merge calls below
 *  are single blocking IPC round trips with no built-in progress reporting, and this test genuinely takes real
 *  time on ~515 MB. Without this, a run can go long enough with zero output to look hung (this is exactly what
 *  happened on a real run while building this - the window got closed thinking it had stuck) - so this is here
 *  purely to keep confirming "still alive, still working" at a steady cadence, not to report real progress. */
async function withHeartbeat(promise, label, intervalMs = 3000) {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    console.log(`    ... still working on "${label}" (${((Date.now() - startedAt) / 1000).toFixed(0)}s elapsed)`);
  }, intervalMs);
  try {
    return await promise;
  } finally {
    clearInterval(timer);
  }
}

async function main() {
  console.log('Checking the app\'s real temp/cache directory is safe to use...');
  const tempDir = assertRealTempDataDirectoryIsSafeToUse();
  fs.mkdirSync(tempDir, { recursive: true });
  console.log(`OK - using: ${tempDir}`);

  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `large-file-split-${runId}`);
  const sourceRoot = path.join(scratchRoot, 'source');

  console.log(`\nGenerating test source tree at ${sourceRoot} (this includes a real ${(LARGE_FILE_BYTES / 1e6).toFixed(1)} MB file - may take a little while)...`);
  execFileSync(process.execPath, [
    path.join(__dirname, '../generate-random-tree.js'),
    '--root', sourceRoot,
    '--files', '5',
    '--max-depth', '2',
    '--min-size', '0',
    '--max-size', '20000',
    '--seed', '135791',
    '--no-edge-cases',
    '--disk-capacity-bytes', String(MEDIA_CAPACITY_BYTES),
    '--large-file-bytes', String(LARGE_FILE_BYTES),
  ], { stdio: 'inherit' });
  const manifestPath = `${sourceRoot}.manifest.json`;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const largeFileEntry = manifest.files.find((f) => f.relativePath.startsWith('large-files/'));
  const normalFileEntries = manifest.files.filter((f) => f !== largeFileEntry);
  console.log(`\nGenerated ${manifest.fileCount} files (${normalFileEntries.length} normal + 1 large: ${largeFileEntry.sizeBytes.toLocaleString()} bytes).`);
  printTree(sourceRoot, 'Source tree (before)');

  const results = {};
  let app, win;
  try {
    console.log('\nLaunching the app...');
    ({ app, win } = await launchApp());

    // Avoid racing app.component.ts's own startup housekeeping IPC call - see ui/test-add-missing-files.js's
    // and ui/capture-recover-data-gif.js's identical pauses for the same explanation:
    // WorkerCommunicator.sendAndAwaitResponse removes ALL 'message-from-worker' listeners (not just its own)
    // once ANY call resolves - so if the startup housekeeping call's own response arrives while this script's
    // callWorker() below is still waiting for its own, that cleanup wipes this listener out too, and the real
    // response - whenever it eventually arrives - has nothing left listening for it. This script never had this
    // pause before because the old, real (multi-minute) 7-Zip split was slow enough that the race rarely
    // mattered in practice; now that planning is near-instant pure arithmetic, it's hit far more reliably.
    await new Promise((r) => setTimeout(r, 3000));

    // This script drives the worker directly over raw IPC (not through the app's own UI), so it generates its
    // own session ID up front - see SESSION_FOLDER_NAME_PATTERN's own comment in worker.ts for why every job
    // needs one and what it isolates.
    const sessionId = 'session-' + Date.now();
    const sessionTempDir = path.join(tempDir, sessionId);

    console.log('\nCalling partition-backup-to-optical-media with splitLargeFiles=true (planning only - no 7-Zip yet)...');
    const response = await withHeartbeat(
      callWorker(win, 'partition-backup-to-optical-media', {
        rootPath: sourceRoot,
        mediaCapacityInBytes: MEDIA_CAPACITY_BYTES,
        splitLargeFiles: true,
        sessionId,
      }, 60 * 1000), // planning is now pure arithmetic - should be near-instant even for a 700 MB file
      'partition-backup-to-optical-media',
    );

    const allEntries = response.res.flat();
    const largeFileAbsPath = path.join(sourceRoot, largeFileEntry.relativePath.split('/').join(path.sep));

    // 1. The original large file must NOT appear anywhere in the result in its original, unsplit form - only
    //    its predicted split pieces should.
    results.originalLargeFileExcluded = !allEntries.some((e) => e.path === largeFileAbsPath);
    console.log(`  original large file excluded from the result: ${results.originalLargeFileExcluded}`);

    // 2. Every normal (non-large) file should still appear exactly once, unsplit - proves splitting one file
    //    doesn't disturb how the rest of a normal backup gets partitioned (test-partitioning.js already proves
    //    the partitioning algorithm itself thoroughly - this is just a coexistence sanity check).
    const normalFilesFound = normalFileEntries.every((f) => {
      const absPath = path.join(sourceRoot, f.relativePath.split('/').join(path.sep));
      return allEntries.some((e) => e.path === absPath && e.stats.size === f.sizeBytes);
    });
    results.normalFilesStillPartitionedCorrectly = normalFilesFound;
    console.log(`  all ${normalFileEntries.length} normal files still present, unsplit: ${normalFilesFound}`);

    // 3. Exactly 2 PREDICTED part-file paths - identified by the app's own PART_FILE_PATTERN naming convention
    //    alone (none of our small generated files can ever match it) - and, the actual point of planning no
    //    longer touching 7-Zip at all: neither predicted path may exist on disk yet.
    const predictedPartEntries = allEntries
      .filter((e) => /\.part\.\d+$/i.test(e.path))
      .sort((a, b) => a.path.localeCompare(b.path));
    results.exactlyTwoPartsPredicted = predictedPartEntries.length === 2;
    console.log(`  predicted part-file paths: ${predictedPartEntries.length} (expected 2)`);
    const noPartFilesMaterializedYet = predictedPartEntries.every((e) => !fs.existsSync(e.path));
    results.planningHadNoFilesystemSideEffects = noPartFilesMaterializedYet;
    console.log(`  none of them physically exist yet (planning is side-effect-free): ${noPartFilesMaterializedYet}`);
    if (predictedPartEntries.length === 2) {
      // The ESTIMATE is plain arithmetic with no 7-Zip archive overhead folded in (see estimateLargeFileSplitPieces
      // in worker.ts) - so, unlike the real split checked after materialization below, both predicted sizes are
      // exact: the first is exactly one full volume, the second is exactly the raw remainder.
      const [predictedFirst, predictedSecond] = predictedPartEntries;
      const predictedFirstCorrect = predictedFirst.stats.size === EXPECTED_VOLUME_SIZE_BYTES;
      const predictedSecondCorrect = predictedSecond.stats.size === (LARGE_FILE_BYTES - EXPECTED_VOLUME_SIZE_BYTES);
      results.predictedSizesAreExactlyRight = predictedFirstCorrect && predictedSecondCorrect;
      console.log(`    predicted part 1: ${predictedFirst.stats.size.toLocaleString()} bytes (expected exactly ${EXPECTED_VOLUME_SIZE_BYTES.toLocaleString()}) - ${predictedFirstCorrect ? 'OK' : 'WRONG'}`);
      console.log(`    predicted part 2: ${predictedSecond.stats.size.toLocaleString()} bytes (expected exactly ${(LARGE_FILE_BYTES - EXPECTED_VOLUME_SIZE_BYTES).toLocaleString()}) - ${predictedSecondCorrect ? 'OK' : 'WRONG'}`);
    } else {
      results.predictedSizesAreExactlyRight = false;
    }

    // 4. Materialize this "disc"'s pieces - the ONLY point that actually invokes 7-Zip - passing bare-relative
    //    paths, the same convention materializeOpticalMediaDiscPieces expects and the real burn wizards already
    //    hand it. Predicted split-piece paths (unlike ordinary files) are rooted under the session's own temp
    //    subdirectory, not sourceRoot (see estimateLargeFileSplitPieces/partitionBackupToOpticalMedia in
    //    worker.ts) - so the relative path has to be computed against sessionTempDir, not sourceRoot, or
    //    path.relative() produces a "../../.." climb between two unrelated trees instead of the short, sensible
    //    relative path the real burn wizards already produce by stripping whichever of sourcePath/
    //    tempDataDirectoryPath actually matches (see backup-to-optical-media.component.ts's
    //    WriteToOpticalMediaProceed for that exact idiom - found for real testing this script against the actual
    //    worker).
    const bareRelativePartPaths = predictedPartEntries.map((e) => path.relative(sessionTempDir, e.path));
    console.log('\nCalling materialize-optical-media-disc-pieces (runs the real 7-Zip split)...');
    const materializeResponse = await withHeartbeat(
      callWorker(win, 'materialize-optical-media-disc-pieces', {
        dirPath: sourceRoot,
        paths: bareRelativePartPaths,
        sessionId,
      }, 10 * 60 * 1000), // generous timeout - real disk I/O on ~515 MB
      'materialize-optical-media-disc-pieces',
    );
    const materializedEntries = materializeResponse.res;

    // 5. Exactly 2 real part files, sitting in the app's real session temp directory, with the exact sizes a
    //    genuine "-v500m" split of this exact file size must produce - the actual point of this test. Separately
    //    double-checked (case-insensitively - Windows paths, don't want a spurious drive-letter-casing mismatch
    //    to hide a real problem) that they really did land under the session temp directory.
    const partEntries = materializedEntries
      .map((e) => ({ path: path.join(sessionTempDir, e.path), stats: e.stats }))
      .sort((a, b) => a.path.localeCompare(b.path));
    results.exactlyTwoRealPartFilesProduced = partEntries.length === 2;
    console.log(`  real part files produced: ${partEntries.length} (expected 2)`);
    const partsLandedInTempDir = partEntries.every((e) => e.path.toLowerCase().startsWith(sessionTempDir.toLowerCase()));
    results.partsLandedInRealTempDir = partsLandedInTempDir;
    console.log(`  all part files under the real session temp dir: ${partsLandedInTempDir}`);
    if (partEntries.length === 2) {
      const [first, second] = partEntries;
      // `-v500m -mx0` still wraps the data in a real 7z ARCHIVE (headers/CRC/filename metadata), not a raw
      // byte-for-byte split - so the total archived size is always a little bigger than the original file, not
      // identical (confirmed on a real run: 122-146 bytes of overhead for a single-file store-mode archive,
      // varying slightly run to run - not a fixed constant worth hardcoding, which is also why
      // estimateLargeFileSplitPieces in worker.ts deliberately does NOT try to predict it - see its own
      // comment). The first volume, however, IS always exactly EXPECTED_VOLUME_SIZE_BYTES (7-Zip only ever
      // truncates the LAST volume) - confirmed identically on every real run so far, so that one is checked for
      // an exact match.
      const MAX_PLAUSIBLE_7Z_ARCHIVE_OVERHEAD_BYTES = 4096; // generous margin over the observed 122-146 bytes
      const totalSize = first.stats.size + second.stats.size;
      const firstSizeCorrect = first.stats.size === EXPECTED_VOLUME_SIZE_BYTES;
      const totalSizeCorrect = totalSize >= LARGE_FILE_BYTES && totalSize <= (LARGE_FILE_BYTES + MAX_PLAUSIBLE_7Z_ARCHIVE_OVERHEAD_BYTES);
      results.partSizesAreExactlyRight = firstSizeCorrect && totalSizeCorrect;
      console.log(`    part 1: ${first.stats.size.toLocaleString()} bytes (expected exactly ${EXPECTED_VOLUME_SIZE_BYTES.toLocaleString()}) - ${firstSizeCorrect ? 'OK' : 'WRONG'}`);
      console.log(`    part 2: ${second.stats.size.toLocaleString()} bytes (the remainder, size not asserted exactly - see comment above)`);
      console.log(`    total (${totalSize.toLocaleString()} bytes) is original size + small 7z archive overhead: ${totalSizeCorrect}`);

      // 6. Feed the REAL part files into the already-proven merge-file-parts, and confirm the reassembled file's
      //    fingerprint matches the ORIGINAL large file's fingerprint exactly (recorded by generate-random-tree.js
      //    while writing it, streamed - no need to re-read the ~515 MB file separately here).
      const originalFileName = path.basename(largeFileEntry.relativePath);
      printTree(path.dirname(partEntries[0].path), 'App temp dir - split pieces (before merge)');
      console.log(`\nCalling merge-file-parts on the real split output ("${originalFileName}")...`);
      const mergeResponse = await withHeartbeat(
        callWorker(win, 'merge-file-parts', {
          partFilePaths: partEntries.map((e) => e.path),
          originalFileName,
        }, 10 * 60 * 1000),
        'merge-file-parts',
      );

      // mergeFileParts writes the reassembled file next to the part files it was given (outputDir =
      // dirname(partFilePaths[0]) in worker.ts) - which mirrors the large file's original relative subdirectory
      // (e.g. "large-files\"), NOT tempDir's own root. Reusing partEntries[0]'s own directory here guarantees
      // this matches the app's real logic exactly, rather than reconstructing that relative path by hand (a
      // constructed-by-hand version of this path.join(tempDir, originalFileName) is what silently pointed at the
      // wrong location on a real run - see git history for this file, 2026-08-27).
      const reassembledPath = path.join(path.dirname(partEntries[0].path), originalFileName);
      printTree(path.dirname(partEntries[0].path), 'App temp dir (after merge)');
      const reassembledExists = fs.existsSync(reassembledPath);
      const reassembledHash = reassembledExists ? sha256File(reassembledPath) : null;
      results.merged = mergeResponse.res.merged === true;
      results.reassembledFileMatchesOriginalHash = reassembledExists && reassembledHash === largeFileEntry.sha256;
      results.partFilesCleanedUpAfterMerge = partEntries.every((e) => !fs.existsSync(e.path));
      console.log(`  merged flag                : ${mergeResponse.res.merged}`);
      console.log(`  reassembled hash matches original: ${results.reassembledFileMatchesOriginalHash}`);
      console.log(`  part files cleaned up by the app  : ${results.partFilesCleanedUpAfterMerge}`);

      if (reassembledExists) {
        fs.rmSync(reassembledPath, { force: true });
        // Also remove the subdirectory partitionBackupToOpticalMedia created for the split pieces (e.g.
        // "large-files\") if that left it empty - tidiness only, harmless either way since it's inside the
        // app's own disposable temp dir, but rmdirSync only succeeds on an empty directory so this is safe to
        // attempt unconditionally. Then remove this run's own now-empty session-<id> folder too - left behind
        // otherwise, it would make the NEXT script's assertRealTempDataDirectoryIsSafeToUse call refuse to run
        // (it can't tell "an empty leftover session folder" apart from real pending data).
        try { fs.rmdirSync(path.dirname(reassembledPath)); } catch { /* not empty, or already gone - fine */ }
        try { fs.rmdirSync(sessionTempDir); } catch { /* not empty, or already gone - fine */ }
      }
    } else {
      results.partSizesAreExactlyRight = false;
      results.merged = false;
      results.reassembledFileMatchesOriginalHash = false;
      results.partFilesCleanedUpAfterMerge = false;
      console.log('  Skipping merge check - did not get exactly 2 real part files.');
    }
  } finally {
    if (app) { await app.close().catch(() => {}); }
  }

  const pass = Object.values(results).every(Boolean);

  console.log('\nSummary:');
  for (const [check, ok] of Object.entries(results)) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${check}`);
  }

  // Clean up our own scratch source tree (~515 MB) regardless of pass/fail - only files this script itself
  // knows about. Any leftover real part files (only if the merge step above did not run/succeed) are
  // intentionally left in the app's real temp directory on failure, same as test-merge.js, so they can be
  // inspected rather than silently discarded.
  if (pass) {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  } else {
    console.log(`\nLeaving scratch files in place for inspection: ${scratchRoot}`);
  }

  console.log(`\n${pass ? 'PASS' : 'FAIL'} - large-file splitting (partition-backup-to-optical-media estimate + materialize-optical-media-disc-pieces real split) ${pass ? 'produced correct, byte-for-byte-reassemblable pieces.' : 'did not behave as expected, see above.'}`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => {
  console.error('\nTEST ERRORED:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
