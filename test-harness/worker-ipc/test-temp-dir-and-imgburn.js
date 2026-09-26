#!/usr/bin/env node
'use strict';

/**
 * Exercises the app's temp/cache folder safety rules, the per-file lists its clean-up steps report, and how an
 * ImgBurn launch problem is reported - through the app's REAL worker IPC, no UI clicking.
 *
 * Never touches the app's real temp/cache folder: appData/config.json's cacheDataDirectoryPath is pointed at
 * scratch folders under this run's own scratch root (with a space in the name), and imgBurnExecutablePath at a
 * missing path or harmless stub .bat files, for the length of the run - the original config.json is restored
 * byte-for-byte in a finally block (see lib/ibb-tools.js).
 *
 *  1. A fresh folder is created and marked as the app's own; the marker records its exact path.
 *  2. Clearing it deletes the app's own scratch content (split parts) and keeps anything it doesn't recognize -
 *     which comes back
 *     as a list of full paths (notClearedItems), shown as a scrollable list in the "Temp directory not fully
 *     cleared" dialog.
 *  3. A folder whose marker records a different path - what the app folder being copied or moved leaves behind -
 *     is adopted (marker rewritten to the new path) when it only holds the app's own scratch content...
 *  4. ...but refused when it holds anything else (a marker copied into a folder with real content), and clearing
 *     it is refused too, leaving that content untouched.
 *  5. The per-disc clean-up refuses a path outside the temp folder and lists it; the recovery clean-up deletes a
 *     failed file inside the recovery folder, refuses a folder, and lists it - all by full path.
 *  6. ImgBurn: a missing executable shows exactly one "ImgBurn could not be started" error dialog; the .ibb path
 *     is passed as ONE quoted argument even with spaces in it; ImgBurn exiting with an error code after it started
 *     shows nothing (the user may just have closed it).
 *
 * NOTE: needs a real Windows desktop/window session (see call-worker.js's top comment) - run from your own
 * interactive terminal.
 *
 * Usage:
 *   node test-harness/worker-ipc/test-temp-dir-and-imgburn.js
 */

const fs = require('fs');
const path = require('path');
const { launchApp, callWorker, startRecordingAppErrors, takeAppErrors } = require('./call-worker');
const { backupAndRedirectConfigField, restoreConfig } = require('../lib/ibb-tools');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');

// Same name worker.ts gives the marker file (CACHE_DIRECTORY_OWNERSHIP_MARKER_FILENAME).
const MARKER = '.this-directory-was-created-by-my-backup-app-do-not-delete';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function report(results, name, ok, extra) {
  results[name] = ok;
  console.log(`  ${ok ? 'OK' : 'FAILED'} - ${name}${extra ? `  (${extra})` : ''}`);
}

function recordedPath(cacheDir) {
  try { return JSON.parse(fs.readFileSync(path.join(cacheDir, MARKER), 'utf8')).resolvedPath; } catch { return null; }
}

/** Waits up to `ms` for 'app-error' messages to arrive (ImgBurn is launched without being waited for, so its
 *  failure is reported after the request that launched it has already completed) and returns them. */
async function appErrorsWithin(win, ms) {
  const deadline = Date.now() + ms;
  const collected = [];
  while (Date.now() < deadline) {
    collected.push(...await takeAppErrors(win));
    await pause(200);
  }
  collected.push(...await takeAppErrors(win));
  return collected;
}

async function main() {
  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `temp-dir-and-imgburn-${runId}`);
  const cacheA = path.join(scratchRoot, 'cache a');       // what the app starts with
  const cacheMoved = path.join(scratchRoot, 'cache moved');
  const cacheWithUserFile = path.join(scratchRoot, 'cache with a user file');
  fs.mkdirSync(scratchRoot, { recursive: true });

  let originalConfigContent;
  let app, win;
  const results = {};
  try {
    // Pointed at a folder that doesn't exist yet BEFORE launch, so the app's own startup check creates and marks it.
    originalConfigContent = backupAndRedirectConfigField('cacheDataDirectoryPath', cacheA);

    console.log('\nLaunching the app...');
    ({ app, win } = await launchApp());
    // The app's startup checks look at the temp folder too; let them finish before this script changes anything
    // (see ui/test-add-missing-files.js's identical pause) - a startup check that saw one of the deliberately
    // refused folders below would close the app.
    await win.getByText('Cumulative backup', { exact: true }).waitFor({ timeout: 60_000 });
    await pause(3000);
    await startRecordingAppErrors(win);

    // ---- 1. fresh folder
    console.log('\nA fresh temp folder...');
    let ownership = (await callWorker(win, 'ensure-temp-directory-ownership', {})).res;
    report(results, 'freshFolderCreatedAndMarked', ownership.ok === true && recordedPath(cacheA) === path.resolve(cacheA), recordedPath(cacheA));

    // ---- 2. clearing keeps (and lists) what it doesn't recognize
    console.log('\nClearing a temp folder that also holds a file the app did not create...');
    fs.mkdirSync(path.join(cacheA, 'session-1'), { recursive: true });
    fs.writeFileSync(path.join(cacheA, 'session-1', 'movie.mkv.part.001'), 'p');
    fs.writeFileSync(path.join(cacheA, 'notes.txt'), 'not the app\'s');
    let cleared = (await callWorker(win, 'clear-temp-data-directory', {})).res;
    report(results, 'clearDeletesOwnContentAndListsTheRestByFullPath',
      cleared.cleared === false && !fs.existsSync(path.join(cacheA, 'session-1')) && fs.existsSync(path.join(cacheA, 'notes.txt'))
      && cleared.notClearedItems.length === 1 && cleared.notClearedItems[0].startsWith(path.join(cacheA, 'notes.txt') + '  -  '),
      JSON.stringify(cleared.notClearedItems));
    fs.rmSync(path.join(cacheA, 'notes.txt'));

    // ---- 3. moved/copied app folder: stale marker, only the app's own content -> adopted
    console.log('\nA temp folder whose marker records another path (the app folder was copied or moved)...');
    fs.mkdirSync(path.join(cacheMoved, 'session-2'), { recursive: true });
    fs.writeFileSync(path.join(cacheMoved, 'session-2', 'Disk_1.ibb'), 'ibb');
    fs.writeFileSync(path.join(cacheMoved, MARKER), fs.readFileSync(path.join(cacheA, MARKER))); // records cacheA's path
    backupAndRedirectConfigField('cacheDataDirectoryPath', cacheMoved); // true original already captured above
    ownership = (await callWorker(win, 'ensure-temp-directory-ownership', {})).res;
    report(results, 'movedFolderWithOnlyOwnContentIsAdopted',
      ownership.ok === true && recordedPath(cacheMoved) === path.resolve(cacheMoved) && fs.existsSync(path.join(cacheMoved, 'session-2', 'Disk_1.ibb')),
      ownership.message);

    // ---- 4. a copied marker in a folder with real content -> refused, nothing touched
    console.log('\nA copied marker in a folder that holds real content...');
    fs.mkdirSync(cacheWithUserFile, { recursive: true });
    fs.writeFileSync(path.join(cacheWithUserFile, 'my thesis.docx'), 'irreplaceable');
    fs.writeFileSync(path.join(cacheWithUserFile, MARKER), fs.readFileSync(path.join(cacheA, MARKER)));
    backupAndRedirectConfigField('cacheDataDirectoryPath', cacheWithUserFile);
    ownership = (await callWorker(win, 'ensure-temp-directory-ownership', {})).res;
    cleared = (await callWorker(win, 'clear-temp-data-directory', {})).res;
    report(results, 'folderWithUserContentIsRefusedAndLeftUntouched',
      ownership.ok === false && cleared.cleared === false && recordedPath(cacheWithUserFile) === path.resolve(cacheA)
      && fs.readFileSync(path.join(cacheWithUserFile, 'my thesis.docx'), 'utf8') === 'irreplaceable');
    backupAndRedirectConfigField('cacheDataDirectoryPath', cacheA);

    // ---- 5. per-disc and recovery clean-up list what they refuse, by full path
    console.log('\nClean-up steps refusing paths...');
    const outside = path.join(scratchRoot, 'outside the temp folder.part.001');
    fs.writeFileSync(outside, 'o');
    const partials = (await callWorker(win, 'delete-partials-for-disc', { partialAbsolutePaths: [outside] })).res;
    report(results, 'perDiscCleanupRefusesAndListsAPathOutsideTheTempFolder',
      partials.cleared === false && fs.existsSync(outside) && partials.notClearedItems[0].startsWith(outside + '  -  '));
    const recovered = path.join(scratchRoot, 'recovered');
    fs.mkdirSync(path.join(recovered, 'a folder'), { recursive: true });
    fs.writeFileSync(path.join(recovered, 'failed.txt'), 'f');
    const failed = (await callWorker(win, 'delete-recovered-failed-files', {
      failedAbsolutePaths: [path.join(recovered, 'failed.txt'), path.join(recovered, 'a folder')], targetDirectory: recovered,
    })).res;
    report(results, 'recoveryCleanupDeletesTheFileAndListsTheRefusedFolder',
      failed.cleared === false && !fs.existsSync(path.join(recovered, 'failed.txt')) && fs.existsSync(path.join(recovered, 'a folder'))
      && failed.notClearedItems.length === 1 && failed.notClearedItems[0].startsWith(path.join(recovered, 'a folder') + '  -  '));

    // ---- 6. ImgBurn launch reporting
    console.log('\nImgBurn launch problems...');
    const ibbSource = path.join(scratchRoot, 'ibb source');
    fs.mkdirSync(ibbSource, { recursive: true });
    fs.writeFileSync(path.join(ibbSource, 'f.txt'), 'content');
    const sessionId = `session-${runId}`;
    const stubDir = path.join(scratchRoot, 'stub folder with spaces');
    fs.mkdirSync(stubDir, { recursive: true });

    backupAndRedirectConfigField('imgBurnExecutablePath', path.join(scratchRoot, 'no such folder', 'ImgBurn.exe'));
    await takeAppErrors(win);
    await callWorker(win, 'create-IBB-file', { disk_id: 0, paths: ['f.txt'], sourcePath: ibbSource, sessionId, volumeLabel: 'Test Disc 1' });
    const missingErrors = await appErrorsWithin(win, 3000);
    report(results, 'missingImgBurnShowsOneError',
      missingErrors.length === 1 && /^ImgBurn could not be started/.test(missingErrors[0].summary), JSON.stringify(missingErrors.map((e) => e.summary)));

    // The stub hands its arguments to a small Node script, which saves them as UTF-8 JSON - a batch file cannot record
    // them faithfully itself: cmd.exe reads a script's text, and writes echo's output, in the console code page,
    // which garbles non-English names such as the Greek ones in this repository's own path. %~dp0 is the stub's
    // own folder, as Windows passes it (not garbled).
    const argsFile = path.join(stubDir, 'args.json');
    fs.writeFileSync(path.join(stubDir, 'record-args.js'),
      "require('fs').writeFileSync(require('path').join(__dirname, 'args.json'), JSON.stringify(process.argv.slice(2)));\n");
    const echoStub = path.join(stubDir, 'fake imgburn.bat');
    fs.writeFileSync(echoStub, '@echo off\r\nnode "%~dp0record-args.js" %*\r\n');
    backupAndRedirectConfigField('imgBurnExecutablePath', echoStub);
    await callWorker(win, 'create-IBB-file', { disk_id: 1, paths: ['f.txt'], sourcePath: ibbSource, sessionId, volumeLabel: 'Test Disc 2' });
    for (let i = 0; i < 50 && !fs.existsSync(argsFile); i++) { await pause(100); }
    const passedArgs = fs.existsSync(argsFile) ? JSON.parse(fs.readFileSync(argsFile, 'utf8')) : '(the stub was never run)';
    const expectedIbb = path.join(cacheA, sessionId, 'Disk_2.ibb');
    report(results, 'ibbPathPassedAsOneQuotedArgument',
      JSON.stringify(passedArgs) === JSON.stringify(['/MODE', 'BUILD', '/SRC', expectedIbb]), JSON.stringify(passedArgs));

    const failingStub = path.join(stubDir, 'exits with 3.bat');
    fs.writeFileSync(failingStub, '@echo off\r\nexit /b 3\r\n');
    backupAndRedirectConfigField('imgBurnExecutablePath', failingStub);
    await takeAppErrors(win);
    await callWorker(win, 'create-IBB-file', { disk_id: 2, paths: ['f.txt'], sourcePath: ibbSource, sessionId, volumeLabel: 'Test Disc 3' });
    const exitErrors = await appErrorsWithin(win, 3000);
    report(results, 'imgBurnExitingWithAnErrorCodeShowsNothing', exitErrors.length === 0, JSON.stringify(exitErrors.map((e) => e.summary)));
  } finally {
    if (app) { await app.close().catch(() => {}); }
    if (originalConfigContent !== undefined) { restoreConfig(originalConfigContent); }
  }

  const pass = Object.keys(results).length > 0 && Object.values(results).every(Boolean);
  console.log('\nSummary:');
  for (const [check, ok] of Object.entries(results)) { console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${check}`); }
  if (pass) {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  } else {
    console.log(`\nLeaving scratch files in place for inspection: ${scratchRoot}`);
  }
  console.log(`\n${pass ? 'PASS' : 'FAIL'} - temp folder safety, clean-up lists and ImgBurn launch reporting ${pass ? 'behaved correctly.' : 'did not behave as expected, see above.'}`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => {
  console.error('\nTEST ERRORED:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
