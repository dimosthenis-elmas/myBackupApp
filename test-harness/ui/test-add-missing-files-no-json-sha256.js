#!/usr/bin/env node
'use strict';

/**
 * End-to-end test of the "Add missing files to optical media cold storage" wizard's NO-metadata-JSON entry
 * point, proving that the discs it physically reads back one by one also get SHA-256 hashes recorded - the
 * exact case the JSON entry point never covers (there the existing discs' hashes come from the loaded JSON).
 *
 * The no-JSON flow reads every existing disc straight off the media (getCombinedFilePathsFromAllOpticalDiscs
 * -> readAllDiscsToReconstructTheCompleteBackupFilePaths in optical-disc-backup-data-retriever.component.ts) to
 * rebuild the cold storage's file list, then - once the user has added the missing files - writes the updated
 * metadata JSON. Before this feature, that JSON carried integrity data for the NEW discs only (hashed in
 * sendToImgBurn); the files read back off the existing discs had no sha256 at all, so they could never be
 * integrity-checked. This test drives the whole no-JSON flow with one mounted .iso disc and checks the written
 * scaffold JSON: every file entry on the existing disc must have a sha256 that matches a fresh recompute of that
 * exact file's real bytes, and every directory entry must have none.
 *
 * Deliberately a SINGLE disc and a small tree - the multi-disc read and the diff/continuation logic are already
 * covered by test-recover-multi-disc.js and test-add-missing-files.js respectively. This test's only job is the
 * new "hash what we read back off a disc" behaviour.
 *
 * NOTE: needs a real Windows desktop/window session (see worker-ipc/call-worker.js's top comment) - run from
 * your own interactive terminal. It mounts a real .iso as an optical disc (see ./iso-disc.js).
 *
 * Usage:
 *   node test-harness/ui/test-add-missing-files-no-json-sha256.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { launchApp } = require('../worker-ipc/call-worker');
const { assertNoOpticalMediaAlreadyMounted, buildIso, mountIso, dismountIso } = require('./iso-disc');
const { printTree } = require('../lib/print-tree');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');
const { generateFixtureTree } = require('../lib/fixture-tree-source');

const SPEC_DIR = path.join(__dirname, 'tree-specs', 'test-add-missing-files-no-json-sha256');

function sha256OfFileSync(absPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

async function clickMainMenuButton(win, labelText) {
  const container = win.locator('.grid-container > div').filter({ has: win.locator('h2', { hasText: labelText }) });
  await container.locator('button').click();
}

async function main() {
  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `add-missing-no-json-sha256-${runId}`);
  const masterDir = path.join(scratchRoot, 'master');
  const disc1Dir = path.join(scratchRoot, 'disc1-files');
  const metadataJsonPath = path.join(scratchRoot, 'cold-storage-metadata.json');
  const disc1IsoPath = path.join(scratchRoot, 'disc1.iso');
  fs.mkdirSync(disc1Dir, { recursive: true });

  // 1. Generate a small master tree, then copy half its files into a separate "existing disc 1" folder - the
  //    half left in the master alone is what the wizard must discover as missing, so the flow reaches step 3 and
  //    then partition() (which writes the scaffold JSON we check below). A fresh, smaller-than-the-master disc
  //    keeps the missing set non-empty without any large-file splitting.
  generateFixtureTree({
    root: masterDir,
    randomArgs: ['--files', '10', '--max-depth', '2', '--min-size', '0', '--max-size', '20000', '--seed', '998877'],
    specDir: SPEC_DIR,
  });
  const manifest = JSON.parse(fs.readFileSync(`${masterDir}.manifest.json`, 'utf8'));
  const half = Math.ceil(manifest.files.length / 2);
  const disc1Files = manifest.files.slice(0, half);
  // The copied files get an mtime a minute in the future: the wizard's diff refuses a job when a file already on
  // a disc has an OLDER mtime than the master copy ("files changed since they were burned"), and Joliet's 2-second
  // timestamp granularity could otherwise round a just-copied mtime down to (or below) the master's own.
  const discMtime = new Date(Date.now() + 60_000);
  for (const f of disc1Files) {
    const relOs = f.relativePath.split('/').join(path.sep);
    const dest = path.join(disc1Dir, relOs);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(masterDir, relOs), dest);
    fs.utimesSync(dest, discMtime, discMtime);
  }
  console.log(`\nMaster has ${manifest.fileCount} files - disc 1 holds ${disc1Files.length} of them, the rest stay missing.`);
  printTree(disc1Dir, 'Disc 1 contents (built into disc1.iso below)');

  assertNoOpticalMediaAlreadyMounted();
  console.log('\nBuilding and mounting disc1.iso...');
  buildIso(disc1Dir, disc1IsoPath, 'TESTDISC1');
  mountIso(disc1IsoPath);

  let app, win;
  try {
    console.log('Launching the app...');
    ({ app, win } = await launchApp());

    // One native open dialog (the master folder) and one native save dialog (where the scaffold JSON goes) - the
    // no-JSON flow never opens a "Select JSON file" dialog, so a single-item open queue is enough.
    await app.evaluate(({ dialog }, paths) => {
      const queue = [...paths];
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [queue.shift()] });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: queue.shift() });
    }, [masterDir, metadataJsonPath]);

    // Let the app's own startup temp-leftover check settle before any raw IPC would race it (see
    // test-add-missing-files.js's identical pause).
    await new Promise((r) => setTimeout(r, 3000));

    const WATCH_PAUSE_MS = 1000;
    const step = async (label, fn) => {
      process.stdout.write(`  [ ] ${label} ... `);
      try {
        await fn();
      } catch (e) {
        console.log('FAILED');
        const screenshotPath = path.join(FIXTURES_ROOT, `optical-backup-ui-add-missing-no-json-sha256-failure-${runId}.png`);
        try {
          await win.screenshot({ path: screenshotPath });
          console.log(`  Screenshot of the app at the point of failure saved to: ${screenshotPath}`);
        } catch { /* app/window may already be gone */ }
        throw e;
      }
      console.log('done');
      await new Promise((r) => setTimeout(r, WATCH_PAUSE_MS));
    };

    await step('main menu -> Add missing files to optical media cold storage', () =>
      clickMainMenuButton(win, 'Add missing files to optical media cold storage'));

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

    // Deliberately NOT checking the "Provide cold storage files metadata by importing a JSON file" checkbox - the
    // whole point of this test is the no-JSON, physically-read-back disc path.
    await step('click "Next" (no JSON - reads the mounted disc back)', () =>
      win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 }));

    // The "All disks..." button only appears once disc 1 has been read AND hashed (attachSha256ToReadDisc runs
    // before the "insert the next disc" dialog is shown), so waiting for it is also the wait for the hashing.
    await step('wait for disc 1 to be read and hashed, then click "All disks have been processed..."', () =>
      win.getByRole('button', { name: 'All disks have been processed, continue to the next step' }).click({ timeout: 120_000 }));

    await step('wait for step 3 ("files missing from your cold storage") to render', () =>
      win.getByText('Below you see the files missing from your cold storage.', { exact: true }).waitFor({ timeout: 60_000 }));

    await step('type the cold storage collection name', () =>
      win.getByPlaceholder('e.g. My Backup').fill('no-json-sha256-test'));

    // partition() asks where to save the updated JSON (stubbed), plans the one new disc, then writes the scaffold
    // JSON - the existing disc's entries carry the hashes we check after the app closes.
    await step('click "Next" (partition - writes the scaffold JSON)', () =>
      win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 }));

    await step('wait for the "Cold storage metadata prepared" confirmation (scaffold JSON now written)', () =>
      win.getByText('Cold storage metadata prepared', { exact: true }).waitFor({ timeout: 120_000 }));
  } finally {
    if (app) { await app.close().catch(() => {}); }
    console.log('\nDismounting disc1.iso...');
    dismountIso(disc1IsoPath);
  }

  // 2. Verify the scaffold JSON: the existing disc's (disc 0) file entries must each carry a sha256 matching a
  //    fresh recompute of that exact file, and no directory entry may have one.
  console.log('\nVerifying the scaffold JSON has SHA-256 hashes for the disc read back off the media...');
  const metadata = JSON.parse(fs.readFileSync(metadataJsonPath, 'utf8'));
  const hasExistingDisc = Array.isArray(metadata) && Array.isArray(metadata[0]) && metadata[0].length > 0;
  if (!hasExistingDisc) { throw new Error('The scaffold JSON has no non-empty disc 0 (existing disc) entry.'); }

  const disc0 = metadata[0];
  const fileEntries = disc0.filter((e) => !e.stats.isDirectory);
  const dirEntries = disc0.filter((e) => e.stats.isDirectory);

  let allFileHashesCorrect = fileEntries.length > 0;
  for (const entry of fileEntries) {
    const relPath = entry.path.replace(/^D:\\/, '');
    const absPath = path.join(disc1Dir, relPath);
    const hasHash = typeof entry.stats.sha256 === 'string' && entry.stats.sha256.length === 64;
    const realHash = fs.existsSync(absPath) ? sha256OfFileSync(absPath) : null;
    const correct = hasHash && realHash === entry.stats.sha256;
    if (!correct) {
      allFileHashesCorrect = false;
      console.log(`  WRONG: "${relPath}" - recorded sha256: ${entry.stats.sha256 || '(missing)'}, real: ${realHash || '(file not found)'}`);
    }
  }
  console.log(`  Every disc-0 file entry has a real, correct sha256: ${allFileHashesCorrect ? 'OK' : 'WRONG'} (${fileEntries.length} files checked)`);

  const noDirHasHash = dirEntries.every((e) => e.stats.sha256 === undefined);
  console.log(`  No directory entry has a sha256 field: ${noDirHasHash ? 'OK' : 'WRONG'} (${dirEntries.length} directories checked)`);

  const verifyPassed = hasExistingDisc && allFileHashesCorrect && noDirHasHash;

  if (verifyPassed) {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  } else {
    console.log(`\nLeaving scratch files in place for inspection: ${scratchRoot}`);
  }

  console.log(`\n${verifyPassed ? 'PASS' : 'FAIL'} - ${verifyPassed
    ? 'the no-JSON add-missing-files flow recorded a real, correct SHA-256 for every file read back off the existing disc (and none for any directory).'
    : 'did not produce the expected result - see the OK/WRONG lines above.'}`);
  process.exitCode = verifyPassed ? 0 : 1;
}

main().catch((e) => {
  const message = (e && e.message) || String(e);
  const fullDetail = (e && e.stack) ? e.stack : message;
  if (/closed|Target .*(closed|crashed)/i.test(message)) {
    console.error(`\nTEST ERRORED: the app window was closed before the test finished (${message}).`);
  } else {
    const logPath = path.join(FIXTURES_ROOT, `optical-backup-ui-add-missing-no-json-sha256-error-${Date.now()}.log`);
    try { fs.writeFileSync(logPath, fullDetail); } catch { /* best effort */ }
    console.error(`\nTEST ERRORED: ${message}`);
    console.error(`Full details saved to: ${logPath}`);
  }
  process.exitCode = 1;
});
