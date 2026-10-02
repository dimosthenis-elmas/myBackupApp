#!/usr/bin/env node
'use strict';

/**
 * "Add missing files" finishing a large file that an earlier job left with only some of its pieces on discs - the
 * app was closed before the rest were burned. Each piece is named with how many pieces its file has
 * ("<name>.outOf.<total>.part.NNN", see app/workers/split-pieces.ts), and a disc is recorded in the metadata JSON as
 * soon as it is confirmed burned, so the JSON shows which pieces are missing.
 *
 * The earlier job is played over the worker's IPC: a 700 MB file is planned for CDs (2 pieces, one per disc), only
 * piece 1 is split and "burned" (kept aside), and the JSON gets disc 1 - piece 1 with its SHA-256, and one small file.
 * Then the real wizard, clicked through: master folder, CD, that JSON, "Next" - the large file must be listed as
 * missing (the small one must not); collection name, "Next" - the "Cold storage metadata prepared" dialog must say
 * only its missing pieces are planned, and there must be exactly one new disc; "Send disk 2 to ImgBurn" (ImgBurn is a
 * stub) - its project must hold exactly "big.bin.outOf.2.part.002"; "Confirm disc burned" - no dialog, and the JSON
 * must then have that piece on disc 2 with its SHA-256. Last, piece 1 from the earlier job and piece 2 from this one
 * must rejoin (merge-file-parts) into the file, byte for byte.
 *
 * Touches the app's real temp folder (see worker-ipc/temp-dir-guard.js) - refuses to run unless it is empty.
 * NOTE: needs a real Windows desktop/window session (see worker-ipc/call-worker.js's top comment).
 *
 * Usage:
 *   node test-harness/ui/test-add-missing-files-split-resume.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { launchApp, callWorker } = require('../worker-ipc/call-worker');
const { assertRealTempDataDirectoryIsSafeToUse, resolveRealTempDataDirectory, waitForSessionSubdirectory } = require('../worker-ipc/temp-dir-guard');
const { OPTICAL_DRIVE_LETTER_CONVENTION } = require('../lib/cold-storage-metadata');
const { writeStubImgBurnBat, backupAndRedirectImgBurnPath, restoreConfig, waitForFile, parseIbbBackupList, waitForDiscConfirmed } = require('../lib/ibb-tools');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');

// 700 MB: one full 500 MiB piece and a remainder - 2 pieces, and on CDs (651,000,000 effective) one piece per disc.
// Same proven-safe size as test-add-missing-files.js.
const LARGE_FILE_BYTES = 700_000_000;
const CD_CAPACITY_BYTES = 700_000_000;
const CD_REPLETION_RATIO = 0.93; // OPTICAL_MEDIA's CD, src/app/shared/utils/optical-media.ts
const LARGE_FILE_FOLDER = 'large-files';
const LARGE_FILE_NAME = 'big.bin';
const pieceName = (n) => `${LARGE_FILE_NAME}.outOf.2.part.${String(n).padStart(3, '0')}`;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function sha256Streamed(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath).on('error', reject).on('data', (d) => hash.update(d)).on('end', () => resolve(hash.digest('hex')));
  });
}

async function clickMainMenuButton(win, labelText) {
  const container = win.locator('.grid-container > div').filter({ has: win.locator('h2', { hasText: labelText }) });
  await container.locator('button').click();
}

async function main() {
  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `add-missing-files-split-resume-${runId}`);
  const masterDir = path.join(scratchRoot, 'master');
  const largeFile = path.join(masterDir, LARGE_FILE_FOLDER, LARGE_FILE_NAME);
  const smallFile = path.join(masterDir, 'notes.txt');
  const burnedPiece1 = path.join(scratchRoot, 'disc 1', pieceName(1));
  const existingJsonPath = path.join(scratchRoot, 'cold-storage-metadata.json');
  const updatedJsonPath = path.join(scratchRoot, 'cold-storage-metadata - updated.json');
  const stubImgBurnPath = path.join(scratchRoot, 'stub-imgburn.bat');
  const rejoinDir = path.join(scratchRoot, 'rejoined');

  // The master: a small file (already on disc 1) and a 700 MB file - sparse, with 32 bytes of its own every 100 MB.
  fs.mkdirSync(path.dirname(largeFile), { recursive: true });
  fs.writeFileSync(smallFile, 'already on disc 1');
  const fd = fs.openSync(largeFile, 'w');
  fs.ftruncateSync(fd, LARGE_FILE_BYTES);
  for (let offset = 0; offset < LARGE_FILE_BYTES; offset += 100_000_000) {
    const block = crypto.createHash('sha256').update(`resume:${offset}`).digest();
    fs.writeSync(fd, block, 0, block.length, offset);
  }
  fs.closeSync(fd);
  const largeFileSha256 = await sha256Streamed(largeFile);
  writeStubImgBurnBat(stubImgBurnPath);

  console.log('Checking the app\'s real temp/cache directory is safe to use...');
  assertRealTempDataDirectoryIsSafeToUse();
  const realTempDir = resolveRealTempDataDirectory();

  const results = {};
  const report = (name, ok, detail = '') => {
    results[name] = !!ok;
    console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? `  (${detail})` : ''}`);
  };
  let app, win, originalConfigContent;
  let earlierSessionDir;
  try {
    console.log('\nLaunching the app...');
    ({ app, win } = await launchApp());
    await pause(3000); // let the app's own startup temp-folder check finish first (see test-add-missing-files.js)

    // ---- The earlier job, over IPC: piece 1 of the large file burned on disc 1, then the app closed.
    console.log('\nThe earlier job: piece 1 of the large file "burned" on disc 1, then the app closed...');
    const earlierSession = `session-${Date.now()}`;
    earlierSessionDir = path.join(realTempDir, earlierSession);
    const plan = (await callWorker(win, 'partition-backup-to-optical-media', {
      rootPath: masterDir, mediaCapacityInBytes: CD_CAPACITY_BYTES, maxRepletionRatio: CD_REPLETION_RATIO,
      splitLargeFiles: true, sessionId: earlierSession,
    }, 60_000)).res;
    const piece1Planned = plan.flat().map((e) => path.relative(earlierSessionDir, e.path)).find((p) => p.endsWith(pieceName(1)));
    const [piece1] = (await callWorker(win, 'create-optical-media-disc-partials', { dirPath: masterDir, paths: [piece1Planned], sessionId: earlierSession }, 10 * 60_000)).res;
    const [{ sha256: piece1Sha256 }] = (await callWorker(win, 'compute-sha256-for-backed-up-files', { dirPath: masterDir, paths: [piece1.path], sessionId: earlierSession }, 10 * 60_000)).res;
    fs.mkdirSync(path.dirname(burnedPiece1), { recursive: true });
    fs.copyFileSync(path.join(earlierSessionDir, piece1.path), burnedPiece1);
    fs.rmSync(earlierSessionDir, { recursive: true, force: true }); // what the app offers to clear at its next start
    const smallStats = fs.statSync(smallFile);
    const existingJson = [[
      { path: `${OPTICAL_DRIVE_LETTER_CONVENTION}notes.txt`, stats: { size: smallStats.size, mtime: smallStats.mtime.toISOString(), isDirectory: false } },
      { path: `${OPTICAL_DRIVE_LETTER_CONVENTION}${piece1.path}`, stats: { size: piece1.stats.size, mtime: new Date(piece1.stats.mtime).toISOString(), isDirectory: false, sha256: piece1Sha256 } },
    ]];
    fs.writeFileSync(existingJsonPath, JSON.stringify(existingJson, null, 2));
    console.log(`  disc 1 in the JSON: ${existingJson[0].map((e) => e.path).join(', ')}`);

    // ---- "Add missing files", clicked through.
    await app.evaluate(({ dialog }, paths) => {
      const queue = [...paths];
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [queue.shift()] });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: queue.shift() });
    }, [masterDir, existingJsonPath, updatedJsonPath]);
    const step = async (label, fn) => {
      process.stdout.write(`  [ ] ${label} ... `);
      try {
        await fn();
      } catch (e) {
        console.log('FAILED');
        const screenshotPath = path.join(FIXTURES_ROOT, `add-missing-files-split-resume-failure-${runId}.png`);
        try { await win.screenshot({ path: screenshotPath }); console.log(`  Screenshot saved to: ${screenshotPath}`); } catch { /* window gone */ }
        throw e;
      }
      console.log('done');
      await pause(700);
    };

    console.log('\n"Add missing files" with that JSON...');
    await step('main menu -> Add missing files to optical media cold storage', () =>
      clickMainMenuButton(win, 'Add missing files to optical media cold storage'));
    await step('"Ok" on the wizard\'s info dialog', () => win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 }));
    await step('pick the "Add new files" task', () =>
      win.getByRole('button', { name: 'Add new files', exact: true }).click({ timeout: 15_000 }));
    await step('choose the master folder', async () => {
      await win.getByRole('button', { name: 'Select the location of your files (Master)' }).click({ timeout: 15_000 });
      await win.getByText(masterDir, { exact: true }).waitFor({ timeout: 10_000 });
    });
    await step('choose "CD (700 MB)"', async () => {
      await win.getByRole('combobox').click({ timeout: 15_000 });
      await win.getByRole('option', { name: 'CD (700 MB)' }).click({ timeout: 15_000 });
    });
    await step('choose the JSON', async () => {
      await win.getByRole('button', { name: 'Select JSON file' }).click({ timeout: 15_000 });
      await win.getByText(existingJsonPath, { exact: true }).waitFor({ timeout: 10_000 });
      await pause(2000); // the JSON is still being read and checked (see test-add-missing-files.js)
    });
    await step('"Next"; wait for the missing files', async () => {
      await win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 });
      await win.getByRole('checkbox', { name: 'Select all' }).waitFor({ state: 'visible', timeout: 60_000 });
    });
    // A file's tick box is named by its icon ("file") and its name.
    const listed = async (name) => win.getByRole('checkbox', { name: `file ${name}`, exact: true }).count();
    report('theLargeFileIsListedAsMissing_theSmallOneIsNot', (await listed(LARGE_FILE_NAME)) === 1 && (await listed('notes.txt')) === 0);

    await step('type the collection name; "Next"', async () => {
      await win.getByPlaceholder('e.g. My Backup').fill('Resume test');
      await win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 });
    });
    await step('wait for "Cold storage metadata prepared"', () =>
      win.getByText('Cold storage metadata prepared', { exact: true }).waitFor({ timeout: 5 * 60_000 }));
    const preparedText = (await win.getByRole('dialog').innerText()).replace(/\s+/g, ' ');
    report('itSaysOnlyTheMissingPiecesArePlanned', preparedText.includes('only its missing pieces are planned'), preparedText.slice(-200));
    originalConfigContent = backupAndRedirectImgBurnPath(stubImgBurnPath);
    await step('"Ok"', () => win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 }));
    await step('wait for "Send disk 2 to ImgBurn"', () => win.getByRole('button', { name: 'Send disk 2 to ImgBurn' }).waitFor({ timeout: 30_000 }));
    report('exactlyOneNewDisc', (await win.getByRole('tab').count()) === 1);

    await step('"Send disk 2 to ImgBurn", "Ok" on its label', async () => {
      await win.getByRole('button', { name: 'Send disk 2 to ImgBurn' }).click({ timeout: 15_000 });
      await win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 5 * 60_000 });
    });
    const sessionDir = await waitForSessionSubdirectory(realTempDir, 30_000);
    const ibbPath = path.join(sessionDir, 'Disk_1.ibb');
    await waitForFile(ibbPath, 60_000);
    const ibbFiles = parseIbbBackupList(ibbPath).filter((e) => e.type === 'F');
    report('itsProjectHoldsExactlyPiece2', ibbFiles.length === 1 && ibbFiles[0].name === pieceName(2), ibbFiles.map((e) => e.name).join(' | '));
    fs.mkdirSync(rejoinDir, { recursive: true });
    if (ibbFiles.length === 1) { fs.copyFileSync(ibbFiles[0].fullSourcePath, path.join(rejoinDir, pieceName(2))); }

    await step('"Confirm disc burned" - no dialog', async () => {
      await win.getByRole('button', { name: 'Confirm disc burned' }).click({ timeout: 15_000 });
      await waitForDiscConfirmed(win);
    });
    const recordedDisc2 = () => { try { return JSON.parse(fs.readFileSync(updatedJsonPath, 'utf8'))[1] || []; } catch { return []; } };
    for (let i = 0; i < 60 && recordedDisc2().length === 0; i++) { await pause(500); }
    const disc2 = recordedDisc2();
    report('theJsonHasPiece2OnDisc2WithItsSha256',
      disc2.length === 1 && disc2[0].path === `${OPTICAL_DRIVE_LETTER_CONVENTION}${LARGE_FILE_FOLDER}\\${pieceName(2)}` && /^[0-9a-f]{64}$/.test(disc2[0].stats.sha256 || ''),
      disc2.map((e) => e.path).join(' | '));

    // ---- Rejoin: piece 1 from the earlier job, piece 2 from this one.
    console.log('\nRejoining piece 1 (earlier job) and piece 2 (this job)...');
    fs.copyFileSync(burnedPiece1, path.join(rejoinDir, pieceName(1)));
    const merged = (await callWorker(win, 'merge-file-parts', {
      partFilePaths: [1, 2].map((n) => path.join(rejoinDir, pieceName(n))), originalFileName: LARGE_FILE_NAME,
    }, 10 * 60_000)).res;
    const rejoined = path.join(rejoinDir, LARGE_FILE_NAME);
    const rejoinedSha256 = fs.existsSync(rejoined) ? await sha256Streamed(rejoined) : '(missing)';
    report('theyRejoinIntoTheFile_byteForByte', merged.merged === true && rejoinedSha256 === largeFileSha256, merged.message);
    fs.rmSync(sessionDir, { recursive: true, force: true });
  } finally {
    if (app) { await app.close().catch(() => {}); }
    if (originalConfigContent !== undefined) { restoreConfig(originalConfigContent); }
    if (earlierSessionDir) { fs.rmSync(earlierSessionDir, { recursive: true, force: true }); }
  }

  const failed = Object.entries(results).filter(([, ok]) => !ok).map(([name]) => name);
  const pass = Object.keys(results).length === 6 && failed.length === 0;
  if (pass) {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  } else {
    console.log(`\nLeaving scratch files in place for inspection: ${scratchRoot}`);
  }
  console.log(`\n${pass ? 'PASS' : 'FAIL'} - "Add missing files" burns just the missing piece of a large file an earlier job ` +
    `left half-burned, and it rejoins with the piece already on disc.${failed.length ? ` Failed: ${failed.join(', ')}` : ''}`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((error) => {
  console.error(`\nTEST ERRORED: ${(error && error.stack) || error}`);
  process.exitCode = 1;
});
