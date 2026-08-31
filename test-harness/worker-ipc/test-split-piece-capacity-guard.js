#!/usr/bin/env node
'use strict';

/**
 * Regression test for a real infinite-loop bug in partitionBackupToOpticalMedia (app/workers/worker.ts): the
 * bin-packing pass that assigns each large file's real SPLIT PIECE to a disc had no "this one piece alone is
 * bigger than any disc" guard - unlike the ordinary-file pass just above it, which has always had one. If a
 * single piece (fixed at LARGE_FILE_SPLIT_VOLUME_SIZE_MIB) can never fit under the given mediaCapacityInBytes,
 * nothing ever gets assigned to a disc, nothing ever gets removed from the remaining-pieces list, and the while
 * loop - whose only exit condition is that list reaching length 0 - spins forever.
 *
 * Not reachable through the real app UI (the smallest selectable medium, a 700MB CD, is always bigger than one
 * 500 MiB piece - see that constant's own comment for why it was chosen), but reachable by calling
 * partitionBackupToOpticalMedia directly with too small a capacity - which is exactly what this test does on
 * purpose, with splitLargeFiles: true and a mediaCapacityInBytes deliberately smaller than the one resulting
 * split piece. Before the fix this hung forever; this script's own callWorker call has a real timeout (not the
 * usual 5-minute default - see CALL_TIMEOUT_MS below) so a reintroduced regression fails loudly instead of
 * hanging the test run.
 *
 * NOTE: needs a real Windows desktop/window session (see call-worker.js's top comment) - run from your own
 * interactive terminal.
 *
 * Usage:
 *   node test-harness/worker-ipc/test-split-piece-capacity-guard.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { launchApp, callWorker } = require('./call-worker');
const { assertRealTempDataDirectoryIsSafeToUse } = require('./temp-dir-guard');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');

// Well under LARGE_FILE_SPLIT_VOLUME_SIZE_MIB (500 MiB - app/workers/worker.ts), so 7-Zip's real split produces
// exactly ONE volume of about this size (no actual multi-piece splitting needed) - that one piece is still all
// this test needs to trigger the guard.
const LARGE_FILE_BYTES = 20_000_000; // 20 MB

// Deliberately much smaller than LARGE_FILE_BYTES (and smaller still once * maxOpticalMediumRepletionRatio is
// applied inside partitionBackupToOpticalMedia), so the one resulting split piece can never fit - this is the
// exact condition that used to loop forever.
const TINY_MEDIA_CAPACITY_BYTES = 5_000_000; // 5 MB

// Real timeout, not the usual 5-minute default callWorker gives every other script here - if the guard
// regresses, this is what turns "the test run hangs indefinitely" into "the test fails, promptly, with a clear
// message pointing at exactly what happened."
const CALL_TIMEOUT_MS = 60_000;

async function main() {
  console.log('Checking the app\'s real temp/cache directory is safe to use (this is where the real split piece gets written)...');
  assertRealTempDataDirectoryIsSafeToUse();
  console.log('OK.\n');

  const root = path.join(FIXTURES_ROOT, `split-piece-capacity-guard-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });
  const largeFilePath = path.join(root, 'oversized-for-this-tiny-disc.bin');
  fs.writeFileSync(largeFilePath, crypto.randomBytes(LARGE_FILE_BYTES));
  console.log(`Generated a ${LARGE_FILE_BYTES.toLocaleString()}-byte file at:\n  ${largeFilePath}`);
  console.log(`Requesting a tiny ${TINY_MEDIA_CAPACITY_BYTES.toLocaleString()}-byte medium capacity with splitLargeFiles: true -`);
  console.log('the resulting split piece cannot possibly fit, which is exactly what used to loop forever.\n');

  console.log('Launching the app...');
  const { app, win } = await launchApp();
  let caught = null;
  try {
    console.log(`Calling partition-backup-to-optical-media over real IPC (timeout ${CALL_TIMEOUT_MS / 1000}s)...`);
    const response = await callWorker(win, 'partition-backup-to-optical-media', {
      rootPath: root,
      mediaCapacityInBytes: TINY_MEDIA_CAPACITY_BYTES,
      splitLargeFiles: true,
    }, CALL_TIMEOUT_MS);
    console.log('\nUNEXPECTED: the call resolved successfully instead of rejecting:', JSON.stringify(response.res));
  } catch (e) {
    caught = e;
  } finally {
    await app.close().catch(() => {});
  }

  let pass = false;
  if (!caught) {
    console.log('\nFAIL - expected partition-backup-to-optical-media to reject with FILE_TOO_LARGE_FOR_SINGLE_OPTICAL_DISC, but it resolved.');
  } else if (/Timed out/i.test(caught.message)) {
    console.log(`\nFAIL - the call never returned within ${CALL_TIMEOUT_MS / 1000}s - this is the infinite-loop regression itself: ${caught.message}`);
  } else if (!/FILE_TOO_LARGE_FOR_SINGLE_OPTICAL_DISC/.test(caught.message)) {
    console.log(`\nFAIL - rejected, but not with the expected err_code: ${caught.message}`);
  } else {
    console.log(`\nCorrectly rejected instead of looping forever: ${caught.message}`);
    pass = true;
  }

  fs.rmSync(root, { recursive: true, force: true });

  console.log(`\n${pass ? 'PASS' : 'FAIL'} - the split-piece bin-packing pass ${pass ? 'correctly refuses a piece that cannot fit any disc, instead of looping forever.' : 'did NOT behave as expected, see above.'}`);
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => {
  console.error('\nTEST ERRORED:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
