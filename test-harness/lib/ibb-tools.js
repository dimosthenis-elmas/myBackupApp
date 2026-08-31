'use strict';

/**
 * Shared helpers for any test that needs to click a real "Send to ImgBurn" button - first used by
 * ui/test-backup-to-optical-media.js, factored out here once ui/test-add-missing-files.js needed the exact same
 * technique, so the two copies can't silently drift apart.
 *
 * ============================================================================================================
 * Why "Send to ImgBurn" needs special handling at all
 * ============================================================================================================
 * createIBB_file (app/workers/worker.ts) does two things every time it's called, unconditionally, no matter how
 * it's invoked: writes a real .ibb project file (safe - just a text file), AND spawns whatever ImgBurn.exe is
 * configured in appData/config.json on it (`exec("<imgBurnExecutablePath>" /MODE BUILD /SRC <path>)`) - both
 * coupled inside one function, with no "just write the file" mode to call instead. backupAndRedirectImgBurnPath/
 * restoreConfig let a test click that button for real (proving the whole real code path runs without error)
 * while it actually launches nothing but an instant no-op stub - never your real ImgBurn. createIBB_file rereads
 * config.json fresh from disk on every call (not cached), so writing the redirect to disk right before the
 * clicks - and always restoring the original byte-for-byte in a finally block, however the test ends - is enough.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.resolve(__dirname, '../../appData/config.json');

/** Creates a harmless no-op .bat stub at `stubPath` - `@echo off`, exits instantly, does nothing. Point
 *  imgBurnExecutablePath at this via backupAndRedirectImgBurnPath before any "Send to ImgBurn" click. */
function writeStubImgBurnBat(stubPath) {
  fs.writeFileSync(stubPath, '@echo off\r\n');
}

/** Backs up appData/config.json's exact raw text (so it can be restored byte-for-byte, whitespace and all - not
 *  a JSON.stringify round trip, which could subtly reformat it), then writes a version with imgBurnExecutablePath
 *  pointed at `stubExecutablePath` instead. Returns the original raw text - pass it to restoreConfig when done. */
function backupAndRedirectImgBurnPath(stubExecutablePath) {
  const originalContent = fs.readFileSync(CONFIG_PATH, 'utf8');
  const config = JSON.parse(originalContent);
  config.imgBurnExecutablePath = stubExecutablePath;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4));
  console.log(`  (real appData/config.json temporarily redirected: imgBurnExecutablePath -> ${stubExecutablePath})`);
  return originalContent;
}

function restoreConfig(originalContent) {
  fs.writeFileSync(CONFIG_PATH, originalContent);
  console.log('  (real appData/config.json restored to its original content)');
}

/** Polls for `filePath` to exist, rather than trying to key off any UI dialog's own show/hide timing - the real
 *  work behind "Send to ImgBurn" (write a small .ibb file, spawn a .bat that exits instantly) can finish fast
 *  enough to race a "wait for the loading dialog to appear, then disappear" approach into a false timeout. */
async function waitForFile(filePath, timeoutMs) {
  const startedAt = Date.now();
  while (!fs.existsSync(filePath)) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for "${filePath}" to appear.`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  // Small grace period so the write is fully flushed before this script reads it back.
  await new Promise((r) => setTimeout(r, 300));
}

/** Parses a real .ibb file's [START_BACKUP_LIST]...[END_BACKUP_LIST] section, returning its F|/D| lines split
 *  into { type, name, parentPath, fullSourcePath }. Real .ibb files are UTF-16LE (see saveIBB_toDisk) - reading
 *  with any other encoding would garble non-ASCII filenames. */
function parseIbbBackupList(ibbFilePath) {
  const text = fs.readFileSync(ibbFilePath, 'utf16le');
  const start = text.indexOf('[START_BACKUP_LIST]');
  const end = text.indexOf('[END_BACKUP_LIST]');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Could not find [START_BACKUP_LIST]/[END_BACKUP_LIST] markers in ${ibbFilePath}`);
  }
  const section = text.slice(start + '[START_BACKUP_LIST]'.length, end);
  return section.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('F|') || line.startsWith('D|'))
    .map((line) => {
      const [type, name, parentPath, fullSourcePath] = line.split('|');
      return { type, name, parentPath, fullSourcePath };
    });
}

/** Parses a real .ibb file's `VolumeLabel_UDF=<label>` line (the exact text burned onto the disc's UDF volume
 *  label - see createIBB_file/saveIBB_toDisk), returning just `<label>`. */
function parseIbbVolumeLabel(ibbFilePath) {
  const text = fs.readFileSync(ibbFilePath, 'utf16le');
  const match = text.match(/^VolumeLabel_UDF=(.*)$/m);
  if (!match) {
    throw new Error(`Could not find a VolumeLabel_UDF= line in ${ibbFilePath}`);
  }
  return match[1].trim();
}

module.exports = {
  writeStubImgBurnBat,
  backupAndRedirectImgBurnPath,
  restoreConfig,
  waitForFile,
  parseIbbBackupList,
  parseIbbVolumeLabel,
};
