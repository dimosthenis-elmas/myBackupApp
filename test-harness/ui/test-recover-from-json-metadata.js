#!/usr/bin/env node
'use strict';

/**
 * End-to-end test of the "Recover data from optical media backup" wizard's OTHER entry point - providing a
 * pre-existing cold storage metadata JSON file (the "Provide cold storage files metadata by importing a JSON
 * file" checkbox on step 1) instead of physically reading every disc's listing one by one. This is a genuinely
 * different code path from test-recover-multi-disc.js: `seedFromExternalMetadata` in
 * optical-disc-backup-data-retriever.component.ts computes each disc's ID directly from the JSON's own file
 * paths (schema-validated first - src/app/schemas/filesMetadata.schema.json), and - if valid - the wizard skips
 * the ENTIRE "insert disc 1, insert disc 2, ..." enumeration dance entirely and jumps straight to file
 * selection. Real discs are still needed afterward, during the RECOVERY phase, to copy the actual bytes of
 * whichever files get selected - only the LISTING step is skipped.
 *
 * ============================================================================================================
 * How the test JSON fixture is built - reusing the app's own real computation, not hand-constructed
 * ============================================================================================================
 * A real cold storage metadata JSON is normally produced by the "backup to optical media" / "add missing files"
 * screens (neither automated yet). Rather than hand-writing JSON that merely LOOKS right against the schema,
 * this script asks the app's own real worker IPC (`get-file-paths-with-stats` - the exact same call
 * readAllDiscsToReconstructTheCompleteBackupFilePaths itself makes when physically reading a real disc) for each
 * simulated disc folder's real file listing + stats, then normalizes the paths the same way the real burn-time
 * flow does before saving (see OPTICAL_DRIVE_LETTER_CONVENTION in disc-id-hash.ts - a fixed "D:\" placeholder
 * prefix, not a real drive letter). The result is structurally identical to what the app would have saved for
 * real, just assembled directly instead of by burning two actual discs first.
 *
 * IT ALSO covers a large file's real split pieces spread across DIFFERENT discs, reassembled during recovery -
 * the same "Partial files detected" merge-offer flow test-recover-multi-disc.js proves for the physical-disc-read
 * path, but exercised here from a JSON-seeded disc listing instead. The genuinely new thing this checks that
 * nothing else does: does a JSON metadata file correctly describe split-file pieces distributed across discs (the
 * pieces are just ordinary files as far as get-file-paths-with-stats/seedFromExternalMetadata are concerned - no
 * special-casing anywhere), and does the merge-offer flow still work when the file tree came from JSON rather than
 * physical enumeration. Same as test-recover-multi-disc.js, the real split pieces can come from either this
 * script splitting the file directly via real 7-Zip (random mode / --json-tree with no split-plan.json - see
 * test-recover-multi-disc.js's own comments for why this bypasses the app's own partitioning IPC entirely) OR
 * already be sitting in the tree from --json-tree's own split-plan.json (see tree-specs/
 * test-recover-from-json-metadata/split-plan.json) - this script detects which happened the same way that one
 * does (the whole file is simply absent, only its ".part.NNN" siblings exist) and skips the live 7-Zip call when
 * it's already done.
 *
 * NOTE: needs a real Windows desktop/window session (see worker-ipc/call-worker.js's top comment) - run from
 * your own interactive terminal.
 *
 * Usage:
 *   node test-harness/ui/test-recover-from-json-metadata.js [--random-tree | --json-tree]
 * See lib/fixture-tree-source.js for what step 1's source tree generation flags do - --json-tree uses this
 * script's own bundled spec under ui/tree-specs/test-recover-from-json-metadata/ (tree-spec.json +
 * split-plan.json), which includes a large file at exactly LARGE_FILE_BYTES (below) under large-files/.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { launchApp, callWorker } = require('../worker-ipc/call-worker');
const { assertRealTempDataDirectoryIsSafeToUse } = require('../worker-ipc/temp-dir-guard');
const { assertNoOpticalMediaAlreadyMounted, buildIso, mountIso, dismountIso } = require('./iso-disc');
const { printTree } = require('../lib/print-tree');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');
const { normalizeForMetadata } = require('../lib/cold-storage-metadata');
const { generateFixtureTree } = require('../lib/fixture-tree-source');
const { resolveSevenZipExecutablePath, splitFileIntoRealParts } = require('../lib/seven-zip');
const { dismissStartupTempClearDialog } = require('../lib/startup-dialogs');

const SPEC_DIR = path.join(__dirname, 'tree-specs', 'test-recover-from-json-metadata');

// Same proven-safe constant as worker-ipc/test-large-file-split.js - see test-recover-multi-disc.js's own
// comment for why this script's fixture-building split calls 7-Zip directly (lib/seven-zip.js) instead of going
// through the app's own partitioning IPC - there's no app-side capacity constant to worry about here any more.
const LARGE_FILE_BYTES = 700_000_000;
const LARGE_FILE_SPLIT_VOLUME_SIZE_MIB = 500; // must match LARGE_FILE_SPLIT_VOLUME_SIZE_MIB in app/workers/worker.ts

/** Prints a periodic "still working" line while `promise` is pending - a real run went silent on the
 *  get-file-paths-with-stats calls below long enough to look hung (it was not - just slower than expected on
 *  that machine at that moment). Same technique as worker-ipc/test-large-file-split.js's withHeartbeat. */
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

async function clickMainMenuButton(win, labelText) {
  const container = win.locator('.grid-container > div').filter({ has: win.locator('h2', { hasText: labelText }) });
  await container.locator('button').click();
}

async function main() {
  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `json-metadata-${runId}`);
  const sourceRoot = path.join(scratchRoot, 'source');
  const disc1Dir = path.join(scratchRoot, 'disc1-files');
  const disc2Dir = path.join(scratchRoot, 'disc2-files');
  const outputRoot = path.join(scratchRoot, 'recovered');
  const disc1IsoPath = path.join(scratchRoot, 'disc1.iso');
  const disc2IsoPath = path.join(scratchRoot, 'disc2.iso');
  const metadataJsonPath = path.join(scratchRoot, 'cold-storage-metadata.json');
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.mkdirSync(disc1Dir, { recursive: true });
  fs.mkdirSync(disc2Dir, { recursive: true });

  // 1. Generate ONE nested source tree (edge cases ON, plus a real large file to be split), split its NORMAL
  //    files evenly between two per-disc folders, preserving each file's relative subdirectory - same approach as
  //    test-recover-multi-disc.js. The large file is handled separately below (its real SPLIT PIECES, not the
  //    whole file, get distributed - one per disc, same as test-recover-multi-disc.js).
  generateFixtureTree({
    root: sourceRoot,
    randomArgs: ['--files', '16', '--max-depth', '3', '--min-size', '0', '--max-size', '20000', '--seed', '335577', '--large-file-bytes', String(LARGE_FILE_BYTES)],
    specDir: SPEC_DIR,
  });
  const manifestPath = `${sourceRoot}.manifest.json`;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const largeFileEntry = manifest.files.find((f) => f.relativePath.startsWith('large-files/'));
  const normalFiles = manifest.files.filter((f) => f !== largeFileEntry);

  // Was the large file fed in ALREADY split (a --json-tree spec with a split-plan.json marking it - see
  // tree-specs/test-recover-from-json-metadata/split-plan.json)? Same detection as test-recover-multi-disc.js:
  // generate-tree-from-json.js's manifest entry always records the ORIGINAL whole-file size/hash even when only
  // the real ".part.NNN" pieces exist on disk, so the reliable check is what's actually sitting on disk.
  const largeFileRelDirOs = largeFileEntry ? path.dirname(largeFileEntry.relativePath).split('/').join(path.sep) : null;
  const largeFileName = largeFileEntry ? path.basename(largeFileEntry.relativePath) : null;
  const largeFileDirAbs = largeFileEntry ? path.join(sourceRoot, largeFileRelDirOs) : null;
  const alreadySplitPartPaths = largeFileEntry && !fs.existsSync(path.join(largeFileDirAbs, largeFileName))
    ? fs.readdirSync(largeFileDirAbs).filter((f) => f.startsWith(`${largeFileName}.part.`)).sort().map((f) => path.join(largeFileDirAbs, f))
    : null;
  const half = Math.ceil(normalFiles.length / 2);
  const disc1Files = normalFiles.slice(0, half);
  const disc2Files = normalFiles.slice(half);
  function copyPreservingDirs(f, destDir) {
    const relOs = f.relativePath.split('/').join(path.sep);
    const destPath = path.join(destDir, relOs);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, relOs), destPath);
  }
  for (const f of disc1Files) { copyPreservingDirs(f, disc1Dir); }
  for (const f of disc2Files) { copyPreservingDirs(f, disc2Dir); }

  const emptyDirRel = path.join('edge-cases', 'empty-directory');
  if (fs.existsSync(path.join(sourceRoot, emptyDirRel))) {
    const edgeCasesWentToDisc1 = disc1Files.some((f) => f.relativePath.startsWith('edge-cases/'));
    fs.mkdirSync(path.join(edgeCasesWentToDisc1 ? disc1Dir : disc2Dir, emptyDirRel), { recursive: true });
  }

  console.log(`\nGenerated ${manifest.fileCount} files - disc 1: ${disc1Files.length} normal, disc 2: ${disc2Files.length} normal, plus the large file's real split pieces (below).`);
  printTree(sourceRoot, 'Source tree (before)');

  console.log('\nChecking no optical media is already mounted...');
  assertNoOpticalMediaAlreadyMounted();

  // Same guard test-recover-multi-disc.js uses before it touches the app's real temp/cache directory - the
  // recovery wizard's own reassembly step may use it, protecting any real, in-progress backup work you might
  // have sitting there.
  console.log('Checking the app\'s real temp/cache directory is safe to use...');
  assertRealTempDataDirectoryIsSafeToUse();

  let app, win, tempPartDir, mountedIsoPath;
  try {
    console.log('\nLaunching the app...');
    ({ app, win } = await launchApp());
    await dismissStartupTempClearDialog(win);

    // Avoid racing app.component.ts's own startup housekeeping IPC call(s) before the first raw callWorker()
    // call below (get-file-paths-with-stats, or - in the --json-tree branch below with no split-plan.json - none
    // of the intervening real-7z-split work that would otherwise provide enough of a natural gap) - see
    // ui/test-add-missing-files.js's identical pause for the full explanation. dismissStartupTempClearDialog
    // above already waits for/clicks past the mandatory startup dialog itself; this pause covers the trailing
    // clear-temp-data-directory call that "Ok" click just triggered.
    await new Promise((r) => setTimeout(r, 3000));

    let partEntries;
    if (alreadySplitPartPaths) {
      // Already split via this spec's own split-plan.json - the real pieces are sitting right in the source
      // tree since generate-tree-from-json.js produced them. No need to ask the app to split anything: that's
      // not what this script exists to prove (see this script's own header comment).
      console.log(`"${largeFileName}" arrived already split into ${alreadySplitPartPaths.length} real piece(s) (this spec's own split-plan.json) - skipping the live app split.`);
      partEntries = alreadySplitPartPaths.map((p) => ({ path: p, stats: { size: fs.statSync(p).size } }));
    } else {
      // Splits the real file directly via 7-Zip (see this script's own header comment for why) rather than
      // going through the app's own partitioning IPC.
      console.log(`Splitting the ${(LARGE_FILE_BYTES / 1e6).toFixed(1)} MB file with real 7-Zip (${LARGE_FILE_SPLIT_VOLUME_SIZE_MIB} MiB volumes)...`);
      const sevenZipPath = resolveSevenZipExecutablePath();
      tempPartDir = path.join(scratchRoot, 'large-file-split');
      const largeFileAbsPath = path.join(largeFileDirAbs, largeFileName);
      const partPaths = splitFileIntoRealParts(sevenZipPath, largeFileAbsPath, tempPartDir, largeFileName, LARGE_FILE_SPLIT_VOLUME_SIZE_MIB);
      partEntries = partPaths.map((p) => ({ path: p, stats: { size: fs.statSync(p).size } }));
    }
    if (partEntries.length !== 2) {
      throw new Error(`Expected exactly 2 real split pieces, got ${partEntries.length}. Something about the size constants (or your own split-plan.json's volumeSizeMiB) no longer holds.`);
    }

    // Distribute the pieces - one per disc, deliberately, so reassembly is proven to work even when the pieces
    // didn't come from the same disc. Placed into disc1Dir/disc2Dir BEFORE the get-file-paths-with-stats calls
    // below, so they show up naturally in the JSON metadata just like any other file - no special-casing needed.
    const originalFileName = largeFileName;
    console.log(`Got ${partEntries.length} real split pieces for "${originalFileName}" - placing one on each disc...`);
    const disc1PartDest = path.join(disc1Dir, 'large-files', path.basename(partEntries[0].path));
    const disc2PartDest = path.join(disc2Dir, 'large-files', path.basename(partEntries[1].path));
    fs.mkdirSync(path.dirname(disc1PartDest), { recursive: true });
    fs.copyFileSync(partEntries[0].path, disc1PartDest);
    fs.mkdirSync(path.dirname(disc2PartDest), { recursive: true });
    fs.copyFileSync(partEntries[1].path, disc2PartDest);
    console.log(`  disc 1: ${path.basename(disc1PartDest)} (${partEntries[0].stats.size.toLocaleString()} bytes)`);
    console.log(`  disc 2: ${path.basename(disc2PartDest)} (${partEntries[1].stats.size.toLocaleString()} bytes)`);

    // 2. Ask the app's own real IPC for each disc folder's real file listing + stats - the exact same call the
    //    app itself makes when physically reading a real disc - then build the metadata JSON from that.
    console.log('\nAsking the app for each disc\'s real file listing (get-file-paths-with-stats)...');
    const disc1Listing = (await withHeartbeat(callWorker(win, 'get-file-paths-with-stats', { dirPath: disc1Dir }), 'get-file-paths-with-stats (disc 1)')).res;
    const disc2Listing = (await withHeartbeat(callWorker(win, 'get-file-paths-with-stats', { dirPath: disc2Dir }), 'get-file-paths-with-stats (disc 2)')).res;

    // See lib/cold-storage-metadata.js's own doc comment for why this must be a literal prefix-string
    // replacement, not path.relative() - a real bug found here (2026-08-27) before this was extracted into that
    // shared module.
    const coldStorageMetadata = [
      normalizeForMetadata(disc1Listing, disc1Dir),
      normalizeForMetadata(disc2Listing, disc2Dir),
    ];
    fs.writeFileSync(metadataJsonPath, JSON.stringify(coldStorageMetadata, null, 2));
    console.log(`Wrote cold storage metadata JSON (disc 1: ${coldStorageMetadata[0].length} entries, disc 2: ${coldStorageMetadata[1].length} entries) to:\n  ${metadataJsonPath}`);

    // 3. Build both discs. Neither is mounted yet at this point - unlike test-recover-multi-disc.js, the JSON
    //    path skips the enumeration/listing phase entirely, so the first disc only needs to be mounted right
    //    before the RECOVERY phase starts asking for one.
    printTree(disc1Dir, 'Disc 1 contents (before burning to .iso)');
    printTree(disc2Dir, 'Disc 2 contents (before burning to .iso)');
    console.log('\nBuilding disc1.iso and disc2.iso...');
    buildIso(disc1Dir, disc1IsoPath, 'TESTDISC1');
    buildIso(disc2Dir, disc2IsoPath, 'TESTDISC2');

    await app.evaluate(({ dialog }, paths) => {
      const queue = [...paths];
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [queue.shift()] });
    }, [outputRoot, metadataJsonPath]);

    const WATCH_PAUSE_MS = 5000;
    const step = async (label, fn) => {
      process.stdout.write(`  [ ] ${label} ... `);
      try {
        await fn();
      } catch (e) {
        console.log('FAILED');
        const screenshotPath = path.join(FIXTURES_ROOT, `optical-backup-ui-json-metadata-test-failure-${runId}.png`);
        try {
          await win.screenshot({ path: screenshotPath });
          console.log(`  Screenshot of the app at the point of failure saved to: ${screenshotPath}`);
        } catch { /* app/window may already be gone */ }
        throw e;
      }
      console.log('done');
      await new Promise((r) => setTimeout(r, WATCH_PAUSE_MS));
    };

    // --- Phase A: step 1 - output folder, check the JSON checkbox, provide the JSON, Next ---

    await step('main menu -> Recover data from optical media backup', () =>
      clickMainMenuButton(win, 'Recover data from optical media backup'));

    await step('click "Select a directory to save the recovered files"', () =>
      win.getByRole('button', { name: 'Select a directory to save the recovered files' }).click({ timeout: 15_000 }));

    await step('wait for the chosen output path to appear on screen', () =>
      win.getByText(outputRoot, { exact: true }).waitFor({ timeout: 10_000 }));

    await step('check "Provide cold storage files metadata by importing a JSON file"', () =>
      win.getByRole('checkbox', { name: 'Provide cold storage files metadata by importing a JSON file' }).click({ timeout: 15_000 }));

    await step('click "Select JSON file"', () =>
      win.getByRole('button', { name: 'Select JSON file' }).click({ timeout: 15_000 }));

    await step('wait for the chosen JSON path to appear on screen', () =>
      win.getByText(metadataJsonPath, { exact: true }).waitFor({ timeout: 10_000 }));

    // The mat-chip above appears the instant a path is chosen - BEFORE afterJSONpathIsGiven() actually finishes
    // reading+schema-validating it over IPC (see getJSON() in recover-data-from-optical-media.component.ts:
    // externalMetadataJSONpath is set, THEN validation is awaited, not the other way round). Clicking "Next"
    // before that validation IPC round trip completes would hit step1()'s own "no valid JSON file has been
    // selected yet" guard instead of proceeding - a small deliberate pause here avoids that race, same reasoning
    // as the pause documented in test-recover-single-disc.js's own README.
    await new Promise((r) => setTimeout(r, 1500));

    await step('click "Next" (validates + seeds from the JSON - no disc reads needed)', () =>
      win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 }));

    // --- Phase B: straight to file selection (step_2's "insert disc" screen is skipped entirely) ---

    await step('wait for the combined files tree to finish rendering (up to 60s)', () =>
      win.getByRole('checkbox', { name: 'Select all' }).waitFor({ state: 'visible', timeout: 60_000 }));

    await step('click "Select all"', () =>
      win.getByRole('checkbox', { name: 'Select all' }).click({ timeout: 15_000 }));

    await step('click "Recover selected data"', () =>
      win.getByRole('button', { name: 'Recover selected data' }).click({ timeout: 15_000 }));

    // Mount disc1 now - right before confirming, so it's already inserted by the time recoverAllFilesFromAllDiscs
    // starts waiting for a disc, the same "mount before the app starts polling" rule test-recover-multi-disc.js's
    // header explains in full.
    await step('mount disc1 (ready for the recovery phase, which starts right after this dialog)', async () => {
      mountIso(disc1IsoPath);
      mountedIsoPath = disc1IsoPath;
    });

    await step('click "Ok" on the "you will need to insert disc(s)" info dialog', () =>
      win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 }));

    await step('wait for disc 1\'s files to be recovered (up to 60s)', () =>
      win.getByRole('button', { name: 'Continue with the next disc' }).waitFor({ timeout: 60_000 }));

    await step('swap discs: dismount disc1, mount disc2', async () => {
      dismountIso(disc1IsoPath);
      mountIso(disc2IsoPath);
      mountedIsoPath = disc2IsoPath;
    });

    // Small deliberate pause before clicking - see test-recover-single-disc.js's own README note on why.
    await new Promise((r) => setTimeout(r, 1000));

    await step('click "Continue with the next disc"', () =>
      win.getByRole('button', { name: 'Continue with the next disc' }).click({ timeout: 15_000 }));

    // --- Phase C: the large file's two pieces (one from each disc) were both selected and just got copied - the
    //     wizard now offers to reassemble them, exactly like test-recover-multi-disc.js, but with a JSON-seeded
    //     disc listing behind it this time instead of a physically-read one. ---

    await step('wait for disc 2\'s files to be recovered, click "Yes, reassemble" on "Partial files detected" (up to 60s)', () =>
      win.getByRole('button', { name: 'Yes, reassemble', exact: true }).click({ timeout: 60_000 }));

    await step('wait for the merge to finish, click "Ok" on "Reassembly successful" (up to 60s)', () =>
      win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 60_000 }));

    await step('click "Ok" on "Data recovery successful"', () =>
      win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 }));

    console.log('Wizard completed.');
  } finally {
    if (app) { await app.close().catch(() => {}); }
    if (mountedIsoPath) {
      console.log('\nDismounting whichever disc is still mounted...');
      dismountIso(mountedIsoPath);
    }
    // No separate tempPartDir cleanup needed here any more: it's now a plain subdirectory of scratchRoot (this
    // script's own split, via real 7-Zip directly), not the app's real temp/cache directory, so it's already
    // covered by scratchRoot's own pass/fail cleanup below - see test-recover-multi-disc.js's identical comment.
  }

  // 4. Verify: recovered folder should exactly match the original combined manifest, including the large file
  //    reassembled from its two cross-disc pieces (not the .part.NNN pieces themselves, which the app deletes
  //    after a successful merge) - the manifest's entry for it already has the correct original hash/size.
  printTree(outputRoot, 'Recovered tree (after)');
  console.log('\nVerifying recovered files against the manifest...');
  let verifyPassed = false;
  try {
    execFileSync(process.execPath, [
      path.join(__dirname, '../verify-manifest.js'),
      '--manifest', manifestPath,
      '--dir', outputRoot,
    ], { stdio: 'inherit' });
    verifyPassed = true;
  } catch {
    verifyPassed = false;
  }

  if (verifyPassed) {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  } else {
    console.log(`\nLeaving scratch files in place for inspection: ${scratchRoot}`);
  }

  console.log(`\n${verifyPassed ? 'PASS' : 'FAIL'} - JSON-metadata recovery ${verifyPassed ? 'correctly skipped disc enumeration and recovered every file (including the reassembled large file) with matching content.' : 'did not produce a correct result, see verify-manifest output above.'}`);
  process.exitCode = verifyPassed ? 0 : 1;
}

main().catch((e) => {
  const message = (e && e.message) || String(e);
  const fullDetail = (e && e.stack) ? e.stack : message;
  if (/closed|Target .*(closed|crashed)/i.test(message)) {
    console.error(`\nTEST ERRORED: the app window was closed before the test finished (${message}).`);
  } else {
    const logPath = path.join(FIXTURES_ROOT, `optical-backup-ui-json-metadata-test-error-${Date.now()}.log`);
    try { fs.writeFileSync(logPath, fullDetail); } catch { /* best effort */ }
    console.error(`\nTEST ERRORED: ${message}`);
    console.error(`Full details saved to: ${logPath}`);
  }
  process.exitCode = 1;
});
