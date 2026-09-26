#!/usr/bin/env node
'use strict';

/**
 * Names too long for a disc (over 127 characters - see app/workers/disc-names.ts), through the app's REAL worker IPC
 * and a REAL ImgBurn build, no UI clicking:
 *
 *  1. create-IBB-file names every file and folder as it will be on the disc: a name over 127 characters (a file, a
 *     folder, an empty folder, a name with an emoji, a split file's pieces) gets its shorter disc name, a name of
 *     exactly 127 keeps its own; every line still points at the untouched original in the source (or the temp
 *     folder, for a piece). The disc also gets the list of original names, whose stats come back for the JSON.
 *  2. The real ImgBurn builds an image from that project without changing a single name (no warning in its log),
 *     and the mounted image holds exactly those names, with the right contents.
 *  3. Recovery's copy (incremental-copy-files with sourcePaths, as the recovery wizard sends it) puts every file
 *     back under its original name, read from the disc's own list of original names.
 *  4. Refused: a disc on which the list of original names would take the name of a file of the user's; a recovery
 *     path, or a disc path, leading outside its folder.
 *  5. The source files are never renamed or changed.
 *  6. A real 700 MB file whose 120-character name fits on a disc but whose pieces' names (".part.001" added) do not,
 *     the whole way: planned and split for real (the wizard's dialog would list the file itself, once), both discs
 *     built by the real ImgBurn without a warning, each recovered under the original piece names, and the pieces
 *     rejoined by merge-file-parts (7-Zip) into the file under its own name - byte for byte the original.
 *  Last, clearing the temp folder removes everything left there, the lists of original names included.
 *
 * Never touches the app's real temp folder: cacheDataDirectoryPath points at a scratch folder, and
 * imgBurnExecutablePath at a no-op stub (the real ImgBurn is only run by this script itself, headless), for the
 * length of the run - config.json is restored byte-for-byte in a finally block.
 *
 * NOTE: needs a real Windows desktop/window session (see call-worker.js's top comment), and ImgBurn configured in
 * appData/config.json. Refuses to run while an optical drive has a disc in it (it mounts an image).
 *
 * Usage:
 *   node test-harness/worker-ipc/test-long-names-on-disc.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { launchApp, callWorker } = require('./call-worker');
const { backupAndRedirectConfigField, restoreConfig, writeStubImgBurnBat, parseIbbBackupList } = require('../lib/ibb-tools');
const { realImgBurnPath, buildIsoWithImgBurn } = require('../lib/imgburn-build');
const { assertNoOpticalMediaAlreadyMounted, mountIso, dismountIso } = require('../ui/iso-disc');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');
const { writeRandomFile } = require('../lib/random-file-writer');
const { discPath, itemsWithNamesTooLong, ORIGINAL_NAMES_FILE_NAME, MAX_DISC_NAME_LENGTH } = require('../../app/workers/disc-names');

// The name that started it all: 138 characters.
const PAPER = 'End-to-End_Modeling_of_Hierarchical_Time_Series_Using_Autoregressive_Transformer_and_Conditional_Normalizing_Flow-based_Reconciliation.pdf';
const GREEK_FOLDER = 'Φάκελος_' + 'α'.repeat(125);                          // 133
const EMOJI_FILE = 'x'.repeat(122) + '\u{1F600}\u{1F600}.txt';               // 130 UTF-16 units
const EXACTLY_127 = 'e'.repeat(123) + '.txt';
const EMPTY_LONG_FOLDER = 'E'.repeat(130);
// Section 6: fits on a disc (120), its pieces' names (129) do not. Split into two pieces on two CDs (see
// test-large-file-split.js for the 700 MB / 500 MiB / CD arithmetic).
const SPLIT_FILE = 'videos\\Conference_talk_recording_' + 'r'.repeat(90) + '.mkv';
const SPLIT_FILE_BYTES = 700_000_000;
const CD = { capacity: 700_000_000, maxRepletionRatio: 0.93 };

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sha256Streamed = (file) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  fs.createReadStream(file).on('error', reject).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
});

function report(results, name, ok, extra) {
  results[name] = ok;
  console.log(`  ${ok ? 'OK' : 'FAILED'} - ${name}${extra ? `  (${extra})` : ''}`);
}

/** Every file (relative path) and empty folder (relative path + "\") under `root`, sorted. */
function listTree(root) {
  const out = [];
  (function walk(dir, rel) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    if (entries.length === 0 && rel) { out.push(rel + '\\'); }
    for (const e of entries) {
      const r = rel ? rel + '\\' + e.name : e.name;
      if (e.isDirectory()) { walk(path.join(dir, e.name), r); } else { out.push(r); }
    }
  })(root, '');
  return out.sort();
}

/** Name, size, modified time and content hash of every file under `root` - to prove nothing there changed. */
function snapshot(root) {
  return listTree(root).map((rel) => {
    const full = path.join(root, rel);
    const st = fs.statSync(full);
    return rel.endsWith('\\') ? rel : `${rel} ${st.size} ${st.mtimeMs} ${sha256(full)}`;
  }).join('\n');
}

async function main() {
  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `long-names-on-disc-${runId}`);
  const source = path.join(scratchRoot, 'source');
  const cache = path.join(scratchRoot, 'app temp');
  const recovered = path.join(scratchRoot, 'recovered');
  const outsideRecovered = path.join(scratchRoot, 'escaped.txt');
  const isoPath = path.join(scratchRoot, 'disc.iso');
  const sessionId = `session-${runId}`;
  const sessionDir = path.join(cache, sessionId);

  // The source: every kind of name too long for a disc, next to ordinary ones.
  const files = {
    [`papers\\${PAPER}`]: 'the paper',
    [`${GREEK_FOLDER}\\inner.txt`]: 'inside a folder whose name is too long',
    [`emoji\\${EMOJI_FILE}`]: 'a name with emoji right where it would be cut',
    [`edge\\${EXACTLY_127}`]: 'exactly 127 characters - kept as it is',
    ['ok\\short.txt']: 'nothing special',
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(source, rel)), { recursive: true });
    fs.writeFileSync(path.join(source, rel), content);
  }
  fs.mkdirSync(path.join(source, EMPTY_LONG_FOLDER), { recursive: true });
  // A split file's two pieces, as createOpticalMediaDiscPartials leaves them in the session's temp folder.
  const pieces = { [`big\\${PAPER}.part.001`]: 'piece one', [`big\\${PAPER}.part.002`]: 'piece two' };
  // What a wizard sends: every planned path, relative to the disc's root - an empty folder with its "\".
  const planned = [...Object.keys(files), EMPTY_LONG_FOLDER + '\\', ...Object.keys(pieces)];
  const sourceBefore = snapshot(source);

  let originalConfigContent;
  let app, win;
  const mountedIsos = new Set();
  const mount = (iso) => { const drive = mountIso(iso); mountedIsos.add(iso); return drive.DriveLetter + '\\'; };
  const dismount = (iso) => { dismountIso(iso); mountedIsos.delete(iso); };
  const results = {};
  try {
    originalConfigContent = backupAndRedirectConfigField('cacheDataDirectoryPath', cache);
    const imgBurnExe = realImgBurnPath(originalConfigContent);
    const stub = path.join(scratchRoot, 'stub imgburn.bat');
    writeStubImgBurnBat(stub);
    backupAndRedirectConfigField('imgBurnExecutablePath', stub);
    assertNoOpticalMediaAlreadyMounted();

    console.log('\nLaunching the app...');
    ({ app, win } = await launchApp());
    await win.getByText('Cumulative backup', { exact: true }).waitFor({ timeout: 60_000 });
    await pause(3000); // let the app's own startup temp-folder check finish first (see test-temp-dir-and-imgburn.js)
    await callWorker(win, 'ensure-temp-directory-ownership', {});
    for (const [rel, content] of Object.entries(pieces)) {
      fs.mkdirSync(path.dirname(path.join(sessionDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(sessionDir, rel), content);
    }

    // ---- 1. the project
    console.log('\nThe ImgBurn project for a disc with names too long for it...');
    const project = (await callWorker(win, 'create-IBB-file', { disk_id: 0, paths: planned, sourcePath: source, sessionId, volumeLabel: 'Long names' })).res;
    const expectedDiscPaths = {};
    for (const p of planned) { if (discPath(p) !== p) { expectedDiscPaths[p] = discPath(p); } }
    report(results, 'responseNamesEveryShortenedPathOnTheDisc',
      JSON.stringify(project.discPaths) === JSON.stringify(expectedDiscPaths) && Object.keys(expectedDiscPaths).length === 6,
      `${Object.keys(project.discPaths).length} shortened`);

    const entries = parseIbbBackupList(path.join(sessionDir, 'Disk_1.ibb'));
    const onDisc = (e) => (e.parentPath === '\\' ? '' : e.parentPath.slice(1) + '\\') + e.name;
    report(results, 'noNameInTheProjectIsOver127',
      entries.every((e) => e.name.length <= MAX_DISC_NAME_LENGTH), entries.map((e) => e.name.length).sort((a, b) => b - a).slice(0, 3).join(', '));
    const fileLines = new Map(entries.filter((e) => e.type === 'F').map((e) => [onDisc(e), e.fullSourcePath]));
    const everyFileAtItsDiscPathFromItsOriginal = Object.keys(files).every((rel) => fileLines.get(discPath(rel)) === path.join(source, rel))
      && Object.keys(pieces).every((rel) => fileLines.get(discPath(rel)) === path.join(sessionDir, rel));
    report(results, 'everyFileIsAtItsDiscPathAndReadFromItsUntouchedOriginal', everyFileAtItsDiscPathFromItsOriginal);
    report(results, 'aNameOfExactly127IsKept', fileLines.has(`edge\\${EXACTLY_127}`));
    const pieceNames = Object.keys(pieces).map((rel) => discPath(rel).split('\\').pop());
    report(results, 'piecesKeepTheirEndingAndShareOneStart',
      /\.part\.001$/.test(pieceNames[0]) && /\.part\.002$/.test(pieceNames[1]) && pieceNames[0].slice(0, -4) === pieceNames[1].slice(0, -4), pieceNames.join(' | '));
    report(results, 'theEmptyFolderIsShortenedToo',
      entries.some((e) => e.type === 'D' && e.parentPath === '\\' && e.name === discPath(EMPTY_LONG_FOLDER)));

    const namesFileTemp = path.join(sessionDir, 'Disk_1.original-names.json');
    const namesFile = JSON.parse(fs.readFileSync(namesFileTemp, 'utf8'));
    const expectedOriginals = {};
    for (const [original, shortened] of Object.entries(expectedDiscPaths)) { expectedOriginals[shortened] = original; }
    report(results, 'theDiscGetsTheListOfOriginalNamesAtItsRoot',
      fileLines.get(ORIGINAL_NAMES_FILE_NAME) === namesFileTemp && JSON.stringify(namesFile.originalPaths) === JSON.stringify(expectedOriginals)
      && project.originalNamesFile && project.originalNamesFile.sha256 === sha256(namesFileTemp) && project.originalNamesFile.size === fs.statSync(namesFileTemp).size);

    // ---- 2. a real ImgBurn build
    console.log('\nBuilding the disc image with the real ImgBurn...');
    const build = buildIsoWithImgBurn(imgBurnExe, path.join(sessionDir, 'Disk_1.ibb'), isoPath, path.join(scratchRoot, 'imgburn.log'));
    report(results, 'imgBurnBuildsItWithoutChangingAName', build.built && build.problems.length === 0, build.problems.join(' / '));
    const discRoot = mount(isoPath);
    const expectedOnDisc = [...Object.keys(files), ...Object.keys(pieces), EMPTY_LONG_FOLDER + '\\'].map(discPath).concat(ORIGINAL_NAMES_FILE_NAME).sort();
    const actualOnDisc = listTree(discRoot);
    report(results, 'theDiscHoldsExactlyTheseNames', JSON.stringify(actualOnDisc) === JSON.stringify(expectedOnDisc),
      actualOnDisc.length + ' entries');
    const contentsMatch = Object.entries({ ...files, ...pieces }).every(([rel, content]) => {
      try { return fs.readFileSync(path.join(discRoot, discPath(rel)), 'utf8') === content; } catch { return false; }
    });
    report(results, 'everyFileOnTheDiscHasItsContent', contentsMatch);

    // ---- 3. recovery puts the original names back
    console.log('\nRecovering from the disc, by its own list of original names...');
    const listOnDisc = JSON.parse(fs.readFileSync(path.join(discRoot, ORIGINAL_NAMES_FILE_NAME), 'utf8'));
    const sourcePaths = {};
    for (const [shortened, original] of Object.entries(listOnDisc.originalPaths)) { sourcePaths[original] = shortened; }
    fs.mkdirSync(recovered, { recursive: true });
    await callWorker(win, 'incremental-copy-files', { sourceOnlyPaths: planned, source: discRoot, target: recovered, sourcePaths });
    const expectedRecovered = planned.slice().sort();
    const actualRecovered = listTree(recovered);
    const recoveredContents = Object.entries({ ...files, ...pieces }).every(([rel, content]) => {
      try { return fs.readFileSync(path.join(recovered, rel), 'utf8') === content; } catch { return false; }
    });
    report(results, 'recoveryPutsEveryOriginalNameBack',
      JSON.stringify(actualRecovered) === JSON.stringify(expectedRecovered) && recoveredContents, `${actualRecovered.length} entries`);

    // ---- 4. refusals
    console.log('\nWhat must be refused...');
    fs.writeFileSync(path.join(source, ORIGINAL_NAMES_FILE_NAME), 'a file of the user\'s that happens to have that name');
    const clash = await callWorker(win, 'create-IBB-file', {
      disk_id: 1, paths: [ORIGINAL_NAMES_FILE_NAME, `papers\\${PAPER}`], sourcePath: source, sessionId, volumeLabel: 'Clash',
    }).then(() => null, (e) => e.message);
    report(results, 'aDiscWhoseListWouldTakeTheNameOfAUserFileIsRefused',
      !!clash && /same name/.test(clash) && !fs.existsSync(path.join(sessionDir, 'Disk_2.ibb')), clash ? clash.slice(0, 120) : 'not refused');
    fs.rmSync(path.join(source, ORIGINAL_NAMES_FILE_NAME));

    // Each would succeed without the check: the file to copy exists, one folder up from where it may be read.
    const recoveredBefore = snapshot(recovered);
    const escapeSource = path.join(scratchRoot, 'a', 'b');
    fs.mkdirSync(escapeSource, { recursive: true });
    fs.writeFileSync(path.join(scratchRoot, 'a', 'escaped.txt'), 'must not leave the recovery folder');
    const escapeByPath = await callWorker(win, 'incremental-copy-files', { sourceOnlyPaths: ['..\\escaped.txt'], source: escapeSource, target: recovered })
      .then(() => null, (e) => e.message);
    const escapeByDiscPath = await callWorker(win, 'incremental-copy-files', {
      sourceOnlyPaths: ['from-outside.txt'], source: path.join(discRoot, 'ok'), target: recovered, sourcePaths: { 'from-outside.txt': `..\\${ORIGINAL_NAMES_FILE_NAME}` },
    }).then(() => null, (e) => e.message);
    const refused = (message) => !!message && /is not inside/.test(message);
    report(results, 'recoveryRefusesPathsLeadingOutsideItsFolders',
      refused(escapeByPath) && refused(escapeByDiscPath) && !fs.existsSync(outsideRecovered) && snapshot(recovered) === recoveredBefore,
      `${refused(escapeByPath) ? 'target refused' : 'TARGET NOT REFUSED'}, ${refused(escapeByDiscPath) ? 'source refused' : 'SOURCE NOT REFUSED'}`);

    // ---- 5. the user's files
    report(results, 'theSourceFilesAreUntouched', snapshot(source) === sourceBefore);
    dismount(isoPath);

    // ---- 6. a split file whose pieces' names are too long, the whole way
    console.log('\nA real 700 MB file whose pieces\' names are too long for a disc...');
    const largeSource = path.join(scratchRoot, 'large source');
    const largeFile = path.join(largeSource, SPLIT_FILE);
    fs.mkdirSync(path.dirname(largeFile), { recursive: true });
    const largeFileSha256 = writeRandomFile(largeFile, SPLIT_FILE_BYTES);
    const largeFileStatsBefore = fs.statSync(largeFile);
    const sessionId2 = `session-${runId + 1}`;
    const sessionDir2 = path.join(cache, sessionId2);
    const plan = (await callWorker(win, 'partition-backup-to-optical-media', {
      rootPath: largeSource, mediaCapacityInBytes: CD.capacity, maxRepletionRatio: CD.maxRepletionRatio, splitLargeFiles: true, sessionId: sessionId2,
    }, 60_000)).res;
    const plannedByDisc = plan.map((disc) => disc.map((e) => path.relative(sessionDir2, e.path)));
    const listed = itemsWithNamesTooLong(plannedByDisc.flat());
    report(results, 'itsNameFitsButItsPiecesDoNot_theDialogListsTheFileOnce',
      SPLIT_FILE.split('\\').pop().length <= MAX_DISC_NAME_LENGTH && plannedByDisc.length === 2
      && JSON.stringify(listed) === JSON.stringify([SPLIT_FILE]), `${plannedByDisc.length} discs; listed: ${listed.join(', ')}`);

    const recoveredLarge = path.join(scratchRoot, 'recovered large');
    fs.mkdirSync(recoveredLarge, { recursive: true });
    const discNamesOk = [];
    for (let d = 0; d < plannedByDisc.length; d++) {
      // What "Send to ImgBurn" does for disc d: the real split (the first time), then the project.
      const discFiles = (await callWorker(win, 'create-optical-media-disc-partials', { dirPath: largeSource, paths: plannedByDisc[d], sessionId: sessionId2 }, 10 * 60_000)).res;
      await callWorker(win, 'create-IBB-file', { disk_id: d, paths: discFiles.map((e) => e.path), sourcePath: largeSource, sessionId: sessionId2, volumeLabel: `Split ${d + 1}` });
      const iso = path.join(scratchRoot, `split disc ${d + 1}.iso`);
      const splitBuild = buildIsoWithImgBurn(imgBurnExe, path.join(sessionDir2, `Disk_${d + 1}.ibb`), iso, path.join(scratchRoot, `imgburn split ${d + 1}.log`));
      const root = mount(iso);
      const onThisDisc = listTree(root);
      discNamesOk.push(splitBuild.built && splitBuild.problems.length === 0
        && JSON.stringify(onThisDisc) === JSON.stringify(discFiles.map((e) => discPath(e.path)).concat(ORIGINAL_NAMES_FILE_NAME).sort()));
      // Recover this disc, as the wizard does: each piece under its original name, read from the disc's own list.
      const list = JSON.parse(fs.readFileSync(path.join(root, ORIGINAL_NAMES_FILE_NAME), 'utf8'));
      const piecePaths = {};
      for (const [shortened, original] of Object.entries(list.originalPaths)) { piecePaths[original] = shortened; }
      await callWorker(win, 'incremental-copy-files', { sourceOnlyPaths: Object.keys(piecePaths), source: root, target: recoveredLarge, sourcePaths: piecePaths }, 10 * 60_000);
      dismount(iso);
    }
    report(results, 'bothDiscsAreBuiltWithTheirPiecesShortenedAndNothingElseChanged', discNamesOk.length === 2 && discNamesOk.every(Boolean), JSON.stringify(discNamesOk));
    const recoveredPieces = listTree(recoveredLarge);
    report(results, 'bothPiecesAreRecoveredUnderTheirOriginalNames',
      JSON.stringify(recoveredPieces) === JSON.stringify([`${SPLIT_FILE}.part.001`, `${SPLIT_FILE}.part.002`]), recoveredPieces.join(' | '));

    const merged = (await callWorker(win, 'merge-file-parts', {
      partFilePaths: recoveredPieces.map((rel) => path.join(recoveredLarge, rel)), originalFileName: SPLIT_FILE.split('\\').pop(),
    }, 10 * 60_000)).res;
    const rejoined = path.join(recoveredLarge, SPLIT_FILE);
    const rejoinedSha256 = fs.existsSync(rejoined) ? await sha256Streamed(rejoined) : '(missing)';
    report(results, 'thePiecesRejoinIntoTheFileUnderItsOwnName_byteForByte',
      merged.merged === true && rejoinedSha256 === largeFileSha256 && JSON.stringify(listTree(recoveredLarge)) === JSON.stringify([SPLIT_FILE]),
      merged.message);
    const largeFileStatsAfter = fs.statSync(largeFile);
    report(results, 'theLargeSourceFileIsUntouched',
      largeFileStatsAfter.size === largeFileStatsBefore.size && largeFileStatsAfter.mtimeMs === largeFileStatsBefore.mtimeMs
      && (await sha256Streamed(largeFile)) === largeFileSha256);

    // ---- the temp folder
    const cleared = (await callWorker(win, 'clear-temp-data-directory', {})).res;
    report(results, 'clearingTheTempFolderRemovesTheListsOfOriginalNamesAndThePieces',
      cleared.cleared === true && !fs.existsSync(sessionDir) && !fs.existsSync(sessionDir2), cleared.cleared ? '' : JSON.stringify(cleared.notClearedItems));
  } finally {
    if (app) { await app.close().catch(() => {}); }
    if (originalConfigContent !== undefined) { restoreConfig(originalConfigContent); }
    for (const iso of mountedIsos) { try { dismountIso(iso); } catch { /* reported by the failure itself */ } }
  }

  const pass = Object.keys(results).length > 0 && Object.values(results).every(Boolean);
  console.log('\nSummary:');
  for (const [check, ok] of Object.entries(results)) { console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${check}`); }
  if (pass) {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  } else {
    console.log(`\nLeaving scratch files in place for inspection: ${scratchRoot}`);
  }
  console.log(`\n${pass ? 'PASS' : 'FAIL'} - names too long for a disc ${pass ? 'are shortened on the disc only, and recovered under their original names.' : 'were not handled as expected, see above.'}`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => {
  console.error('\nTEST ERRORED:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
