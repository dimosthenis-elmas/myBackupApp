#!/usr/bin/env node
'use strict';

/**
 * What "Add missing files to optical media cold storage" does with a metadata JSON it cannot use - through the real
 * app (Playwright clicks). Cases 1-6 hand it to the "Update JSON" task; case 7 is the "Add new files" task's own
 * "Select JSON file" picker, which has to react to a bad pick the same way. Nothing here reaches a disc: every case
 * is decided before the flow asks for one, so this test builds no .iso and mounts nothing.
 *
 *   1. An empty file (0 bytes), and 2. a file holding only whitespace, are the same thing to this flow as
 *   3. a JSON that is valid but records no discs ([]): nothing to lose, so the flow does not stop and does not
 *      ask - it carries on to "where to save the updated metadata JSON", writes it there, and moves on to reading
 *      discs from disc 1, exactly like "I do not have a json" does. All three are checked here.
 *   4. A file that holds something which is NOT valid JSON is still refused, in plain words - that one may be a
 *      real metadata JSON that got damaged or was only partly written, and it must not be written over.
 *   5. A JSON that records the same file on two discs is refused before anything is written, naming the file: left
 *      to the disc read, it would make every disc inserted afterwards be refused as "files in common with a disc
 *      read before", blaming the disc in the drive for something the JSON says.
 *   6. But two discs that each needed shortened names carry a list of original names at the SAME path on both (see
 *      disc-names.ts), so that path repeating is not the same thing and must NOT be refused.
 *   7. A pick that fails (4) must not leave the JSON loaded BEFORE it in force: "Next" has to ask for a JSON again,
 *      not silently diff the master folder against the file the user just replaced.
 *
 * NOTE: needs a real Windows desktop/window session (see worker-ipc/call-worker.js's top comment) - run from
 * your own interactive terminal.
 *
 * Usage:
 *   node test-harness/ui/test-add-missing-files-update-json-bad-input.js
 */

const fs = require('fs');
const path = require('path');
const { launchApp } = require('../worker-ipc/call-worker');
const { waitForFile } = require('../lib/ibb-tools');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');

const WATCH_PAUSE_MS = 1000;

const checks = [];

function check(label, ok, detail) {
  checks.push({ label, ok });
  console.log(`  [${ok ? 'OK' : 'WRONG'}] ${label}${detail ? ` - ${detail}` : ''}`);
}

async function clickMainMenuButton(win, labelText) {
  const container = win.locator('.grid-container > div').filter({ has: win.locator('h2', { hasText: labelText }) });
  await container.locator('button').click();
}

/** One metadata JSON entry, hand-built (the app itself is what normally writes these - see the sibling test that
 *  builds the seed through the real "I do not have a json" flow). Only the fields the schema requires, plus the
 *  flag this file needs where it is used. */
function entryOnDisc(path, extra = {}) {
  return { path, stats: { size: 3, mtime: '2026-01-01T00:00:00.000Z', isDirectory: false }, ...extra };
}

const NAMES_LIST_PATH = 'D:\\my-backup original names.json';

/** Fresh app, fresh stubbed native dialogs: showOpenDialog hands back `openQueue` in order, showSaveDialog hands
 *  back `saveQueue` in order and records every call it got (`globalThis.__dialogs.savedTo`), so a scenario can
 *  tell "the flow stopped before asking where to save" from "it carried on". */
async function withApp(label, runId, { openQueue, saveQueue }, body) {
  let app, win;
  const step = async (text, fn) => {
    process.stdout.write(`  [ ] ${text} ... `);
    try {
      await fn();
    } catch (e) {
      console.log('FAILED');
      const screenshotPath = path.join(FIXTURES_ROOT, `optical-backup-ui-update-json-bad-input-${label}-${runId}.png`);
      try { await win.screenshot({ path: screenshotPath }); console.log(`  Screenshot saved to: ${screenshotPath}`); } catch { /* window gone */ }
      throw e;
    }
    console.log('done');
    await new Promise((r) => setTimeout(r, WATCH_PAUSE_MS));
  };
  try {
    ({ app, win } = await launchApp());
    await app.evaluate(({ dialog }, cfg) => {
      const open = [...cfg.openQueue];
      const save = [...cfg.saveQueue];
      globalThis.__dialogs = { savedTo: [] };
      dialog.showOpenDialog = async () => {
        const next = open.shift();
        return next ? { canceled: false, filePaths: [next] } : { canceled: true, filePaths: [] };
      };
      dialog.showSaveDialog = async (w, opts) => {
        globalThis.__dialogs.savedTo.push((opts && opts.defaultPath) || '');
        const next = save.shift();
        return next ? { canceled: false, filePath: next } : { canceled: true };
      };
    }, { openQueue, saveQueue });
    // Let the app's own startup temp-leftover check settle before any raw IPC would race it (see
    // test-add-missing-files.js's identical pause).
    await new Promise((r) => setTimeout(r, 3000));
    await body(win, step, app);
  } finally {
    if (app) { await app.close().catch(() => {}); }
  }
}

async function main() {
  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `add-missing-update-json-bad-input-${runId}`);
  fs.mkdirSync(scratchRoot, { recursive: true });

  /** One "nothing in this file, so treat it as a cold storage that records no discs yet" scenario. */
  const scenarioOfAnEmptyMetadataJson = async (label, fileName, fileContent) => {
    const jsonPath = path.join(scratchRoot, fileName);
    const updatedJsonPath = path.join(scratchRoot, fileName.replace(/\.json$/, '') + ' - updated.json');
    fs.writeFileSync(jsonPath, fileContent);
    console.log(`\n=== ${label}`);
    await withApp(label, runId, { openQueue: [jsonPath], saveQueue: [updatedJsonPath] }, async (win, step, app) => {
      await step('main menu -> Add missing files to optical media cold storage', () =>
        clickMainMenuButton(win, 'Add missing files to optical media cold storage'));
      await step('click "Ok" on the wizard\'s notice', () =>
        win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 }));
      await step('click "Update JSON" (opens the file picker)', () =>
        win.getByRole('button', { name: 'Update JSON' }).click({ timeout: 15_000 }));

      let wrote = false;
      await step('wait for the flow to carry on and write the updated metadata JSON', async () => {
        try { await waitForFile(updatedJsonPath, 30_000); wrote = true; } catch { /* reported as a check below */ }
      });
      check(`${label}: the flow carried on to "where to save the updated JSON" and wrote it there`, wrote);
      if (wrote) {
        const written = fs.readFileSync(updatedJsonPath, 'utf8').trim();
        check(`${label}: what it wrote there is the empty metadata JSON it will now read discs into`, written === '[]',
          `the file holds "${written}"`);
        check(`${label}: the wizard left step 1 and is waiting for discs to be inserted`, await win
          .getByText('Update cold storage metadata with existing (already burnt) discs')
          .waitFor({ state: 'detached', timeout: 30_000 }).then(() => true, () => false));
      }
    });
  };

  await scenarioOfAnEmptyMetadataJson('an empty file', 'empty.json', '');
  await scenarioOfAnEmptyMetadataJson('a whitespace-only file', 'whitespace-only.json', '  \r\n\t\n   ');
  await scenarioOfAnEmptyMetadataJson('a JSON that records no discs', 'no-discs.json', '[]');

  // ---- 4. A file holding something that is not valid JSON at all is still refused ----
  {
    const label = 'a damaged (partly written) JSON';
    const jsonPath = path.join(scratchRoot, 'damaged.json');
    const updatedJsonPath = path.join(scratchRoot, 'damaged - updated.json');
    fs.writeFileSync(jsonPath, '[{"path": "D:\\\\a.txt", "stats": {"size": 3, "mtime": "2026-01-01T00:00:00');
    console.log(`\n=== ${label}`);
    await withApp('damaged', runId, { openQueue: [jsonPath], saveQueue: [updatedJsonPath] }, async (win, step, app) => {
      await step('main menu -> Add missing files to optical media cold storage', () =>
        clickMainMenuButton(win, 'Add missing files to optical media cold storage'));
      await step('click "Ok" on the wizard\'s notice', () =>
        win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 }));
      await step('click "Update JSON" (opens the file picker)', () =>
        win.getByRole('button', { name: 'Update JSON' }).click({ timeout: 15_000 }));

      let text = '';
      await step('wait for the refusal', async () => {
        const dialog = win.getByRole('dialog').filter({ has: win.getByRole('heading', { name: 'Error', exact: true }) }).last();
        await dialog.waitFor({ timeout: 30_000 });
        text = (await dialog.innerText()).replace(/\s+/g, ' ').trim();
      });
      // Contains, not equals: a dialog's innerText carries its title and its buttons as well as the message ("Error
      // <message> Ok"), so the sentence is what is compared, not the whole dialog.
      check(`${label}: is refused in plain words`,
        text.includes('Could not read this JSON file: it is not valid JSON - it may be damaged or only partly written.'),
        `"${text}"`);
      const savedTo = await app.evaluate(() => globalThis.__dialogs.savedTo.length);
      check(`${label}: no save location was asked for, and nothing was written`, savedTo === 0 && !fs.existsSync(updatedJsonPath));
    });
  }

  // ---- 5. The same file on two discs: refused, naming it, before anything is asked for or written ----
  {
    const label = 'a JSON that records a file on two discs';
    const jsonPath = path.join(scratchRoot, 'file-on-two-discs.json');
    const updatedJsonPath = path.join(scratchRoot, 'file-on-two-discs - updated.json');
    const twice = 'D:\\photos\\a.jpg';
    fs.writeFileSync(jsonPath, JSON.stringify([
      [entryOnDisc(twice), entryOnDisc('D:\\photos\\b.jpg')],
      [entryOnDisc(twice), entryOnDisc('D:\\photos\\c.jpg')],
    ], null, 2));
    console.log(`\n=== ${label}`);
    await withApp('file-twice', runId, { openQueue: [jsonPath], saveQueue: [updatedJsonPath] }, async (win, step, app) => {
      await step('main menu -> Add missing files to optical media cold storage', () =>
        clickMainMenuButton(win, 'Add missing files to optical media cold storage'));
      await step('click "Ok" on the wizard\'s notice', () =>
        win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 }));
      await step('click "Update JSON" (opens the file picker)', () =>
        win.getByRole('button', { name: 'Update JSON' }).click({ timeout: 15_000 }));

      let text = '';
      await step('wait for the refusal', async () => {
        const dialog = win.getByRole('dialog').filter({ has: win.getByRole('heading', { name: 'This JSON is malformed', exact: true }) }).last();
        await dialog.waitFor({ timeout: 30_000 });
        text = (await dialog.innerText()).replace(/\s+/g, ' ').trim();
      });
      check(`${label}: is refused, naming the file it lists twice`, text.includes(twice), `"${text}"`);
      check(`${label}: the refusal says how many there are (the list is what the user works from)`,
        text.includes('ON MORE THAN ONE DISC (1)'), `"${text}"`);
      check(`${label}: says the user has to correct the JSON (the app never edits their file)`,
        /correct the JSON/i.test(text));
      const savedTo = await app.evaluate(() => globalThis.__dialogs.savedTo.length);
      check(`${label}: no save location was asked for, and nothing was written`, savedTo === 0 && !fs.existsSync(updatedJsonPath));

      // The refusal has to be dismissed before anything behind it can be looked at: a modal marks the app's own
      // content aria-hidden while it is open, so a getByRole locator for a button on step 1 matches nothing at all
      // until it is closed (see test-harness/ui/README.md). Nothing else closes this one - it is disableClose.
      await step('click "Ok" on the refusal', () =>
        win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 }));
      check(`${label}: the wizard is still on step 1, so another JSON can be picked`, await win
        .getByRole('button', { name: 'Update JSON' }).isEnabled({ timeout: 10_000 }).catch(() => false));
    });
  }

  // ---- 6. The other side of that check: a list of original names repeating is not a file recorded twice ----
  {
    const label = 'a JSON whose two discs each carry a list of original names';
    const jsonPath = path.join(scratchRoot, 'two-names-lists.json');
    const updatedJsonPath = path.join(scratchRoot, 'two-names-lists - updated.json');
    const metadata = [
      [entryOnDisc(NAMES_LIST_PATH, { originalNamesList: true }), entryOnDisc('D:\\photos\\b.jpg')],
      [entryOnDisc(NAMES_LIST_PATH, { originalNamesList: true }), entryOnDisc('D:\\photos\\c.jpg')],
    ];
    fs.writeFileSync(jsonPath, JSON.stringify(metadata, null, 2));
    console.log(`\n=== ${label}`);
    await withApp('two-names-lists', runId, { openQueue: [jsonPath], saveQueue: [updatedJsonPath] }, async (win, step, app) => {
      await step('main menu -> Add missing files to optical media cold storage', () =>
        clickMainMenuButton(win, 'Add missing files to optical media cold storage'));
      await step('click "Ok" on the wizard\'s notice', () =>
        win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 }));
      await step('click "Update JSON" (opens the file picker)', () =>
        win.getByRole('button', { name: 'Update JSON' }).click({ timeout: 15_000 }));

      let wrote = false;
      await step('wait for the flow to carry on and write the metadata JSON', async () => {
        try { await waitForFile(updatedJsonPath, 30_000); wrote = true; } catch { /* reported as a check below */ }
      });
      check(`${label}: is NOT refused - two discs can legitimately carry one each`, wrote);
      if (wrote) {
        const written = JSON.parse(fs.readFileSync(updatedJsonPath, 'utf8'));
        check(`${label}: both discs and both lists survive into the file it wrote`,
          written.length === 2 && written.every((disc) => disc.some((e) => e.path === NAMES_LIST_PATH && e.originalNamesList === true)),
          `${written.length} disc(s)`);
      }
    });
  }

  // ---- 7. A failed pick must not leave the JSON loaded before it silently in force ----
  {
    const label = 'a usable JSON, then a damaged one';
    const goodJsonPath = path.join(scratchRoot, 'usable.json');
    const secondBadJsonPath = path.join(scratchRoot, 'damaged-second.json');
    const masterDir = path.join(scratchRoot, 'master');
    fs.mkdirSync(masterDir, { recursive: true });
    fs.writeFileSync(goodJsonPath, JSON.stringify([[entryOnDisc('D:\\photos\\a.jpg')]], null, 2));
    fs.writeFileSync(secondBadJsonPath, '[{"path": "D:\\\\a.txt", "stats": {"size": 3');
    console.log(`\n=== ${label}`);
    await withApp('stale-json', runId, { openQueue: [masterDir, goodJsonPath, secondBadJsonPath], saveQueue: [] }, async (win, step, app) => {
      await step('main menu -> Add missing files to optical media cold storage', () =>
        clickMainMenuButton(win, 'Add missing files to optical media cold storage'));
      await step('click "Ok" on the wizard\'s notice', () =>
        win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 }));
      await step('pick the "Add new files" task', () =>
        win.getByRole('button', { name: 'Add new files', exact: true }).click({ timeout: 15_000 }));
      await step('choose the master folder', () =>
        win.getByRole('button', { name: 'Select the location of your files (Master)' }).click({ timeout: 15_000 }));
      await step('choose a JSON the wizard accepts', async () => {
        await win.getByRole('button', { name: 'Select JSON file' }).click({ timeout: 15_000 });
        await win.getByText(goodJsonPath, { exact: true }).waitFor({ timeout: 10_000 });
      });
      await step('choose a damaged JSON instead, and "Ok" on the refusal', async () => {
        await win.getByRole('button', { name: 'Select JSON file' }).click({ timeout: 15_000 });
        const dialog = win.getByRole('dialog').filter({ has: win.getByRole('heading', { name: 'Error', exact: true }) }).last();
        await dialog.waitFor({ timeout: 30_000 });
        await dialog.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 });
      });

      let text = '';
      await step('click "Next" - it must ask for a JSON, not use the one just replaced', async () => {
        await win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 });
        const dialog = win.getByRole('dialog').filter({ has: win.getByRole('heading', { name: 'Missing fields', exact: true }) }).last();
        await dialog.waitFor({ timeout: 15_000 });
        text = (await dialog.innerText()).replace(/\s+/g, ' ').trim();
      });
      check(`${label}: "Next" refuses instead of diffing against the JSON the user replaced`,
        /choose a metadata json file first/i.test(text), `"${text}"`);
    });
  }

  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.log(`\nLeaving scratch files in place for inspection: ${scratchRoot}`);
  } else {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
  console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} - ${checks.length - failed.length}/${checks.length} checks passed `
    + `(a metadata JSON holding no discs is carried on with, one that is damaged or records a file twice is refused, ` +
    `two discs carrying a list of original names each is not mistaken for a file recorded twice, and a JSON that was ` +
    `replaced by an unusable pick is not silently used).`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((e) => {
  const message = (e && e.message) || String(e);
  const fullDetail = (e && e.stack) ? e.stack : message;
  if (/closed|Target .*(closed|crashed)/i.test(message)) {
    console.error(`\nTEST ERRORED: the app window was closed before the test finished (${message}).`);
  } else {
    const logPath = path.join(FIXTURES_ROOT, `optical-backup-ui-update-json-bad-input-error-${Date.now()}.log`);
    try { fs.writeFileSync(logPath, fullDetail); } catch { /* best effort */ }
    console.error(`\nTEST ERRORED: ${message}`);
    console.error(`Full details saved to: ${logPath}`);
  }
  process.exitCode = 1;
});
