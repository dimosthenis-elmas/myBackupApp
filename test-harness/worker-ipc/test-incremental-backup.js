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
 *   4. Empty directories: one that exists (empty) on both sides but with a NEWER mtime in the source is NOT
 *      reported by `diff` (a directory's own mtime says nothing about whether it is backed up), and neither is
 *      one that is empty in the source but has files in the target (it exists there, so it is backed up), while
 *      one that exists only in the source IS reported, and copying it creates it in the target.
 *   5. Edge cases, each in its own small folder pair:
 *      - A source folder whose name contains "$&" and "$$" (special in JavaScript's String.replace replacement
 *        text) plus a Greek file name: only the new file is reported, copied, and a second diff is empty. A file
 *        whose copy in the backup is NEWER, and a file that only exists in the backup, are both left alone.
 *      - A folder renamed in letter case only in the source ("photos" -> "Photos") with one file inside edited:
 *        only the edited file is reported, and it lands in the existing folder (no duplicate). Case-insensitive
 *        filesystems only (NTFS by default) - skipped elsewhere.
 *      - An unreadable entry (a folder Windows denies listing) in the source: with `skipUnreadable` - which is
 *        how the Cumulative backup wizard calls diff - the rest is still compared and one warning lists the
 *        skipped entry by full path; without it, diff fails.
 *      - A file that disappears between diff and the copy makes incremental-copy-files report an error.
 *      - A changed file whose earlier copy in the backup is read-only (a copy of a read-only file is read-only
 *        too, and Windows refuses to copy over one) is replaced with the new version. Synchronize directories
 *        copies through the same incremental-copy-files.
 *
 * Scope note: the source tree is generated with --no-edge-cases. generate-random-tree.js's built-in empty
 * directory case would also show up in diff's output (the worker's getAllFiles walks an empty directory as a
 * single trailing-backslash "path", not a file - see getAllFiles/insertBranch in worker.ts) alongside the real
 * file paths, which would only complicate steps 1-3's exact-set assertions without adding coverage - so empty
 * directories are exercised separately, by step 4's own dedicated ones. The zero-byte/unicode edge cases are
 * covered by test-harness/ui/test-recover-single-disc.js.
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
const { launchApp, callWorker, startRecordingAppErrors, takeAppErrors } = require('./call-worker');
const { MARKER_FILE_NAME } = require('../lib/safety');
const { printTree } = require('../lib/print-tree');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');
const { isCaseInsensitiveFilesystem } = require('../lib/filesystem-case');

/** Writes `text` to `filePath` (creating its folder) and sets its mtime to `minutes` after a fixed base time, so
 *  "newer"/"older" is under this script's control rather than depending on how fast the lines run. */
function writeFileAt(filePath, text, minutes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
  const t = new Date(Date.UTC(2024, 0, 1) + minutes * 60_000);
  fs.utimesSync(filePath, t, t);
}

function readOrNull(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
}

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
    await callWorker(win, 'incremental-copy-files', { sourceOnlyPaths: excludeMarkerFile(firstDiff.res), source: sourceRoot, target: targetRoot, nameClash: 'keep-both' });

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
    await callWorker(win, 'incremental-copy-files', { sourceOnlyPaths: excludeMarkerFile(secondDiff.res), source: sourceRoot, target: targetRoot, nameClash: 'keep-both' });

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

    // 6. Empty directories. The tree is fully in sync at this point, so any diff result now is down to these three.
    //    "empty-dir-in-both" exists empty on both sides, deliberately with a much NEWER mtime in the source: a
    //    directory's own mtime only records when it was created or had entries added/removed, so it must not make
    //    a matching empty directory look modified. "empty-dir-with-files-in-target" is empty in the source but
    //    holds a file in the target - it exists there, so it must not be reported either. "empty-dir-only-in-source"
    //    is genuinely missing from the target, so it MUST still be reported and then created by the copy.
    console.log('\nAdding empty directories (one on both sides with a newer source mtime, one non-empty in the target, one source-only)...');
    const emptyInBothRel = 'empty-dir-in-both';
    const emptyWithFilesInTargetRel = 'empty-dir-with-files-in-target';
    const emptyOnlyInSourceRel = 'empty-dir-only-in-source';
    fs.mkdirSync(path.join(sourceRoot, emptyInBothRel));
    fs.mkdirSync(path.join(targetRoot, emptyInBothRel));
    fs.mkdirSync(path.join(sourceRoot, emptyWithFilesInTargetRel));
    fs.mkdirSync(path.join(targetRoot, emptyWithFilesInTargetRel));
    fs.writeFileSync(path.join(targetRoot, emptyWithFilesInTargetRel, 'target-only-file.txt'), 'only in the target');
    fs.mkdirSync(path.join(sourceRoot, emptyOnlyInSourceRel));
    const older = new Date('2020-01-01T00:00:00Z');
    const newer = new Date('2025-01-01T00:00:00Z');
    fs.utimesSync(path.join(targetRoot, emptyInBothRel), older, older);
    fs.utimesSync(path.join(sourceRoot, emptyInBothRel), newer, newer);

    console.log('Calling diff (empty directories)...');
    const emptyDirsDiff = await callWorker(win, 'diff', { source: sourceRoot, target: targetRoot });
    results.emptyDirDiffIsOnlyTheMissingOne = assertSameSet(excludeMarkerFile(emptyDirsDiff.res), [emptyOnlyInSourceRel + path.sep], 'diff (empty directories) == only the source-only empty directory');

    console.log('Calling incremental-copy-files (empty directories)...');
    await callWorker(win, 'incremental-copy-files', { sourceOnlyPaths: excludeMarkerFile(emptyDirsDiff.res), source: sourceRoot, target: targetRoot, nameClash: 'keep-both' });
    const createdInTarget = path.join(targetRoot, emptyOnlyInSourceRel);
    results.sourceOnlyEmptyDirCreatedInTarget = fs.existsSync(createdInTarget) && fs.statSync(createdInTarget).isDirectory();
    console.log(`  ${results.sourceOnlyEmptyDirCreatedInTarget ? 'OK' : 'FAILED'} - source-only empty directory ${results.sourceOnlyEmptyDirCreatedInTarget ? 'was created in the target' : 'is missing from the target'}.`);

    // 7. Edge cases (see the header comment), each in its own folder pair so the exact-set checks above stay
    //    about the generated tree only.
    const edgeRoot = path.join(scratchRoot, 'edge-cases');
    fs.mkdirSync(edgeRoot, { recursive: true });
    await startRecordingAppErrors(win);

    console.log('\nEdge case: "$&" / "$$" in the source folder name, a Greek file name, a newer copy in the backup, a backup-only file...');
    const dollarSource = path.join(edgeRoot, 'source $& $$ φάκελος');
    const dollarTarget = path.join(edgeRoot, 'target-dollar');
    writeFileAt(path.join(dollarSource, 'αρχείο.txt'), 'new file', 0);
    writeFileAt(path.join(dollarSource, 'backup is newer.txt'), 'older', 0);
    writeFileAt(path.join(dollarTarget, 'backup is newer.txt'), 'NEWER', 30);
    writeFileAt(path.join(dollarTarget, 'only in backup.txt'), 'keep me', 0);
    const dollarDiff = await callWorker(win, 'diff', { source: dollarSource, target: dollarTarget });
    results.dollarSourceDiffIsOnlyTheNewFile = assertSameSet(dollarDiff.res, ['αρχείο.txt'], 'diff ("$&" source folder) == only the new file');
    await callWorker(win, 'incremental-copy-files', { sourceOnlyPaths: dollarDiff.res, source: dollarSource, target: dollarTarget, nameClash: 'keep-both' });
    results.dollarSourceFileCopied = readOrNull(path.join(dollarTarget, 'αρχείο.txt')) === 'new file';
    results.dollarSourceSecondDiffIsEmpty = (await callWorker(win, 'diff', { source: dollarSource, target: dollarTarget })).res.length === 0;
    results.newerBackupCopyAndBackupOnlyFileLeftAlone = readOrNull(path.join(dollarTarget, 'backup is newer.txt')) === 'NEWER'
      && readOrNull(path.join(dollarTarget, 'only in backup.txt')) === 'keep me';
    console.log(`  copied: ${results.dollarSourceFileCopied}, second diff empty: ${results.dollarSourceSecondDiffIsEmpty}, newer/backup-only files left alone: ${results.newerBackupCopyAndBackupOnlyFileLeftAlone}`);

    if (isCaseInsensitiveFilesystem(edgeRoot)) {
      console.log('\nEdge case: a folder renamed in letter case only in the source, with one file inside edited...');
      const caseSource = path.join(edgeRoot, 'source-case');
      const caseTarget = path.join(edgeRoot, 'target-case');
      writeFileAt(path.join(caseSource, 'Photos', 'a.jpg'), 'edited', 10);
      writeFileAt(path.join(caseTarget, 'photos', 'a.jpg'), 'old', 0);
      writeFileAt(path.join(caseSource, 'Photos', 'b.jpg'), 'same', 0);
      writeFileAt(path.join(caseTarget, 'photos', 'b.jpg'), 'same', 0);
      const caseDiff = await callWorker(win, 'diff', { source: caseSource, target: caseTarget });
      results.caseRenamedFolderDiffIsOnlyTheEditedFile = assertSameSet(caseDiff.res, [path.join('Photos', 'a.jpg')], 'diff (case-renamed folder) == only the edited file');
      await callWorker(win, 'incremental-copy-files', { sourceOnlyPaths: caseDiff.res, source: caseSource, target: caseTarget, nameClash: 'keep-both' });
      results.caseRenamedFolderEditLandsInExistingFolder = readOrNull(path.join(caseTarget, 'photos', 'a.jpg')) === 'edited'
        && fs.readdirSync(caseTarget).length === 1;
      console.log(`  edit landed in the existing folder, no duplicate folder: ${results.caseRenamedFolderEditLandsInExistingFolder}`);
    } else {
      console.log('\n(Edge case "folder renamed in letter case only" skipped: this filesystem is case-sensitive.)');
    }

    console.log('\nEdge case: an unreadable entry (a folder Windows denies listing) in the source...');
    const unreadableSource = path.join(edgeRoot, 'source-unreadable');
    const unreadableTarget = path.join(edgeRoot, 'target-unreadable');
    const lockedDir = path.join(unreadableSource, 'locked');
    writeFileAt(path.join(unreadableSource, 'ok.txt'), 'ok', 0);
    writeFileAt(path.join(lockedDir, 'secret.txt'), 's', 0);
    fs.mkdirSync(unreadableTarget, { recursive: true });
    execFileSync('icacls', [lockedDir, '/deny', '*S-1-1-0:(RD)'], { stdio: 'pipe' });
    try {
      await takeAppErrors(win); // start from an empty record
      const skippingDiff = await callWorker(win, 'diff', { source: unreadableSource, target: unreadableTarget, skipUnreadable: true });
      const warnings = await takeAppErrors(win);
      results.unreadableEntrySkippedWhenAsked = assertSameSet(skippingDiff.res, ['ok.txt'], 'diff (skipUnreadable) == the readable file');
      results.unreadableEntryReportedByFullPath = warnings.length === 1 && Array.isArray(warnings[0].lists)
        && warnings[0].lists[0].items.some((item) => item.startsWith(lockedDir));
      console.log(`  exactly one warning, listing the skipped entry by full path: ${results.unreadableEntryReportedByFullPath}`);
      let failedWithoutSkipping = false;
      try { await callWorker(win, 'diff', { source: unreadableSource, target: unreadableTarget }); } catch { failedWithoutSkipping = true; }
      results.unreadableEntryFailsWhenNotAsked = failedWithoutSkipping;
      console.log(`  without skipUnreadable, diff fails: ${failedWithoutSkipping}`);
    } finally {
      execFileSync('icacls', [lockedDir, '/remove:d', '*S-1-1-0'], { stdio: 'pipe' });
    }

    console.log('\nEdge case: a file that disappears between diff and the copy...');
    const vanishSource = path.join(edgeRoot, 'source-vanish');
    const vanishTarget = path.join(edgeRoot, 'target-vanish');
    writeFileAt(path.join(vanishSource, 'will vanish.txt'), 'v', 0);
    fs.mkdirSync(vanishTarget, { recursive: true });
    const vanishDiff = await callWorker(win, 'diff', { source: vanishSource, target: vanishTarget });
    fs.rmSync(path.join(vanishSource, 'will vanish.txt'));
    let copyReportedError = false;
    try { await callWorker(win, 'incremental-copy-files', { sourceOnlyPaths: vanishDiff.res, source: vanishSource, target: vanishTarget, nameClash: 'keep-both' }); } catch { copyReportedError = true; }
    results.vanishedFileMakesCopyReportAnError = copyReportedError;
    console.log(`  the copy reported an error: ${copyReportedError}`);

    console.log('\nEdge case: a changed file whose earlier copy in the backup is read-only...');
    const readOnlySource = path.join(edgeRoot, 'source-read-only');
    const readOnlyTarget = path.join(edgeRoot, 'target-read-only');
    writeFileAt(path.join(readOnlySource, 'form.pdf'), 'version 2, longer', 10);
    writeFileAt(path.join(readOnlyTarget, 'form.pdf'), 'version 1', 0);
    fs.chmodSync(path.join(readOnlyTarget, 'form.pdf'), 0o444); // on Windows this sets the read-only attribute
    const readOnlyDiff = await callWorker(win, 'diff', { source: readOnlySource, target: readOnlyTarget });
    let readOnlyCopyError = null;
    try {
      await callWorker(win, 'incremental-copy-files', { sourceOnlyPaths: readOnlyDiff.res, source: readOnlySource, target: readOnlyTarget, nameClash: 'keep-both' });
    } catch (e) {
      readOnlyCopyError = String(e.message).split('\n')[0];
    }
    results.readOnlyBackupCopyIsReplaced = readOnlyCopyError === null && readOrNull(path.join(readOnlyTarget, 'form.pdf')) === 'version 2, longer';
    console.log(`  the read-only copy was replaced with the new version: ${results.readOnlyBackupCopyIsReplaced}${readOnlyCopyError ? ` (${readOnlyCopyError})` : ''}`);

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
