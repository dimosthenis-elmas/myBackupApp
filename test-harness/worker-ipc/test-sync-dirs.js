#!/usr/bin/env node
'use strict';

/**
 * Exercises the "Synchronize directories" flow - diff (both directions) + incremental-copy-files +
 * delete-files-and-dirs-for-dir-sync - through the app's REAL worker IPC, no app source touched, no UI clicking.
 * Reproduces the exact same algorithm src/app/sync-dirs/sync-dirs.component.ts uses (see its syncDirs() and
 * commitAllSyncOperations()): copyPaths = diff(source, target); deletePaths = diff(target, source) with any
 * overlap with copyPaths removed (those are modified files - handled by copy, never delete+recreate); then copy
 * copyPaths, then delete deletePaths.
 *
 * ============================================================================================================
 * SAFETY - this is the one test-harness script that can genuinely delete real files, so read this before editing
 * ============================================================================================================
 * WorkerCommunicator.deleteFilesAndDirsForDirSync's second parameter is `commit` - false previews the operation
 * only (nothing is touched on disk), true actually performs the deletions - sent over IPC as `{ commit: ... }`
 * and passed straight through, unmodified, into worker.ts's own `commit` parameter, which gates
 * fs.unlinkSync/fs.rmdirSync directly. (This used to be named `previewOnly` here, with the opposite sense and no
 * inversion anywhere in the pipeline - a landmine that happened to not matter only because every real call site
 * already passed values as if it were `commit`. Fixed by renaming the parameter to match what it actually does.)
 * This script still names its own constants after what they DO rather than passing a bare `true`/`false` - that
 * costs nothing and keeps the intent obvious at each call site below.
 *
 * Additional guardrails specific to this script (on top of the usual generate-random-tree.js safety model):
 *  - `targetRoot` is never anything other than a fresh folder this script itself creates under the OS temp dir -
 *    no CLI flag accepts an external path, so there is no path-injection surface at all.
 *  - `assertPathIsWithin` is called immediately before the one call that can actually delete something, and
 *    throws (refusing to proceed) if `targetRoot` somehow were not inside this script's own scratch root -
 *    defense in depth even though the path above already can't be attacker/user-controlled.
 *  - The delete-preview call (commit=false) is always made FIRST, with an explicit assertion that nothing was
 *    actually removed from disk, before the real commit=true call is ever reached.
 *  - The files this script lets get deleted are a small, explicit, hand-picked set it planted itself (not
 *    anything computed/sweeping) - see "leftover" below.
 *
 * NOTE: needs a real Windows desktop/window session (see call-worker.js's top comment) - run from your own
 * interactive terminal.
 *
 * Usage:
 *   node test-harness/worker-ipc/test-sync-dirs.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { launchApp, callWorker } = require('./call-worker');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');
const { MARKER_FILE_NAME } = require('../lib/safety');
const { printTree } = require('../lib/print-tree');

// See the SAFETY block above. Named after what they DO rather than passed as a bare true/false, so intent stays
// obvious at each deleteFilesAndDirsForDirSync call site in this file.
const DELETE_PARAM_THAT_ACTUALLY_PREVIEWS_ONLY = false;
const DELETE_PARAM_THAT_ACTUALLY_COMMITS_DELETIONS = true;

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function excludeMarkerFile(relPaths) {
  return relPaths.filter((p) => path.basename(p) !== MARKER_FILE_NAME);
}

/** Throws if `childPath` is not (resolved) inside `parentDir` - the guard the SAFETY block above promises right
 *  before the one call in this script that can actually delete something. */
function assertPathIsWithin(childPath, parentDir, label) {
  const resolvedChild = path.resolve(childPath);
  const resolvedParent = path.resolve(parentDir) + path.sep;
  if (!resolvedChild.startsWith(resolvedParent)) {
    throw new Error(`Refusing to proceed: ${label} ("${resolvedChild}") is not inside the scratch root ("${resolvedParent}").`);
  }
}

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

function main_assertSameSet(actualArray, expectedArray, label) {
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
  const scratchRoot = path.join(FIXTURES_ROOT, `sync-dirs-${runId}`);
  const sourceRoot = path.join(scratchRoot, 'source');
  const targetRoot = path.join(scratchRoot, 'target');

  console.log(`Generating test source tree at ${sourceRoot} ...`);
  execFileSync(process.execPath, [
    path.join(__dirname, '../generate-random-tree.js'),
    '--root', sourceRoot,
    '--files', '15',
    '--max-depth', '2',
    '--min-size', '0',
    '--max-size', '20000',
    '--seed', '909090',
    '--no-edge-cases',
  ], { stdio: 'inherit' });
  const manifestPath = `${sourceRoot}.manifest.json`;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log(`\nGenerated ${manifest.fileCount} files, ${manifest.totalSizeBytes.toLocaleString()} bytes total.`);

  fs.mkdirSync(targetRoot, { recursive: true });

  let app, win;
  const results = {};
  try {
    console.log('\nLaunching the app...');
    ({ app, win } = await launchApp());

    // 1. Establish a baseline: target = an exact copy of source (reusing the already-proven diff +
    //    incremental-copy-files pair - see worker-ipc/test-incremental-backup.js for dedicated coverage of this
    //    pair on its own).
    console.log('\nEstablishing baseline (target = copy of source)...');
    const baselineDiff = await callWorker(win, 'diff', { source: sourceRoot, target: targetRoot });
    await callWorker(win, 'incremental-copy-files', { sourceOnlyPaths: excludeMarkerFile(baselineDiff.res), source: sourceRoot, target: targetRoot });

    // 2. Diverge: modify+add on the SOURCE side (should end up copied), and plant two deliberate "leftovers"
    //    directly in the TARGET side that don't exist in source at all (should end up deleted). One leftover
    //    sits in an existing, otherwise-non-empty subdirectory (so only the file should disappear); the other
    //    sits alone in a brand-new subdirectory (so the now-empty directory should ALSO get cleaned up) - this
    //    exercises the directory-cleanup path deliberately, as its own clearly-isolated case.
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

    printTree(sourceRoot, 'Source tree (before)');
    printTree(targetRoot, 'Target tree (before - includes the planted leftovers)');

    // 3. Compute copyPaths / deletePaths exactly the way sync-dirs.component.ts does.
    console.log('\nComputing copy/delete paths (mirrors sync-dirs.component.ts)...');
    const copyDiff = await callWorker(win, 'diff', { source: sourceRoot, target: targetRoot });
    const copyPaths = excludeMarkerFile(copyDiff.res);
    const deleteDiff = await callWorker(win, 'diff', { source: targetRoot, target: sourceRoot });
    const deletePaths = deleteDiff.res.filter((p) => !copyPaths.includes(p));

    const expectedCopyPaths = [toModify.relativePath, newSourceFileRel].map((p) => p.split('/').join(path.sep));
    const expectedDeletePaths = [leftoverInExistingDirRel, leftoverAloneDirRel];
    results.copyPathsCorrect = main_assertSameSet(copyPaths, expectedCopyPaths, 'copyPaths == exactly the source-side changes');
    results.deletePathsCorrect = main_assertSameSet(deletePaths, expectedDeletePaths, 'deletePaths == exactly the planted leftovers');

    const mtimesBeforeAnyDeleteCall = snapshotMtimes(targetRoot);

    // 4. PREVIEW first (commit=false) - the safety-critical assertion: nothing on disk actually changes.
    console.log('\nCalling delete-files-and-dirs-for-dir-sync in PREVIEW mode (must delete nothing)...');
    await callWorker(win, 'delete-files-and-dirs-for-dir-sync', {
      pathsMarkedForDeletion: deletePaths,
      commit: DELETE_PARAM_THAT_ACTUALLY_PREVIEWS_ONLY,
      source: sourceRoot,
      target: targetRoot,
    });
    const leftoverFileStillPresent = fs.existsSync(path.join(targetRoot, leftoverInExistingDirRel));
    const leftoverAloneStillPresent = fs.existsSync(path.join(targetRoot, leftoverAloneDirRel));
    const leftoverOnlyDirStillPresent = fs.existsSync(path.join(targetRoot, 'leftover-only-dir'));
    const mtimesAfterPreview = snapshotMtimes(targetRoot);
    let nothingElseChangedDuringPreview = true;
    for (const [relPath, mtimeBefore] of mtimesBeforeAnyDeleteCall) {
      if (mtimesAfterPreview.get(relPath) !== mtimeBefore) { nothingElseChangedDuringPreview = false; }
    }
    results.previewDeletedNothing = leftoverFileStillPresent && leftoverAloneStillPresent && leftoverOnlyDirStillPresent && nothingElseChangedDuringPreview;
    console.log(`  leftover file still present      : ${leftoverFileStillPresent}`);
    console.log(`  leftover-alone file still present: ${leftoverAloneStillPresent}`);
    console.log(`  leftover-only dir still present  : ${leftoverOnlyDirStillPresent}`);
    console.log(`  nothing else touched during preview: ${nothingElseChangedDuringPreview}`);
    console.log(`  ${results.previewDeletedNothing ? 'OK' : 'FAILED'} - preview mode deleted nothing, as required.`);

    if (!results.previewDeletedNothing) {
      // Refuse to proceed to the real commit call if preview mode did not behave as a pure preview - the whole
      // point of checking this first.
      throw new Error('Preview mode altered the target directory - refusing to proceed to the real (commit=true) delete call.');
    }

    // 5. Copy the source-side changes across (same order sync-dirs.component.ts's commitAllSyncOperations uses:
    //    copy, then delete).
    console.log('\nCalling incremental-copy-files (the copy side of the sync)...');
    await callWorker(win, 'incremental-copy-files', { sourceOnlyPaths: copyPaths, source: sourceRoot, target: targetRoot });

    // 6. The one real delete call in this whole script - guarded immediately before it's made.
    assertPathIsWithin(targetRoot, scratchRoot, 'delete target');
    console.log('\nCalling delete-files-and-dirs-for-dir-sync in COMMIT mode (deletes the planted leftovers)...');
    await callWorker(win, 'delete-files-and-dirs-for-dir-sync', {
      pathsMarkedForDeletion: deletePaths,
      commit: DELETE_PARAM_THAT_ACTUALLY_COMMITS_DELETIONS,
      source: sourceRoot,
      target: targetRoot,
    });

    // 7. Verify: target must now be an EXACT match for source's final state - byte-for-byte AND with zero
    //    extras. verify-manifest.js's own EXTRA detection is what actually proves the leftovers are gone (not
    //    just "the 2 files I expected"), since it independently lists everything under targetRoot.
    printTree(targetRoot, 'Target tree (after)');
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

    // 8. Explicit, redundant proof (on top of verify-manifest's EXTRA check) that deletion actually happened,
    //    not just that things coincidentally lined up.
    results.leftoversActuallyDeleted =
      !fs.existsSync(path.join(targetRoot, leftoverInExistingDirRel)) &&
      !fs.existsSync(path.join(targetRoot, leftoverAloneDirRel)) &&
      !fs.existsSync(path.join(targetRoot, 'leftover-only-dir')); // the now-empty directory must be cleaned up too
    console.log(`\nLeftovers actually deleted (file + now-empty dir): ${results.leftoversActuallyDeleted}`);

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

  console.log(`\n${pass ? 'PASS' : 'FAIL'} - Synchronize directories (diff + incremental-copy-files + delete-files-and-dirs-for-dir-sync) ${pass ? 'behaved correctly end-to-end.' : 'did not behave as expected, see above.'}`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => {
  console.error('\nTEST ERRORED:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
