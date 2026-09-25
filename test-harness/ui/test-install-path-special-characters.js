#!/usr/bin/env node
'use strict';

/**
 * The app has to work from wherever its folder is copied (it is portable), including a folder whose name holds
 * characters that mean something in a URL. This copies the built app (app/, dist/, and appData's config.json and
 * IBB_TEMPLATE.ibb - not its logs or temp files) into a fresh folder named "app copy # 100% <run id>" under
 * test-harness/generated-fixtures/, launches THAT copy, and checks:
 *
 *   - The main menu appears, loaded from the copy's own dist folder. The page used to be loaded from a
 *     "file:" URL glued together from the path, where "#" starts a fragment and "%" an escape - so from such a
 *     folder the window stayed blank.
 *   - Nothing is loaded from the internet: every request the page makes while the app is loaded again from the
 *     copy's index.html is for a local file (the fonts and icons used to come from Google Fonts, so the app looked
 *     wrong offline).
 *   - The Roboto text font and the Material Icons font are really loaded - with nothing fetched from the
 *     internet, necessarily from the copy's own assets/fonts.
 *
 * The app has to be built first (npm run build:prod) - this copies the build output, it does not build.
 *
 * NOTE: needs a real Windows desktop/window session (see worker-ipc/call-worker.js's top comment) - run from your
 * own interactive terminal.
 *
 * Usage:
 *   node test-harness/ui/test-install-path-special-characters.js
 */

const fs = require('fs');
const path = require('path');
const { fileURLToPath, pathToFileURL } = require('url');
const { launchApp } = require('../worker-ipc/call-worker');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');

const REPO_ROOT = path.join(__dirname, '../..');

async function main() {
  const runId = Date.now();
  const copyRoot = path.join(FIXTURES_ROOT, `app copy # 100% ${runId}`);
  if (!fs.existsSync(path.join(REPO_ROOT, 'dist', 'index.html')) || !fs.existsSync(path.join(REPO_ROOT, 'app', 'main.js'))) {
    throw new Error('The app is not built (dist/index.html or app/main.js missing) - run "npm run build:prod" first.');
  }
  console.log(`Copying the built app to: ${copyRoot}`);
  fs.cpSync(path.join(REPO_ROOT, 'app'), path.join(copyRoot, 'app'), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'dist'), path.join(copyRoot, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(copyRoot, 'appData'), { recursive: true });
  for (const name of ['config.json', 'IBB_TEMPLATE.ibb']) {
    fs.copyFileSync(path.join(REPO_ROOT, 'appData', name), path.join(copyRoot, 'appData', name));
  }

  const results = {};
  let app, win;
  try {
    console.log('Launching the copy...');
    ({ app, win } = await launchApp({}, copyRoot));

    await win.getByText('Synchronize directories').first().waitFor({ timeout: 30_000 });
    results['the main menu appears'] = true;

    // The app's router replaces "index.html" in the address with the page shown ("main-menu"), so what can be
    // checked is the folder the page came from.
    const copyDist = path.join(copyRoot, 'dist');
    let loadedFrom = '';
    try { loadedFrom = fileURLToPath(win.url()); } catch { loadedFrom = win.url(); }
    results['the page comes from the copy\'s own dist folder'] = loadedFrom.toLowerCase().startsWith((copyDist + path.sep).toLowerCase());
    console.log(`  page loaded from: ${loadedFrom}`);

    // Every request the page makes, recorded while the app is loaded again from the copy's index.html - the same
    // address main.js loads. (Chromium keeps no resource-timing entries for file: pages, so this is how to see them.)
    const requested = [];
    win.on('request', (request) => requested.push(request.url()));
    await win.goto(pathToFileURL(path.join(copyDist, 'index.html')).href);
    await win.getByText('Synchronize directories').first().waitFor({ timeout: 30_000 });
    const loadedFamilies = await win.evaluate(async () => {
      await document.fonts.load('16px "Roboto"');
      await document.fonts.load('24px "Material Icons"', 'home');
      await document.fonts.ready;
      return [...document.fonts].filter((face) => face.status === 'loaded').map((face) => face.family.replace(/["']/g, ''));
    });
    const remote = requested.filter((u) => /^https?:/i.test(u));
    results['nothing is loaded from the internet'] = requested.length > 0 && remote.length === 0;
    console.log(`  ${requested.length} request(s) while loading${remote.length ? `, from the internet: ${JSON.stringify(remote.slice(0, 5))}` : ', none from the internet'}`);
    // With nothing fetched from the internet, a font that did load can only be one of the app's own files.
    results['the Roboto font is loaded from the app\'s own files'] = remote.length === 0 && loadedFamilies.includes('Roboto');
    results['the Material Icons font is loaded from the app\'s own files'] = remote.length === 0 && loadedFamilies.includes('Material Icons');
    console.log(`  fonts loaded: ${JSON.stringify([...new Set(loadedFamilies)])}`);
    const fontFiles = requested.filter((u) => /\.woff2$/i.test(u)).map((u) => decodeURIComponent(u.split('/').pop()));
    if (fontFiles.length) { console.log(`  font files requested: ${JSON.stringify(fontFiles)}`); }
  } finally {
    if (app) { await app.close().catch(() => {}); }
  }

  const pass = Object.keys(results).length === 5 && Object.values(results).every(Boolean);
  console.log('\nSummary:');
  for (const [check, ok] of Object.entries(results)) { console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${check}`); }
  if (pass) {
    fs.rmSync(copyRoot, { recursive: true, force: true });
  } else {
    console.log(`\nLeaving the copy in place for inspection: ${copyRoot}`);
  }
  console.log(`\n${pass ? 'PASS' : 'FAIL'} - the app ${pass ? 'ran from a folder with "#" and "%" in its name, entirely from its own files.' : 'did not run correctly from a copied folder, see above.'}`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => {
  console.error('\nTEST ERRORED:', (e && e.message) || e);
  process.exitCode = 1;
});
