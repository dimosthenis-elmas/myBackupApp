#!/usr/bin/env node
'use strict';

/**
 * Cleans up leftover scratch data from interrupted/failed test-harness runs - the exact same two places that had
 * to be checked and cleaned up BY HAND, repeatedly, while building this test suite (2026-08-27): every script
 * here only cleans up after itself on SUCCESS - a run you interrupt (Ctrl+C, closing the app window, or a real
 * failure) deliberately leaves its scratch data in place so it can be inspected, and that data just sits there
 * afterward unless something clears it.
 *
 * What this touches, and why each one is safe:
 *
 * 1. `test-harness/generated-fixtures/` - the shared scratch root every test-harness script uses (see
 *    lib/fixtures-root.js; hardcoded identically in every one of them - `generate-random-tree.js`,
 *    `generate-tree-from-json.js`, `test-*.js`). Wiped ENTIRELY, with no per-subfolder ownership-marker check
 *    (unlike `generate-random-tree.js --reset`, which does check one) - that's deliberate: this whole folder's
 *    name and location is hardcoded across every script here, nothing else has any reason to create a folder at
 *    this exact path, and it lives entirely inside this project (git-ignored), never anywhere a real file of
 *    yours would be.
 * 2. The app's REAL shared temp/cache directory (`appData\tempFilesCanBeDeleted\` - same one `temp-dir-guard.js`
 *    protects before letting a worker-ipc test run). Only its OWNERSHIP MARKER is ever kept - everything else is
 *    removed, matching that directory's own name and documented purpose (the app's own README describes it as
 *    disposable/regenerable). Refuses to touch this directory at all if it doesn't carry the app's own ownership
 *    marker (see `assertRealTempDataDirectoryIsSafeToUse` in `temp-dir-guard.js`) - i.e. exactly the same
 *    guarantee every worker-ipc test already relies on before it's willing to touch this folder itself.
 *
 * What this does NOT touch:
 * - Any mounted optical media (real disc or leftover test `.iso`) - only REPORTED, never auto-dismounted, since
 *   there's no way to tell a real disc you care about from a leftover test one. Dismount it yourself
 *   (`Dismount-DiskImage -ImagePath <path>`) if the report shows one that shouldn't be there.
 * - Nothing outside the two paths above, ever.
 *
 * Usage:
 *   node test-harness/cleanup.js            Actually removes everything found.
 *   node test-harness/cleanup.js --dry-run  Only reports what would be removed - touches nothing.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { resolveRealTempDataDirectory, MARKER_FILENAME: REAL_TEMP_MARKER_FILENAME } = require('./worker-ipc/temp-dir-guard');
const { FIXTURES_ROOT } = require('./lib/fixtures-root');

const dryRun = process.argv.includes('--dry-run');

function humanSize(bytes) {
  if (bytes < 1024) { return `${bytes} B`; }
  if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Recursively sums the size of everything under `dirPath`. Missing/inaccessible entries just count as 0 - this
 *  is only used for a human-readable summary, not a safety decision. */
function dirSizeBytes(dirPath) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    try {
      if (entry.isDirectory()) { total += dirSizeBytes(full); }
      else { total += fs.statSync(full).size; }
    } catch { /* vanished between readdir and stat, or a permissions quirk - skip it */ }
  }
  return total;
}

function cleanFixturesRoot() {
  const fixturesRoot = FIXTURES_ROOT;
  console.log(`\n=== Scratch fixtures folder: ${fixturesRoot} ===`);

  if (!fs.existsSync(fixturesRoot)) {
    console.log('  Nothing there - already clean.');
    return;
  }

  const entries = fs.readdirSync(fixturesRoot);
  if (entries.length === 0) {
    console.log('  Empty - already clean.');
    return;
  }

  const totalBytes = dirSizeBytes(fixturesRoot);
  console.log(`  Found ${entries.length} item(s), ${humanSize(totalBytes)} total:`);
  for (const entry of entries) { console.log(`    - ${entry}`); }

  if (dryRun) {
    console.log('  (--dry-run: not removing)');
    return;
  }

  // Removed ONE top-level entry at a time, not the whole folder in one rmSync call - a single locked file (e.g.
  // a .iso still mounted from an interrupted run - see the mounted-media report below) would otherwise make the
  // ENTIRE removal fail with EPERM and leave every other, perfectly removable leftover untouched too. This way
  // one stuck item is reported clearly and skipped, and everything else still gets cleaned up.
  let removedCount = 0;
  for (const entry of entries) {
    const full = path.join(fixturesRoot, entry);
    try {
      fs.rmSync(full, { recursive: true, force: true });
      removedCount++;
    } catch (error) {
      console.log(`  Could NOT remove "${entry}": ${error.message}`);
      console.log('    (likely a .iso inside it is still mounted - see the mounted-media report below, dismount it, then re-run)');
    }
  }
  console.log(`  Removed ${removedCount} of ${entries.length} item(s).`);
}

function cleanRealAppTempDir() {
  console.log(`\n=== App's real temp/cache directory ===`);

  let tempDir;
  try {
    tempDir = resolveRealTempDataDirectory();
  } catch (error) {
    console.log(`  Could not resolve it (${error.message}) - skipping.`);
    return;
  }

  if (!fs.existsSync(tempDir)) {
    console.log(`  ${tempDir} does not exist yet - already clean.`);
    return;
  }

  const markerPath = path.join(tempDir, REAL_TEMP_MARKER_FILENAME);
  if (!fs.existsSync(markerPath)) {
    console.log(
      `  Refusing to touch ${tempDir}: it does not carry the app's own ownership marker ` +
      `(${REAL_TEMP_MARKER_FILENAME}). This means it either isn't really the app's temp directory, or something ` +
      `unexpected is going on - leaving it alone entirely.`
    );
    return;
  }

  const entries = fs.readdirSync(tempDir).filter((e) => e !== REAL_TEMP_MARKER_FILENAME);
  if (entries.length === 0) {
    console.log(`  ${tempDir} - already clean (just the ownership marker).`);
    return;
  }

  const totalBytes = entries.reduce((sum, e) => sum + dirSizeBytes(path.join(tempDir, e)) + (() => {
    try { const st = fs.statSync(path.join(tempDir, e)); return st.isFile() ? st.size : 0; } catch { return 0; }
  })(), 0);
  console.log(`  ${tempDir}`);
  console.log(`  Found ${entries.length} item(s) besides the ownership marker, ${humanSize(totalBytes)} total:`);
  for (const entry of entries) { console.log(`    - ${entry}`); }

  if (dryRun) {
    console.log('  (--dry-run: not removing)');
    return;
  }

  for (const entry of entries) {
    fs.rmSync(path.join(tempDir, entry), { recursive: true, force: true });
  }
  console.log('  Removed (ownership marker kept).');
}

function reportMountedOpticalMedia() {
  console.log('\n=== Currently mounted optical media (checked, never auto-dismounted) ===');
  let out;
  try {
    out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DriveType=5" | Where-Object { $_.Size -gt 0 } | ' +
      'Select-Object DeviceID, VolumeName, Size | ConvertTo-Json -Compress',
    ], { encoding: 'utf8' }).trim();
  } catch (error) {
    console.log(`  Could not check (${error.message}).`);
    return;
  }

  if (!out) {
    console.log('  None.');
    return;
  }

  console.log(`  ${out}`);
  console.log('  If this is a leftover test .iso (not a real disc you care about), dismount it yourself:');
  console.log('    Dismount-DiskImage -ImagePath "<path to the .iso>"');
}

function main() {
  console.log(dryRun ? 'DRY RUN - reporting only, nothing will be removed.' : 'Cleaning up test-harness leftovers...');
  // Mounted media is checked FIRST and purely reported (never touched) - if a leftover .iso from an interrupted
  // run is still mounted, this is what explains upfront why removing the scratch folder that contains it might
  // fail below (a mounted .iso is locked by Windows), instead of that failure being a surprise.
  reportMountedOpticalMedia();
  cleanFixturesRoot();
  cleanRealAppTempDir();
  console.log(`\n${dryRun ? 'Dry run complete.' : 'Done.'}`);
}

main();
