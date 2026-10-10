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
function normalizeForMetadata(listing, discDir, optionsOrDriveConvention = {}) {
  // The 3rd argument was a bare drive-convention string before `partialPiecePaths` existed; still accepted that
  // way so no existing call site has to change.
  const options = typeof optionsOrDriveConvention === 'string'
    ? { driveConvention: optionsOrDriveConvention }
    : optionsOrDriveConvention;
  const driveConvention = options.driveConvention || OPTICAL_DRIVE_LETTER_CONVENTION;
  const discDirWithSep = discDir.endsWith(path.sep) ? discDir : discDir + path.sep;
  const toMetadataPath = (absolutePath) => {
    if (!absolutePath.startsWith(discDirWithSep)) {
      throw new Error(`Expected "${absolutePath}" to start with "${discDirWithSep}"`);
    }
    return driveConvention + absolutePath.slice(discDirWithSep.length);
  };
  // `options.partialPiecePaths`: real absolute paths (the same form `listing` entries have - under `discDir`) of the
  // entries that are a large file's split pieces. Each matching entry is written with `isPartial: true`, LAST, and
  // with nothing else added - byte-for-byte the shape the app itself writes for a piece
  // (createOpticalMediaDiscPartials in worker.ts, carried through metadataEntriesForDisc in shortened-names.ts).
  // That flag is the SOLE authority for "this entry is a split piece" (see ipc.interfaces.ts's ColdStorageMetadata
  // and src/types/interface.d.ts): nothing in the app ever infers it from a name, so a fixture that wants the
  // recovery wizard's "Partial files detected" merge offer MUST flag its pieces exactly this way. A fixture that
  // leaves them unflagged gets what a plain file gets - and a disc read straight off a disc (no JSON at all) never
  // has any metadata entry, so its pieces are always copied back as the plain files they are, never reassembled.
  const partialPiecePaths = new Set((options.partialPiecePaths || []).map(toMetadataPath));
  return listing.map((entry) => {
    const metadataPath = toMetadataPath(entry.path);
    return {
      path: metadataPath,
      stats: {
        size: entry.stats.size,
        mtime: new Date(entry.stats.mtime).toISOString(),
        isDirectory: entry.stats.isDirectory,
      },
      ...(partialPiecePaths.has(metadataPath) ? { isPartial: true } : {}),
    };
  });
}

module.exports = { OPTICAL_DRIVE_LETTER_CONVENTION, normalizeForMetadata };
