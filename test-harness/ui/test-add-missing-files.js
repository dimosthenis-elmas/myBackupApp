#!/usr/bin/env node
'use strict';

/**
 * End-to-end test of the "Add missing files to optical media cold storage" wizard - the last of the app's 5
 * main-menu features with no automated test, and the one your own git history flags as still a work in progress
 * (commit 87b2064's message says so explicitly; the component still has a commented-out "//---- testing only
 * ---- START ----" block in step1()). Scoped deliberately to the JSON-metadata entry point only (useExternalMetadata
 * = true) - the "no JSON, physically re-insert every existing disc one by one" path reuses the SAME
 * <optical-disc-backup-data-retriever> component (and getCombinedFilePathsFromAllOpticalDiscs) already thoroughly
 * exercised by ui/test-recover-multi-disc.js, so it isn't the genuinely new thing worth proving here - the
 * JSON-seeded diff/continuation logic below is.
 *
 * ============================================================================================================
 * What this actually proves, and why it's a meaningfully different code path from every other test here
 * ============================================================================================================
 * Every other backup/recover test either starts a cold storage from scratch or reads one back unchanged. This is
 * the one flow that ADDS to an already-existing cold storage: it has to (1) diff a "master" folder against an
 * existing cold storage's own file listing to find only the genuinely NEW files (diff() /
 * replacePartialFileSplits in add-missing-files-to-optical-media-cold-storage.component.ts), (2) correctly
 * EXCLUDE the files that are already backed up from the new disc(s), (3) continue the disc numbering from
 * wherever the existing cold storage left off (nextDiscNumber = existingDiscCount + disk_id + 1, burned into
 * every new disc's volume label), and (4) merge the new discs' entries into the existing metadata JSON without
 * disturbing the old ones. None of that is exercised by any other script here.
 *
 * IT ALSO covers a real large-file split, which is genuinely different here than everywhere else it's tested:
 * unlike backup-to-optical-media.component.ts's WriteToOpticalMediaProceed (which tries WITHOUT splitting first,
 * and only retries with splitLargeFiles=true after hitting the "file too large" error, behind a confirmation
 * dialog chain), THIS wizard's partition() calls partitionBackupToOpticalMedia with splitLargeFiles HARDCODED to
 * true, unconditionally, every time - there is no "does this need splitting?" branch here at all, so a bug in
 * that code path would never surface through a confirmation dialog the way it would in the other wizard. A real
 * 700MB missing file, added to the master tree, is deliberately left un-backed-up so the wizard has to split it
 * for real - see "the split-piece bin-packing arithmetic" further down for why this reliably produces exactly 3
 * new discs (1 for the small missing files, 2 for the large file's real ~500MB/~176MB pieces), not 1.
 *
 * Like ui/test-backup-to-optical-media.js, this clicks "Send to ImgBurn" for real - see lib/ibb-tools.js for why
 * that needs the real ImgBurn path temporarily redirected to a harmless no-op stub first, and why that's safe.
 *
 * ============================================================================================================
 * How the test fixture is built
 * ============================================================================================================
 * One "master" folder is generated (nested, edge cases ON, plus a real 700MB file). Its NORMAL files are split in
 * half: the first half is copied into a separate "existing disc 1" folder and turned into a cold storage
 * metadata JSON via the app's own real get-file-paths-with-stats IPC (see lib/cold-storage-metadata.js) -
 * simulating a cold storage that was already backed up. The second half - plus the one built-in empty-directory
 * edge case AND the real 700MB file - is deliberately left OUT of that JSON, so the wizard's own diff has to
 * discover all of it as missing on its own. The wizard is then driven through: master folder -> medium -> JSON
 * checkbox -> select JSON -> Next (diff) -> select all (already pre-selected) -> collection name -> Next
 * (partition - asks where to save the updated JSON; this run deliberately picks the ORIGINAL JSON's own path
 * first, to exercise the "Overwrite original metadata JSON?" warning - see promptForUpdatedMetadataSavePath in
 * add-missing-files-to-optical-media-cold-storage.component.ts - then "Choose a different location", which is
 * where the real 7-Zip split actually happens) -> Ok -> "Send disk N to ImgBurn" for every disc produced.
 *
 * The split-piece bin-packing arithmetic: partitionBackupToOpticalMedia (worker.ts) runs TWO separate bin-packing
 * passes when splitLargeFiles is true, pushing onto the SAME shared `partitioning` array - first the ordinary
 * (non-large) files, THEN a second pass over the large file's real split pieces - never interleaved. The small
 * missing files here (a handful of KB-sized files) all fit in one bin on their own (disc 1). The 700MB file,
 * split into real 500 MiB volumes (LARGE_FILE_SPLIT_VOLUME_SIZE_MIB, fixed regardless of chosen medium), produces
 * exactly 2 pieces (~500MB + ~176MB, matching worker-ipc/test-large-file-split.js's own proven-safe arithmetic for
 * the same 700MB size) - and since CD's effective capacity (~665MB) sits ABOVE one piece but BELOW both combined,
 * bin-packing puts them on two SEPARATE discs (disc 2, disc 3). Total: 3 new discs, deterministically - each with
 * its own uniquely-numbered "Send disk N to ImgBurn" button (unlike backup-to-optical-media.component.ts's
 * identically-labeled ones, so no DOM-indexing pitfall picking the right BUTTON here - see that script's own
 * README section for what that was). Its own STEP still needs selecting first, same as that other wizard - only
 * the currently-selected step's content is actually visible at a time here too (confirmed via a failure
 * screenshot, after an earlier attempt at this script wrongly assumed otherwise from a strict-mode Playwright
 * error that only proved the collapsed panels' text was DOM-present, not that it was visible).
 *
 * Verifies four independent things: the real generated .ibb files (across all 3 new discs, combined) contain
 * EXACTLY the missing normal files/directories (no already-backed-up file leaked in - the diff logic's own
 * correctness check) PLUS the large file's real split pieces, verified STRUCTURALLY (exact piece count, exact
 * first-volume size, total size within the same real-7z-overhead tolerance worker-ipc/test-large-file-split.js
 * already established) rather than by predicting 7-Zip's own output filenames in advance; the updated metadata
 * JSON preserves the original disc's entries untouched while correctly appending every new disc's entries,
 * including the (now-known, from the .ibb) split-piece paths; every new disc's real burned volume label AND its
 * on-screen "please label this disc as disc N" instruction both correctly continue the numbering from the 1 disc
 * already in the existing cold storage (Disc 2, Disc 3, Disc 4) - the exact real bug found and fixed while
 * building this script (see getNextDiscNumber's own doc comment in
 * add-missing-files-to-optical-media-cold-storage.component.ts for the fix: both are now computed once, from the
 * same place, instead of the on-screen text using a bare, never-continued local index).
 *
 * NOTE: needs a real Windows desktop/window session (see worker-ipc/call-worker.js's top comment) - run from
 * your own interactive terminal.
 *
 * Usage:
 *   node test-harness/ui/test-add-missing-files.js [--random-tree | --json-tree]
 * See lib/fixture-tree-source.js for what step 1's master tree generation flags do - --json-tree uses this
 * script's own bundled example under ui/tree-specs/test-add-missing-files/tree-spec.json, which includes a large
 * file at exactly LARGE_FILE_BYTES (below) under large-files/.
 */

const fs = require('fs');
const path = require('path');
const { launchApp, callWorker } = require('../worker-ipc/call-worker');
const { assertRealTempDataDirectoryIsSafeToUse, resolveRealTempDataDirectory } = require('../worker-ipc/temp-dir-guard');
const { printTree } = require('../lib/print-tree');
const { normalizeForMetadata, OPTICAL_DRIVE_LETTER_CONVENTION } = require('../lib/cold-storage-metadata');
const { writeStubImgBurnBat, backupAndRedirectImgBurnPath, restoreConfig, waitForFile, parseIbbBackupList, parseIbbVolumeLabel } = require('../lib/ibb-tools');
const { MARKER_FILE_NAME } = require('../lib/safety');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');
const { generateFixtureTree } = require('../lib/fixture-tree-source');
const { dismissStartupTempClearDialog } = require('../lib/startup-dialogs');

const SPEC_DIR = path.join(__dirname, 'tree-specs', 'test-add-missing-files');

// Used for both the collection name typed into the wizard and the expected volume labels below - see the
// "Disc label text" verification further down for why this needs to be a named constant, not just a literal.
const COLD_STORAGE_COLLECTION_NAME = 'Add-missing-files test';

// Same proven-safe constants as worker-ipc/test-large-file-split.js and test-recover-multi-disc.js - see those
// scripts' own comments for the full reasoning (in short: a 700MB file real-splits into exactly 2 pieces at the
// app's fixed 500 MiB volume size, and CD's effective ~665MB capacity sits above one piece but below both
// combined, forcing them onto two separate discs rather than looping forever or fitting together).
const LARGE_FILE_BYTES = 700_000_000;
const EXPECTED_FIRST_PIECE_BYTES = 500 * 1024 * 1024; // 524,288,000 - see LARGE_FILE_SPLIT_VOLUME_SIZE_MIB in worker.ts
const EXPECTED_PART_COUNT = 2;
const EXPECTED_NEW_DISC_COUNT = 3; // 1 for the small missing files, 2 for the large file's real split pieces

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Prints a periodic "still working" line while `promise` is pending - see the identical helper in
 *  ui/test-recover-from-json-metadata.js for why (a real get-file-paths-with-stats call once looked hung). */
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

function copyPreservingDirs(relativePath, srcRoot, destRoot) {
  const relOs = relativePath.split('/').join(path.sep);
  const destPath = path.join(destRoot, relOs);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(path.join(srcRoot, relOs), destPath);
}

/** Returns every ANCESTOR directory (relative to the tree root) of `relOsPath` - "a/b/c/file.txt" -> ["a",
 *  "a/b", "a/b/c"]. Pass `includeSelf: true` for a path that is itself a directory (rather than a file), so its
 *  OWN full path is included too, not just its ancestors - "a/b" -> ["a", "a/b"].
 *
 * Needed because the real .ibb's own tree-flattening (insertBranch_for_IBB_creation in worker.ts) creates a D|
 * entry for EVERY intermediate directory a selected item's path passes through, not just the one directory it
 * directly lives in - found for real (2026-08-27) building this script, when a first attempt at the expected-dirs
 * set (just the one empty-directory edge case) undercounted by exactly the number of distinct parent directories
 * the real missing (nested) files live under. This does NOT apply to the cold storage metadata JSON itself,
 * which only ever stores the leaf items actually selected (files and empty-directory markers) - see
 * getSelectedData() in files-tree.component.ts - so the JSON-side verification further down does not need this.
 * The large file's own relative path is included in this calculation too (even though the large FILE itself
 * never appears whole in the .ibb - only its split pieces do) because its containing directory ("large-files")
 * genuinely does still need its own D| entry, since that's where the split pieces live too. */
function allAncestorDirs(relOsPath, includeSelf = false) {
  const parts = relOsPath.split(path.sep);
  const upperExclusive = includeSelf ? parts.length : parts.length - 1;
  const dirs = [];
  for (let i = 1; i <= upperExclusive; i++) {
    dirs.push(parts.slice(0, i).join(path.sep));
  }
  return dirs;
}

async function clickMainMenuButton(win, labelText) {
  const container = win.locator('.grid-container > div').filter({ has: win.locator('h2', { hasText: labelText }) });
  await container.locator('button').click();
}

async function main() {
  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `add-missing-files-${runId}`);
  const masterDir = path.join(scratchRoot, 'master');
  const existingDisc1Dir = path.join(scratchRoot, 'existing-disc1-files');
  const existingMetadataJsonPath = path.join(scratchRoot, 'existing-cold-storage-metadata.json');
  const updatedMetadataJsonPath = path.join(scratchRoot, 'updated-cold-storage-metadata.json');
  const stubImgBurnPath = path.join(scratchRoot, 'stub-imgburn.bat');

  // 1. Generate ONE master tree (nested, edge cases ON, plus a real 700MB file), split its NORMAL files in half:
  //    the first half simulates an ALREADY-backed-up disc (copied out + turned into a metadata JSON below); the
  //    second half - plus the one built-in empty directory AND the large file - is deliberately left out of that
  //    JSON, so the wizard's own diff has to find all of it as missing.
  generateFixtureTree({
    root: masterDir,
    randomArgs: ['--files', '16', '--max-depth', '3', '--min-size', '0', '--max-size', '20000', '--seed', '445566', '--large-file-bytes', String(LARGE_FILE_BYTES)],
    specDir: SPEC_DIR,
  });
  const manifestPath = `${masterDir}.manifest.json`;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const largeFileEntry = manifest.files.find((f) => f.relativePath.startsWith('large-files/'));
  const normalFiles = manifest.files.filter((f) => f !== largeFileEntry);
  const half = Math.ceil(normalFiles.length / 2);
  const existingFiles = normalFiles.slice(0, half);
  const missingFiles = normalFiles.slice(half);
  if (largeFileEntry) { missingFiles.push(largeFileEntry); }
  for (const f of existingFiles) { copyPreservingDirs(f.relativePath, masterDir, existingDisc1Dir); }

  const emptyDirRel = path.join('edge-cases', 'empty-directory');
  const hasEmptyDir = fs.existsSync(path.join(masterDir, emptyDirRel));
  // Deliberately NOT copied into existingDisc1Dir - stays missing, same as the second half of normalFiles.

  // generate-random-tree.js's own ownership marker (see MARKER_FILE_NAME in lib/safety.js) is a REAL file sitting
  // directly in masterDir, but it's deliberately NOT part of manifest.files (other tests exclude it from their
  // own manifest-hash-based comparisons for the same reason). It was never copied into existingDisc1Dir either
  // (only manifest.files entries are), so the app's own diff() will correctly find it as missing too, right
  // alongside the intended `missingFiles` - it has to be accounted for here or this script's own "extra in .ibb"
  // check below would wrongly flag it as a bug.
  const hasMarkerFile = fs.existsSync(path.join(masterDir, MARKER_FILE_NAME));

  console.log(`\nGenerated ${manifest.fileCount} files - already in cold storage: ${existingFiles.length}, missing (to be discovered by the wizard): ${missingFiles.length - (largeFileEntry ? 1 : 0)} normal${hasEmptyDir ? ' + 1 empty directory' : ''}${hasMarkerFile ? ' + 1 ownership marker file' : ''}${largeFileEntry ? ' + 1 large file (will be split for real)' : ''}.`);
  printTree(masterDir, 'Master tree (before)');

  console.log('\nChecking the app\'s real temp/cache directory is safe to use (this is where real .ibb files and split pieces get written)...');
  assertRealTempDataDirectoryIsSafeToUse();
  const realTempDir = resolveRealTempDataDirectory();

  writeStubImgBurnBat(stubImgBurnPath);

  let app, win, originalConfigContent, existingMetadata;
  const createdIbbPaths = [];
  const discLabelDialogTexts = [];
  try {
    console.log('\nLaunching the app...');
    ({ app, win } = await launchApp());

    // Every app launch, app.component.ts's own clearTempDataDirectoryOnStartup() unconditionally calls the
    // exact same 'get-file-paths-with-stats' IPC key this script is about to call next (to build the mandatory
    // "Clearing temporary files" dialog's own message), then - once that dialog is dismissed below - a further
    // 'clear-temp-data-directory' call. callWorker (worker-ipc/call-worker.js) matches responses by key alone -
    // no per-request correlation ID exists anywhere in this IPC contract - so this script's own call, fired with
    // no UI interaction in between, can race one of those and receive ITS response instead of its own. Found for
    // real (2026-08-27): the returned "listing" was a single entry pointing at the app's own temp-dir ownership
    // marker file, not anything under existingDisc1Dir. Every OTHER script here does several UI clicks (each
    // with their own 5s watch pause) before ever making a raw callWorker call, which is why none of them ever
    // hit this - by then the startup check has long since finished. This is specific to how this TEST HARNESS
    // bypasses the app's own internal call queue for raw IPC calls - real UI-driven usage is naturally
    // serialized through it instead - so the fix belongs here, not in the app. dismissStartupTempClearDialog
    // already waits for the dialog itself (so the FIRST two calls are guaranteed done by the time it returns) -
    // this pause covers the trailing clear-temp-data-directory call the "Ok" click just triggered.
    await dismissStartupTempClearDialog(win);
    await new Promise((r) => setTimeout(r, 3000));

    // 2. Ask the app's own real IPC for the "existing disc 1" folder's real file listing + stats, then build a
    //    cold storage metadata JSON from it - the exact same technique ui/test-recover-from-json-metadata.js
    //    uses (see lib/cold-storage-metadata.js for why this must be a literal prefix-string replacement).
    console.log('\nAsking the app for the existing disc\'s real file listing (get-file-paths-with-stats)...');
    const existingListing = (await withHeartbeat(callWorker(win, 'get-file-paths-with-stats', { dirPath: existingDisc1Dir }), 'get-file-paths-with-stats (existing disc 1)')).res;
    existingMetadata = [normalizeForMetadata(existingListing, existingDisc1Dir)];
    fs.writeFileSync(existingMetadataJsonPath, JSON.stringify(existingMetadata, null, 2));
    console.log(`Wrote existing cold storage metadata JSON (1 disc, ${existingMetadata[0].length} entries) to:\n  ${existingMetadataJsonPath}`);
    printTree(existingDisc1Dir, 'Existing cold storage disc 1 contents (fed in via JSON)');

    // The save-dialog queue deliberately has existingMetadataJsonPath queued TWICE in a row: the first
    // showSaveDialog call (see "click Next (partitions...)" below) is made to pick the exact same path the
    // wizard originally loaded the existing metadata FROM, to exercise promptForUpdatedMetadataSavePath's
    // "you're about to overwrite the original" safety check in add-missing-files-to-optical-media-cold-storage.
    // component.ts - a real trap since Electron's save dialog reopens in the last-used folder, which right
    // after picking the source JSON IS that file's own folder. Only the SECOND (distinct) queued path is
    // actually consumed to complete the save, once "Choose a different location" is clicked.
    await app.evaluate(({ dialog }, paths) => {
      const queue = [...paths];
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [queue.shift()] });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: queue.shift() });
    }, [masterDir, existingMetadataJsonPath, existingMetadataJsonPath, updatedMetadataJsonPath]);

    const WATCH_PAUSE_MS = 5000;
    const step = async (label, fn) => {
      process.stdout.write(`  [ ] ${label} ... `);
      try {
        await fn();
      } catch (e) {
        console.log('FAILED');
        const screenshotPath = path.join(FIXTURES_ROOT, `optical-backup-ui-add-missing-files-test-failure-${runId}.png`);
        try {
          await win.screenshot({ path: screenshotPath });
          console.log(`  Screenshot of the app at the point of failure saved to: ${screenshotPath}`);
        } catch { /* app/window may already be gone */ }
        throw e;
      }
      console.log('done');
      await new Promise((r) => setTimeout(r, WATCH_PAUSE_MS));
    };

    // --- Phase A: step 1 - master folder, medium, JSON checkbox + file, Next ---

    await step('main menu -> Add missing files to optical media cold storage', () =>
      clickMainMenuButton(win, 'Add missing files to optical media cold storage'));

    // This component's ngAfterViewInit() unconditionally opens a "This app is a work in progress..." warning
    // dialog (title "Warning", default single "Ok" button) the instant it loads - before step 1's own form is
    // usable. click()'s own actionability wait covers the small delay before it appears (ngAfterViewInit awaits
    // getTempDataDirectoryPath() first).
    await step('click "Ok" on the "This app is a work in progress" warning', () =>
      win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 }));

    await step('click "Select the location of your files (Master)"', () =>
      win.getByRole('button', { name: 'Select the location of your files (Master)' }).click({ timeout: 15_000 }));

    await step('wait for the chosen master path to appear on screen', () =>
      win.getByText(masterDir, { exact: true }).waitFor({ timeout: 10_000 }));

    await step('open the "Optical medium type" dropdown', () =>
      win.getByRole('combobox').click({ timeout: 15_000 }));

    await step('select "CD (700 MB)"', () =>
      win.getByRole('option', { name: 'CD (700 MB)' }).click({ timeout: 15_000 }));

    await step('check "Provide cold storage files metadata by importing a JSON file"', () =>
      win.getByRole('checkbox', { name: 'Provide cold storage files metadata by importing a JSON file', exact: false }).click({ timeout: 15_000 }));

    await step('click "Select JSON file"', () =>
      win.getByRole('button', { name: 'Select JSON file' }).click({ timeout: 15_000 }));

    await step('wait for the chosen JSON path to appear on screen', () =>
      win.getByText(existingMetadataJsonPath, { exact: true }).waitFor({ timeout: 10_000 }));

    // Same race as ui/test-recover-from-json-metadata.js's step 1 - the mat-chip above appears the instant a
    // path is chosen, BEFORE afterJSONpathIsGiven() actually finishes reading+schema-validating it over IPC. But
    // THIS wizard's own step1() is more exposed to it: unlike recover-data-from-optical-media.component.ts's
    // step1(), this component's step1() only guards on externalMetadataJSONpath being truthy (already true by
    // then) - NOT on json_coldStorageFilesMetadata itself. Clicking "Next" before that validation IPC round trip
    // completes wouldn't hit a "not ready yet" guard at all; it would silently fall through to the NO-JSON
    // branch instead (step1()'s `if (this.json_coldStorageFilesMetadata) {...} else {...}`), launching the
    // physical-disc-reading UI unexpectedly. A generous deliberate pause here avoids ever finding out the hard
    // way whether that's a real, hittable bug.
    await new Promise((r) => setTimeout(r, 2000));

    await step('click "Next" (validates + diffs against the JSON - no disc reads needed)', () =>
      win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 }));

    // --- Phase B: step 3 - the wizard's own diff results (should be exactly the missing files) ---

    // If this times out, see the race noted above - it would mean step1() took the wrong (no-JSON) branch.
    await step('wait for step 3 ("files missing from your cold storage") to render (up to 30s)', () =>
      win.getByText('Below you see the files missing from your cold storage.', { exact: true }).waitFor({ timeout: 30_000 }));

    await step('wait for the missing-files tree to finish rendering (up to 60s)', () =>
      win.getByRole('checkbox', { name: 'Select all' }).waitFor({ state: 'visible', timeout: 60_000 }));

    await step('type the cold storage collection name', () =>
      win.getByPlaceholder('e.g. My Backup').fill(COLD_STORAGE_COLLECTION_NAME));

    // Clicking "Next" starts partition(), which first asks where to save the updated metadata JSON - the
    // stubbed queue above makes it pick the SAME path as the original JSON on this first attempt, so the
    // "Overwrite original metadata JSON?" warning (promptForUpdatedMetadataSavePath) should appear before any
    // of the real (potentially slow) partitioning work starts.
    await step('click "Next" (first save attempt reuses the original JSON\'s own path)', () =>
      win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 }));

    await step('wait for the "Overwrite original metadata JSON?" warning and click "Choose a different location"', () =>
      win.getByRole('button', { name: 'Choose a different location', exact: true }).click({ timeout: 15_000 }));

    // --- Phase C: the updated-JSON save dialog result, then step 5 - one "Send disk N to ImgBurn" per new disc ---

    // This is where the real 7-Zip split happens (partition() -> partitionBackupToOpticalMedia with
    // splitLargeFiles hardcoded true, now proceeding with the second, distinct queued save path from the
    // "Choose a different location" click above) - give it real time, same generous budget
    // worker-ipc/test-large-file-split.js gives the equivalent direct IPC call. This confirmation is the actual
    // proof partition() (and the JSON write after it) finished - not either of the two clicks above, which only
    // wait for their own click to register, not for the app's subsequent async work.
    // Title/text changed from "Cold storage metadata saved to JSON" to "Cold storage metadata prepared" when
    // partition() was changed to write an incremental scaffold instead of the full (now-estimate-only) result in
    // one shot - see that dialog's own comment in add-missing-files-to-optical-media-cold-storage.component.ts.
    // The 5-minute budget is now generous rather than required - partition() itself is fast (planning is pure
    // arithmetic, no more real 7-Zip split up front) - but there's no harm in leaving headroom here.
    await step('wait for the "Cold storage metadata prepared" confirmation (up to 5 minutes)', () =>
      win.getByText('Cold storage metadata prepared', { exact: true }).waitFor({ timeout: 5 * 60_000 }));

    // Redirect ImgBurn to the harmless stub only now, right before it's actually needed - see lib/ibb-tools.js.
    console.log('\nRedirecting the real ImgBurn path to a harmless no-op stub for the "Send to ImgBurn" clicks below...');
    originalConfigContent = backupAndRedirectImgBurnPath(stubImgBurnPath);

    await step('click "Ok" on the confirmation', () =>
      win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 }));

    // Waited for via the FIRST disc's own uniquely-texted button, not the shared "The following files..." h3 (a
    // getByText on that shared text hits a strict-mode violation - Playwright's locator matches all 3 panels'
    // text at once, since it does not filter by visibility at match time, only when actually waiting/acting).
    // That strict-mode error, on its own, is NOT proof every panel is simultaneously VISIBLE though - found for
    // real (2026-08-27) via a failure screenshot: only disc 1's step starts expanded, same as
    // backup-to-optical-media.component.ts's stepper - discs 2/3 are collapsed (DOM-present, not yet visible)
    // until their own tab header is clicked. So each disc's own step still needs selecting before its button is
    // actually clickable, same as that other script - see the loop below.
    await step('wait for step 5 to render (disc 1\'s "Send disk 1 to ImgBurn" button)', () =>
      win.getByRole('button', { name: 'Send disk 1 to ImgBurn' }).waitFor({ timeout: 30_000 }));

    const actualDiscCount = await win.getByRole('tab').count();
    console.log(`  -> ${actualDiscCount} new disc step(s) rendered (expected ${EXPECTED_NEW_DISC_COUNT} - 1 for the small missing files, 2 for the large file's real split pieces).`);
    if (actualDiscCount !== EXPECTED_NEW_DISC_COUNT) {
      throw new Error(`Expected exactly ${EXPECTED_NEW_DISC_COUNT} new discs, got ${actualDiscCount}. Something about the size constants at the top of this script no longer holds.`);
    }

    // Every disc's own uniquely-texted "Send disk N to ImgBurn" button (unlike backup-to-optical-media.
    // component.ts's identically-labeled ones - no DOM-indexing pitfall here), but its STEP still needs to be
    // selected first - mat-step HEADERS (unlike step body content) are always all simultaneously present in the
    // DOM, so selecting them by ordinal position (.nth(i)) is safe.
    for (let i = 0; i < actualDiscCount; i++) {
      await step(`open new disc ${i + 1}'s step`, () =>
        win.getByRole('tab').nth(i).click({ timeout: 15_000 }));

      await step(`click "Send disk ${i + 1} to ImgBurn"`, () =>
        win.getByRole('button', { name: `Send disk ${i + 1} to ImgBurn` }).click({ timeout: 15_000 }));

      // Capture the "Disc label" dialog's own visible text before dismissing it - this is the exact real-bug
      // regression check for the on-screen-instruction-vs-real-volume-label mismatch found while building this
      // script (see getNextDiscNumber's own doc comment in add-missing-files-to-optical-media-cold-storage.
      // component.ts): before the fix, EVERY one of these would have said "disc <i+1>" (wrong - bare local
      // index, restarting at 1) instead of "disc <2, 3, 4>" (correct - continuing from the 1 disc already in the
      // existing cold storage).
      await step(`wait for and read disc ${i + 1}'s "Disc label" confirmation text`, async () => {
        const dialogText = await win.locator('mat-dialog-content').textContent({ timeout: 15_000 });
        discLabelDialogTexts.push((dialogText || '').trim());
      });

      await step(`click "Ok" on disc ${i + 1}'s "Disc label" confirmation`, () =>
        win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 }));

      const ibbPath = path.join(realTempDir, `Disk_${i + 1}.ibb`);
      process.stdout.write(`  [ ] wait for the real .ibb file for new disc ${i + 1} to appear ... `);
      await waitForFile(ibbPath, 30_000);
      console.log('done');
      createdIbbPaths.push(ibbPath);
    }

    console.log('\nWizard completed.');
    printTree(realTempDir, 'App temp dir (after) - real .ibb files and any split pieces');

    // --- Phase D (verification, still with the app open) ---
    //
    // 3. Verify (a): the real generated .ibb files (combined, across all new discs) contain EXACTLY the missing
    //    normal files/directories, PLUS the large file's real split pieces (verified structurally - see below).
    //
    // This now runs BEFORE the app closes (it used to run after, purely against files left on disk) because
    // Phase E below needs to click "Confirm disc burned" for real, which needs a live app - and confirming a
    // disc deletes its real split-piece files, which this verification still needs to read the sizes of first.
    // So the order has to be: verify (files still exist) -> confirm (deletes them) -> assert they're gone - same
    // restructuring as ui/test-backup-to-optical-media.js, see that script's own comment for the full reasoning.
    console.log('\nParsing the real .ibb file(s) and comparing against the expected missing files...');
    const allIbbEntries = [];
    const actualVolumeLabels = [];
    const splitPieceFilesToCleanUp = [];
    // Per-disc breakdown (parallel to createdIbbPaths) - Phase E needs to know exactly which real split-piece
    // files belong to WHICH disc, since a large file's pieces can be spread across more than one disc and
    // confirming disc i must only ever delete disc i's own pieces.
    const perDiscFileEntries = [];
    try {
      for (const ibbPath of createdIbbPaths) {
        const entries = parseIbbBackupList(ibbPath);
        const discFileCount = entries.filter((e) => e.type === 'F').length;
        const discDirCount = entries.filter((e) => e.type === 'D').length;
        console.log(`  ${path.basename(ibbPath)}: ${discFileCount} file entries, ${discDirCount} directory entries.`);
        allIbbEntries.push(...entries);
        actualVolumeLabels.push(parseIbbVolumeLabel(ibbPath));
        perDiscFileEntries.push(entries.filter((e) => e.type === 'F'));
      }
    } finally {
      for (const ibbPath of createdIbbPaths) {
        if (fs.existsSync(ibbPath)) { fs.rmSync(ibbPath, { force: true }); }
      }
    }

  const ibbFileEntries = allIbbEntries.filter((e) => e.type === 'F');
  const ibbDirAbsPaths = allIbbEntries.filter((e) => e.type === 'D').map((e) => e.fullSourcePath.replace(/\\+$/, ''));

  // Split-piece entries are the ones the app's own fallback resolved under the real temp dir (see
  // insertBranch_for_IBB_creation's own fallback in worker.ts) rather than under masterDir - everything else is
  // an ordinary missing file/the marker file.
  const normalIbbFileAbsPaths = ibbFileEntries.filter((e) => !e.fullSourcePath.startsWith(realTempDir)).map((e) => e.fullSourcePath);
  const splitPieceIbbEntries = ibbFileEntries.filter((e) => e.fullSourcePath.startsWith(realTempDir));
  for (const e of splitPieceIbbEntries) { splitPieceFilesToCleanUp.push(e.fullSourcePath); }

  const normalMissingFiles = missingFiles.filter((f) => f !== largeFileEntry);
  const expectedMissingFileAbsPaths = normalMissingFiles.map((f) => path.join(masterDir, f.relativePath.split('/').join(path.sep)));
  if (hasMarkerFile) { expectedMissingFileAbsPaths.push(path.join(masterDir, MARKER_FILE_NAME)); }
  const expectedAlreadyBackedUpAbsPaths = existingFiles.map((f) => path.join(masterDir, f.relativePath.split('/').join(path.sep)));

  // Every ancestor directory of every missing item (normal files AND the large file - its own containing
  // directory still needs a D| entry, since that's where the split pieces live too), plus the empty directory's
  // own full ancestor+self chain, deduped via a Set (the same directory legitimately shows up as an ancestor of
  // more than one missing item).
  const expectedMissingDirRelPathSet = new Set();
  for (const f of missingFiles) {
    for (const d of allAncestorDirs(f.relativePath.split('/').join(path.sep))) { expectedMissingDirRelPathSet.add(d); }
  }
  if (hasEmptyDir) {
    for (const d of allAncestorDirs(emptyDirRel, true)) { expectedMissingDirRelPathSet.add(d); }
  }
  const expectedMissingDirAbsPaths = [...expectedMissingDirRelPathSet].map((d) => path.join(masterDir, d));

  const normalIbbFileSet = new Set(normalIbbFileAbsPaths);
  const missingFileSet = new Set(expectedMissingFileAbsPaths);
  const filesMissingFromIbb = expectedMissingFileAbsPaths.filter((f) => !normalIbbFileSet.has(f));
  const filesExtraInIbb = normalIbbFileAbsPaths.filter((f) => !missingFileSet.has(f));
  const alreadyBackedUpThatLeakedIn = expectedAlreadyBackedUpAbsPaths.filter((f) => normalIbbFileSet.has(f));
  const seen = new Set();
  const duplicatesInIbb = [];
  for (const f of normalIbbFileAbsPaths) { if (seen.has(f)) { duplicatesInIbb.push(f); } else { seen.add(f); } }

  const ibbDirSet = new Set(ibbDirAbsPaths);
  const missingDirSet = new Set(expectedMissingDirAbsPaths);
  const dirsMissingFromIbb = expectedMissingDirAbsPaths.filter((d) => !ibbDirSet.has(d));
  const dirsExtraInIbb = ibbDirAbsPaths.filter((d) => !missingDirSet.has(d));

  console.log(`\nNormal .ibb file entries: ${normalIbbFileAbsPaths.length}, directory entries: ${ibbDirAbsPaths.length}.`);
  console.log(`  Expected missing files: ${expectedMissingFileAbsPaths.length}, already-backed-up files (should NOT appear): ${expectedAlreadyBackedUpAbsPaths.length}.`);
  console.log(`  MISSING FROM .ibb        : ${filesMissingFromIbb.length}`);
  console.log(`  EXTRA IN .ibb            : ${filesExtraInIbb.length}`);
  console.log(`  DUPLICATE IN .ibb        : ${duplicatesInIbb.length}`);
  console.log(`  ALREADY-BACKED-UP LEAKED : ${alreadyBackedUpThatLeakedIn.length} (this is the diff logic's own correctness check)`);
  console.log(`  DIRS MISSING FROM .ibb   : ${dirsMissingFromIbb.length}`);
  console.log(`  DIRS EXTRA IN .ibb       : ${dirsExtraInIbb.length}`);
  for (const f of filesMissingFromIbb.slice(0, 10)) { console.log(`    missing from .ibb: ${f}`); }
  for (const f of filesExtraInIbb.slice(0, 10)) { console.log(`    extra in .ibb: ${f}`); }
  for (const f of duplicatesInIbb.slice(0, 10)) { console.log(`    duplicate in .ibb: ${f}`); }
  for (const f of alreadyBackedUpThatLeakedIn.slice(0, 10)) { console.log(`    already-backed-up file leaked in: ${f}`); }
  for (const d of dirsMissingFromIbb.slice(0, 10)) { console.log(`    missing dir: ${d}`); }
  for (const d of dirsExtraInIbb.slice(0, 10)) { console.log(`    extra dir: ${d}`); }

  const normalCheckPassed = filesMissingFromIbb.length === 0 && filesExtraInIbb.length === 0
    && duplicatesInIbb.length === 0 && alreadyBackedUpThatLeakedIn.length === 0
    && dirsMissingFromIbb.length === 0 && dirsExtraInIbb.length === 0;

  // 3b. Verify the large file's real split pieces STRUCTURALLY - their exact names come from 7-Zip itself, not
  //     predicted in advance (unlike everything else above, which this script fully controls).
  console.log('\nVerifying the large file\'s real split pieces...');
  const originalLargeFileAbsPath = largeFileEntry ? path.join(masterDir, largeFileEntry.relativePath.split('/').join(path.sep)) : null;
  const largeFileBasename = largeFileEntry ? path.basename(largeFileEntry.relativePath) : null;
  const partNamePattern = largeFileBasename ? new RegExp('^' + escapeRegExp(largeFileBasename) + '\\.part\\.', 'i') : null;
  const partEntries = splitPieceIbbEntries
    .filter((e) => partNamePattern && partNamePattern.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const originalLargeFileLeakedWhole = normalIbbFileAbsPaths.includes(originalLargeFileAbsPath)
    || splitPieceIbbEntries.some((e) => e.fullSourcePath === originalLargeFileAbsPath);
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
  const splitCheckPassed = !largeFileEntry || (partCountCorrect && firstPieceSizeCorrect && totalSizeCorrect && !originalLargeFileLeakedWhole);

    // --- Phase E: confirm each new disc was burned, and verify ITS OWN real split pieces (if any) actually get
    // deleted - the whole point of the "confirm disc burned" feature (lazy per-disc materialization instead of
    // splitting every large file up front for the entire job). Uses perDiscFileEntries (captured above) rather
    // than the flattened, all-discs splitPieceIbbEntries, since confirming disc i must only ever delete disc i's
    // own pieces - never a different, not-yet-confirmed disc's, even if they share the same source file.
    // Confirmed in REVERSE order (last disc first) rather than sequentially - any-order confirmation is a real,
    // explicit part of this feature's design (both wizard steppers are non-linear, and nothing about
    // confirmDiscBurned assumes an earlier disc was confirmed first), so this deliberately exercises that rather
    // than only ever confirming in the same order discs were sent, which would leave "confirm out of order"
    // completely unverified.
    console.log('\nConfirming each new disc was burned (in reverse order), and verifying its real split pieces get cleaned up...');
    const confirmDeletionResults = [];
    const confirmOrder = [...Array(createdIbbPaths.length).keys()].reverse();
    for (const i of confirmOrder) {
      const discSplitPiecePaths = perDiscFileEntries[i]
        .filter((e) => e.fullSourcePath.startsWith(realTempDir))
        .map((e) => e.fullSourcePath);

      await step(`open new disc ${i + 1}'s step (for confirm)`, () =>
        win.getByRole('tab').nth(i).click({ timeout: 15_000 }));

      await step(`click "Confirm disc burned" for new disc ${i + 1}`, () =>
        win.getByRole('button', { name: 'Confirm disc burned' }).click({ timeout: 15_000 }));

      await step(`wait for new disc ${i + 1} to show as confirmed`, () =>
        win.getByRole('button', { name: 'Disc confirmed', exact: false }).waitFor({ timeout: 15_000 }));

      if (discSplitPiecePaths.length > 0) {
        // confirmDiscBurned awaits the real delete IPC call before its own button text updates, so by the time
        // the wait above resolves this should already be done - a short grace period only guards against any
        // last bit of filesystem latency, to avoid a flaky false failure.
        await new Promise((r) => setTimeout(r, 1000));
        const stillPresent = discSplitPiecePaths.filter((p) => fs.existsSync(p));
        const deleted = stillPresent.length === 0;
        confirmDeletionResults.push(deleted);
        console.log(`  new disc ${i + 1}: ${discSplitPiecePaths.length} real split piece(s), all deleted after confirm: ${deleted}`);
        if (!deleted) { console.log(`    STILL PRESENT: ${stillPresent.join(', ')}`); }
      } else {
        console.log(`  new disc ${i + 1}: no split pieces to clean up.`);
      }
    }
    const confirmCheckPassed = confirmDeletionResults.every(Boolean);

    // Fallback cleanup only - by this point confirmCheckPassed being true already means every real split-piece
    // file is gone, so this is normally a no-op (fs.existsSync guards make it safe either way). They're
    // disposable, one-time-use scratch artifacts either way (same reasoning as the .ibb cleanup above). Also
    // removes the now-empty "large-files" parent directory they were the only contents of, so cleanup.js finds
    // nothing left over on the next run.
    for (const p of splitPieceFilesToCleanUp) { if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); } }
    const splitPieceParentDirs = new Set(splitPieceFilesToCleanUp.map((p) => path.dirname(p)));
    for (const d of splitPieceParentDirs) {
      if (fs.existsSync(d) && fs.readdirSync(d).length === 0) { fs.rmdirSync(d); }
    }

  // 4. Verify (b): the updated metadata JSON preserves the original disc's entries untouched and correctly
  //    appends every new disc's entries (paths normalized to the D:\ convention, continuing the numbering) -
  //    including the split pieces, now that their real names are known from the .ibb parsing above.
  console.log('\nVerifying the updated cold storage metadata JSON...');
  const expectedTotalDiscs = 1 + EXPECTED_NEW_DISC_COUNT;
  const updatedMetadata = JSON.parse(fs.readFileSync(updatedMetadataJsonPath, 'utf8'));
  console.log(`  Existing metadata JSON (before, ${existingMetadataJsonPath}): ${existingMetadata.length} disc(s), ${existingMetadata[0].length} entries on disc 1.`);
  console.log(`  Updated metadata JSON (after, ${updatedMetadataJsonPath}): ${Array.isArray(updatedMetadata) ? updatedMetadata.length : '?'} disc(s), ` +
    (Array.isArray(updatedMetadata) ? updatedMetadata.map((d, i) => `disc ${i + 1} = ${d.length} entries`).join(', ') : 'not an array'));
  const hasExpectedDiscCount = Array.isArray(updatedMetadata) && updatedMetadata.length === expectedTotalDiscs;
  const originalDiscUnchanged = hasExpectedDiscCount && JSON.stringify(updatedMetadata[0]) === JSON.stringify(existingMetadata[0]);

  const expectedNewDiscRelPaths = new Set([
    ...normalMissingFiles.map((f) => f.relativePath.split('/').join(path.sep)),
    ...(hasEmptyDir ? [emptyDirRel + path.sep] : []),
    ...(hasMarkerFile ? [MARKER_FILE_NAME] : []),
    ...partEntries.map((e) => path.join('large-files', e.name)),
  ]);
  const actualNewDiscRelPaths = hasExpectedDiscCount
    ? new Set(updatedMetadata.slice(1).flat().map((e) => e.path.startsWith(OPTICAL_DRIVE_LETTER_CONVENTION) ? e.path.slice(OPTICAL_DRIVE_LETTER_CONVENTION.length) : e.path))
    : new Set();
  const newDiscMissing = [...expectedNewDiscRelPaths].filter((p) => !actualNewDiscRelPaths.has(p));
  const newDiscExtra = [...actualNewDiscRelPaths].filter((p) => !expectedNewDiscRelPaths.has(p));

  console.log(`  Updated JSON has ${Array.isArray(updatedMetadata) ? updatedMetadata.length : 'N/A'} disc(s) (expected ${expectedTotalDiscs}): ${hasExpectedDiscCount ? 'OK' : 'WRONG'}`);
  console.log(`  Original disc's entries unchanged: ${originalDiscUnchanged ? 'OK' : 'WRONG'}`);
  console.log(`  New discs' entries (combined) - missing: ${newDiscMissing.length}, extra: ${newDiscExtra.length}`);
  for (const p of newDiscMissing.slice(0, 10)) { console.log(`    missing from new discs' JSON entries: ${p}`); }
  for (const p of newDiscExtra.slice(0, 10)) { console.log(`    extra in new discs' JSON entries: ${p}`); }

  const jsonCheckPassed = hasExpectedDiscCount && originalDiscUnchanged && newDiscMissing.length === 0 && newDiscExtra.length === 0;

  // 5. Verify (c): the continued-disc-numbering regression check itself, for EVERY new disc - both the real
  //    burned volume label and the on-screen "Disc label" instruction text must say "Disc 2"/"Disc 3"/"Disc 4"
  //    (continuing from the 1 disc already in the existing cold storage), never "Disc 1"/"disc 1" (the bare local
  //    index this app used to show before the fix made while building this script - see getNextDiscNumber's own
  //    doc comment).
  console.log('\nVerifying disc numbering for every new disc...');
  let discNumberingCheckPassed = true;
  for (let i = 0; i < createdIbbPaths.length; i++) {
    const expectedDiscNumber = existingMetadata.length + i + 1; // existingMetadata always has exactly 1 disc here (= 2, 3, 4)
    const expectedVolumeLabel = `${COLD_STORAGE_COLLECTION_NAME} Disc ${expectedDiscNumber}`;
    const actualVolumeLabel = actualVolumeLabels[i];
    const dialogText = discLabelDialogTexts[i] || '';
    const volumeLabelCorrect = actualVolumeLabel === expectedVolumeLabel;
    const dialogMentionsExpected = new RegExp(`\\bdisc ${expectedDiscNumber}\\b`, 'i').test(dialogText);
    const dialogWronglyMentions1 = expectedDiscNumber !== 1 && /\bdisc 1\b/i.test(dialogText);
    console.log(`  Disc ${i + 1}/${createdIbbPaths.length}: real volume label = "${actualVolumeLabel}" (expected "${expectedVolumeLabel}") - ${volumeLabelCorrect ? 'OK' : 'WRONG'}`);
    console.log(`    On-screen text: "${dialogText}" - mentions "disc ${expectedDiscNumber}": ${dialogMentionsExpected ? 'OK' : 'WRONG'}, wrongly mentions "disc 1": ${dialogWronglyMentions1 ? 'WRONG - regression!' : 'OK'}`);
    if (!volumeLabelCorrect || !dialogMentionsExpected || dialogWronglyMentions1) { discNumberingCheckPassed = false; }
  }

    const verifyPassed = normalCheckPassed && splitCheckPassed && confirmCheckPassed && jsonCheckPassed && discNumberingCheckPassed;

    if (verifyPassed) {
      fs.rmSync(scratchRoot, { recursive: true, force: true });
    } else {
      console.log(`\nLeaving scratch files in place for inspection: ${scratchRoot}`);
    }

    console.log(`\n${verifyPassed ? 'PASS' : 'FAIL'} - add-missing-files ${verifyPassed ? 'correctly diffed against the existing cold storage, split the large missing file for real, burned only the missing files/directories/pieces across the new discs, correctly merged the updated metadata JSON with continued numbering, and cleaned each disc\'s pieces up on confirm.' : 'did not produce a correct result, see the counts above.'}`);
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
    const logPath = path.join(FIXTURES_ROOT, `optical-backup-ui-add-missing-files-test-error-${Date.now()}.log`);
    try { fs.writeFileSync(logPath, fullDetail); } catch { /* best effort */ }
    console.error(`\nTEST ERRORED: ${message}`);
    console.error(`Full details saved to: ${logPath}`);
  }
  process.exitCode = 1;
});
