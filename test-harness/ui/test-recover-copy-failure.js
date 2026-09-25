#!/usr/bin/env node
'use strict';

/**
 * A copy that fails part-way through a recovery - through the REAL "Recover data from optical media backup" wizard,
 * with one simulated disc (a mounted .iso), like test-recover-single-disc.js.
 *
 * Just before the recovery copies anything, the folder it recovers into is made unwritable (a temporary "deny
 * write" ACL), so the copy from the disc fails. The wizard must then show its own "Error while recovering from
 * this disc" dialog with "Try this disc again" and "Cancel recovery" - not the generic "something unexpected went
 * wrong" error, and not a progress bar that never finishes. The folder is then made writable again and "Try this
 * disc again" is clicked: the recovery has to go on to the end and recover every file with matching content.
 *
 * NOTE: needs a real Windows desktop/window session (see worker-ipc/call-worker.js's top comment) - run from your
 * own interactive terminal.
 *
 * Usage:
 *   node test-harness/ui/test-recover-copy-failure.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { launchApp } = require('../worker-ipc/call-worker');
const { assertNoOpticalMediaAlreadyMounted, buildIso, mountIso, dismountIso } = require('./iso-disc');
const { printTree } = require('../lib/print-tree');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');

async function clickMainMenuButton(win, labelText) {
  const container = win.locator('.grid-container > div').filter({ has: win.locator('h2', { hasText: labelText }) });
  await container.locator('button').click();
}

function denyWrites(dir) { execFileSync('icacls', [dir, '/deny', '*S-1-1-0:(OI)(CI)(W)'], { stdio: 'pipe' }); }
function allowWrites(dir) { execFileSync('icacls', [dir, '/remove:d', '*S-1-1-0'], { stdio: 'pipe' }); }

async function main() {
  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `ui-recover-copy-failure-${runId}`);
  const sourceRoot = path.join(scratchRoot, 'source');
  const outputRoot = path.join(scratchRoot, 'recovered');
  const isoPath = path.join(scratchRoot, 'disc1.iso');
  fs.mkdirSync(outputRoot, { recursive: true });

  execFileSync(process.execPath, [
    path.join(__dirname, '../generate-random-tree.js'),
    '--root', sourceRoot, '--files', '12', '--max-depth', '2', '--min-size', '0', '--max-size', '20000', '--seed', '4711',
  ], { stdio: 'inherit' });
  const manifestPath = `${sourceRoot}.manifest.json`;
  printTree(sourceRoot, 'Source tree');

  console.log('\nChecking no optical media is already mounted...');
  assertNoOpticalMediaAlreadyMounted();
  buildIso(sourceRoot, isoPath, 'TESTDISC1');
  const drive = mountIso(isoPath);
  console.log(`Mounted: ${JSON.stringify(drive)}`);

  const results = {};
  let app, win, writesDenied = false;
  try {
    console.log('\nLaunching the app...');
    ({ app, win } = await launchApp());
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
    }, outputRoot);

    const WATCH_PAUSE_MS = 1000;
    const step = async (label, fn) => {
      process.stdout.write(`  [ ] ${label} ... `);
      try {
        await fn();
      } catch (e) {
        console.log('FAILED');
        const screenshotPath = path.join(FIXTURES_ROOT, `optical-backup-ui-recover-copy-failure-${runId}.png`);
        try { await win.screenshot({ path: screenshotPath }); console.log(`  Screenshot saved to: ${screenshotPath}`); } catch { /* window gone */ }
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

    console.log('  Making the recovery folder unwritable, so the copy from the disc fails...');
    denyWrites(outputRoot);
    writesDenied = true;

    await step('click "Ok" on the "you will need to insert disc(s)" confirmation', () =>
      win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 30_000 }));

    await step('wait for "Error while recovering from this disc" with "Try this disc again" and "Cancel recovery" (up to 60s)', async () => {
      const errorDialog = win.getByRole('dialog').filter({ hasText: 'Error while recovering from this disc' });
      await errorDialog.waitFor({ timeout: 60_000 });
      await errorDialog.getByRole('button', { name: 'Try this disc again', exact: true }).waitFor({ timeout: 5_000 });
      await errorDialog.getByRole('button', { name: 'Cancel recovery', exact: true }).waitFor({ timeout: 5_000 });
    });
    results.copyFailureShowsTheRecoveryErrorDialog = true;
    results.noGenericErrorDialog = (await win.getByText('Something unexpected went wrong').count()) === 0;

    console.log('  Making the recovery folder writable again...');
    allowWrites(outputRoot);
    writesDenied = false;

    await step('click "Try this disc again"', () =>
      win.getByRole('button', { name: 'Try this disc again', exact: true }).click({ timeout: 15_000 }));

    // Same short pause test-recover-single-disc.js makes before this wait - see its comment.
    await new Promise((r) => setTimeout(r, 1000));

    await step('wait for the copy to finish, click "Ok" on "Data recovery successful" (up to 60s)', () =>
      win.getByRole('dialog').filter({ hasText: 'Data recovery successful' }).getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 60_000 }));
    console.log('Wizard completed.');
  } finally {
    if (writesDenied) { try { allowWrites(outputRoot); } catch { /* best effort */ } }
    if (app) { await app.close().catch(() => {}); }
    console.log('\nDismounting the test disc...');
    dismountIso(isoPath);
  }

  printTree(outputRoot, 'Recovered tree (after)');
  console.log('\nVerifying recovered files against the manifest...');
  try {
    execFileSync(process.execPath, [path.join(__dirname, '../verify-manifest.js'), '--manifest', manifestPath, '--dir', outputRoot], { stdio: 'inherit' });
    results.tryingTheDiscAgainRecoversEverything = true;
  } catch {
    results.tryingTheDiscAgainRecoversEverything = false;
  }

  const pass = Object.values(results).length === 3 && Object.values(results).every(Boolean);
  console.log('\nSummary:');
  for (const [check, ok] of Object.entries(results)) { console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${check}`); }
  if (pass) {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  } else {
    console.log(`\nLeaving scratch files in place for inspection: ${scratchRoot}`);
  }
  console.log(`\n${pass ? 'PASS' : 'FAIL'} - a failed recovery copy ${pass ? 'showed the recovery error dialog, and trying the disc again recovered every file.' : 'was not handled as expected, see above.'}`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => {
  console.error('\nTEST ERRORED:', (e && e.message) || e);
  process.exitCode = 1;
});
