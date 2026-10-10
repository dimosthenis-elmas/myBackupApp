#!/usr/bin/env node
'use strict';

/**
 * What the user actually sees when the "Add missing files to optical media cold storage" wizard's first task, "Add
 * new files to my cold storage", cannot go ahead because a file it is told is already on the discs has CHANGED in
 * the master folder since it was burned - through the REAL app (Playwright clicks).
 *
 * ============================================================================================================
 * Why this is its own script rather than another phase of ui/test-add-missing-files.js
 * ============================================================================================================
 * That script is a single long burn: it generates a big master tree, burns 3 real discs (including a real 700MB
 * split), and verifies the whole merged metadata JSON. Reaching THIS dialog from there would mean either burning
 * all of that first, or re-launching the app mid-script - and the dialog itself is a small, fast, self-contained
 * thing (no disc is read, no .ibb is written, nothing is burned: the diff runs entirely against a JSON), so it is
 * cheap to prove on its own. It is also the one path in this component that STOPS the flow and is exercised by
 * nothing else: ui/test-add-missing-files.js deliberately records its one already-backed-up folder with an OLDER
 * mtime than the master's (see "burned-empty-folder" there) precisely to prove an unchanged EMPTY FOLDER is NOT
 * treated as modified - the opposite of what this script proves for a real FILE.
 *
 * ============================================================================================================
 * The check this covers
 * ============================================================================================================
 * diff() (in add-missing-files-to-optical-media-cold-storage.component.ts) walks every master file, and for each
 * one that the cold storage already records, compares mtime OR size. Any that differ are "modified": the wizard
 * cannot proceed, because adding files cannot repair a file that was burned and then changed. It collects ALL of
 * them (it used to stop at the first) and shows them in the shared ConfirmationDialogComponent's `lists` - a real
 * cdk-virtual-scroll-viewport, so even a very large number of them stays usable.
 *
 * ============================================================================================================
 * How the fixture is built (and why it is deterministic)
 * ============================================================================================================
 * A tiny master folder with three files:
 *   kept.txt      - copied onto the "existing disc" and left alone: must NOT be reported.
 *   changed.txt   - copied onto the "existing disc", and THEN appended to in the master, so its size no longer
 *                   matches what the disc recorded: must be reported, and listed by its master path.
 *   brand-new.txt - never backed up: a genuinely MISSING file, which must NOT be mistaken for a modified one
 *                   (and must not be what the dialog is about).
 * The "existing disc" folder's real listing (through the app's own get-file-paths-with-stats IPC, turned into a
 * metadata JSON by lib/cold-storage-metadata.js - the exact same technique ui/test-add-missing-files.js uses) is
 * written BEFORE the master's copy is appended to, so the JSON holds the original size. Comparing sizes (rather
 * than only mtimes) makes this independent of filesystem timestamp resolution and clock skew.
 *
 * NOTE: needs a real Windows desktop/window session (see worker-ipc/call-worker.js's top comment) - run from your
 * own interactive terminal.
 *
 * Usage:
 *   node test-harness/ui/test-add-missing-files-modified.js
 */

const fs = require('fs');
const path = require('path');
const { launchApp, callWorker } = require('../worker-ipc/call-worker');
const { normalizeForMetadata } = require('../lib/cold-storage-metadata');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');

const WATCH_PAUSE_MS = 1000;

/** Prints a periodic "still working" line while `promise` is pending - identical to the helper in
 *  ui/test-add-missing-files.js (a real get-file-paths-with-stats call once looked hung). */
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

async function clickMainMenuButton(win, labelText) {
  const container = win.locator('.grid-container > div').filter({ has: win.locator('h2', { hasText: labelText }) });
  await container.locator('button').click();
}

async function main() {
  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `add-missing-files-modified-${runId}`);
  const masterDir = path.join(scratchRoot, 'master');
  const existingDisc1Dir = path.join(scratchRoot, 'existing-disc1-files');
  const existingMetadataJsonPath = path.join(scratchRoot, 'existing-cold-storage-metadata.json');

  // --- The fixture (see the header above for why exactly these three files) ---
  const keptFileRel = 'kept.txt';
  const changedFileRel = 'changed.txt';
  const brandNewFileRel = 'brand-new.txt';
  fs.mkdirSync(masterDir, { recursive: true });
  fs.mkdirSync(existingDisc1Dir, { recursive: true });
  fs.writeFileSync(path.join(masterDir, keptFileRel), 'already backed up and unchanged');
  fs.writeFileSync(path.join(masterDir, changedFileRel), 'already backed up');
  fs.writeFileSync(path.join(masterDir, brandNewFileRel), 'not backed up at all');
  const keptMasterPath = path.join(masterDir, keptFileRel);
  const changedMasterPath = path.join(masterDir, changedFileRel);
  const brandNewMasterPath = path.join(masterDir, brandNewFileRel);

  // The "existing disc": a copy of the two files the metadata JSON will record as already burned. brand-new.txt is
  // deliberately NOT copied - it stays the genuinely missing file the wizard would otherwise go on to offer.
  fs.copyFileSync(path.join(masterDir, keptFileRel), path.join(existingDisc1Dir, keptFileRel));
  fs.copyFileSync(path.join(masterDir, changedFileRel), path.join(existingDisc1Dir, changedFileRel));

  console.log(`\nMaster folder: ${masterDir}`);
  console.log(`Existing disc: ${existingDisc1Dir}`);
  console.log(`  ${keptFileRel}    - on the disc, unchanged (must NOT be listed)`);
  console.log(`  ${changedFileRel}    - on the disc, then changed in the master (must be listed)`);
  console.log(`  ${brandNewFileRel} - never backed up, genuinely missing (must NOT be listed)`);

  let app, win;
  let verifyPassed = false;
  try {
    console.log('\nLaunching the app...');
    ({ app, win } = await launchApp());

    // Both pickers ("Select the location of your files (Master)" and "Select JSON file") go through the same
    // native open dialog - same stub as ui/test-add-missing-files.js.
    await app.evaluate(({ dialog }, paths) => {
      const queue = [...paths];
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [queue.shift()] });
    }, [masterDir, existingMetadataJsonPath]);

    // The existing cold storage metadata JSON is built the real way - from a real listing of the "existing disc"
    // folder, through the app's own get-file-paths-with-stats IPC (see lib/cold-storage-metadata.js).
    console.log("\nAsking the app for the existing disc's real file listing (get-file-paths-with-stats)...");
    const listing = (await withHeartbeat(callWorker(win, 'get-file-paths-with-stats', { dirPath: existingDisc1Dir }), 'get-file-paths-with-stats (existing disc 1)')).res;
    const existingMetadata = [normalizeForMetadata(listing, existingDisc1Dir)];
    fs.writeFileSync(existingMetadataJsonPath, JSON.stringify(existingMetadata, null, 2));
    console.log(`Wrote existing cold storage metadata JSON (1 disc, ${existingMetadata[0].length} entries) to:\n  ${existingMetadataJsonPath}`);

    // ONLY NOW change the master's copy, so the JSON still records the ORIGINAL size - this is exactly the "the
    // file was burned, and then changed in the master" situation this dialog exists for. Appending makes the size
    // differ (the check compares size as well as mtime), so this is deterministic on any filesystem/clock.
    fs.appendFileSync(changedMasterPath, ' - but this was added to the master copy afterwards, so it no longer matches the disc');

    const step = async (label, fn) => {
      process.stdout.write(`  [ ] ${label} ... `);
      try {
        await fn();
      } catch (e) {
        console.log('FAILED');
        const screenshotPath = path.join(FIXTURES_ROOT, `optical-backup-ui-add-missing-files-modified-test-failure-${runId}.png`);
        try {
          await win.screenshot({ path: screenshotPath });
          console.log(`  Screenshot of the app at the point of failure saved to: ${screenshotPath}`);
        } catch { /* app/window may already be gone */ }
        throw e;
      }
      console.log('done');
      await new Promise((r) => setTimeout(r, WATCH_PAUSE_MS));
    };

    // --- Drive the wizard up to the point the diff runs (mirrors ui/test-add-missing-files.js's Phase A) ---
    await step('main menu -> Add missing files to optical media cold storage', () =>
      clickMainMenuButton(win, 'Add missing files to optical media cold storage'));

    // ngAfterViewInit unconditionally opens an "Info" dialog before step 1 is usable.
    await step('click "Ok" on the wizard\'s info dialog', () =>
      win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 }));

    await step('click "Add new files"', () =>
      win.getByRole('button', { name: 'Add new files', exact: true }).click({ timeout: 15_000 }));

    await step('click "Select the location of your files (Master)"', () =>
      win.getByRole('button', { name: 'Select the location of your files (Master)' }).click({ timeout: 15_000 }));

    await step('wait for the chosen master path to appear on screen', () =>
      win.getByText(masterDir, { exact: true }).waitFor({ timeout: 10_000 }));

    await step('open the "Optical medium type" dropdown', () =>
      win.getByRole('combobox').click({ timeout: 15_000 }));

    await step('select "CD (700 MB)"', () =>
      win.getByRole('option', { name: 'CD (700 MB)' }).click({ timeout: 15_000 }));

    await step('click "Select JSON file"', () =>
      win.getByRole('button', { name: 'Select JSON file' }).click({ timeout: 15_000 }));

    await step('wait for the chosen JSON path to appear on screen', () =>
      win.getByText(existingMetadataJsonPath, { exact: true }).waitFor({ timeout: 10_000 }));

    // Same race as ui/test-add-missing-files.js: the chip above appears the instant a path is chosen, BEFORE
    // afterJSONpathIsGiven() has finished reading+validating the JSON over IPC - clicking "Next" before that shows
    // the "Missing fields" dialog instead of starting the diff. A deliberate pause avoids that.
    await new Promise((r) => setTimeout(r, 2000));

    await step('click "Next" (scans the master, diffs against the JSON - no disc reads needed)', () =>
      win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 }));

    // --- The dialog under test ---
    const errorDialog = win.getByRole('dialog').filter({ hasText: 'have changed in the master' });
    await step('wait for the "Error" dialog listing the changed file (up to 60s)', () =>
      errorDialog.waitFor({ timeout: 60_000 }));

    // A real cdk-virtual-scroll-viewport (ConfirmationDialogComponent's `lists`), not a plain scrolling div.
    await step('wait for the modified-files scrollable list to render', () =>
      errorDialog.locator('cdk-virtual-scroll-viewport.confirmation-dialog-list').waitFor({ timeout: 15_000 }));

    const dialogText = await errorDialog.innerText();
    const listItemTexts = await errorDialog.locator('.confirmation-dialog-list-item').allTextContents();
    const viewportCount = await errorDialog.locator('cdk-virtual-scroll-viewport.confirmation-dialog-list').count();
    const step3TreeRendered = await win.getByText('Below you see the files missing from your cold storage.', { exact: true }).count();

    const showsTitle = dialogText.includes('Error');
    const showsReason = dialogText.includes('have changed in the master folder since') && dialogText.includes('Adding files cannot fix that');
    const showsLabel = dialogText.includes('Modified files (1):');
    const listsChangedFile = listItemTexts.length === 1 && listItemTexts[0] === changedMasterPath;
    const omitsUnchangedFile = !dialogText.includes(keptMasterPath);
    const omitsMissingFile = !dialogText.includes(brandNewMasterPath);
    const isOneRealScrollingList = viewportCount === 1;
    const didNotBuildMissingTree = step3TreeRendered === 0;

    console.log(`\n  Dialog title mentions "Error": ${showsTitle ? 'OK' : 'WRONG'}`);
    console.log(`  Dialog says why in words: ${showsReason ? 'OK' : 'WRONG'}`);
    console.log(`  List label "Modified files (1):" present: ${showsLabel ? 'OK' : 'WRONG'}`);
    console.log(`  List holds exactly the changed file, by its master path: ${listsChangedFile ? 'OK' : 'WRONG'}`);
    if (!listsChangedFile) { console.log(`    list item(s): ${JSON.stringify(listItemTexts)} (expected ${JSON.stringify([changedMasterPath])})`); }
    console.log(`  Unchanged, already-backed-up file not listed: ${omitsUnchangedFile ? 'OK' : 'WRONG - regression!'}`);
    console.log(`  Genuinely missing file not listed as modified: ${omitsMissingFile ? 'OK' : 'WRONG - regression!'}`);
    console.log(`  One real cdk-virtual-scroll-viewport (not a plain div): ${isOneRealScrollingList ? 'OK' : 'WRONG'}`);
    console.log(`  The "select files to burn" tree was never built underneath: ${didNotBuildMissingTree ? 'OK' : 'WRONG - regression!'}`);

    verifyPassed = showsTitle && showsReason && showsLabel && listsChangedFile && omitsUnchangedFile && omitsMissingFile && isOneRealScrollingList && didNotBuildMissingTree;

    // Ok exits to the main menu (goToMainMenuAndReload) - proving the flow stopped rather than carrying on.
    await step('click "Ok" on the dialog', () =>
      errorDialog.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 }));

    await step('wait for the main menu again (the wizard reloads the app)', () =>
      win.locator('.grid-container > div').filter({ has: win.locator('h2', { hasText: 'Add missing files to optical media cold storage' }) }).waitFor({ timeout: 30_000 }));

    if (verifyPassed) {
      fs.rmSync(scratchRoot, { recursive: true, force: true });
    } else {
      console.log(`\nLeaving scratch files in place for inspection: ${scratchRoot}`);
    }

    console.log(`\n${verifyPassed ? 'PASS' : 'FAIL'} - add-missing-files-modified ${verifyPassed ? 'refused to add files to a cold storage whose burned file had changed in the master, listed every changed file by its master path in a real scrollable list, and left the "select files to burn" tree unbuilt.' : 'did not show the expected dialog/list, see the checks above.'}`);
    process.exitCode = verifyPassed ? 0 : 1;
  } finally {
    if (app) { await app.close().catch(() => {}); }
  }
}

main().catch((e) => {
  const message = (e && e.message) || String(e);
  const fullDetail = (e && e.stack) ? e.stack : message;
  if (/closed|Target .*(closed|crashed)/i.test(message)) {
    console.error(`\nTEST ERRORED: the app window was closed before the test finished (${message}).`);
  } else {
    const logPath = path.join(FIXTURES_ROOT, `optical-backup-ui-add-missing-files-modified-test-error-${Date.now()}.log`);
    try { fs.writeFileSync(logPath, fullDetail); } catch { /* best effort */ }
    console.error(`\nTEST ERRORED: ${message}`);
    console.error(`Full details saved to: ${logPath}`);
  }
  process.exitCode = 1;
});

