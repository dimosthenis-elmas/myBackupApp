#!/usr/bin/env node
'use strict';

/**
 * Exercises how the worker's disc scans handle links and entries they cannot read, a whole drive as the folder, and
 * files too large for a single disc - through the app's REAL worker IPC, no UI clicking.
 *
 *  1. Links and unreadable entries - a junction pointing to a folder OUTSIDE the scanned one, a dangling junction,
 *     and a folder Windows denies listing (a "deny list folder" ACL, the same thing that makes e.g. the legacy
 *     "My Music" junction inside Documents unreadable):
 *       - The scan behind every disc (get-file-paths-with-stats / partition-backup-to-optical-media) never follows
 *         a link. A disc cannot hold a link, so each one is left out - of the result and of the plan - and nothing
 *         it points to is ever part of either. Each link left out is written to logs.txt, with where it points, and
 *         is NOT in the "Some items were left out" warning (a warning naming Windows' own links on every run would
 *         stop being read); the response counts them (linksLeftOut), for the wizard's own dialog to say how many.
 *       - A backup-source scan (skipUnreadable - how the Backup to optical media and Add missing files wizards call
 *         it) skips the folder that cannot be listed, and raises ONE warning, "Some items were left out", naming
 *         it by full path; without skipUnreadable (reading a disc, whose ID is a hash of everything on it) it fails.
 *       - Synchronize directories' comparison (diff with comparison 'any-difference', never skipping - a skipped
 *         source entry would look "missing" and its copy in the target would be deleted) fails too, on the folder
 *         that cannot be listed. (How diff treats links is covered by test-sync-and-cumulative-rules.js.)
 *  2. Files too large for a single disc: planning without splitting reports ALL of them by full path
 *     (too_large_files), not just the first one - that list is what the "Large files found" dialog shows. A plan
 *     that stops there shows no "left out" warning (the wizard plans again once splitting is agreed to, and the
 *     warning would otherwise appear twice); a plan that goes ahead names the folder it could not list.
 *  3. A whole drive as the folder (a temporary SUBST drive letter onto a scratch folder): planning a backup of
 *     "X:\" (what the folder picker returns for a drive), a scan of a bare "X:" (what the disc readers pass - on
 *     its own that means "the current directory on drive X", not its root), and resolving and hashing a file under
 *     the drive root all work. Skipped if no drive letter is free.
 *
 * Nothing here writes into the app's real temp/cache directory (planning a disc only checks it exists), so no
 * temp-dir-guard is needed. The deny ACL and the SUBST drive are both removed again in a finally block.
 *
 * NOTE: needs a real Windows desktop/window session (see call-worker.js's top comment) - run from your own
 * interactive terminal.
 *
 * Usage:
 *   node test-harness/worker-ipc/test-scan-edge-cases.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { launchApp, callWorker, startRecordingAppErrors, takeAppErrors } = require('./call-worker');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');

// The app's log, which the worker's console.warn lines go to (appData/logs.txt, next to config.json).
const LOGS_TXT = path.resolve(__dirname, '../../appData/logs.txt');

/** True if logs.txt has the line leaveOutLink (worker.ts) writes for the link at `linkPath`, pointing to `pointsTo`. */
function linkIsLogged(linkPath, pointsTo) {
  try { return fs.readFileSync(LOGS_TXT, 'utf8').includes(`Left out a link: ${linkPath}  -  a link to "${pointsTo}"`); } catch { return false; }
}

/** A file of exactly `sizeBytes` with no real content (sparse on NTFS) - near-instant regardless of size. */
function writeExactSizeFile(filePath, sizeBytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, 'w');
  fs.ftruncateSync(fd, sizeBytes);
  fs.closeSync(fd);
}

/** callWorker rejects with an Error whose message contains the worker's error payload as one line of JSON, right
 *  after 'Worker returned status "error" for "<key>": ' (see callWorkerInner in call-worker.js). The message can
 *  go on after it - Playwright uses the page-side error's stack as the message, so "at ..." lines follow - which is
 *  why the JSON is read from its own line. Returns that payload ({} if it can't be read), or null if the call did
 *  not fail. */
async function callExpectingError(win, key, params) {
  try {
    await callWorker(win, key, params);
    return null;
  } catch (e) {
    const marker = `Worker returned status "error" for "${key}": `;
    const line = String(e.message).split('\n').find((l) => l.includes(marker));
    if (!line) { return {}; }
    try { return JSON.parse(line.slice(line.indexOf(marker) + marker.length)); } catch { return {}; }
  }
}

function report(results, name, ok, extra) {
  results[name] = ok;
  console.log(`  ${ok ? 'OK' : 'FAILED'} - ${name}${extra ? `  (${extra})` : ''}`);
}

async function main() {
  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `scan-edge-cases-${runId}`);
  const sessionId = `session-${runId}`;
  const tree = path.join(scratchRoot, 'tree');
  const lockedDir = path.join(tree, 'locked');
  fs.mkdirSync(path.join(tree, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'a.txt'), 'a');
  fs.writeFileSync(path.join(tree, 'sub', 'b.txt'), 'b');
  // A junction to a folder outside the tree - nothing in that folder may ever show up in a disc scan or plan.
  const outsideFolder = path.join(scratchRoot, 'outside-the-tree');
  fs.mkdirSync(outsideFolder);
  fs.writeFileSync(path.join(outsideFolder, 'outside.txt'), 'must not be backed up from the tree');
  const outsideLink = path.join(tree, 'link-to-outside');
  fs.symlinkSync(outsideFolder, outsideLink, 'junction');
  const junctionTarget = path.join(scratchRoot, 'junction-target-that-is-removed');
  const danglingLink = path.join(tree, 'dangling');
  fs.mkdirSync(junctionTarget);
  fs.symlinkSync(junctionTarget, danglingLink, 'junction');
  fs.rmdirSync(junctionTarget);
  fs.mkdirSync(lockedDir);
  fs.writeFileSync(path.join(lockedDir, 'secret.txt'), 's');

  const bigFiles = path.join(scratchRoot, 'big');
  writeExactSizeFile(path.join(bigFiles, 'big one.bin'), 3_000_000);
  writeExactSizeFile(path.join(bigFiles, 'sub', 'big two.bin'), 5_000_000);
  writeExactSizeFile(path.join(bigFiles, 'small.txt'), 10);
  // A folder that cannot be listed - left out of a disc plan, so the plan has an entry to name in its warning.
  const lockedInBigFiles = path.join(bigFiles, 'locked');
  fs.mkdirSync(lockedInBigFiles);
  fs.writeFileSync(path.join(lockedInBigFiles, 'secret.txt'), 's');

  let lockedApplied = false;
  try {
    for (const dir of [lockedDir, lockedInBigFiles]) { execFileSync('icacls', [dir, '/deny', '*S-1-1-0:(RD)'], { stdio: 'pipe' }); }
    try { fs.readdirSync(lockedDir); } catch { lockedApplied = true; }
  } catch { /* icacls unavailable - the checks that need a folder that cannot be listed are skipped */ }
  console.log(`Scratch tree at ${tree} (a junction to outside, a dangling junction${lockedApplied ? ', a folder that cannot be listed' : ''}).`);

  let substLetter = null;
  let app, win;
  const results = {};
  try {
    console.log('\nLaunching the app...');
    ({ app, win } = await launchApp());
    // Let the app's own startup checks finish before this script's raw calls - see ui/test-add-missing-files.js's
    // identical pause for why they would otherwise interfere.
    await new Promise((r) => setTimeout(r, 3000));
    await startRecordingAppErrors(win);

    // ---- 1. links and unreadable entries
    console.log('\nLinks and unreadable entries...');
    await takeAppErrors(win);
    const scan = await callWorker(win, 'get-file-paths-with-stats', { dirPath: tree, skipUnreadable: true });
    const warnings = await takeAppErrors(win);
    const scannedNames = scan.res.map((e) => path.relative(tree, e.path)).sort();
    const expectedNames = ['a.txt', path.join('sub', 'b.txt')].sort();
    report(results, 'scanLeavesEachLinkOutAndNothingBehindIt', JSON.stringify(scannedNames) === JSON.stringify(expectedNames), JSON.stringify(scannedNames));
    report(results, 'eachLinkLeftOutIsInLogsTxtWithWhereItPoints', linkIsLogged(outsideLink, outsideFolder) && linkIsLogged(danglingLink, junctionTarget));
    // The number the wizard's dialog says ("2 links were left out ...").
    report(results, 'theScanResponseCountsTheLinksLeftOut', scan.linksLeftOut === 2, `linksLeftOut: ${scan.linksLeftOut}`);
    const listed = warnings.length === 1 && Array.isArray(warnings[0].lists) ? warnings[0].lists[0].items : [];
    if (lockedApplied) {
      report(results, 'oneWarningNamesOnlyTheFolderThatCannotBeListed - no link',
        warnings.length === 1 && warnings[0].title === 'Some items were left out' && listed.length === 1 && listed[0].startsWith(lockedDir + '  -  '),
        `${warnings.length} warning(s): ${JSON.stringify(listed)}`);
      report(results, 'scanWithoutSkippingFailsOnAFolderThatCannotBeListed', (await callExpectingError(win, 'get-file-paths-with-stats', { dirPath: tree })) !== null);
    } else {
      report(results, 'noWarningForTheLinks', warnings.length === 0, `${warnings.length} warning(s): ${JSON.stringify(listed)}`);
    }

    await takeAppErrors(win);
    const plan = await callWorker(win, 'partition-backup-to-optical-media', { rootPath: tree, mediaCapacityInBytes: 4.7e9, maxRepletionRatio: 0.97, splitLargeFiles: false, sessionId, skipUnreadable: true });
    const plannedPaths = plan.res.flat().map((e) => e.path);
    const plannedFiles = plan.res.flat().filter((e) => !e.stats.isDirectory).map((e) => path.relative(tree, e.path)).sort();
    report(results, 'backupPlanningLeavesEachLinkOutAndNothingBehindIt',
      JSON.stringify(plannedFiles) === JSON.stringify(expectedNames) && plannedPaths.every((p) => p.startsWith(tree + path.sep))
        && !plannedPaths.some((p) => p.startsWith(outsideLink) || p.startsWith(danglingLink))
        && (await takeAppErrors(win)).length === (lockedApplied ? 1 : 0), JSON.stringify(plannedFiles));
    report(results, 'thePlanResponseCountsTheLinksLeftOut', plan.linksLeftOut === 2, `linksLeftOut: ${plan.linksLeftOut}`);
    if (lockedApplied) {
      report(results, 'syncComparisonFailsInsteadOfSkipping', (await callExpectingError(win, 'diff', { source: tree, target: bigFiles, comparison: 'any-difference' })) !== null);
    }

    // ---- 2. every too-large file is reported
    console.log('\nFiles too large for a single disc...');
    await takeAppErrors(win);
    const tooLarge = await callExpectingError(win, 'partition-backup-to-optical-media', { rootPath: bigFiles, mediaCapacityInBytes: 2_000_000, maxRepletionRatio: 0.97, splitLargeFiles: false, sessionId, skipUnreadable: true });
    const reportedPaths = tooLarge && Array.isArray(tooLarge.too_large_files) ? tooLarge.too_large_files.map((f) => f.path).sort() : [];
    const expectedTooLarge = [path.join(bigFiles, 'big one.bin'), path.join(bigFiles, 'sub', 'big two.bin')].sort();
    const warningsWhenStopped = await takeAppErrors(win);
    if (lockedApplied) {
      report(results, 'aPlanThatStopsAtTooLargeFilesShowsNoLeftOutWarning',
        tooLarge !== null && tooLarge.err_code === 'FILE_TOO_LARGE_FOR_SINGLE_OPTICAL_DISC' && warningsWhenStopped.length === 0,
        `${warningsWhenStopped.length} warning(s)`);
      await callWorker(win, 'partition-backup-to-optical-media', { rootPath: bigFiles, mediaCapacityInBytes: 4.7e9, maxRepletionRatio: 0.97, splitLargeFiles: false, sessionId, skipUnreadable: true });
      const warningsWhenPlanned = await takeAppErrors(win);
      const leftOutWhenPlanned = warningsWhenPlanned.length === 1 && Array.isArray(warningsWhenPlanned[0].lists) ? warningsWhenPlanned[0].lists[0].items : [];
      report(results, 'aPlanThatGoesAheadNamesTheFolderItCouldNotList',
        leftOutWhenPlanned.length === 1 && leftOutWhenPlanned[0].startsWith(lockedInBigFiles + '  -  '), JSON.stringify(leftOutWhenPlanned));
    }
    report(results, 'planningReportsEveryTooLargeFileByFullPath',
      tooLarge !== null && tooLarge.err_code === 'FILE_TOO_LARGE_FOR_SINGLE_OPTICAL_DISC' && JSON.stringify(reportedPaths) === JSON.stringify(expectedTooLarge),
      JSON.stringify(reportedPaths));

    // ---- 3. a whole drive as the folder
    for (const letter of 'YXWVUTSRQP') { if (!fs.existsSync(`${letter}:\\`)) { substLetter = letter; break; } }
    if (substLetter) {
      console.log(`\nA whole drive as the folder (temporary drive ${substLetter}: onto a scratch folder)...`);
      const driveDir = path.join(scratchRoot, 'drive');
      fs.mkdirSync(path.join(driveDir, 'd'), { recursive: true });
      fs.writeFileSync(path.join(driveDir, 'top.txt'), 'top');
      fs.writeFileSync(path.join(driveDir, 'd', 'x.txt'), 'x content');
      execFileSync('subst', [`${substLetter}:`, driveDir]);
      const root = `${substLetter}:\\`;
      const drivePlan = await callWorker(win, 'partition-backup-to-optical-media', { rootPath: root, mediaCapacityInBytes: 4.7e9, maxRepletionRatio: 0.97, splitLargeFiles: false, sessionId });
      const drivePlanned = drivePlan.res.flat().map((e) => e.path).sort();
      report(results, 'planningADriveRootListsTheWholeDrive',
        JSON.stringify(drivePlanned) === JSON.stringify([`${root}d\\x.txt`, `${root}top.txt`]), JSON.stringify(drivePlanned));
      const bareScan = await callWorker(win, 'get-file-paths', { sourceDir: `${substLetter}:` });
      report(results, 'scanningABareDriveLetterScansItsRoot', JSON.stringify(bareScan.res.slice().sort()) === JSON.stringify([`${root}d\\x.txt`, `${root}top.txt`]), JSON.stringify(bareScan.res));
      const partials = await callWorker(win, 'create-optical-media-disc-partials', { dirPath: root, paths: ['d\\x.txt'], sessionId });
      report(results, 'resolvingAFileUnderADriveRootWorks', partials.res.length === 1 && partials.res[0].stats.size === 'x content'.length);
      const hashes = await callWorker(win, 'compute-sha256-for-backed-up-files', { dirPath: root, paths: ['top.txt'], sessionId });
      const expectedHash = crypto.createHash('sha256').update('top').digest('hex');
      report(results, 'hashingAFileUnderADriveRootWorks', hashes.res.length === 1 && hashes.res[0].sha256 === expectedHash);
    } else {
      console.log('\n(Whole-drive scenario skipped: no free drive letter for a temporary SUBST drive.)');
    }
  } finally {
    if (app) { await app.close().catch(() => {}); }
    if (substLetter) { try { execFileSync('subst', [`${substLetter}:`, '/D']); } catch { /* already gone */ } }
    for (const dir of [lockedDir, lockedInBigFiles]) { try { execFileSync('icacls', [dir, '/remove:d', '*S-1-1-0'], { stdio: 'pipe' }); } catch { /* best effort */ } }
  }

  const pass = Object.keys(results).length > 0 && Object.values(results).every(Boolean);
  console.log('\nSummary:');
  for (const [check, ok] of Object.entries(results)) { console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${check}`); }
  if (pass) {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  } else {
    console.log(`\nLeaving scratch files in place for inspection: ${scratchRoot}`);
  }
  console.log(`\n${pass ? 'PASS' : 'FAIL'} - scan edge cases (links, unreadable entries, too-large files, a whole drive) ${pass ? 'behaved correctly.' : 'did not behave as expected, see above.'}`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => {
  console.error('\nTEST ERRORED:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
