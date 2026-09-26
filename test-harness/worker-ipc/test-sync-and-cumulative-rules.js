#!/usr/bin/env node
'use strict';

/**
 * Checks Cumulative backup and Synchronize directories against their rules, through the app's REAL worker IPC,
 * calling the worker exactly the way the two wizards do (no UI clicking):
 *
 *   Cumulative backup: every source file that is missing from the backup or updated (newer in the source, or a
 *                      different size) ends up in the backup with the source's content; nothing else in the
 *                      backup changes, and nothing is deleted.
 *   Synchronize dirs:  afterwards the target holds exactly the source's files and folders - and no links.
 *   Both:              nothing outside the two chosen folders is read into them, written to, or deleted; a link is
 *                      never copied into the target.
 *
 *  1. Random folder pairs (fixed seeds): missing files, target-only files and folders, empty folders, a target copy
 *     that is newer / older / a different size / the same size and date with different bytes. Each pair is run
 *     through both features and checked against the rules above; the source must be unchanged.
 *  2. An earlier copy that Windows refuses to copy over - read-only, or hidden while the source is not - is
 *     replaced with the new version, in both features. (Hidden: Windows only - skipped elsewhere.) And Synchronize
 *     directories' 2-second allowance for modified times (a FAT drive stores them to 2 seconds): identical bytes
 *     with times 1 second apart are left alone, 3 seconds apart are copied again.
 *  3. Links (junctions - the kind of link anyone can create on Windows): a link is never followed and never copied.
 *     A link in the source is left out and written to logs.txt, with where it points - not to the "Some items were
 *     left out" warning; a link in the target is replaced as the link itself where the source has a folder or a file at that
 *     path, deleted as the link itself by Synchronize directories otherwise, and left alone by Cumulative backup
 *     (which never deletes). For every scenario, in both features: a folder outside both (what the links point to)
 *     must be unchanged, the result must follow the rules, and a second run must find nothing left to do.
 *  4. Folders inside each other: both features refuse the pair with a message and change nothing - the target
 *     containing the source, the source containing the target, and differently cased paths. A sibling whose name
 *     merely starts with the other's ("S" and "S-sibling") is not refused, and the same folder twice is simply
 *     already up to date / in sync.
 *  4b. A chosen folder that is a link, or inside one: both features refuse it, naming the folder it leads to, and
 *     change nothing - also a target that is a junction to a folder inside the source; so does recovery's copy (no
 *     comparison first) into a folder that is a junction. A folder on a SUBST drive is not taken for a link
 *     (skipped if no drive letter is free).
 *  5. A name that is a file on one side and a folder on the other: Synchronize directories
 *     replaces the target's entry, folder contents and all, so the target ends up identical to the source;
 *     Cumulative backup deletes nothing - the backup's old entry is renamed "<name> (old folder)" / "(old file)"
 *     (numbered if that name is taken too) with everything in it unchanged, and the source's entry is backed up
 *     under the name. Also for two names that differ only in letter case, on a case-insensitive filesystem. The
 *     rest of the folder, a folder outside both, and the source are unchanged, and a second run finds nothing to do.
 *  5b. Synchronize directories with files and folders renamed only in capital letters (on a filesystem that ignores
 *     letter case): the target ends up with the source's exact spelling - also for a file that changed too and an
 *     empty folder - and when the capitals are the only difference the sync still has the rename to do.
 *  6. The check Synchronize directories runs after a sync (compare-folders): after every sync above it must find
 *     both folders identical, counting the same files and bytes as this script's own walk; and on a pair built to
 *     differ it reports each difference once, by path and with what differs - a size, an entry only one side has (a
 *     whole folder as one line), a name that differs only in letter case, a file against a folder, a link in the
 *     target - and nothing else; a link in the source is not a difference (a sync does not copy it).
 *  7. Synchronize directories' delete step never deletes through a link: its list is made before the copy step, and a
 *     folder of the target can have become a link since - the delete step is given exactly that state, with a
 *     junction to a folder outside both, and must leave that folder alone while still deleting the rest of the list.
 *  8. A copy that fails part way - another program holds part of the source file locked - leaves the target's earlier
 *     copy exactly as it was, and no temporary file behind, in both features (Windows only: the lock is PowerShell's).
 *
 * Everything lives in a fresh folder under test-harness/generated-fixtures/. Nothing here touches the app's
 * temp/cache directory, so no temp-dir-guard is needed.
 *
 * NOTE: needs a real Windows desktop/window session (see call-worker.js's top comment) - run from your own
 * interactive terminal.
 *
 * Usage:
 *   node test-harness/worker-ipc/test-sync-and-cumulative-rules.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const { launchApp, callWorker, startRecordingAppErrors, takeAppErrors } = require('./call-worker');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');
const { isCaseInsensitiveFilesystem } = require('../lib/filesystem-case');

const IS_WINDOWS = process.platform === 'win32';
// The app's log, which the worker's console.warn lines go to (appData/logs.txt, next to config.json).
const LOGS_TXT = path.resolve(__dirname, '../../appData/logs.txt');
const BASE_SECONDS = Date.UTC(2025, 0, 1) / 1000;

const results = {};
function report(name, ok, detail) {
  results[name] = Boolean(ok);
  console.log(`  ${ok ? 'OK' : 'FAILED'} - ${name}${detail ? `  (${detail})` : ''}`);
}

function write(filePath, content, mtimeSeconds) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  if (mtimeSeconds !== undefined) { fs.utimesSync(filePath, mtimeSeconds, mtimeSeconds); }
}

/** Removes hidden/read-only/system attributes below `dir` (Windows) and deletes it. */
function removeTree(dir) {
  if (IS_WINDOWS) { try { execFileSync('attrib', ['-h', '-r', '-s', path.join(dir, '*'), '/s', '/d'], { stdio: 'pipe' }); } catch { /* nothing to clear */ } }
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Has another program (PowerShell) hold `length` bytes of `filePath` from `offset` locked - reading them fails - until
 *  the returned process is killed. Resolves once the lock is in place. The path goes through an environment variable,
 *  so spaces and non-Latin letters in it need no quoting. */
function lockByteRange(filePath, offset, length) {
  return new Promise((resolve, reject) => {
    const script = `$fs = [IO.File]::Open($env:LOCK_PATH, 'Open', 'Read', 'ReadWrite'); $fs.Lock(${offset}, ${length}); ` +
      `Write-Output locked; Start-Sleep -Seconds 300`;
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, env: { ...process.env, LOCK_PATH: filePath } });
    ps.stdout.on('data', (d) => { if (String(d).includes('locked')) { resolve(ps); } });
    ps.on('error', reject);
    ps.on('exit', (code) => reject(new Error(`the PowerShell holding the lock exited early (code ${code})`)));
  });
}

/** True if logs.txt has the line leaveOutLink (worker.ts) writes for the link at `linkPath`, pointing to `pointsTo`. */
function linkIsLogged(linkPath, pointsTo) {
  try { return fs.readFileSync(LOGS_TXT, 'utf8').includes(`Left out a link: ${linkPath}  -  a link to "${pointsTo}"`); } catch { return false; }
}

/** The worker's own message from a failed callWorker: its error payload is one line of JSON after 'Worker returned
 *  status "error" for "<key>": ' (see callWorkerInner in call-worker.js). Falls back to the whole message. */
function workerErrorMessage(e) {
  const text = String(e.message);
  const marker = /Worker returned status "error" for "[^"]+": /.exec(text);
  if (marker) {
    const json = text.slice(marker.index + marker[0].length).split('\n')[0];
    try { const payload = JSON.parse(json); if (payload && payload.message) { return payload.message; } } catch { /* not JSON */ }
  }
  return text;
}

// ---- the two features, called the way their wizards call the worker

async function cumulative(win, source, target) {
  const list = (await callWorker(win, 'diff', { source, target, comparison: 'source-newer-or-different-size', skipUnreadable: true })).res;
  await callWorker(win, 'incremental-copy-files', { sourceOnlyPaths: list, source, target, nameClash: 'keep-both' });
  return list.length;
}

/** Called the way the Synchronize directories wizard does: copy, delete, then give target entries the source's
 *  letter case (match-letter-case). Returns how many entries it copied, deleted and renamed. */
async function sync(win, source, target) {
  const copyList = (await callWorker(win, 'diff', { source, target, comparison: 'any-difference-or-content' })).res;
  const copying = new Set(copyList);
  const deleteList = (await callWorker(win, 'diff', { source: target, target: source, comparison: 'any-difference', listLinks: true })).res.filter((p) => !copying.has(p));
  const renames = (await callWorker(win, 'match-letter-case', { source, target, commit: false })).res;
  await callWorker(win, 'incremental-copy-files', { sourceOnlyPaths: copyList, source, target, nameClash: 'replace' });
  await callWorker(win, 'delete-files-and-dirs-for-dir-sync', { pathsMarkedForDeletion: deleteList, commit: true, source, target });
  await callWorker(win, 'match-letter-case', { source, target, commit: true });
  return copyList.length + deleteList.length + renames.length;
}

const run = (win, mode, source, target) => (mode === 'sync' ? sync(win, source, target) : cumulative(win, source, target));

/** The check the Synchronize directories wizard runs after a sync (compare-folders): it must find the two folders
 *  identical and count the source's files (not its links) and their bytes the way this script's own walk does.
 *  Returns what is wrong, if anything. */
async function checkAfterSync(win, source, target) {
  const sourceEntries = withoutLinks(snapshot(source));
  const expectedFiles = [...sourceEntries.values()].filter((e) => e.kind !== 'dir').length;
  const expectedBytes = [...sourceEntries.values()].reduce((sum, e) => sum + (e.kind.startsWith('file') ? e.size : 0), 0);
  const check = (await callWorker(win, 'compare-folders', { source, target })).res;
  const problems = [];
  if (!check.matched) { problems.push(`the check after the sync found differences: ${JSON.stringify(check.mismatches.slice(0, 3))}`); }
  if (check.fileCount !== expectedFiles || check.totalBytes !== expectedBytes) {
    problems.push(`the check counted ${check.fileCount} files / ${check.totalBytes} bytes, expected ${expectedFiles} / ${expectedBytes}`);
  }
  return problems;
}

// ---- what a folder holds: relative path -> 'dir' | 'file <sha256>' | 'link -> <where it points>' (never followed)

function snapshot(root) {
  const entries = new Map();
  (function walk(dir, rel) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const relPath = rel ? path.join(rel, name) : name;
      const stats = fs.lstatSync(full);
      // Without a trailing backslash: the same junction reads back with or without one depending on what created it.
      if (stats.isSymbolicLink()) { entries.set(relPath, { kind: 'link -> ' + fs.readlinkSync(full).replace(/(?<!^[A-Za-z]:)[\\/]+$/, '') }); }
      else if (stats.isDirectory()) { entries.set(relPath, { kind: 'dir' }); walk(full, relPath); }
      else { entries.set(relPath, { kind: 'file ' + crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'), mtimeMs: stats.mtimeMs, size: stats.size }); }
    }
  })(root, '');
  return entries;
}

/** A snapshot without its links - what a sync leaves in the target: links are never copied. */
function withoutLinks(entries) {
  return new Map([...entries].filter(([, v]) => !v.kind.startsWith('link')));
}

function differences(expected, actual) {
  const lines = [];
  for (const [k, v] of expected) { if (!actual.has(k) || actual.get(k).kind !== v.kind) { lines.push(`${k}: expected ${v.kind.slice(0, 40)}, got ${actual.has(k) ? actual.get(k).kind.slice(0, 40) : 'nothing'}`); } }
  for (const [k, v] of actual) { if (!expected.has(k)) { lines.push(`${k}: unexpected ${v.kind.slice(0, 40)}`); } }
  return lines;
}

/** What Cumulative backup must leave in the target: the target as it was, plus every source file or folder that was
 *  missing or updated (source newer, or a different size) - never a source link; a source entry replaces what was at
 *  its path (and, if that was a link or a file where the source has a folder, it simply becomes that folder). */
function expectedAfterCumulative(sourceBefore, targetBefore) {
  const expected = new Map(targetBefore);
  for (const [k, v] of withoutLinks(sourceBefore)) {
    const before = targetBefore.get(k);
    if (v.kind === 'dir') {
      if (!before || before.kind !== 'dir') { expected.set(k, v); }
      continue;
    }
    const updated = !before || !before.kind.startsWith('file')
      || v.mtimeMs > before.mtimeMs || v.size !== before.size;
    if (updated) { expected.set(k, v); }
  }
  return expected;
}

// ---- 1. random folder pairs

function seededRandom(seed) { return () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }; }

function buildRandomPair(seed, source, target) {
  const random = seededRandom(seed);
  const bytes = (n) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) { b[i] = Math.floor(random() * 256); } return b; };
  const pick = (list) => list[Math.floor(random() * list.length)];
  let discarded = 0;
  (function level(sourceDir, targetDir, depth) {
    fs.mkdirSync(sourceDir, { recursive: true }); fs.mkdirSync(targetDir, { recursive: true });
    const used = new Set();
    for (let i = 0, n = 1 + Math.floor(random() * 4); i < n; i++) {
      const isDir = depth < 3 && random() < 0.4;
      const name = isDir ? pick(['A', 'sub', 'x y', 'Φάκελος', 'deep']) : pick(['a.txt', 'b.bin', 'c', 'Doc.md', 'ω.txt']);
      if (used.has(name.toLowerCase())) { continue; }
      used.add(name.toLowerCase());
      const s = path.join(sourceDir, name); const t = path.join(targetDir, name);
      if (isDir) {
        const x = random();
        if (x < 0.15) { level(s, path.join(target, '..', `discarded-${seed}-${++discarded}`), depth + 1); }       // folder missing in the target
        else if (x < 0.3) { fs.mkdirSync(s); if (random() < 0.5) { fs.mkdirSync(t); if (random() < 0.5) { write(path.join(t, 'extra.txt'), bytes(3), BASE_SECONDS); } } } // empty in the source
        else { level(s, t, depth + 1); }
      } else {
        const size = Math.floor(random() * 3000); const content = bytes(size); const mtime = BASE_SECONDS + Math.floor(random() * 100000);
        write(s, content, mtime);
        const x = random();
        if (x < 0.2) { /* missing in the target */ }
        else if (x < 0.4) { write(t, content, mtime); }                                  // identical
        else if (x < 0.5) { write(t, content, mtime + 5000); }                           // target newer, same bytes
        else if (x < 0.6) { write(t, bytes(size), mtime + 5000); }                       // target newer, other bytes
        else if (x < 0.7) { write(t, bytes(size), mtime - 5000); }                       // target older, same size
        else if (x < 0.85) { write(t, bytes(size + 1 + Math.floor(random() * 10)), mtime); } // another size
        else { write(t, bytes(size), mtime); }                                            // same size and date, other bytes
      }
    }
    for (let i = 0, extras = Math.floor(random() * 3); i < extras; i++) {                // only in the target
      if (random() < 0.6) { write(path.join(targetDir, `only-in-target-${depth}-${i}.txt`), bytes(20), BASE_SECONDS); }
      else { fs.mkdirSync(path.join(targetDir, `only-in-target-${depth}-${i}`, 'deep'), { recursive: true }); if (random() < 0.5) { write(path.join(targetDir, `only-in-target-${depth}-${i}`, 'deep', 'f.txt'), bytes(9), BASE_SECONDS); } }
    }
  })(source, target, 0);
}

async function main() {
  const scratchRoot = path.join(FIXTURES_ROOT, `sync-and-cumulative-rules-${Date.now()}`);
  fs.mkdirSync(scratchRoot, { recursive: true });
  let app, win;
  try {
    console.log('Launching the app...');
    ({ app, win } = await launchApp());
    // Let the app's own startup checks finish before this script's raw calls - see ui/test-add-missing-files.js.
    await new Promise((r) => setTimeout(r, 3000));

    // ---- 1
    console.log('\n1. Random folder pairs, both features, checked against their rules...');
    const seeds = Array.from({ length: 20 }, (_, i) => 1000 + i * 7919);
    for (const mode of ['cumulative', 'sync']) {
      const failures = [];
      for (const seed of seeds) {
        const dir = path.join(scratchRoot, `random-${mode}-${seed}`);
        const source = path.join(dir, 'source'); const target = path.join(dir, 'target');
        buildRandomPair(seed, source, target);
        const sourceBefore = snapshot(source); const targetBefore = snapshot(target);
        try {
          await run(win, mode, source, target);
          const expected = mode === 'sync' ? withoutLinks(sourceBefore) : expectedAfterCumulative(sourceBefore, targetBefore);
          const problems = differences(expected, snapshot(target));
          if (differences(sourceBefore, snapshot(source)).length) { problems.push('the SOURCE changed'); }
          if (mode === 'sync') { problems.push(...await checkAfterSync(win, source, target)); }
          if (problems.length) { failures.push(`seed ${seed}: ${problems.slice(0, 2).join(' | ')}`); }
        } catch (e) {
          failures.push(`seed ${seed}: ${String(e.message).split('\n')[0].slice(0, 200)}`);
        }
      }
      report(`${mode}: ${seeds.length} random folder pairs follow the rules`, failures.length === 0, failures.slice(0, 3).join(' || '));
    }

    // ---- 2
    console.log('\n2. An earlier copy Windows refuses to copy over...');
    const protections = [['read-only', (p) => fs.chmodSync(p, 0o444)]];
    if (IS_WINDOWS) { protections.push(['hidden (the source file is not)', (p) => execFileSync('attrib', ['+h', p])]); }
    for (const [label, protect] of protections) {
      for (const mode of ['cumulative', 'sync']) {
        const dir = path.join(scratchRoot, `protected-${mode}-${label.split(' ')[0]}`);
        const source = path.join(dir, 'source'); const target = path.join(dir, 'target');
        write(path.join(source, 'f.txt'), 'version 2, longer', BASE_SECONDS + 600);
        write(path.join(target, 'f.txt'), 'version 1', BASE_SECONDS);
        protect(path.join(target, 'f.txt'));
        let error = '';
        try { await run(win, mode, source, target); } catch (e) { error = String(e.message).split('\n')[0].slice(0, 200); }
        const content = fs.readFileSync(path.join(target, 'f.txt'), 'utf8');
        report(`${mode}: a ${label} earlier copy is replaced`, !error && content === 'version 2, longer', error || `target holds "${content}"`);
      }
    }
    for (const [secondsApart, expectCopied] of [[1, false], [3, true]]) {
      const dir = path.join(scratchRoot, `mtime-${secondsApart}s`);
      const source = path.join(dir, 'source'); const target = path.join(dir, 'target');
      write(path.join(source, 'f.txt'), 'same bytes', BASE_SECONDS);
      write(path.join(target, 'f.txt'), 'same bytes', BASE_SECONDS + secondsApart);
      const copyList = (await callWorker(win, 'diff', { source, target, comparison: 'any-difference-or-content' })).res;
      const deleteList = (await callWorker(win, 'diff', { source: target, target: source, comparison: 'any-difference' })).res;
      const reported = copyList.length === 1 && deleteList.length === 1;
      const notReported = copyList.length === 0 && deleteList.length === 0;
      report(`sync: identical file, modified times ${secondsApart} s apart, is ${expectCopied ? '' : 'NOT '}copied again`, expectCopied ? reported : notReported,
        `copy list ${JSON.stringify(copyList)}, delete list ${JSON.stringify(deleteList)}`);
    }

    // ---- 3
    console.log('\n3. Links (junctions) - never followed, never copied...');
    await startRecordingAppErrors(win);
    const linkScenarios = [
      ['a junction in the target pointing outside, the source has nothing there', ({ S, T, O }) => { write(path.join(S, 'a.txt'), 'a'); fs.symlinkSync(O, path.join(T, 'link'), 'junction'); }],
      ['a junction in the source pointing outside is left out, not copied', ({ S, O }) => { write(path.join(S, 'a.txt'), 'a'); fs.symlinkSync(O, path.join(S, 'link'), 'junction'); }],
      ['a junction in the source that points to nothing', ({ S, root }) => { const gone = path.join(root, 'gone'); fs.mkdirSync(gone); fs.symlinkSync(gone, path.join(S, 'dangling'), 'junction'); fs.rmdirSync(gone); }],
      ['the same junction on both sides', ({ S, T, O }) => { fs.symlinkSync(O, path.join(S, 'link'), 'junction'); fs.symlinkSync(O, path.join(T, 'link'), 'junction'); }],
      ['junctions on both sides pointing to different places', ({ S, T, O }) => { fs.symlinkSync(O, path.join(S, 'link'), 'junction'); fs.symlinkSync(path.join(O, 'sub'), path.join(T, 'link'), 'junction'); }],
      ['a junction in the target where the source has a folder', ({ S, T, O }) => { write(path.join(S, 'd', 'precious.txt'), 'SOURCE VERSION'); write(path.join(S, 'd', 'new.txt'), 'n'); fs.symlinkSync(O, path.join(T, 'd'), 'junction'); }],
      ['a junction in the target where the source has a file', ({ S, T, O }) => { write(path.join(S, 'd'), 'a file named d'); fs.symlinkSync(O, path.join(T, 'd'), 'junction'); }],
      ['a junction in the target where the source has an empty folder', ({ S, T, O }) => { fs.mkdirSync(path.join(S, 'd')); fs.symlinkSync(O, path.join(T, 'd'), 'junction'); }],
      ['a file in the target where the source has a junction', ({ S, T, O }) => { fs.symlinkSync(O, path.join(S, 'd'), 'junction'); write(path.join(T, 'd'), 'old file'); }],
      ['a folder with files in the target where the source has a junction', ({ S, T, O }) => { fs.symlinkSync(O, path.join(S, 'd'), 'junction'); write(path.join(T, 'd', 'a.txt'), 'a'); fs.mkdirSync(path.join(T, 'd', 'empty')); }],
      ['a junction inside a folder only the target has', ({ S, T, O }) => { write(path.join(S, 'a.txt'), 'a'); write(path.join(T, 'old', 'x.txt'), 'x'); fs.symlinkSync(O, path.join(T, 'old', 'link'), 'junction'); }],
    ];
    let scenarioNumber = 0;
    for (const [label, build] of linkScenarios) {
      scenarioNumber++;
      for (const mode of ['cumulative', 'sync']) {
        const root = path.join(scratchRoot, `link-${scenarioNumber}-${mode}`);
        const S = path.join(root, 'source'); const T = path.join(root, 'target'); const O = path.join(root, 'outside');
        fs.mkdirSync(S, { recursive: true }); fs.mkdirSync(T, { recursive: true });
        write(path.join(O, 'precious.txt'), 'keep me'); write(path.join(O, 'sub', 'deep.txt'), 'deep');
        build({ S, T, O, root });
        const outsideBefore = snapshot(O); const sourceBefore = snapshot(S); const targetBefore = snapshot(T);
        // The source's links, as logs.txt must name them: by full path, with where each points.
        const sourceLinks = [...sourceBefore].filter(([, v]) => v.kind.startsWith('link')).map(([k, v]) => [path.join(S, k), v.kind.slice('link -> '.length)]);
        let problems = [];
        try {
          await takeAppErrors(win);
          await run(win, mode, S, T);
          const warnings = await takeAppErrors(win);
          const expected = mode === 'sync' ? withoutLinks(sourceBefore) : expectedAfterCumulative(sourceBefore, targetBefore);
          problems = differences(expected, snapshot(T));
          if (differences(outsideBefore, snapshot(O)).length) { problems.unshift('the folder OUTSIDE source and target changed'); }
          if (warnings.length) { problems.push(`a "left out" warning appeared: ${JSON.stringify(warnings[0].lists ? warnings[0].lists[0].items : warnings[0])}`); }
          if (!sourceLinks.every(([linkPath, pointsTo]) => linkIsLogged(linkPath, pointsTo))) { problems.push('not every source link is in logs.txt with where it points'); }
          const secondRun = await run(win, mode, S, T);
          if (secondRun) { problems.push(`a second run still found ${secondRun} item(s) to do`); }
        } catch (e) {
          problems = [String(e.message).split('\n')[0].slice(0, 200)];
        }
        report(`${mode}: ${label}`, problems.length === 0, problems.slice(0, 2).join(' | '));
      }
    }
    await takeAppErrors(win);

    // ---- 4
    console.log('\n4. Folders inside each other...');
    const nestedPairs = [
      ['the target contains the source', (root) => ({ S: path.join(root, 'T', 'Photos'), T: path.join(root, 'T') })],
      ['the source contains the target', (root) => ({ S: path.join(root, 'S'), T: path.join(root, 'S', 'backup') })],
    ];
    if (IS_WINDOWS) { nestedPairs.push(['differently cased paths, the target inside the source', (root) => ({ S: path.join(root, 'S'), T: path.join(root, 's', 'Backup') })]); }
    scenarioNumber = 0;
    for (const [label, makePair] of nestedPairs) {
      scenarioNumber++;
      for (const mode of ['cumulative', 'sync']) {
        const root = path.join(scratchRoot, `nested-${scenarioNumber}-${mode}`);
        fs.mkdirSync(root, { recursive: true });
        const { S, T } = makePair(root);
        write(path.join(S, 'a.txt'), 'a'); write(path.join(T, 't.txt'), 't');
        const before = snapshot(root);
        let error = null;
        try { await run(win, mode, S, T); } catch (e) { error = String(e.message); }
        const refused = error !== null && error.includes('inside the other');
        const unchanged = differences(before, snapshot(root)).length === 0;
        report(`${mode}: refused when ${label}`, refused && unchanged, !refused ? `not refused (${error ? error.split('\n')[0].slice(0, 150) : 'it ran'})` : (!unchanged ? 'files changed' : ''));
      }
    }
    {
      const root = path.join(scratchRoot, 'siblings');
      const S = path.join(root, 'S'); const T = path.join(root, 'S-sibling');
      write(path.join(S, 'a.txt'), 'a'); fs.mkdirSync(T, { recursive: true });
      let outcome;
      try { outcome = await sync(win, S, T); } catch (e) { outcome = String(e.message).split('\n')[0]; }
      report('sync: "S" and "S-sibling" (a name that merely starts with the other) are not refused', outcome === 1, String(outcome));
      let cumulativeOutcome; let syncOutcome;
      try { cumulativeOutcome = await cumulative(win, S, S); } catch (e) { cumulativeOutcome = String(e.message).split('\n')[0]; }
      try { syncOutcome = await sync(win, S, S); } catch (e) { syncOutcome = String(e.message).split('\n')[0]; }
      report('the same folder twice is already up to date / in sync', cumulativeOutcome === 0 && syncOutcome === 0 && fs.existsSync(path.join(S, 'a.txt')),
        `cumulative: ${cumulativeOutcome}, sync: ${syncOutcome}`);
    }

    // ---- 4b
    console.log('\n4b. A chosen folder that is a link, or inside one...');
    // [label, make the pair (and the folder the linked one leads to) under `root`]
    const linkedPairs = [
      ['the target is a junction', (root) => {
        const real = path.join(root, 'real target'); fs.mkdirSync(real, { recursive: true });
        const T = path.join(root, 'T-link'); fs.symlinkSync(real, T, 'junction');
        return { S: path.join(root, 'S'), T, leadsTo: real };
      }],
      ['the target is inside a junction', (root) => {
        const real = path.join(root, 'real'); fs.mkdirSync(path.join(real, 'backup'), { recursive: true });
        const link = path.join(root, 'link'); fs.symlinkSync(real, link, 'junction');
        return { S: path.join(root, 'S'), T: path.join(link, 'backup'), leadsTo: path.join(real, 'backup') };
      }],
      ['the source is a junction', (root) => {
        const real = path.join(root, 'real source'); fs.mkdirSync(real, { recursive: true });
        const S = path.join(root, 'S-link'); fs.symlinkSync(real, S, 'junction');
        return { S, T: path.join(root, 'T'), leadsTo: real };
      }],
      ['the target is a junction to a folder inside the source', (root) => {
        const S = path.join(root, 'S'); fs.mkdirSync(path.join(S, 'inner'), { recursive: true });
        const T = path.join(root, 'T-link'); fs.symlinkSync(path.join(S, 'inner'), T, 'junction');
        return { S, T, leadsTo: path.join(S, 'inner') };
      }],
    ];
    scenarioNumber = 0;
    for (const [label, makePair] of linkedPairs) {
      scenarioNumber++;
      for (const mode of ['cumulative', 'sync']) {
        const root = path.join(scratchRoot, `linked-${scenarioNumber}-${mode}`);
        fs.mkdirSync(root, { recursive: true });
        const { S, T, leadsTo } = makePair(root);
        write(path.join(S, 'a.txt'), 'a'); write(path.join(T, 't.txt'), 't');
        const before = snapshot(root);
        let error = null;
        try { await run(win, mode, S, T); } catch (e) { error = workerErrorMessage(e); }
        const refused = error !== null && error.includes('a link to') && error.toLowerCase().includes(`choose the folder it leads to instead: "${leadsTo.toLowerCase()}"`);
        const unchanged = differences(before, snapshot(root)).length === 0;
        report(`${mode}: refused when ${label}, naming the folder it leads to`, refused && unchanged,
          !refused ? `not refused as a link (${error ? error.slice(0, 200) : 'it ran'})` : (!unchanged ? 'files changed' : ''));
      }
    }
    {
      // Recovery copies straight from the disc, with no comparison first - its copy step refuses the folder itself.
      const root = path.join(scratchRoot, 'linked-recovery');
      const disc = path.join(root, 'disc'); write(path.join(disc, 'a.txt'), 'a');
      const real = path.join(root, 'real recovery folder'); fs.mkdirSync(real, { recursive: true });
      const T = path.join(root, 'recovery-link'); fs.symlinkSync(real, T, 'junction');
      let error = null;
      try { await callWorker(win, 'incremental-copy-files', { sourceOnlyPaths: ['a.txt'], source: disc, target: T }); } catch (e) { error = workerErrorMessage(e); }
      report('recovery (a copy with no comparison first): refused when its folder is a junction, nothing copied',
        error !== null && error.includes('a link to') && fs.readdirSync(real).length === 0, error ? error.slice(0, 200) : 'it ran');
    }
    if (IS_WINDOWS) {
      let substLetter = null;
      for (const letter of 'YXWVUTSRQP') { if (!fs.existsSync(`${letter}:\\`)) { substLetter = letter; break; } }
      if (substLetter) {
        const root = path.join(scratchRoot, 'subst');
        write(path.join(root, 'S', 'a.txt'), 'a'); fs.mkdirSync(path.join(root, 'on the drive', 'T'), { recursive: true });
        execFileSync('subst', [`${substLetter}:`, path.join(root, 'on the drive')]);
        try {
          const T = `${substLetter}:\\T`;
          let outcome;
          try { outcome = await cumulative(win, path.join(root, 'S'), T); } catch (e) { outcome = String(e.message).split('\n')[0]; }
          let syncOutcome;
          try { syncOutcome = await sync(win, path.join(root, 'S'), T); } catch (e) { syncOutcome = String(e.message).split('\n')[0]; }
          report(`a folder on a SUBST drive (${substLetter}:) is not taken for a link`, outcome === 1 && syncOutcome === 0 && fs.existsSync(path.join(T, 'a.txt')),
            `cumulative: ${outcome}, then sync: ${syncOutcome}`);
        } finally {
          try { execFileSync('subst', [`${substLetter}:`, '/D']); } catch { /* already gone */ }
        }
      } else {
        console.log('  (SUBST drive check skipped: no free drive letter.)');
      }
    }

    // ---- 5
    console.log('\n5. A name that is a file on one side and a folder on the other...');
    // [label, build, the name in the target that clashes, the name Cumulative sets it aside as]
    const clashScenarios = [
      ['a file in the source, a folder with files in the target', ({ S, T }) => {
        write(path.join(S, 'x'), 'the file'); write(path.join(T, 'x', 'a.txt'), 'a'); write(path.join(T, 'x', 'sub', 'b.txt'), 'b');
      }, 'x', 'x (old folder)'],
      ['a folder with files in the source, a file in the target', ({ S, T }) => {
        write(path.join(S, 'x', 'a.txt'), 'a'); write(path.join(S, 'x', 'sub', 'b.txt'), 'b'); write(path.join(T, 'x'), 'the old file');
      }, 'x', 'x (old file)'],
      ['an empty folder in the source, a file in the target', ({ S, T }) => {
        fs.mkdirSync(path.join(S, 'x')); write(path.join(T, 'x'), 'the old file');
      }, 'x', 'x (old file)'],
      ['a file in the source, an empty folder in the target', ({ S, T }) => {
        write(path.join(S, 'x'), 'the file'); fs.mkdirSync(path.join(T, 'x'));
      }, 'x', 'x (old folder)'],
      ['a file in the source, a folder in the target, and "x (old folder)" already taken', ({ S, T }) => {
        write(path.join(S, 'x'), 'the file'); write(path.join(T, 'x', 'a.txt'), 'a'); write(path.join(T, 'x (old folder)', 'older.txt'), 'older');
      }, 'x', 'x (old folder 2)'],
    ];
    if (isCaseInsensitiveFilesystem(scratchRoot)) {
      clashScenarios.push(['a file "X" in the source, a folder "x" in the target (one name to Windows)', ({ S, T }) => {
        write(path.join(S, 'X'), 'the file'); write(path.join(T, 'x', 'a.txt'), 'a');
      }, 'x', 'X (old folder)']);
    }
    scenarioNumber = 0;
    for (const [label, build, clash, aside] of clashScenarios) {
      scenarioNumber++;
      for (const mode of ['cumulative', 'sync']) {
        const root = path.join(scratchRoot, `clash-${scenarioNumber}-${mode}`);
        const S = path.join(root, 'source'); const T = path.join(root, 'target'); const O = path.join(root, 'outside');
        fs.mkdirSync(S, { recursive: true }); fs.mkdirSync(T, { recursive: true });
        write(path.join(O, 'precious.txt'), 'keep me');
        write(path.join(S, 'same.txt'), 'same', BASE_SECONDS); write(path.join(T, 'same.txt'), 'same', BASE_SECONDS);
        write(path.join(T, 'only in target.txt'), 'extra');
        build({ S, T, O });
        const outsideBefore = snapshot(O); const sourceBefore = snapshot(S); const targetBefore = snapshot(T);
        let problems = [];
        try {
          await run(win, mode, S, T);
          let expected;
          if (mode === 'sync') {
            expected = sourceBefore;
          } else {
            // Everything the backup had, with the clashing entry (and all below it) under its new name - plus the source.
            expected = new Map();
            for (const [k, v] of targetBefore) {
              expected.set(k === clash || k.startsWith(clash + path.sep) ? aside + k.slice(clash.length) : k, v);
            }
            for (const [k, v] of sourceBefore) { expected.set(k, v); }
          }
          problems = differences(expected, snapshot(T));
          if (differences(outsideBefore, snapshot(O)).length) { problems.unshift('the folder OUTSIDE source and target changed'); }
          if (differences(sourceBefore, snapshot(S)).length) { problems.unshift('the SOURCE changed'); }
          if (mode === 'sync') { problems.push(...await checkAfterSync(win, S, T)); }
          const secondRun = await run(win, mode, S, T);
          if (secondRun) { problems.push(`a second run still found ${secondRun} item(s) to do`); }
        } catch (e) {
          problems = [String(e.message).split('\n')[0].slice(0, 200)];
        }
        report(`${mode}: ${label}`, problems.length === 0, problems.slice(0, 3).join(' | '));
      }
    }

    // ---- 5b
    if (isCaseInsensitiveFilesystem(scratchRoot)) {
      console.log('\n5b. Sync: renames that only changed capital letters...');
      {
        const root = path.join(scratchRoot, 'letter-case');
        const S = path.join(root, 'source'); const T = path.join(root, 'target');
        write(path.join(S, 'Photos', 'IMG_001.JPG'), 'same picture', BASE_SECONDS); write(path.join(T, 'photos', 'img_001.jpg'), 'same picture', BASE_SECONDS);
        write(path.join(S, 'Photos', 'Notes.txt'), 'new notes, longer', BASE_SECONDS + 600); write(path.join(T, 'photos', 'notes.txt'), 'old notes', BASE_SECONDS);
        write(path.join(S, 'Readme.TXT'), 'readme', BASE_SECONDS); write(path.join(T, 'readme.txt'), 'readme', BASE_SECONDS);
        fs.mkdirSync(path.join(S, 'Empty Folder')); fs.mkdirSync(path.join(T, 'empty folder'));
        write(path.join(T, 'photos', 'only in target.txt'), 'x', BASE_SECONDS);
        const sourceBefore = snapshot(S);
        let problems = [];
        try {
          await sync(win, S, T);
          problems = differences(sourceBefore, snapshot(T));
          problems.push(...await checkAfterSync(win, S, T));
          const secondRun = await sync(win, S, T);
          if (secondRun) { problems.push(`a second run still found ${secondRun} item(s) to do`); }
        } catch (e) {
          problems = [String(e.message).split('\n')[0].slice(0, 200)];
        }
        report('sync: files and folders renamed only in capital letters (one also changed) end up with the source\'s spelling',
          problems.length === 0, problems.slice(0, 3).join(' | '));
      }
      {
        // When the capitals are the only difference, the sync still has something to do - it is not "already in sync".
        const root = path.join(scratchRoot, 'letter-case-only');
        const S = path.join(root, 'source'); const T = path.join(root, 'target');
        write(path.join(S, 'Report.TXT'), 'same', BASE_SECONDS); write(path.join(T, 'report.txt'), 'same', BASE_SECONDS);
        let found = null; let names = [];
        try { found = await sync(win, S, T); names = fs.readdirSync(T); } catch (e) { found = String(e.message).split('\n')[0]; }
        report('sync: when only the capitals differ, it is not "already in sync" - the rename is made',
          found === 1 && JSON.stringify(names) === JSON.stringify(['Report.TXT']), `found ${found}, target holds ${JSON.stringify(names)}`);
      }
    }

    // ---- 6
    console.log('\n6. The check after a sync reports every kind of difference, one line each...');
    {
      const root = path.join(scratchRoot, 'check-differences');
      const S = path.join(root, 'source'); const T = path.join(root, 'target'); const O = path.join(root, 'outside');
      write(path.join(O, 'sub', 'o.txt'), 'o');
      write(path.join(S, 'same.txt'), 'same'); write(path.join(T, 'same.txt'), 'same');
      write(path.join(S, 'sub', 'size differs.txt'), '0123456789'); write(path.join(T, 'sub', 'size differs.txt'), '012345678901');
      write(path.join(S, 'only in source.txt'), 's');
      write(path.join(S, 'folder only in source', 'one.txt'), '1'); write(path.join(S, 'folder only in source', 'two.txt'), '2');
      write(path.join(T, 'only in target.txt'), 't');
      write(path.join(S, 'Photo.jpg'), 'p'); write(path.join(T, 'photo.jpg'), 'p');
      write(path.join(S, 'clash'), 'a file'); write(path.join(T, 'clash', 'inside.txt'), 'i');
      fs.symlinkSync(O, path.join(S, 'link'), 'junction'); fs.symlinkSync(path.join(O, 'sub'), path.join(T, 'link'), 'junction');
      const check = (await callWorker(win, 'compare-folders', { source: S, target: T })).res;
      const expectedLines = [
        [path.join('sub', 'size differs.txt'), 'the size differs: 10 bytes in the source, 12 bytes in the target'],
        ['only in source.txt', 'only in the source'],
        ['folder only in source', 'only in the source (a folder)'],
        ['only in target.txt', 'only in the target'],
        ['Photo.jpg', 'the name differs only in letter case: "photo.jpg" in the target'],
        ['clash', 'a file, 6 bytes in the source, a folder in the target'],
        // The source's link is left out - a sync does not copy it - so the target's is only in the target.
        ['link', `only in the target (a link to "${path.join(O, 'sub')}")`],
      ];
      const missing = expectedLines.filter(([p, why]) => !check.mismatches.some((line) => line.startsWith(`${p}  -  ${why}`)));
      report('the check finds the two folders different', check.matched === false);
      report('the check reports each difference by path and says what differs', missing.length === 0,
        missing.length ? `not reported: ${JSON.stringify(missing.map((m) => m[0]))}; got ${JSON.stringify(check.mismatches)}` : '');
      report('the check reports nothing else - one line for a whole folder, one for a case-only name',
        check.mismatches.length === expectedLines.length, `${check.mismatches.length} line(s): ${JSON.stringify(check.mismatches)}`);
    }

    // ---- 7
    console.log('\n7. The delete step never deletes through a link...');
    {
      // Sets up directly the state the delete step can meet: the target's folder "L" has become a link (a junction) to
      // a folder outside both since the list was made, and the list still holds what "L" contained, next to ordinary
      // target-only entries.
      const root = path.join(scratchRoot, 'delete-through-link');
      const S = path.join(root, 'source'); const T = path.join(root, 'target'); const O = path.join(root, 'outside');
      write(path.join(S, 'a.txt'), 'a'); write(path.join(T, 'a.txt'), 'a');
      write(path.join(O, 'victim.txt'), 'keep me'); fs.mkdirSync(path.join(O, 'empty folder'));
      write(path.join(O, 'sub', 'deep.txt'), 'keep me too');
      fs.symlinkSync(O, path.join(T, 'L'), 'junction');
      write(path.join(T, 'gone', 'x.txt'), 'target only'); write(path.join(T, 'old.txt'), 'target only');
      const outsideBefore = snapshot(O);
      const deleteList = [path.join('L', 'empty folder') + path.sep, path.join('L', 'sub', 'deep.txt'), path.join('L', 'victim.txt'), path.join('gone', 'x.txt'), 'old.txt'];
      let error = '';
      try {
        await callWorker(win, 'delete-files-and-dirs-for-dir-sync', { pathsMarkedForDeletion: deleteList, commit: true, source: S, target: T });
      } catch (e) { error = String(e.message).split('\n')[0].slice(0, 200); }
      const outsideChanges = differences(outsideBefore, snapshot(O));
      report('sync: nothing is deleted through a link in the target - the folder it points to is unchanged', !error && outsideChanges.length === 0,
        error || outsideChanges.slice(0, 3).join(' | '));
      report('sync: the target-only entries on the same list are still deleted, and the link is left in place',
        !fs.existsSync(path.join(T, 'old.txt')) && !fs.existsSync(path.join(T, 'gone')) && fs.lstatSync(path.join(T, 'L')).isSymbolicLink(),
        JSON.stringify(fs.readdirSync(T)));
    }

    // ---- 8
    if (IS_WINDOWS) {
      console.log('\n8. A copy that fails part way leaves the earlier copy as it was...');
      for (const mode of ['cumulative', 'sync']) {
        const root = path.join(scratchRoot, `copy-fails-${mode}`);
        const S = path.join(root, 'source'); const T = path.join(root, 'target');
        const sourceFile = path.join(S, 'big.bin'); const targetFile = path.join(T, 'big.bin');
        write(sourceFile, Buffer.alloc(3 * 1024 * 1024, 7), BASE_SECONDS + 600); // newer and bigger: it is copied
        write(targetFile, 'the earlier copy', BASE_SECONDS);
        // Another program holds 1 MB of the source locked, so reading it fails part way through the copy.
        const locker = await lockByteRange(sourceFile, 1024 * 1024, 1024 * 1024);
        let error = '';
        try { await run(win, mode, S, T); } catch (e) { error = String(e.message).split('\n')[0].slice(0, 200); }
        finally { locker.kill(); await new Promise((r) => locker.once('exit', r)); }
        const earlierCopy = fs.existsSync(targetFile) ? fs.readFileSync(targetFile, 'utf8') : '(gone)';
        const otherEntries = fs.readdirSync(T).filter((n) => n !== 'big.bin');
        report(`${mode}: a copy that fails part way leaves the earlier copy as it was, and nothing else behind`,
          error !== '' && earlierCopy === 'the earlier copy' && otherEntries.length === 0,
          `${error ? 'the run failed, as it should' : 'the run did NOT fail'}; target holds "${earlierCopy.slice(0, 30)}"; other entries: ${JSON.stringify(otherEntries)}`);
      }
    }

  } finally {
    if (app) { await app.close().catch(() => {}); }
  }

  const pass = Object.keys(results).length > 0 && Object.values(results).every(Boolean);
  console.log('\nSummary:');
  for (const [check, ok] of Object.entries(results)) { console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${check}`); }
  if (pass) {
    removeTree(scratchRoot);
  } else {
    console.log(`\nLeaving scratch files in place for inspection: ${scratchRoot}`);
  }
  console.log(`\n${pass ? 'PASS' : 'FAIL'} - Cumulative backup and Synchronize directories ${pass ? 'followed their rules, kept to the two folders, and refused folders inside each other.' : 'did not behave as expected, see above.'}`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => {
  console.error('\nTEST ERRORED:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
