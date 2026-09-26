#!/usr/bin/env node
'use strict';

/**
 * A split file whose pieces' names are too long for a disc, clicked through the real wizards - the discs in between
 * built by the real ImgBurn from the projects the app wrote:
 *
 *  1. Backup to optical media, of a real 700 MB file whose 120-character name fits on a disc (at most 127) but whose
 *     pieces' names (".part.001" added, 129) do not: "Large files found" -> split; "Names too long for a disc" lists
 *     the file itself, once, by its full path; "Continue" plans two discs, one piece each. Both are sent (ImgBurn is a
 *     no-op stub for the wizard), built by the real ImgBurn without a single name changed, and confirmed burned.
 *  2. Recover data from that JSON: the tree shows the pieces under their original names; both discs are inserted in
 *     turn; "Partial files detected" names the file to rejoin under its original name; "Yes, reassemble" - and the
 *     recovered folder then holds just that file, byte for byte the original (SHA-256).
 *  The source file is never changed.
 *
 * Never touches the app's real temp folder: cacheDataDirectoryPath points at a scratch folder, and
 * imgBurnExecutablePath at a no-op stub, for the length of the run (the real ImgBurn is only run by this script
 * itself, headless) - config.json is restored byte-for-byte in a finally block.
 *
 * NOTE: needs a real Windows desktop/window session, ImgBurn configured in appData/config.json, and about 3 GB of free
 * space. Refuses to run while an optical drive has a disc in it (it mounts images).
 *
 * Usage:
 *   node test-harness/ui/test-long-names-split-file.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { launchApp } = require('../worker-ipc/call-worker');
const { backupAndRedirectConfigField, restoreConfig, writeStubImgBurnBat, waitForFile, confirmedAfterDismissingLinkedDiscsNotice } = require('../lib/ibb-tools');
const { realImgBurnPath, buildIsoWithImgBurn } = require('../lib/imgburn-build');
const { writeRandomFile } = require('../lib/random-file-writer');
const { assertNoOpticalMediaAlreadyMounted, mountIso, dismountIso } = require('./iso-disc');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');
const { discName } = require('../../app/workers/disc-names');

// Fits on a disc (120); its pieces' names (129) do not. 700 MB splits into two 500 MiB-based pieces, one per CD (see
// worker-ipc/test-large-file-split.js for the arithmetic).
const FILE_NAME = 'Conference_talk_recording_' + 'r'.repeat(90) + '.mkv';
const FILE_REL = `videos\\${FILE_NAME}`;
const FILE_BYTES = 700_000_000;
const WATCH_PAUSE_MS = 700;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sha256Streamed = (file) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  fs.createReadStream(file).on('error', reject).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
});

async function main() {
  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `long-names-split-${runId}`);
  const source = path.join(scratchRoot, 'source');
  const cache = path.join(scratchRoot, 'app temp');
  const metadataJsonPath = path.join(scratchRoot, 'cold-storage-metadata.json');
  const recovered = path.join(scratchRoot, 'recovered');
  const isoPaths = [1, 2].map((n) => path.join(scratchRoot, `disc ${n}.iso`));
  const sourceFile = path.join(source, FILE_REL);
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.mkdirSync(recovered, { recursive: true });
  const originalSha256 = writeRandomFile(sourceFile, FILE_BYTES);
  const sourceMtimeBefore = fs.statSync(sourceFile).mtimeMs;

  assertNoOpticalMediaAlreadyMounted();
  const results = {};
  const report = (name, ok, extra) => {
    results[name] = ok;
    console.log(`  ${ok ? 'OK' : 'FAILED'} - ${name}${extra ? `  (${extra})` : ''}`);
  };

  let originalConfigContent;
  let app, win;
  const mounted = new Set();
  const step = async (label, fn) => {
    process.stdout.write(`  [ ] ${label} ... `);
    try {
      await fn();
    } catch (e) {
      console.log('FAILED');
      const screenshotPath = path.join(FIXTURES_ROOT, `long-names-split-test-failure-${runId}.png`);
      try { await win.screenshot({ path: screenshotPath }); console.log(`  Screenshot at the point of failure: ${screenshotPath}`); } catch { /* window gone */ }
      throw e;
    }
    console.log('done');
    await pause(WATCH_PAUSE_MS);
  };
  const launch = async (openPaths, savePaths = []) => {
    ({ app, win } = await launchApp());
    await win.getByText('Cumulative backup', { exact: true }).waitFor({ timeout: 60_000 });
    await pause(3000); // the app's own startup temp-folder check
    await app.evaluate(({ dialog }, { open, save }) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [open.shift()] });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: save.shift() });
    }, { open: [...openPaths], save: [...savePaths] });
  };
  const close = async () => { if (app) { await app.close().catch(() => {}); app = undefined; } };
  const openFeature = (name) => win.locator('.grid-container > div').filter({ has: win.locator('h2', { hasText: name }) }).locator('button').click();
  const dialogTitled = (title) => win.getByRole('dialog').filter({ has: win.getByRole('heading', { name: title, exact: true }) }).last();
  const clickIn = (title, button) => dialogTitled(title).getByRole('button', { name: button, exact: true }).click({ timeout: 15_000 });
  const mount = (iso) => { mountIso(iso); mounted.add(iso); };
  const dismount = (iso) => { dismountIso(iso); mounted.delete(iso); };

  try {
    originalConfigContent = backupAndRedirectConfigField('cacheDataDirectoryPath', cache);
    const imgBurnExe = realImgBurnPath(originalConfigContent);
    const stub = path.join(scratchRoot, 'stub imgburn.bat');
    writeStubImgBurnBat(stub);
    backupAndRedirectConfigField('imgBurnExecutablePath', stub);

    // ---- 1. Backup to optical media
    console.log('\n1. Backup to optical media...');
    await launch([source], [metadataJsonPath]);
    await step('main menu -> Backup to optical media; folder, "CD (700 MB)", a name', async () => {
      await openFeature('Backup to optical media');
      await win.getByRole('button', { name: 'Path to backup' }).click({ timeout: 15_000 });
      await win.getByText(source, { exact: true }).waitFor({ timeout: 10_000 });
      await win.getByRole('combobox').click({ timeout: 15_000 });
      await win.getByRole('option', { name: 'CD (700 MB)' }).click({ timeout: 15_000 });
      await win.getByPlaceholder('e.g. My Backup').fill('Split file test');
    });
    await step('"Next" - "Large files found", "Yes, split the large files", "Ok, got it."', async () => {
      await win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 });
      await clickIn('Large files found', 'Yes, split the large files');
      await clickIn('Info', 'Ok, got it.');
    });
    await step('"Names too long for a disc" lists the file itself, once', async () => {
      const dialog = dialogTitled('Names too long for a disc');
      await dialog.waitFor({ timeout: 60_000 });
      await dialog.getByText(sourceFile, { exact: true }).waitFor({ timeout: 10_000 });
    });
    const listedItems = await dialogTitled('Names too long for a disc').locator('.confirmation-dialog-list-item').allInnerTexts();
    report('theDialogListsTheFileOnceNotItsPieces', listedItems.length === 1 && listedItems[0].trim() === sourceFile, listedItems.join(' | '));
    await step('"Continue - shorten them on the disc", then the disc count dialog, "Next"', async () => {
      await clickIn('Names too long for a disc', 'Continue - shorten them on the disc');
      await win.getByText('Backup to optical medium', { exact: true }).waitFor({ timeout: 60_000 });
      await win.getByRole('dialog').getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 });
      await win.getByText('Burn backup to optical media', { exact: true }).waitFor({ timeout: 30_000 });
      // The discs' tabs, once the "Building files tree" dialog has closed - an open dialog hides the page behind it.
      await win.getByRole('tab').first().waitFor({ timeout: 60_000 });
    });
    const discCount = await win.getByRole('tab').count();
    report('twoDiscsOnePieceEach', discCount === 2, `${discCount} discs`);

    let sessionDir;
    for (let d = 1; d <= discCount; d++) {
      await step(`disc ${d}: "Send to ImgBurn", "Ok" on the disc label (the first send splits the file for real)`, async () => {
        await win.getByRole('tab', { name: `Optical disk ${d}`, exact: false }).click({ timeout: 15_000 });
        await pause(700); // the step's expand animation - both panels are on screen until it ends
        await win.getByRole('button', { name: 'Send to ImgBurn' }).click({ timeout: 15_000 });
        await win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 5 * 60_000 });
      });
      if (!sessionDir) {
        for (let i = 0; i < 75 && !sessionDir; i++) {
          const found = fs.existsSync(cache) ? fs.readdirSync(cache).filter((n) => /^session-\d+$/.test(n)) : [];
          if (found.length > 0) { sessionDir = path.join(cache, found[0]); } else { await pause(200); }
        }
      }
      await waitForFile(path.join(sessionDir, `Disk_${d}.ibb`), 60_000);
    }

    // Built before "Confirm disc burned", which deletes the pieces from the temp folder - as a real burn comes first.
    console.log('\nBuilding both disc images with the real ImgBurn...');
    const builds = isoPaths.map((iso, i) => buildIsoWithImgBurn(imgBurnExe, path.join(sessionDir, `Disk_${i + 1}.ibb`), iso, path.join(scratchRoot, `imgburn ${i + 1}.log`)));
    report('imgBurnBuildsBothDiscsWithoutChangingAName', builds.every((b) => b.built && b.problems.length === 0),
      builds.flatMap((b) => b.problems).join(' / '));

    for (let d = 1; d <= discCount; d++) {
      await step(`disc ${d}: "Confirm disc burned"`, async () => {
        await win.getByRole('tab', { name: `Optical disk ${d}`, exact: false }).click({ timeout: 15_000 });
        await pause(700); // the step's expand animation - both panels are on screen until it ends
        await win.getByRole('button', { name: 'Confirm disc burned' }).click({ timeout: 15_000 });
        await confirmedAfterDismissingLinkedDiscsNotice(win);
      });
    }
    const recordedDiscs = () => { try { return JSON.parse(fs.readFileSync(metadataJsonPath, 'utf8')).filter((disc) => disc.length > 0).length; } catch { return 0; } };
    for (let i = 0; i < 60 && recordedDiscs() < 2; i++) { await pause(500); }
    await close();
    const json = JSON.parse(fs.readFileSync(metadataJsonPath, 'utf8'));
    const pieceEntries = json.flat().filter((e) => e.originalPath && /\.part\.\d+$/.test(e.originalPath));
    report('theJsonRecordsBothPiecesWithTheirOriginalPaths',
      pieceEntries.length === 2 && pieceEntries.every((e) => e.path === 'D:\\videos\\' + discName(e.originalPath.split('\\').pop())),
      pieceEntries.map((e) => e.path.split('\\').pop()).join(' | '));

    // ---- 2. Recover from the JSON, rejoining the file
    console.log('\n2. Recover data, from the JSON, rejoining the file...');
    await launch([recovered, metadataJsonPath]);
    await step('main menu -> Recover data; an empty folder and the JSON, "Next"', async () => {
      await openFeature('Recover data from optical media backup');
      await win.getByRole('button', { name: 'Select a directory to save the recovered files' }).click({ timeout: 15_000 });
      await win.getByText(recovered, { exact: true }).waitFor({ timeout: 10_000 });
      await win.getByRole('checkbox', { name: 'Provide cold storage files metadata by importing a JSON file' }).click({ timeout: 15_000 });
      await win.getByRole('button', { name: 'Select JSON file' }).click({ timeout: 15_000 });
      await win.getByText(metadataJsonPath, { exact: true }).waitFor({ timeout: 10_000 });
      await pause(2000); // the JSON is still being read and checked
      await win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 });
      await win.getByRole('checkbox', { name: 'Select all' }).waitFor({ state: 'visible', timeout: 60_000 });
    });
    const shown = async (name) => win.getByRole('checkbox', { name: new RegExp(escapeRegExp(name)) }).count();
    report('theTreeShowsThePiecesUnderTheirOriginalNames',
      (await shown(`${FILE_NAME}.part.001`)) === 1 && (await shown(`${FILE_NAME}.part.002`)) === 1
      && (await shown(discName(`${FILE_NAME}.part.001`))) === 0);
    await step('"Select all", "Recover selected data" (and "Continue" if the recovered paths are too long)', async () => {
      await win.getByRole('checkbox', { name: 'Select all' }).click({ timeout: 15_000 });
      await win.getByRole('button', { name: 'Recover selected data' }).click({ timeout: 15_000 });
      const tooLong = dialogTitled('Paths too long for some programs');
      const insertDiscs = dialogTitled('Data recovery from optical media backup');
      await Promise.race([tooLong.waitFor({ timeout: 30_000 }).catch(() => {}), insertDiscs.waitFor({ timeout: 30_000 }).catch(() => {})]);
      if ((await tooLong.count()) > 0) { await clickIn('Paths too long for some programs', 'Continue - recover them here'); }
      await insertDiscs.waitFor({ timeout: 30_000 });
    });
    await step('insert disc 1, "Ok"; wait for its piece', async () => {
      mount(isoPaths[0]);
      await clickIn('Data recovery from optical media backup', 'Ok');
      await win.getByRole('button', { name: 'Continue with the next disc' }).waitFor({ timeout: 5 * 60_000 });
    });
    await step('swap to disc 2, "Continue with the next disc"', async () => {
      dismount(isoPaths[0]);
      mount(isoPaths[1]);
      await pause(1000); // see test-recover-single-disc.js
      await win.getByRole('button', { name: 'Continue with the next disc' }).click({ timeout: 15_000 });
    });
    const rejoinedPath = path.join(recovered, FILE_REL);
    await step('"Partial files detected" names the file under its original name; "Yes, reassemble"', async () => {
      const dialog = dialogTitled('Partial files detected');
      await dialog.waitFor({ timeout: 5 * 60_000 });
      await dialog.getByText(new RegExp('^' + escapeRegExp(rejoinedPath))).first().waitFor({ timeout: 10_000 });
      await clickIn('Partial files detected', 'Yes, reassemble');
    });
    await step('"Ok" on "Reassembly successful", then on "Data recovery successful"', async () => {
      await dialogTitled('Reassembly successful').waitFor({ timeout: 5 * 60_000 });
      await clickIn('Reassembly successful', 'Ok');
      await dialogTitled('Data recovery successful').waitFor({ timeout: 60_000 });
      await clickIn('Data recovery successful', 'Ok');
    });
    await close();
    dismount(isoPaths[1]);

    const recoveredFiles = [];
    (function walk(dir, rel) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? rel + '\\' + e.name : e.name;
        if (e.isDirectory()) { walk(path.join(dir, e.name), r); } else { recoveredFiles.push(r); }
      }
    })(recovered, '');
    const rejoinedSha256 = fs.existsSync(rejoinedPath) ? await sha256Streamed(rejoinedPath) : '(missing)';
    report('theFileIsRejoinedUnderItsOwnName_byteForByte',
      JSON.stringify(recoveredFiles) === JSON.stringify([FILE_REL]) && rejoinedSha256 === originalSha256, recoveredFiles.join(' | '));
    report('theSourceFileIsUntouched', fs.statSync(sourceFile).mtimeMs === sourceMtimeBefore && (await sha256Streamed(sourceFile)) === originalSha256);
  } finally {
    await close();
    if (originalConfigContent !== undefined) { restoreConfig(originalConfigContent); }
    for (const iso of mounted) { try { dismountIso(iso); } catch { /* the failure is reported already */ } }
  }

  const pass = Object.keys(results).length > 0 && Object.values(results).every(Boolean);
  console.log('\nSummary:');
  for (const [check, ok] of Object.entries(results)) { console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${check}`); }
  if (pass) {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  } else {
    console.log(`\nLeaving scratch files in place for inspection: ${scratchRoot}`);
  }
  console.log(`\n${pass ? 'PASS' : 'FAIL'} - a split file with names too long for a disc ${pass ? 'was burned, recovered and rejoined under its original name, byte for byte.' : 'was not handled as expected, see above.'}`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => {
  const message = (e && e.message) || String(e);
  const logPath = path.join(FIXTURES_ROOT, `long-names-split-test-error-${Date.now()}.log`);
  try { fs.mkdirSync(FIXTURES_ROOT, { recursive: true }); fs.writeFileSync(logPath, (e && e.stack) || message); } catch { /* best effort */ }
  console.error(`\nTEST ERRORED: ${message}`);
  console.error(`Full details saved to: ${logPath}`);
  process.exitCode = 1;
});
