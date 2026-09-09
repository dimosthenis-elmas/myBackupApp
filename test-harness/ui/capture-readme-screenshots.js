#!/usr/bin/env node
'use strict';

/**
 * Drives the real app through a small, harmless slice of EVERY one of the app's 6 main-menu features and saves
 * several real screenshots per feature, for you to pick from when updating the top-level README.md. Not a test -
 * there is no pass/fail assertion here, just win.screenshot() calls at points worth showing. Deliberately takes
 * MORE screenshots than any one feature strictly needs in a README, so there's something to choose between.
 *
 * Each feature launches and closes its OWN app instance (fresh main menu every time - simplest way to avoid one
 * feature's leftover state ever bleeding into the next one's screenshots).
 *
 * Kept deliberately fast and side-effect-free for 5 of the 6 features - every fixture tree there has NO large
 * file, so:
 *  - "Backup to optical media" never hits the "too large, split it?" confirmation chain.
 *  - "Add missing files" never actually needs a real 7-Zip split (partition() still runs, just instantly).
 *  - Neither of those, nor "Recover data from optical media", ever click "Send to ImgBurn" or mount a real/virtual
 *    disc - they stop right at the screen worth screenshotting. Nothing gets burned, split, or sent to any
 *    external program anywhere in this script.
 * The 6th, "Verify integrity of cold storage disc", is the one exception - it has no JSON-seeded shortcut around
 * reading a disc's real listing, so it DOES mount two real virtual .iso discs (dismounted again before it's done)
 * to get a real "one passed, one FAILED" tally worth screenshotting.
 *
 * NOTE: needs a real Windows desktop/window session (see worker-ipc/call-worker.js's top comment) - run from
 * your own interactive terminal. Also needs no optical media already mounted (see iso-disc.js) for the "Verify
 * integrity" capture specifically.
 *
 * Usage:
 *   node test-harness/ui/capture-readme-screenshots.js
 * Output (docs/screenshots/):
 *   main-menu.png
 *   backup-to-optical-media/01-step1-filled.png, 02-discs-confirmation.png, 03-step2-burn-screen.png
 *   incremental-backup/01-paths-chosen.png, 02-diff-select-all.png, 03-preview.png, 04-success.png
 *   sync-dirs/01-paths-chosen.png, 02-warning.png, 03-preview.png, 04-success.png
 *   recover-data/01-json-selected.png, 02-file-tree.png, 03-file-tree-select-all.png
 *   add-missing-files/01-step1-filled.png, 02-diff-results.png, 03-metadata-saved.png, 04-burn-screen.png
 *   verify-integrity/01-tally.png
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { launchApp, callWorker } = require('../worker-ipc/call-worker');
const { assertRealTempDataDirectoryIsSafeToUse } = require('../worker-ipc/temp-dir-guard');
const { assertNoOpticalMediaAlreadyMounted, buildIso, mountIso, dismountIso } = require('./iso-disc');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');
const { generateFixtureTree } = require('../lib/fixture-tree-source');
const { normalizeForMetadata } = require('../lib/cold-storage-metadata');

const OUTPUT_DIR = path.join(__dirname, '..', '..', 'docs', 'screenshots');
// Never read - none of the functions below ever pass --json-tree, so generateFixtureTree always takes the
// random-mode branch, which doesn't touch specDir at all.
const UNUSED_SPEC_DIR = path.join(__dirname, 'tree-specs', 'capture-readme-screenshots');

async function clickMainMenuButton(win, labelText) {
  const container = win.locator('.grid-container > div').filter({ has: win.locator('h2', { hasText: labelText }) });
  await container.locator('button').click();
}

/** Returns a shot(win, label, fileName) function that screenshots into docs/screenshots/<featureDir>/. */
function makeShot(featureDir) {
  const dir = path.join(OUTPUT_DIR, featureDir);
  fs.mkdirSync(dir, { recursive: true });
  return async (win, label, fileName) => {
    const target = path.join(dir, fileName);
    await win.screenshot({ path: target });
    console.log(`  [x] ${label} -> ${target}`);
  };
}

/** Queues native dialog responses, same stub every ui/test-*.js script uses (real app.evaluate into the main
 *  process - see app/main.ts's ipcMain.handle('dialog', ...), the one real path every "choose a folder/file"
 *  button in the app funnels through). */
async function stubDialogs(app, openPaths = [], savePaths = []) {
  await app.evaluate(({ dialog }, queues) => {
    const openQueue = [...queues.openPaths];
    const saveQueue = [...queues.savePaths];
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [openQueue.shift()] });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: saveQueue.shift() });
  }, { openPaths, savePaths });
}

function copyPreservingDirs(relativePath, srcRoot, destRoot) {
  const relOs = relativePath.split('/').join(path.sep);
  const destPath = path.join(destRoot, relOs);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(path.join(srcRoot, relOs), destPath);
}

async function pause(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

// ============================================================================================================
// Main menu
// ============================================================================================================
async function captureMainMenu() {
  console.log('\n=== Main menu ===');
  const shot = makeShot('.');
  let app, win;
  try {
    ({ app, win } = await launchApp());
    await win.getByText('Backup to optical media', { exact: false }).first().waitFor({ timeout: 15_000 });
    await pause(1000); // let anything else still settling (animations, etc.) finish
    await shot(win, 'Main menu', 'main-menu.png');
  } finally {
    if (app) { await app.close().catch(() => {}); }
  }
}

// ============================================================================================================
// Backup to optical media
// ============================================================================================================
async function captureBackupToOpticalMedia() {
  console.log('\n=== Backup to optical media ===');
  const shot = makeShot('backup-to-optical-media');
  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `shots-backup-${runId}`);
  const sourceRoot = path.join(scratchRoot, 'source');
  const metadataJsonPath = path.join(scratchRoot, 'cold-storage-metadata.json');

  generateFixtureTree({
    root: sourceRoot,
    randomArgs: ['--files', '10', '--max-depth', '2', '--min-size', '2000', '--max-size', '50000', '--seed', '2026042', '--no-edge-cases'],
    specDir: UNUSED_SPEC_DIR,
  });
  assertRealTempDataDirectoryIsSafeToUse();

  let app, win;
  try {
    ({ app, win } = await launchApp());
    await stubDialogs(app, [sourceRoot], [metadataJsonPath]);

    await clickMainMenuButton(win, 'Backup to optical media');
    await win.getByRole('button', { name: 'Path to backup' }).click({ timeout: 15_000 });
    await win.getByText(sourceRoot, { exact: true }).waitFor({ timeout: 10_000 });
    // .first() - step 1 now has a second combobox too (the "File integrity data" toggle); "Optical medium type"
    // is always the first one in DOM order.
    await win.getByRole('combobox').first().click({ timeout: 15_000 });
    await win.getByRole('option', { name: 'CD (700 MB)' }).click({ timeout: 15_000 });
    await win.getByPlaceholder('e.g. My Backup').fill('Documents Archive');
    await pause(500);
    await shot(win, 'Step 1 filled in', '01-step1-filled.png');

    await win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 });
    // No large file in this tree, so this goes straight to the "you will need N discs" confirmation - never the
    // "too large, split it?" chain (see ui/test-backup-to-optical-media.js for that chain).
    await win.getByText('Backup to optical medium', { exact: true }).waitFor({ timeout: 30_000 });
    await pause(500);
    await shot(win, '"You will need N discs" confirmation', '02-discs-confirmation.png');

    await win.getByRole('dialog').getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 });
    await win.getByText('Burn backup to optical media', { exact: true }).waitFor({ timeout: 30_000 });
    await pause(1000);
    await shot(win, 'Step 2 burn screen', '03-step2-burn-screen.png');
  } finally {
    if (app) { await app.close().catch(() => {}); }
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
}

// ============================================================================================================
// Cumulative (incremental) backup
// ============================================================================================================
async function captureIncrementalBackup() {
  console.log('\n=== Cumulative (incremental) backup ===');
  const shot = makeShot('incremental-backup');
  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `shots-incremental-${runId}`);
  const sourceRoot = path.join(scratchRoot, 'source');
  const targetRoot = path.join(scratchRoot, 'target');

  generateFixtureTree({
    root: sourceRoot,
    randomArgs: ['--files', '12', '--max-depth', '2', '--min-size', '0', '--max-size', '20000', '--seed', '13131', '--no-edge-cases'],
    specDir: UNUSED_SPEC_DIR,
  });
  fs.mkdirSync(targetRoot, { recursive: true }); // must pre-exist - stands in for what the folder-picker would return

  let app, win;
  try {
    ({ app, win } = await launchApp());
    await stubDialogs(app, [sourceRoot, targetRoot]);

    await clickMainMenuButton(win, 'Cumulative backup');
    await win.getByRole('button', { name: 'Source directory path' }).click({ timeout: 15_000 });
    await win.getByText(sourceRoot, { exact: true }).waitFor({ timeout: 10_000 });
    await win.getByRole('button', { name: 'Backup directory path' }).click({ timeout: 15_000 });
    await win.getByText(targetRoot, { exact: true }).waitFor({ timeout: 10_000 });
    await pause(500);
    await shot(win, 'Paths chosen', '01-paths-chosen.png');

    await win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 });
    await win.getByRole('checkbox', { name: 'Select all' }).waitFor({ timeout: 30_000 });
    await win.getByRole('checkbox', { name: 'Select all' }).click({ timeout: 15_000 });
    await pause(500);
    await shot(win, 'Diff screen, everything selected', '02-diff-select-all.png');

    await win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 });
    await win.getByRole('button', { name: 'Write to the backup' }).waitFor({ timeout: 30_000 });
    await pause(500);
    await shot(win, 'Preview dialog', '03-preview.png');

    await win.getByRole('button', { name: 'Write to the backup' }).click({ timeout: 30_000 });
    await win.getByRole('button', { name: 'Yes', exact: true }).click({ timeout: 15_000 });
    await win.getByRole('button', { name: 'Ok', exact: true }).waitFor({ timeout: 60_000 });
    await pause(500);
    await shot(win, 'Success dialog', '04-success.png');
  } finally {
    if (app) { await app.close().catch(() => {}); }
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
}

// ============================================================================================================
// Synchronize directories
// ============================================================================================================
async function captureSyncDirs() {
  console.log('\n=== Synchronize directories ===');
  const shot = makeShot('sync-dirs');
  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `shots-sync-${runId}`);
  const sourceRoot = path.join(scratchRoot, 'source');
  const targetRoot = path.join(scratchRoot, 'target');

  generateFixtureTree({
    root: sourceRoot,
    randomArgs: ['--files', '12', '--max-depth', '2', '--min-size', '0', '--max-size', '20000', '--seed', '246810', '--no-edge-cases'],
    specDir: UNUSED_SPEC_DIR,
  });
  console.log('Establishing baseline (target = copy of source)...');
  fs.cpSync(sourceRoot, targetRoot, { recursive: true });
  // Diverge a little so the preview/diff screen actually has something to show (a copy and a delete).
  fs.writeFileSync(path.join(sourceRoot, 'new-file-added-to-source.dat'), crypto.randomBytes(9000));
  fs.mkdirSync(path.join(targetRoot, 'leftover-only-dir'), { recursive: true });
  fs.writeFileSync(path.join(targetRoot, 'leftover-only-dir', 'leftover.dat'), crypto.randomBytes(1234));

  let app, win;
  try {
    ({ app, win } = await launchApp());
    await stubDialogs(app, [sourceRoot, targetRoot]);

    await clickMainMenuButton(win, 'Synchronize directories');
    await win.getByRole('button', { name: 'Path to the template directory' }).click({ timeout: 15_000 });
    await win.getByText(sourceRoot, { exact: true }).waitFor({ timeout: 10_000 });
    await win.getByRole('button', { name: 'Path to the directory to be synchronized with the template' }).click({ timeout: 15_000 });
    await win.getByText(targetRoot, { exact: true }).waitFor({ timeout: 10_000 });
    await pause(500);
    await shot(win, 'Paths chosen', '01-paths-chosen.png');

    await win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 });
    await win.getByRole('button', { name: 'Continue', exact: true }).waitFor({ timeout: 15_000 });
    await pause(500);
    await shot(win, 'Destructive-operation warning', '02-warning.png');

    await win.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 15_000 });
    await win.getByRole('button', { name: 'Write to the backup' }).waitFor({ timeout: 30_000 });
    await pause(500);
    await shot(win, 'Preview dialog', '03-preview.png');

    await win.getByRole('button', { name: 'Write to the backup' }).click({ timeout: 30_000 });
    await win.getByRole('button', { name: 'Yes, continue', exact: true }).click({ timeout: 15_000 });
    await win.getByRole('button', { name: 'Ok', exact: true }).waitFor({ timeout: 60_000 });
    await pause(500);
    await shot(win, 'Success dialog', '04-success.png');
  } finally {
    if (app) { await app.close().catch(() => {}); }
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
}

// ============================================================================================================
// Recover data from optical media (JSON entry point - never mounts a disc, see header comment)
// ============================================================================================================
async function captureRecoverData() {
  console.log('\n=== Recover data from optical media ===');
  const shot = makeShot('recover-data');
  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `shots-recover-${runId}`);
  const sourceRoot = path.join(scratchRoot, 'source');
  const disc1Dir = path.join(scratchRoot, 'disc1-files');
  const disc2Dir = path.join(scratchRoot, 'disc2-files');
  const outputRoot = path.join(scratchRoot, 'recovered');
  const metadataJsonPath = path.join(scratchRoot, 'cold-storage-metadata.json');
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.mkdirSync(disc1Dir, { recursive: true });
  fs.mkdirSync(disc2Dir, { recursive: true });

  generateFixtureTree({
    root: sourceRoot,
    randomArgs: ['--files', '16', '--max-depth', '2', '--min-size', '0', '--max-size', '20000', '--seed', '335577', '--no-edge-cases'],
    specDir: UNUSED_SPEC_DIR,
  });
  const manifest = JSON.parse(fs.readFileSync(`${sourceRoot}.manifest.json`, 'utf8'));
  const half = Math.ceil(manifest.files.length / 2);
  for (const f of manifest.files.slice(0, half)) { copyPreservingDirs(f.relativePath, sourceRoot, disc1Dir); }
  for (const f of manifest.files.slice(half)) { copyPreservingDirs(f.relativePath, sourceRoot, disc2Dir); }

  let app, win;
  try {
    ({ app, win } = await launchApp());
    // Avoid racing app.component.ts's own startup housekeeping IPC call(s) - see captureAddMissingFiles's
    // identical pause below, and ui/test-add-missing-files.js's own comment, for the full explanation:
    // WorkerCommunicator's sendAndAwaitResponse removes ALL 'message-from-worker' listeners (not just its own)
    // once any call resolves, so if the startup housekeeping call's own response arrives while this script's
    // callWorker() below is still waiting for its own response, that cleanup wipes out this listener too and the
    // real response - once it does arrive - has nothing left listening for it.
    await pause(3000);

    // Same technique as ui/test-recover-from-json-metadata.js: ask the app's own real IPC for each disc folder's
    // real listing, build the metadata JSON from that - no real disc/iso needed for the screens captured here.
    console.log('Asking the app for each disc\'s real file listing (get-file-paths-with-stats)...');
    const disc1Listing = (await callWorker(win, 'get-file-paths-with-stats', { dirPath: disc1Dir })).res;
    const disc2Listing = (await callWorker(win, 'get-file-paths-with-stats', { dirPath: disc2Dir })).res;
    const coldStorageMetadata = [
      normalizeForMetadata(disc1Listing, disc1Dir),
      normalizeForMetadata(disc2Listing, disc2Dir),
    ];
    fs.writeFileSync(metadataJsonPath, JSON.stringify(coldStorageMetadata, null, 2));

    await stubDialogs(app, [outputRoot, metadataJsonPath]);

    await clickMainMenuButton(win, 'Recover data from optical media backup');
    await win.getByRole('button', { name: 'Select a directory to save the recovered files' }).click({ timeout: 15_000 });
    await win.getByText(outputRoot, { exact: true }).waitFor({ timeout: 10_000 });
    await win.getByRole('checkbox', { name: 'Provide cold storage files metadata by importing a JSON file' }).click({ timeout: 15_000 });
    await win.getByRole('button', { name: 'Select JSON file' }).click({ timeout: 15_000 });
    await win.getByText(metadataJsonPath, { exact: true }).waitFor({ timeout: 10_000 });
    await pause(1500); // avoid the validation-IPC race documented in ui/test-recover-from-json-metadata.js
    await shot(win, 'Step 1, JSON selected', '01-json-selected.png');

    await win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 });
    // Straight to file selection - step_2's "insert disc" screen is skipped entirely with a JSON-seeded listing.
    await win.getByRole('checkbox', { name: 'Select all' }).waitFor({ state: 'visible', timeout: 60_000 });
    await pause(500);
    await shot(win, 'Combined files tree (from JSON, no disc reads needed)', '02-file-tree.png');

    await win.getByRole('checkbox', { name: 'Select all' }).click({ timeout: 15_000 });
    await pause(500);
    await shot(win, 'Files tree, everything selected', '03-file-tree-select-all.png');
  } finally {
    if (app) { await app.close().catch(() => {}); }
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
}

// ============================================================================================================
// Add missing files to optical media cold storage (no large file - partition() runs instantly, no ImgBurn click)
// ============================================================================================================
async function captureAddMissingFiles() {
  console.log('\n=== Add missing files to optical media cold storage ===');
  const shot = makeShot('add-missing-files');
  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `shots-add-missing-${runId}`);
  const masterDir = path.join(scratchRoot, 'master');
  const existingDisc1Dir = path.join(scratchRoot, 'existing-disc1-files');
  const existingMetadataJsonPath = path.join(scratchRoot, 'existing-cold-storage-metadata.json');
  const updatedMetadataJsonPath = path.join(scratchRoot, 'updated-cold-storage-metadata.json');

  generateFixtureTree({
    root: masterDir,
    randomArgs: ['--files', '16', '--max-depth', '2', '--min-size', '0', '--max-size', '20000', '--seed', '445566', '--no-edge-cases'],
    specDir: UNUSED_SPEC_DIR,
  });
  const manifest = JSON.parse(fs.readFileSync(`${masterDir}.manifest.json`, 'utf8'));
  const half = Math.ceil(manifest.files.length / 2);
  const existingFiles = manifest.files.slice(0, half); // second half is left out - the wizard's diff discovers it as "missing"
  for (const f of existingFiles) { copyPreservingDirs(f.relativePath, masterDir, existingDisc1Dir); }

  assertRealTempDataDirectoryIsSafeToUse();

  let app, win;
  try {
    ({ app, win } = await launchApp());
    // Avoid racing app.component.ts's own startup housekeeping IPC call(s) - see ui/test-add-missing-files.js's
    // own comment on this exact race.
    await pause(3000);

    console.log('Asking the app for the existing disc\'s real file listing (get-file-paths-with-stats)...');
    const existingListing = (await callWorker(win, 'get-file-paths-with-stats', { dirPath: existingDisc1Dir })).res;
    const existingMetadata = [normalizeForMetadata(existingListing, existingDisc1Dir)];
    fs.writeFileSync(existingMetadataJsonPath, JSON.stringify(existingMetadata, null, 2));

    await stubDialogs(app, [masterDir, existingMetadataJsonPath], [updatedMetadataJsonPath]);

    await clickMainMenuButton(win, 'Add missing files to optical media cold storage');
    // ngAfterViewInit() unconditionally opens a "This app is a work in progress..." warning the instant the
    // wizard loads - see add-missing-files-to-optical-media-cold-storage.component.ts.
    await win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 });

    await win.getByRole('button', { name: 'Select the location of your files (Master)' }).click({ timeout: 15_000 });
    await win.getByText(masterDir, { exact: true }).waitFor({ timeout: 10_000 });
    await win.getByRole('combobox').click({ timeout: 15_000 });
    await win.getByRole('option', { name: 'CD (700 MB)' }).click({ timeout: 15_000 });
    await win.getByRole('checkbox', { name: 'Provide cold storage files metadata by importing a JSON file', exact: false }).click({ timeout: 15_000 });
    await win.getByRole('button', { name: 'Select JSON file' }).click({ timeout: 15_000 });
    await win.getByText(existingMetadataJsonPath, { exact: true }).waitFor({ timeout: 10_000 });
    await pause(2000); // avoid the validation-IPC race documented in ui/test-add-missing-files.js
    await shot(win, 'Step 1 filled in', '01-step1-filled.png');

    await win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 });
    await win.getByText('Below you see the files missing from your cold storage.', { exact: true }).waitFor({ timeout: 30_000 });
    await win.getByRole('checkbox', { name: 'Select all' }).waitFor({ state: 'visible', timeout: 60_000 });
    await win.getByPlaceholder('e.g. My Backup').fill('Documents Archive');
    await pause(500);
    await shot(win, 'Diff results - files missing from cold storage', '02-diff-results.png');

    // No large file in this tree, so partition() completes almost instantly - no real 5-minute 7-Zip wait needed.
    await win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 });
    await win.getByText('Cold storage metadata prepared', { exact: true }).waitFor({ timeout: 60_000 });
    await pause(500);
    await shot(win, 'Metadata saved confirmation', '03-metadata-saved.png');

    await win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 });
    await win.getByRole('button', { name: 'Send disk 1 to ImgBurn' }).waitFor({ timeout: 30_000 });
    await pause(500);
    await shot(win, 'Burn screen (new disc)', '04-burn-screen.png');
  } finally {
    if (app) { await app.close().catch(() => {}); }
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
}

// ============================================================================================================
// Verify integrity of cold storage disc (one representative screenshot: the "Verify another disc?" running
// tally, now a real scrolling list - see ConfirmationDialogComponent's own `lists` field - rather than the
// single joined "disc 1 passed, disc 2 FAILED, ..." line an earlier version of this dialog used). Unlike every
// capture above, this one DOES mount real virtual discs - the wizard has no JSON-seeded shortcut around that
// (it always reads a disc's real listing to auto-identify it), and a mix of one passed + one FAILED disc is
// what actually makes the tally worth screenshotting.
// ============================================================================================================
async function buildDiscMetadataWithRealHashes(win, discDir, manifest) {
  const listing = (await callWorker(win, 'get-file-paths-with-stats', { dirPath: discDir })).res;
  const normalized = normalizeForMetadata(listing, discDir);
  const hashByRelativePath = new Map(manifest.files.map((f) => [f.relativePath, f.sha256]));
  for (const entry of normalized) {
    if (entry.stats.isDirectory) { continue; }
    const relPosix = entry.path.replace(/^D:\\/, '').split(path.sep).join('/');
    const hash = hashByRelativePath.get(relPosix);
    if (!hash) { throw new Error(`No manifest hash found for "${relPosix}" on disc at ${discDir}.`); }
    entry.stats.sha256 = hash;
  }
  return normalized;
}

async function captureVerifyIntegrity() {
  console.log('\n=== Verify integrity of cold storage disc ===');
  const shot = makeShot('verify-integrity');
  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `shots-verify-${runId}`);
  const sourceRoot = path.join(scratchRoot, 'source');
  const disc1Dir = path.join(scratchRoot, 'disc1-files');
  const disc2Dir = path.join(scratchRoot, 'disc2-files');
  const disc1IsoPath = path.join(scratchRoot, 'disc1.iso');
  const disc2IsoPath = path.join(scratchRoot, 'disc2.iso');
  const metadataJsonPath = path.join(scratchRoot, 'cold-storage-metadata.json');
  fs.mkdirSync(disc1Dir, { recursive: true });
  fs.mkdirSync(disc2Dir, { recursive: true });

  generateFixtureTree({
    root: sourceRoot,
    randomArgs: ['--files', '10', '--max-depth', '2', '--min-size', '1000', '--max-size', '20000', '--seed', '778899', '--no-edge-cases'],
    specDir: UNUSED_SPEC_DIR,
  });
  const manifest = JSON.parse(fs.readFileSync(`${sourceRoot}.manifest.json`, 'utf8'));
  const half = Math.ceil(manifest.files.length / 2);
  const disc1Files = manifest.files.slice(0, half);
  const disc2Files = manifest.files.slice(half);
  for (const f of disc1Files) { copyPreservingDirs(f.relativePath, sourceRoot, disc1Dir); }
  for (const f of disc2Files) { copyPreservingDirs(f.relativePath, sourceRoot, disc2Dir); }

  assertNoOpticalMediaAlreadyMounted();

  let app, win, mountedIsoPath;
  try {
    ({ app, win } = await launchApp());
    await pause(3000); // avoid racing app.component.ts's own startup housekeeping IPC call - see captureRecoverData

    console.log('Asking the app for each disc\'s real file listing + attaching real sha256 from the manifest...');
    const disc1Entries = await buildDiscMetadataWithRealHashes(win, disc1Dir, manifest);
    const disc2Entries = await buildDiscMetadataWithRealHashes(win, disc2Dir, manifest);
    fs.writeFileSync(metadataJsonPath, JSON.stringify([disc1Entries, disc2Entries], null, 2));

    // Corrupt one file on disc 2 AFTER its hash was already recorded above - same technique
    // ui/test-verify-cold-storage-integrity.js uses - so the tally ends up showing one passed + one FAILED disc,
    // not two identical "passed" entries.
    const corruptedFile = disc2Files.find((f) => f.sizeBytes > 0);
    const corruptedAbsPath = path.join(disc2Dir, corruptedFile.relativePath.split('/').join(path.sep));
    const tamperedBytes = fs.readFileSync(corruptedAbsPath);
    tamperedBytes[0] = tamperedBytes[0] ^ 0xFF;
    fs.writeFileSync(corruptedAbsPath, tamperedBytes);

    console.log('Building disc1.iso and disc2.iso...');
    buildIso(disc1Dir, disc1IsoPath, 'SHOTDISC1');
    buildIso(disc2Dir, disc2IsoPath, 'SHOTDISC2');
    console.log('Mounting disc 1...');
    mountIso(disc1IsoPath);
    mountedIsoPath = disc1IsoPath;

    await stubDialogs(app, [metadataJsonPath]);

    await clickMainMenuButton(win, 'Verify integrity of cold storage disc');
    await win.getByRole('button', { name: 'Choose metadata JSON' }).click({ timeout: 15_000 });

    await win.getByText('Disc 1: verification successful', { exact: true }).waitFor({ timeout: 60_000 });
    await win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 });
    await win.getByText('Verify another disc?', { exact: true }).waitFor({ timeout: 15_000 });

    // Swap discs BEFORE telling the wizard to look again - same disc-swap rule every recovery/verify script here
    // follows (waitForOpticalDiskToBeMounted only checks "is ANY optical drive currently showing media").
    console.log('Swapping discs (dismount disc 1, mount disc 2)...');
    dismountIso(disc1IsoPath);
    mountIso(disc2IsoPath);
    mountedIsoPath = disc2IsoPath;

    await win.getByRole('button', { name: 'Verify another disc', exact: true }).click({ timeout: 15_000 });
    await win.getByText('Disc 2: verification FAILED', { exact: true }).waitFor({ timeout: 60_000 });
    await win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 });

    await win.getByText('Verify another disc?', { exact: true }).waitFor({ timeout: 15_000 });
    await pause(500);
    await shot(win, 'Running tally as a scrolling list (one passed, one FAILED)', '01-tally.png');
  } finally {
    // Same ordering rule as every other script here that mounts an .iso - MUST dismount before scratchRoot is
    // deleted below, since Windows keeps the backing .iso file locked while it's mounted.
    if (app) { await app.close().catch(() => {}); }
    if (mountedIsoPath) { dismountIso(mountedIsoPath); }
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const features = [
    ['Main menu', captureMainMenu],
    ['Backup to optical media', captureBackupToOpticalMedia],
    ['Cumulative (incremental) backup', captureIncrementalBackup],
    ['Synchronize directories', captureSyncDirs],
    ['Recover data from optical media', captureRecoverData],
    ['Add missing files to optical media cold storage', captureAddMissingFiles],
    ['Verify integrity of cold storage disc', captureVerifyIntegrity],
  ];

  const results = [];
  for (const [name, fn] of features) {
    try {
      await fn();
      results.push([name, 'OK']);
    } catch (e) {
      console.error(`\nFAILED capturing "${name}": ${(e && e.stack) || e}`);
      results.push([name, 'FAILED']);
    }
  }

  console.log('\nSummary:');
  for (const [name, status] of results) {
    console.log(`  ${status === 'OK' ? 'OK   ' : 'FAILED'} - ${name}`);
  }
  console.log(`\nScreenshots saved under: ${OUTPUT_DIR}`);
  process.exitCode = results.some(([, status]) => status === 'FAILED') ? 1 : 0;
}

main().catch((e) => {
  console.error(`\nFAILED: ${(e && e.stack) || e}`);
  process.exitCode = 1;
});
