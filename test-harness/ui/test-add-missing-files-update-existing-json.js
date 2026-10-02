#!/usr/bin/env node
'use strict';

/**
 * End-to-end test of "Add missing files to optical media cold storage" -> "Update cold storage metadata
 * with existing (already burnt) discs", the task for someone who has the metadata JSON but has since
 * burned discs that it does not record.
 *
 * Proves what that flow has to get right, and nothing else in this suite does:
 *   - the discs the JSON already records are kept, unchanged, and the discs read now are APPENDED after them -
 *     the order of discs in the JSON IS the numbering burned on their labels, so a read that replaced the
 *     existing entries instead of appending to them would silently renumber a whole collection;
 *   - the first disc read is recorded (and announced) as disc N+1, continuing the JSON's numbering;
 *   - every file read off an added disc gets a real SHA-256, as in the "I do not have a json" flow;
 *   - a disc the JSON already records is refused rather than listed a second time;
 *   - the JSON written does not end in an empty disc entry.
 *
 * The seed JSON fed in is NOT hand-written: it is produced by this wizard's own "I do not have a json" flow
 * reading disc 1, so the disc id it carries (a hash of that disc's own paths - see disc-id-hash.ts) is genuine,
 * and the seeded duplicate check has a real id to match against.
 *
 * NOTE: needs a real Windows desktop/window session (see worker-ipc/call-worker.js's top comment) - run from
 * your own interactive terminal. It mounts real .iso files as optical discs (see ./iso-disc.js).
 *
 * Usage:
 *   node test-harness/ui/test-add-missing-files-update-existing-json.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { launchApp } = require('../worker-ipc/call-worker');
const { assertNoOpticalMediaAlreadyMounted, buildIso, mountIso, dismountIso } = require('./iso-disc');
const { printTree } = require('../lib/print-tree');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');
const { MARKER_FILE_NAME } = require('../lib/safety');
const { generateFixtureTree } = require('../lib/fixture-tree-source');

const SPEC_DIR = path.join(__dirname, 'tree-specs', 'test-add-missing-files-update-existing-json');

function sha256OfFileSync(absPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

/** Every file under `root`, relative and "\"-separated. */
function listFiles(root) {
  const out = [];
  (function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '\\' + e.name : e.name;
      if (e.isDirectory()) { walk(path.join(dir, e.name), r); } else { out.push(r); }
    }
  })(root, '');
  return out.sort();
}

/** A disc's entries as a comparable list of "path|sha256", paths compared case-insensitively (a disc may hand a
 *  name back in a different case than the folder it was built from). */
function entrySignatures(discEntries) {
  return discEntries
    .map((e) => `${String(e.path).replace(/^D:\\/i, '').toLowerCase()}|${e.stats.sha256 || ''}`)
    .sort();
}

async function clickMainMenuButton(win, labelText) {
  const container = win.locator('.grid-container > div').filter({ has: win.locator('h2', { hasText: labelText }) });
  await container.locator('button').click();
}

async function main() {
  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `add-missing-update-json-${runId}`);
  const disc1Dir = path.join(scratchRoot, 'disc1-files');
  const disc2Dir = path.join(scratchRoot, 'disc2-files');
  const seedJsonPath = path.join(scratchRoot, 'cold-storage-metadata.json');
  const updatedJsonPath = path.join(scratchRoot, 'cold-storage-metadata - updated.json');
  const disc1IsoPath = path.join(scratchRoot, 'disc1.iso');
  const disc2IsoPath = path.join(scratchRoot, 'disc2.iso');
  fs.mkdirSync(disc1Dir, { recursive: true });
  fs.mkdirSync(disc2Dir, { recursive: true });

  // Two discs of one cold storage: disc 1 is what the JSON fed into the flow already records, disc 2 is the disc
  // that was burned later and is missing from it. Each disc's folder IS that disc's contents - this flow has no
  // master folder, so nothing is copied anywhere.
  generateFixtureTree({
    root: disc1Dir,
    randomArgs: ['--files', '8', '--max-depth', '2', '--min-size', '0', '--max-size', '20000', '--seed', '112233'],
    specDir: SPEC_DIR,
  });
  generateFixtureTree({
    root: disc2Dir,
    randomArgs: ['--files', '6', '--max-depth', '2', '--min-size', '0', '--max-size', '15000', '--seed', '445566',
      '--no-edge-cases'],
    specDir: SPEC_DIR,
  });
  // The discs of one cold storage must not share a single file path - the app refuses a disc that repeats a path on
  // one it has already read ("every disc of a backup holds different files"), which would stop disc 2 from ever
  // being added. A generated tree would otherwise carry two files in common with disc 1's: the same edge cases
  // (--no-edge-cases above drops those) and the generator's own bookkeeping file at its root (removed here - it is
  // not disc content; disc 1 keeps its own).
  fs.rmSync(path.join(disc2Dir, MARKER_FILE_NAME), { force: true });
  const filesOnDisc2 = listFiles(disc2Dir);
  console.log(`\nDisc 1 (already in the JSON) holds ${listFiles(disc1Dir).length} files.`);
  console.log(`Disc 2 (to be added to it) holds ${filesOnDisc2.length} files.`);
  printTree(disc2Dir, 'Disc 2 contents (built into disc2.iso below)');

  assertNoOpticalMediaAlreadyMounted();
  console.log('\nBuilding both .iso files, then mounting disc1.iso...');
  buildIso(disc1Dir, disc1IsoPath, 'TESTDISC1');
  buildIso(disc2Dir, disc2IsoPath, 'TESTDISC2');
  mountIso(disc1IsoPath);

  let app, win;
  let newDiscAnnouncement = '';
  let refusalText = '';
  // The seed JSON the "I do not have a json" phase below builds, read back once it has been written. Declared out
  // here, not inside the try: the checks after the app has been closed use it too.
  let seed;
  try {
    console.log('Launching the app...');
    ({ app, win } = await launchApp());

    // Phase 1 - build a genuine metadata JSON of disc 1 with the "I do not have a json" flow, to feed the update
    // flow below. Exactly one native dialog (the save dialog); no showOpenDialog stub, since this flow must never
    // ask for a master folder.
    await app.evaluate(({ dialog }, saveTo) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: saveTo });
    }, seedJsonPath);

    // Let the app's own startup temp-leftover check settle before any raw IPC would race it (see
    // test-add-missing-files.js's identical pause).
    await new Promise((r) => setTimeout(r, 3000));

    const step = async (label, fn) => {
      process.stdout.write(`  [ ] ${label} ... `);
      try {
        await fn();
      } catch (e) {
        console.log('FAILED');
        const screenshotPath = path.join(FIXTURES_ROOT, `optical-backup-ui-add-missing-update-json-failure-${runId}.png`);
        try {
          await win.screenshot({ path: screenshotPath });
          console.log(`  Screenshot of the app at the point of failure saved to: ${screenshotPath}`);
        } catch { /* app/window may already be gone */ }
        throw e;
      }
      console.log('done');
      await new Promise((r) => setTimeout(r, 1000));
    };

    await step('main menu -> Add missing files to optical media cold storage', () =>
      clickMainMenuButton(win, 'Add missing files to optical media cold storage'));

    await step('click "Ok" on the wizard\'s notice', () =>
      win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 }));

    await step('click "I do not have a json" (opens the save dialog)', () =>
      win.getByRole('button', { name: 'I do not have a json' }).click({ timeout: 15_000 }));

    await step('wait for disc 1 to be read and hashed, then click "All disks have been processed..."', () =>
      win.getByRole('button', { name: 'All disks have been processed, continue to the next step' }).click({ timeout: 120_000 }));

    await step('"Ok" on "Metadata JSON saved", back to the main menu', async () => {
      const dialog = win.getByRole('dialog').filter({ has: win.getByRole('heading', { name: 'Metadata JSON saved', exact: true }) }).last();
      await dialog.waitFor({ timeout: 60_000 });
      await dialog.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 });
      await win.getByText('Cumulative backup', { exact: true }).waitFor({ timeout: 60_000 });
    });

    seed = JSON.parse(fs.readFileSync(seedJsonPath, 'utf8'));
    const seedIsUsable = Array.isArray(seed) && seed.length === 1 && seed[0].length > 0
      && seed[0].every((e) => e.stats.isDirectory || /^[0-9a-f]{64}$/.test(e.stats.sha256 || ''));
    console.log(`  The JSON built from disc 1 is a usable seed: ${seedIsUsable ? 'OK' : 'WRONG'} (${(seed || []).length} disc(s))`);
    if (!seedIsUsable) { throw new Error(`the "I do not have a json" flow did not produce a usable seed JSON at ${seedJsonPath}`); }

    // Phase 2 - the update flow itself: hand it that JSON, then insert disc 2.
    console.log('\nDismounting disc1.iso, mounting disc2.iso...');
    dismountIso(disc1IsoPath);
    mountIso(disc2IsoPath);

    await app.evaluate(({ dialog }, paths) => {
      const queue = [...paths];
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [queue.shift()] });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: queue.shift() });
    }, [seedJsonPath, updatedJsonPath]);

    await step('main menu -> Add missing files to optical media cold storage', () =>
      clickMainMenuButton(win, 'Add missing files to optical media cold storage'));

    await step('click "Ok" on the wizard\'s notice', () =>
      win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 }));

    // One button for the whole thing: it opens the file picker (stubbed to hand back the seed JSON), reads and
    // validates it, then asks where to save the updated JSON (the queued second path) and starts reading discs.
    await step('click "Update JSON" (opens the file picker, then the save dialog)', () =>
      win.getByRole('button', { name: 'Update JSON' }).click({ timeout: 15_000 }));

    // The "All disks..." button only appears once disc 2 has been read AND hashed, so waiting for it is also the
    // wait for the hashing. The dialog naming it disc 2 is the numbering assertion: the JSON records 1 disc.
    await step('wait for disc 2 to be read and hashed, then click "All disks have been processed..."', async () => {
      const dialog = win.getByRole('dialog').filter({ has: win.getByRole('heading', { name: 'Accessing disc', exact: true }) }).last();
      await dialog.getByRole('button', { name: 'All disks have been processed, continue to the next step' }).waitFor({ timeout: 120_000 });
      newDiscAnnouncement = (await dialog.innerText()).replace(/\s+/g, ' ').trim();
      await dialog.getByRole('button', { name: 'All disks have been processed, continue to the next step' }).click({ timeout: 15_000 });
    });

    await step('"Ok" on "Metadata JSON updated", back to the main menu', async () => {
      const dialog = win.getByRole('dialog').filter({ has: win.getByRole('heading', { name: 'Metadata JSON updated', exact: true }) }).last();
      await dialog.waitFor({ timeout: 60_000 });
      const text = (await dialog.innerText()).replace(/\s+/g, ' ');
      if (!text.includes(updatedJsonPath)) { throw new Error(`the dialog does not name the saved file: ${text}`); }
      await dialog.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 });
      await win.getByText('Cumulative backup', { exact: true }).waitFor({ timeout: 60_000 });
    });

    // Phase 3 - a disc the JSON now records must be refused, not recorded twice. Only the refusal itself is
    // checked: the app is closed with that dialog still open.
    console.log('\nDismounting disc2.iso, mounting disc1.iso again...');
    dismountIso(disc2IsoPath);
    mountIso(disc1IsoPath);

    await app.evaluate(({ dialog }, paths) => {
      const queue = [...paths];
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [queue.shift()] });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: queue.shift() });
    }, [updatedJsonPath, path.join(scratchRoot, 'unused-should-not-be-written.json')]);

    await step('main menu -> Add missing files to optical media cold storage (again)', () =>
      clickMainMenuButton(win, 'Add missing files to optical media cold storage'));

    await step('click "Ok" on the wizard\'s notice', () =>
      win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 }));

    await step('click "Update JSON"', () =>
      win.getByRole('button', { name: 'Update JSON' }).click({ timeout: 15_000 }));

    await step('disc 1, already recorded in the JSON, is refused as disc 1', async () => {
      const dialog = win.getByRole('dialog').filter({ has: win.getByRole('heading', { name: 'Error', exact: true }) }).last();
      await dialog.waitFor({ timeout: 120_000 });
      refusalText = (await dialog.innerText()).replace(/\s+/g, ' ').trim();
    });
  } finally {
    if (app) { await app.close().catch(() => {}); }
    // Both discs, whichever one this run got as far as mounting, and tolerantly: a disc left mounted here would
    // make every later disc test in the suite refuse to run (see iso-disc.js's assertNoOpticalMediaAlreadyMounted),
    // turning one failure into several. disc1.iso is also dismounted mid-run, so it may legitimately be gone.
    console.log('\nDismounting any test discs still mounted...');
    for (const [label, isoPath] of [['disc1.iso', disc1IsoPath], ['disc2.iso', disc2IsoPath]]) {
      try { dismountIso(isoPath); } catch { console.log(`  ${label} was not mounted.`); }
    }
  }

  // ---- The metadata JSON the update flow wrote ----
  console.log('\nVerifying the updated metadata JSON...');
  const updated = JSON.parse(fs.readFileSync(updatedJsonPath, 'utf8'));
  const discs = Array.isArray(updated) ? updated : [];

  const keptDisc1 = discs.length >= 1 && JSON.stringify(entrySignatures(discs[0])) === JSON.stringify(entrySignatures(seed[0]));
  console.log(`  Disc 1's own entries are kept exactly as they were: ${keptDisc1 ? 'OK' : 'WRONG'} (${(discs[0] || []).length} entries now, ${seed[0].length} before)`);

  const appendedDisc2 = discs.length === 2 && discs[1].length > 0;
  console.log(`  The disc just read was appended as disc 2 (2 discs, none empty): ${appendedDisc2 ? 'OK' : 'WRONG'} (${discs.length} disc(s), last holds ${(discs[1] || []).length} item(s))`);

  const addedEntries = appendedDisc2 ? discs[1].filter((e) => !e.stats.isDirectory) : [];
  const byPath = new Map(addedEntries.map((e) => [String(e.path).replace(/^D:\\/i, '').toLowerCase(), e]));
  const onDisc2 = new Set(filesOnDisc2.map((f) => f.toLowerCase()));
  const wrong = [];
  for (const rel of filesOnDisc2) {
    const entry = byPath.get(rel.toLowerCase());
    const realHash = sha256OfFileSync(path.join(disc2Dir, rel));
    if (!entry) { wrong.push(`${rel} - missing from disc 2's entries`); }
    else if (entry.stats.sha256 !== realHash) { wrong.push(`${rel} - recorded ${entry.stats.sha256 || 'no sha256'}, real ${realHash}`); }
  }
  for (const e of addedEntries) {
    if (!onDisc2.has(String(e.path).replace(/^D:\\/i, '').toLowerCase())) { wrong.push(`${e.path} - in the JSON but not on disc 2`); }
  }
  const disc2Correct = appendedDisc2 && wrong.length === 0;
  console.log(`  Every file on disc 2 is recorded with its real sha256, and nothing else: ${disc2Correct ? 'OK' : 'WRONG'} (${filesOnDisc2.length} files checked)`);
  for (const w of wrong) { console.log(`    WRONG: ${w}`); }

  const announcedAs2 = /\bdisc 2\b/i.test(newDiscAnnouncement);
  console.log(`  The read of disc 2 was announced as disc 2: ${announcedAs2 ? 'OK' : 'WRONG'} ("${newDiscAnnouncement}")`);

  // The app's own wording: "This disc was already read: it is disc 1." Matching on "already read" plus the disc
  // number keeps this distinct from the other refusal (a disc sharing files with one read before), which must NOT
  // be what happens here.
  const refusedAs1 = /already read/i.test(refusalText) && /\bdisc 1\b/i.test(refusalText);
  console.log(`  Reading disc 1 again was refused as already read (disc 1): ${refusedAs1 ? 'OK' : 'WRONG'} ("${refusalText}")`);

  const endsOnARealDisc = discs.length > 0 && discs[discs.length - 1].length > 0;
  console.log(`  The JSON does not end in an empty disc entry: ${endsOnARealDisc ? 'OK' : 'WRONG'}`);

  const verifyPassed = keptDisc1 && disc2Correct && announcedAs2 && refusedAs1 && endsOnARealDisc;

  if (verifyPassed) {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  } else {
    console.log(`\nLeaving scratch files in place for inspection: ${scratchRoot}`);
  }

  console.log(`\n${verifyPassed ? 'PASS' : 'FAIL'} - ${verifyPassed
    ? 'the existing metadata JSON kept its own disc and gained the disc that was missing from it, hashed, in order.'
    : 'did not produce the expected result - see the OK/WRONG lines above.'}`);
  process.exitCode = verifyPassed ? 0 : 1;
}

main().catch((e) => {
  const message = (e && e.message) || String(e);
  const fullDetail = (e && e.stack) ? e.stack : message;
  if (/closed|Target .*(closed|crashed)/i.test(message)) {
    console.error(`\nTEST ERRORED: the app window was closed before the test finished (${message}).`);
  } else {
    const logPath = path.join(FIXTURES_ROOT, `optical-backup-ui-add-missing-update-json-error-${Date.now()}.log`);
    try { fs.writeFileSync(logPath, fullDetail); } catch { /* best effort */ }
    console.error(`\nTEST ERRORED: ${message}`);
    console.error(`Full details saved to: ${logPath}`);
  }
  process.exitCode = 1;
});
