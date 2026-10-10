#!/usr/bin/env node
'use strict';

/**
 * End-to-end test of the "Recover data from optical media backup" wizard across TWO discs, not one - the
 * natural next step beyond test-recover-single-disc.js (which deliberately scoped to a single disc - see its own
 * header). Drives the real app through Playwright, using two mounted .iso files in place of two physical discs.
 *
 * ============================================================================================================
 * Why this needed real investigation before it could be built safely: waitForOpticalDiskToBeMounted() (worker.ts)
 * ============================================================================================================
 * just checks "is ANY optical drive currently showing media" - it does NOT wait for an eject-then-reinsert
 * transition. So if the PREVIOUS disc were left mounted when the app starts waiting for the NEXT one, it would
 * immediately re-detect the same old disc - which the app's own enumeration step correctly rejects with "you
 * already processed this disc" (see readAllDiscsToReconstructTheCompleteBackupFilePaths in
 * optical-disc-backup-data-retriever.component.ts). So this script always DISMOUNTS the disc that was mounted
 * before MOUNTING the next one and before clicking whatever button makes the app start waiting again - never the
 * other order. Confirmed by reading worker.ts's OPTICAL_DISC_POLL_SCRIPT directly, not guessed.
 *
 * There are TWO separate disc-swap cycles in this one wizard, not one:
 *  1. Enumeration (step_2): the app reads each disc's file LISTING only, one at a time, to build the combined
 *     tree you pick files from.
 *  2. Recovery (step_5): after you pick files, the app asks you to physically re-insert whichever discs are
 *     actually needed (in any order) and copies the real bytes from each, one at a time.
 * This script mounts disc2 last during enumeration (step 1) and lets the app detect it AGAIN, still mounted, as
 * the first disc of the recovery phase (step 2) - no swap needed there, since it's already exactly what's
 * inserted; only THEN does it swap to disc1 for the second recovery pass.
 *
 * The source tree is a real NESTED structure (--max-depth 4 - this tool's own max, edge cases ON: a zero-byte
 * file, a unicode/space filename, an empty directory - plus two MORE empty directories placed by this script
 * itself, one per disc), split evenly between the two discs while preserving each file's relative subdirectory.
 * A shared parent directory legitimately ending up split across two different physical discs is normal for how
 * real large backups get spread across media.
 *
 * IT ALSO covers a large file's real split pieces spread across DIFFERENT discs - but NOT reassembled: the pieces
 * come back exactly as the plain files they are, because this is the physical-disc-read path and a disc read
 * carries NO cold storage metadata at all. The wizard reassembles a file ONLY when its metadata entry says
 * `isPartial: true` (see ipc.interfaces.ts's ColdStorageMetadata - the flag a real burn writes via
 * createOpticalMediaDiscPartials, and the sole authority for "this is a piece": a name is never consulted), so a
 * disc read never flags anything, "Partial files detected" must never appear here, and nothing is ever merged or
 * deleted. That is the assertion this script exists to make, and it's why the pieces are deliberately placed on
 * two DIFFERENT discs: each must be recovered, from its own disc, as a byte-identical copy of the piece that was
 * burned. The merge-offer flow itself (which needs metadata) is covered by ui/test-recover-from-json-metadata.js
 * and ui/test-long-names-split-file.js, both seeded from a JSON whose piece entries carry that flag. The real
 * split pieces can come from either of two places:
 *   - Random mode (default) / --json-tree with no split-plan.json: the tree gets ONE WHOLE large file, and this
 *     script splits it directly via real 7-Zip (lib/seven-zip.js's splitFileIntoRealParts - the same helper
 *     generate-tree-from-json.js's own --split-plan option uses, same 500 MiB volumes as
 *     test-large-file-split.js). Deliberately bypasses the app's own partitioning IPC entirely - this script
 *     needs to prove the recovery WIZARD's own handling of pieces, not that the app can plan/split a file (already
 *     proven directly by worker-ipc/test-large-file-split.js), so there's no reason to couple this fixture-
 *     building step to that machinery.
 *   - --json-tree with a split-plan.json marking the large file: generate-tree-from-json.js already produced the
 *     real split pieces sitting in the tree by the time this script even looks - see tree-specs/
 *     test-recover-multi-disc/split-plan.json - so this script detects that (the whole file is simply absent,
 *     only its "<name>.part.NNN" siblings exist) and skips the live 7-Zip call entirely.
 * Either way, one piece goes on each disc, deliberately, so recovering them proves a piece is copied correctly
 * even when it didn't come from the same disc as its sibling.
 *
 * It never touches the app's real temp/cache folder: nothing here is ever merged (see above), and a merge is the
 * only thing in this wizard that uses it.
 *
 * NOTE: needs a real Windows desktop/window session (see worker-ipc/call-worker.js's top comment) - run from
 * your own interactive terminal.
 *
 * Usage:
 *   node test-harness/ui/test-recover-multi-disc.js [--random-tree | --json-tree]
 * See lib/fixture-tree-source.js for what step 1's source tree generation flags do - --json-tree uses this
 * script's own bundled spec under ui/tree-specs/test-recover-multi-disc/ (tree-spec.json + split-plan.json),
 * which includes a large file at exactly LARGE_FILE_BYTES (below) under large-files/ - required for the
 * split-piece math this script asserts on to come out the same regardless of which generator built the tree.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { launchApp } = require('../worker-ipc/call-worker');
const { assertNoOpticalMediaAlreadyMounted, buildIso, mountIso, dismountIso } = require('./iso-disc');
const { printTree } = require('../lib/print-tree');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');
const { generateFixtureTree } = require('../lib/fixture-tree-source');
const { resolveSevenZipExecutablePath, splitFileIntoRealParts } = require('../lib/seven-zip');

const SPEC_DIR = path.join(__dirname, 'tree-specs', 'test-recover-multi-disc');

// Same proven-safe constant as worker-ipc/test-large-file-split.js - LARGE_FILE_BYTES must exceed one real 500
// MiB volume so a genuine multi-piece split happens. This script's own fixture-building split (below) calls
// 7-Zip directly, bypassing the app's partitioning logic entirely - what this script needs to prove is the
// recovery WIZARD's own handling of pieces read straight off a disc, not that the app can plan/split a file,
// which is proven elsewhere
// (worker-ipc/test-large-file-split.js) - so there's no app-side capacity constant to worry about here any more.
const LARGE_FILE_BYTES = 700_000_000;
const LARGE_FILE_SPLIT_VOLUME_SIZE_MIB = 500; // must match LARGE_FILE_SPLIT_VOLUME_SIZE_MIB in app/workers/worker.ts

async function clickMainMenuButton(win, labelText) {
  const container = win.locator('.grid-container > div').filter({ has: win.locator('h2', { hasText: labelText }) });
  await container.locator('button').click();
}

/** Streamed, not a whole buffer in memory - each piece is a real 500 MiB-based volume. */
const sha256Streamed = (filePath) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  fs.createReadStream(filePath).on('error', reject).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
});

async function main() {
  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `multi-disc-${runId}`);
  const sourceRoot = path.join(scratchRoot, 'source');
  const disc1Dir = path.join(scratchRoot, 'disc1-files');
  const disc2Dir = path.join(scratchRoot, 'disc2-files');
  const outputRoot = path.join(scratchRoot, 'recovered');
  const disc1IsoPath = path.join(scratchRoot, 'disc1.iso');
  const disc2IsoPath = path.join(scratchRoot, 'disc2.iso');
  fs.mkdirSync(outputRoot, { recursive: true }); // stands in for what the folder-picker would return
  fs.mkdirSync(disc1Dir, { recursive: true });
  fs.mkdirSync(disc2Dir, { recursive: true });

  // 1. Generate ONE nested source tree (--max-depth 4, edge cases ON, plus a real large file to be split), then
  //    split its NORMAL files evenly between two separate "per-disc" folders, preserving each file's relative
  //    subdirectory structure. The large file is handled separately below (its real SPLIT PIECES, not the whole
  //    file, get distributed - one per disc). Building two SEPARATE random trees instead was considered and
  //    rejected - the app requires every disc to have unique filenames, and one shared generation pass with one
  //    shared manifest is simpler to verify at the end than merging two.
  generateFixtureTree({
    root: sourceRoot,
    randomArgs: ['--files', '20', '--max-depth', '4', '--min-size', '0', '--max-size', '20000', '--seed', '224466', '--large-file-bytes', String(LARGE_FILE_BYTES)],
    specDir: SPEC_DIR,
  });
  const manifestPath = `${sourceRoot}.manifest.json`;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const largeFileEntry = manifest.files.find((f) => f.relativePath.startsWith('large-files/'));
  const normalFiles = manifest.files.filter((f) => f !== largeFileEntry);

  // Was the large file fed in ALREADY split (a --json-tree spec with a split-plan.json marking it - see
  // tree-specs/test-recover-multi-disc/split-plan.json)? generate-tree-from-json.js's manifest entry always
  // records the ORIGINAL whole-file size/hash even when only the real ".part.NNN" pieces exist on disk (see that
  // script's own top comment) - so the one reliable way to tell is to check what's actually sitting on disk: no
  // whole file at the expected path means it must have arrived pre-split.
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

  // generate-random-tree.js's empty-directory edge case never appears in manifest.files (verify-manifest.js
  // doesn't check for empty dirs either - there's nothing to hash), so it needs handling separately: replicate
  // it into whichever disc actually ended up with the rest of the "edge-cases/" subtree, keeping that whole
  // subtree together on one disc rather than splitting it further.
  const emptyDirRel = path.join('edge-cases', 'empty-directory');
  if (fs.existsSync(path.join(sourceRoot, emptyDirRel))) {
    const edgeCasesWentToDisc1 = disc1Files.some((f) => f.relativePath.startsWith('edge-cases/'));
    fs.mkdirSync(path.join(edgeCasesWentToDisc1 ? disc1Dir : disc2Dir, emptyDirRel), { recursive: true });
  }

  // Two MORE empty directories, deliberately placed by this script itself (not generate-random-tree.js's own
  // single built-in one above) - one per disc, each nested a few levels deep. IMPORTANT: each disc's path must be
  // DISTINCT (disc1/disc2 suffix below) - the app tracks empty directories as path entries the exact same way it
  // tracks files (see getAllFiles/getAllFilesSet in worker.ts), so two identically-named empty directories on
  // different discs are indistinguishable from a real duplicate filename to its "does every disc have unique
  // names" check, and it correctly refuses the second one - found for real (2026-08-27) by giving both discs the
  // literal same path here, which is a bug in this script, not the app.
  fs.mkdirSync(path.join(disc1Dir, 'extra-empty-dirs', 'nested', 'deeper-still-disc1'), { recursive: true });
  fs.mkdirSync(path.join(disc2Dir, 'extra-empty-dirs', 'nested', 'deeper-still-disc2'), { recursive: true });

  console.log(`\nGenerated ${manifest.fileCount} files - disc 1: ${disc1Files.length} normal, disc 2: ${disc2Files.length} normal, plus the large file's real split pieces (below).`);
  printTree(sourceRoot, 'Source tree (before)');

  console.log('\nChecking no optical media is already mounted...');
  assertNoOpticalMediaAlreadyMounted();

  // NOTE: no assertRealTempDataDirectoryIsSafeToUse() here any more, unlike test-recover-from-json-metadata.js and
  // test-add-missing-files-split-resume.js: nothing in this run is ever merged (a physical disc read flags no
  // pieces at all - see this script's header), and merging is the only thing in this wizard that touches the app's
  // real temp/cache directory.

  let app, win, tempPartDir, mountedIsoPath;
  // The real split pieces themselves (their on-disk source paths, so their exact content can be re-hashed later)
  // and the path each one must come back at, relative to the recovery folder. Filled in below, then read again by
  // the verification step that runs AFTER the app has closed - which is why both are declared out here rather
  // than inside the try block.
  let partEntries = [];
  let recoveredPieceRelPaths = [];
  try {
    // 2. Launch the app EARLY - before building either .iso - since the large file's real split pieces have to
    //    come from the app's own real partitioning logic (over worker IPC, same as test-large-file-split.js),
    //    and both discs need those pieces before they can be built at all. The same app/win instance is reused
    //    for the UI click-through further down - no need to launch twice.
    console.log('\nLaunching the app...');
    ({ app, win } = await launchApp());
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
    }, outputRoot);

    if (alreadySplitPartPaths) {
      // Already split via this spec's own split-plan.json - the real pieces are sitting right in the source
      // tree since generate-tree-from-json.js produced them. No need to ask the app to split anything: that's
      // not what this script exists to prove (see this script's own header comment).
      console.log(`"${largeFileName}" arrived already split into ${alreadySplitPartPaths.length} real piece(s) (this spec's own split-plan.json) - skipping the live app split.`);
      partEntries = alreadySplitPartPaths.map((p) => ({ path: p, stats: { size: fs.statSync(p).size } }));
    } else {
      // Splits the real file directly via 7-Zip - the same lib/seven-zip.js helper generate-tree-from-json.js's
      // own --split-plan option already uses - rather than going through the app's own partitioning IPC. This
      // script doesn't need or test that two-step (plan-then-materialize) sequence at all, just SOME real split
      // fixture, so calling 7-Zip directly avoids coupling a recovery test to the burn flow's own machinery.
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

    // Distribute the pieces - one per disc, deliberately, so each one is recovered from a disc the other piece
    // never touched. Nothing is flagged anywhere (this is a plain disc read - no metadata), so the wizard must
    // copy them back as the two plain files they are and never offer to reassemble them.
    const originalFileName = largeFileName;
    console.log(`Got ${partEntries.length} real split pieces for "${originalFileName}" - placing one on each disc...`);
    const disc1PartDest = path.join(disc1Dir, 'large-files', path.basename(partEntries[0].path));
    const disc2PartDest = path.join(disc2Dir, 'large-files', path.basename(partEntries[1].path));
    fs.mkdirSync(path.dirname(disc1PartDest), { recursive: true });
    fs.copyFileSync(partEntries[0].path, disc1PartDest);
    fs.mkdirSync(path.dirname(disc2PartDest), { recursive: true });
    fs.copyFileSync(partEntries[1].path, disc2PartDest);
    // Where each piece must come back: recovery preserves a file's path relative to the disc it was read from, and
    // both pieces sit under the large file's own folder on their disc - so the same folder, under the output root.
    const pieceRelDirPosix = path.posix.dirname(largeFileEntry.relativePath);
    recoveredPieceRelPaths = [disc1PartDest, disc2PartDest].map((p) => `${pieceRelDirPosix}/${path.basename(p)}`);
    console.log(`  disc 1: ${path.basename(disc1PartDest)} (${partEntries[0].stats.size.toLocaleString()} bytes)`);
    console.log(`  disc 2: ${path.basename(disc2PartDest)} (${partEntries[1].stats.size.toLocaleString()} bytes)`);

    // Exactly what each simulated disc actually contains, right before it's turned into a .iso - this is what
    // lets you trace which files ended up on which disc, not just "source" vs "recovered".
    printTree(disc1Dir, 'Disc 1 contents (before burning to .iso)');
    printTree(disc2Dir, 'Disc 2 contents (before burning to .iso)');

    // 3. Build both discs, mount disc1 first (disc2 stays unmounted for now).
    console.log('\nBuilding disc1.iso and disc2.iso...');
    buildIso(disc1Dir, disc1IsoPath, 'TESTDISC1');
    buildIso(disc2Dir, disc2IsoPath, 'TESTDISC2');
    console.log('Mounting disc1...');
    mountedIsoPath = disc1IsoPath;
    mountIso(disc1IsoPath);

    // Pause after every successful step, deliberately - long enough for a human watching the window to actually
    // see what just happened before the next click fires. Purely for watchability; the app itself doesn't need
    // this.
    const WATCH_PAUSE_MS = 1000;

    const step = async (label, fn) => {
      process.stdout.write(`  [ ] ${label} ... `);
      try {
        await fn();
      } catch (e) {
        console.log('FAILED');
        const screenshotPath = path.join(FIXTURES_ROOT, `optical-backup-ui-multi-disc-test-failure-${runId}.png`);
        try {
          await win.screenshot({ path: screenshotPath });
          console.log(`  Screenshot of the app at the point of failure saved to: ${screenshotPath}`);
        } catch { /* app/window may already be gone */ }
        throw e;
      }
      console.log('done');
      await new Promise((r) => setTimeout(r, WATCH_PAUSE_MS));
    };

    // --- Phase A: enumeration (step_2) - read disc1's listing, swap to disc2, read disc2's listing ---

    await step('main menu -> Recover data from optical media backup', () =>
      clickMainMenuButton(win, 'Recover data from optical media backup'));

    await step('click "Select a directory to save the recovered files"', () =>
      win.getByRole('button', { name: 'Select a directory to save the recovered files' }).click({ timeout: 15_000 }));

    await step('wait for the chosen output path to appear on screen', () =>
      win.getByText(outputRoot, { exact: true }).waitFor({ timeout: 10_000 }));

    await step('click "Next" (starts reading disc 1)', () =>
      win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 }));

    // IMPORTANT: wait for the "insert next disc" dialog's "Ok" button to actually APPEAR (proof disc 1 was read)
    // BEFORE swapping - swapping any earlier could plausibly race the read; swapping any later (i.e. clicking Ok
    // first) is the real bug this script's header warns about, since that would make the app start waiting again
    // while disc1 is STILL mounted, immediately re-detecting it as "already processed".
    await step('wait for disc 1 to be read (up to 60s)', () =>
      win.getByRole('button', { name: 'Ok', exact: true }).waitFor({ timeout: 60_000 }));

    await step('swap discs: dismount disc1, mount disc2', async () => {
      dismountIso(disc1IsoPath);
      mountIso(disc2IsoPath);
      mountedIsoPath = disc2IsoPath;
    });

    await step('click "Ok" to continue to the next disc', () =>
      win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 }));

    await step('wait for disc 2 to be read, click "All disks have been processed, continue to the next step" (up to 60s)', () =>
      win.getByRole('button', { name: 'All disks have been processed, continue to the next step' }).click({ timeout: 60_000 }));

    // --- Phase B: pick files, then recovery (step_5) - disc2 is already mounted (no swap needed for the first
    //     recovery pass, since it's already exactly what's inserted), then swap to disc1 for the second ---

    // This step's timing genuinely varies a lot run to run (confirmed on real runs, 2026-08-27 - anywhere from a
    // few seconds to over 60s) - the checkbox is CSS `visibility:hidden` (not removed from the DOM) while
    // createFilesTreeForReconstructedBackupPaths() builds the combined 2-disc tree, and how long that takes
    // seems to vary (every run launches a fresh Electron process, so this may be JIT/cold-start variance rather
    // than anything wrong with the tree-building itself). Split into an explicit "wait to become visible" step
    // and a separate click, rather than one combined wait-and-click call.
    await step('wait for the combined files tree to finish rendering (up to 120s)', () =>
      win.getByRole('checkbox', { name: 'Select all' }).waitFor({ state: 'visible', timeout: 120_000 }));

    await step('click "Select all"', () =>
      win.getByRole('checkbox', { name: 'Select all' }).click({ timeout: 15_000 }));

    await step('click "Recover selected data"', () =>
      win.getByRole('button', { name: 'Recover selected data' }).click({ timeout: 15_000 }));

    await step('click "Ok" on the "you will need to insert disc(s)" info dialog', () =>
      win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 }));

    // Same ordering rule as above: wait for the button to APPEAR (proof disc 2's files were actually copied)
    // before swapping, then swap, then click.
    await step('wait for disc 2\'s files to be recovered (up to 60s)', () =>
      win.getByRole('button', { name: 'Continue with the next disc' }).waitFor({ timeout: 60_000 }));

    await step('swap discs: dismount disc2, mount disc1', async () => {
      dismountIso(disc2IsoPath);
      mountIso(disc1IsoPath);
      mountedIsoPath = disc1IsoPath;
    });

    // Small deliberate pause before clicking - test-recover-single-disc.js found (and documented in its own
    // README) that clicking straight through to the final wait with no pause at all can race the app's own
    // sequential worker-IPC calls closely enough to silently copy zero files. The real PowerShell mount/dismount
    // calls above already add real wall-clock time here, but this is kept for the same margin of safety.
    await new Promise((r) => setTimeout(r, 1000));

    await step('click "Continue with the next disc"', () =>
      win.getByRole('button', { name: 'Continue with the next disc' }).click({ timeout: 15_000 }));

    // --- Phase C: disc 1's files were just copied - that was the LAST disc, so the wizard goes straight to its
    //     final summary. There is deliberately NO merge offer here: a physical disc read carries no cold storage
    //     metadata, so no entry is flagged `isPartial` and the two pieces were copied as the plain files they are.
    //     The merge-offer flow needs metadata and is covered by ui/test-recover-from-json-metadata.js and
    //     ui/test-long-names-split-file.js. ---

    await step('wait for the final summary - no merge offer at all, straight to "Data recovery successful" (up to 60s)', async () => {
      const summary = win.getByRole('dialog').filter({ hasText: 'Data recovery successful' });
      await summary.waitFor({ timeout: 60_000 });
      // Fails loudly (rather than silently passing) if the wizard ever starts offering a merge on this path again -
      // that would mean a disc read had somehow flagged a piece.
      if (await win.getByRole('dialog').filter({ hasText: 'Partial files detected' }).count() > 0) {
        throw new Error('The wizard offered to reassemble files read straight off a disc - nothing on this path is flagged isPartial, so it must not.');
      }
    });

    await step('click "Ok" on "Data recovery successful"', () =>
      win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 }));

    console.log('Wizard completed.');
  } finally {
    if (app) { await app.close().catch(() => {}); }
    console.log('\nDismounting whichever disc is still mounted...');
    dismountIso(mountedIsoPath || disc1IsoPath);
    // No separate tempPartDir cleanup needed here any more: it's now a plain subdirectory of scratchRoot (this
    // script's own split, via real 7-Zip directly - see Phase 2 above), not the app's real temp/cache directory,
    // so it's already covered by scratchRoot's own pass/fail cleanup below - and leaving it in place on FAILURE
    // (rather than force-deleting it here regardless) is exactly what makes the split pieces available for
    // inspection alongside everything else when something goes wrong.
  }

  // 4. Verify: the recovered folder must hold every normal file from both discs, PLUS the two pieces exactly as
  //    they were burned - one per disc, byte for byte - and must NOT hold the whole large file: nothing was
  //    reassembled, because a physical disc read carries no metadata to reassemble from (the point of this run).
  //    verify-manifest.js is pointed at a manifest derived from the generated one: the large file's own entry
  //    (which describes the WHOLE file, and was never written to any disc) is dropped, and one entry per recovered
  //    piece is added, hashed from the very piece this script placed on that disc.
  printTree(outputRoot, 'Recovered tree (after)');
  const verificationManifestPath = path.join(scratchRoot, 'manifest-for-verification.json');
  const pieceEntries = [];
  for (let i = 0; i < partEntries.length; i++) {
    pieceEntries.push({
      relativePath: recoveredPieceRelPaths[i],
      sizeBytes: partEntries[i].stats.size,
      sha256: await sha256Streamed(partEntries[i].path),
    });
  }
  fs.writeFileSync(verificationManifestPath, JSON.stringify({
    ...manifest,
    fileCount: normalFiles.length + pieceEntries.length,
    files: [...normalFiles, ...pieceEntries],
  }, null, 2));
  console.log(`\nVerifying the recovered files (the large file's own manifest entry replaced by its ${pieceEntries.length} pieces)...`);
  let verifyPassed = false;
  try {
    execFileSync(process.execPath, [
      path.join(__dirname, '../verify-manifest.js'),
      '--manifest', verificationManifestPath,
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

  console.log(`\n${verifyPassed ? 'PASS' : 'FAIL'} - multi-disc recovery ${verifyPassed ? "correctly recovered every file from both discs - the large file's two cross-disc pieces came back as the plain files they are, byte for byte, with nothing merged and nothing deleted (a disc read has no metadata to reassemble from)." : 'did not produce a correct result, see verify-manifest output above.'}`);
  process.exitCode = verifyPassed ? 0 : 1;
}

main().catch((e) => {
  const message = (e && e.message) || String(e);
  const fullDetail = (e && e.stack) ? e.stack : message;
  if (/closed|Target .*(closed|crashed)/i.test(message)) {
    console.error(`\nTEST ERRORED: the app window was closed before the test finished (${message}).`);
  } else {
    const logPath = path.join(FIXTURES_ROOT, `optical-backup-ui-multi-disc-test-error-${Date.now()}.log`);
    try { fs.writeFileSync(logPath, fullDetail); } catch { /* best effort */ }
    console.error(`\nTEST ERRORED: ${message}`);
    console.error(`Full details saved to: ${logPath}`);
  }
  process.exitCode = 1;
});
