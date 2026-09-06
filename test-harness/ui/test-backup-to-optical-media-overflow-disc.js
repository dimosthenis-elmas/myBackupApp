#!/usr/bin/env node
'use strict';

/**
 * Exercises the capacity-safe handling of a large-file split "sliver" surplus in
 * backup-to-optical-media.component.ts's sendToImgBurn/maybeAppendOverflowDiscs - added because the ORIGINAL
 * lazy-split feature unconditionally attached a surplus piece to whichever disc's send triggered it, with no
 * check that it actually fit. Two scenarios, each its own phase (own fixture, own app launch):
 *
 *  1. "Overflow" - the surplus doesn't fit on ANY already-planned disc, so a brand new disc is appended to hold
 *     it, and the user is told the estimated disc count changed (the "Disc count updated" dialog) BEFORE the
 *     stepper grows - never silently.
 *  2. "Absorption" - the surplus is rejected by the disc that triggers it, but a LATER disc (not yet sent, with
 *     room to spare) picks it up instead, so no new, mostly-empty disc ever gets created. This is what makes
 *     scenario 1 an actual last resort rather than the default outcome.
 *
 * ============================================================================================================
 * Why this uses a STUB 7-Zip instead of a real, byte-precise "boundary" file size
 * ============================================================================================================
 * worker-ipc/test-large-file-split-boundary.js already proves that a REAL 7-Zip split can produce one more
 * piece than estimateLargeFileSplitPieces predicted, and that materializeOpticalMediaDiscPieces correctly
 * surfaces that real, extra piece rather than dropping it - using a file sized to the exact byte where real
 * 7-Zip's own (tiny, unpredictable) per-volume overhead tips it over. That reconciliation mechanism is assumed
 * proven here, not re-tested.
 *
 * What ISN'T proven anywhere yet is what the UI does with a real surplus piece once it exists: does it check
 * capacity before attaching it, correctly reject/defer one that doesn't fit, correctly let a later disc absorb
 * it, and correctly fall back to a new disc when nothing else will take it? Testing THAT deterministically needs
 * the surplus's SIZE to be under this script's control (comfortably bigger than one disc's spare room for
 * "overflow", comfortably in between two discs' spare room for "absorption") - real 7-Zip overhead is only ever
 * a handful of bytes, nowhere near big enough to force either case on a real ~700MB-scale file. So the app's
 * configured 7-Zip path is temporarily redirected (same technique/safety as
 * worker-ipc/test-large-file-split-boundary.js's own "Part 2") to a stub .bat that deliberately produces exactly
 * one more piece than planned, with that extra piece's SIZE chosen by this script per phase, via
 * `fsutil file createnew` (near-instant regardless of size - no real data is ever written or needs to be, since
 * this script is testing the capacity/overflow MECHANISM, not byte-for-byte reassembly, which is already proven
 * by test-large-file-split.js/test-backup-to-optical-media.js).
 *
 * ============================================================================================================
 * Sizing (CD medium, the smallest real choice - same 700,000,000-byte large file worker-ipc/
 * test-large-file-split.js and ui/test-backup-to-optical-media.js already use)
 * ============================================================================================================
 * CD raw capacity 700,000,000 * the app's own 0.95 maxOpticalMediumRepletionRatio = 665,000,000 effective.
 * A 700,000,000-byte file's ESTIMATE (pure arithmetic, see estimateLargeFileSplitPieces) is exactly 2 pieces:
 * piece.001 = 524,288,000 (one full volume), piece.002 = 175,712,000 (the remainder). Both are bigger than half
 * of 665,000,000, so partitionBackupToOpticalMedia's bin-packing can never combine them - each is planned ALONE
 * on its own disc ("Optical disk 1" = piece.001 gets sorted first, being larger; "Optical disk 2" = piece.002),
 * leaving:
 *   - disc 1 (piece.001) with 665,000,000 - 524,288,000 =  140,712,000 bytes of spare room.
 *   - disc 2 (piece.002) with 665,000,000 - 175,712,000 =  489,288,000 bytes of spare room.
 * Whichever disc is sent first is the one whose send triggers the (stubbed) real split, which always produces a
 * real piece.001 and piece.002 matching the estimate exactly, PLUS the surplus piece.003 - so this script's
 * pass-or-fail does not depend on send order (both phases below just send disc 1 then disc 2, the natural
 * order), only on the surplus SIZE relative to the two spare-room figures above:
 *   - ABSORBABLE_SURPLUS_BYTES (200,000,000): bigger than disc 1's spare room (rejected there, whichever disc
 *     triggers it) but smaller than disc 2's (absorbed there) - so no matter which of the two discs happens to
 *     trigger the split, the OTHER one always has enough room left to pick it up. Expected result: still
 *     exactly 2 discs, no "Disc count updated" dialog ever appears.
 *   - UNABSORBABLE_SURPLUS_BYTES (500,000,000): bigger than BOTH discs' spare room, but still comfortably under
 *     the medium's own 665,000,000 effective capacity (so a brand new, otherwise-empty disc can hold it alone).
 *     Expected result: 3 discs total, with the "Disc count updated" dialog appearing before the 3rd one does.
 *
 * NOTE: needs a real Windows desktop/window session (see worker-ipc/call-worker.js's top comment) - run from
 * your own interactive terminal.
 *
 * Usage:
 *   node test-harness/ui/test-backup-to-optical-media-overflow-disc.js
 */

const fs = require('fs');
const path = require('path');
const { launchApp } = require('../worker-ipc/call-worker');
const { assertRealTempDataDirectoryIsSafeToUse, resolveRealTempDataDirectory, waitForSessionSubdirectory } = require('../worker-ipc/temp-dir-guard');
const { printTree } = require('../lib/print-tree');
const { writeStubImgBurnBat, backupAndRedirectConfigField, restoreConfig, waitForFile, parseIbbBackupList } = require('../lib/ibb-tools');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');

const VOLUME_SIZE_BYTES = 500 * 1024 * 1024; // 524,288,000 - see LARGE_FILE_SPLIT_VOLUME_SIZE_MIB in worker.ts
const LARGE_FILE_BYTES = 700_000_000; // same proven-safe constant as test-large-file-split.js
const EXPECTED_PIECE_1_BYTES = VOLUME_SIZE_BYTES; // 524,288,000
const EXPECTED_PIECE_2_BYTES = LARGE_FILE_BYTES - VOLUME_SIZE_BYTES; // 175,712,000

const CD_CAPACITY_BYTES = 700_000_000;
const OPTICAL_MEDIUM_REPLETION_RATIO = 0.95;
const EFFECTIVE_CAPACITY_BYTES = CD_CAPACITY_BYTES * OPTICAL_MEDIUM_REPLETION_RATIO; // 665,000,000
const DISC_1_SPARE_BYTES = EFFECTIVE_CAPACITY_BYTES - EXPECTED_PIECE_1_BYTES; // 140,712,000
const DISC_2_SPARE_BYTES = EFFECTIVE_CAPACITY_BYTES - EXPECTED_PIECE_2_BYTES; // 489,288,000

const ABSORBABLE_SURPLUS_BYTES = 200_000_000; // > DISC_1_SPARE_BYTES, <= DISC_2_SPARE_BYTES
const UNABSORBABLE_SURPLUS_BYTES = 500_000_000; // > DISC_2_SPARE_BYTES (the bigger of the two), <= EFFECTIVE_CAPACITY_BYTES

if (!(ABSORBABLE_SURPLUS_BYTES > DISC_1_SPARE_BYTES && ABSORBABLE_SURPLUS_BYTES <= DISC_2_SPARE_BYTES)) {
  throw new Error('ABSORBABLE_SURPLUS_BYTES no longer sits strictly between the two discs\' spare room - fix the sizing comment/constants at the top of this script.');
}
if (!(UNABSORBABLE_SURPLUS_BYTES > DISC_2_SPARE_BYTES && UNABSORBABLE_SURPLUS_BYTES <= EFFECTIVE_CAPACITY_BYTES)) {
  throw new Error('UNABSORBABLE_SURPLUS_BYTES no longer exceeds both discs\' spare room (or exceeds the medium\'s own effective capacity) - fix the sizing comment/constants at the top of this script.');
}

/** Writes a file of exactly `sizeBytes` with no real content (sparse on NTFS) - fast regardless of size, and
 *  fine here since neither this file's nor any stub piece's actual bytes are ever read back (see this script's
 *  own header comment for why content doesn't matter for what's under test). */
function writeExactSizeFile(filePath, sizeBytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, 'w');
  fs.ftruncateSync(fd, sizeBytes);
  fs.closeSync(fd);
}

/** Writes a stub "7-Zip" .bat that ignores the real source file entirely and instead creates exactly 3 dummy
 *  piece files of chosen sizes via `fsutil file createnew` (near-instant, no real data written) - piece.001 and
 *  piece.002 matching this script's own real, planned estimate exactly, plus a piece.003 "surplus" of
 *  `surplusBytes` - the one real piece materializeOpticalMediaDiscPieces will report as unplanned. Argv shape
 *  (`%~4` = the destination "...\<name>.part" prefix, quotes stripped) mirrors the real
 *  `7z -v500m -mx0 a "<dest>.part" "<source>"` invocation - see worker.ts's own comment on that exec() call. */
function writeStub7zBat(stubPath, surplusBytes) {
  fs.writeFileSync(stubPath, [
    '@echo off',
    'setlocal',
    'set "DEST=%~4"',
    `fsutil file createnew "%DEST%.001" ${EXPECTED_PIECE_1_BYTES}`,
    `fsutil file createnew "%DEST%.002" ${EXPECTED_PIECE_2_BYTES}`,
    `fsutil file createnew "%DEST%.003" ${surplusBytes}`,
    '',
  ].join('\r\n'));
}

async function clickMainMenuButton(win, labelText) {
  const container = win.locator('.grid-container > div').filter({ has: win.locator('h2', { hasText: labelText }) });
  await container.locator('button').click();
}

/** Runs one full phase: fresh fixture, fresh app launch, click all the way through the wizard, send both
 *  originally-planned discs (in the natural "disc 1, then disc 2" order - see this script's own header comment
 *  for why send order doesn't matter here), then either wait for the overflow dialog + a 3rd disc (`expectOverflow:
 *  true`) or confirm no such dialog/disc ever appears (`expectOverflow: false`). Returns `{ pass, discCount }`. */
async function runPhase({ phaseName, surplusBytes, expectOverflow }) {
  console.log(`\n${'='.repeat(110)}\nPhase: ${phaseName} (surplus = ${surplusBytes.toLocaleString()} bytes, expecting ${expectOverflow ? 'a new overflow disc' : 'absorption, no new disc'})\n${'='.repeat(110)}`);

  console.log('Checking the app\'s real temp/cache directory is safe to use...');
  assertRealTempDataDirectoryIsSafeToUse();
  const realTempDir = resolveRealTempDataDirectory();

  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `backup-to-optical-media-overflow-disc-${phaseName}-${runId}`);
  const sourceRoot = path.join(scratchRoot, 'source');
  const largeFileAbsPath = path.join(sourceRoot, 'large-files', 'oversized-file.bin');
  const metadataJsonPath = path.join(scratchRoot, 'cold-storage-metadata.json');
  const stubImgBurnPath = path.join(scratchRoot, 'stub-imgburn.bat');
  const stub7zPath = path.join(scratchRoot, 'stub-7z.bat');

  console.log(`Writing a ${(LARGE_FILE_BYTES / 1e6).toFixed(0)} MB sparse source file...`);
  writeExactSizeFile(largeFileAbsPath, LARGE_FILE_BYTES);
  printTree(sourceRoot, 'Source tree (before)');

  writeStubImgBurnBat(stubImgBurnPath);
  writeStub7zBat(stub7zPath, surplusBytes);

  const results = {};
  let app, win, originalConfigContent;
  const createdIbbPaths = [];
  let sessionDir;
  try {
    console.log('\nLaunching the app...');
    ({ app, win } = await launchApp());

    await app.evaluate(({ dialog }, paths) => {
      const queue = [...paths];
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [queue.shift()] });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: queue.shift() });
    }, [sourceRoot, metadataJsonPath]);

    const WATCH_PAUSE_MS = 2000; // short - this script is about the mechanism, not a human-watchable demo
    const step = async (label, fn) => {
      process.stdout.write(`  [ ] ${label} ... `);
      try {
        await fn();
      } catch (e) {
        console.log('FAILED');
        const screenshotPath = path.join(FIXTURES_ROOT, `optical-backup-ui-overflow-disc-${phaseName}-failure-${runId}.png`);
        try {
          await win.screenshot({ path: screenshotPath });
          console.log(`  Screenshot of the app at the point of failure saved to: ${screenshotPath}`);
        } catch { /* app/window may already be gone */ }
        throw e;
      }
      console.log('done');
      await new Promise((r) => setTimeout(r, WATCH_PAUSE_MS));
    };

    // --- step 1: source folder, medium, collection name, Next (tries WITHOUT splitting first - expected to hit
    // the "too large" error, same confirmation chain as ui/test-backup-to-optical-media.js) ---

    await step('main menu -> Backup to optical media', () => clickMainMenuButton(win, 'Backup to optical media'));
    await step('click "Path to backup"', () => win.getByRole('button', { name: 'Path to backup' }).click({ timeout: 30_000 }));
    await step('wait for the chosen source path to appear on screen', () => win.getByText(sourceRoot, { exact: true }).waitFor({ timeout: 10_000 }));
    await step('open the "Optical medium type" dropdown', () => win.getByRole('combobox').click({ timeout: 30_000 }));
    await step('select "CD (700 MB)"', () => win.getByRole('option', { name: 'CD (700 MB)' }).click({ timeout: 30_000 }));
    await step('type the cold storage collection name', () => win.getByPlaceholder('e.g. My Backup').fill(`Overflow-disc test (${phaseName})`));
    await step('click "Next" (expected to hit the "too large" error)', () => win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 30_000 }));

    await step('wait for the "Error - Too large files found" dialog', () => win.getByText('Error - Too large files found', { exact: true }).waitFor({ timeout: 30_000 }));
    await step('click "Yes, split the large files"', () => win.getByRole('button', { name: 'Yes, split the large files', exact: true }).click({ timeout: 30_000 }));
    await step('wait for the "Info" temp-directory notice', () => win.getByText('Info', { exact: true }).waitFor({ timeout: 30_000 }));
    await step('click "Ok, got it." (retries with splitting enabled)', () => win.getByRole('button', { name: 'Ok, got it.', exact: true }).click({ timeout: 30_000 }));

    await step('wait for the "Backup to optical medium" confirmation dialog', () => win.getByText('Backup to optical medium', { exact: true }).waitFor({ timeout: 60_000 }));
    const planMessage = await win.getByRole('dialog').innerText();
    results.plannedTwoDiscs = /\bestimated 2 discs\b/.test(planMessage);
    console.log(`  plan message mentions "estimated 2 discs": ${results.plannedTwoDiscs} (full text: "${planMessage.replace(/\s+/g, ' ').trim()}")`);
    await step('click "Next" on the confirmation dialog', () => win.getByRole('dialog').getByRole('button', { name: 'Next', exact: true }).click({ timeout: 30_000 }));

    await step('wait for step 2 to render ("Burn backup to optical media")', () => win.getByText('Burn backup to optical media', { exact: true }).waitFor({ timeout: 30_000 }));
    const initialDiscCount = await win.getByRole('tab').count();
    results.initialDiscCountIsTwo = initialDiscCount === 2;
    console.log(`  -> ${initialDiscCount} disc step(s) rendered (expected 2) - ${results.initialDiscCountIsTwo ? 'OK' : 'WRONG'}`);

    // Redirect both 7-Zip (to this phase's stub, controlling the surplus size) and ImgBurn (to a harmless no-op)
    // only now, right before either is actually needed - see ui/test-backup-to-optical-media.js's own comment
    // on the same "keep the redirected window short" reasoning for ImgBurn.
    console.log('\nRedirecting the real 7-Zip and ImgBurn paths to harmless stubs for the "Send to ImgBurn" clicks below...');
    originalConfigContent = backupAndRedirectConfigField('_7zipExecutablePath', stub7zPath);
    backupAndRedirectConfigField('imgBurnExecutablePath', stubImgBurnPath); // 2nd redirect - true original already captured above

    // --- send disc 1, then disc 2 (the natural order - see header comment for why order doesn't matter here) ---

    for (let i = 0; i < 2; i++) {
      await step(`open the "Optical disk ${i + 1}" step`, () => win.getByRole('tab', { name: `Optical disk ${i + 1}`, exact: false }).click({ timeout: 30_000 }));
      await step(`click "Send to ImgBurn" for disc ${i + 1}`, () => win.getByRole('button', { name: 'Send to ImgBurn' }).click({ timeout: 30_000 }));
      await step(`click "Ok" on the "Disc label" confirmation for disc ${i + 1}`, () => win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 30_000 }));

      if (!sessionDir) {
        // Created by whichever disc's send is first to need it - this is always disc 1 here, but discovered
        // rather than assumed, and cached for the rest of this phase either way.
        process.stdout.write('  [ ] discover this job\'s real session subfolder ... ');
        sessionDir = await waitForSessionSubdirectory(realTempDir, 15_000);
        console.log(`done (${path.basename(sessionDir)})`);
      }

      const ibbPath = path.join(sessionDir, `Disk_${i + 1}.ibb`);
      process.stdout.write(`  [ ] wait for the real .ibb file for disc ${i + 1} to appear ... `);
      await waitForFile(ibbPath, 30_000);
      console.log('done');
      createdIbbPaths.push(ibbPath);
    }

    let finalDiscCount = 2;
    if (expectOverflow) {
      await step('wait for the "Disc count updated" dialog', () => win.getByText('Disc count updated', { exact: true }).waitFor({ timeout: 30_000 }));
      const overflowMessage = await win.getByRole('dialog').innerText();
      results.overflowDialogMentionsExpectedCounts = /\bwas 2\b/.test(overflowMessage) && /\bneed 3 discs in total\b/.test(overflowMessage);
      console.log(`  overflow dialog mentions "was 2" and "need 3 discs in total": ${results.overflowDialogMentionsExpectedCounts} (full text: "${overflowMessage.replace(/\s+/g, ' ').trim()}")`);
      await step('click "Ok" on the "Disc count updated" dialog', () => win.getByRole('dialog').getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 30_000 }));

      await step('wait for the new "Optical disk 3" step to appear', () => win.getByRole('tab', { name: 'Optical disk 3', exact: false }).waitFor({ timeout: 30_000 }));
      const discCountAfterOverflow = await win.getByRole('tab').count();
      results.discCountIsThreeAfterOverflow = discCountAfterOverflow === 3;
      console.log(`  -> ${discCountAfterOverflow} disc step(s) now rendered (expected 3) - ${results.discCountIsThreeAfterOverflow ? 'OK' : 'WRONG'}`);

      await step('open the "Optical disk 3" step', () => win.getByRole('tab', { name: 'Optical disk 3', exact: false }).click({ timeout: 30_000 }));
      await step('click "Send to ImgBurn" for disc 3', () => win.getByRole('button', { name: 'Send to ImgBurn' }).click({ timeout: 30_000 }));
      await step('click "Ok" on the "Disc label" confirmation for disc 3', () => win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 30_000 }));
      const ibbPath3 = path.join(sessionDir, 'Disk_3.ibb');
      process.stdout.write('  [ ] wait for the real .ibb file for disc 3 to appear ... ');
      await waitForFile(ibbPath3, 30_000);
      console.log('done');
      createdIbbPaths.push(ibbPath3);
      finalDiscCount = 3;
    } else {
      // Give any (incorrect) late dialog/extra disc a moment to show up before asserting it never does - a
      // fixed grace period is fine here since maybeAppendOverflowDiscs runs synchronously off the back of the
      // disc-2 send this phase already awaited above, not off some later, unrelated timer.
      await new Promise((r) => setTimeout(r, 1500));
      results.noOverflowDialogAppeared = (await win.getByText('Disc count updated', { exact: true }).count()) === 0;
      console.log(`  no "Disc count updated" dialog appeared: ${results.noOverflowDialogAppeared}`);
      const discCountAfterSends = await win.getByRole('tab').count();
      results.discCountStillTwo = discCountAfterSends === 2;
      console.log(`  -> ${discCountAfterSends} disc step(s) rendered (expected still 2 - no new disc) - ${results.discCountStillTwo ? 'OK' : 'WRONG'}`);
    }

    printTree(sessionDir, 'App temp session dir (after) - real .ibb files and stub-generated split pieces');

    // --- verify the saved cold storage metadata JSON: exact entry count, and each entry's own sizes ---
    console.log('\nVerifying the saved cold storage metadata JSON...');
    const savedMetadata = JSON.parse(fs.readFileSync(metadataJsonPath, 'utf8'));
    results.metadataHasExpectedDiscCount = savedMetadata.length === finalDiscCount;
    console.log(`  metadata JSON has ${savedMetadata.length} disc entries (expected ${finalDiscCount}) - ${results.metadataHasExpectedDiscCount ? 'OK' : 'WRONG'}`);

    const sizesOf = (discEntries) => (discEntries || []).map((e) => e.stats.size).sort((a, b) => a - b);
    const disc1Sizes = sizesOf(savedMetadata[0]);
    const disc2Sizes = sizesOf(savedMetadata[1]);
    results.disc1HasJustItsOwnPiece = JSON.stringify(disc1Sizes) === JSON.stringify([EXPECTED_PIECE_1_BYTES]);
    console.log(`  disc 1 entry sizes: [${disc1Sizes.join(', ')}] (expected [${EXPECTED_PIECE_1_BYTES}]) - ${results.disc1HasJustItsOwnPiece ? 'OK' : 'WRONG'}`);

    if (expectOverflow) {
      results.disc2HasJustItsOwnPiece = JSON.stringify(disc2Sizes) === JSON.stringify([EXPECTED_PIECE_2_BYTES]);
      console.log(`  disc 2 entry sizes: [${disc2Sizes.join(', ')}] (expected [${EXPECTED_PIECE_2_BYTES}], surplus must NOT be here) - ${results.disc2HasJustItsOwnPiece ? 'OK' : 'WRONG'}`);
      const disc3Sizes = sizesOf(savedMetadata[2]);
      results.disc3HasJustTheSurplus = JSON.stringify(disc3Sizes) === JSON.stringify([surplusBytes]);
      console.log(`  disc 3 (overflow) entry sizes: [${disc3Sizes.join(', ')}] (expected [${surplusBytes}]) - ${results.disc3HasJustTheSurplus ? 'OK' : 'WRONG'}`);
    } else {
      const expectedDisc2Sizes = [EXPECTED_PIECE_2_BYTES, surplusBytes].sort((a, b) => a - b);
      results.disc2AbsorbedTheSurplus = JSON.stringify(disc2Sizes) === JSON.stringify(expectedDisc2Sizes);
      console.log(`  disc 2 entry sizes: [${disc2Sizes.join(', ')}] (expected [${expectedDisc2Sizes.join(', ')}] - its own piece PLUS the absorbed surplus) - ${results.disc2AbsorbedTheSurplus ? 'OK' : 'WRONG'}`);
    }

    // --- verify the real .ibb files agree with the metadata JSON on entry counts (independent cross-check) ---
    console.log('\nCross-checking the real .ibb file(s)\' own file-entry counts against the metadata JSON...');
    const ibbFileCounts = createdIbbPaths.map((p) => parseIbbBackupList(p).filter((e) => e.type === 'F').length);
    const expectedFileCounts = expectOverflow ? [1, 1, 1] : [1, 2];
    results.ibbFileCountsMatchExpected = JSON.stringify(ibbFileCounts) === JSON.stringify(expectedFileCounts);
    console.log(`  .ibb file-entry counts per disc: [${ibbFileCounts.join(', ')}] (expected [${expectedFileCounts.join(', ')}]) - ${results.ibbFileCountsMatchExpected ? 'OK' : 'WRONG'}`);
    for (const ibbPath of createdIbbPaths) { if (fs.existsSync(ibbPath)) { fs.rmSync(ibbPath, { force: true }); } }

    // --- confirm every disc was burned (forward order - any-order confirmation is already proven by
    // ui/test-backup-to-optical-media.js; this just needs a clean end state), then verify the temp dir ends up
    // with no leftover split-piece files at all. ---
    console.log('\nConfirming every disc was burned...');
    const finalTabCount = await win.getByRole('tab').count();
    for (let i = 0; i < finalTabCount; i++) {
      await step(`open the "Optical disk ${i + 1}" step (for confirm)`, () => win.getByRole('tab', { name: `Optical disk ${i + 1}`, exact: false }).click({ timeout: 30_000 }));
      await step(`click "Confirm disc burned" for disc ${i + 1}`, () => win.getByRole('button', { name: 'Confirm disc burned' }).click({ timeout: 30_000 }));
      await step(`wait for disc ${i + 1} to show as confirmed`, () => win.getByRole('button', { name: 'Disc confirmed', exact: false }).waitFor({ timeout: 30_000 }));
    }
    await new Promise((r) => setTimeout(r, 1000)); // let the last confirm's real delete finish
    const largeFilesTempDir = path.join(sessionDir, 'large-files');
    const leftoverPieces = fs.existsSync(largeFilesTempDir) ? fs.readdirSync(largeFilesTempDir).filter((f) => /\.part\.\d+$/i.test(f)) : [];
    results.noLeftoverPiecesAfterConfirming = leftoverPieces.length === 0;
    console.log(`  leftover split-piece files after confirming every disc: ${leftoverPieces.length} (expected 0) - ${results.noLeftoverPiecesAfterConfirming ? 'OK' : 'WRONG'}`);
    if (leftoverPieces.length > 0) { console.log(`    STILL PRESENT: ${leftoverPieces.join(', ')}`); }

    // confirmDiscBurned deliberately never removes the now-empty "large-files" directory (or the session
    // directory itself) - see its own comment in worker.ts - a harmless leftover, cleaned up whenever
    // clearTempDataDirectory next runs. But this script runs TWO phases against the same real temp dir, and
    // assertRealTempDataDirectoryIsSafeToUse (called at the start of the NEXT phase, before that phase's own app
    // launch has a chance to create its own, different session folder) can't tell "an empty leftover session
    // folder" apart from "real pending data" sitting directly under the temp dir - so this script removes this
    // phase's whole session folder itself here, between phases, rather than leaving that for the next phase to
    // trip over.
    if (sessionDir && fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }

    const pass = Object.values(results).every(Boolean);
    console.log(`\nPhase "${phaseName}" summary:`);
    for (const [check, ok] of Object.entries(results)) { console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${check}`); }

    if (pass) {
      fs.rmSync(scratchRoot, { recursive: true, force: true });
    } else {
      console.log(`\nLeaving scratch files in place for inspection: ${scratchRoot}`);
    }
    return pass;
  } finally {
    if (app) { await app.close().catch(() => {}); }
    if (originalConfigContent !== undefined) { restoreConfig(originalConfigContent); }
  }
}

async function main() {
  const overflowPass = await runPhase({ phaseName: 'overflow', surplusBytes: UNABSORBABLE_SURPLUS_BYTES, expectOverflow: true });
  const absorptionPass = await runPhase({ phaseName: 'absorption', surplusBytes: ABSORBABLE_SURPLUS_BYTES, expectOverflow: false });

  const pass = overflowPass && absorptionPass;
  console.log(`\n${'='.repeat(110)}`);
  console.log(`Overflow phase   : ${overflowPass ? 'PASS' : 'FAIL'}`);
  console.log(`Absorption phase : ${absorptionPass ? 'PASS' : 'FAIL'}`);
  console.log(`\n${pass ? 'PASS' : 'FAIL'} - the capacity-safe surplus-sliver handling ${pass ? 'correctly rejects a surplus that doesn\'t fit, lets a later disc absorb one that does, and only creates a new disc as a last resort - telling the user before it does.' : 'did not behave as expected, see above.'}`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => {
  const message = (e && e.message) || String(e);
  const fullDetail = (e && e.stack) ? e.stack : message;
  if (/closed|Target .*(closed|crashed)/i.test(message)) {
    console.error(`\nTEST ERRORED: the app window was closed before the test finished (${message}).`);
  } else {
    const logPath = path.join(FIXTURES_ROOT, `optical-backup-ui-overflow-disc-test-error-${Date.now()}.log`);
    try { fs.writeFileSync(logPath, fullDetail); } catch { /* best effort */ }
    console.error(`\nTEST ERRORED: ${message}`);
    console.error(`Full details saved to: ${logPath}`);
  }
  process.exitCode = 1;
});
