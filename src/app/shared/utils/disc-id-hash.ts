// Source: https://stackoverflow.com/questions/7616461/generate-a-hash-from-string-in-javascript , https://github.com/bryc/code/blob/master/jshash/experimental/cyrb53.js

/**
 * Fixed, arbitrary drive-letter prefix used to normalize a disc's file paths before hashing them (see
 * getDiscIdHash) or writing them into cold storage metadata (see backup-to-optical-media.component.ts).
 *
 * The optical drive gets whatever letter Windows happens to have free at mount time (D:, E:, F:, ...), which
 * can differ between machines and even between sessions on the same machine. If paths were hashed/stored using
 * the real mounted letter, the exact same physical disc could produce a different id - or a different stored
 * path - depending on what it happened to mount as. Substituting this fixed letter for whatever the disc
 * actually mounted as keeps ids and stored paths stable regardless of the real drive letter.
 *
 * This is purely an internal naming convention for path normalization - it does not mean the optical drive is
 * expected to literally be D:, and nothing here reads the real drive letter to decide this value.
 */
export const OPTICAL_DRIVE_LETTER_CONVENTION = "D:\\";

/**
 * Computes the deterministic disc-identification hash used throughout the optical-media backup/recovery flow.
 * A disc's ID is this hash applied to its sorted, OPTICAL_DRIVE_LETTER_CONVENTION-normalized file paths (see
 * OpticalDiscBackupDataRetriever for how a physically-read disc's ID is computed, and seedFromExternalMetadata
 * for how the same ID is computed from a cold storage metadata JSON instead).
 *
 * This lives in one place, shared by every caller (the recovery flow, and the burn-time disc-labeling dialogs in
 * backup-to-optical-media and add-missing-files-to-optical-media-cold-storage) specifically so there is only one
 * implementation to keep in sync - the whole point of showing this hash to the user for physical disc labeling is
 * that it must exactly match what gets computed later, when that disc is used for a recovery. A second, drifted
 * copy of this algorithm would silently break that guarantee.
 */
export function getDiscIdHash(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for(let i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1  = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2  = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
