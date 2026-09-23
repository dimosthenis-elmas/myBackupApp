#!/usr/bin/env node
'use strict';

/**
 * Exercises the progress reporting of every worker operation that scans a directory, through the app's REAL
 * worker IPC - no app source touched, no UI clicking. Every such operation first probes the tree's real size
 * (countAllFilesQuick in app/workers/worker.ts) and then reports "(i of N)" lines against it, which the UI turns
 * into its filling progress circle. This checks the things that would silently break that circle:
 *
 *   - The probed total N equals what the real scan actually finds - counted here by an independent walk, not
 *     taken from the worker's own answer. The source tree deliberately contains a directory junction to a
 *     second folder (a link to a directory): the real scanners follow links, so a probe that didn't would
 *     undercount, and the circle would hit 100% long before the scan finished.
 *   - A cancel left over from an earlier operation (a `stop` with nothing running) doesn't zero the probe: the
 *     scan must still complete (not "stopped") and still report the real N, not "(0 of 0)".
 *   - diff() reports one scan phase and then one comparison phase, in that order, and the comparison ends
 *     exactly on its last item.
 *   - partition-backup-to-optical-media reports a scan phase and then one "Packing items" line per disc, ending
 *     exactly on its last file - and skips the scan entirely when it is handed the file list up front.
 *
 * The scratch data (a random source tree, a second folder it links to, an empty diff target) all lives under
 * test-harness/generated-fixtures/. The real temp directory is only touched the way test-partitioning.js
 * touches it (see that file's top comment), so this uses the same guard.
 *
 * NOTE: this needs a real Windows desktop/window session (see call-worker.js's top comment) - run it from your
 * own interactive terminal, not from a headless/remote sandbox. Creating the directory junction needs no admin
 * rights on Windows.
 *
 * Usage:
 *   node test-harness/worker-ipc/test-scan-progress.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { launchApp, callWorkerWithProgress, sendToWorker } = require('./call-worker');
const { assertRealTempDataDirectoryIsSafeToUse } = require('./temp-dir-guard');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');

const TEST_DISC_CAPACITY_BYTES = 200_000; // small on purpose, so the packing loop runs for several discs
const SCAN_LINE = /^Scanning items \((\d+) of (\d+)\)$/;
const COMPARE_LINE = /^Comparing items \((\d+) of (\d+)\)$/;
const PACK_LINE = /^Packing items \((\d+) of (\d+)\)$/;

const results = {};

function check(name, ok, detail) {
  results[name] = Boolean(ok);
  console.log(`  ${ok ? 'OK' : 'FAILED'} - ${name}${!ok && detail ? ` (${detail})` : ''}`);
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function parseLines(lines, pattern) {
  return lines
    .map((line) => pattern.exec(line))
    .filter(Boolean)
    .map((m) => ({ current: Number(m[1]), total: Number(m[2]) }));
}

/** Counts what the app's scanners are supposed to find under `dir`, the same way they define it: every file is
 *  one entry, an empty directory is one entry, and a link to a directory is followed (fs.statSync follows links,
 *  which is exactly why the app's own scanners use it). Deliberately its own walk, so the test never trusts the
 *  worker to grade itself. */
function countExpectedEntries(dir) {
  const names = fs.readdirSync(dir);
  if (names.length === 0) { return 1; }
  let count = 0;
  for (const name of names) {
    count += fs.statSync(path.join(dir, name)).isDirectory() ? countExpectedEntries(path.join(dir, name)) : 1;
  }
  return count;
}

/** Checks one phase's parsed progress lines: at least one, every one against `expectedTotal`, and never going
 *  backwards or past the total. Returns nothing - records its own results. */
function checkPhase(label, parsed, expectedTotal) {
  check(`${label}: reported at least one progress line`, parsed.length > 0, 'none received');
  check(`${label}: every line's total is ${expectedTotal}`, parsed.every((p) => p.total === expectedTotal),
    `totals seen: ${[...new Set(parsed.map((p) => p.total))].join(', ')}`);
  let ordered = true;
  for (let i = 0; i < parsed.length; i++) {
    if (parsed[i].current < 1 || parsed[i].current > parsed[i].total) { ordered = false; }
    if (i > 0 && parsed[i].current < parsed[i - 1].current) { ordered = false; }
  }
  check(`${label}: counts never go backwards or past the total`, ordered);
}

function checkNoUnknownLines(label, lines, patterns) {
  const unknown = lines.filter((line) => !patterns.some((p) => p.test(line)));
  check(`${label}: no progress lines of an unexpected form`, unknown.length === 0, `e.g. ${JSON.stringify(unknown.slice(0, 3))}`);
}

function generateTree(root, files, maxDepth, seed) {
  execFileSync(process.execPath, [
    path.join(__dirname, '../generate-random-tree.js'),
    '--root', root,
    '--files', String(files),
    '--max-depth', String(maxDepth),
    '--min-size', '0',
    '--max-size', '30000',
    '--seed', String(seed),
  ], { stdio: 'inherit' });
}

function removeLink(linkPath) {
  try { fs.unlinkSync(linkPath); } catch { fs.rmdirSync(linkPath); }
}

async function main() {
  console.log('Checking the app\'s real temp/cache directory is safe to use...');
  const tempDir = assertRealTempDataDirectoryIsSafeToUse();
  console.log(`OK - using: ${tempDir}\n`);

  // 1. Fixtures: a source tree, a second folder the source links to, and an empty folder to diff against.
  const scratch = path.join(FIXTURES_ROOT, `scan-progress-${Date.now()}`);
  const source = path.join(scratch, 'source');
  const linkedTarget = path.join(scratch, 'linked-target');
  const emptyTarget = path.join(scratch, 'empty-target');
  const linkPath = path.join(source, 'linked-folder');
  console.log(`Generating fixtures under ${scratch} ...`);
  generateTree(source, 70, 3, 4242);
  generateTree(linkedTarget, 30, 2, 777);
  fs.mkdirSync(emptyTarget, { recursive: true });
  fs.symlinkSync(linkedTarget, linkPath, 'junction');

  const expected = countExpectedEntries(source);
  const linkedCount = countExpectedEntries(linkedTarget);
  console.log(`\nSource tree holds ${expected} entries by an independent count (${linkedCount} of them reached only through the junction).`);
  if (expected < 100) { throw new Error(`Fixture too small to produce several progress lines (${expected} entries) - the generator's output changed.`); }

  // 2. Launch the real app and call the real worker.
  console.log('\nLaunching the app...');
  const { app, win } = await launchApp();
  let scanWithStats;
  try {
    console.log('\n1) get-file-paths-with-stats');
    scanWithStats = await callWorkerWithProgress(win, 'get-file-paths-with-stats', { dirPath: source });
    check('get-file-paths-with-stats: finished normally', scanWithStats.response.status === 'completed', scanWithStats.response.status);
    check('get-file-paths-with-stats: result count matches the independent count', scanWithStats.response.res.length === expected,
      `got ${scanWithStats.response.res.length}, expected ${expected}`);
    check('get-file-paths-with-stats: the scan followed the junction',
      scanWithStats.response.res.some((entry) => entry.path.includes(`${path.sep}linked-folder${path.sep}`)));
    checkNoUnknownLines('get-file-paths-with-stats', scanWithStats.progressLines, [SCAN_LINE]);
    checkPhase('get-file-paths-with-stats', parseLines(scanWithStats.progressLines, SCAN_LINE), expected);

    console.log('\n2) get-file-paths-with-stats right after a leftover cancel');
    await sendToWorker(win, 'stop', {});
    await sleep(500);
    const afterStop = await callWorkerWithProgress(win, 'get-file-paths-with-stats', { dirPath: source });
    check('after a leftover cancel: the scan still finished normally (not "stopped")', afterStop.response.status === 'completed', afterStop.response.status);
    check('after a leftover cancel: the scan still found every entry', afterStop.response.res.length === expected,
      `got ${afterStop.response.res.length}, expected ${expected}`);
    checkPhase('after a leftover cancel', parseLines(afterStop.progressLines, SCAN_LINE), expected);

    console.log('\n3) get-file-paths right after a leftover cancel');
    await sendToWorker(win, 'stop', {});
    await sleep(500);
    const paths = await callWorkerWithProgress(win, 'get-file-paths', { sourceDir: source });
    check('get-file-paths: finished normally after a leftover cancel', paths.response.status === 'completed', paths.response.status);
    check('get-file-paths: result count matches the independent count', paths.response.res.length === expected,
      `got ${paths.response.res.length}, expected ${expected}`);
    checkNoUnknownLines('get-file-paths', paths.progressLines, [SCAN_LINE]);
    checkPhase('get-file-paths', parseLines(paths.progressLines, SCAN_LINE), expected);

    console.log('\n4) diff (source against an empty folder - every source entry is source-only)');
    const diff = await callWorkerWithProgress(win, 'diff', { source, target: emptyTarget });
    const diffScan = parseLines(diff.progressLines, SCAN_LINE);
    const diffCompare = parseLines(diff.progressLines, COMPARE_LINE);
    check('diff: finished normally', diff.response.status === 'completed', diff.response.status);
    check('diff: every source entry reported as source-only', diff.response.res.length === expected,
      `got ${diff.response.res.length}, expected ${expected}`);
    checkNoUnknownLines('diff', diff.progressLines, [SCAN_LINE, COMPARE_LINE]);
    // The empty target folder is one entry itself, so the scan phase's total is the source's plus one.
    checkPhase('diff scan phase', diffScan, expected + 1);
    checkPhase('diff comparison phase', diffCompare, expected);
    check('diff comparison phase: ends exactly on its last item', diffCompare.length > 0 && diffCompare[diffCompare.length - 1].current === expected);
    const lastScanIndex = diff.progressLines.map((l) => SCAN_LINE.test(l)).lastIndexOf(true);
    const firstCompareIndex = diff.progressLines.map((l) => COMPARE_LINE.test(l)).indexOf(true);
    check('diff: the whole scan phase is reported before the comparison phase starts', lastScanIndex !== -1 && firstCompareIndex !== -1 && lastScanIndex < firstCompareIndex);

    console.log('\n5) partition-backup-to-optical-media (scans the folder, then packs it)');
    const partition = await callWorkerWithProgress(win, 'partition-backup-to-optical-media', {
      rootPath: source,
      mediaCapacityInBytes: TEST_DISC_CAPACITY_BYTES,
      splitLargeFiles: false,
      sessionId: 'session-' + Date.now(),
    });
    const discs = partition.response.res;
    const partitionScan = parseLines(partition.progressLines, SCAN_LINE);
    const partitionPack = parseLines(partition.progressLines, PACK_LINE);
    check('partition: finished normally', partition.response.status === 'completed', partition.response.status);
    check('partition: needs several discs (so the packing loop reports more than once)', discs.length > 1, `${discs.length} disc(s)`);
    check('partition: every entry placed on a disc', discs.reduce((sum, disc) => sum + disc.length, 0) === expected);
    checkNoUnknownLines('partition', partition.progressLines, [SCAN_LINE, PACK_LINE]);
    checkPhase('partition scan phase', partitionScan, expected);
    checkPhase('partition packing phase', partitionPack, expected);
    check('partition packing phase: one line per disc', partitionPack.length === discs.length, `${partitionPack.length} lines for ${discs.length} discs`);
    check('partition packing phase: ends exactly on its last file', partitionPack.length > 0 && partitionPack[partitionPack.length - 1].current === expected);
    const lastPartitionScanIndex = partition.progressLines.map((l) => SCAN_LINE.test(l)).lastIndexOf(true);
    const firstPackIndex = partition.progressLines.map((l) => PACK_LINE.test(l)).indexOf(true);
    check('partition: the whole scan phase is reported before packing starts', lastPartitionScanIndex !== -1 && firstPackIndex !== -1 && lastPartitionScanIndex < firstPackIndex);

    console.log('\n6) partition-backup-to-optical-media handed the file list up front (must not scan at all)');
    // rootPath points at a folder that does not exist: if the worker still tried to scan it, the scan would
    // throw and this call would reject - so simply succeeding is the proof that the scan was skipped.
    let handedList;
    try {
      handedList = await callWorkerWithProgress(win, 'partition-backup-to-optical-media', {
        rootPath: path.join(scratch, 'does-not-exist'),
        mediaCapacityInBytes: TEST_DISC_CAPACITY_BYTES,
        splitLargeFiles: false,
        sessionId: 'session-' + Date.now(),
        filesMetadata: scanWithStats.response.res,
      });
    } catch (error) {
      check('partition with a supplied file list: did not scan the (nonexistent) folder', false, error.message.slice(0, 200));
    }
    if (handedList) {
      const handedPack = parseLines(handedList.progressLines, PACK_LINE);
      check('partition with a supplied file list: did not scan the (nonexistent) folder', handedList.response.status === 'completed');
      check('partition with a supplied file list: reported no scan phase', parseLines(handedList.progressLines, SCAN_LINE).length === 0);
      checkNoUnknownLines('partition with a supplied file list', handedList.progressLines, [PACK_LINE]);
      checkPhase('partition with a supplied file list, packing phase', handedPack, expected);
      check('partition with a supplied file list: every entry placed on a disc',
        handedList.response.res.reduce((sum, disc) => sum + disc.length, 0) === expected);
    }
  } finally {
    await app.close().catch(() => {});
  }

  const pass = Object.values(results).every(Boolean);
  console.log('\nSummary:');
  for (const [name, ok] of Object.entries(results)) { console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${name}`); }

  if (pass) {
    removeLink(linkPath); // remove the link itself first, so nothing can ever follow it out of the scratch folder
    fs.rmSync(scratch, { recursive: true, force: true });
  } else {
    console.log(`\nLeaving scratch files in place for inspection: ${scratch}`);
  }

  console.log(`\n${pass ? 'PASS' : 'FAIL'} - scan/diff/partition progress reporting ${pass ? 'is accurate: totals match a real count, a leftover cancel does not break it, and the phases arrive in order.' : 'did not behave as expected, see above.'}`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => {
  console.error('\nTEST ERRORED:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
