#!/usr/bin/env node
'use strict';

/**
 * End-to-end test of the SHA-256 integrity-checksum feature's BACKUP-SIDE half via the real "Backup to optical
 * media" wizard - the "File integrity data" toggle added at step 1, and the real hashing it triggers right
 * before each disc's metadata is written (attachSha256HashesToDiscFiles in backup-to-optical-media.component.ts).
 *
 * Neither of this feature's other UI tests (test-recover-integrity-detects-corruption.js) exercises this code
 * path at all - that one hand-builds its cold storage metadata JSON directly (via get-file-paths-with-stats +
 * a manifest's own hashes), specifically to test recovery-side detection in isolation. This is the one that
 * actually clicks through the burn wizard itself and checks what it really writes.
 *
 * Two independent phases, each its own full app launch (kept separate rather than navigating one still-open app
 * back to the main menu between them, to avoid any risk of leftover state from phase 1 leaking into phase 2):
 *   Phase 1 (default - the toggle is never touched): every file entry in the written metadata JSON must have a
 *     `stats.sha256` that matches a fresh, independent recompute of that exact file's real content - not just
 *     "some string is present". Every directory entry must have NO sha256 at all (hashing a directory makes no
 *     sense - see the isDirectory filter in attachSha256HashesToDiscFiles).
 *   Phase 2 (toggle switched to "None"): every entry (files and directories alike) must have NO sha256 field at
 *     all - the field must be genuinely OMITTED, not just empty/null, matching the schema's "optional" (not
 *     "nullable") design.
 *
 * Both phases use a small, single-disc tree (no large-file splitting) - that machinery is already proven
 * elsewhere (test-backup-to-optical-media.js); this test's only job is the integrity-checksum toggle/hashing.
 *
 * NOTE: needs a real Windows desktop/window session (see worker-ipc/call-worker.js's top comment) - run from
 * your own interactive terminal.
 *
 * Usage:
 *   node test-harness/ui/test-backup-to-optical-media-sha256.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { launchApp } = require('../worker-ipc/call-worker');
const { assertRealTempDataDirectoryIsSafeToUse, resolveRealTempDataDirectory, waitForSessionSubdirectory } = require('../worker-ipc/temp-dir-guard');
const { printTree } = require('../lib/print-tree');
const { writeStubImgBurnBat, backupAndRedirectImgBurnPath, restoreConfig } = require('../lib/ibb-tools');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');
const { generateFixtureTree } = require('../lib/fixture-tree-source');

const SPEC_DIR = path.join(__dirname, 'tree-specs', 'test-backup-to-optical-media-sha256');

function sha256OfFileSync(absPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

async function clickMainMenuButton(win, labelText) {
  const container = win.locator('.grid-container > div').filter({ has: win.locator('h2', { hasText: labelText }) });
  await container.locator('button').click();
}

/** Drives the SIMPLE (no large-file split needed) "Backup to optical media" wizard, start to finish for its one
 *  disc, against an already-launched app/window. `selectNoneIntegrity`: if true, clicks the "File integrity
 *  data" dropdown and picks "None" before clicking "Next" - if false/omitted, leaves it at its default (SHA-256)
 *  untouched, exactly as a user who never notices the toggle would experience it. */
async function runSimpleBackupWizard(win, { sourceRoot, metadataJsonPath, collectionName, selectNoneIntegrity, runId, screenshotTag }) {
  const WATCH_PAUSE_MS = 3000;
  const step = async (label, fn) => {
    process.stdout.write(`  [ ] ${label} ... `);
    try {
      await fn();
    } catch (e) {
      console.log('FAILED');
      const screenshotPath = path.join(FIXTURES_ROOT, `optical-backup-ui-backup-sha256-test-failure-${screenshotTag}-${runId}.png`);
      try {
        await win.screenshot({ path: screenshotPath });
        console.log(`  Screenshot of the app at the point of failure saved to: ${screenshotPath}`);
      } catch { /* app/window may already be gone */ }
      throw e;
    }
    console.log('done');
    await new Promise((r) => setTimeout(r, WATCH_PAUSE_MS));
  };

  await step('main menu -> Backup to optical media', () =>
    clickMainMenuButton(win, 'Backup to optical media'));

  await step('click "Path to backup"', () =>
    win.getByRole('button', { name: 'Path to backup' }).click({ timeout: 15_000 }));

  await step('wait for the chosen source path to appear on screen', () =>
    win.getByText(sourceRoot, { exact: true }).waitFor({ timeout: 10_000 }));

  // .first() - "Optical medium type" is always the first combobox on this step; "File integrity data" is the
  // second, selected separately below only when this phase actually wants "None".
  await step('open the "Optical medium type" dropdown', () =>
    win.getByRole('combobox').first().click({ timeout: 15_000 }));

  await step('select "CD (700 MB)"', () =>
    win.getByRole('option', { name: 'CD (700 MB)' }).click({ timeout: 15_000 }));

  await step('type the cold storage collection name', () =>
    win.getByPlaceholder('e.g. My Backup').fill(collectionName));

  if (selectNoneIntegrity) {
    await step('open the "File integrity data" dropdown', () =>
      win.getByRole('combobox').nth(1).click({ timeout: 15_000 }));

    await step('select "None"', () =>
      win.getByRole('option', { name: 'None', exact: true }).click({ timeout: 15_000 }));
  }

  await step('click "Next" (no large files - goes straight to the disc-count confirmation)', () =>
    win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 }));

  await step('wait for the "Backup to optical medium" confirmation dialog', () =>
    win.getByText('Backup to optical medium', { exact: true }).waitFor({ timeout: 30_000 }));

  await step('click "Next" on the confirmation dialog (chooses where to save the JSON next)', () =>
    win.getByRole('dialog').getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 }));

  await step('wait for step 2 to render ("Burn backup to optical media")', () =>
    win.getByText('Burn backup to optical media', { exact: true }).waitFor({ timeout: 30_000 }));

  await step('click "Send to ImgBurn" for the one disc', () =>
    win.getByRole('button', { name: 'Send to ImgBurn' }).click({ timeout: 15_000 }));

  await step('click "Ok" on the "Disc label" confirmation', () =>
    win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 }));

  process.stdout.write('  [ ] wait for the metadata JSON to be written with this disc\'s real entries ... ');
  // Written incrementally, inside sendToImgBurn's own metadataUpdateQueue - by the time createIBB_file's chain
  // (awaited by "Ok" above having settled) resolves, the write has already happened, but a short poll is safer
  // than assuming zero filesystem latency.
  const deadline = Date.now() + 30_000;
  let metadataJSON;
  for (;;) {
    if (fs.existsSync(metadataJsonPath)) {
      const parsed = JSON.parse(fs.readFileSync(metadataJsonPath, 'utf8'));
      if (Array.isArray(parsed) && Array.isArray(parsed[0]) && parsed[0].length > 0) { metadataJSON = parsed; break; }
    }
    if (Date.now() > deadline) { throw new Error(`Timed out waiting for a non-empty disc 0 entry in ${metadataJsonPath}`); }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log('done');

  return metadataJSON;
}

async function runPhase({ phaseName, sourceRoot, metadataJsonPath, selectNoneIntegrity, stubImgBurnPath, runId }) {
  console.log(`\n=== Phase: ${phaseName} ===`);
  let app, win, originalConfigContent;
  try {
    console.log('Launching the app...');
    ({ app, win } = await launchApp());

    await app.evaluate(({ dialog }, paths) => {
      const queue = [...paths];
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [queue.shift()] });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: queue.shift() });
    }, [sourceRoot, metadataJsonPath]);

    console.log('Redirecting the real ImgBurn path to a harmless no-op stub for the "Send to ImgBurn" click...');
    originalConfigContent = backupAndRedirectImgBurnPath(stubImgBurnPath);

    return await runSimpleBackupWizard(win, {
      sourceRoot,
      metadataJsonPath,
      collectionName: `sha256-test (${phaseName})`,
      selectNoneIntegrity,
      runId,
      screenshotTag: phaseName.replace(/\s+/g, '-'),
    });
  } finally {
    if (app) { await app.close().catch(() => {}); }
    if (originalConfigContent !== undefined) { restoreConfig(originalConfigContent); }

    // This phase's job never clicks "Confirm disc burned" (nothing to confirm - no real split pieces exist for
    // a tree this small), so its real .ibb file - and the session-<id> subfolder createIBB_file made for it -
    // would otherwise be left sitting in the app's REAL temp/cache directory forever, which would make the
    // NEXT script (or the next phase, or your own next real use of the app) fail
    // assertRealTempDataDirectoryIsSafeToUse's "is it empty?" check. Cleaned up here explicitly, the same way
    // test-backup-to-optical-media.js cleans up its own real .ibb files/session folder at the end - best-effort
    // (a cleanup failure is logged, not thrown, so it never masks this phase's actual pass/fail result).
    try {
      const tempDir = resolveRealTempDataDirectory();
      const sessionDir = await waitForSessionSubdirectory(tempDir, 15_000);
      for (const name of fs.readdirSync(sessionDir)) {
        if (/^Disk_\d+\.ibb$/i.test(name)) { fs.rmSync(path.join(sessionDir, name), { force: true }); }
      }
      if (fs.readdirSync(sessionDir).length === 0) { fs.rmdirSync(sessionDir); }
    } catch (cleanupError) {
      console.warn(`  (non-fatal) could not clean up this phase's real temp-dir session folder: ${(cleanupError && cleanupError.message) || cleanupError}`);
    }
  }
}

async function main() {
  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `backup-sha256-${runId}`);
  const sourceRoot = path.join(scratchRoot, 'source');
  const metadataJsonPathDefault = path.join(scratchRoot, 'cold-storage-metadata-default.json');
  const metadataJsonPathNone = path.join(scratchRoot, 'cold-storage-metadata-none.json');
  const stubImgBurnPath = path.join(scratchRoot, 'stub-imgburn.bat');

  // Small, plain tree - well under one CD's capacity, no large files. What this test checks is the toggle and
  // the hashing it triggers, not the split/partitioning machinery already proven in test-backup-to-optical-media.js.
  generateFixtureTree({
    root: sourceRoot,
    randomArgs: ['--files', '10', '--max-depth', '2', '--min-size', '0', '--max-size', '20000', '--seed', '135790'],
    specDir: SPEC_DIR,
  });
  printTree(sourceRoot, 'Source tree (before)');

  console.log('\nChecking the app\'s real temp/cache directory is safe to use...');
  assertRealTempDataDirectoryIsSafeToUse();

  writeStubImgBurnBat(stubImgBurnPath);

  // --- Phase 1: default (SHA-256, never touched) - every file entry must carry a real, correct sha256; every
  // directory entry must carry none. ---
  const metadataDefault = await runPhase({
    phaseName: 'default (SHA-256)',
    sourceRoot,
    metadataJsonPath: metadataJsonPathDefault,
    selectNoneIntegrity: false,
    stubImgBurnPath,
    runId,
  });

  const discEntriesDefault = metadataDefault[0];
  const fileEntriesDefault = discEntriesDefault.filter((e) => !e.stats.isDirectory);
  const dirEntriesDefault = discEntriesDefault.filter((e) => e.stats.isDirectory);
  console.log(`\nDefault-phase metadata: ${discEntriesDefault.length} entries (${fileEntriesDefault.length} files, ${dirEntriesDefault.length} directories).`);

  let allFileHashesCorrect = true;
  for (const entry of fileEntriesDefault) {
    const relPath = entry.path.replace(/^D:\\/, '');
    const absPath = path.join(sourceRoot, relPath);
    const hasHash = typeof entry.stats.sha256 === 'string' && entry.stats.sha256.length === 64;
    const realHash = fs.existsSync(absPath) ? sha256OfFileSync(absPath) : null;
    const correct = hasHash && realHash === entry.stats.sha256;
    if (!correct) {
      allFileHashesCorrect = false;
      console.log(`  WRONG: "${relPath}" - recorded sha256: ${entry.stats.sha256 || '(missing)'}, real: ${realHash || '(file not found)'}`);
    }
  }
  console.log(`  Every file entry has a real, correct sha256: ${allFileHashesCorrect ? 'OK' : 'WRONG'} (${fileEntriesDefault.length} files checked)`);

  const noDirHasHash = dirEntriesDefault.every((e) => e.stats.sha256 === undefined);
  console.log(`  No directory entry has a sha256 field: ${noDirHasHash ? 'OK' : 'WRONG'} (${dirEntriesDefault.length} directories checked)`);

  // --- Phase 2: toggle switched to "None" - NO entry (file or directory) may carry a sha256 field at all. ---
  const metadataNone = await runPhase({
    phaseName: 'None',
    sourceRoot,
    metadataJsonPath: metadataJsonPathNone,
    selectNoneIntegrity: true,
    stubImgBurnPath,
    runId,
  });

  const discEntriesNone = metadataNone[0];
  console.log(`\n"None"-phase metadata: ${discEntriesNone.length} entries.`);
  const noEntryHasHash = discEntriesNone.every((e) => e.stats.sha256 === undefined);
  console.log(`  No entry (file or directory) has a sha256 field: ${noEntryHasHash ? 'OK' : 'WRONG'} (${discEntriesNone.length} entries checked)`);

  const verifyPassed = allFileHashesCorrect && noDirHasHash && noEntryHasHash;

  if (verifyPassed) {
    // Each phase's own real temp/cache session subfolder (.ibb file included) is already cleaned up inside
    // runPhase's own finally block - only this script's own FIXTURES_ROOT scratch files are left to remove here.
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  } else {
    console.log(`\nLeaving scratch files in place for inspection: ${scratchRoot}`);
  }

  console.log(`\n${verifyPassed ? 'PASS' : 'FAIL'} - ${verifyPassed
    ? 'the "File integrity data" toggle correctly attached a real, correct SHA-256 to every file (and none to any directory) by default, and correctly omitted the field entirely for every entry when set to "None".'
    : 'did not produce the expected result - see the OK/WRONG lines above.'}`);
  process.exitCode = verifyPassed ? 0 : 1;
}

main().catch((e) => {
  const message = (e && e.message) || String(e);
  const fullDetail = (e && e.stack) ? e.stack : message;
  if (/closed|Target .*(closed|crashed)/i.test(message)) {
    console.error(`\nTEST ERRORED: the app window was closed before the test finished (${message}).`);
  } else {
    const logPath = path.join(FIXTURES_ROOT, `optical-backup-ui-backup-sha256-test-error-${Date.now()}.log`);
    try { fs.writeFileSync(logPath, fullDetail); } catch { /* best effort */ }
    console.error(`\nTEST ERRORED: ${message}`);
    console.error(`Full details saved to: ${logPath}`);
  }
  process.exitCode = 1;
});
