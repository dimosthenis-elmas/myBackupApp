#!/usr/bin/env node
'use strict';

/**
 * What the user actually sees when Cumulative backup or Synchronize directories cannot go ahead, through the REAL
 * app (Playwright clicks). Each scenario gets a fresh app and fresh folders under test-harness/generated-fixtures/.
 *
 *   1. Cumulative backup with the backup folder INSIDE the source folder, and
 *   2. Synchronize directories with the target folder CONTAINING the template folder:
 *      both are refused. The error dialog has to say why in words ("One of the two folders is inside the other",
 *      naming both) - the worker's error used to reach dialogs as "[object Object]" - and neither folder changes.
 *   3. Cumulative backup with a folder in the source that Windows refuses to list (a temporary "deny list folder"
 *      ACL - the same thing that makes e.g. the legacy "My Music" junction inside Documents unreadable): a warning
 *      titled "Some items were left out" lists that folder by its full path, and the comparison still goes on
 *      to show everything else.
 *   4. Synchronize directories where, after the sync, the two folders still differ - a file renamed only in letter
 *      case ("Photo.jpg" / "photo.jpg"), which the sync leaves as it is: the check it runs afterwards shows
 *      "Directory synchronization - differences found" with that file in its scrollable list, saying what differs.
 *
 * NOTE: needs a real Windows desktop/window session (see worker-ipc/call-worker.js's top comment) - run from your
 * own interactive terminal.
 *
 * Usage:
 *   node test-harness/ui/test-wizard-error-dialogs.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { launchApp } = require('../worker-ipc/call-worker');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');

const WATCH_PAUSE_MS = 1000;

async function clickMainMenuButton(win, labelText) {
  const container = win.locator('.grid-container > div').filter({ has: win.locator('h2', { hasText: labelText }) });
  await container.locator('button').click();
}

function listTree(root) {
  const out = [];
  (function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { out.push(path.join(dir, e.name)); if (e.isDirectory()) { walk(path.join(dir, e.name)); } } })(root);
  return out.sort();
}

async function withApp(label, runId, pickedPaths, body) {
  let app, win;
  const step = async (text, fn) => {
    process.stdout.write(`  [ ] ${text} ... `);
    try {
      await fn();
    } catch (e) {
      console.log('FAILED');
      const screenshotPath = path.join(FIXTURES_ROOT, `optical-backup-ui-wizard-error-dialogs-${label}-${runId}.png`);
      try { await win.screenshot({ path: screenshotPath }); console.log(`  Screenshot saved to: ${screenshotPath}`); } catch { /* window gone */ }
      throw e;
    }
    console.log('done');
    await new Promise((r) => setTimeout(r, WATCH_PAUSE_MS));
  };
  try {
    ({ app, win } = await launchApp());
    await app.evaluate(({ dialog }, paths) => {
      const queue = [...paths];
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [queue.shift()] });
    }, pickedPaths);
    await body(win, step);
  } finally {
    if (app) { await app.close().catch(() => {}); }
  }
}

async function main() {
  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `ui-wizard-error-dialogs-${runId}`);
  const results = {};

  // ---- 1. Cumulative backup: the backup folder inside the source
  {
    const source = path.join(scratchRoot, 'cumulative-nested', 'source');
    const backup = path.join(source, 'backup');
    fs.mkdirSync(backup, { recursive: true });
    fs.writeFileSync(path.join(source, 'a.txt'), 'a');
    const before = listTree(path.join(scratchRoot, 'cumulative-nested'));
    console.log('\n=== Cumulative backup, backup folder inside the source');
    await withApp('cumulative-nested', runId, [source, backup], async (win, step) => {
      await step('main menu -> Cumulative backup', () => clickMainMenuButton(win, 'Cumulative backup'));
      await step('pick the source folder', () => win.getByRole('button', { name: 'Source directory path' }).click({ timeout: 15_000 }));
      await step('pick the backup folder', () => win.getByRole('button', { name: 'Backup directory path' }).click({ timeout: 15_000 }));
      await step('wait for the backup path on screen', () => win.getByText(backup, { exact: true }).waitFor({ timeout: 10_000 }));
      await step('click "Next"', () => win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 }));
      await step('wait for the error dialog (up to 30s)', () => win.getByRole('dialog').filter({ hasText: 'inside the other' }).waitFor({ timeout: 30_000 }));
      const text = await win.getByRole('dialog').filter({ hasText: 'inside the other' }).innerText();
      results['cumulative: folders inside each other are refused with a message naming both'] = text.includes(source) && text.includes(backup);
      results['cumulative: the message is readable (no "[object Object]")'] = !text.includes('[object Object]');
    });
    results['cumulative: nothing changed on disk'] = JSON.stringify(listTree(path.join(scratchRoot, 'cumulative-nested'))) === JSON.stringify(before);
  }

  // ---- 2. Synchronize directories: the target folder contains the template folder
  {
    const target = path.join(scratchRoot, 'sync-nested', 'target');
    const template = path.join(target, 'Photos');
    fs.mkdirSync(template, { recursive: true });
    fs.writeFileSync(path.join(template, 'p1.jpg'), 'p1');
    fs.writeFileSync(path.join(target, 'other.txt'), 'o');
    const before = listTree(path.join(scratchRoot, 'sync-nested'));
    console.log('\n=== Synchronize directories, target folder contains the template folder');
    await withApp('sync-nested', runId, [template, target], async (win, step) => {
      await step('main menu -> Synchronize directories', () => clickMainMenuButton(win, 'Synchronize directories'));
      await step('pick the template folder', () => win.getByRole('button', { name: 'Path to the template directory' }).click({ timeout: 15_000 }));
      await step('pick the folder to be synchronized', () => win.getByRole('button', { name: 'Path to the directory to be synchronized with the template' }).click({ timeout: 15_000 }));
      await step('wait for the target path on screen', () => win.getByText(target, { exact: true }).waitFor({ timeout: 10_000 }));
      await step('click "Next"', () => win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 }));
      await step('click "Continue" on the warning', () => win.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 15_000 }));
      await step('wait for the error dialog (up to 30s)', () => win.getByRole('dialog').filter({ hasText: 'inside the other' }).waitFor({ timeout: 30_000 }));
      const text = await win.getByRole('dialog').filter({ hasText: 'inside the other' }).innerText();
      results['sync: folders inside each other are refused with a message naming both'] = text.includes(template) && text.includes(target);
      results['sync: the message is readable (no "[object Object]")'] = !text.includes('[object Object]');
    });
    results['sync: nothing changed on disk - the template folder is still there'] =
      JSON.stringify(listTree(path.join(scratchRoot, 'sync-nested'))) === JSON.stringify(before);
  }

  // ---- 3. Cumulative backup: a source folder Windows refuses to list
  {
    const source = path.join(scratchRoot, 'cumulative-unreadable', 'source');
    const backup = path.join(scratchRoot, 'cumulative-unreadable', 'backup');
    const locked = path.join(source, 'locked');
    fs.mkdirSync(locked, { recursive: true });
    fs.mkdirSync(backup, { recursive: true });
    fs.writeFileSync(path.join(source, 'readable.txt'), 'r');
    fs.writeFileSync(path.join(locked, 'secret.txt'), 's');
    execFileSync('icacls', [locked, '/deny', '*S-1-1-0:(RD)'], { stdio: 'pipe' });
    console.log('\n=== Cumulative backup, a source folder that cannot be listed');
    try {
      await withApp('cumulative-unreadable', runId, [source, backup], async (win, step) => {
        await step('main menu -> Cumulative backup', () => clickMainMenuButton(win, 'Cumulative backup'));
        await step('pick the source folder', () => win.getByRole('button', { name: 'Source directory path' }).click({ timeout: 15_000 }));
        await step('pick the backup folder', () => win.getByRole('button', { name: 'Backup directory path' }).click({ timeout: 15_000 }));
        await step('wait for the backup path on screen', () => win.getByText(backup, { exact: true }).waitFor({ timeout: 10_000 }));
        await step('click "Next"', () => win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 }));
        const warning = win.getByRole('dialog').filter({ hasText: 'Some items were left out' });
        await step('wait for "Some items were left out" (up to 30s)', () => warning.waitFor({ timeout: 30_000 }));
        results['cumulative: the skipped folder is listed by its full path'] = (await warning.getByText(locked).count()) > 0;
        await step('click "Ok" on the warning', () => warning.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 }));
        await step('the comparison still finishes ("Select all" appears, up to 30s)', () => win.getByRole('checkbox', { name: 'Select all' }).waitFor({ timeout: 30_000 }));
        results['cumulative: the comparison goes on without the unreadable folder'] = true;
      });
    } finally {
      execFileSync('icacls', [locked, '/remove:d', '*S-1-1-0'], { stdio: 'pipe' });
    }
  }

  // ---- 4. Synchronize directories: the check after the sync finds a difference
  {
    const template = path.join(scratchRoot, 'sync-difference', 'template');
    const target = path.join(scratchRoot, 'sync-difference', 'target');
    fs.mkdirSync(template, { recursive: true }); fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(template, 'Photo.jpg'), 'p'); fs.writeFileSync(path.join(target, 'photo.jpg'), 'p');
    fs.writeFileSync(path.join(template, 'new.txt'), 'n');
    console.log('\n=== Synchronize directories, the check afterwards finds a name that differs only in letter case');
    await withApp('sync-difference', runId, [template, target], async (win, step) => {
      await step('main menu -> Synchronize directories', () => clickMainMenuButton(win, 'Synchronize directories'));
      await step('pick the template folder', () => win.getByRole('button', { name: 'Path to the template directory' }).click({ timeout: 15_000 }));
      await step('pick the folder to be synchronized', () => win.getByRole('button', { name: 'Path to the directory to be synchronized with the template' }).click({ timeout: 15_000 }));
      await step('wait for the target path on screen', () => win.getByText(target, { exact: true }).waitFor({ timeout: 10_000 }));
      await step('click "Next"', () => win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 }));
      await step('click "Continue" on the warning', () => win.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 15_000 }));
      await step('wait for the preview, click "Write to the backup" (up to 60s)', () => win.getByRole('button', { name: 'Write to the backup' }).click({ timeout: 60_000 }));
      await step('click "Yes, continue"', () => win.getByRole('button', { name: 'Yes, continue', exact: true }).click({ timeout: 15_000 }));
      const differences = win.getByRole('dialog').filter({ hasText: 'differences found' });
      await step('wait for "Directory synchronization - differences found" (up to 60s)', () => differences.waitFor({ timeout: 60_000 }));
      results['sync: the check after the sync lists the difference by name, saying what differs'] =
        (await differences.getByText('Photo.jpg  -  the name differs only in letter case: "photo.jpg" in the target').count()) > 0;
      await step('click "Ok"', () => differences.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 }));
    });
    results['sync: the other change was still made'] = fs.existsSync(path.join(target, 'new.txt'));
  }

  const pass = Object.keys(results).length > 0 && Object.values(results).every(Boolean);
  console.log('\nSummary:');
  for (const [check, ok] of Object.entries(results)) { console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${check}`); }
  if (pass) {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  } else {
    console.log(`\nLeaving scratch files in place for inspection: ${scratchRoot}`);
  }
  console.log(`\n${pass ? 'PASS' : 'FAIL'} - the wizards' error and warning dialogs ${pass ? 'said what was wrong, by full path, and changed nothing they should not.' : 'did not behave as expected, see above.'}`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => {
  console.error('\nTEST ERRORED:', (e && e.message) || e);
  process.exitCode = 1;
});
