'use strict';

/**
 * Resolves the app's REAL, shared temp/cache directory (appData/config.json's cacheDataDirectoryPath - the same
 * one your real app instance uses) and refuses to let a test proceed if it currently holds anything other than
 * the app's own ownership marker - see CACHE_DIRECTORY_OWNERSHIP_MARKER_FILENAME in app/workers/worker.ts.
 *
 * Why this exists: partition-backup-to-optical-media (with splitLargeFiles) and merge-file-parts both read/write
 * this directory - there is no test-only override for it (CONFIG_PATH in worker.ts is hardcoded). Anything real
 * left in there (e.g. large-file splits for discs you have not burned yet) could be overwritten by a test run.
 * This directory's own name is "tempFilesCanBeDeleted" - by the app's own design, everything in it is meant to
 * be disposable/regenerable from your original source files, so the actual risk is narrow: it only matters if
 * you have a real backup in progress with pending, not-yet-burned splits sitting there right now. This guard
 * makes that check automatic on every run instead of relying on remembering to look first.
 */

const fs = require('fs');
const path = require('path');

const MARKER_FILENAME = '.this-directory-was-created-by-my-backup-app-do-not-delete';

function resolveRealTempDataDirectory() {
  const appDataDir = path.resolve(__dirname, '../../appData');
  const configPath = path.join(appDataDir, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const cacheDirRel = config.cacheDataDirectoryPath;
  if (!cacheDirRel) {
    throw new Error(`appData/config.json has no cacheDataDirectoryPath set.`);
  }
  return path.isAbsolute(cacheDirRel) ? cacheDirRel : path.resolve(appDataDir, cacheDirRel);
}

/**
 * Throws with a clear, actionable message if the real temp directory has anything in it besides the app's own
 * ownership marker (or is missing entirely, which is also fine - the app creates it on demand). Returns the
 * resolved path on success.
 */
function assertRealTempDataDirectoryIsSafeToUse() {
  const dir = resolveRealTempDataDirectory();

  if (!fs.existsSync(dir)) {
    return dir; // Nothing there at all - safe. The app will create it.
  }

  const entries = fs.readdirSync(dir).filter((e) => e !== MARKER_FILENAME);
  if (entries.length > 0) {
    throw new Error(
      `Refusing to run: the app's real temp/cache directory ("${dir}") is not empty ` +
      `(besides its own ownership marker). Found: ${entries.join(', ')}. ` +
      `This usually means a real backup has pending, not-yet-burned split files sitting there. ` +
      `Finish or clear that first (from within the app, so its own safety checks apply), then re-run.`
    );
  }

  return dir;
}

module.exports = { resolveRealTempDataDirectory, assertRealTempDataDirectoryIsSafeToUse, MARKER_FILENAME };
