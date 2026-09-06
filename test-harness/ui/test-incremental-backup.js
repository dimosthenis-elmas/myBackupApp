#!/usr/bin/env node
'use strict';

/**
 * End-to-end test of the "Cumulative backup" UI wizard (main menu -> Cumulative backup -> pick source/backup
 * folders -> review the diff -> preview -> confirm -> copy -> success) by driving the REAL app through
 * Playwright - actual clicks on actual screens, unlike worker-ipc/test-incremental-backup.js, which sends the
 * same `diff`/`incremental-copy-files` IPC messages directly and never touches the UI at all (see that script's
 * own header, and its README, for why - and for the much deeper "is this truly incremental, not just
 * copy-everything" assertions, which live there rather than being duplicated here).
 *
 * This one is folder-to-folder only - no optical media simulation needed (see test-harness/optical-media) - so
 * the only dialog that needs stubbing is the native "choose a folder" picker, twice: once for the source
 * directory, once for the backup (target) directory. Both go through the exact same `dialog.showOpenDialog`
 * stub test-harness/ui/test-recover-single-disc.js already uses (see ipcMain.handle('dialog', ...) in
 * app/main.ts - every "choose a folder/file" button in the app funnels through that one real Electron API), just
 * returning a different queued path on each of the two calls instead of always the same one.
 *
 * Scope: ONE pass through the wizard (generate a source tree -> sync it to an empty target -> verify byte-for-
 * byte), the same scope as test-recover-single-disc.js. Proving the *second*-sync behavior (diff reporting only
 * the changed files, untouched files never re-touched) is exactly what worker-ipc/test-incremental-backup.js
 * already does thoroughly; re-driving a second full pass through the UI here would mostly add page-reload
 * handling complexity (via the app's own icon-button "go to main menu", which does a full window.location.reload())
 * without adding real new coverage - left as a natural follow-up if ever wanted.
 *
 * NOTE: needs a real Windows desktop/window session (see worker-ipc/call-worker.js's top comment) - run from
 * your own interactive terminal.
 *
 * Usage:
 *   node test-harness/ui/test-incremental-backup.js [--random-tree | --json-tree]
 * See lib/fixture-tree-source.js for what step 1's source tree generation flags do - --json-tree uses this
 * script's own bundled example under ui/tree-specs/test-incremental-backup/tree-spec.json.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { launchApp } = require('../worker-ipc/call-worker');
const { printTree } = require('../lib/print-tree');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');
const { generateFixtureTree } = require('../lib/fixture-tree-source');

const SPEC_DIR = path.join(__dirname, 'tree-specs', 'test-incremental-backup');

async function clickMainMenuButton(win, labelText) {
  const container = win.locator('.grid-container > div').filter({ has: win.locator('h2', { hasText: labelText }) });
  await container.locator('button').click();
}

async function main() {
  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `ui-incremental-${runId}`);
  const sourceRoot = path.join(scratchRoot, 'source');
  const targetRoot = path.join(scratchRoot, 'target');

  // 1. Generate the source tree + manifest - random by default, or from this test's own bundled JSON spec
  //    (--json-tree) - see lib/fixture-tree-source.js. --no-edge-cases in random mode for the same reason
  //    worker-ipc/test-incremental-backup.js uses it - keeps this test's own scope (the wizard's screens/buttons
  //    actually work) separate from edge-case coverage, which test-recover-single-disc.js already exercises (the
  //    bundled JSON example mirrors that: no edge cases either).
  generateFixtureTree({
    root: sourceRoot,
    randomArgs: ['--files', '15', '--max-depth', '2', '--min-size', '0', '--max-size', '20000', '--seed', '13131', '--no-edge-cases'],
    specDir: SPEC_DIR,
  });
  const manifestPath = `${sourceRoot}.manifest.json`;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log(`\nGenerated ${manifest.fileCount} files, ${manifest.totalSizeBytes.toLocaleString()} bytes total.`);
  printTree(sourceRoot, 'Source tree (before)');

  fs.mkdirSync(targetRoot, { recursive: true }); // must pre-exist - stands in for what the folder-picker would return

  let app, win;
  try {
    // 2. Launch the app and stub the native folder-picker: first call (Source directory) returns sourceRoot,
    //    second call (Backup directory) returns targetRoot - both buttons go through the same
    //    window.electronAPI.openDialog('showOpenDialog', ...) -> ipcMain.handle('dialog', ...) -> dialog.showOpenDialog
    //    path, so one stub with a small queue covers both.
    console.log('\nLaunching the app...');
    ({ app, win } = await launchApp());
    await app.evaluate(({ dialog }, paths) => {
      const queue = [...paths];
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [queue.shift()] });
    }, [sourceRoot, targetRoot]);

    // 3. Click through the wizard - each interaction logged individually (before AND after), same pattern as
    //    test-recover-single-disc.js, for the same reason: pinpoints exactly which click got stuck or failed.
    // Pause after every successful step, deliberately - long enough for a human watching the window to actually
    // see what just happened before the next click fires. Purely for watchability; the app itself doesn't need
    // this.
    const WATCH_PAUSE_MS = 5000;

    const step = async (label, fn) => {
      process.stdout.write(`  [ ] ${label} ... `);
      try {
        await fn();
      } catch (e) {
        console.log('FAILED');
        const screenshotPath = path.join(FIXTURES_ROOT, `optical-backup-ui-incremental-test-failure-${runId}.png`);
        try {
          await win.screenshot({ path: screenshotPath });
          console.log(`  Screenshot of the app at the point of failure saved to: ${screenshotPath}`);
        } catch { /* app/window may already be gone */ }
        throw e;
      }
      console.log('done');
      await new Promise((r) => setTimeout(r, WATCH_PAUSE_MS));
    };

    await step('main menu -> Cumulative backup', () =>
      clickMainMenuButton(win, 'Cumulative backup'));

    await step('click "Source directory path"', () =>
      win.getByRole('button', { name: 'Source directory path' }).click({ timeout: 15_000 }));

    await step('wait for the chosen source path to appear on screen', () =>
      win.getByText(sourceRoot, { exact: true }).waitFor({ timeout: 10_000 }));

    await step('click "Backup directory path"', () =>
      win.getByRole('button', { name: 'Backup directory path' }).click({ timeout: 15_000 }));

    await step('wait for the chosen backup path to appear on screen', () =>
      win.getByText(targetRoot, { exact: true }).waitFor({ timeout: 10_000 }));

    await step('click "Next" (entry point -> diff screen)', () =>
      win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 }));

    await step('wait for the diff to finish and the "Select all" checkbox to appear (up to 30s)', () =>
      win.getByRole('checkbox', { name: 'Select all' }).waitFor({ timeout: 30_000 }));

    await step('click the "Select all" checkbox', () =>
      win.getByRole('checkbox', { name: 'Select all' }).click({ timeout: 15_000 }));

    await step('click "Next" (diff screen -> preview dialog)', () =>
      win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 }));

    await step('click "Write to the backup" in the preview dialog', () =>
      win.getByRole('button', { name: 'Write to the backup' }).click({ timeout: 30_000 }));

    await step('click "Yes" on the copy confirmation', () =>
      win.getByRole('button', { name: 'Yes', exact: true }).click({ timeout: 15_000 }));

    await step('wait for the copy to finish, click "Ok" on "The files have been copied successfully" (up to 60s)', () =>
      win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 60_000 }));

    console.log('Wizard completed.');
  } finally {
    if (app) { await app.close().catch(() => {}); }
  }

  // 4. Verify.
  printTree(targetRoot, 'Backup target tree (after)');
  console.log('\nVerifying the backup against the manifest...');
  let verifyPassed = false;
  try {
    execFileSync(process.execPath, [
      path.join(__dirname, '../verify-manifest.js'),
      '--manifest', manifestPath,
      '--dir', targetRoot,
    ], { stdio: 'inherit' });
    verifyPassed = true;
  } catch {
    verifyPassed = false;
  }

  // 5. Clean up only on success - on failure, leave everything in place for inspection.
  if (verifyPassed) {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  } else {
    console.log(`\nLeaving scratch files in place for inspection: ${scratchRoot}`);
  }

  console.log(`\n${verifyPassed ? 'PASS' : 'FAIL'} - Cumulative backup wizard ${verifyPassed ? 'correctly copied every file with matching content.' : 'did not produce a correct result, see verify-manifest output above.'}`);
  process.exitCode = verifyPassed ? 0 : 1;
}

main().catch((e) => {
  const message = (e && e.message) || String(e);
  const fullDetail = (e && e.stack) ? e.stack : message;
  if (/closed|Target .*(closed|crashed)/i.test(message)) {
    console.error(`\nTEST ERRORED: the app window was closed before the test finished (${message}).`);
  } else {
    const logPath = path.join(FIXTURES_ROOT, `optical-backup-ui-incremental-test-error-${Date.now()}.log`);
    try { fs.writeFileSync(logPath, fullDetail); } catch { /* best effort */ }
    console.error(`\nTEST ERRORED: ${message}`);
    console.error(`Full details saved to: ${logPath}`);
  }
  process.exitCode = 1;
});
