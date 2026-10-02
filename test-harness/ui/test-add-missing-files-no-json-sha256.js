#!/usr/bin/env node
'use strict';

/**
 * End-to-end test of "Add missing files to optical media cold storage" -> "I do not have a json", the task
 * for someone who has the discs but no metadata JSON: no master folder, no diff, no new discs burned - it just
 * reads the existing cold storage's discs one by one and builds the JSON that was missing.
 *
 * Proves what that flow has to get right and nothing else does:
 *   - it asks where to save the new JSON before reading anything, and never asks for a master folder;
 *   - every file it reads back off a disc gets a real SHA-256 (the JSON's whole point - it is what later
 *     integrity checks compare against), while directory entries get none;
 *   - what it writes names every file on the disc, hashed, and does not end in an empty disc entry.
 *
 * The physical read is <optical-disc-backup-data-retriever> (getCombinedFilePathsFromAllOpticalDiscs ->
 * readAllDiscsToReconstructTheCompleteBackupFilePaths), reused from the recovery wizard; the hashing is its
 * computeSha256ForReadDiscs/attachSha256ToReadDisc, and the per-disc JSON write is this wizard's onDiscsUpdated.
 *
 * Deliberately a SINGLE disc and a small tree - the multi-disc read is already covered by
 * test-recover-multi-disc.js, and the JSON-seeded diff/continuation by test-add-missing-files.js. This test's
 * only job is "read a disc with no JSON in hand and come away with a correct, hashed metadata JSON".
 *
 * NOTE: needs a real Windows desktop/window session (see worker-ipc/call-worker.js's top comment) - run from
 * your own interactive terminal. It mounts a real .iso as an optical disc (see ./iso-disc.js).
 *
 * Usage:
 *   node test-harness/ui/test-add-missing-files-no-json-sha256.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { launchApp } = require('../worker-ipc/call-worker');
const { assertNoOpticalMediaAlreadyMounted, buildIso, mountIso, dismountIso } = require('./iso-disc');
const { printTree } = require('../lib/print-tree');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');
const { generateFixtureTree } = require('../lib/fixture-tree-source');

const SPEC_DIR = path.join(__dirname, 'tree-specs', 'test-add-missing-files-no-json-sha256');

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

async function clickMainMenuButton(win, labelText) {
  const container = win.locator('.grid-container > div').filter({ has: win.locator('h2', { hasText: labelText }) });
  await container.locator('button').click();
}

async function main() {
  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `add-missing-no-json-sha256-${runId}`);
  const disc1Dir = path.join(scratchRoot, 'disc1-files');
  const metadataJsonPath = path.join(scratchRoot, 'cold-storage-metadata.json');
  const disc1IsoPath = path.join(scratchRoot, 'disc1.iso');
  fs.mkdirSync(disc1Dir, { recursive: true });

  // The disc's contents ARE the whole fixture - there is no master folder in this flow, so nothing is copied
  // around: whatever ends up in here is what the app has to rediscover from the disc alone.
  generateFixtureTree({
    root: disc1Dir,
    randomArgs: ['--files', '10', '--max-depth', '2', '--min-size', '0', '--max-size', '20000', '--seed', '998877'],
    specDir: SPEC_DIR,
  });
  const filesOnDisc = listFiles(disc1Dir);
  console.log(`\nThe disc to be read holds ${filesOnDisc.length} files.`);
  printTree(disc1Dir, 'Disc 1 contents (built into disc1.iso below)');

  assertNoOpticalMediaAlreadyMounted();
  console.log('\nBuilding and mounting disc1.iso...');
  buildIso(disc1Dir, disc1IsoPath, 'TESTDISC1');
  mountIso(disc1IsoPath);

  let app, win;
  try {
    console.log('Launching the app...');
    ({ app, win } = await launchApp());

    // Exactly one native dialog in this flow: the save dialog for the new metadata JSON. Deliberately no
    // showOpenDialog stub - this flow must never ask for a master folder, so if it ever did, a real picker would
    // open and the test would stall visibly instead of quietly passing.
    await app.evaluate(({ dialog }, saveTo) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: saveTo });
    }, metadataJsonPath);

    // Let the app's own startup temp-leftover check settle before any raw IPC would race it (see
    // test-add-missing-files.js's identical pause).
    await new Promise((r) => setTimeout(r, 3000));

    const step = async (label, fn) => {
      process.stdout.write(`  [ ] ${label} ... `);
      try {
        await fn();
      } catch (e) {
        console.log('FAILED');
        const screenshotPath = path.join(FIXTURES_ROOT, `optical-backup-ui-add-missing-no-json-sha256-failure-${runId}.png`);
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

    // The save dialog is the app's first move after this click, and no master folder is ever asked for - the
    // "Select the location of your files (Master)" button is deliberately never touched.
    await step('click "I do not have a json" (opens the save dialog)', () =>
      win.getByRole('button', { name: 'I do not have a json' }).click({ timeout: 15_000 }));

    // The "All disks..." button only appears once disc 1 has been read AND hashed (attachSha256ToReadDisc runs
    // before the "insert the next disc" dialog is shown), so waiting for it is also the wait for the hashing.
    await step('wait for disc 1 to be read and hashed, then click "All disks have been processed..."', () =>
      win.getByRole('button', { name: 'All disks have been processed, continue to the next step' }).click({ timeout: 120_000 }));

    await step('"Ok" on "Metadata JSON saved", back to the main menu', async () => {
      const dialog = win.getByRole('dialog').filter({ has: win.getByRole('heading', { name: 'Metadata JSON saved', exact: true }) }).last();
      await dialog.waitFor({ timeout: 60_000 });
      const text = (await dialog.innerText()).replace(/\s+/g, ' ');
      if (!text.includes(metadataJsonPath)) { throw new Error(`the dialog does not name the saved file: ${text}`); }
      await dialog.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 });
      await win.getByText('Cumulative backup', { exact: true }).waitFor({ timeout: 60_000 });
    });
  } finally {
    if (app) { await app.close().catch(() => {}); }
    console.log('\nDismounting disc1.iso...');
    dismountIso(disc1IsoPath);
  }

  // ---- The metadata JSON the app built from the disc alone ----
  console.log('\nVerifying the metadata JSON it built from the disc alone...');
  const metadata = JSON.parse(fs.readFileSync(metadataJsonPath, 'utf8'));
  const entries = (metadata || []).flat();
  const fileEntries = entries.filter((e) => !e.stats.isDirectory);
  const dirEntries = entries.filter((e) => e.stats.isDirectory);

  // Every file that is on the disc must be in the JSON, under its path on the disc, with a sha256 matching a
  // fresh recompute of that exact file's real bytes. Paths are compared case-insensitively - a disc may hand a
  // name back in a different case than the folder it was built from.
  const bare = (p) => String(p).replace(/^D:\\/i, '').toLowerCase();
  const byPath = new Map(fileEntries.map((e) => [bare(e.path), e]));
  const onDisc = new Set(filesOnDisc.map((f) => f.toLowerCase()));
  const wrong = [];
  for (const rel of filesOnDisc) {
    const entry = byPath.get(rel.toLowerCase());
    const realHash = sha256OfFileSync(path.join(disc1Dir, rel));
    if (!entry) { wrong.push(`${rel} - missing from the JSON`); }
    else if (!/^[0-9a-f]{64}$/.test(entry.stats.sha256 || '')) { wrong.push(`${rel} - no sha256 recorded`); }
    else if (entry.stats.sha256 !== realHash) { wrong.push(`${rel} - recorded ${entry.stats.sha256}, real ${realHash}`); }
  }
  for (const e of fileEntries) {
    if (!onDisc.has(bare(e.path))) { wrong.push(`${e.path} - in the JSON but not on the disc`); }
  }
  const allFilesHashed = wrong.length === 0;
  console.log(`  Every file on the disc is recorded with its real sha256: ${allFilesHashed ? 'OK' : 'WRONG'} (${filesOnDisc.length} files checked)`);
  for (const w of wrong) { console.log(`    WRONG: ${w}`); }

  const noDirHasHash = dirEntries.every((e) => e.stats.sha256 === undefined);
  console.log(`  No directory entry has a sha256 field: ${noDirHasHash ? 'OK' : 'WRONG'} (${dirEntries.length} directories checked)`);

  const endsOnARealDisc = Array.isArray(metadata) && metadata.length > 0 && metadata[metadata.length - 1].length > 0;
  console.log(`  The JSON does not end in an empty disc entry: ${endsOnARealDisc ? 'OK' : 'WRONG'} (${(metadata || []).length} disc(s), last holds ${(metadata || []).length ? (metadata[metadata.length - 1] || []).length : '-'} item(s))`);

  const verifyPassed = allFilesHashed && noDirHasHash && endsOnARealDisc;

  if (verifyPassed) {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  } else {
    console.log(`\nLeaving scratch files in place for inspection: ${scratchRoot}`);
  }

  console.log(`\n${verifyPassed ? 'PASS' : 'FAIL'} - ${verifyPassed
    ? 'the "I do not have a json" flow built a metadata JSON from the disc alone, holding every file with its real sha256.'
    : 'did not produce the expected result - see the OK/WRONG lines above.'}`);
  process.exitCode = verifyPassed ? 0 : 1;
}

main().catch((e) => {
  const message = (e && e.message) || String(e);
  const fullDetail = (e && e.stack) ? e.stack : message;
  if (/closed|Target .*(closed|crashed)/i.test(message)) {
    console.error(`\nTEST ERRORED: the app window was closed before the test finished (${message}).`);
  } else {
    const logPath = path.join(FIXTURES_ROOT, `optical-backup-ui-add-missing-no-json-sha256-error-${Date.now()}.log`);
    try { fs.writeFileSync(logPath, fullDetail); } catch { /* best effort */ }
    console.error(`\nTEST ERRORED: ${message}`);
    console.error(`Full details saved to: ${logPath}`);
  }
  process.exitCode = 1;
});
