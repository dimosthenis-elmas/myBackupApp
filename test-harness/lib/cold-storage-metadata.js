'use strict';

/**
 * Shared helper for building a cold storage metadata JSON fixture from a real disc folder's real listing - first
 * built for ui/test-recover-from-json-metadata.js, factored out here once ui/test-add-missing-files.js needed
 * the exact same technique, so the two copies can't silently drift apart.
 */

const path = require('path');

// Fixed placeholder prefix the real app substitutes for whatever drive letter a disc actually mounts as, before
// hashing its paths for a disc ID or saving them into cold storage metadata - see disc-id-hash.ts. Not a real
// drive letter requirement; just the one fixed string every real JSON metadata file uses too.
const OPTICAL_DRIVE_LETTER_CONVENTION = 'D:\\';

/** Converts a real `get-file-paths-with-stats` listing (real absolute paths under `discDir`) into the shape a
 *  cold storage metadata JSON entry needs: `discDir` replaced with `driveConvention`, and stats reduced to just
 *  { size, mtime (ISO string), isDirectory }.
 *
 * IMPORTANT: this must be a literal PREFIX STRING REPLACEMENT (discDir -> driveConvention) - exactly mirroring
 * the real app's own real-disc-read normalization (`x.replace(/^(\w+:\\)/, OPTICAL_DRIVE_LETTER_CONVENTION)` in
 * recoverAllFilesFromAllDiscs) - NOT path.relative(), which silently NORMALIZES AWAY the trailing separator that
 * marks an empty directory (see getAllFiles/getAllFilePathsWithStats in worker.ts: an empty directory's own path
 * entry always ends in a trailing "\"). Losing that one character changes the whole disc's hash for any disc
 * containing an empty directory - found for real (2026-08-27) by directly re-implementing both sides' hash
 * computation and diffing the exact path lists byte for byte, while building
 * ui/test-recover-from-json-metadata.js. A path.relative()-based version of this function is what produced that
 * bug; see that script's own git history / test-harness/ui/README.md for the full diagnosis. */
function normalizeForMetadata(listing, discDir, driveConvention = OPTICAL_DRIVE_LETTER_CONVENTION) {
  const discDirWithSep = discDir.endsWith(path.sep) ? discDir : discDir + path.sep;
  return listing.map((entry) => {
    if (!entry.path.startsWith(discDirWithSep)) {
      throw new Error(`Expected "${entry.path}" to start with "${discDirWithSep}"`);
    }
    return {
      path: driveConvention + entry.path.slice(discDirWithSep.length),
      stats: {
        size: entry.stats.size,
        mtime: new Date(entry.stats.mtime).toISOString(),
        isDirectory: entry.stats.isDirectory,
      },
    };
  });
}

module.exports = { OPTICAL_DRIVE_LETTER_CONVENTION, normalizeForMetadata };
