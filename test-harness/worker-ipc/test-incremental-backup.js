#!/usr/bin/env node
'use strict';

/**
 * Exercises the "Cumulative (incremental) backup" flow - diff + incremental-copy-files - through the app's REAL
 * worker IPC, no app source touched, no UI clicking. Purely folder-to-folder: unlike worker-ipc/test-merge.js and
 * test-harness/ui, this never touches optical media simulation or the app's shared temp/cache directory (diff and
 * incremental-copy-files only ever read/write the source and target folders they're given), so there's no
 * temp-dir-guard needed here.
 *
 * What this actually proves, in order:
 *   1. A first sync from an empty target copies every source file across, byte-for-byte (verify-manifest.js).
 *   2. After mutating a couple of source files and adding one new one, `diff` reports EXACTLY those 3 changed
 *      paths - not the whole tree again. This is the core "incremental" behavior; asserting the diff result by
 *      exact set (not just "some subset copied correctly") is what actually distinguishes this from "copy
 *      everything every time and happen to get the right answer."
 *   3. A second `incremental-copy-files` call with that diff correctly updates the 2 modified files and adds the
 *      1 new one, and - checked by comparing each target file's mtime before/after - never re-touches any of the
 *      untouched files. Re-copying everything would still pass step 1's hash check; the mtime check is what
 *      actually catches "it just copies the whole tree and ignores the diff".
 *
 * Scope note: the source tree is generated with --no-edge-cases. generate-random-tree.js's built-in empty
 * directory case would also show up in diff's output (the worker's getAllFiles walks an empty directory as a
 * single trailing-backslash "path", not a file - see getAllFiles/insertBranch in worker.ts) alongside the real
 * file paths, which would only complicate this test's exact-set assertions without adding coverage - the
 * zero-byte/unicode/empty-dir edge cases themselves are already covered by test-harness/ui/test-recover-single-disc.js.
 *
 * NOTE: needs a real Windows desktop/window session (see call-worker.js's top comment) - run from your own
 * interactive terminal.
 *
 * Usage:
 *   node test-harness/worker-ipc/test-incremental-backup.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { launchApp, callWorker } = require('./call-worker');
const { MARKER_FILE_NAME } = require('../lib/safety');
const { printTree } = require('../lib/print-tree');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');

// diff() walks the entire source directory, so it correctly reports generate-random-tree.js's own ownership
// marker file as "source-only" too - it genuinely is a real file sitting in the source root. That's harness
// bookkeeping, not test data (verify-manifest.js already excludes it from its own directory listing for the
// same reason), so it's excluded here rather than asserted on.
function excludeMarkerFile(relPaths) {
  return relPaths.filter((p) => path.basename(p) !== MARKER_FILE_NAME);
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** Recursively lists files under `dir`, returning absolute paths. Used here only to snapshot mtimes - actual
 *  content correctness is delegated to verify-manifest.js, which already does this the same way. */
function listFilesRecursive(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...listFilesRecursive(full)); }
    else if (entry.isFile()) { out.push(full); }
  }
  return out;
}

function snapshotMtimes(dir) {
  const snapshot = new Map();
  for (const filePath of listFilesRecursive(dir)) {
    snapshot.set(path.relative(dir, filePath), fs.statSync(filePath).mtimeMs);
  }
  return snapshot;
}

/** Set equality by value, with a readable diff if they don't match. */
function assertSameSet(actualArray, expectedArray, label) {
  const actual = [...new Set(actualArray)].sort();
  const expected = [...new Set(expectedArray)].sort();
  const matches = actual.length === expected.length && actual.every((v, i) => v === expected[i]);
  console.log(`  ${label}: ${matches ? 'MATCH' : 'MISMATCH'} (${actual.length} of ${expected.length} expected)`);
  if (!matches) {
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual  : ${JSON.stringify(actual)}`);
  }
  return matches;
}

async function main() {
  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `incremental-${runId}`);
  const sourceRoot = path.join(scratchRoot, 'source');
  const targetRoot = path.join(scratchRoot, 'target');

  // 1. Generate the initial source tree + manifest (no edge cases - see header comment for why).
  console.log(`Generating test source tree at ${sourceRoot} ...`);
  execFileSync(process.execPath, [
    path.join(__dirname, '../generate-random-tree.js'),
    '--root', sourceRoot,
    '--files', '20',
    '--max-depth', '3',
    '--min-size', '0',
    '--max-size', '50000',
    '--seed', '424242',
    '--no-edge-cases',
  ], { stdio: 'inherit' });
  const manifestPath = `${sourceRoot}.manifest.json`;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log(`\nGenerated ${manifest.fileCount} files, ${manifest.totalSizeBytes.toLocaleString()} bytes total.`);
  printTree(sourceRoot, 'Source tree (before)');

  fs.mkdirSync(targetRoot, { recursive: true }); // must pre-exist - diff/incremental-copy-files never create their own root

  let app, win;
  const results = {};
  try {
    console.log('\nLaunching the app...');
    ({ app, win } = await launchApp());

    // 2. First sync: diff against an empty target should report every source file.
    console.log('\nCalling diff (empty target)...');
    const firstDiff = await callWorker(win, 'diff', { source: sourceRoot, target: targetRoot });
    const expectedAllRelPaths = manifest.files.map((f) => f.relativePath.split('/').join(path.sep));
    results.firstDiffMatchesFullTree = assertSameSet(excludeMarkerFile(firstDiff.res), expectedAllRelPaths, 'diff (empty target) == every source file');

    console.log('Calling incremental-copy-files (first sync)...');
    await callWorker(win, 'incremental-copy-files', { sourceOnlyPaths: excludeMarkerFile(firstDiff.res), source: sourceRoot, target: targetRoot });

    printTree(targetRoot, 'Target tree (after first sync)');
    console.log('\nVerifying first sync against the manifest...');
    try {
      execFileSync(process.execPath, [
        path.join(__dirname, '../verify-manifest.js'),
        '--manifest', manifestPath,
        '--dir', targetRoot,
      ], { stdio: 'inherit' });
      results.firstSyncVerified = true;
    } catch { results.firstSyncVerified = false; }

    const mtimesAfterFirstSync = snapshotMtimes(targetRoot);

    // 3. Mutate: overwrite 2 existing files with different-sized content, and add 1 brand-new file.
    console.log('\nMutating the source tree (2 modified files, 1 new file)...');
    const toModify = manifest.files.slice(0, 2);
    const updatedEntries = [];
    for (const entry of toModify) {
      const relOs = entry.relativePath.split('/').join(path.sep);
      const absPath = path.join(sourceRoot, relOs);
      const newBytes = crypto.randomBytes(entry.sizeBytes + 777); // deliberately different size than before
      fs.writeFileSync(absPath, newBytes);
      updatedEntries.push({ relativePath: entry.relativePath, sizeBytes: newBytes.length, sha256: sha256File(absPath) });
      console.log(`  modified: ${entry.relativePath} (${entry.sizeBytes} -> ${newBytes.length} bytes)`);
    }
    const newFileRel = 'new-file-added-after-first-sync.dat';
    const newFileAbs = path.join(sourceRoot, newFileRel);
    const newFileBytes = crypto.randomBytes(12345);
    fs.writeFileSync(newFileAbs, newFileBytes);
    console.log(`  added   : ${newFileRel} (${newFileBytes.length} bytes)`);
    const newEntry = { relativePath: newFileRel, sizeBytes: newFileBytes.length, sha256: sha256File(newFileAbs) };

    // Build the updated manifest: original files, with the 2 modified entries replaced and the 1 new entry added.
    const updatedByRelPath = new Map(updatedEntries.map((e) => [e.relativePath, e]));
    const updatedManifest = {
      ...manifest,
      files: [...manifest.files.map((f) => updatedByRelPath.get(f.relativePath) || f), newEntry],
    };
    updatedManifest.fileCount = updatedManifest.files.length;
    const updatedManifestPath = path.join(scratchRoot, 'source-updated.manifest.json');
    fs.writeFileSync(updatedManifestPath, JSON.stringify(updatedManifest, null, 2));

    // 4. Second diff: this is the actual point of the test - it must report EXACTLY the 3 changed paths, not
    //    the full tree again.
    console.log('\nCalling diff (after mutation)...');
    const secondDiff = await callWorker(win, 'diff', { source: sourceRoot, target: targetRoot });
    const expectedChangedRelPaths = [...toModify.map((e) => e.relativePath), newFileRel].map((p) => p.split('/').join(path.sep));
    results.secondDiffIsExactlyTheChanges = assertSameSet(excludeMarkerFile(secondDiff.res), expectedChangedRelPaths, 'diff (after mutation) == exactly the changed/new files');

    console.log('Calling incremental-copy-files (second sync)...');
    await callWorker(win, 'incremental-copy-files', { sourceOnlyPaths: excludeMarkerFile(secondDiff.res), source: sourceRoot, target: targetRoot });

    printTree(targetRoot, 'Target tree (after second sync)');
    console.log('\nVerifying second sync against the updated manifest...');
    try {
      execFileSync(process.execPath, [
        path.join(__dirname, '../verify-manifest.js'),
        '--manifest', updatedManifestPath,
        '--dir', targetRoot,
      ], { stdio: 'inherit' });
      results.secondSyncVerified = true;
    } catch { results.secondSyncVerified = false; }

    // 5. The real proof of "incremental": every untouched file's mtime in the target must be UNCHANGED from
    //    after the first sync - re-copying it (even with identical bytes) would still pass step 4's hash check,
    //    so only an mtime comparison actually catches "it copied the whole tree again".
    console.log('\nChecking untouched files were not re-copied (mtime unchanged)...');
    const mtimesAfterSecondSync = snapshotMtimes(targetRoot);
    const changedRelPathsSet = new Set(expectedChangedRelPaths);
    let untouchedOk = true;
    for (const [relPath, mtimeBefore] of mtimesAfterFirstSync) {
      if (changedRelPathsSet.has(relPath)) { continue; }
      const mtimeAfter = mtimesAfterSecondSync.get(relPath);
      if (mtimeAfter !== mtimeBefore) {
        untouchedOk = false;
        console.log(`  RE-COPIED (should not have been touched): ${relPath} (mtime ${mtimeBefore} -> ${mtimeAfter})`);
      }
    }
    results.untouchedFilesNotReCopied = untouchedOk;
    console.log(`  ${untouchedOk ? 'OK' : 'FAILED'} - untouched files ${untouchedOk ? 'were left alone' : 'were re-copied'}.`);

  } finally {
    if (app) { await app.close().catch(() => {}); }
  }

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

  console.log(`\n${pass ? 'PASS' : 'FAIL'} - incremental backup (diff + incremental-copy-files) ${pass ? 'behaved correctly end-to-end.' : 'did not behave as expected, see above.'}`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => {
  console.error('\nTEST ERRORED:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
