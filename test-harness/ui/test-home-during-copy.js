#!/usr/bin/env node
'use strict';

/**
 * The toolbar's Home button while Cumulative backup is copying, through the REAL app (Playwright clicks). Home goes
 * back to the main menu - the app reloads - and must stop the copy on its way: a moment later nothing more is being
 * copied, part of the files are in the backup folder, and no temporary copy is left there. The reloaded app must work
 * as usual: no error dialog - in particular not "the previous command has not finished", which a copy still running in
 * the background would cause - and a comparison started right away finishes.
 *
 * The source is SOURCE_FILE_COUNT small files, so the copy takes a while; the backup folder starts empty. All folders
 * are fresh ones under test-harness/generated-fixtures/.
 *
 * NOTE: needs a real Windows desktop/window session (see worker-ipc/call-worker.js's top comment) - run from your
 * own interactive terminal.
 *
 * Usage:
 *   node test-harness/ui/test-home-during-copy.js
 */

const fs = require('fs');
const path = require('path');
const { launchApp } = require('../worker-ipc/call-worker');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');

const SOURCE_FILE_COUNT = 6000;
const WATCH_PAUSE_MS = 1000;

async function clickMainMenuButton(win, labelText) {
  const container = win.locator('.grid-container > div').filter({ has: win.locator('h2', { hasText: labelText }) });
  await container.locator('button').click({ timeout: 15_000 });
}

function makeSource(source) {
  const chunk = Buffer.alloc(4096, 7);
  for (let i = 0; i < SOURCE_FILE_COUNT; i++) {
    const dir = path.join(source, `folder-${Math.floor(i / 300)}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `file-${i}.bin`), chunk);
  }
}

/** The files under `dir`, as full paths. */
function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
}

async function main() {
  const runId = Date.now();
  const scratch = path.join(FIXTURES_ROOT, `ui-home-during-copy-${runId}`);
  const source = path.join(scratch, 'source');
  const target = path.join(scratch, 'backup');
  console.log(`Generating ${SOURCE_FILE_COUNT} source files...`);
  makeSource(source);
  fs.mkdirSync(target, { recursive: true });

  const results = {};
  let app, win;
  const step = async (label, fn, pause = true) => {
    process.stdout.write(`  [ ] ${label} ... `);
    try {
      await fn();
    } catch (e) {
      console.log('FAILED');
      const screenshotPath = path.join(FIXTURES_ROOT, `ui-home-during-copy-${runId}.png`);
      try { await win.screenshot({ path: screenshotPath }); console.log(`  Screenshot saved to: ${screenshotPath}`); } catch { /* window gone */ }
      throw e;
    }
    console.log('done');
    if (pause) { await new Promise((r) => setTimeout(r, WATCH_PAUSE_MS)); }
  };
  const chooseFoldersAndCompare = async () => {
    await step('main menu -> Cumulative backup', () => clickMainMenuButton(win, 'Cumulative backup'));
    await step('click "Source directory path"', () => win.getByRole('button', { name: 'Source directory path' }).click({ timeout: 15_000 }));
    await step('click "Backup directory path"', () => win.getByRole('button', { name: 'Backup directory path' }).click({ timeout: 15_000 }));
    await step('wait for both paths on screen', () => win.getByText(target, { exact: true }).waitFor({ timeout: 10_000 }));
    await step('click "Next" - compare the folders', () => win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 }));
    // Files to tick - or, once everything is copied, "The backup is up to date".
    await step('wait for the comparison to finish (up to 60s)', () =>
      win.getByRole('checkbox', { name: 'Select all' }).or(win.getByText('The backup is up to date')).first().waitFor({ timeout: 60_000 }));
  };
  const openDialogs = async () => win.getByRole('dialog').allTextContents();

  try {
    ({ app, win } = await launchApp());
    // Two rounds of folder choices: before Home and after it.
    await app.evaluate(({ dialog }, paths) => {
      const queue = [...paths];
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [queue.shift()] });
    }, [source, target, source, target]);

    await chooseFoldersAndCompare();
    await step('click "Select all"', () => win.getByRole('checkbox', { name: 'Select all' }).click({ timeout: 15_000 }));
    await step('click "Next" - preview', () => win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 }));
    await step('click "Write to the backup"', () => win.getByRole('button', { name: 'Write to the backup' }).click({ timeout: 60_000 }));
    await step('click "Yes"', () => win.getByRole('button', { name: 'Yes', exact: true }).click({ timeout: 15_000 }), false);
    await step('wait until files are being copied (a "copied file" line in the log)', () =>
      win.locator('app-incremental-copying').getByText('copied file').first().waitFor({ timeout: 60_000 }), false);
    await step('click Home in the toolbar', () => win.getByRole('button', { name: 'Home', exact: true }).click({ timeout: 5_000 }), false);
    await step('wait for the main menu', () =>
      win.locator('.grid-container h2', { hasText: 'Cumulative backup' }).waitFor({ timeout: 30_000 }));

    // The copy may take a moment to notice; then nothing more may arrive in the backup folder.
    await new Promise((r) => setTimeout(r, 3000));
    const copiedSoon = listFiles(target).length;
    await new Promise((r) => setTimeout(r, 4000));
    const files = listFiles(target);
    console.log(`  copied: ${copiedSoon} files 3 s after the main menu showed, ${files.length} of ${SOURCE_FILE_COUNT} 4 s later`);
    results['the copy stopped: nothing more copied after Home'] = files.length === copiedSoon;
    results['the copy stopped part-way'] = files.length < SOURCE_FILE_COUNT;
    results['no temporary copy is left in the backup folder'] = !files.some((f) => /~my-backup-copy-[0-9a-f]+\.tmp$/i.test(path.basename(f)));
    const dialogsAfterHome = await openDialogs();
    if (dialogsAfterHome.length > 0) { console.log(`  dialogs open after Home: ${JSON.stringify(dialogsAfterHome)}`); }
    results['no dialog (in particular no error) after Home'] = dialogsAfterHome.length === 0;

    if (dialogsAfterHome.length === 0) {
      console.log('\nThe reloaded app: compare the same folders again...');
      await chooseFoldersAndCompare();
      const dialogsAfterComparing = await openDialogs();
      if (dialogsAfterComparing.length > 0) { console.log(`  dialogs open after comparing: ${JSON.stringify(dialogsAfterComparing)}`); }
      results['the reloaded app compares the folders without an error dialog'] = dialogsAfterComparing.length === 0;
    }
  } finally {
    if (app) { await app.close().catch(() => {}); }
  }

  const pass = Object.keys(results).length > 0 && Object.values(results).every(Boolean);
  console.log('\nSummary:');
  for (const [check, ok] of Object.entries(results)) { console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${check}`); }
  if (pass) {
    fs.rmSync(scratch, { recursive: true, force: true });
  } else {
    console.log(`\nLeaving scratch files in place for inspection: ${scratch}`);
  }
  console.log(`\n${pass ? 'PASS' : 'FAIL'} - Home during a Cumulative backup copy ${pass ? 'stopped the copy, and the app went on working.' : 'did not behave as expected, see above.'}`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => {
  console.error('\nTEST ERRORED:', (e && e.message) || e);
  process.exitCode = 1;
});
