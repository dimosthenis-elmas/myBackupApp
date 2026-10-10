#!/usr/bin/env node
/*
 * repair-metadata-json.js - a standalone migration tool for cold storage metadata JSONs written before the
 * `isPartial` flag existed.
 *
 * The app now recognizes a large file's split pieces (see app/workers/split-pieces.ts and
 * createOpticalMediaDiscPartials in app/workers/worker.ts) ONLY by an entry's `isPartial: true` flag, never by the
 * entry's name - so a plain file that merely looks like a piece ("report.part.001") is never mistaken for one.
 * JSONs written before this flag existed have no such entry, so their real pieces must be flagged once, here.
 *
 * What it flags (per file, across every disc together - a file's pieces may be spread over several discs):
 *   - every entry whose name ends "...outOf.<total>.part.<number>" (the app's current piece naming) - always;
 *   - every entry whose name ends "...part.<number>" (7-Zip's own naming, discs burned before the total was added)
 *     ONLY when that same base name has at least 2 pieces with consecutive numbers - so a lone "report.part.001"
 *     that is really an ordinary file is left alone.
 * It skips directory entries and a disc's own list of original names (ORIGINAL_NAMES_FILE_NAME).
 *
 * It is idempotent (already-flagged entries are left as they are), backs the original up next to itself as
 * "<file>.bak" (the first backup is kept - a later run never overwrites it), and writes the JSON back with the
 * same 2-space indentation the app itself uses.
 *
 * Usage:
 *   node scripts/repair-metadata-json.js <metadata.json> [more.json ...]
 *   npm run repair-metadata -- <metadata.json> [more.json ...]
 *
 * Exit code is 0 when every file was handled (changed or already up to date) and 1 when any file could not be
 * read, parsed or written, or when no path was given.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Kept in sync with PIECE_ENDING in app/workers/split-pieces.ts (this script is plain CommonJS and runs straight
// from the repository, without the TypeScript build). "outOf" is the part the app's current naming adds; a name
// without it is 7-Zip's own older naming.
const PIECE_ENDING = /(?:\.outOf\.\d+)?\.part\.\d+$/i;
const PIECE_WITH_TOTAL = /\.outOf\.\d+\.part\.\d+$/i;
const PIECE = /^([\s\S]*?)(?:\.outOf\.(\d+))?\.part\.(\d+)$/i;

/** A metadata path with its drive letter (e.g. "D:\") stripped, so it is compared/grouped the same however a disc
 *  happened to mount. */
function withoutDrive(p) {
  return String(p).replace(/^\w+:\\/, '').replace(/^\w+:\//, '');
}

/** The name (last path segment) of a metadata path. */
function baseNameOf(p) {
  const s = String(p).replace(/\//g, '\\');
  const i = s.lastIndexOf('\\');
  return i >= 0 ? s.slice(i + 1) : s;
}

/** The directory (everything up to and including the last backslash) of a metadata path, as written. */
function dirOf(p) {
  const s = String(p).replace(/\//g, '\\');
  const i = s.lastIndexOf('\\');
  return i >= 0 ? s.slice(0, i + 1) : '';
}

/** True for an entry that is a disc's own list of original names (ORIGINAL_NAMES_FILE_NAME), not a file of the
 *  user's - see disc-names.ts. */
function isOriginalNamesList(entry) {
  return entry.originalNamesList === true;
}

/** True for a directory entry - never a piece. */
function isDirectory(entry) {
  return !!(entry && entry.stats && entry.stats.isDirectory === true);
}

/** Flags `metadata` (a ColdStorageMetadata: an array of discs, each an array of entries) in place, and returns how
 *  many entries it changed. */
function flagPieces(metadata) {
  // Every entry, in disc order, with the disc it belongs to - for the summary and for idempotence.
  const entries = [];
  metadata.forEach((disc, discIndex) => {
    if (!Array.isArray(disc)) { return; }
    disc.forEach((entry, entryIndex) => {
      if (!entry || typeof entry.path !== 'string') { return; }
      if (isDirectory(entry) || isOriginalNamesList(entry)) { return; }
      entries.push({ entry, discIndex, entryIndex });
    });
  });

  let changed = 0;
  const newStyle = [];
  const oldStyle = [];
  for (const e of entries) {
    if (e.entry.isPartial === true) { continue; } // already flagged - idempotent
    const name = baseNameOf(e.entry.path);
    if (!PIECE_ENDING.test(name)) { continue; }
    if (PIECE_WITH_TOTAL.test(name)) { newStyle.push(e); } else { oldStyle.push(e); }
  }

  for (const e of newStyle) {
    e.entry.isPartial = true;
    changed++;
  }

  // Old-style pieces (no total in the name) are only trusted in runs: a base name with at least 2 pieces whose
  // numbers are consecutive. A lone "...part.001" could just be an ordinary file.
  const byBase = new Map();
  for (const e of oldStyle) {
    const name = baseNameOf(e.entry.path);
    const m = PIECE.exec(name);
    if (!m || m[1] === '') { continue; }
    const key = (dirOf(withoutDrive(e.entry.path)) + m[1]).toLowerCase();
    const group = byBase.get(key) || { members: [] };
    group.members.push({ e, number: Number(m[3]) });
    byBase.set(key, group);
  }
  for (const group of byBase.values()) {
    const numbers = group.members.map((m) => m.number).sort((a, b) => a - b);
    let consecutive = numbers.length >= 2;
    for (let i = 1; consecutive && i < numbers.length; i++) {
      if (numbers[i] !== numbers[i - 1] + 1) { consecutive = false; }
    }
    if (!consecutive) { continue; }
    for (const m of group.members) {
      m.e.entry.isPartial = true;
      changed++;
    }
  }

  return { changed, newStyle: newStyle.length, oldStyle: oldStyle.length };
}

/** Repairs one metadata JSON file. Returns true on success (changed or already up to date). */
function repairFile(filePath) {
  const absolute = path.resolve(filePath);
  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    console.error(`\n${filePath}: could not be read as JSON - ${error.message}`);
    return false;
  }
  if (!Array.isArray(metadata) || !metadata.every(Array.isArray)) {
    console.error(`\n${filePath}: not a cold storage metadata JSON (expected an array of discs, each an array of entries).`);
    return false;
  }

  const { changed, newStyle, oldStyle } = flagPieces(metadata);
  if (changed === 0) {
    console.log(`\n${filePath}: already up to date - no split piece needed flagging.`);
    return true;
  }

  const backupPath = absolute + '.bak';
  try {
    if (fs.existsSync(backupPath)) {
      console.log(`\n${filePath}: backup kept at ${backupPath} (from an earlier run).`);
    } else {
      fs.copyFileSync(absolute, backupPath);
      console.log(`\n${filePath}: original backed up to ${backupPath}.`);
    }
    fs.writeFileSync(absolute, JSON.stringify(metadata, null, 2), 'utf8');
  } catch (error) {
    console.error(`\n${filePath}: could not be written - ${error.message}`);
    return false;
  }

  console.log(`${filePath}: flagged ${changed} split piece(s) as isPartial ` +
    `(${newStyle} named "...outOf.N.part.N", ${oldStyle} named "...part.N" in a consecutive run).`);
  return true;
}

function main(argv) {
  const files = argv.slice(2).filter((a) => a !== '--');
  if (files.length === 0) {
    console.error('Usage: node scripts/repair-metadata-json.js <metadata.json> [more.json ...]');
    console.error('       npm run repair-metadata -- <metadata.json> [more.json ...]');
    return 1;
  }
  let ok = true;
  for (const file of files) {
    if (!repairFile(file)) { ok = false; }
  }
  return ok ? 0 : 1;
}

process.exit(main(process.argv));
