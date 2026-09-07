#!/usr/bin/env node
'use strict';

/**
 * End-to-end test of the "Synchronize directories" UI wizard (main menu -> Synchronize directories -> pick
 * template/target folders -> Next -> warning -> preview -> confirm -> commit -> success) by driving the REAL app
 * through Playwright - actual clicks on actual screens. See worker-ipc/test-sync-dirs.js for the same flow
 * driven directly over IPC instead, including the deep "is this really deleting/keeping the right things"
 * assertions - this script's job is proving the SCREEN itself (buttons, dialogs, the disabled-until-preview-
 * finishes proceed button) wires up to that already-proven engine correctly, not re-proving the engine.
 *
 * Also asserts something the final-state manifest check (below) can't: that the rendered log list (both the
 * preview dialog's own copy and the inline one shown during the real commit) always lists every "add" (copy/
 * create) line before any "delete" line, never interleaved - see checkAddsBeforeDeletes. sync-dirs.component.ts
 * only ever starts the delete phase after fully awaiting the copy phase, specifically to guarantee this; a
 * regression that broke that (e.g. running both phases concurrently) would still leave the final directory
 * contents correct, so only a check on the log's own order - not just the end result - would catch it.
 *
 * ============================================================================================================
 * SAFETY - this is the one UI test that can genuinely delete real files, same reason as worker-ipc/test-sync-dirs.js
 * ============================================================================================================
 * What IS directly relevant here:
 *  - `targetRoot` is always a fresh folder this script creates under test-harness/generated-fixtures/ (see
 *    lib/fixtures-root.js) - no CLI flag accepts an external path.
 *  - The wizard's own design already enforces preview-before-commit (the "Write to the backup" proceed button
 *    starts DISABLED until the preview stream finishes, and nothing is deleted/copied for real until the
 *    separate "Yes, continue" confirmation after that) - this script adds one more explicit check on top: it
 *    asserts, on disk, that the planted leftover files are STILL PRESENT right after the preview dialog appears
 *    and before "Yes, continue" is ever clicked.
 *  - The files that get deleted are a small, explicit, hand-picked set this script plants itself (not anything
 *    computed/sweeping) - same two "leftover" files as worker-ipc/test-sync-dirs.js uses.
 *
 * NOTE: needs a real Windows desktop/window session (see worker-ipc/call-worker.js's top comment) - run from
 * your own interactive terminal.
 *
 * Usage:
 *   node test-harness/ui/test-sync-dirs.js [--random-tree | --json-tree]
 * See lib/fixture-tree-source.js for what step 1's source tree generation flags do - --json-tree uses this
 * script's own bundled example under ui/tree-specs/test-sync-dirs/tree-spec.json.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { launchApp } = require('../worker-ipc/call-worker');
const { printTree } = require('../lib/print-tree');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');
const { generateFixtureTree } = require('../lib/fixture-tree-source');

const SPEC_DIR = path.join(__dirname, 'tree-specs', 'test-sync-dirs');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** Classifies each rendered log line (as shown by app-scrollable-list, in DOM/arrival order - see that
 *  component's own MyDataSource, which never reorders anything, only ever appends) as "add" (a copy/create
 *  operation - see the exact wording insertBranch in worker.ts pushes) or "delete" (see
 *  insertBranchForDirSyncDeletions's own wording), then checks that every add line comes before every delete
 *  line - the guarantee sync-dirs.component.ts is supposed to provide by always fully awaiting the copy phase
 *  before ever starting the delete phase. Returns enough detail to print a useful failure message, not just a
 *  bare true/false. */
function checkAddsBeforeDeletes(lines) {
  // Matches both the preview wording (insertBranch/insertBranchForDirSyncDeletions with doCopy/commit=false -
  // "will copy file", "will update existing file", "will delete file", "will delete directory") and the real
  // commit wording (doCopy/commit=true - "copied file", "updated existing file", "deleted file", "deleted
  // directory") - the verb stem is the same either way, only the tense/prefix differs.
  const addPattern = /cop(?:y|ied) file|updat(?:e|ed) existing file|creat(?:e|ed) directory/i;
  const deletePattern = /delet(?:e|ed) (?:file|directory)/i;
  const addLines = [];
  const deleteLines = [];
  let lastAddIndex = -1;
  let firstDeleteIndex = -1;
  lines.forEach((line, i) => {
    if (deletePattern.test(line)) {
      deleteLines.push(line);
      if (firstDeleteIndex === -1) { firstDeleteIndex = i; }
    } else if (addPattern.test(line)) {
      addLines.push(line);
      lastAddIndex = i;
    }
  });
  const ok = addLines.length > 0 && deleteLines.length > 0 && lastAddIndex < firstDeleteIndex;
  return { ok, addLines, deleteLines, lastAddIndex, firstDeleteIndex };
}

async function clickMainMenuButton(win, labelText) {
  const container = win.locator('.grid-container > div').filter({ has: win.locator('h2', { hasText: labelText }) });
  await container.locator('button').click();
}

async function main() {
  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `ui-sync-dirs-${runId}`);
  const sourceRoot = path.join(scratchRoot, 'source');
  const targetRoot = path.join(scratchRoot, 'target');

  // 1. Generate the source tree, then establish a baseline where target already exactly mirrors it (a plain
  //    recursive filesystem copy - not through the app - since the point of THIS test is the sync-dirs SCREEN,
  //    not re-proving the copy engine, which worker-ipc/test-incremental-backup.js already covers thoroughly).
  generateFixtureTree({
    root: sourceRoot,
    randomArgs: ['--files', '15', '--max-depth', '2', '--min-size', '0', '--max-size', '20000', '--seed', '246810', '--no-edge-cases'],
    specDir: SPEC_DIR,
  });
  const manifestPath = `${sourceRoot}.manifest.json`;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log(`\nGenerated ${manifest.fileCount} files, ${manifest.totalSizeBytes.toLocaleString()} bytes total.`);

  console.log('Establishing baseline (target = copy of source)...');
  fs.cpSync(sourceRoot, targetRoot, { recursive: true });

  // 2. Diverge: modify+add on the source side (should end up copied), plant two deliberate leftovers directly in
  //    the target side that don't exist in source at all (should end up deleted) - one inside an existing,
  //    otherwise non-empty subdirectory (only the file should disappear), one alone in a brand-new subdirectory
  //    (the now-empty directory should ALSO get cleaned up).
  console.log('\nDiverging: modifying/adding on the source side...');
  const toModify = manifest.files[0];
  const modifyRelOs = toModify.relativePath.split('/').join(path.sep);
  fs.writeFileSync(path.join(sourceRoot, modifyRelOs), crypto.randomBytes(toModify.sizeBytes + 555));
  console.log(`  modified (source): ${toModify.relativePath}`);
  const newSourceFileRel = 'new-file-added-to-source.dat';
  fs.writeFileSync(path.join(sourceRoot, newSourceFileRel), crypto.randomBytes(9000));
  console.log(`  added (source)   : ${newSourceFileRel}`);

  console.log('Planting leftovers directly in the target side (should be deleted)...');
  const existingTargetSubdir = path.dirname(manifest.files.find((f) => f.relativePath.includes('/'))?.relativePath || '');
  const leftoverInExistingDirRel = existingTargetSubdir && existingTargetSubdir !== '.'
    ? path.join(existingTargetSubdir, 'leftover-in-existing-dir.dat')
    : 'leftover-in-existing-dir.dat';
  fs.mkdirSync(path.dirname(path.join(targetRoot, leftoverInExistingDirRel)), { recursive: true });
  fs.writeFileSync(path.join(targetRoot, leftoverInExistingDirRel), crypto.randomBytes(4321));
  console.log(`  leftover file          : ${leftoverInExistingDirRel}`);
  const leftoverAloneDirRel = path.join('leftover-only-dir', 'leftover-alone.dat');
  fs.mkdirSync(path.join(targetRoot, 'leftover-only-dir'), { recursive: true });
  fs.writeFileSync(path.join(targetRoot, leftoverAloneDirRel), crypto.randomBytes(1234));
  console.log(`  leftover file+empty dir: ${leftoverAloneDirRel}`);

  printTree(sourceRoot, 'Source tree (before sync)');
  printTree(targetRoot, 'Target tree (before sync - includes the planted leftovers)');

  const results = {};
  let app, win;
  try {
    // 3. Launch the app and stub the native folder-picker: first call (template directory) returns sourceRoot,
    //    second call (directory to be synchronized) returns targetRoot.
    console.log('\nLaunching the app...');
    ({ app, win } = await launchApp());
    await app.evaluate(({ dialog }, paths) => {
      const queue = [...paths];
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [queue.shift()] });
    }, [sourceRoot, targetRoot]);

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
        const screenshotPath = path.join(FIXTURES_ROOT, `optical-backup-ui-sync-dirs-test-failure-${runId}.png`);
        try {
          await win.screenshot({ path: screenshotPath });
          console.log(`  Screenshot of the app at the point of failure saved to: ${screenshotPath}`);
        } catch { /* app/window may already be gone */ }
        throw e;
      }
      console.log('done');
      await new Promise((r) => setTimeout(r, WATCH_PAUSE_MS));
    };

    await step('main menu -> Synchronize directories', () =>
      clickMainMenuButton(win, 'Synchronize directories'));

    await step('click "Path to the template directory"', () =>
      win.getByRole('button', { name: 'Path to the template directory' }).click({ timeout: 15_000 }));

    await step('wait for the chosen template (source) path to appear on screen', () =>
      win.getByText(sourceRoot, { exact: true }).waitFor({ timeout: 10_000 }));

    await step('click "Path to the directory to be synchronized with the template"', () =>
      win.getByRole('button', { name: 'Path to the directory to be synchronized with the template' }).click({ timeout: 15_000 }));

    await step('wait for the chosen target path to appear on screen', () =>
      win.getByText(targetRoot, { exact: true }).waitFor({ timeout: 10_000 }));

    await step('click "Next"', () =>
      win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 }));

    await step('click "Continue" on the destructive-operation warning', () =>
      win.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 15_000 }));

    // Safety check: the preview dialog is now open (or opening) and nothing should have been deleted yet -
    // confirmed on disk BEFORE the confirmation click below, not just assumed from the app's own UI state.
    await step('wait for the preview dialog, verify nothing deleted yet', async () => {
      await win.getByText('Preview', { exact: true }).waitFor({ timeout: 15_000 });
      const stillThere = fs.existsSync(path.join(targetRoot, leftoverInExistingDirRel)) &&
        fs.existsSync(path.join(targetRoot, leftoverAloneDirRel));
      if (!stillThere) { throw new Error('Leftover files were removed from disk before any commit confirmation - aborting.'); }
    });

    // {trial: true} runs every actionability check (visible, enabled, stable, receives events) WITHOUT
    // actually clicking - so this waits for the preview to finish (the button starts disabled until then)
    // while leaving the preview dialog open long enough to read its log list, below.
    await step('wait for preview to finish (up to 30s)', () =>
      win.getByRole('button', { name: 'Write to the backup' }).click({ timeout: 30_000, trial: true }));

    await step('verify the preview log lists every "add" line before any "delete" line', async () => {
      const lines = await win.locator('app-incremental-dialog .example-item').allTextContents();
      const check = checkAddsBeforeDeletes(lines);
      console.log(`  ${check.addLines.length} add line(s), ${check.deleteLines.length} delete line(s)`);
      if (!check.ok) { console.log(`  lines seen (in order): ${JSON.stringify(lines)}`); }
      results.previewLogAddsBeforeDeletes = check.ok;
    });

    await step('click "Write to the backup"', () =>
      win.getByRole('button', { name: 'Write to the backup' }).click({ timeout: 15_000 }));

    await step('click "Yes, continue" on the sync confirmation', () =>
      win.getByRole('button', { name: 'Yes, continue', exact: true }).click({ timeout: 15_000 }));

    await step('wait for the sync to finish, click "Ok" on "Directory synchronization completed successfully" (up to 60s)', () =>
      win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 60_000 }));

    // The commit phase's own log list is rendered inline on the sync-dirs screen itself (not inside a dialog -
    // see showCommitedOperationsLogs in sync-dirs.component.html), and stays on screen after the "completed
    // successfully" dialog above is dismissed, so it's still readable here.
    await step('verify the commit log lists every "add" line before any "delete" line', async () => {
      const lines = await win.locator('sync-dirs .example-item').allTextContents();
      const check = checkAddsBeforeDeletes(lines);
      console.log(`  ${check.addLines.length} add line(s), ${check.deleteLines.length} delete line(s)`);
      if (!check.ok) { console.log(`  lines seen (in order): ${JSON.stringify(lines)}`); }
      results.commitLogAddsBeforeDeletes = check.ok;
    });

    console.log('Wizard completed.');
  } finally {
    if (app) { await app.close().catch(() => {}); }
  }

  // 4. Verify: target must now be an EXACT match for source's final state - byte-for-byte AND with zero extras.
  //    verify-manifest.js's own EXTRA detection is what actually proves the leftovers are gone.
  printTree(targetRoot, 'Target tree (after sync)');
  console.log('\nVerifying target now matches source exactly (rebuilt manifest, includes EXTRA detection)...');
  const finalManifest = {
    ...manifest,
    files: [
      ...manifest.files.filter((f) => f.relativePath !== toModify.relativePath),
      { relativePath: toModify.relativePath, sizeBytes: fs.statSync(path.join(sourceRoot, modifyRelOs)).size, sha256: sha256File(path.join(sourceRoot, modifyRelOs)) },
      { relativePath: newSourceFileRel, sizeBytes: fs.statSync(path.join(sourceRoot, newSourceFileRel)).size, sha256: sha256File(path.join(sourceRoot, newSourceFileRel)) },
    ],
  };
  finalManifest.fileCount = finalManifest.files.length;
  const finalManifestPath = path.join(scratchRoot, 'source-final.manifest.json');
  fs.writeFileSync(finalManifestPath, JSON.stringify(finalManifest, null, 2));
  try {
    execFileSync(process.execPath, [
      path.join(__dirname, '../verify-manifest.js'),
      '--manifest', finalManifestPath,
      '--dir', targetRoot,
    ], { stdio: 'inherit' });
    results.targetMatchesSourceExactly = true;
  } catch { results.targetMatchesSourceExactly = false; }

  results.leftoversActuallyDeleted =
    !fs.existsSync(path.join(targetRoot, leftoverInExistingDirRel)) &&
    !fs.existsSync(path.join(targetRoot, leftoverAloneDirRel)) &&
    !fs.existsSync(path.join(targetRoot, 'leftover-only-dir'));
  console.log(`Leftovers actually deleted (file + now-empty dir): ${results.leftoversActuallyDeleted}`);

  const pass = Object.values(results).every(Boolean);

  console.log('\nSummary:');
  for (const [check, ok] of Object.entries(results)) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${check}`);
  }

  if (pass) {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  } else {
    console.log(`\nLeaving scratch files in place for inspection: ${scratchRoot}`);
  }

  console.log(`\n${pass ? 'PASS' : 'FAIL'} - Synchronize directories wizard ${pass ? 'correctly synced (copied + deleted) everything.' : 'did not produce a correct result, see above.'}`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => {
  const message = (e && e.message) || String(e);
  const fullDetail = (e && e.stack) ? e.stack : message;
  if (/closed|Target .*(closed|crashed)/i.test(message)) {
    console.error(`\nTEST ERRORED: the app window was closed before the test finished (${message}).`);
  } else {
    const logPath = path.join(FIXTURES_ROOT, `optical-backup-ui-sync-dirs-test-error-${Date.now()}.log`);
    try { fs.writeFileSync(logPath, fullDetail); } catch { /* best effort */ }
    console.error(`\nTEST ERRORED: ${message}`);
    console.error(`Full details saved to: ${logPath}`);
  }
  process.exitCode = 1;
});
