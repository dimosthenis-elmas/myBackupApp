#!/usr/bin/env node
'use strict';

/**
 * A large file split across discs, finished in a later session - through the app's real worker IPC and real 7-Zip.
 * Each piece is named "<file>.outOf.<total>.part.NNN" (app/workers/split-pieces.ts), and a disc is recorded in the
 * metadata JSON as soon as it is confirmed burned, so a job can end - the app closed - with only some pieces of a
 * file on discs. "Add missing files" then plans only the missing pieces (partition-backup-to-optical-media's
 * incompleteSplitFiles), splits the file again, and must burn pieces that fit together with those already on discs:
 *  1. Session 1: a 1.1 GB file is planned as 3 pieces, named "... outOf.3 ..."; only piece 1 is split and "burned"
 *     (kept aside, its SHA-256 recorded as the wizard does), then the app closes.
 *  2. Session 2: planning with piece 1 on a disc plans exactly pieces 2 and 3; splitting leaves just those two in the
 *     temp folder.
 *  3. Rejoining with piece 2 missing is refused, naming it ("Pieces missing: 2 (of 3)"), and deletes nothing; with
 *     all three - piece 1 from session 1, pieces 2 and 3 from session 2 - the file is rejoined byte for byte.
 *  4. Session 3: the file has changed (same size) since piece 1 was burned - splitting it for its missing pieces is
 *     refused, and no piece of it is left in the temp folder.
 *  5. A sliver: a file planned as 2 pieces that 7-Zip splits into 3. Sending piece 1's disc gives piece 1 and the
 *     sliver, and all three pieces are named "... outOf.3 ...". In a later session with pieces 1 and 3 burned, only
 *     piece 2 is planned, the new split gives back the burned sliver (SHA-256) and no new one; with only piece 1 burned,
 *     pieces 2 and 3 are planned. Both times the three pieces rejoin into the file byte for byte.
 *
 * Touches the app's real temp folder (no per-test override exists - see temp-dir-guard.js) - refuses to run unless
 * it is empty (besides the app's own ownership marker), same as test-large-file-split.js.
 *
 * NOTE: needs a real Windows desktop/window session (see call-worker.js's top comment) - run from your own
 * interactive terminal.
 *
 * Usage:
 *   node test-harness/worker-ipc/test-split-file-resume.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { launchApp, callWorker } = require('./call-worker');
const { assertRealTempDataDirectoryIsSafeToUse } = require('./temp-dir-guard');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');

// Two full 500 MiB pieces (LARGE_FILE_SPLIT_VOLUME_SIZE_MIB in worker.ts) and a remainder of 51,424,000 bytes - far
// from the boundary where 7-Zip makes one piece more than planned (test-large-file-split-boundary.js).
const LARGE_FILE_BYTES = 1_100_000_000;
const PIECE_COUNT = 3;
// One full piece fits (600,000,000 * 0.95), the whole file does not - see test-large-file-split.js.
const MEDIA_CAPACITY_BYTES = 600_000_000;
const MAX_REPLETION_RATIO = 0.95;
const FILE_NAME = 'big.bin';
const FILE_FOLDER = 'videos';
// 50 bytes short of two full pieces: planned as 2, but 7-Zip's own few bytes of overhead make it 3 - the last one a
// "sliver" of a few bytes (see test-large-file-split-boundary.js).
const SLIVER_FILE_BYTES = 2 * 500 * 1024 * 1024 - 50;
const SLIVER_FILE_NAME = 'sliver.bin';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const pieceName = (n) => `${FILE_NAME}.outOf.${PIECE_COUNT}.part.${String(n).padStart(3, '0')}`;

function sha256Streamed(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath).on('error', reject).on('data', (d) => hash.update(d)).on('end', () => resolve(hash.digest('hex')));
  });
}

/** A sparse file of `size` bytes with 32 bytes derived from `seed` every 100 MB, so every piece has content of its
 *  own, and a different seed changes the file without changing its size. */
function writeLargeFile(filePath, seed, size = LARGE_FILE_BYTES) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, 'w');
  fs.ftruncateSync(fd, size);
  for (let offset = 0; offset < size; offset += 100_000_000) {
    const block = crypto.createHash('sha256').update(`${seed}:${offset}`).digest();
    fs.writeSync(fd, block, 0, block.length, offset);
  }
  fs.closeSync(fd);
}

async function main() {
  console.log('Checking the app\'s real temp/cache directory is safe to use...');
  const tempDir = assertRealTempDataDirectoryIsSafeToUse();
  console.log(`OK - using: ${tempDir}`);

  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `split-file-resume-${runId}`);
  const sourceRoot = path.join(scratchRoot, 'source');
  const largeFile = path.join(sourceRoot, FILE_FOLDER, FILE_NAME);
  const burnedDisc = path.join(scratchRoot, 'disc 1');
  const recovered = path.join(scratchRoot, 'recovered');

  console.log(`\nWriting a ${LARGE_FILE_BYTES.toLocaleString()}-byte file at ${largeFile}...`);
  writeLargeFile(largeFile, 'original');
  const originalSha256 = await sha256Streamed(largeFile);
  const fileMetadata = () => {
    const s = fs.statSync(largeFile);
    return [{ path: largeFile, stats: { size: s.size, mtime: s.mtime, isDirectory: false } }];
  };

  const results = {};
  const report = (name, ok, detail = '') => {
    results[name] = !!ok;
    console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? `  (${detail})` : ''}`);
  };
  const sessionDirs = [];
  const newSession = () => {
    const id = `session-${Date.now()}`;
    sessionDirs.push(path.join(tempDir, id));
    return id;
  };
  // A plan's pieces as a wizard sends them: relative to the job's session folder.
  const plannedPaths = (plan, sessionId) => plan.res.flat().map((e) => path.relative(path.join(tempDir, sessionId), e.path)).sort();
  const inFolder = (n) => `${FILE_FOLDER}\\${pieceName(n)}`;
  const plan = (sessionId, extra) => callWorker(win, 'partition-backup-to-optical-media', {
    rootPath: sourceRoot, mediaCapacityInBytes: MEDIA_CAPACITY_BYTES, maxRepletionRatio: MAX_REPLETION_RATIO,
    splitLargeFiles: true, sessionId, ...extra,
  }, 60_000);
  const split = (sessionId, paths) => callWorker(win, 'create-optical-media-disc-partials', { dirPath: sourceRoot, paths, sessionId }, 10 * 60_000);
  const launch = async () => {
    ({ app, win } = await launchApp());
    await pause(3000); // let the app's own startup temp-folder check finish first (see test-large-file-split.js)
  };

  let app, win;
  try {
    // ---- 1. Session 1
    console.log('\n1. Session 1: plan, then split and "burn" piece 1 only; the app closes...');
    await launch();
    const session1 = newSession();
    const planned1 = plannedPaths(await plan(session1, {}), session1);
    report('allThreePiecesArePlannedNamedWithTheirTotal', JSON.stringify(planned1) === JSON.stringify([1, 2, 3].map(inFolder)), planned1.join(' | '));
    const disc1 = (await split(session1, [inFolder(1)])).res;
    report('piece1IsSplitUnderItsName', disc1.length === 1 && disc1[0].path === inFolder(1), disc1.map((e) => e.path).join(' | '));
    const piece1Sha256 = (await callWorker(win, 'compute-sha256-for-backed-up-files', { dirPath: sourceRoot, paths: [inFolder(1)], sessionId: session1 }, 10 * 60_000)).res[0].sha256;
    fs.mkdirSync(burnedDisc, { recursive: true });
    fs.copyFileSync(path.join(tempDir, session1, inFolder(1)), path.join(burnedDisc, pieceName(1)));
    await app.close();
    app = undefined;
    // What the app offers to clear at its next start.
    fs.rmSync(path.join(tempDir, session1), { recursive: true, force: true });

    // ---- 2. Session 2
    console.log('\n2. Session 2 ("Add missing files" with the JSON): piece 1 is on a disc...');
    await launch();
    const incomplete = [{ path: largeFile, total: PIECE_COUNT, burnedPieces: [{ number: 1, sha256: piece1Sha256 }] }];
    const session2 = newSession();
    const planned2 = plannedPaths(await plan(session2, { filesMetadata: fileMetadata(), incompleteSplitFiles: incomplete }), session2);
    report('onlyTheMissingPiecesArePlanned', JSON.stringify(planned2) === JSON.stringify([2, 3].map(inFolder)), planned2.join(' | '));
    const sent2 = (await split(session2, planned2)).res.map((e) => e.path).sort();
    report('theyAreSplitUnderTheirNames', JSON.stringify(sent2) === JSON.stringify([2, 3].map(inFolder)), sent2.join(' | '));
    const temp2 = path.join(tempDir, session2, FILE_FOLDER);
    const inTemp2 = fs.readdirSync(temp2).sort();
    report('onlyTheyAreLeftInTheTempFolder', JSON.stringify(inTemp2) === JSON.stringify([2, 3].map(pieceName)), inTemp2.join(' | '));

    // ---- 3. Rejoining
    console.log('\n3. Rejoining: piece 1 from session 1, pieces 2 and 3 from session 2...');
    fs.mkdirSync(recovered, { recursive: true });
    fs.copyFileSync(path.join(burnedDisc, pieceName(1)), path.join(recovered, pieceName(1)));
    fs.copyFileSync(path.join(temp2, pieceName(3)), path.join(recovered, pieceName(3)));
    const withoutPiece2 = (await callWorker(win, 'merge-file-parts', {
      partFilePaths: [1, 3].map((n) => path.join(recovered, pieceName(n))), originalFileName: FILE_NAME,
    })).res;
    report('withPiece2MissingItIsNamedAndNothingIsDeleted',
      withoutPiece2.merged === false && withoutPiece2.message.startsWith('Pieces missing: 2 (of 3)') && fs.readdirSync(recovered).length === 2,
      withoutPiece2.message);
    fs.copyFileSync(path.join(temp2, pieceName(2)), path.join(recovered, pieceName(2)));
    const merged = (await callWorker(win, 'merge-file-parts', {
      partFilePaths: [1, 2, 3].map((n) => path.join(recovered, pieceName(n))), originalFileName: FILE_NAME,
    }, 10 * 60_000)).res;
    const rejoined = path.join(recovered, FILE_NAME);
    const rejoinedSha256 = fs.existsSync(rejoined) ? await sha256Streamed(rejoined) : '(missing)';
    report('allThreeRejoinIntoTheFile_byteForByte', merged.merged === true && rejoinedSha256 === originalSha256, merged.message);
    fs.rmSync(path.join(tempDir, session2), { recursive: true, force: true });

    // ---- 4. Session 3: the file changed
    console.log('\n4. Session 3: the file has changed since piece 1 was burned...');
    writeLargeFile(largeFile, 'changed');
    const session3 = newSession();
    const planned3 = plannedPaths(await plan(session3, { filesMetadata: fileMetadata(), incompleteSplitFiles: incomplete }), session3);
    let refusal = '';
    try {
      await split(session3, planned3);
    } catch (error) {
      refusal = error.message;
    }
    report('splittingItForItsMissingPiecesIsRefused', refusal.includes('can no longer be split into the pieces already on your discs'),
      refusal.slice(0, 300));
    const temp3 = path.join(tempDir, session3, FILE_FOLDER);
    const leftIn3 = fs.existsSync(temp3) ? fs.readdirSync(temp3) : [];
    report('noPieceOfItIsLeftBehind', leftIn3.length === 0, leftIn3.join(' | '));

    // ---- 5. A sliver
    console.log('\n5. A file split into one piece more than planned (a sliver), finished in later sessions...');
    const sliverFile = path.join(sourceRoot, FILE_FOLDER, SLIVER_FILE_NAME);
    writeLargeFile(sliverFile, 'sliver', SLIVER_FILE_BYTES);
    const sliverSha256 = await sha256Streamed(sliverFile);
    const sliverMetadata = () => {
      const s = fs.statSync(sliverFile);
      return [{ path: sliverFile, stats: { size: s.size, mtime: s.mtime, isDirectory: false } }];
    };
    const sliverName = (total, n) => `${SLIVER_FILE_NAME}.outOf.${total}.part.${String(n).padStart(3, '0')}`;
    const sliverIn = (total, n) => `${FILE_FOLDER}\\${sliverName(total, n)}`;
    const sliverPiecesIn = (folder) => fs.readdirSync(folder).filter((n) => n.startsWith(SLIVER_FILE_NAME)).sort();
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    /** Copies pieces 1 to 3 into a fresh folder, each from `folderOf(its number)`, and rejoins them there; true if the
     *  file comes back byte for byte. */
    const rejoinSliverFile = async (label, folderOf) => {
      const folder = path.join(scratchRoot, `rejoined ${label}`);
      fs.mkdirSync(folder, { recursive: true });
      for (const n of [1, 2, 3]) { fs.copyFileSync(path.join(folderOf(n), sliverName(3, n)), path.join(folder, sliverName(3, n))); }
      const result = (await callWorker(win, 'merge-file-parts', {
        partFilePaths: [1, 2, 3].map((n) => path.join(folder, sliverName(3, n))), originalFileName: SLIVER_FILE_NAME,
      }, 10 * 60_000)).res;
      const file = path.join(folder, SLIVER_FILE_NAME);
      return result.merged === true && fs.existsSync(file) && (await sha256Streamed(file)) === sliverSha256;
    };

    // The first job: piece 1's disc is sent - the split gives three pieces - and burned together with the sliver.
    const session4 = newSession();
    const planned4 = plannedPaths(await plan(session4, { filesMetadata: sliverMetadata() }), session4);
    report('sliver_twoPiecesArePlanned', same(planned4, [1, 2].map((n) => sliverIn(2, n))), planned4.join(' | '));
    const sent4 = (await split(session4, [sliverIn(2, 1)])).res.map((e) => e.path).sort();
    report('sliver_piece1AndTheSliverComeBack_namedWithTheRealTotal', same(sent4, [1, 3].map((n) => sliverIn(3, n))), sent4.join(' | '));
    const temp4 = path.join(tempDir, session4, FILE_FOLDER);
    report('sliver_allThreePiecesAreNamedOutOf3', same(sliverPiecesIn(temp4), [1, 2, 3].map((n) => sliverName(3, n))), sliverPiecesIn(temp4).join(' | '));
    const burnedSha256 = new Map((await callWorker(win, 'compute-sha256-for-backed-up-files', {
      dirPath: sourceRoot, paths: [1, 3].map((n) => sliverIn(3, n)), sessionId: session4,
    }, 10 * 60_000)).res.map((r) => [r.path, r.sha256]));
    const sliverDisc = path.join(scratchRoot, 'disc with piece 1 and the sliver');
    fs.mkdirSync(sliverDisc, { recursive: true });
    for (const n of [1, 3]) { fs.copyFileSync(path.join(temp4, sliverName(3, n)), path.join(sliverDisc, sliverName(3, n))); }
    fs.rmSync(path.join(tempDir, session4), { recursive: true, force: true });
    const burned = (numbers) => [{ path: sliverFile, total: 3, burnedPieces: numbers.map((n) => ({ number: n, sha256: burnedSha256.get(sliverIn(3, n)) })) }];

    // A later job, the sliver already burned: only piece 2 is missing, and the new split must give back the burned
    // sliver byte for byte (its SHA-256) - its end holds 7-Zip's own record of the archive.
    const session5 = newSession();
    const planned5 = plannedPaths(await plan(session5, { filesMetadata: sliverMetadata(), incompleteSplitFiles: burned([1, 3]) }), session5);
    report('sliverBurned_onlyPiece2IsPlanned', same(planned5, [sliverIn(3, 2)]), planned5.join(' | '));
    const sent5 = (await split(session5, planned5)).res.map((e) => e.path).sort();
    const temp5 = path.join(tempDir, session5, FILE_FOLDER);
    report('sliverBurned_onlyPiece2IsSplitAndLeft_noNewSliver', same(sent5, [sliverIn(3, 2)]) && same(sliverPiecesIn(temp5), [sliverName(3, 2)]),
      `${sent5.join(' | ')} / ${sliverPiecesIn(temp5).join(' | ')}`);
    report('sliverBurned_theThreeRejoin_byteForByte', await rejoinSliverFile('sliver burned', (n) => (n === 2 ? temp5 : sliverDisc)));
    fs.rmSync(path.join(tempDir, session5), { recursive: true, force: true });

    // A later job, the sliver never burned (only piece 1 is on a disc): pieces 2 and 3 are missing - the sliver planned
    // as an empty piece.
    const session6 = newSession();
    const planned6 = plannedPaths(await plan(session6, { filesMetadata: sliverMetadata(), incompleteSplitFiles: burned([1]) }), session6);
    report('sliverMissing_pieces2And3ArePlanned', same(planned6, [2, 3].map((n) => sliverIn(3, n))), planned6.join(' | '));
    const sent6 = (await split(session6, planned6)).res.map((e) => e.path).sort();
    const temp6 = path.join(tempDir, session6, FILE_FOLDER);
    report('sliverMissing_theyAreSplit', same(sent6, [2, 3].map((n) => sliverIn(3, n))), sent6.join(' | '));
    report('sliverMissing_theThreeRejoin_byteForByte', await rejoinSliverFile('sliver missing', (n) => (n === 1 ? sliverDisc : temp6)));
  } finally {
    if (app) { await app.close().catch(() => {}); }
    for (const dir of sessionDirs) { fs.rmSync(dir, { recursive: true, force: true }); }
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }

  const failed = Object.entries(results).filter(([, ok]) => !ok).map(([name]) => name);
  const pass = Object.keys(results).length === 18 && failed.length === 0;
  console.log(`\n${pass ? 'PASS' : 'FAIL'} - a split file whose first piece was burned in an earlier session gets exactly its missing pieces, ` +
    `which rejoin with it - with a sliver too, burned or not; a file that changed since is refused.${failed.length ? ` Failed: ${failed.join(', ')}` : ''}`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((error) => {
  console.error('TEST ERRORED:', error);
  process.exitCode = 1;
});
