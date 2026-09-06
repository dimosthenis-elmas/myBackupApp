#!/usr/bin/env node
'use strict';

/**
 * End-to-end test of the "Recover data from optical media backup" UI wizard - the piece that directly answers
 * the original ask (avoid physically inserting discs, avoid manual button-clicking) - by driving the REAL app
 * through Playwright, with a single simulated "disc" (a mounted .iso built by test-harness/optical-media) in
 * place of a physical one, and the native "select folder" dialog stubbed so it never needs a person at the
 * keyboard.
 *
 * Deliberately scoped to a SINGLE disc for a first working version - the "backup to optical media" wizard's own
 * last step hands off to external ImgBurn software to actually burn, which nothing here can complete anyway (no
 * amount of scripting replaces a real burner + blank disc), and the worker-ipc tests already thoroughly verify
 * the app prepares that data correctly. So this test builds its one "disc" directly (bypassing the backup
 * wizard's burn step entirely) and focuses on what's actually new and high-value: reading from a (simulated)
 * disc and recovering files through the real UI.
 *
 * What it does:
 *   1. Generates a small random source tree + manifest (generate-random-tree.js).
 *   2. Builds a .iso from that tree and mounts it (test-harness/optical-media).
 *   3. Launches the real app, stubs the native "select folder" dialog to return a fresh scratch output folder.
 *   4. Clicks through: main menu -> Recover data from optical media backup -> select output folder -> Next ->
 *      (waits for the app's OWN disc detection to find the mounted .iso) -> "all discs processed" -> select all
 *      files -> Recover selected data -> confirm -> (waits for copy) -> "Ok" on the success dialog.
 *   5. Verifies the recovered folder's contents against the manifest by hash (verify-manifest.js) - a real
 *      pass/fail, not just "no error was thrown".
 *   6. Dismounts the .iso and cleans up its own scratch files either way.
 *
 * NOTE: needs a real Windows desktop/window session (see worker-ipc/call-worker.js's top comment) - run from
 * your own interactive terminal.
 *
 * Usage:
 *   node test-harness/ui/test-recover-single-disc.js [--random-tree | --json-tree]
 * See lib/fixture-tree-source.js for what step 1's source tree generation flags do - --json-tree uses this
 * script's own bundled example under ui/tree-specs/test-recover-single-disc/tree-spec.json.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { launchApp } = require('../worker-ipc/call-worker');
const { assertNoOpticalMediaAlreadyMounted, buildIso, mountIso, dismountIso } = require('./iso-disc');
const { printTree } = require('../lib/print-tree');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');
const { generateFixtureTree } = require('../lib/fixture-tree-source');
const { dismissStartupTempClearDialog } = require('../lib/startup-dialogs');

const SPEC_DIR = path.join(__dirname, 'tree-specs', 'test-recover-single-disc');

async function clickMainMenuButton(win, labelText) {
  const container = win.locator('.grid-container > div').filter({ has: win.locator('h2', { hasText: labelText }) });
  await container.locator('button').click();
}

async function main() {
  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `ui-recover-${runId}`);
  const sourceRoot = path.join(scratchRoot, 'source');
  const outputRoot = path.join(scratchRoot, 'recovered');
  const isoPath = path.join(scratchRoot, 'disc1.iso');
  fs.mkdirSync(outputRoot, { recursive: true }); // must pre-exist - stands in for what a real folder-picker dialog would only ever return

  // 1. Generate the source tree + manifest - random by default, or from this test's own bundled JSON spec
  //    (--json-tree) - see lib/fixture-tree-source.js.
  generateFixtureTree({
    root: sourceRoot,
    randomArgs: ['--files', '15', '--max-depth', '2', '--min-size', '0', '--max-size', '20000', '--seed', '777'],
    specDir: SPEC_DIR,
  });
  const manifestPath = `${sourceRoot}.manifest.json`;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log(`\nGenerated ${manifest.fileCount} files, ${manifest.totalSizeBytes.toLocaleString()} bytes total.`);
  printTree(sourceRoot, 'Source tree (before)');

  // 2. Build and mount the one "disc" this whole source tree fits on.
  console.log('\nChecking no optical media is already mounted...');
  assertNoOpticalMediaAlreadyMounted();
  console.log(`Building disc1.iso from the source tree...`);
  buildIso(sourceRoot, isoPath, 'TESTDISC1');
  console.log('Mounting it as a virtual optical drive...');
  const drive = mountIso(isoPath);
  console.log(`Mounted: ${JSON.stringify(drive)}`);

  let app, win;
  try {
    // 3. Launch the app and stub the native folder-picker to return our scratch output folder.
    console.log('\nLaunching the app...');
    ({ app, win } = await launchApp());
    await dismissStartupTempClearDialog(win);
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
    }, outputRoot);

    // 4. Click through the wizard - each interaction logged individually (before AND after) so a hang or a
    //    selector mismatch shows exactly where it stopped, instead of a silent gap between milestone messages.
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
        // Screenshot the app's actual on-screen state at the moment of failure - saved outside the
        // all-cleaned-up-either-way scratchRoot so it survives for you to look at (or point me at).
        const screenshotPath = path.join(FIXTURES_ROOT, `optical-backup-ui-test-failure-${runId}.png`);
        try {
          await win.screenshot({ path: screenshotPath });
          console.log(`  Screenshot of the app at the point of failure saved to: ${screenshotPath}`);
        } catch { /* app/window may already be gone (e.g. closed manually) - nothing more we can capture */ }
        throw e;
      }
      console.log('done');
      await new Promise((r) => setTimeout(r, WATCH_PAUSE_MS));
    };

    await step('main menu -> Recover data from optical media backup', () =>
      clickMainMenuButton(win, 'Recover data from optical media backup'));

    await step('click "Select a directory to save the recovered files"', () =>
      win.getByRole('button', { name: 'Select a directory to save the recovered files' }).click({ timeout: 15_000 }));

    await step('wait for the chosen output path to appear on screen', () =>
      win.getByText(outputRoot, { exact: true }).waitFor({ timeout: 10_000 }));

    await step('click "Next"', () =>
      win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 }));

    await step('wait for disc detection + read, click "All disks have been processed..." (up to 60s)', () =>
      win.getByRole('button', { name: 'All disks have been processed, continue to the next step' }).click({ timeout: 60_000 }));

    await step('click the "Select all" checkbox', () =>
      win.getByRole('checkbox', { name: 'Select all' }).click({ timeout: 30_000 }));

    await step('click "Recover selected data"', () =>
      win.getByRole('button', { name: 'Recover selected data' }).click({ timeout: 15_000 }));

    await step('click "Ok" on the "you will need to insert disc(s)" confirmation', () =>
      win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 30_000 }));

    // Small deliberate pause before the next wait - found empirically while building this: clicking straight
    // through to the "Data recovery successful" wait immediately after the line above raced the app's own
    // sequential worker-IPC calls in recoverAllFilesFromAllDiscs (ipc.stop() then waitForOpticalDiskToBeMounted()
    // back-to-back) closely enough that "the worker is busy" queuing kicked in and the copy silently moved zero
    // files despite the wizard still reporting success. A brief pause here reliably avoids it. This is
    // automation clicking through faster than a human ever would, not a bug a real user is likely to hit - but
    // documented here rather than silently worked around, in case it's worth a real fix in WorkerCommunicator's
    // queueing later.
    await new Promise((r) => setTimeout(r, 1000));

    await step('wait for the copy to finish, click "Ok" on "Data recovery successful" (up to 60s)', () =>
      win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 60_000 }));

    console.log('Wizard completed.');
  } finally {
    if (app) { await app.close().catch(() => {}); }
    console.log('\nDismounting the test disc...');
    dismountIso(isoPath);
  }

  // 5. Verify.
  printTree(outputRoot, 'Recovered tree (after)');
  console.log('\nVerifying recovered files against the manifest...');
  let verifyPassed = false;
  try {
    execFileSync(process.execPath, [
      path.join(__dirname, '../verify-manifest.js'),
      '--manifest', manifestPath,
      '--dir', outputRoot,
    ], { stdio: 'inherit' });
    verifyPassed = true;
  } catch {
    verifyPassed = false;
  }

  // 6. Clean up our own scratch files ONLY on success - on failure, leave everything (source tree, recovered
  //    output, the .iso) in place under scratchRoot so it can actually be inspected afterwards instead of
  //    guessing blind at what went wrong.
  if (verifyPassed) {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  } else {
    console.log(`\nLeaving scratch files in place for inspection: ${scratchRoot}`);
  }

  console.log(`\n${verifyPassed ? 'PASS' : 'FAIL'} - recovery wizard ${verifyPassed ? 'correctly recovered every file with matching content.' : 'did not produce a correct result, see verify-manifest output above.'}`);
  process.exitCode = verifyPassed ? 0 : 1;
}

main().catch((e) => {
  const message = (e && e.message) || String(e);
  const fullDetail = (e && e.stack) ? e.stack : message;

  // Playwright's "the app/browser was closed" errors come with a long, mostly-internal stack trace that's not
  // useful to read in full (e.g. if the app window was closed manually mid-run, which is an expected thing to
  // happen while poking at this interactively, not a real failure worth a wall of text). Print a short, clear
  // line for that case; for anything else, still keep the terminal output to just the message, and save the
  // full detail to a file instead of dumping it inline - print that file's path so it's there if actually needed.
  if (/closed|Target .*(closed|crashed)/i.test(message)) {
    console.error(`\nTEST ERRORED: the app window was closed before the test finished (${message}).`);
  } else {
    const logPath = path.join(FIXTURES_ROOT, `optical-backup-ui-test-error-${Date.now()}.log`);
    try { fs.writeFileSync(logPath, fullDetail); } catch { /* best effort - still show the short message below */ }
    console.error(`\nTEST ERRORED: ${message}`);
    console.error(`Full details saved to: ${logPath}`);
  }
  process.exitCode = 1;
});
