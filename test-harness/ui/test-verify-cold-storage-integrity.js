#!/usr/bin/env node
'use strict';

/**
 * End-to-end test of the standalone "Verify integrity of cold storage disc" wizard - the ONE piece of the
 * SHA-256 integrity-checksum feature that had NO automated coverage at all until this script: every other
 * integrity test either drives the "Backup to optical media" wizard (test-backup-to-optical-media-sha256.js) or
 * hooks into the ORDINARY recovery wizard's own post-recovery check
 * (test-recover-integrity-detects-corruption.js) - neither ever opens this wizard's own menu entry.
 *
 * Builds a real cold storage metadata JSON covering TWO simulated discs (same "ask the app's own real
 * get-file-paths-with-stats IPC, then attach each file's real sha256 straight from generate-random-tree.js's
 * own manifest" technique test-recover-integrity-detects-corruption.js already established as ground truth),
 * deliberately keeps disc 1 clean and corrupts one file on disc 2 AFTER its hash was recorded - then drives the
 * wizard through BOTH discs in one session to prove:
 *   - Loading the JSON and inserting disc 1 auto-identifies it correctly (no disc-number prompt needed) and
 *     reports "verification successful" with the right Verified/FAILED counts.
 *   - The "Verify another disc?" loop actually accepts a second disc, correctly identifies IT too (not
 *     confused with disc 1), and reports "verification FAILED" for it, naming the tampered file.
 *   - "Finish" ends the wizard cleanly back at the main menu.
 * This also exercises the shared disc-auto-identification logic (getDiscIdHashForPaths) on a JSON with more
 * than one disc, which none of this feature's other tests do.
 *
 * Same disc-swap rule test-recover-multi-disc.js's own header explains in full: waitForOpticalDiskToBeMounted
 * only checks "is ANY optical drive currently showing media", so disc 1 is always DISMOUNTED before disc 2 is
 * mounted, and before clicking whatever makes the wizard start waiting again - never the other order.
 *
 * NOTE: needs a real Windows desktop/window session (see worker-ipc/call-worker.js's top comment) - run from
 * your own interactive terminal.
 *
 * Usage:
 *   node test-harness/ui/test-verify-cold-storage-integrity.js
 */

const fs = require('fs');
const path = require('path');
const { launchApp, callWorker } = require('../worker-ipc/call-worker');
const { assertNoOpticalMediaAlreadyMounted, buildIso, mountIso, dismountIso } = require('./iso-disc');
const { printTree } = require('../lib/print-tree');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');
const { normalizeForMetadata } = require('../lib/cold-storage-metadata');
const { generateFixtureTree } = require('../lib/fixture-tree-source');

const SPEC_DIR = path.join(__dirname, 'tree-specs', 'test-verify-cold-storage-integrity');

async function clickMainMenuButton(win, labelText) {
  const container = win.locator('.grid-container > div').filter({ has: win.locator('h2', { hasText: labelText }) });
  await container.locator('button').click();
}

/** Builds one disc's cold storage metadata entries (real stats via get-file-paths-with-stats + real sha256
 *  straight from the manifest - ground truth, computed from the ORIGINAL, not-yet-tampered content) for the
 *  files already copied into `discDir`. */
async function buildDiscMetadata(win, discDir, manifest) {
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

async function main() {
  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `verify-wizard-${runId}`);
  const sourceRoot = path.join(scratchRoot, 'source');
  const disc1Dir = path.join(scratchRoot, 'disc1-files');
  const disc2Dir = path.join(scratchRoot, 'disc2-files');
  const disc1IsoPath = path.join(scratchRoot, 'disc1.iso');
  const disc2IsoPath = path.join(scratchRoot, 'disc2.iso');
  const metadataJsonPath = path.join(scratchRoot, 'cold-storage-metadata.json');
  fs.mkdirSync(disc1Dir, { recursive: true });
  fs.mkdirSync(disc2Dir, { recursive: true });

  // 1. A small, plain tree (no large files/edge cases - not what this test is about), split evenly across two
  //    simulated discs.
  generateFixtureTree({
    root: sourceRoot,
    randomArgs: ['--files', '10', '--max-depth', '2', '--min-size', '1000', '--max-size', '20000', '--seed', '246810', '--no-edge-cases'],
    specDir: SPEC_DIR,
  });
  const manifestPath = `${sourceRoot}.manifest.json`;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log(`\nGenerated ${manifest.fileCount} files, ${manifest.totalSizeBytes.toLocaleString()} bytes total.`);

  const half = Math.ceil(manifest.files.length / 2);
  const disc1Files = manifest.files.slice(0, half);
  const disc2Files = manifest.files.slice(half);
  function copyPreservingDirs(f, destDir) {
    const relOs = f.relativePath.split('/').join(path.sep);
    const destPath = path.join(destDir, relOs);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, relOs), destPath);
  }
  for (const f of disc1Files) { copyPreservingDirs(f, disc1Dir); }
  for (const f of disc2Files) { copyPreservingDirs(f, disc2Dir); }
  console.log(`Disc 1: ${disc1Files.length} files (kept clean). Disc 2: ${disc2Files.length} files (one will be tampered).`);
  printTree(sourceRoot, 'Source tree (before)');

  console.log('\nChecking no optical media is already mounted...');
  assertNoOpticalMediaAlreadyMounted();

  // Declared here (not with const inside the try block below) so they're still in scope AFTER the try/finally -
  // the same class of bug found for real in test-recover-integrity-detects-corruption.js's own cross-check
  // section, fixed the same way here.
  let corruptedFile, disc1ReportsNoFailures, disc1ReportsAllVerified, disc2ReportsOneFailure,
    disc2MentionsCorruptedFile, tallyReportsBothDiscs;

  let app, win, mountedIsoPath;
  try {
    console.log('\nLaunching the app...');
    ({ app, win } = await launchApp());
    // Same startup-housekeeping race-avoidance pause every other script here uses before its first raw
    // callWorker() call.
    await new Promise((r) => setTimeout(r, 3000));

    // 2. Build both discs' metadata entries (real stats + real sha256 from the manifest - the "recorded good, at
    //    backup time" step), BEFORE any corruption happens.
    console.log('\nAsking the app for each disc\'s real file listing (get-file-paths-with-stats)...');
    const disc1Entries = await buildDiscMetadata(win, disc1Dir, manifest);
    const disc2Entries = await buildDiscMetadata(win, disc2Dir, manifest);
    fs.writeFileSync(metadataJsonPath, JSON.stringify([disc1Entries, disc2Entries], null, 2));
    console.log(`Wrote cold storage metadata JSON (disc 1: ${disc1Entries.length} entries, disc 2: ${disc2Entries.length} entries) to:\n  ${metadataJsonPath}`);

    // 3. NOW - only after both discs' hashes are already recorded above - tamper with exactly one file on disc
    //    2, in place (same size). Disc 1 stays completely clean.
    corruptedFile = disc2Files.find((f) => f.sizeBytes > 0);
    if (!corruptedFile) { throw new Error('Expected at least one non-empty file on disc 2 to corrupt.'); }
    const corruptedRelOs = corruptedFile.relativePath.split('/').join(path.sep);
    const corruptedAbsPath = path.join(disc2Dir, corruptedRelOs);
    const tamperedBytes = fs.readFileSync(corruptedAbsPath);
    tamperedBytes[0] = tamperedBytes[0] ^ 0xFF;
    fs.writeFileSync(corruptedAbsPath, tamperedBytes);
    console.log(`\nDeliberately corrupted "${corruptedFile.relativePath}" on disc 2, AFTER its hash was already recorded above.`);

    // 4. Build both .isos (disc 2's now includes the tampered file) and mount disc 1 first - mounted BEFORE the
    //    app is even asked to look, same convention test-recover-single-disc.js uses.
    printTree(disc1Dir, 'Disc 1 contents (clean)');
    printTree(disc2Dir, 'Disc 2 contents (before burning to .iso - now with the tampered file)');
    console.log('\nBuilding disc1.iso and disc2.iso...');
    buildIso(disc1Dir, disc1IsoPath, 'TESTDISC1');
    buildIso(disc2Dir, disc2IsoPath, 'TESTDISC2');
    console.log('Mounting disc 1...');
    mountIso(disc1IsoPath);
    mountedIsoPath = disc1IsoPath;

    await app.evaluate(({ dialog }, jsonPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [jsonPath] });
    }, metadataJsonPath);

    const WATCH_PAUSE_MS = 5000;
    const step = async (label, fn) => {
      process.stdout.write(`  [ ] ${label} ... `);
      try {
        await fn();
      } catch (e) {
        console.log('FAILED');
        const screenshotPath = path.join(FIXTURES_ROOT, `optical-backup-ui-verify-wizard-test-failure-${runId}.png`);
        try {
          await win.screenshot({ path: screenshotPath });
          console.log(`  Screenshot of the app at the point of failure saved to: ${screenshotPath}`);
        } catch { /* app/window may already be gone */ }
        throw e;
      }
      console.log('done');
      await new Promise((r) => setTimeout(r, WATCH_PAUSE_MS));
    };

    // --- Phase A: main menu -> the new wizard -> choose the JSON ---

    await step('main menu -> Verify integrity of cold storage disc', () =>
      clickMainMenuButton(win, 'Verify integrity of cold storage disc'));

    await step('click "Choose metadata JSON"', () =>
      win.getByRole('button', { name: 'Choose metadata JSON' }).click({ timeout: 15_000 }));

    // --- Phase B: disc 1 (clean) auto-identifies and verifies successfully ---

    await step('wait for disc 1\'s result dialog ("verification successful") (up to 60s)', () =>
      win.getByText('Disc 1: verification successful', { exact: true }).waitFor({ timeout: 60_000 }));

    const disc1DialogText = await win.getByRole('dialog').innerText();
    console.log(`\nDisc 1 result dialog text:\n${disc1DialogText}\n`);
    disc1ReportsNoFailures = /FAILED: 0\b/.test(disc1DialogText);
    disc1ReportsAllVerified = new RegExp(`Verified: ${disc1Entries.filter(e => !e.stats.isDirectory).length}\\b`).test(disc1DialogText);
    console.log(`  Disc 1 reports FAILED: 0: ${disc1ReportsNoFailures ? 'OK' : 'WRONG'}`);
    console.log(`  Disc 1 reports every file Verified: ${disc1ReportsAllVerified ? 'OK' : 'WRONG'}`);

    await step('click "Ok" on disc 1\'s result dialog', () =>
      win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 }));

    await step('wait for "Verify another disc?"', () =>
      win.getByText('Verify another disc?', { exact: true }).waitFor({ timeout: 15_000 }));

    // --- Phase C: swap discs BEFORE telling the wizard to look again (see this script's own header comment) ---

    await step('swap discs: dismount disc1, mount disc2', async () => {
      dismountIso(disc1IsoPath);
      mountIso(disc2IsoPath);
      mountedIsoPath = disc2IsoPath;
    });

    await step('click "Verify another disc"', () =>
      win.getByRole('button', { name: 'Verify another disc', exact: true }).click({ timeout: 15_000 }));

    // --- Phase D: disc 2 (tampered) auto-identifies correctly (not confused with disc 1) and reports FAILED ---

    await step('wait for disc 2\'s result dialog ("verification FAILED") (up to 60s)', () =>
      win.getByText('Disc 2: verification FAILED', { exact: true }).waitFor({ timeout: 60_000 }));

    const disc2DialogText = await win.getByRole('dialog').innerText();
    console.log(`\nDisc 2 result dialog text:\n${disc2DialogText}\n`);
    disc2ReportsOneFailure = /FAILED: 1\b/.test(disc2DialogText);
    disc2MentionsCorruptedFile = disc2DialogText.includes(path.basename(corruptedFile.relativePath));
    console.log(`  Disc 2 reports FAILED: 1: ${disc2ReportsOneFailure ? 'OK' : 'WRONG'}`);
    console.log(`  Disc 2 names the tampered file: ${disc2MentionsCorruptedFile ? 'OK' : 'WRONG'}`);

    await step('click "Ok" on disc 2\'s result dialog', () =>
      win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 }));

    await step('wait for "Verify another disc?" (running tally)', () =>
      win.getByText('Verify another disc?', { exact: true }).waitFor({ timeout: 15_000 }));

    const tallyDialogText = await win.getByRole('dialog').innerText();
    console.log(`\nRunning-tally dialog text:\n${tallyDialogText}\n`);
    tallyReportsBothDiscs = /disc 1 passed/.test(tallyDialogText) && /disc 2 FAILED/.test(tallyDialogText);
    console.log(`  Running tally correctly shows "disc 1 passed, disc 2 FAILED": ${tallyReportsBothDiscs ? 'OK' : 'WRONG'}`);

    // --- Phase E: finish ---

    await step('click "Finish"', () =>
      win.getByRole('button', { name: 'Finish', exact: true }).click({ timeout: 15_000 }));

    await step('confirm we\'re back at the main menu', () =>
      win.getByText('Verify integrity of cold storage disc', { exact: true }).waitFor({ timeout: 15_000 }));

    console.log('Wizard completed.');
  } finally {
    // MUST dismount before any cleanup below tries to delete scratchRoot - disc2.iso (or whichever is still
    // mountedIsoPath) is a file Windows keeps LOCKED while it backs a mounted virtual drive, so deleting the
    // scratch folder before this runs would throw (or silently leave the .iso undeleted) - found for real: an
    // earlier version of this script computed verifyPassed and called fs.rmSync on the WHOLE scratch folder
    // INSIDE the try block, before this finally ever got a chance to dismount anything, which is exactly
    // backwards. Nothing below this point may run before this.
    if (app) { await app.close().catch(() => {}); }
    if (mountedIsoPath) {
      console.log('\nDismounting the test disc...');
      dismountIso(mountedIsoPath);
    }
  }

  const verifyPassed = disc1ReportsNoFailures && disc1ReportsAllVerified
    && disc2ReportsOneFailure && disc2MentionsCorruptedFile && tallyReportsBothDiscs;

  if (verifyPassed) {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  } else {
    console.log(`\nLeaving scratch files in place for inspection: ${scratchRoot}`);
  }

  console.log(`\n${verifyPassed ? 'PASS' : 'FAIL'} - ${verifyPassed
    ? 'the standalone verify wizard correctly auto-identified two different discs from one metadata JSON, reported the clean disc as fully Verified, reported the tampered disc as FAILED (naming the tampered file), kept a correct running per-disc tally across the session, and finished cleanly.'
    : 'did not produce the expected result - see the OK/WRONG lines above.'}`);
  process.exitCode = verifyPassed ? 0 : 1;
}

main().catch((e) => {
  const message = (e && e.message) || String(e);
  const fullDetail = (e && e.stack) ? e.stack : message;
  if (/closed|Target .*(closed|crashed)/i.test(message)) {
    console.error(`\nTEST ERRORED: the app window was closed before the test finished (${message}).`);
  } else {
    const logPath = path.join(FIXTURES_ROOT, `optical-backup-ui-verify-wizard-test-error-${Date.now()}.log`);
    try { fs.writeFileSync(logPath, fullDetail); } catch { /* best effort */ }
    console.error(`\nTEST ERRORED: ${message}`);
    console.error(`Full details saved to: ${logPath}`);
  }
  process.exitCode = 1;
});
