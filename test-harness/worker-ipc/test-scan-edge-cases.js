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
 *         a link. A disc cannot hold a link, so each one is listed - and planned - as the one small Windows
 *         shortcut it is burned as, "<link name>.lnk", recording where it points; nothing it points to is ever
 *         part of the result.
 *       - A backup-source scan (skipUnreadable - how the Backup to optical media and Add missing files wizards call
 *         it) skips the folder that cannot be listed and raises ONE warning, "Some items were left out", naming it
 *         by full path; without skipUnreadable (reading a disc, whose ID is a hash of everything on it) it fails.
 *       - Synchronize directories' comparison (diff with comparison 'any-difference', never skipping - a skipped
 *         source entry would look "missing" and its copy in the target would be deleted) fails too, on the folder
 *         that cannot be listed. (diff lists a link as one entry and copies it as a link -
 *         test-sync-and-cumulative-rules.js covers that.)
 *       - When the disc is sent (create-optical-media-disc-partials, with the app's temp folder pointed at a
 *         scratch folder for the run), each link's shortcut is created in the temp folder - never in the source -
 *         as one small file that Windows itself reads as pointing where the link points (also when that place no
 *         longer exists), and it is hashed like any other file. The folder the links point to is untouched.
 *  2. Files too large for a single disc: planning without splitting reports ALL of them by full path
 *     (too_large_files), not just the first one - that list is what the "Large files found" dialog shows. A plan
 *     that stops there shows no "left out" warning (the wizard plans again once splitting is agreed to, and the
 *     warning would otherwise appear twice) - the entry left out there is the one case a link is: a real file
 *     already has the name its shortcut would get. A plan that goes ahead names it in the warning.
 *  3. A whole drive as the folder (a temporary SUBST drive letter onto a scratch folder): planning a backup of
 *     "X:\" (what the folder picker returns for a drive), a scan of a bare "X:" (what the disc readers pass - on
 *     its own that means "the current directory on drive X", not its root), and resolving and hashing a file under
 *     the drive root all work. Skipped if no drive letter is free.
 *
 * Nothing here writes into the app's real temp/cache directory (planning a disc only checks it exists, and the
 * shortcuts are created with config.json's cacheDataDirectoryPath pointed at a scratch folder, restored afterwards),
 * so no temp-dir-guard is needed. The deny ACL and the SUBST drive are both removed again in a finally block.
 *
 * NOTE: needs a real Windows desktop/window session (see call-worker.js's top comment) - run from your own
 * interactive terminal.
 *
 * Usage:
 *   node test-harness/worker-ipc/test-scan-edge-cases.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { launchApp, callWorker, startRecordingAppErrors, takeAppErrors } = require('./call-worker');
const { backupAndRedirectConfigField, restoreConfig } = require('../lib/ibb-tools');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');

/** What Windows itself says each .lnk shortcut points to (Shell.Application ... GetLink.Path). The paths go in and
 *  come out as UTF-8 through a JSON file, so non-English names survive. Returns [] if Windows could not read them. */
function readShortcutTargets(shortcutPaths) {
  const listDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shortcut-targets-'));
  try {
    const listFile = path.join(listDir, 'shortcuts.json');
    fs.writeFileSync(listFile, JSON.stringify(shortcutPaths), 'utf8');
    const script = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n' +
      '$shell = New-Object -ComObject Shell.Application\n' +
      // Assigned first: Windows PowerShell hands a piped JSON array on as ONE item, so looping over the pipeline
      // directly would get both paths at once.
      '$list = Get-Content -Raw -Encoding UTF8 -LiteralPath $env:SHORTCUT_LIST | ConvertFrom-Json\n' +
      'foreach ($p in $list) {\n' +
      '  $item = Get-Item -LiteralPath $p\n' +
      '  Write-Output ($shell.Namespace($item.DirectoryName).ParseName($item.Name).GetLink.Path)\n' +
      '}';
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', env: { ...process.env, SHORTCUT_LIST: listFile } }).trim().split(/\r?\n/);
  } catch {
    return [];
  } finally {
    fs.rmSync(listDir, { recursive: true, force: true });
  }
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
  fs.mkdirSync(junctionTarget);
  fs.symlinkSync(junctionTarget, path.join(tree, 'dangling'), 'junction');
  fs.rmdirSync(junctionTarget);
  fs.mkdirSync(lockedDir);
  fs.writeFileSync(path.join(lockedDir, 'secret.txt'), 's');
  let lockedApplied = false;
  try {
    execFileSync('icacls', [lockedDir, '/deny', '*S-1-1-0:(RD)'], { stdio: 'pipe' });
    try { fs.readdirSync(lockedDir); } catch { lockedApplied = true; }
  } catch { /* icacls unavailable - the links alone still exercise leaving entries out */ }
  console.log(`Scratch tree at ${tree} (a junction to outside, a dangling junction${lockedApplied ? ', a folder that cannot be listed' : ''}).`);

  const bigFiles = path.join(scratchRoot, 'big');
  writeExactSizeFile(path.join(bigFiles, 'big one.bin'), 3_000_000);
  writeExactSizeFile(path.join(bigFiles, 'sub', 'big two.bin'), 5_000_000);
  writeExactSizeFile(path.join(bigFiles, 'small.txt'), 10);
  // A link whose shortcut name is already taken by a real file - the one case a disc scan leaves a link out.
  const clashingLink = path.join(bigFiles, 'a link');
  fs.symlinkSync(outsideFolder, clashingLink, 'junction');
  fs.writeFileSync(clashingLink + '.lnk', 'a real file that happens to have the name');

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
    const expectedNames = ['a.txt', 'dangling.lnk', 'link-to-outside.lnk', path.join('sub', 'b.txt')].sort();
    report(results, 'scanListsEachLinkAsItsShortcutAndNothingBehindIt', JSON.stringify(scannedNames) === JSON.stringify(expectedNames), JSON.stringify(scannedNames));
    const scannedByName = new Map(scan.res.map((e) => [path.relative(tree, e.path), e]));
    report(results, 'aLinkEntryRecordsWhereItPoints',
      scannedByName.get('link-to-outside.lnk')?.stats.linkTarget === outsideFolder && scannedByName.get('dangling.lnk')?.stats.linkTarget === junctionTarget);
    if (lockedApplied) {
      const listed = warnings.length === 1 && Array.isArray(warnings[0].lists) ? warnings[0].lists[0].items : [];
      report(results, 'oneWarningNamesTheFolderThatCannotBeListed',
        warnings.length === 1 && warnings[0].title === 'Some items were left out' && listed.length === 1 && listed[0].startsWith(lockedDir + '  -  '),
        `${warnings.length} warning(s): ${JSON.stringify(listed)}`);
      report(results, 'scanWithoutSkippingFailsOnAFolderThatCannotBeListed', (await callExpectingError(win, 'get-file-paths-with-stats', { dirPath: tree })) !== null);
    } else {
      report(results, 'noWarningWhenNothingIsLeftOut', warnings.length === 0, `${warnings.length} warning(s)`);
    }

    await takeAppErrors(win);
    const plan = await callWorker(win, 'partition-backup-to-optical-media', { rootPath: tree, mediaCapacityInBytes: 4.7e9, splitLargeFiles: false, sessionId, skipUnreadable: true });
    const plannedPaths = plan.res.flat().map((e) => e.path);
    const plannedFiles = plan.res.flat().filter((e) => !e.stats.isDirectory).map((e) => path.relative(tree, e.path)).sort();
    report(results, 'backupPlanningPlansEachLinkAsItsShortcutAndNothingBehindIt',
      JSON.stringify(plannedFiles) === JSON.stringify(expectedNames) && plannedPaths.every((p) => p.startsWith(tree + path.sep))
        && !plannedPaths.some((p) => p.includes(`link-to-outside${path.sep}`))
        && (await takeAppErrors(win)).length === (lockedApplied ? 1 : 0), JSON.stringify(plannedFiles));
    if (lockedApplied) {
      report(results, 'syncComparisonFailsInsteadOfSkipping', (await callExpectingError(win, 'diff', { source: tree, target: bigFiles, comparison: 'any-difference' })) !== null);
    }

    console.log('\nEach link\'s shortcut, created when its disc is sent...');
    const scratchTemp = path.join(scratchRoot, 'app temp folder');
    const outsideBefore = JSON.stringify(fs.readdirSync(outsideFolder));
    const originalConfig = backupAndRedirectConfigField('cacheDataDirectoryPath', scratchTemp);
    try {
      const relPaths = plan.res.flat().filter((e) => !e.stats.isDirectory).map((e) => path.relative(tree, e.path));
      const created = await callWorker(win, 'create-optical-media-disc-partials', { dirPath: tree, paths: relPaths, sessionId });
      const createdByName = new Map(created.res.map((e) => [e.path, e]));
      const shortcut = path.join(scratchTemp, sessionId, 'link-to-outside.lnk');
      const danglingShortcut = path.join(scratchTemp, sessionId, 'dangling.lnk');
      report(results, 'shortcutsAreCreatedInTheTempFolderNeverInTheSource',
        fs.existsSync(shortcut) && fs.existsSync(danglingShortcut) && !fs.existsSync(path.join(tree, 'link-to-outside.lnk')) && !fs.existsSync(path.join(tree, 'dangling.lnk')));
      const shortcutSize = fs.existsSync(shortcut) ? fs.statSync(shortcut).size : -1;
      report(results, 'eachShortcutIsOneSmallFileWithItsLinkTarget',
        shortcutSize > 0 && shortcutSize < 16 * 1024 && createdByName.get('link-to-outside.lnk')?.stats.size === shortcutSize
          && createdByName.get('link-to-outside.lnk')?.stats.linkTarget === outsideFolder, `${shortcutSize} bytes`);
      const targets = readShortcutTargets([shortcut, danglingShortcut]);
      report(results, 'windowsReadsEachShortcutAsPointingWhereItsLinkPoints', targets[0] === outsideFolder && targets[1] === junctionTarget, JSON.stringify(targets));
      const hashes = await callWorker(win, 'compute-sha256-for-backed-up-files', { dirPath: tree, paths: ['link-to-outside.lnk'], sessionId });
      report(results, 'aShortcutIsHashedLikeAnyOtherFile',
        hashes.res.length === 1 && hashes.res[0].sha256 === crypto.createHash('sha256').update(fs.readFileSync(shortcut)).digest('hex'));
      report(results, 'theFolderTheLinksPointToIsUntouched', JSON.stringify(fs.readdirSync(outsideFolder)) === outsideBefore);
    } finally {
      restoreConfig(originalConfig);
    }

    // ---- 2. every too-large file is reported
    console.log('\nFiles too large for a single disc...');
    const tooLarge = await callExpectingError(win, 'partition-backup-to-optical-media', { rootPath: bigFiles, mediaCapacityInBytes: 2_000_000, splitLargeFiles: false, sessionId });
    const reportedPaths = tooLarge && Array.isArray(tooLarge.too_large_files) ? tooLarge.too_large_files.map((f) => f.path).sort() : [];
    const expectedTooLarge = [path.join(bigFiles, 'big one.bin'), path.join(bigFiles, 'sub', 'big two.bin')].sort();
    await takeAppErrors(win);
    const tooLargeAsTheWizardAsks = await callExpectingError(win, 'partition-backup-to-optical-media', { rootPath: bigFiles, mediaCapacityInBytes: 2_000_000, splitLargeFiles: false, sessionId, skipUnreadable: true });
    const warningsWhenStopped = await takeAppErrors(win);
    report(results, 'aPlanThatStopsAtTooLargeFilesShowsNoLeftOutWarning',
      tooLargeAsTheWizardAsks !== null && tooLargeAsTheWizardAsks.err_code === 'FILE_TOO_LARGE_FOR_SINGLE_OPTICAL_DISC' && warningsWhenStopped.length === 0,
      `${warningsWhenStopped.length} warning(s)`);
    await callWorker(win, 'partition-backup-to-optical-media', { rootPath: bigFiles, mediaCapacityInBytes: 4.7e9, splitLargeFiles: false, sessionId, skipUnreadable: true });
    const warningsWhenPlanned = await takeAppErrors(win);
    const leftOutWhenPlanned = warningsWhenPlanned.length === 1 && Array.isArray(warningsWhenPlanned[0].lists) ? warningsWhenPlanned[0].lists[0].items : [];
    report(results, 'aPlanThatGoesAheadNamesTheLinkWhoseShortcutNameIsTaken',
      leftOutWhenPlanned.length === 1 && leftOutWhenPlanned[0].startsWith(clashingLink + '  -  ') && leftOutWhenPlanned[0].includes('already next to it'),
      JSON.stringify(leftOutWhenPlanned));
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
      const drivePlan = await callWorker(win, 'partition-backup-to-optical-media', { rootPath: root, mediaCapacityInBytes: 4.7e9, splitLargeFiles: false, sessionId });
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
    if (lockedApplied) { try { execFileSync('icacls', [lockedDir, '/remove:d', '*S-1-1-0'], { stdio: 'pipe' }); } catch { /* best effort */ } }
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
