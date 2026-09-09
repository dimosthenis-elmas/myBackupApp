#!/usr/bin/env node
'use strict';

/**
 * End-to-end test of the SHA-256 integrity-checksum feature's recovery-side half: proves it actually catches
 * real corruption, not just that "happy path" hashing runs without error. This is the highest-priority test
 * from that feature's own test plan - every other test for this feature (backend hashing math, schema shape,
 * toggle plumbing) could pass while the one thing the feature exists for - noticing that a recovered file's
 * bytes don't match what was recorded at backup time - silently doesn't work. This is the one that actually
 * checks that.
 *
 * ============================================================================================================
 * The scenario, and why it's built this way
 * ============================================================================================================
 * A real disc's data can degrade AFTER it was burned and its hashes were recorded (a bad drive read, physical
 * disc handling damage) - the whole reason this feature exists (see the app's own design notes: M-DISC + ImgBurn
 * verify already cover long-term chemical media degradation, this is defense-in-depth against everything else).
 * So this test:
 *   1. Builds a small source tree, copies it onto one simulated "disc" folder.
 *   2. Asks the app's own real IPC for that disc's real file listing (get-file-paths-with-stats - the exact same
 *      call the app itself makes when reading a real disc), and builds a cold storage metadata JSON from it,
 *      attaching each file's REAL sha256 straight from generate-random-tree.js's own manifest (ground truth,
 *      computed from the ORIGINAL, not-yet-tampered bytes) - this is the "recorded good, at backup time" step.
 *   3. ONLY AFTER that JSON is written - simulating corruption that happens to the media AFTER backup - flips one
 *      byte of exactly one file, in place (same size, so the recorded `stats.size` stays accurate), directly on
 *      the simulated disc folder.
 *   4. Builds a .iso from the NOW-CORRUPTED folder and mounts it (test-harness/optical-media) - so the recovery
 *      wizard genuinely reads corrupted bytes off a simulated disc, the same as it would off a real damaged one.
 *   5. Drives the real "Recover data from optical media backup" wizard via the JSON-import entry point (skips
 *      physical disc enumeration - see ui/test-recover-from-json-metadata.js for the technique this borrows),
 *      recovers everything, and asserts:
 *      - The final dialog's TITLE says "...integrity FAILURES", never plain "successful" (see
 *        finishRecoveryAfterOptionalMerge in optical-disc-backup-data-retriever.component.ts) - a real problem
 *        must never be masked by an upbeat title.
 *      - Its message reports exactly 1 FAILED and names the tampered file.
 *      - Its message reports every OTHER file as Verified (not accidentally swept into "no data" or "failed").
 *   6. Independently (not trusting the dialog alone): re-reads the recovered tampered file's real bytes and
 *      confirms they do NOT match the original manifest hash (proving the corruption really happened, on the
 *      recovered copy, not just that the dialog claims it did) - and confirms every OTHER recovered file DOES
 *      still match its manifest hash (proving nothing else broke).
 *
 * NOTE: needs a real Windows desktop/window session (see worker-ipc/call-worker.js's top comment) - run from
 * your own interactive terminal.
 *
 * Usage:
 *   node test-harness/ui/test-recover-integrity-detects-corruption.js
 */

const fs = require('fs');
const path = require('path');
const { launchApp, callWorker } = require('../worker-ipc/call-worker');
const { assertRealTempDataDirectoryIsSafeToUse } = require('../worker-ipc/temp-dir-guard');
const { assertNoOpticalMediaAlreadyMounted, buildIso, mountIso, dismountIso } = require('./iso-disc');
const { printTree } = require('../lib/print-tree');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');
const { normalizeForMetadata } = require('../lib/cold-storage-metadata');
const { generateFixtureTree } = require('../lib/fixture-tree-source');

const SPEC_DIR = path.join(__dirname, 'tree-specs', 'test-recover-integrity-detects-corruption');

function sha256OfFileSync(absPath) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

async function clickMainMenuButton(win, labelText) {
  const container = win.locator('.grid-container > div').filter({ has: win.locator('h2', { hasText: labelText }) });
  await container.locator('button').click();
}

async function main() {
  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `integrity-corruption-${runId}`);
  const sourceRoot = path.join(scratchRoot, 'source');
  const discDir = path.join(scratchRoot, 'disc1-files');
  const outputRoot = path.join(scratchRoot, 'recovered');
  const isoPath = path.join(scratchRoot, 'disc1.iso');
  const metadataJsonPath = path.join(scratchRoot, 'cold-storage-metadata.json');
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.mkdirSync(discDir, { recursive: true });

  // 1. A small, plain tree - no large files/edge cases, deliberately: those are already covered elsewhere, and
  //    would only add noise to what this test is specifically checking.
  generateFixtureTree({
    root: sourceRoot,
    randomArgs: ['--files', '12', '--max-depth', '2', '--min-size', '1000', '--max-size', '20000', '--seed', '424242', '--no-edge-cases'],
    specDir: SPEC_DIR,
  });
  const manifestPath = `${sourceRoot}.manifest.json`;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log(`\nGenerated ${manifest.fileCount} files, ${manifest.totalSizeBytes.toLocaleString()} bytes total.`);

  // Copy every file onto the one simulated disc, preserving relative structure - clean, untampered, at first.
  for (const f of manifest.files) {
    const relOs = f.relativePath.split('/').join(path.sep);
    const destPath = path.join(discDir, relOs);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, relOs), destPath);
  }
  printTree(sourceRoot, 'Source tree (before)');

  console.log('\nChecking no optical media is already mounted...');
  assertNoOpticalMediaAlreadyMounted();
  console.log('Checking the app\'s real temp/cache directory is safe to use...');
  assertRealTempDataDirectoryIsSafeToUse();

  // Declared here (not with const/let inside the try block below) specifically so they're still in scope for
  // the "5. Independent cross-check" section AFTER the try/finally - a real bug found by actually running this
  // script for the first time: these were originally declared inside the try block and referenced outside it,
  // which throws "corruptedFile is not defined" (a ReferenceError, not a test failure) the moment the app
  // closes and this script tries to do its own independent verification.
  let corruptedFile, hashedCount, dialogCheckPassed;

  let app, win, mountedIsoPath;
  try {
    console.log('\nLaunching the app...');
    ({ app, win } = await launchApp());

    // Same startup-housekeeping race-avoidance pause as test-recover-from-json-metadata.js/test-add-missing-
    // files.js - a raw callWorker() call this early can otherwise race app.component.ts's own startup IPC call.
    await new Promise((r) => setTimeout(r, 3000));

    // 2. Ask the app for the disc's real file listing, and build the metadata JSON from it - attaching each
    //    file's REAL sha256 straight from the manifest (the ORIGINAL, not-yet-tampered content) rather than
    //    re-hashing anything here, so this is genuinely "what the app would have recorded at backup time" using
    //    ground truth that already exists rather than a second, possibly-divergent computation.
    console.log('\nAsking the app for the disc\'s real file listing (get-file-paths-with-stats)...');
    const discListing = (await callWorker(win, 'get-file-paths-with-stats', { dirPath: discDir })).res;
    const normalized = normalizeForMetadata(discListing, discDir);
    const hashByRelativePath = new Map(manifest.files.map((f) => [f.relativePath, f.sha256]));
    hashedCount = 0;
    for (const entry of normalized) {
      if (entry.stats.isDirectory) { continue; }
      const relPosix = entry.path.replace(/^D:\\/, '').split(path.sep).join('/');
      const hash = hashByRelativePath.get(relPosix);
      if (!hash) { throw new Error(`No manifest hash found for "${relPosix}" - something about the path normalization above doesn't match the manifest's own relativePath format.`); }
      entry.stats.sha256 = hash;
      hashedCount++;
    }
    const coldStorageMetadata = [normalized];
    fs.writeFileSync(metadataJsonPath, JSON.stringify(coldStorageMetadata, null, 2));
    console.log(`Wrote cold storage metadata JSON (1 disc, ${normalized.length} entries, ${hashedCount} with a real recorded sha256) to:\n  ${metadataJsonPath}`);

    // 3. NOW - only after the JSON above already has this file's hash recorded - corrupt exactly one file's real
    //    bytes on the simulated disc, in place (same size). This is the "corruption happened to the media AFTER
    //    backup" step this whole feature exists to catch.
    corruptedFile = manifest.files.find((f) => f.sizeBytes > 0);
    if (!corruptedFile) { throw new Error('Expected at least one non-empty file in the generated tree to corrupt - check the --min-size passed to generateFixtureTree above.'); }
    const corruptedRelOs = corruptedFile.relativePath.split('/').join(path.sep);
    const corruptedAbsPath = path.join(discDir, corruptedRelOs);
    const tamperedBytes = fs.readFileSync(corruptedAbsPath);
    tamperedBytes[0] = tamperedBytes[0] ^ 0xFF; // guaranteed to change the file's hash, whatever its content
    fs.writeFileSync(corruptedAbsPath, tamperedBytes);
    console.log(`\nDeliberately corrupted "${corruptedFile.relativePath}" on the simulated disc, AFTER its hash was already recorded above - simulating real-world post-backup corruption.`);

    // 4. Build the .iso from the NOW-CORRUPTED disc folder, and mount it.
    printTree(discDir, 'Disc 1 contents (before burning to .iso - now with the tampered file)');
    console.log('\nBuilding disc1.iso...');
    buildIso(discDir, isoPath, 'TESTDISC1');

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
        const screenshotPath = path.join(FIXTURES_ROOT, `optical-backup-ui-integrity-corruption-test-failure-${runId}.png`);
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

    // Same race-avoidance pause as test-recover-from-json-metadata.js - externalMetadataJSONpath is set
    // synchronously, well before afterJSONpathIsGiven() actually finishes reading+schema-validating it.
    await new Promise((r) => setTimeout(r, 1500));

    await step('click "Next" (validates + seeds from the JSON - no disc reads needed)', () =>
      win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 }));

    // --- Phase B: straight to file selection (step_2's "insert disc" enumeration screen is skipped entirely) ---

    await step('wait for the combined files tree to finish rendering (up to 60s)', () =>
      win.getByRole('checkbox', { name: 'Select all' }).waitFor({ state: 'visible', timeout: 60_000 }));

    await step('click "Select all"', () =>
      win.getByRole('checkbox', { name: 'Select all' }).click({ timeout: 15_000 }));

    await step('click "Recover selected data"', () =>
      win.getByRole('button', { name: 'Recover selected data' }).click({ timeout: 15_000 }));

    await step('mount disc1 (ready for the recovery phase, which starts right after this dialog)', async () => {
      mountIso(isoPath);
      mountedIsoPath = isoPath;
    });

    await step('click "Ok" on the "you will need to insert disc(s)" info dialog', () =>
      win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 }));

    // Same deliberate pause as test-recover-single-disc.js's identical spot - avoids a real timing race between
    // this click and the app's own back-to-back ipc.stop()/waitForOpticalDiskToBeMounted() calls.
    await new Promise((r) => setTimeout(r, 1000));

    // --- Phase C: THIS is the actual point of this test - the post-recovery integrity check must catch the
    // tampered file, and must say so in the dialog's own TITLE, not just bury it in the message. ---

    await step('wait for the integrity-FAILURE dialog title (up to 60s)', () =>
      win.getByText('Data recovery finished with integrity FAILURES', { exact: true }).waitFor({ timeout: 60_000 }));

    const dialogText = await win.getByRole('dialog').innerText();
    console.log(`\nIntegrity summary dialog text:\n${dialogText}\n`);

    const expectedVerifiedCount = hashedCount - 1;
    const dialogMentionsCorruptedFile = dialogText.includes(path.basename(corruptedFile.relativePath));
    const dialogReportsExactlyOneFailed = /FAILED integrity check \(1\)/.test(dialogText);
    const dialogReportsRestVerified = new RegExp(`Verified \\(${expectedVerifiedCount}\\)`).test(dialogText);
    console.log(`  Dialog mentions the corrupted file's name: ${dialogMentionsCorruptedFile ? 'OK' : 'WRONG'}`);
    console.log(`  Dialog reports "FAILED integrity check (1)": ${dialogReportsExactlyOneFailed ? 'OK' : 'WRONG'}`);
    console.log(`  Dialog reports "Verified (${expectedVerifiedCount})": ${dialogReportsRestVerified ? 'OK' : 'WRONG'}`);
    dialogCheckPassed = dialogMentionsCorruptedFile && dialogReportsExactlyOneFailed && dialogReportsRestVerified;

    await step('click "Ok" to dismiss the integrity summary dialog', () =>
      win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 }));

    console.log('Wizard completed.');
  } finally {
    if (app) { await app.close().catch(() => {}); }
    if (mountedIsoPath) {
      console.log('\nDismounting the test disc...');
      dismountIso(mountedIsoPath);
    }
  }

  // 5. Independent cross-check, not trusting the dialog alone: re-read the RECOVERED copy of the tampered file
  //    and confirm its real bytes do NOT match the original manifest hash (the corruption genuinely carried
  //    through to the recovered output, not just that the dialog claimed so) - and confirm every OTHER recovered
  //    file's real bytes DO still match (nothing else broke).
  console.log('\nIndependently verifying the recovered files\' real bytes against the manifest...');
  let allOthersMatch = true;
  let tamperedFileMismatches = false;
  const corruptedRelOs = corruptedFile.relativePath.split('/').join(path.sep);
  for (const f of manifest.files) {
    const relOs = f.relativePath.split('/').join(path.sep);
    const recoveredAbsPath = path.join(outputRoot, relOs);
    const recoveredHash = fs.existsSync(recoveredAbsPath) ? sha256OfFileSync(recoveredAbsPath) : null;
    const matches = recoveredHash === f.sha256;
    if (relOs === corruptedRelOs) {
      tamperedFileMismatches = !matches;
      console.log(`  ${f.relativePath} (the deliberately tampered file): recovered hash ${matches ? 'still matches (WRONG - corruption did not carry through)' : 'does NOT match original (expected)'}`);
    } else if (!matches) {
      allOthersMatch = false;
      console.log(`  ${f.relativePath}: MISMATCH (unexpected - this file was never tampered with)`);
    }
  }
  console.log(`  Every other recovered file still matches its manifest hash: ${allOthersMatch ? 'OK' : 'WRONG'}`);
  console.log(`  The tampered file's recovered copy genuinely does not match: ${tamperedFileMismatches ? 'OK' : 'WRONG'}`);

  const verifyPassed = dialogCheckPassed && allOthersMatch && tamperedFileMismatches;

  if (verifyPassed) {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  } else {
    console.log(`\nLeaving scratch files in place for inspection: ${scratchRoot}`);
  }

  console.log(`\n${verifyPassed ? 'PASS' : 'FAIL'} - ${verifyPassed
    ? 'the post-recovery SHA-256 integrity check correctly caught the deliberately corrupted file (FAILED, named, dialog title not "successful"), correctly reported every other file as Verified, and the corruption genuinely carried through to the recovered copy.'
    : 'did not produce the expected result - see the OK/WRONG lines above.'}`);
  process.exitCode = verifyPassed ? 0 : 1;
}

main().catch((e) => {
  const message = (e && e.message) || String(e);
  const fullDetail = (e && e.stack) ? e.stack : message;
  if (/closed|Target .*(closed|crashed)/i.test(message)) {
    console.error(`\nTEST ERRORED: the app window was closed before the test finished (${message}).`);
  } else {
    const logPath = path.join(FIXTURES_ROOT, `optical-backup-ui-integrity-corruption-test-error-${Date.now()}.log`);
    try { fs.writeFileSync(logPath, fullDetail); } catch { /* best effort */ }
    console.error(`\nTEST ERRORED: ${message}`);
    console.error(`Full details saved to: ${logPath}`);
  }
  process.exitCode = 1;
});
