#!/usr/bin/env node
'use strict';

/**
 * Exercises the "Synchronize directories" flow - diff (both directions) + incremental-copy-files +
 * delete-files-and-dirs-for-dir-sync - through the app's REAL worker IPC, no app source touched, no UI clicking.
 * Reproduces the exact same algorithm src/app/sync-dirs/sync-dirs.component.ts uses (see its syncDirs() and
 * commitAllSyncOperations()): copyPaths = diff(source, target, 'any-difference-or-content'); deletePaths =
 * diff(target, source, 'any-difference') with any overlap with copyPaths removed (a file that exists on both sides
 * but differs shows up in both lists - it is overwritten by the copy, never deleted); then copy copyPaths, then
 * delete deletePaths. 'any-difference' is symmetric (mtimes differing in either direction, or sizes differing),
 * which is what makes that overlap removal correct - the default comparison only asks whether the FIRST
 * directory's copy is newer. The copy side additionally compares the BYTES of files whose size and mtime match.
 *
 * Besides the ordinary changes (a modified file, a new file, two planted leftovers), it also plants a file whose
 * target copy has different bytes (same size) and a NEWER mtime than the source's, and another whose target copy
 * has different bytes but the SAME size and mtime as the source's (only a byte comparison can see that one): the
 * sync has to overwrite both with the source's version, not leave them and above all not delete them. And - on a
 * case-insensitive filesystem such as NTFS, where "name.txt" and "NAME.TXT" are one file - a file renamed in the
 * source in letter case only ("name.txt" -> "NAME.TXT"), which is neither copied nor deleted since it is the same
 * file, and a second one renamed in letter case only AND changed, which has to end up in the target with the new
 * content: the deletion list names it in the target's spelling, which the exact-name overlap removal misses, so
 * this checks that the worker's deletion step refuses to delete a file the source has. Finally, the same algorithm
 * in a case-sensitive folder, where those two spellings ARE different files: the target must end up with exactly
 * the source's spelling (skipped when Windows won't make a folder case-sensitive).
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
const { isCaseInsensitiveFilesystem } = require('../lib/filesystem-case');

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
    await callWorker(win, 'incremental-copy-files', { sourceOnlyPaths: excludeMarkerFile(baselineDiff.res), source: sourceRoot, target: targetRoot, nameClash: 'replace' });

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

    // Two more files that exist on both sides (see the header comment), picked from the generated files that are
    // not the one modified above. The first gets different bytes of the same size and a newer mtime in the target.
    const otherFiles = manifest.files.filter((f) => f.relativePath !== toModify.relativePath);
    const newerTargetFile = otherFiles.find((f) => f.sizeBytes > 0);
    const sameMetadataFile = otherFiles.find((f) => f !== newerTargetFile && f.sizeBytes > 0);
    const untouchedCandidates = otherFiles.filter((f) => f !== newerTargetFile && f !== sameMetadataFile);
    const newerTargetRelOs = newerTargetFile.relativePath.split('/').join(path.sep);
    fs.writeFileSync(path.join(targetRoot, newerTargetRelOs), crypto.randomBytes(newerTargetFile.sizeBytes));
    const inTheFuture = new Date(Date.now() + 120_000);
    fs.utimesSync(path.join(targetRoot, newerTargetRelOs), inTheFuture, inTheFuture);
    console.log(`  target copy given different bytes (same size) and a newer mtime: ${newerTargetFile.relativePath}`);
    // Different bytes, same size, and the target's mtime put back to exactly the source's - invisible to any
    // size/date comparison.
    const sameMetadataRelOs = sameMetadataFile.relativePath.split('/').join(path.sep);
    const sameMetadataSourceStats = fs.statSync(path.join(sourceRoot, sameMetadataRelOs));
    // Every byte inverted, so the content is guaranteed to differ (random bytes could, for a tiny file, happen to
    // equal the original).
    fs.writeFileSync(path.join(targetRoot, sameMetadataRelOs), Buffer.from(fs.readFileSync(path.join(sourceRoot, sameMetadataRelOs)).map((b) => b ^ 0xff)));
    fs.utimesSync(path.join(targetRoot, sameMetadataRelOs), sameMetadataSourceStats.atime, sameMetadataSourceStats.mtime);
    console.log(`  target copy given different bytes, same size and same mtime: ${sameMetadataFile.relativePath}`);

    // Only meaningful where "name" and "NAME" are one file (NTFS by default). On a case-sensitive filesystem the
    // uppercase name would be a genuinely different file, which the sync correctly copies and whose old spelling
    // it correctly deletes - so there is nothing to protect there, and the scenario is skipped.
    let caseRenameRelOs = null;
    // A second file renamed in letter case only AND changed: the copy list names it in the source's spelling and
    // the deletion list in the target's, so the component's exact-name overlap removal leaves it in the deletion
    // list - and the worker's deletion step is what must refuse to delete it (the copy phase just rewrote it).
    let caseRenameEditedFile = null;
    let caseRenameEditedRelOs = null;
    let caseRenameEditedSourceRelOs = null;
    if (isCaseInsensitiveFilesystem(targetRoot)) {
      const [caseRenameCandidate, caseRenameEditedCandidate] = untouchedCandidates.filter((f) => {
        const baseName = path.basename(f.relativePath);
        return baseName.toUpperCase() !== baseName;
      });
      caseRenameRelOs = caseRenameCandidate.relativePath.split('/').join(path.sep);
      const caseRenamedSourceRelOs = path.join(path.dirname(caseRenameRelOs), path.basename(caseRenameRelOs).toUpperCase());
      fs.renameSync(path.join(sourceRoot, caseRenameRelOs), path.join(sourceRoot, caseRenamedSourceRelOs));
      console.log(`  renamed in source, letter case only: ${caseRenameCandidate.relativePath} -> ${caseRenamedSourceRelOs.split(path.sep).join('/')}`);

      caseRenameEditedFile = caseRenameEditedCandidate;
      caseRenameEditedRelOs = caseRenameEditedCandidate.relativePath.split('/').join(path.sep);
      caseRenameEditedSourceRelOs = path.join(path.dirname(caseRenameEditedRelOs), path.basename(caseRenameEditedRelOs).toUpperCase());
      fs.renameSync(path.join(sourceRoot, caseRenameEditedRelOs), path.join(sourceRoot, caseRenameEditedSourceRelOs));
      fs.appendFileSync(path.join(sourceRoot, caseRenameEditedSourceRelOs), crypto.randomBytes(777));
      console.log(`  renamed in source, letter case only, AND changed: ${caseRenameEditedCandidate.relativePath} -> ${caseRenameEditedSourceRelOs.split(path.sep).join('/')}`);
    } else {
      console.log('  (letter-case-only rename scenario skipped: this filesystem is case-sensitive)');
    }

    printTree(sourceRoot, 'Source tree (before)');
    printTree(targetRoot, 'Target tree (before - includes the planted leftovers)');

    // 3. Compute copyPaths / deletePaths exactly the way sync-dirs.component.ts does.
    console.log('\nComputing copy/delete paths (mirrors sync-dirs.component.ts)...');
    const copyDiff = await callWorker(win, 'diff', { source: sourceRoot, target: targetRoot, comparison: 'any-difference-or-content' });
    const copyPaths = excludeMarkerFile(copyDiff.res);
    const deleteDiff = await callWorker(win, 'diff', { source: targetRoot, target: sourceRoot, comparison: 'any-difference' });
    const deletePaths = deleteDiff.res.filter((p) => !copyPaths.includes(p));

    const expectedCopyPaths = [toModify.relativePath, newSourceFileRel, newerTargetFile.relativePath, sameMetadataFile.relativePath].map((p) => p.split('/').join(path.sep));
    const expectedDeletePaths = [leftoverInExistingDirRel, leftoverAloneDirRel];
    if (caseRenameEditedFile !== null) {
      expectedCopyPaths.push(caseRenameEditedSourceRelOs);
      expectedDeletePaths.push(caseRenameEditedRelOs); // listed - see caseRenameEditedFile's comment above
    }
    results.copyPathsCorrect = main_assertSameSet(copyPaths, expectedCopyPaths, 'copyPaths == the modified file, the new file, the files whose target copy differs (not the unchanged case-renamed one)');
    results.deletePathsCorrect = main_assertSameSet(deletePaths, expectedDeletePaths, 'deletePaths == the planted leftovers (+ the target spelling of the case-renamed-and-changed file)');

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
    await callWorker(win, 'incremental-copy-files', { sourceOnlyPaths: copyPaths, source: sourceRoot, target: targetRoot, nameClash: 'replace' });

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
        ...manifest.files.filter((f) => f.relativePath !== toModify.relativePath && f !== caseRenameEditedFile),
        { relativePath: toModify.relativePath, sizeBytes: fs.statSync(path.join(sourceRoot, modifyRelOs)).size, sha256: sha256File(path.join(sourceRoot, modifyRelOs)) },
        { relativePath: newSourceFileRel, sizeBytes: fs.statSync(path.join(sourceRoot, newSourceFileRel)).size, sha256: sha256File(path.join(sourceRoot, newSourceFileRel)) },
        // Under the target's (old) spelling - the sync mirrors content, not the letter case of a name.
        ...(caseRenameEditedFile !== null ? [{ relativePath: caseRenameEditedFile.relativePath, sizeBytes: fs.statSync(path.join(sourceRoot, caseRenameEditedSourceRelOs)).size, sha256: sha256File(path.join(sourceRoot, caseRenameEditedSourceRelOs)) }] : []),
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

    // 9. The files that exist on both sides must still be in the target after the whole sync - deleting a file
    //    the source still has would leave the "synchronized" target missing it - and the newer target copy must
    //    have been overwritten with the source's bytes, not merely left alone.
    results.newerTargetCopyOverwritten = sha256File(path.join(targetRoot, newerTargetRelOs)) === newerTargetFile.sha256;
    console.log(`Target copy that was newer than the source's now has the source's bytes: ${results.newerTargetCopyOverwritten}`);
    results.sameMetadataCopyOverwritten = sha256File(path.join(targetRoot, sameMetadataRelOs)) === sameMetadataFile.sha256;
    console.log(`Target copy with the source's size and mtime but different bytes now has the source's bytes: ${results.sameMetadataCopyOverwritten}`);
    if (caseRenameRelOs !== null) {
      results.caseRenamedFileKept = fs.existsSync(path.join(targetRoot, caseRenameRelOs));
      console.log(`File renamed only in letter case in the source still present in the target: ${results.caseRenamedFileKept}`);
    }
    if (caseRenameEditedFile !== null) {
      results.caseRenamedEditedFileHasNewContent = fs.existsSync(path.join(targetRoot, caseRenameEditedRelOs))
        && sha256File(path.join(targetRoot, caseRenameEditedRelOs)) === sha256File(path.join(sourceRoot, caseRenameEditedSourceRelOs));
      console.log(`File renamed in letter case and changed in the source is in the target with the new content: ${results.caseRenamedEditedFileHasNewContent}`);
    }

    // 10. The same algorithm in a CASE-SENSITIVE folder (Windows per-directory case sensitivity - what Linux
    //     filesystems always are): there "REPORT.TXT" in the source and "report.txt" in the target are two
    //     different files, so the target must end up with REPORT.TXT and without report.txt. Skipped when Windows
    //     won't enable case sensitivity on a folder here (it needs the "Windows Subsystem for Linux" feature).
    const caseSensitiveRoot = path.join(scratchRoot, 'case-sensitive');
    fs.mkdirSync(caseSensitiveRoot, { recursive: true });
    let caseSensitiveEnabled = true;
    try {
      execFileSync('fsutil', ['file', 'setCaseSensitiveInfo', caseSensitiveRoot, 'enable'], { stdio: 'pipe' });
    } catch { caseSensitiveEnabled = false; }
    if (caseSensitiveEnabled && !isCaseInsensitiveFilesystem(caseSensitiveRoot)) {
      console.log('\nCase-sensitive folder: source has REPORT.TXT, target has a different file report.txt...');
      const csSource = path.join(caseSensitiveRoot, 'source');
      const csTarget = path.join(caseSensitiveRoot, 'target');
      fs.mkdirSync(csSource); fs.mkdirSync(csTarget);
      fs.writeFileSync(path.join(csSource, 'REPORT.TXT'), 'the source file');
      fs.writeFileSync(path.join(csTarget, 'report.txt'), 'a different file');
      const csCopy = excludeMarkerFile((await callWorker(win, 'diff', { source: csSource, target: csTarget, comparison: 'any-difference-or-content' })).res);
      const csDelete = (await callWorker(win, 'diff', { source: csTarget, target: csSource, comparison: 'any-difference' })).res.filter((p) => !csCopy.includes(p));
      await callWorker(win, 'incremental-copy-files', { sourceOnlyPaths: csCopy, source: csSource, target: csTarget, nameClash: 'replace' });
      assertPathIsWithin(csTarget, scratchRoot, 'case-sensitive delete target');
      await callWorker(win, 'delete-files-and-dirs-for-dir-sync', { pathsMarkedForDeletion: csDelete, commit: DELETE_PARAM_THAT_ACTUALLY_COMMITS_DELETIONS, source: csSource, target: csTarget });
      const csTargetNames = fs.readdirSync(csTarget).sort();
      results.caseSensitiveFolderMirroredExactly = JSON.stringify(csTargetNames) === JSON.stringify(['REPORT.TXT']);
      console.log(`  target now holds ${JSON.stringify(csTargetNames)} (expected ["REPORT.TXT"]): ${results.caseSensitiveFolderMirroredExactly}`);
    } else {
      console.log('\n(Case-sensitive folder scenario skipped: Windows would not enable case sensitivity on a folder here.)');
    }

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
