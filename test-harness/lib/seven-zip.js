'use strict';

/**
 * Real 7-Zip split, driven directly from a plain node script - no Electron app involved. Used to fabricate
 * "already split into real parts" fixtures (see generate-tree-from-json.js) quickly and deterministically,
 * without waiting on a live app run.
 *
 * IMPORTANT: this deliberately runs the REAL 7-Zip binary, the exact same one and exact same volume-split
 * convention the app itself uses (`-v<N>m -mx0 a "<file>.part" "<file>"` - see LARGE_FILE_SPLIT_VOLUME_SIZE_MIB /
 * partitionBackupToOpticalMedia in app/workers/worker.ts), rather than hand-rolling a byte-chunk split. The
 * app's own merge step (mergePartialFiles in worker.ts) runs `7z t` then `7z x` on the first part to reassemble
 * the rest - that only works on a genuine 7-Zip multi-volume archive. Fixture ".part.NNN" files that were just
 * naively sliced raw bytes would fail that real merge, so anything meant to be recoverable by the real app has
 * to be built by really running 7-Zip, exactly like worker-ipc/test-merge.js already does outside the live app.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** Reads the real `_7zipExecutablePath` this app itself is configured to use (appData/config.json - same
 *  CONFIG_PATH worker.ts resolves to), and confirms it actually exists on disk. Throws a clear, actionable error
 *  otherwise - mirrors the same check worker-ipc/test-merge.js already does. */
function resolveSevenZipExecutablePath() {
  const configPath = path.resolve(__dirname, '../../appData/config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Cannot find appData/config.json at "${configPath}" - is this being run from inside the project?`);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const sevenZipPath = config._7zipExecutablePath;
  if (!sevenZipPath || !fs.existsSync(sevenZipPath)) {
    throw new Error(
      `_7zipExecutablePath in appData/config.json ("${sevenZipPath}") does not exist - 7-Zip must be installed ` +
      `and configured for this, same requirement the app itself has for splitting/merging large files.`
    );
  }
  return sevenZipPath;
}

/** Splits `sourceFilePath` (a real, already-written file) into real 7-Zip volumes named
 *  "<partsBaseName>.part.NNN", written into `destDir`, using the app's own exact split convention (store mode,
 *  no compression - `-mx0` - so this is fast even for large sizes). Returns the sorted list of created part file
 *  paths.
 * @param volumeSizeMiB volume size in MiB, matching the app's own -v<N>m flag (LARGE_FILE_SPLIT_VOLUME_SIZE_MIB
 *   is 500 in the real app; pass a smaller value here for fast, deterministic multi-part fixtures without
 *   needing a multi-hundred-MB source file). */
function splitFileIntoRealParts(sevenZipPath, sourceFilePath, destDir, partsBaseName, volumeSizeMiB) {
  fs.mkdirSync(destDir, { recursive: true });
  const partsPrefix = path.join(destDir, `${partsBaseName}.part`);
  execFileSync(sevenZipPath, [`-v${volumeSizeMiB}m`, '-mx0', 'a', partsPrefix, sourceFilePath]);

  const partFileNames = fs.readdirSync(destDir)
    .filter((f) => f.startsWith(`${partsBaseName}.part.`))
    .sort();
  if (partFileNames.length === 0) {
    throw new Error(`7-Zip produced no "${partsBaseName}.part.NNN" files in "${destDir}" - the split silently failed.`);
  }
  return partFileNames.map((f) => path.join(destDir, f));
}

module.exports = { resolveSevenZipExecutablePath, splitFileIntoRealParts };
