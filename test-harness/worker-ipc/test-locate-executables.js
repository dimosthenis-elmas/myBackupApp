#!/usr/bin/env node
'use strict';

/**
 * The app finds 7-Zip and ImgBurn itself (locate-executables - locateExecutables in app/workers/worker.ts, run by the
 * app at every start): a path in appData/config.json that no longer points to a file is looked for where the program
 * is usually installed, and what is found is saved - with nothing asked. Through the app's real worker IPC:
 *  1. Both paths pointing to files that do not exist: both programs are found on this computer - each saved path is
 *     an existing 7z.exe / ImgBurn.exe - nothing is reported as not found, and the rest of config.json is kept.
 *  2. A path that points to an existing file is kept as it is, even when it is not where the program is usually
 *     installed.
 *
 * Needs 7-Zip and ImgBurn installed (as the app itself does). appData/config.json is restored byte for byte after.
 * NOTE: needs a real Windows desktop/window session (see call-worker.js's top comment).
 *
 * Usage:
 *   node test-harness/worker-ipc/test-locate-executables.js
 */

const fs = require('fs');
const path = require('path');
const { launchApp, callWorker } = require('./call-worker');
const { backupAndRedirectConfigField, restoreConfig } = require('../lib/ibb-tools');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');

const CONFIG_PATH = path.resolve(__dirname, '../../appData/config.json');
const readConfig = () => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

async function main() {
  const scratchRoot = path.join(FIXTURES_ROOT, `locate-executables-${Date.now()}`);
  const nowhere = path.join(scratchRoot, 'no such folder');
  const own7z = path.join(scratchRoot, 'my own copy', '7z.exe');
  fs.mkdirSync(path.dirname(own7z), { recursive: true });
  fs.writeFileSync(own7z, 'stands in for a 7z.exe kept somewhere unusual');

  const results = {};
  const report = (name, ok, detail = '') => {
    results[name] = !!ok;
    console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? `  (${detail})` : ''}`);
  };
  let app, win, originalConfigContent;
  try {
    console.log('Launching the app...');
    ({ app, win } = await launchApp());
    await new Promise((r) => setTimeout(r, 3000)); // the app's own startup checks, locate-executables included, first

    console.log('\n1. Both paths pointing to files that do not exist...');
    originalConfigContent = backupAndRedirectConfigField('_7zipExecutablePath', path.join(nowhere, '7z.exe'));
    backupAndRedirectConfigField('imgBurnExecutablePath', path.join(nowhere, 'ImgBurn.exe'));
    const notFound = (await callWorker(win, 'locate-executables', {}, 60_000)).res;
    const after = readConfig();
    report('nothingIsReportedAsNotFound', Array.isArray(notFound) && notFound.length === 0, JSON.stringify(notFound));
    report('anExisting7zExeIsSaved', /\\7z\.exe$/i.test(after._7zipExecutablePath) && isFile(after._7zipExecutablePath), after._7zipExecutablePath);
    report('anExistingImgBurnExeIsSaved', /\\ImgBurn\.exe$/i.test(after.imgBurnExecutablePath) && isFile(after.imgBurnExecutablePath), after.imgBurnExecutablePath);
    report('theRestOfConfigJsonIsKept', after.cacheDataDirectoryPath === JSON.parse(originalConfigContent).cacheDataDirectoryPath,
      after.cacheDataDirectoryPath);

    console.log('\n2. A path that points to an existing file, somewhere unusual...');
    backupAndRedirectConfigField('_7zipExecutablePath', own7z);
    const notFound2 = (await callWorker(win, 'locate-executables', {}, 60_000)).res;
    report('itIsKeptAsItIs', notFound2.length === 0 && readConfig()._7zipExecutablePath === own7z, readConfig()._7zipExecutablePath);
  } finally {
    if (app) { await app.close().catch(() => {}); }
    if (originalConfigContent !== undefined) { restoreConfig(originalConfigContent); }
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }

  const failed = Object.entries(results).filter(([, ok]) => !ok).map(([name]) => name);
  const pass = Object.keys(results).length === 5 && failed.length === 0;
  console.log(`\n${pass ? 'PASS' : 'FAIL'} - 7-Zip and ImgBurn are found and saved where config.json does not point to them, ` +
    `and a path that exists is kept.${failed.length ? ` Failed: ${failed.join(', ')}` : ''}`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((error) => {
  console.error('TEST ERRORED:', error);
  process.exitCode = 1;
});
