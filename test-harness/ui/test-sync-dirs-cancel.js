#!/usr/bin/env node
'use strict';

/**
 * Cancel in the "Synchronize directories" wizard, through the REAL app (Playwright clicks), at the three moments it
 * can be pressed. Each scenario gets a fresh app and a fresh folder pair: a source with SOURCE_FILE_COUNT files the
 * target lacks (so the copy phase takes a few seconds), and a target with LEFTOVER_COUNT files the source lacks
 * (what the delete phase would remove).
 *
 *   1. "Cancel" on the warning shown before anything is compared: the wizard just stops - no error dialog, and
 *      the folders are untouched.
 *   2. "Cancel" pressed immediately after "Yes, continue" - before the commit has had time to start: it must still
 *      stop it. The Cancel button appears as soon as the confirmation closes, while the commit starts a moment
 *      later; a Cancel pressed in between used to be ignored, and the whole sync - deletions included - ran anyway.
 *   3. "Cancel" pressed while files are being copied: the copy stops, and the deletions must never start. That
 *      used to end in "Directory synchronization failed" with the "Stopping the synchronization" dialog left open
 *      for good.
 *
 * In 2 and 3 the wizard must show "Directory synchronization has stopped", close its "Stopping the
 * synchronization" dialog, show no error, no longer show its Cancel button, and every leftover file must still be
 * in the target. (In 3, if this
 * machine happened to copy everything before Cancel landed, the deletions could legitimately have started - the
 * leftover check is then skipped, and said so.)
 *
 * All folders are fresh ones under test-harness/generated-fixtures/.
 *
 * NOTE: needs a real Windows desktop/window session (see worker-ipc/call-worker.js's top comment) - run from your
 * own interactive terminal.
 *
 * Usage:
 *   node test-harness/ui/test-sync-dirs-cancel.js
 */

const fs = require('fs');
const path = require('path');
const { launchApp } = require('../worker-ipc/call-worker');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');

const SOURCE_FILE_COUNT = 3000;
const LEFTOVER_COUNT = 25;
const WATCH_PAUSE_MS = 1000;

async function clickMainMenuButton(win, labelText) {
  const container = win.locator('.grid-container > div').filter({ has: win.locator('h2', { hasText: labelText }) });
  await container.locator('button').click();
}

function makePair(root) {
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  const chunk = Buffer.alloc(4096, 7);
  for (let i = 0; i < SOURCE_FILE_COUNT; i++) {
    const dir = path.join(source, `folder-${Math.floor(i / 300)}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `file-${i}.bin`), chunk);
  }
  fs.mkdirSync(target, { recursive: true });
  for (let i = 0; i < LEFTOVER_COUNT; i++) { fs.writeFileSync(path.join(target, `leftover-${i}.txt`), `leftover ${i}`); }
  return { source, target };
}

function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
  }
  return n;
}

const leftoversPresent = (target) => Array.from({ length: LEFTOVER_COUNT }, (_, i) => fs.existsSync(path.join(target, `leftover-${i}.txt`))).filter(Boolean).length;
const copiedCount = (target) => countFiles(target) - leftoversPresent(target);

async function runScenario(name, runId, results) {
  const root = path.join(FIXTURES_ROOT, `ui-sync-cancel-${runId}`, name);
  console.log(`\n=== ${name}: generating ${SOURCE_FILE_COUNT} source files and ${LEFTOVER_COUNT} leftovers in the target...`);
  const { source, target } = makePair(root);
  let app, win;
  const step = async (label, fn, pause = true) => {
    process.stdout.write(`  [ ] ${label} ... `);
    try {
      await fn();
    } catch (e) {
      console.log('FAILED');
      const screenshotPath = path.join(FIXTURES_ROOT, `optical-backup-ui-sync-cancel-${name}-${runId}.png`);
      try { await win.screenshot({ path: screenshotPath }); console.log(`  Screenshot saved to: ${screenshotPath}`); } catch { /* window gone */ }
      throw e;
    }
    console.log('done');
    if (pause) { await new Promise((r) => setTimeout(r, WATCH_PAUSE_MS)); }
  };
  try {
    ({ app, win } = await launchApp());
    await app.evaluate(({ dialog }, paths) => {
      const queue = [...paths];
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [queue.shift()] });
    }, [source, target]);

    await step('main menu -> Synchronize directories', () => clickMainMenuButton(win, 'Synchronize directories'));
    await step('pick the template folder', () => win.getByRole('button', { name: 'Path to the template directory' }).click({ timeout: 15_000 }));
    await step('pick the folder to be synchronized', () => win.getByRole('button', { name: 'Path to the directory to be synchronized with the template' }).click({ timeout: 15_000 }));
    await step('wait for both paths on screen', () => win.getByText(target, { exact: true }).waitFor({ timeout: 10_000 }));
    await step('click "Next"', () => win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 }));

    if (name === 'cancel-on-the-warning') {
      await step('click "Cancel" on the warning', () =>
        win.getByRole('dialog').filter({ hasText: 'Warning' }).getByRole('button', { name: 'Cancel', exact: true }).click({ timeout: 15_000 }));
      await new Promise((r) => setTimeout(r, 2000));
      results[`${name}: no dialog is left open (in particular no error)`] = (await win.getByRole('dialog').count()) === 0;
      results[`${name}: the wizard is still usable ("Next" is back)`] = await win.getByRole('button', { name: 'Next', exact: true }).isVisible();
      results[`${name}: nothing copied or deleted`] = copiedCount(target) === 0 && leftoversPresent(target) === LEFTOVER_COUNT;
      return;
    }

    await step('click "Continue" on the warning', () => win.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 15_000 }));
    await step('wait for the preview to finish (up to 180s)', () =>
      win.getByRole('button', { name: 'Write to the backup' }).click({ timeout: 180_000, trial: true }));
    await step('click "Write to the backup"', () => win.getByRole('button', { name: 'Write to the backup' }).click({ timeout: 15_000 }));

    const cancelButton = win.locator('sync-dirs').getByRole('button', { name: 'Cancel', exact: true });
    if (name === 'cancel-before-the-commit-starts') {
      await step('click "Yes, continue"', () => win.getByRole('button', { name: 'Yes, continue', exact: true }).click({ timeout: 15_000 }), false);
      await step('click "Cancel" straight away', () => cancelButton.click({ timeout: 5_000 }), false);
    } else {
      await step('click "Yes, continue"', () => win.getByRole('button', { name: 'Yes, continue', exact: true }).click({ timeout: 15_000 }), false);
      await step('wait until the copy has started (a "copied file" line in the log)', () =>
        win.locator('sync-dirs .example-item').filter({ hasText: 'copied file' }).first().waitFor({ timeout: 60_000 }), false);
      await step('click "Cancel" while files are being copied', () => cancelButton.click({ timeout: 5_000 }), false);
    }

    await step('wait for "Directory synchronization has stopped" (up to 60s)', () =>
      win.getByRole('dialog').filter({ hasText: 'Directory synchronization has stopped' }).waitFor({ timeout: 60_000 }));
    results[`${name}: no "Directory synchronization failed" and no error dialog`] =
      (await win.getByText('Directory synchronization failed').count()) === 0 && (await win.getByText('Something unexpected went wrong').count()) === 0;
    results[`${name}: the "Stopping the synchronization" dialog is closed`] = (await win.getByText('Stopping the synchronization').count()) === 0;
    await step('click "Ok"', () => win.getByRole('dialog').filter({ hasText: 'Directory synchronization has stopped' }).getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 }));
    results[`${name}: the Cancel button is gone once the sync has stopped`] = (await cancelButton.count()) === 0;

    // Give anything that might still (wrongly) be running time to show on disk before looking.
    await new Promise((r) => setTimeout(r, 3000));
    const copied = copiedCount(target);
    const leftovers = leftoversPresent(target);
    console.log(`  after Cancel: ${copied} of ${SOURCE_FILE_COUNT} files copied, ${leftovers} of ${LEFTOVER_COUNT} leftovers still in the target`);
    if (name === 'cancel-during-the-copy' && copied === SOURCE_FILE_COUNT) {
      console.log('  (every file was already copied when Cancel landed - the deletions may legitimately have started, so the leftover check is skipped)');
    } else {
      results[`${name}: no leftover file was deleted after Cancel`] = leftovers === LEFTOVER_COUNT;
    }
    if (name === 'cancel-during-the-copy') { results[`${name}: the copy stopped part-way`] = copied < SOURCE_FILE_COUNT; }
  } finally {
    if (app) { await app.close().catch(() => {}); }
  }
}

async function main() {
  const runId = Date.now();
  const results = {};
  for (const scenario of ['cancel-on-the-warning', 'cancel-before-the-commit-starts', 'cancel-during-the-copy']) {
    await runScenario(scenario, runId, results);
  }

  const pass = Object.keys(results).length > 0 && Object.values(results).every(Boolean);
  console.log('\nSummary:');
  for (const [check, ok] of Object.entries(results)) { console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${check}`); }
  const scratch = path.join(FIXTURES_ROOT, `ui-sync-cancel-${runId}`);
  if (pass) {
    fs.rmSync(scratch, { recursive: true, force: true });
  } else {
    console.log(`\nLeaving scratch files in place for inspection: ${scratch}`);
  }
  console.log(`\n${pass ? 'PASS' : 'FAIL'} - Cancel in Synchronize directories ${pass ? 'stopped cleanly every time and never deleted anything after it was pressed.' : 'did not behave as expected, see above.'}`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => {
  console.error('\nTEST ERRORED:', (e && e.message) || e);
  process.exitCode = 1;
});
