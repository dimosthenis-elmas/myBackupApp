#!/usr/bin/env node
'use strict';

/**
 * End-to-end test of the "Backup to optical media" wizard. Scope, and why: step 2 of this wizard ends with a
 * "Send to ImgBurn" button per disc, which (see createIBB_file in app/workers/worker.ts) does two things for
 * real, unconditionally, every time it's called: writes a real .ibb project file (safe - just a text file), AND
 * spawns your real, configured ImgBurn.exe on it (`exec("<imgBurnExecutablePath>" /MODE BUILD /SRC <path>)`) -
 * both coupled inside one function, with no "just write the file" mode to call instead. So this test can't click
 * "Send to ImgBurn" for real without also launching a real disc-burning GUI - UNLESS the configured ImgBurn path
 * is temporarily redirected first.
 *
 * ============================================================================================================
 * How the real ImgBurn launch is avoided - and why this is safe
 * ============================================================================================================
 * Right before the "Send to ImgBurn" clicks, this script backs up the exact raw text of the real
 * appData/config.json, writes a version with `imgBurnExecutablePath` pointed at a harmless no-op .bat file this
 * script creates in its own scratch folder (`@echo off` - exits immediately, does nothing), then ALWAYS restores
 * the original file byte-for-byte in a finally block, however the test ends. createIBB_file rereads config.json
 * fresh from disk on every call (not cached), so this is enough to make the real exec() call happen (proving that
 * code path runs without error) while it actually launches nothing but an instant no-op - never your real
 * ImgBurn. See lib/ibb-tools.js (backupAndRedirectImgBurnPath/restoreConfig - shared with
 * ui/test-add-missing-files.js, which needs the exact same technique). Nothing else in config.json is touched.
 *
 * ============================================================================================================
 * A real large-file split, via THIS wizard's own unique confirmation-dialog chain
 * ============================================================================================================
 * Unlike add-missing-files-to-optical-media-cold-storage.component.ts's partition() (which hardcodes
 * splitLargeFiles: true, unconditionally, every time), THIS wizard's WriteToOpticalMediaProceed tries WITHOUT
 * splitting first, and only on catching a FILE_TOO_LARGE_FOR_SINGLE_OPTICAL_DISC error does it show a
 * confirmation dialog chain ("Error - Too large files found" -> "Yes, split the large files" -> an "Info" dialog
 * about the temp directory -> "Ok, got it.", which RETRIES the whole call with splitLargeFiles: true) - a
 * genuinely different code path from the other wizard's, and one no UI test here had ever clicked through before.
 * A real source tree with one file bigger than a CD's effective capacity forces exactly this chain. The retry
 * (where the real 7-Zip split actually happens) is followed by the SAME "you will need N discs" confirmation the
 * ordinary (non-split) path already used - see the arithmetic below for why this reliably produces 3 discs (1 for
 * the small normal files, 2 for the real ~500MB/~176MB split pieces - same proven-safe 700MB/CD combination as
 * worker-ipc/test-large-file-split.js and ui/test-add-missing-files.js).
 *
 * ============================================================================================================
 * What this actually checks: every source file/directory - and every real split piece - reaches the real .ibb
 * file(s), correctly
 * ============================================================================================================
 * The .ibb project file's [START_BACKUP_LIST]...[END_BACKUP_LIST] section (see createIBB_file /
 * insertBranch_for_IBB_creation) is a real, human-readable list of "F|name|parentPath|fullSourcePath" (files) and
 * "D|name|parentPath|fullSourcePath" (directories) lines - one function, entirely separate from the partitioning
 * logic already proven elsewhere (worker-ipc/test-partitioning.js), that flattens each disc's SELECTED tree into
 * this format. This script:
 *  1. Generates a source tree just over one CD's effective capacity (700MB * the app's own 0.95
 *     maxOpticalMediumRepletionRatio margin = 665,000,000 bytes) via a small nested tree with edge cases (a
 *     zero-byte file, a unicode/space filename, an empty directory) plus a real 700MB file - big enough on its
 *     own to force the split-confirmation chain above.
 *  2. Clicks through step 1, the "too large" confirmation chain, the resulting "N discs needed" confirmation, the
 *     JSON save-path dialog, and then - per disc - "Send to ImgBurn" and its "Disc label" confirmation.
 *  3. After each disc's real .ibb file appears on disk, reads it (utf16le - see saveIBB_toDisk) and parses every
 *     F|/D| line's own fullSourcePath field. NORMAL files/dirs resolve under the source tree, and are compared
 *     directly against a plain recursive filesystem walk. Split-piece entries resolve under the app's own real
 *     temp/cache directory instead (the same fallback path insertBranch_for_IBB_creation takes for any file it
 *     can't find under the source tree - see that function's own comment) and are verified STRUCTURALLY (exact
 *     piece count, exact first-volume size, total size within the same real-7z-overhead tolerance
 *     worker-ipc/test-large-file-split.js already established), since 7-Zip's own output filenames can't be
 *     predicted in advance.
 *  4. Compares: every real NORMAL file's absolute path must appear in EXACTLY ONE disc's .ibb; the original,
 *     UNSPLIT large file must never appear whole anywhere; every real directory (including the large file's own
 *     containing directory, which the split pieces still live under) must appear in AT LEAST ONE disc's .ibb -
 *     directories legitimately CAN repeat across discs, since each disc's .ibb is built from a fresh, disc-local
 *     tree and needs its own directory declared wherever it has files on that particular disc; that's correct,
 *     not a bug, so only files get a strict one-and-only-once check.
 *
 * NOTE: needs a real Windows desktop/window session (see worker-ipc/call-worker.js's top comment) - run from
 * your own interactive terminal.
 *
 * Usage:
 *   node test-harness/ui/test-backup-to-optical-media.js [--random-tree | --json-tree]
 * See lib/fixture-tree-source.js for what step 1's source tree generation flags do - --json-tree uses this
 * script's own bundled example under ui/tree-specs/test-backup-to-optical-media/tree-spec.json, which includes a
 * large file at exactly LARGE_FILE_BYTES (below) at large-files/oversized-file.bin - both the exact size and
 * exact path are required, since this script locates it by that hardcoded path, not via the manifest.
 */

const fs = require('fs');
const path = require('path');
const { launchApp } = require('../worker-ipc/call-worker');
const { assertRealTempDataDirectoryIsSafeToUse, resolveRealTempDataDirectory } = require('../worker-ipc/temp-dir-guard');
const { printTree } = require('../lib/print-tree');
const { writeStubImgBurnBat, backupAndRedirectImgBurnPath, restoreConfig, waitForFile, parseIbbBackupList } = require('../lib/ibb-tools');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');
const { generateFixtureTree } = require('../lib/fixture-tree-source');

const SPEC_DIR = path.join(__dirname, 'tree-specs', 'test-backup-to-optical-media');

// The app's own "cd" medium choice (optical_media_choices in backup-to-optical-media.component.ts) and its own
// maxOpticalMediumRepletionRatio safety margin (appData/config.json) - the REAL effective per-disc capacity the
// app's own bin-packing uses is capacity * ratio, not the raw capacity.
const CD_CAPACITY_BYTES = 700_000_000;
const OPTICAL_MEDIUM_REPLETION_RATIO = 0.95;

// Same proven-safe constants as worker-ipc/test-large-file-split.js and ui/test-add-missing-files.js - a 700MB
// file real-splits into exactly 2 pieces at the app's fixed 500 MiB volume size, and CD's effective ~665MB
// capacity sits above one piece but below both combined, forcing them onto two separate discs.
const LARGE_FILE_BYTES = 700_000_000;
const EXPECTED_FIRST_PIECE_BYTES = 500 * 1024 * 1024; // 524,288,000 - see LARGE_FILE_SPLIT_VOLUME_SIZE_MIB in worker.ts
const EXPECTED_PART_COUNT = 2;
const EXPECTED_DISC_COUNT = 3; // 1 for the small normal files, 2 for the large file's real split pieces

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Recursively walks `root`, returning every real file's and every real directory's absolute path (directories
 *  excluding `root` itself - the app's own tree-flattening never emits its own entry for the root, only for
 *  things reached via a token path under it - see insertBranch_for_IBB_creation). */
function walkForGroundTruth(root) {
  const files = [];
  const dirs = [];
  (function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        dirs.push(full);
        walk(full);
      } else {
        files.push(full);
      }
    }
  })(root);
  return { files, dirs };
}

async function clickMainMenuButton(win, labelText) {
  const container = win.locator('.grid-container > div').filter({ has: win.locator('h2', { hasText: labelText }) });
  await container.locator('button').click();
}

async function main() {
  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `backup-to-optical-media-${runId}`);
  const sourceRoot = path.join(scratchRoot, 'source');
  const metadataJsonPath = path.join(scratchRoot, 'cold-storage-metadata.json');
  const stubImgBurnPath = path.join(scratchRoot, 'stub-imgburn.bat');

  // 1. Generate a small nested tree with edge cases (structural realism), plus a real 700MB file - big enough on
  //    its own to exceed CD's effective capacity and force the "too large" confirmation chain (see this script's
  //    own header comment).
  generateFixtureTree({
    root: sourceRoot,
    randomArgs: ['--files', '10', '--max-depth', '3', '--min-size', '0', '--max-size', '20000', '--seed', '778899', '--large-file-bytes', String(LARGE_FILE_BYTES)],
    specDir: SPEC_DIR,
  });

  const largeFileAbsPath = path.join(sourceRoot, 'large-files', 'oversized-file.bin');
  const { files: sourceFiles, dirs: sourceDirs } = walkForGroundTruth(sourceRoot);
  const effectiveCapacity = CD_CAPACITY_BYTES * OPTICAL_MEDIUM_REPLETION_RATIO;
  const totalSourceBytes = sourceFiles.reduce((sum, f) => sum + fs.statSync(f).size, 0);
  console.log(`\nGenerated ${sourceFiles.length} files, ${sourceDirs.length} directories, ${(totalSourceBytes / 1e6).toFixed(1)} MB total.`);
  console.log(`Effective per-disc capacity at this medium (${(CD_CAPACITY_BYTES / 1e6).toFixed(0)}MB * ${OPTICAL_MEDIUM_REPLETION_RATIO} ratio): ${(effectiveCapacity / 1e6).toFixed(1)} MB.`);
  if (!fs.existsSync(largeFileAbsPath) || fs.statSync(largeFileAbsPath).size <= effectiveCapacity) {
    throw new Error(`Expected a real file at "${largeFileAbsPath}" bigger than the effective capacity (${effectiveCapacity} bytes) to force the "too large" confirmation chain - something about the size constants at the top of this script no longer holds.`);
  }
  printTree(sourceRoot, 'Source tree (before)');

  console.log('\nChecking the app\'s real temp/cache directory is safe to use (this is where real .ibb files and split pieces get written)...');
  assertRealTempDataDirectoryIsSafeToUse();
  const realTempDir = resolveRealTempDataDirectory();

  writeStubImgBurnBat(stubImgBurnPath);

  let app, win, originalConfigContent;
  const createdIbbPaths = [];
  try {
    console.log('\nLaunching the app...');
    ({ app, win } = await launchApp());

    await app.evaluate(({ dialog }, paths) => {
      const queue = [...paths];
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [queue.shift()] });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: queue.shift() });
    }, [sourceRoot, metadataJsonPath]);

    const WATCH_PAUSE_MS = 5000;
    const step = async (label, fn) => {
      process.stdout.write(`  [ ] ${label} ... `);
      try {
        await fn();
      } catch (e) {
        console.log('FAILED');
        const screenshotPath = path.join(FIXTURES_ROOT, `optical-backup-ui-backup-to-optical-media-test-failure-${runId}.png`);
        try {
          await win.screenshot({ path: screenshotPath });
          console.log(`  Screenshot of the app at the point of failure saved to: ${screenshotPath}`);
        } catch { /* app/window may already be gone */ }
        throw e;
      }
      console.log('done');
      await new Promise((r) => setTimeout(r, WATCH_PAUSE_MS));
    };

    // --- Phase A: step 1 - source folder, medium, collection name, Next ---

    await step('main menu -> Backup to optical media', () =>
      clickMainMenuButton(win, 'Backup to optical media'));

    await step('click "Path to backup"', () =>
      win.getByRole('button', { name: 'Path to backup' }).click({ timeout: 15_000 }));

    await step('wait for the chosen source path to appear on screen', () =>
      win.getByText(sourceRoot, { exact: true }).waitFor({ timeout: 10_000 }));

    await step('open the "Optical medium type" dropdown', () =>
      win.getByRole('combobox').click({ timeout: 15_000 }));

    await step('select "CD (700 MB)"', () =>
      win.getByRole('option', { name: 'CD (700 MB)' }).click({ timeout: 15_000 }));

    await step('type the cold storage collection name', () =>
      win.getByPlaceholder('e.g. My Backup').fill('Backup-to-optical-media test'));

    await step('click "Next" (tries WITHOUT splitting first - expected to hit the "too large" error)', () =>
      win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 }));

    // --- Phase B: the "too large" confirmation chain, unique to this wizard (see header comment) ---

    await step('wait for the "Error - Too large files found" dialog', () =>
      win.getByText('Error - Too large files found', { exact: true }).waitFor({ timeout: 30_000 }));

    await step('click "Yes, split the large files"', () =>
      win.getByRole('button', { name: 'Yes, split the large files', exact: true }).click({ timeout: 15_000 }));

    // Title changed from "Warning!" to "Info" when the dialog's own text was updated to reflect that pieces are
    // now cleaned up automatically on confirm, rather than needing to be manually deleted - see that dialog's
    // own comment in backup-to-optical-media.component.ts.
    await step('wait for the "Info" temp-directory notice', () =>
      win.getByText('Info', { exact: true }).waitFor({ timeout: 15_000 }));

    // Clicking this retries WriteToOpticalMediaProceed() with splitLargeFiles=true - the real 7-Zip split
    // happens inside that retry, so the NEXT wait below needs a real, generous budget, same as the equivalent
    // wait in ui/test-add-missing-files.js.
    await step('click "Ok, got it." (retries with splitting enabled - real 7-Zip split happens now)', () =>
      win.getByRole('button', { name: 'Ok, got it.', exact: true }).click({ timeout: 15_000 }));

    // --- Phase C: "you will need N discs" confirmation (now that splitting succeeded), then the JSON save-path dialog ---

    await step('wait for the "Backup to optical medium" confirmation dialog (up to 5 min - real split happens first)', () =>
      win.getByText('Backup to optical medium', { exact: true }).waitFor({ timeout: 5 * 60_000 }));

    // Scoped to the dialog - step 1's own "Next" button is still present (just covered) underneath it, so an
    // unscoped getByRole('button', {name:'Next'}) would match both and fail Playwright's strict-mode check.
    await step('click "Next" on the confirmation dialog (chooses where to save the JSON next)', () =>
      win.getByRole('dialog').getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 }));

    // --- Phase D: step 2 renders - one "Optical disk N" step per disc, each with its own pre-selected tree ---

    await step('wait for step 2 to render ("Burn backup to optical media")', () =>
      win.getByText('Burn backup to optical media', { exact: true }).waitFor({ timeout: 30_000 }));

    const discTabs = win.getByRole('tab');
    const actualDiscCount = await discTabs.count();
    console.log(`  -> ${actualDiscCount} disc step(s) rendered (expected ${EXPECTED_DISC_COUNT} - 1 for the small normal files, 2 for the large file's real split pieces).`);
    if (actualDiscCount !== EXPECTED_DISC_COUNT) {
      throw new Error(`Expected exactly ${EXPECTED_DISC_COUNT} discs, got ${actualDiscCount}. Something about the size constants at the top of this script no longer holds.`);
    }

    // Redirect ImgBurn to the harmless stub only now, right before it's actually needed - keeping the window
    // during which the real config.json differs from normal as short as practical - and restore it in the
    // outer finally block below no matter how the rest of this script ends.
    console.log('\nRedirecting the real ImgBurn path to a harmless no-op stub for the "Send to ImgBurn" clicks below...');
    originalConfigContent = backupAndRedirectImgBurnPath(stubImgBurnPath);

    // --- Phase E: per disc - open its step, "Send to ImgBurn", confirm the disc label, wait for the real .ibb ---

    for (let i = 0; i < actualDiscCount; i++) {
      await step(`open the "Optical disk ${i + 1}" step`, () =>
        win.getByRole('tab', { name: `Optical disk ${i + 1}`, exact: false }).click({ timeout: 15_000 }));

      // Despite @ViewChildren('cmp') being able to see every disc's FilesTreeComponent instance at once (used
      // right after step 2 first renders, to pre-select every disc's tree - see createTrees()), mat-stepper only
      // keeps the CURRENTLY SELECTED step's own content actually attached to the DOM - found for real
      // (2026-08-27): after navigating to "Optical disk 2", disc 1's "Send to ImgBurn" button was gone from the
      // DOM entirely, not just hidden, so an nth(i)-based locator (assuming both buttons persist simultaneously)
      // broke on disc 2 - there was never a "2nd" match to find, only ever one at a time. Since only one disc's
      // panel is ever attached at once, the plain unscoped locator is already unambiguous on its own.
      await step(`click "Send to ImgBurn" for disc ${i + 1}`, () =>
        win.getByRole('button', { name: 'Send to ImgBurn' }).click({ timeout: 15_000 }));

      await step(`click "Ok" on the "Disc label" confirmation for disc ${i + 1}`, () =>
        win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 }));

      const ibbPath = path.join(realTempDir, `Disk_${i + 1}.ibb`);
      process.stdout.write(`  [ ] wait for the real .ibb file for disc ${i + 1} to appear ... `);
      await waitForFile(ibbPath, 30_000);
      console.log('done');
      createdIbbPaths.push(ibbPath);
    }

    console.log('\nWizard completed.');
    printTree(realTempDir, 'App temp dir (after) - real .ibb files and any split pieces');

    // --- Phase F (verification, still with the app open - see below for why) ---
    //
    // 2. Verify: every real NORMAL file must appear in EXACTLY ONE disc's .ibb; the large file must never appear
    //    whole anywhere; every real directory (the large file's own directory included) must appear in AT LEAST
    //    ONE disc's .ibb (directories legitimately CAN repeat across discs - see this script's own header comment
    //    for why that's correct, not a bug).
    //
    // This now runs BEFORE the app closes (it used to run after, purely against files left on disk) because
    // Phase G below needs to click "Confirm disc burned" for real, which needs a live app - and confirming a
    // disc deletes its real split-piece files, which this verification still needs to read the sizes of first.
    // So the order has to be: verify (files still exist) -> confirm (deletes them) -> assert they're gone.
    console.log('\nParsing the real .ibb file(s) and comparing against the source tree...');
    const allEntries = [];
    const splitPieceFilesToCleanUp = [];
    // Per-disc breakdown (parallel to createdIbbPaths) - Phase G needs to know exactly which real split-piece
    // files belong to WHICH disc, since a large file's pieces can be spread across more than one disc and
    // confirming disc i must only ever delete disc i's own pieces.
    const perDiscFileEntries = [];
    try {
      for (const ibbPath of createdIbbPaths) {
        const entries = parseIbbBackupList(ibbPath);
        const discFileCount = entries.filter((e) => e.type === 'F').length;
        const discDirCount = entries.filter((e) => e.type === 'D').length;
        console.log(`  ${path.basename(ibbPath)}: ${discFileCount} file entries, ${discDirCount} directory entries.`);
        allEntries.push(...entries);
        perDiscFileEntries.push(entries.filter((e) => e.type === 'F'));
      }
    } finally {
      for (const ibbPath of createdIbbPaths) {
        if (fs.existsSync(ibbPath)) { fs.rmSync(ibbPath, { force: true }); }
      }
    }

  const fileEntries = allEntries.filter((e) => e.type === 'F');
  const dirAbsPaths = allEntries.filter((e) => e.type === 'D').map((e) => e.fullSourcePath.replace(/\\+$/, ''));

  // Split-piece entries are the ones the app's own fallback resolved under the real temp dir (see
  // insertBranch_for_IBB_creation's own fallback in worker.ts) rather than under the source tree - everything
  // else is an ordinary file.
  const normalFileAbsPaths = fileEntries.filter((e) => !e.fullSourcePath.startsWith(realTempDir)).map((e) => e.fullSourcePath);
  const splitPieceEntries = fileEntries.filter((e) => e.fullSourcePath.startsWith(realTempDir));
  for (const e of splitPieceEntries) { splitPieceFilesToCleanUp.push(e.fullSourcePath); }

  const expectedNormalFileAbsPaths = sourceFiles.filter((f) => f !== largeFileAbsPath);

  const normalFileSet = new Set(normalFileAbsPaths);
  const expectedFileSet = new Set(expectedNormalFileAbsPaths);
  const missingFiles = expectedNormalFileAbsPaths.filter((f) => !normalFileSet.has(f));
  const extraFiles = normalFileAbsPaths.filter((f) => !expectedFileSet.has(f));
  const seenFiles = new Set();
  const duplicateFiles = [];
  for (const f of normalFileAbsPaths) { if (seenFiles.has(f)) { duplicateFiles.push(f); } else { seenFiles.add(f); } }

  const sourceDirSet = new Set(sourceDirs);
  const ibbDirSet = new Set(dirAbsPaths);
  const missingDirs = sourceDirs.filter((d) => !ibbDirSet.has(d));
  const extraDirs = dirAbsPaths.filter((d) => !sourceDirSet.has(d));

  console.log(`\nNormal files: ${normalFileAbsPaths.length} F| entries across all discs, ${dirAbsPaths.length} D| entries.`);
  console.log(`  Expected normal files: ${expectedNormalFileAbsPaths.length} (source total minus the one large file).`);
  console.log(`  MISSING   : ${missingFiles.length}`);
  console.log(`  EXTRA     : ${extraFiles.length}`);
  console.log(`  DUPLICATE : ${duplicateFiles.length}`);
  console.log(`Dirs: ${sourceDirs.length} in source, ${ibbDirSet.size} distinct D| entries across all discs.`);
  console.log(`  MISSING   : ${missingDirs.length}`);
  console.log(`  EXTRA     : ${extraDirs.length}`);
  for (const f of missingFiles.slice(0, 10)) { console.log(`    missing file: ${f}`); }
  for (const f of extraFiles.slice(0, 10)) { console.log(`    extra file: ${f}`); }
  for (const f of duplicateFiles.slice(0, 10)) { console.log(`    duplicate file: ${f}`); }
  for (const d of missingDirs.slice(0, 10)) { console.log(`    missing dir: ${d}`); }
  for (const d of extraDirs.slice(0, 10)) { console.log(`    extra dir: ${d}`); }

  const normalCheckPassed = missingFiles.length === 0 && extraFiles.length === 0 && duplicateFiles.length === 0
    && missingDirs.length === 0 && extraDirs.length === 0;

  // 3. Verify the large file's real split pieces STRUCTURALLY - their exact names come from 7-Zip itself, not
  //    predicted in advance (unlike everything else above, which this script fully controls).
  console.log('\nVerifying the large file\'s real split pieces...');
  const largeFileBasename = path.basename(largeFileAbsPath);
  const partNamePattern = new RegExp('^' + escapeRegExp(largeFileBasename) + '\\.part\\.', 'i');
  const partEntries = splitPieceEntries
    .filter((e) => partNamePattern.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const originalLargeFileLeakedWhole = normalFileAbsPaths.includes(largeFileAbsPath)
    || splitPieceEntries.some((e) => e.fullSourcePath === largeFileAbsPath);
  const partSizes = partEntries.map((e) => fs.statSync(e.fullSourcePath).size);
  const partCountCorrect = partEntries.length === EXPECTED_PART_COUNT;
  const firstPieceSizeCorrect = partSizes.length > 0 && partSizes[0] === EXPECTED_FIRST_PIECE_BYTES;
  const totalPartBytes = partSizes.reduce((a, b) => a + b, 0);
  // 7z -mx0 still wraps each volume in a real archive with a little header overhead - same tolerance
  // worker-ipc/test-large-file-split.js already established for the identical 700MB/500MiB combination.
  const totalSizeCorrect = totalPartBytes >= LARGE_FILE_BYTES && totalPartBytes <= LARGE_FILE_BYTES + 4096;
  console.log(`  Real split pieces found: ${partEntries.length} (expected ${EXPECTED_PART_COUNT}) - ${partCountCorrect ? 'OK' : 'WRONG'}`);
  for (const e of partEntries) { console.log(`    ${e.name} - ${fs.statSync(e.fullSourcePath).size.toLocaleString()} bytes (${e.fullSourcePath})`); }
  console.log(`  First piece exactly ${EXPECTED_FIRST_PIECE_BYTES.toLocaleString()} bytes: ${firstPieceSizeCorrect ? 'OK' : 'WRONG'}`);
  console.log(`  Total size ${totalPartBytes.toLocaleString()} bytes vs original ${LARGE_FILE_BYTES.toLocaleString()} bytes (+ up to 4096 bytes real 7z overhead allowed): ${totalSizeCorrect ? 'OK' : 'WRONG'}`);
  console.log(`  Original whole (unsplit) large file leaked into any .ibb: ${originalLargeFileLeakedWhole ? 'WRONG - regression!' : 'OK, not present'}`);
  const splitCheckPassed = partCountCorrect && firstPieceSizeCorrect && totalSizeCorrect && !originalLargeFileLeakedWhole;

    // --- Phase G: confirm each disc was burned, and verify ITS OWN real split pieces (if any) actually get
    // deleted - the whole point of the "confirm disc burned" feature (lazy per-disc materialization instead of
    // splitting every large file up front for the entire job). Uses perDiscFileEntries (captured above) rather
    // than the flattened, all-discs splitPieceEntries, since confirming disc i must only ever delete disc i's
    // own pieces - never a different, not-yet-confirmed disc's, even if they share the same source file.
    console.log('\nConfirming each disc was burned, and verifying its real split pieces get cleaned up...');
    const confirmDeletionResults = [];
    for (let i = 0; i < actualDiscCount; i++) {
      const discSplitPiecePaths = perDiscFileEntries[i]
        .filter((e) => e.fullSourcePath.startsWith(realTempDir))
        .map((e) => e.fullSourcePath);

      await step(`open the "Optical disk ${i + 1}" step (for confirm)`, () =>
        win.getByRole('tab', { name: `Optical disk ${i + 1}`, exact: false }).click({ timeout: 15_000 }));

      await step(`click "Confirm disc burned" for disc ${i + 1}`, () =>
        win.getByRole('button', { name: 'Confirm disc burned' }).click({ timeout: 15_000 }));

      await step(`wait for disc ${i + 1} to show as confirmed`, () =>
        win.getByRole('button', { name: 'Disc confirmed', exact: false }).waitFor({ timeout: 15_000 }));

      if (discSplitPiecePaths.length > 0) {
        // confirmDiscBurned awaits the real delete IPC call before its own button text updates, so by the time
        // the wait above resolves this should already be done - a short grace period only guards against any
        // last bit of filesystem latency, to avoid a flaky false failure.
        await new Promise((r) => setTimeout(r, 1000));
        const stillPresent = discSplitPiecePaths.filter((p) => fs.existsSync(p));
        const deleted = stillPresent.length === 0;
        confirmDeletionResults.push(deleted);
        console.log(`  disc ${i + 1}: ${discSplitPiecePaths.length} real split piece(s), all deleted after confirm: ${deleted}`);
        if (!deleted) { console.log(`    STILL PRESENT: ${stillPresent.join(', ')}`); }
      } else {
        console.log(`  disc ${i + 1}: no split pieces to clean up (normal-files disc).`);
      }
    }
    const confirmCheckPassed = confirmDeletionResults.every(Boolean);

    // Fallback cleanup only - by this point confirmCheckPassed being true already means every real split-piece
    // file is gone, so this is normally a no-op (fs.existsSync guards make it safe either way). Also removes the
    // now-empty "large-files" parent directory they were the only contents of.
    for (const p of splitPieceFilesToCleanUp) { if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); } }
    const splitPieceParentDirs = new Set(splitPieceFilesToCleanUp.map((p) => path.dirname(p)));
    for (const d of splitPieceParentDirs) {
      if (fs.existsSync(d) && fs.readdirSync(d).length === 0) { fs.rmdirSync(d); }
    }

    const verifyPassed = normalCheckPassed && splitCheckPassed && confirmCheckPassed;

    if (verifyPassed) {
      fs.rmSync(scratchRoot, { recursive: true, force: true });
    } else {
      console.log(`\nLeaving scratch files in place for inspection: ${scratchRoot}`);
    }

    console.log(`\n${verifyPassed ? 'PASS' : 'FAIL'} - backup-to-optical-media ${verifyPassed ? 'correctly handled the "too large" confirmation chain, represented every normal source file/directory (exactly once/at least once) across the real .ibb file(s), produced correct real split pieces for the large file, and cleaned each disc\'s pieces up on confirm.' : 'did not produce a correct result, see the counts above.'}`);
    process.exitCode = verifyPassed ? 0 : 1;
  } finally {
    if (app) { await app.close().catch(() => {}); }
    if (originalConfigContent !== undefined) {
      restoreConfig(originalConfigContent);
    }
  }
}

main().catch((e) => {
  const message = (e && e.message) || String(e);
  const fullDetail = (e && e.stack) ? e.stack : message;
  if (/closed|Target .*(closed|crashed)/i.test(message)) {
    console.error(`\nTEST ERRORED: the app window was closed before the test finished (${message}).`);
  } else {
    const logPath = path.join(FIXTURES_ROOT, `optical-backup-ui-backup-to-optical-media-test-error-${Date.now()}.log`);
    try { fs.writeFileSync(logPath, fullDetail); } catch { /* best effort */ }
    console.error(`\nTEST ERRORED: ${message}`);
    console.error(`Full details saved to: ${logPath}`);
  }
  process.exitCode = 1;
});
