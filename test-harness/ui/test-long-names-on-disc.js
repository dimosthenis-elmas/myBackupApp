#!/usr/bin/env node
'use strict';

/**
 * Names too long for a disc (over 127 characters) and paths too long for most programs (over 259), end to end in
 * the real app - the disc in between built by the real ImgBurn from the project the app wrote:
 *
 *  A. Backup to optical media: "Next" shows "Names too long for a disc", listing every such item (a file, a folder) by
 *     its full path. "Cancel" stops there - no disc plan, no metadata JSON. "Next" again, "Continue" - then "Paths too
 *     long for some programs" lists the deep file; "Continue" plans the disc. After "Send to ImgBurn" (a no-op stub)
 *     and "Confirm disc burned", the metadata JSON has each shortened file at its path on the disc with its original
 *     path, and the disc's list of original names. The real ImgBurn builds the disc image from that project without
 *     changing a single name.
 *  B. Recover from that JSON: the tree shows the original names; "Recover selected data" into a deep folder shows
 *     "Paths too long for some programs"; "Choose another folder" asks again for the new folder; "Continue" recovers
 *     every file under its original name, SHA-256 verified.
 *  C. Recover from the disc alone (no JSON): the tree shows the original names too, and the disc's own list of
 *     original names puts them back.
 *  E. Verify integrity of cold storage disc: the disc is recognized from the JSON, and every file on it - the list of
 *     original names included - is verified, none failed.
 *  D. Add missing files, after a new file with a long name was added - first reading the disc (no JSON), then with the
 *     JSON: only the new file is missing (the shortened ones are recognized as backed up); with the JSON, "Names too
 *     long for a disc" lists it and the new disc's entry records its original path.
 *  Throughout, the source files are never renamed or changed.
 *
 * Never touches the app's real temp folder: cacheDataDirectoryPath points at a scratch folder, and
 * imgBurnExecutablePath at a no-op stub, for the length of the run (the real ImgBurn is only run by this script
 * itself, headless) - config.json is restored byte-for-byte in a finally block.
 *
 * NOTE: needs a real Windows desktop/window session, and ImgBurn configured in appData/config.json. Refuses to run
 * while an optical drive has a disc in it (it mounts an image).
 *
 * Usage:
 *   node test-harness/ui/test-long-names-on-disc.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { launchApp } = require('../worker-ipc/call-worker');
const { backupAndRedirectConfigField, restoreConfig, writeStubImgBurnBat, waitForFile, parseIbbBackupList, confirmedAfterDismissingLinkedDiscsNotice } = require('../lib/ibb-tools');
const { realImgBurnPath, buildIsoWithImgBurn } = require('../lib/imgburn-build');
const { assertNoOpticalMediaAlreadyMounted, mountIso, dismountIso } = require('./iso-disc');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');
const { printTree } = require('../lib/print-tree');
const { discPath, ORIGINAL_NAMES_FILE_NAME, MAX_DISC_NAME_LENGTH } = require('../../app/workers/disc-names');

const PAPER = 'End-to-End_Modeling_of_Hierarchical_Time_Series_Using_Autoregressive_Transformer_and_Conditional_Normalizing_Flow-based_Reconciliation.pdf';
const LONG_FOLDER = 'Φάκελος_' + 'α'.repeat(125);
const DEEP_FILE = `deep\\${'d'.repeat(100)}\\${'d'.repeat(100)}\\${'f'.repeat(60)}.txt`; // 274 characters on a disc
const NEW_LONG_FILE = `papers\\${'N'.repeat(140)}.pdf`;
const FILES = {
  [`papers\\${PAPER}`]: 'the paper',
  [`${LONG_FOLDER}\\inner.txt`]: 'inside a folder whose name is too long',
  [DEEP_FILE]: 'deep down',
  ['ok\\short.txt']: 'nothing special',
};
const D = 'D:\\';
const WATCH_PAUSE_MS = 700;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Every file under `root`, relative, sorted. */
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

/** Name, size, modified time and content hash of every file under `root`. */
function snapshot(root) {
  return listFiles(root).map((rel) => {
    const st = fs.statSync(path.join(root, rel));
    return `${rel} ${st.size} ${st.mtimeMs} ${sha256(path.join(root, rel))}`;
  }).join('\n');
}

/** True if `folder` holds exactly `files` (relative path -> content). */
function holdsExactly(folder, files) {
  if (!fs.existsSync(folder)) { return false; }
  const expected = Object.keys(files).sort();
  return JSON.stringify(listFiles(folder)) === JSON.stringify(expected)
    && expected.every((rel) => fs.readFileSync(path.join(folder, rel), 'utf8') === files[rel]);
}

function sessionFolders(cache) {
  return fs.existsSync(cache) ? fs.readdirSync(cache).filter((n) => /^session-\d+$/.test(n)) : [];
}

async function main() {
  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `long-names-ui-${runId}`);
  const source = path.join(scratchRoot, 'source');
  const cache = path.join(scratchRoot, 'app temp');
  const metadataJsonPath = path.join(scratchRoot, 'cold-storage-metadata.json');
  const updatedJsonPath = path.join(scratchRoot, 'cold-storage-metadata - updated.json');
  const recoveredFirstChoice = path.join(scratchRoot, 'recovered from the JSON, first choice');
  const recoveredFromJson = path.join(scratchRoot, 'recovered from the JSON');
  const recoveredFromDisc = path.join(scratchRoot, 'recovered from the disc alone');
  const isoPath = path.join(scratchRoot, 'disc 1.iso');
  for (const [rel, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(source, rel)), { recursive: true });
    fs.writeFileSync(path.join(source, rel), content);
  }
  for (const folder of [recoveredFirstChoice, recoveredFromJson, recoveredFromDisc]) { fs.mkdirSync(folder, { recursive: true }); }
  printTree(source, 'Source tree (before)');
  let sourceBefore = snapshot(source);

  assertNoOpticalMediaAlreadyMounted();
  const results = {};
  const report = (name, ok, extra) => {
    results[name] = ok;
    console.log(`  ${ok ? 'OK' : 'FAILED'} - ${name}${extra ? `  (${extra})` : ''}`);
  };

  let originalConfigContent;
  let app, win, mounted = false;
  const step = async (label, fn) => {
    process.stdout.write(`  [ ] ${label} ... `);
    try {
      await fn();
    } catch (e) {
      console.log('FAILED');
      const screenshotPath = path.join(FIXTURES_ROOT, `long-names-ui-test-failure-${runId}.png`);
      try { await win.screenshot({ path: screenshotPath }); console.log(`  Screenshot at the point of failure: ${screenshotPath}`); } catch { /* window gone */ }
      throw e;
    }
    console.log('done');
    await pause(WATCH_PAUSE_MS);
  };
  /** Launches the app, with the native pickers answering from `openPaths`/`savePaths` in turn. */
  const launch = async (openPaths, savePaths = []) => {
    ({ app, win } = await launchApp());
    await win.getByText('Cumulative backup', { exact: true }).waitFor({ timeout: 60_000 });
    await pause(3000); // the app's own startup temp-folder check
    await app.evaluate(({ dialog }, { open, save }) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [open.shift()] });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: save.shift() });
    }, { open: [...openPaths], save: [...savePaths] });
  };
  const close = async () => { if (app) { await app.close().catch(() => {}); app = undefined; } };
  const openFeature = (name) => win.locator('.grid-container > div').filter({ has: win.locator('h2', { hasText: name }) }).locator('button').click();
  // The newest such dialog: one asked again right after the previous one closed can still share the screen with it
  // while that one fades out.
  const dialogTitled = (title) => win.getByRole('dialog').filter({ has: win.getByRole('heading', { name: title, exact: true }) }).last();
  const listsAll = async (title, items) => {
    const dialog = dialogTitled(title);
    await dialog.waitFor({ timeout: 60_000 });
    for (const item of items) { await dialog.getByText(item, { exact: true }).first().waitFor({ timeout: 10_000 }); }
  };
  const clickIn = (title, button) => dialogTitled(title).getByRole('button', { name: button, exact: true }).click({ timeout: 15_000 });

  try {
    originalConfigContent = backupAndRedirectConfigField('cacheDataDirectoryPath', cache);
    const imgBurnExe = realImgBurnPath(originalConfigContent);
    const stub = path.join(scratchRoot, 'stub imgburn.bat');
    writeStubImgBurnBat(stub);
    backupAndRedirectConfigField('imgBurnExecutablePath', stub);

    // ---- A. Backup to optical media
    console.log('\nA. Backup to optical media...');
    await launch([source], [metadataJsonPath]);
    await step('main menu -> Backup to optical media', () => openFeature('Backup to optical media'));
    await step('choose the folder to back up', async () => {
      await win.getByRole('button', { name: 'Path to backup' }).click({ timeout: 15_000 });
      await win.getByText(source, { exact: true }).waitFor({ timeout: 10_000 });
    });
    await step('choose "CD (700 MB)" and a collection name', async () => {
      await win.getByRole('combobox').click({ timeout: 15_000 });
      await win.getByRole('option', { name: 'CD (700 MB)' }).click({ timeout: 15_000 });
      await win.getByPlaceholder('e.g. My Backup').fill('Long names test');
    });
    const longNameItems = [path.join(source, 'papers', PAPER), path.join(source, LONG_FOLDER)];
    await step('"Next" - "Names too long for a disc" lists the long file and the long folder by full path', async () => {
      await win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 });
      await listsAll('Names too long for a disc', longNameItems);
    });
    await step(`"Cancel - I'll shorten them myself"`, () => clickIn('Names too long for a disc', `Cancel - I'll shorten them myself`));
    await pause(3000);
    report('cancelStopsBeforeAnyDiscIsPlanned',
      (await win.getByText('Backup to optical medium', { exact: true }).count()) === 0 && !fs.existsSync(metadataJsonPath)
      && (await win.getByRole('button', { name: 'Path to backup' }).count()) === 1);

    await step('"Next" again - the same dialog; "Continue - shorten them on the disc"', async () => {
      await win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 });
      await listsAll('Names too long for a disc', longNameItems);
      await clickIn('Names too long for a disc', 'Continue - shorten them on the disc');
    });
    await step('"Paths too long for some programs" lists the deep file; "Continue - burn them as they are"', async () => {
      await listsAll('Paths too long for some programs', [path.join(source, DEEP_FILE)]);
      await clickIn('Paths too long for some programs', 'Continue - burn them as they are');
    });
    await step('the disc count dialog, then "Next"', async () => {
      await win.getByText('Backup to optical medium', { exact: true }).waitFor({ timeout: 30_000 });
      await win.getByRole('dialog').getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 });
      await win.getByText('Burn backup to optical media', { exact: true }).waitFor({ timeout: 30_000 });
    });
    await step('"Send to ImgBurn" and "Ok" on the disc label', async () => {
      await win.getByRole('tab', { name: 'Optical disk 1', exact: false }).click({ timeout: 15_000 });
      await win.getByRole('button', { name: 'Send to ImgBurn' }).click({ timeout: 15_000 });
      await win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 });
    });
    const firstSession = await (async () => { for (let i = 0; i < 75 && sessionFolders(cache).length === 0; i++) { await pause(200); } return sessionFolders(cache)[0]; })();
    const firstIbb = path.join(cache, firstSession || 'no-session', 'Disk_1.ibb');
    await waitForFile(firstIbb, 30_000);
    await step('"Confirm disc burned"', async () => {
      await win.getByRole('button', { name: 'Confirm disc burned' }).click({ timeout: 15_000 });
      await confirmedAfterDismissingLinkedDiscsNotice(win);
    });
    const recorded = () => { try { return JSON.parse(fs.readFileSync(metadataJsonPath, 'utf8')); } catch { return null; } };
    for (let i = 0; i < 60 && !(recorded() && recorded()[0] && recorded()[0].length > 0); i++) { await pause(500); }
    await close();

    const disc1 = (recorded() || [[]])[0];
    const entryAt = (p) => disc1.find((e) => e.path === p);
    const shortenedRecorded = [`papers\\${PAPER}`, `${LONG_FOLDER}\\inner.txt`].every((rel) =>
      entryAt(D + discPath(rel)) && entryAt(D + discPath(rel)).originalPath === D + rel && discPath(rel) !== rel);
    const othersRecorded = [DEEP_FILE, 'ok\\short.txt'].every((rel) => entryAt(D + rel) && entryAt(D + rel).originalPath === undefined);
    const list = entryAt(D + ORIGINAL_NAMES_FILE_NAME);
    report('theJsonHasEachShortenedFileAtItsDiscPathWithItsOriginalPath', shortenedRecorded && othersRecorded && disc1.length === 5);
    report('theJsonHasTheDiscsListOfOriginalNames', !!list && list.originalNamesList === true && /^[0-9a-f]{64}$/.test(list.stats.sha256 || ''));
    const ibbNames = parseIbbBackupList(firstIbb).map((e) => e.name);
    report('noNameInTheProjectIsOver127', ibbNames.every((n) => n.length <= MAX_DISC_NAME_LENGTH));

    console.log('\nBuilding the disc image with the real ImgBurn...');
    const build = buildIsoWithImgBurn(imgBurnExe, firstIbb, isoPath, path.join(scratchRoot, 'imgburn.log'));
    report('imgBurnBuildsItWithoutChangingAName', build.built && build.problems.length === 0, build.problems.join(' / '));
    mountIso(isoPath);
    mounted = true;

    // ---- B. Recover from the JSON
    console.log('\nB. Recover data, from the JSON...');
    await launch([recoveredFirstChoice, metadataJsonPath, recoveredFromJson]);
    await step('main menu -> Recover data from optical media backup', () => openFeature('Recover data from optical media backup'));
    await step('choose the recovery folder and the JSON, "Next"', async () => {
      await win.getByRole('button', { name: 'Select a directory to save the recovered files' }).click({ timeout: 15_000 });
      await win.getByText(recoveredFirstChoice, { exact: true }).waitFor({ timeout: 10_000 });
      await win.getByRole('checkbox', { name: 'Provide cold storage files metadata by importing a JSON file' }).click({ timeout: 15_000 });
      await win.getByRole('button', { name: 'Select JSON file' }).click({ timeout: 15_000 });
      await win.getByText(metadataJsonPath, { exact: true }).waitFor({ timeout: 10_000 });
      await pause(2000); // the JSON is still being read and checked (see test-recover-from-json-metadata.js)
      await win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 });
      await win.getByRole('checkbox', { name: 'Select all' }).waitFor({ state: 'visible', timeout: 60_000 });
    });
    // The files to choose from: the original names (a file, a folder), not the disc's shorter ones, nor its list of them.
    const treeShowsTheOriginalNames = async () => {
      const shown = async (name) => win.getByRole('checkbox', { name: new RegExp(escapeRegExp(name)) }).count();
      return (await shown(PAPER)) === 1 && (await shown(LONG_FOLDER)) === 1
        && (await shown(discPath(`papers\\${PAPER}`).split('\\').pop())) === 0 && (await shown(discPath(LONG_FOLDER))) === 0
        && (await shown(ORIGINAL_NAMES_FILE_NAME)) === 0;
    };
    report('theRecoveryTreeShowsTheOriginalNames', await treeShowsTheOriginalNames());
    await step('"Select all", "Recover selected data" - "Paths too long for some programs" lists the deep file', async () => {
      await win.getByRole('checkbox', { name: 'Select all' }).click({ timeout: 15_000 });
      await win.getByRole('button', { name: 'Recover selected data' }).click({ timeout: 15_000 });
      await listsAll('Paths too long for some programs', [path.join(recoveredFirstChoice, DEEP_FILE)]);
    });
    await step('"Choose another folder" - asked again, for the new folder; "Continue - recover them here"', async () => {
      await clickIn('Paths too long for some programs', 'Choose another folder');
      await listsAll('Paths too long for some programs', [path.join(recoveredFromJson, DEEP_FILE)]);
      await clickIn('Paths too long for some programs', 'Continue - recover them here');
    });
    await step('"Ok" on "insert the discs", then on "Data recovery successful" (SHA-256 checked)', async () => {
      await win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 30_000 });
      await pause(1000); // see test-recover-single-disc.js
      await dialogTitled('Data recovery successful').waitFor({ timeout: 90_000 });
      await clickIn('Data recovery successful', 'Ok');
    });
    await close();
    report('recoveryFromTheJsonPutsEveryOriginalNameBack', holdsExactly(recoveredFromJson, FILES) && listFiles(recoveredFirstChoice).length === 0,
      `${fs.existsSync(recoveredFromJson) ? listFiles(recoveredFromJson).length : 0} files`);

    // ---- C. Recover from the disc alone
    console.log('\nC. Recover data, from the disc alone...');
    await launch([recoveredFromDisc]);
    await step('main menu -> Recover data from optical media backup', () => openFeature('Recover data from optical media backup'));
    await step('choose the recovery folder, "Next", read the disc', async () => {
      await win.getByRole('button', { name: 'Select a directory to save the recovered files' }).click({ timeout: 15_000 });
      await win.getByText(recoveredFromDisc, { exact: true }).waitFor({ timeout: 10_000 });
      await win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 });
      await win.getByRole('button', { name: 'All disks have been processed, continue to the next step' }).click({ timeout: 60_000 });
      await win.getByRole('checkbox', { name: 'Select all' }).waitFor({ state: 'visible', timeout: 60_000 });
    });
    report('theRecoveryTreeShowsTheOriginalNamesWithoutTheJsonToo', await treeShowsTheOriginalNames());
    await step('"Select all", "Recover selected data", "Continue - recover them here"', async () => {
      await win.getByRole('checkbox', { name: 'Select all' }).click({ timeout: 15_000 });
      await win.getByRole('button', { name: 'Recover selected data' }).click({ timeout: 15_000 });
      await listsAll('Paths too long for some programs', [path.join(recoveredFromDisc, DEEP_FILE)]);
      await clickIn('Paths too long for some programs', 'Continue - recover them here');
    });
    await step('"Ok" on "insert the discs", then on "Data recovery successful"', async () => {
      await win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 30_000 });
      await pause(1000);
      await dialogTitled('Data recovery successful').waitFor({ timeout: 90_000 });
      await clickIn('Data recovery successful', 'Ok');
    });
    await close();
    report('recoveryFromTheDiscAlonePutsEveryOriginalNameBack', holdsExactly(recoveredFromDisc, FILES),
      `${listFiles(recoveredFromDisc).length} files`);

    // ---- E. Verify integrity
    console.log('\nE. Verify integrity of the disc...');
    await launch([metadataJsonPath]);
    await step('main menu -> Verify integrity of cold storage disc', () => openFeature('Verify integrity of cold storage disc'));
    await step('"Choose metadata JSON" - the disc is recognized and checked', async () => {
      await win.getByRole('button', { name: 'Choose metadata JSON' }).click({ timeout: 15_000 });
      await win.getByText('Disc 1: verification successful', { exact: true }).waitFor({ timeout: 60_000 });
    });
    const verifyResult = await win.getByRole('dialog').innerText();
    // Every file of the disc has a checksum - the list of original names too: 4 files + the list.
    report('verifyChecksEveryFileOfTheDiscAndFindsNoFailure', /FAILED: 0\b/.test(verifyResult) && /Verified: 5\b/.test(verifyResult),
      verifyResult.replace(/\s+/g, ' ').slice(0, 160));
    await close();

    report('theSourceFilesWereNotChanged', snapshot(source) === sourceBefore);

    // ---- D. Add missing files - first reading the disc (no JSON), then with the JSON
    console.log('\nD. Add missing files, after a new file with a long name - without the JSON, reading the disc...');
    fs.writeFileSync(path.join(source, NEW_LONG_FILE), 'added later');
    sourceBefore = snapshot(source);
    await launch([source]);
    await step('main menu -> Add missing files, "Ok" on its notice', async () => {
      await openFeature('Add missing files to optical media cold storage');
      await win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 });
    });
    await step('choose the master folder, "Next" (no JSON), read the disc', async () => {
      await win.getByRole('button', { name: 'Select the location of your files (Master)' }).click({ timeout: 15_000 });
      await win.getByText(source, { exact: true }).waitFor({ timeout: 10_000 });
      await win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 });
      await win.getByRole('button', { name: 'All disks have been processed, continue to the next step' }).click({ timeout: 60_000 });
      await win.getByRole('checkbox', { name: 'Select all' }).waitFor({ state: 'visible', timeout: 60_000 });
    });
    const newName = NEW_LONG_FILE.split('\\').pop();
    const onlyTheNewFileIsListed = async () =>
      (await win.getByRole('checkbox', { name: new RegExp(escapeRegExp(newName)) }).count()) === 1
      && (await win.getByRole('checkbox', { name: new RegExp(escapeRegExp(PAPER)) }).count()) === 0
      && (await win.getByRole('checkbox', { name: /inner\.txt|short\.txt|f{60}\.txt/ }).count()) === 0;
    report('withoutTheJsonOnlyTheNewFileIsMissing', await onlyTheNewFileIsListed());
    await close();
    dismountIso(isoPath);
    mounted = false;

    console.log('\nD. Add missing files, with the JSON...');
    const sessionsBefore = sessionFolders(cache);
    await launch([source, metadataJsonPath], [updatedJsonPath]);
    await step('main menu -> Add missing files, "Ok" on its notice', async () => {
      await openFeature('Add missing files to optical media cold storage');
      await win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 });
    });
    await step('choose the master folder, "CD (700 MB)" and the JSON, "Next"', async () => {
      await win.getByRole('button', { name: 'Select the location of your files (Master)' }).click({ timeout: 15_000 });
      await win.getByText(source, { exact: true }).waitFor({ timeout: 10_000 });
      await win.getByRole('combobox').click({ timeout: 15_000 });
      await win.getByRole('option', { name: 'CD (700 MB)' }).click({ timeout: 15_000 });
      await win.getByRole('checkbox', { name: 'Provide cold storage files metadata by importing a JSON file', exact: false }).click({ timeout: 15_000 });
      await win.getByRole('button', { name: 'Select JSON file' }).click({ timeout: 15_000 });
      await win.getByText(metadataJsonPath, { exact: true }).waitFor({ timeout: 10_000 });
      await pause(2000);
      await win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 });
      await win.getByRole('checkbox', { name: 'Select all' }).waitFor({ state: 'visible', timeout: 60_000 });
    });
    report('onlyTheNewFileIsMissing', await onlyTheNewFileIsListed());
    await step('collection name, "Next" - "Names too long for a disc" lists the new file; "Continue"', async () => {
      await win.getByPlaceholder('e.g. My Backup').fill('Long names test');
      await win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 });
      await listsAll('Names too long for a disc', [path.join(source, NEW_LONG_FILE)]);
      await clickIn('Names too long for a disc', 'Continue - shorten them on the disc');
    });
    await step('"Ok" on "Cold storage metadata prepared"', async () => {
      await dialogTitled('Cold storage metadata prepared').waitFor({ timeout: 60_000 });
      await clickIn('Cold storage metadata prepared', 'Ok');
    });
    await step('"Send disk 2 to ImgBurn", "Ok" on the disc label', async () => {
      await win.getByRole('tab', { name: 'Optical disk 2', exact: false }).click({ timeout: 15_000 });
      await win.getByRole('button', { name: 'Send disk 2 to ImgBurn' }).click({ timeout: 15_000 });
      await win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 });
    });
    const newSession = await (async () => {
      for (let i = 0; i < 75; i++) {
        const fresh = sessionFolders(cache).filter((s) => !sessionsBefore.includes(s));
        if (fresh.length > 0) { return fresh[0]; }
        await pause(200);
      }
      return 'no-session';
    })();
    const secondIbb = path.join(cache, newSession, 'Disk_1.ibb');
    await waitForFile(secondIbb, 30_000);
    await step('"Confirm disc burned"', async () => {
      await win.getByRole('button', { name: 'Confirm disc burned' }).click({ timeout: 15_000 });
      await confirmedAfterDismissingLinkedDiscsNotice(win);
    });
    const updated = () => { try { return JSON.parse(fs.readFileSync(updatedJsonPath, 'utf8')); } catch { return null; } };
    for (let i = 0; i < 60 && !(updated() && updated()[1] && updated()[1].length > 0); i++) { await pause(500); }
    await close();
    const disc2 = (updated() || [[], []])[1] || [];
    const newEntry = disc2.find((e) => e.originalPath === D + NEW_LONG_FILE);
    report('theNewDiscRecordsTheNewFilesOriginalPath',
      !!newEntry && newEntry.path === D + discPath(NEW_LONG_FILE) && disc2.some((e) => e.originalNamesList === true)
      && JSON.stringify(updated()[0]) === JSON.stringify(disc1)
      && parseIbbBackupList(secondIbb).some((e) => e.type === 'F' && e.name === discPath(NEW_LONG_FILE).split('\\').pop()));
    report('theSourceFilesWereNotChangedByAddMissingFiles', snapshot(source) === sourceBefore);
  } finally {
    await close();
    if (originalConfigContent !== undefined) { restoreConfig(originalConfigContent); }
    if (mounted) { try { dismountIso(isoPath); } catch { /* the failure is reported already */ } }
  }

  const pass = Object.keys(results).length > 0 && Object.values(results).every(Boolean);
  console.log('\nSummary:');
  for (const [check, ok] of Object.entries(results)) { console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${check}`); }
  if (pass) {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  } else {
    console.log(`\nLeaving scratch files in place for inspection: ${scratchRoot}`);
  }
  console.log(`\n${pass ? 'PASS' : 'FAIL'} - long names and long paths ${pass ? 'were listed before burning and recovering, shortened on the disc only, and recovered under their original names.' : 'were not handled as expected, see above.'}`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => {
  const message = (e && e.message) || String(e);
  const logPath = path.join(FIXTURES_ROOT, `long-names-ui-test-error-${Date.now()}.log`);
  try { fs.mkdirSync(FIXTURES_ROOT, { recursive: true }); fs.writeFileSync(logPath, (e && e.stack) || message); } catch { /* best effort */ }
  console.error(`\nTEST ERRORED: ${message}`);
  console.error(`Full details saved to: ${logPath}`);
  process.exitCode = 1;
});
