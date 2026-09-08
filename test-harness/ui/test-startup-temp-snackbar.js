#!/usr/bin/env node
'use strict';

/**
 * Exercises the non-blocking "temp dir has leftovers" startup snackbar (clearTempDataDirectoryOnStartup in
 * app.component.ts) - the redesign that replaced the old unconditional, blocking "Clearing temporary files"
 * dialog (every launch used to show it and clear the temp dir regardless of whether there was anything to
 * clear). Three scenarios, one real app launch each:
 *   1. Empty temp dir -> no snackbar at all.
 *   2. Leftover content -> snackbar appears, mentioning the leftover count -> ignored (never clicked) -> auto-
 *      dismisses on its own after ~10s -> the leftover content is still there, completely untouched.
 *   3. Leftover content again -> snackbar appears -> its "Clear" action is clicked -> a non-cancelable "Please
 *      wait" loading dialog blocks the app for the duration of the real delete, then disappears -> the temp dir
 *      actually gets cleared.
 *
 * No app source touched, no UI clicking beyond the snackbar's own "Clear" action in scenario 3 - the leftover
 * fixture itself is seeded directly on disk (a session-<id> folder holding one real-looking .ibb file, the
 * same shape a genuinely completed or interrupted real job leaves behind), not produced by driving a wizard.
 *
 * NOTE: needs a real Windows desktop/window session (see worker-ipc/call-worker.js's top comment) - run from
 * your own interactive terminal.
 *
 * Usage:
 *   node test-harness/ui/test-startup-temp-snackbar.js
 */

const fs = require('fs');
const path = require('path');
const { launchApp } = require('../worker-ipc/call-worker');
const { resolveRealTempDataDirectory, assertRealTempDataDirectoryIsSafeToUse, MARKER_FILENAME } = require('../worker-ipc/temp-dir-guard');

const SNACKBAR_TEXT_FRAGMENT = 'leftover item(s) from a previous session';
// The app's own snackbar duration (see the `duration` option on the MatSnackBar.open call in
// app.component.ts) plus a real margin, so waiting for it to auto-dismiss isn't a race against the exact same
// deadline the app itself is using.
const AUTO_DISMISS_WAIT_MS = 10_000 + 5_000;

function realEntries(tempDir) {
  if (!fs.existsSync(tempDir)) { return []; }
  return fs.readdirSync(tempDir).filter((e) => e !== MARKER_FILENAME);
}

/** Seeds one recognized, disposable leftover item directly under the temp dir - a session-<id> folder holding
 *  one real-looking .ibb project file (IBB_PROJECT_FILE_PATTERN in worker.ts only checks the file NAME, not its
 *  content) - the same shape a genuinely completed (or interrupted) real job leaves behind. Returns its path. */
function seedOneLeftoverItem(tempDir) {
  const sessionDir = path.join(tempDir, `session-${Date.now()}`);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'Disk_1.ibb'), 'dummy .ibb content - only the file name matters here');
  return sessionDir;
}

async function main() {
  const results = {};
  const tempDir = resolveRealTempDataDirectory();
  let app, win;

  // === Scenario 1: empty temp dir -> no snackbar at all ===
  console.log('\n=== Scenario 1: empty temp dir -> no snackbar ===');
  console.log('Checking the app\'s real temp/cache directory is safe to use (must be empty for this scenario)...');
  assertRealTempDataDirectoryIsSafeToUse();
  try {
    console.log('Launching the app...');
    ({ app, win } = await launchApp());
    console.log('  waiting 5s to give a snackbar every chance to appear if it were going to...');
    await new Promise((r) => setTimeout(r, 5000));
    const snackbarCount = await win.getByText(SNACKBAR_TEXT_FRAGMENT, { exact: false }).count();
    results.noSnackbarWhenEmpty = snackbarCount === 0;
    console.log(`  snackbar present: ${snackbarCount > 0} (expected false) - ${results.noSnackbarWhenEmpty ? 'OK' : 'WRONG'}`);
  } finally {
    if (app) { await app.close().catch(() => {}); }
  }

  // === Scenario 2: leftover content, ignored -> auto-dismisses, content untouched ===
  console.log('\n=== Scenario 2: leftover content, ignored -> auto-dismisses untouched ===');
  const leftoverDirIgnored = seedOneLeftoverItem(tempDir);
  console.log(`  seeded a fake leftover job at: ${leftoverDirIgnored}`);
  try {
    console.log('Launching the app...');
    ({ app, win } = await launchApp());
    console.log('  waiting for the snackbar to appear...');
    await win.getByText(SNACKBAR_TEXT_FRAGMENT, { exact: false }).waitFor({ timeout: 15_000 });
    results.snackbarAppearsWhenLeftoverExists = true;
    console.log('  snackbar appeared - OK');

    console.log(`  ignoring it (never clicking) - waiting up to ${AUTO_DISMISS_WAIT_MS / 1000}s for it to auto-dismiss...`);
    await win.getByText(SNACKBAR_TEXT_FRAGMENT, { exact: false }).waitFor({ state: 'hidden', timeout: AUTO_DISMISS_WAIT_MS });
    results.snackbarAutoDismissed = true;
    console.log('  snackbar auto-dismissed on its own - OK');

    const stillThere = fs.existsSync(leftoverDirIgnored);
    results.ignoredLeftoverUntouched = stillThere;
    console.log(`  leftover content still present after ignoring it: ${stillThere} - ${results.ignoredLeftoverUntouched ? 'OK' : 'WRONG'}`);
  } finally {
    if (app) { await app.close().catch(() => {}); }
    if (fs.existsSync(leftoverDirIgnored)) { fs.rmSync(leftoverDirIgnored, { recursive: true, force: true }); }
  }

  // === Scenario 3: leftover content, "Clear" clicked -> temp dir actually cleared ===
  console.log('\n=== Scenario 3: leftover content, "Clear" clicked -> temp dir cleared ===');
  const leftoverDirCleared = seedOneLeftoverItem(tempDir);
  console.log(`  seeded a fake leftover job at: ${leftoverDirCleared}`);
  try {
    console.log('Launching the app...');
    ({ app, win } = await launchApp());
    console.log('  waiting for the snackbar to appear...');
    await win.getByText(SNACKBAR_TEXT_FRAGMENT, { exact: false }).waitFor({ timeout: 15_000 });
    console.log('  clicking "Clear"...');
    await win.getByRole('button', { name: 'Clear', exact: true }).click({ timeout: 5000 });

    // Clicking "Clear" must block the app behind a non-cancelable loading dialog for the duration of the real
    // delete - see the comment on the "Clear" subscription in app.component.ts for why (a new job started while
    // the delete is still running could otherwise have its own just-created files swept up by it). Checked here,
    // not just inferred from the end state below, since a regression that dropped the blocking dialog entirely
    // would still leave the temp dir empty afterward and pass an end-state-only check.
    console.log('  waiting for the "Please wait" loading dialog to appear...');
    await win.getByText('Please wait', { exact: false }).waitFor({ timeout: 5000 });
    results.loadingDialogAppearsWhileClearing = true;
    console.log('  loading dialog appeared - OK');

    console.log('  waiting for the loading dialog to disappear once the clear finishes...');
    await win.getByText('Please wait', { exact: false }).waitFor({ state: 'hidden', timeout: 15_000 });
    results.loadingDialogDisappearsWhenDone = true;
    console.log('  loading dialog disappeared - OK');

    const remaining = realEntries(tempDir);
    results.clearActionEmptiesTempDir = remaining.length === 0;
    console.log(`  real entries remaining after "Clear": ${remaining.length} (expected 0) - ${results.clearActionEmptiesTempDir ? 'OK' : 'WRONG'}`);
    if (remaining.length > 0) { console.log(`    STILL PRESENT: ${remaining.join(', ')}`); }
  } finally {
    if (app) { await app.close().catch(() => {}); }
    if (fs.existsSync(leftoverDirCleared)) { fs.rmSync(leftoverDirCleared, { recursive: true, force: true }); }
  }

  const pass = Object.values(results).every(Boolean);
  console.log('\nSummary:');
  for (const [check, ok] of Object.entries(results)) { console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${check}`); }
  console.log(`\n${pass ? 'PASS' : 'FAIL'} - the startup temp-dir leftover snackbar ${pass ? 'behaves correctly: silent when nothing to report, safely ignorable, and clears on demand.' : 'did not behave as expected, see above.'}`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => {
  const message = (e && e.message) || String(e);
  console.error('\nTEST ERRORED:', e && e.stack ? e.stack : message);
  process.exitCode = 1;
});
