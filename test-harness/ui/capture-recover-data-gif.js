#!/usr/bin/env node
'use strict';

/**
 * Builds a short, real animated GIF of the "Recover data from optical media backup" wizard's JSON entry point
 * (the same click-through as capture-readme-screenshots.js's captureRecoverData), for embedding directly in the
 * top-level README.md - plays automatically, no GitHub upload/hosting step needed, unlike a real video (see
 * "why not a real video" below).
 *
 * ============================================================================================================
 * Why not a real video (capture-recover-data-video.js's own approach)?
 * ============================================================================================================
 * Playwright's built-in `recordVideo` on `_electron.launch()` is a confirmed, unresolved upstream bug on this
 * exact Electron/Playwright/Windows combination - found for real (2026-08-30): enabling it makes the app window
 * open completely blank (window.electronAPI never appears, so launchApp()'s own wait times out). This matches
 * publicly reported Playwright issues (electron app loading blank with recordVideo enabled; recordVideo causing
 * Windows-only timeouts; recordVideo producing zero-length .webm files) - not something fixable from this
 * script's side. capture-recover-data-video.js has been removed rather than left around not working.
 *
 * This script sidesteps the whole problem: it never touches recordVideo, only the already-proven-reliable
 * win.screenshot() (same primitive capture-readme-screenshots.js uses successfully). A handful of real
 * screenshots, taken at the key moments of the flow, are stitched into one animated GIF via `pngjs` (decodes each
 * PNG to raw RGBA) + `gif-encoder-2` (encodes those RGBA frames into a GIF) - both pure JS, no native build step,
 * no ffmpeg. Screenshots are downsampled first (a small nearest-neighbor resize, written inline below - no
 * separate image-resizing dependency needed) so the GIF stays a reasonable size to commit to the repo.
 *
 * Goes all the way through a REAL recovery (unlike the equivalent screenshots in capture-readme-screenshots.js,
 * which deliberately stop before mounting anything): builds two real .iso files, mounts disc 1, clicks through
 * the "insert disc(s)" info dialog, waits for disc 1's real copy to finish, swaps to disc 2 (dismount/mount), and
 * - since the fixture includes a real large file whose real split pieces are spread one-per-disc, same technique
 * as ui/test-recover-from-json-metadata.js - clicks through the real "Partial files detected" / "Yes, reassemble"
 * merge offer before the final "Data recovery successful" dialog. Nothing gets sent to any external program
 * (ImgBurn is never involved in recovery).
 *
 * NOTE: needs a real Windows desktop/window session (see worker-ipc/call-worker.js's top comment) - run from
 * your own interactive terminal. Also needs no optical media already mounted (see iso-disc.js) - it mounts two
 * real virtual .iso discs during the recovery phase.
 *
 * Usage:
 *   node test-harness/ui/capture-recover-data-gif.js
 * Output:
 *   docs/media/recover-data-from-optical-media.gif
 */

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const GIFEncoder = require('gif-encoder-2');
const { launchApp, callWorker } = require('../worker-ipc/call-worker');
const { assertNoOpticalMediaAlreadyMounted, buildIso, mountIso, dismountIso } = require('./iso-disc');
const { assertRealTempDataDirectoryIsSafeToUse, resolveRealTempDataDirectory } = require('../worker-ipc/temp-dir-guard');
const { FIXTURES_ROOT } = require('../lib/fixtures-root');
const { generateFixtureTree } = require('../lib/fixture-tree-source');
const { normalizeForMetadata } = require('../lib/cold-storage-metadata');

const OUTPUT_DIR = path.join(__dirname, '..', '..', 'docs', 'media');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'recover-data-from-optical-media.gif');
// Never read - this script never passes --json-tree, so generateFixtureTree always takes the random-mode branch.
const UNUSED_SPEC_DIR = path.join(__dirname, 'tree-specs', 'capture-readme-screenshots');
// Widest edge of the GIF, in pixels - the real window is much bigger (a full-screen Electron window); downsampled
// to this before encoding so the committed file stays a reasonable size. Height follows from the real capture's
// own aspect ratio (computed from the first frame), not hardcoded. Bumped from 900 (found for real, 2026-08-31:
// at 900 the in-dialog text was small enough, combined with the nearest-neighbor resize below, to read as an
// unreadable blur once embedded in the README - see downsampleRGBA's own comment).
const MAX_GIF_WIDTH = 1280;

// Same proven-safe constants as worker-ipc/test-large-file-split.js / ui/test-recover-from-json-metadata.js - a
// 700MB file real-splits into exactly 2 pieces at the app's fixed 500 MiB volume size, distributed one per disc.
const LARGE_FILE_BYTES = 700_000_000;
const MEDIA_CAPACITY_BYTES = 600_000_000;
const EXPECTED_PART_COUNT = 2;

async function clickMainMenuButton(win, labelText) {
  const container = win.locator('.grid-container > div').filter({ has: win.locator('h2', { hasText: labelText }) });
  await container.locator('button').click();
}

function copyPreservingDirs(relativePath, srcRoot, destRoot) {
  const relOs = relativePath.split('/').join(path.sep);
  const destPath = path.join(destRoot, relOs);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(path.join(srcRoot, relOs), destPath);
}

async function pause(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

/** Area-average (box filter) downscale of an RGBA buffer - each destination pixel is the mean of the source
 *  block it covers, rather than a single sampled source pixel. Good enough for a UI screenshot GIF, and avoids
 *  pulling in a whole image-resizing dependency just for this.
 *
 *  This replaces an earlier plain nearest-neighbor resize: found for real (2026-08-31) that nearest-neighbor,
 *  applied to real dialog text at this downscale ratio (the real capture is close to a full-screen Electron
 *  window, roughly 2x wider than MAX_GIF_WIDTH), reads as an unreadable blur once embedded - it either drops or
 *  keeps each source pixel of a thin anti-aliased text stroke roughly at random depending on where the sample
 *  point lands, instead of blending it in. Averaging every source pixel a destination pixel covers keeps thin
 *  strokes visible and produces properly anti-aliased (smaller but still crisp) text instead. */
function downsampleRGBA(src, srcW, srcH, dstW, dstH) {
  const dst = Buffer.alloc(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const srcY0 = Math.floor((y * srcH) / dstH);
    const srcY1 = Math.max(srcY0 + 1, Math.floor(((y + 1) * srcH) / dstH));
    for (let x = 0; x < dstW; x++) {
      const srcX0 = Math.floor((x * srcW) / dstW);
      const srcX1 = Math.max(srcX0 + 1, Math.floor(((x + 1) * srcW) / dstW));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = srcY0; sy < srcY1; sy++) {
        for (let sx = srcX0; sx < srcX1; sx++) {
          const si = (sy * srcW + sx) * 4;
          r += src[si];
          g += src[si + 1];
          b += src[si + 2];
          a += src[si + 3];
          n++;
        }
      }
      const di = (y * dstW + x) * 4;
      dst[di] = Math.round(r / n);
      dst[di + 1] = Math.round(g / n);
      dst[di + 2] = Math.round(b / n);
      dst[di + 3] = Math.round(a / n);
    }
  }
  return dst;
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const runId = Date.now();
  const scratchRoot = path.join(FIXTURES_ROOT, `gif-recover-${runId}`);
  const sourceRoot = path.join(scratchRoot, 'source');
  const disc1Dir = path.join(scratchRoot, 'disc1-files');
  const disc2Dir = path.join(scratchRoot, 'disc2-files');
  const outputRoot = path.join(scratchRoot, 'recovered');
  const metadataJsonPath = path.join(scratchRoot, 'cold-storage-metadata.json');
  const disc1IsoPath = path.join(scratchRoot, 'disc1.iso');
  const disc2IsoPath = path.join(scratchRoot, 'disc2.iso');
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.mkdirSync(disc1Dir, { recursive: true });
  fs.mkdirSync(disc2Dir, { recursive: true });

  console.log('Checking no optical media is already mounted...');
  assertNoOpticalMediaAlreadyMounted();
  console.log('Checking the app\'s real temp/cache directory is safe to use (this is where the real split pieces get written)...');
  assertRealTempDataDirectoryIsSafeToUse();

  generateFixtureTree({
    root: sourceRoot,
    randomArgs: ['--files', '16', '--max-depth', '2', '--min-size', '0', '--max-size', '20000', '--seed', '335577', '--no-edge-cases', '--large-file-bytes', String(LARGE_FILE_BYTES)],
    specDir: UNUSED_SPEC_DIR,
  });
  const manifest = JSON.parse(fs.readFileSync(`${sourceRoot}.manifest.json`, 'utf8'));
  const largeFileEntry = manifest.files.find((f) => f.relativePath.startsWith('large-files/'));
  const normalFiles = manifest.files.filter((f) => f !== largeFileEntry);
  const half = Math.ceil(normalFiles.length / 2);
  for (const f of normalFiles.slice(0, half)) { copyPreservingDirs(f.relativePath, sourceRoot, disc1Dir); }
  for (const f of normalFiles.slice(half)) { copyPreservingDirs(f.relativePath, sourceRoot, disc2Dir); }

  // This script drives partition-backup-to-optical-media directly over raw IPC (not through the app's own UI),
  // so it generates its own session ID up front - see SESSION_FOLDER_NAME_PATTERN's own comment in worker.ts for
  // why every job needs one and what it isolates.
  const sessionId = 'session-' + Date.now();

  // Known up front (worker.ts mirrors the large file's own relative directory under its session's own temp
  // subdirectory) - computed BEFORE calling partition-backup-to-optical-media below, so the finally block can
  // always attempt cleanup even if that call times out. A real 7-Zip split of a 700MB file can take longer than
  // this script's own IPC wait allows (antivirus real-time scanning of the large read/write is a common cause on
  // Windows), so the pieces can finish writing to disk after that wait has already timed out - without this,
  // there would be no way to know where to clean them up from (see test-harness/cleanup.js for the fallback
  // either way).
  const tempPartDir = path.join(resolveRealTempDataDirectory(), sessionId, path.dirname(largeFileEntry.relativePath).split('/').join(path.sep));

  // { pngBuffer, delayMs } - PNG bytes kept compressed until encode time (decode/downsample/encode all happens
  // once, after the app closes) rather than holding decoded raw RGBA for every frame in memory as we go.
  const frames = [];
  const shoot = async (win, delayMs) => {
    frames.push({ pngBuffer: await win.screenshot(), delayMs });
  };

  let app, win, mountedIsoPath;
  try {
    console.log('\nLaunching the app...');
    ({ app, win } = await launchApp()); // deliberately no recordVideo - see this script's own header comment
    // Avoid racing app.component.ts's own startup housekeeping IPC call (check-temp-data-directory-for-leftovers)
    // - see capture-readme-screenshots.js's captureRecoverData for the full explanation: WorkerCommunicator's
    // sendAndAwaitResponse removes ALL 'message-from-worker' listeners when any call resolves, not just its own,
    // so the callWorker() below can lose its listener to the startup call's own cleanup within the first second -
    // long before the real (multi-minute) 7-Zip split ever finishes - and then just sit until its own 15-minute
    // timeout, no matter how fast the split actually completes. This pause gives the startup check time to finish
    // first.
    await pause(3000);

    // Generous budget - a real 7-Zip split of a 700MB file can take longer than you'd expect on some machines
    // (antivirus real-time scanning of the large read/write is a common cause on Windows - found for real,
    // 2026-08-30: the split completed correctly, just after the previous 5-minute budget here had already timed
    // out this same call).
    console.log(`Calling partition-backup-to-optical-media with splitLargeFiles=true (real 7-Zip split of the ${(LARGE_FILE_BYTES / 1e6).toFixed(1)} MB file)...`);
    const partitionResponse = await callWorker(win, 'partition-backup-to-optical-media', {
      rootPath: sourceRoot,
      mediaCapacityInBytes: MEDIA_CAPACITY_BYTES,
      splitLargeFiles: true,
      sessionId,
    }, 15 * 60 * 1000);
    const partEntries = partitionResponse.res.flat()
      .filter((e) => /\.part\.\d+$/i.test(e.path))
      .sort((a, b) => a.path.localeCompare(b.path));
    if (partEntries.length !== EXPECTED_PART_COUNT) {
      throw new Error(`Expected exactly ${EXPECTED_PART_COUNT} real split pieces, got ${partEntries.length}.`);
    }

    // One piece per disc, same as ui/test-recover-from-json-metadata.js - placed BEFORE the get-file-paths-with-
    // stats calls below, so they show up naturally in the JSON metadata like any other file.
    const disc1PartDest = path.join(disc1Dir, 'large-files', path.basename(partEntries[0].path));
    const disc2PartDest = path.join(disc2Dir, 'large-files', path.basename(partEntries[1].path));
    fs.mkdirSync(path.dirname(disc1PartDest), { recursive: true });
    fs.copyFileSync(partEntries[0].path, disc1PartDest);
    fs.mkdirSync(path.dirname(disc2PartDest), { recursive: true });
    fs.copyFileSync(partEntries[1].path, disc2PartDest);

    console.log('Asking the app for each disc\'s real file listing (get-file-paths-with-stats)...');
    const disc1Listing = (await callWorker(win, 'get-file-paths-with-stats', { dirPath: disc1Dir })).res;
    const disc2Listing = (await callWorker(win, 'get-file-paths-with-stats', { dirPath: disc2Dir })).res;
    const coldStorageMetadata = [
      normalizeForMetadata(disc1Listing, disc1Dir),
      normalizeForMetadata(disc2Listing, disc2Dir),
    ];
    fs.writeFileSync(metadataJsonPath, JSON.stringify(coldStorageMetadata, null, 2));

    console.log('Building disc1.iso and disc2.iso...');
    buildIso(disc1Dir, disc1IsoPath, 'GIFDISC1');
    buildIso(disc2Dir, disc2IsoPath, 'GIFDISC2');

    await app.evaluate(({ dialog }, paths) => {
      const queue = [...paths];
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [queue.shift()] });
    }, [outputRoot, metadataJsonPath]);

    console.log('Clicking through the wizard, capturing a frame at each key moment...');
    await pause(500);
    await shoot(win, 1800); // main menu

    await clickMainMenuButton(win, 'Recover data from optical media backup');
    await pause(400);
    await shoot(win, 1400); // wizard step 1, empty

    await win.getByRole('button', { name: 'Select a directory to save the recovered files' }).click({ timeout: 15_000 });
    await win.getByText(outputRoot, { exact: true }).waitFor({ timeout: 10_000 });
    await pause(300);
    await shoot(win, 1800); // output folder chosen

    await win.getByRole('checkbox', { name: 'Provide cold storage files metadata by importing a JSON file' }).click({ timeout: 15_000 });
    await pause(300);
    await shoot(win, 1400); // JSON checkbox checked

    await win.getByRole('button', { name: 'Select JSON file' }).click({ timeout: 15_000 });
    await win.getByText(metadataJsonPath, { exact: true }).waitFor({ timeout: 10_000 });
    await pause(1500); // avoid the validation-IPC race documented in ui/test-recover-from-json-metadata.js
    await shoot(win, 2200); // JSON file selected

    await win.getByRole('button', { name: 'Next', exact: true }).click({ timeout: 15_000 });
    // Straight to file selection - step_2's "insert disc" screen is skipped entirely with a JSON-seeded listing.
    await win.getByRole('checkbox', { name: 'Select all' }).waitFor({ state: 'visible', timeout: 60_000 });
    await pause(500);
    await shoot(win, 2200); // combined files tree rendered

    await win.getByRole('checkbox', { name: 'Select all' }).click({ timeout: 15_000 });
    await pause(500);
    await shoot(win, 1800); // everything selected

    await win.getByRole('button', { name: 'Recover selected data' }).click({ timeout: 15_000 });

    // Mount disc1 now - right before confirming, so it's already inserted by the time recoverAllFilesFromAllDiscs
    // starts waiting for a disc (same "mount before the app starts polling" rule ui/test-recover-multi-disc.js's
    // header explains in full).
    mountIso(disc1IsoPath);
    mountedIsoPath = disc1IsoPath;
    await win.getByText('Data recovery from optical media backup', { exact: true }).waitFor({ timeout: 15_000 });
    await pause(400);
    await shoot(win, 2800); // "you will need to insert disc(s)" info dialog

    await win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 });
    await win.getByRole('button', { name: 'Continue with the next disc' }).waitFor({ timeout: 60_000 });
    await pause(400);
    await shoot(win, 1800); // disc 1's files recovered

    dismountIso(disc1IsoPath);
    mountIso(disc2IsoPath);
    mountedIsoPath = disc2IsoPath;
    await pause(1000); // small deliberate pause before clicking - see ui/test-recover-single-disc.js's own note

    await win.getByRole('button', { name: 'Continue with the next disc' }).click({ timeout: 15_000 });

    // Both discs' pieces of the large file were just selected and copied - the wizard now offers to reassemble
    // them (see ui/test-recover-from-json-metadata.js for the identical flow).
    await win.getByRole('button', { name: 'Yes, reassemble', exact: true }).waitFor({ timeout: 60_000 });
    await pause(400);
    await shoot(win, 3000); // "Partial files detected" merge-offer dialog

    await win.getByRole('button', { name: 'Yes, reassemble', exact: true }).click({ timeout: 60_000 });
    await win.getByText('Reassembly successful', { exact: true }).waitFor({ timeout: 60_000 });
    await pause(400);
    await shoot(win, 2500); // "Reassembly successful"

    await win.getByRole('button', { name: 'Ok', exact: true }).click({ timeout: 15_000 });
    await win.getByText('Data recovery successful', { exact: true }).waitFor({ timeout: 15_000 });
    await pause(500);
    await shoot(win, 4000); // "Data recovery successful" - final, held-longest frame

    console.log(`Captured ${frames.length} frames. Closing the app...`);
  } finally {
    if (app) { await app.close().catch(() => {}); }
    if (mountedIsoPath) {
      console.log('\nDismounting whichever disc is still mounted...');
      dismountIso(mountedIsoPath);
    }
    // The app's own real temp/cache copies of the split pieces - not cleaned up by the app itself, same as
    // ui/test-recover-from-json-metadata.js's own cleanup.
    if (tempPartDir && fs.existsSync(tempPartDir)) {
      fs.rmSync(tempPartDir, { recursive: true, force: true });
    }
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }

  console.log('\nDecoding, downsampling, and encoding the GIF...');
  const decodedFirst = PNG.sync.read(frames[0].pngBuffer);
  const dstW = Math.min(MAX_GIF_WIDTH, decodedFirst.width);
  const dstH = Math.round((decodedFirst.height / decodedFirst.width) * dstW);

  // 'octree' (not 'neuquant'): this is a UI screenshot - a handful of flat colors plus black-on-white text -
  // not a photo. neuquant's statistical/neural clustering is tuned for photographic color gradients and was
  // muddying the text's dark edge pixels into the background; octree's exact color-space subdivision reproduces
  // flat UI colors and text edges much more faithfully.
  const encoder = new GIFEncoder(dstW, dstH, 'octree', true, frames.length);
  encoder.start();
  encoder.setRepeat(0); // loop forever
  for (const { pngBuffer, delayMs } of frames) {
    const decoded = PNG.sync.read(pngBuffer);
    const resized = downsampleRGBA(decoded.data, decoded.width, decoded.height, dstW, dstH);
    encoder.setDelay(delayMs);
    encoder.addFrame(resized);
  }
  encoder.finish();
  fs.writeFileSync(OUTPUT_FILE, encoder.out.getData());

  const sizeMB = (fs.statSync(OUTPUT_FILE).size / (1024 * 1024)).toFixed(2);
  console.log(`\nSaved: ${OUTPUT_FILE} (${sizeMB} MB, ${frames.length} frames, ${dstW}x${dstH}).`);
}

main().catch((e) => {
  console.error(`\nFAILED: ${(e && e.stack) || e}`);
  process.exitCode = 1;
});
