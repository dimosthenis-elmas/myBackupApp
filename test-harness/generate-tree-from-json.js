#!/usr/bin/env node
'use strict';

/**
 * Generates a directory/file tree from an explicit JSON spec, instead of generate-random-tree.js's randomized
 * one - for when a test needs a SPECIFIC, hand-authored file layout (exact paths/sizes) rather than "some
 * plausible random tree". Produces the exact same manifest.json shape generate-random-tree.js does (relative
 * path -> size + sha256), so verify-manifest.js and every other piece of tooling that already reads that shape
 * work unchanged.
 *
 * ============================================================================================================
 * The two JSON files
 * ============================================================================================================
 * 1. --spec (required): what to create. A flat array of entries, in the SAME shape as one disc's entries in the
 *    app's own real cold storage metadata JSON (see src/app/schemas/filesMetadata.schema.json) - deliberately,
 *    so this is a format already familiar from that JSON rather than a new one to learn. `stats.size` is always
 *    in BYTES, exactly like Node's own fs.Stats.size and the app's own real metadata - never KB/MB/GB:
 *      [
 *        { "path": "docs/report.pdf",            "stats": { "size": 45000,     "isDirectory": false } }, // 45,000 bytes  (~44 KB)
 *        { "path": "docs/empty-folder/",          "stats": { "size": 0,        "isDirectory": true  } }, // directories: size is ignored
 *        { "path": "large-files/movie.mp4",       "stats": { "size": 700000000, "isDirectory": false } } // 700,000,000 bytes (~700 MB)
 *      ]
 *    Every file entry gets real pseudo-random content of exactly the declared size (see lib/random-file-writer).
 *    Directory entries only need to be listed when EMPTY - a non-empty directory is implied by its files' own
 *    paths and gets created automatically, same as a real disc listing only ever explicitly lists empty dirs.
 *
 * 2. --split-plan (optional): which of the --spec's files should be materialized as already-split real 7-Zip
 *    parts instead of one whole file - simulating a disc that already has a large file's real split volumes
 *    burned onto it (see partition()'s splitLargeFiles path in add-missing-files-to-optical-media-cold-storage.
 *    component.ts / backup-to-optical-media.component.ts for when the real app produces exactly this):
 *      [ { "path": "large-files/movie.mp4", "volumeSizeMiB": 500 } ]  // 500 MiB per volume (~524,288,000 bytes) - MiB is spelled out in the field name on purpose
 *    ("volumeSizeMiB" is optional - defaults to DEFAULT_SPLIT_VOLUME_SIZE_MIB below, the app's own real
 *    LARGE_FILE_SPLIT_VOLUME_SIZE_MIB constant in app/workers/worker.ts, also in MiB.)
 *
 *    IMPORTANT: this really runs 7-Zip (see lib/seven-zip.js's own top comment for why a hand-rolled byte-chunk
 *    split would NOT be recoverable by the real app's own merge step). The whole file named in --spec is
 *    generated first (its size/hash locked into the manifest under its ORIGINAL path), then really split via
 *    the app's own configured 7-Zip binary, then the whole file is deleted, leaving only the real
 *    "<name>.part.001", "<name>.part.002", ... volumes behind - exactly what a real burned disc would contain.
 *    The manifest entry is untouched by this: it still records the ORIGINAL whole file's size/hash, since
 *    that's what a real recovery + merge is supposed to reproduce.
 *
 * ============================================================================================================
 * Safety
 * ============================================================================================================
 * - Same containment guard as generate-random-tree.js (lib/safety.js): the root must resolve to a safe,
 *   sufficiently-nested path, and --reset only ever clears a root that already carries this tool's own
 *   ownership marker.
 * - Total declared size (summed straight from --spec, BEFORE anything is written to disk) is capped at
 *   MAX_TOTAL_TREE_SIZE_BYTES (5 GiB) - refuses to generate anything over that, so a typo'd extra zero in a
 *   size can't silently fill your disk.
 * - Fixtures default to a folder INSIDE this project (test-harness/generated-fixtures/), never the OS temp
 *   directory and never the app's own real temp/cache directory (appData/config.json's cacheDataDirectoryPath) -
 *   that directory is reserved for the real app's own live split scratch files, and several other tests require
 *   it to be empty before they run (see worker-ipc/temp-dir-guard.js). Keeping generated fixtures out of it
 *   means they never collide with that requirement, and they stay somewhere you already know to look, easy to
 *   inspect or delete (git-ignored - see .gitignore).
 *
 * Usage:
 *   node test-harness/generate-tree-from-json.js --spec <path to tree-spec.json> [options]
 *
 * Options:
 *   --spec <path>         Required. The tree spec JSON described above.
 *   --split-plan <path>   Optional. The split-plan JSON described above.
 *   --root <path>         Where to generate the tree. Default: a fresh timestamped folder under
 *                         test-harness/generated-fixtures/ (see Safety above for why not the OS temp dir).
 *   --reset               Clear out an existing --root before generating (only if it carries our marker).
 *
 * Example:
 *   node test-harness/generate-tree-from-json.js --spec my-tree.json --split-plan my-split-plan.json
 */

const fs = require('fs');
const path = require('path');
const { resolveSafeRoot, clearMarkedRootContents, writeOwnershipMarker } = require('./lib/safety');
const { writeRandomFile } = require('./lib/random-file-writer');
const { resolveSevenZipExecutablePath, splitFileIntoRealParts } = require('./lib/seven-zip');
const { FIXTURES_ROOT } = require('./lib/fixtures-root');

// 5 GiB - see "Safety" in the top comment. Deliberately a hard, non-configurable cap (not a CLI flag) - the
// whole point is that no --spec, however malformed, can blow past it.
const MAX_TOTAL_TREE_SIZE_BYTES = 5 * 1024 * 1024 * 1024;

// The app's own real LARGE_FILE_SPLIT_VOLUME_SIZE_MIB (app/workers/worker.ts) - used whenever a --split-plan
// entry doesn't specify its own volumeSizeMiB.
const DEFAULT_SPLIT_VOLUME_SIZE_MIB = 500;

function parseArgs(argv) {
  const args = { reset: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--spec': args.spec = argv[++i]; break;
      case '--split-plan': args.splitPlan = argv[++i]; break;
      case '--root': args.root = argv[++i]; break;
      case '--reset': args.reset = true; break;
      case '--help': case '-h': args.help = true; break;
      default:
        throw new Error(`Unknown argument: ${a} (run with --help)`);
    }
  }
  return args;
}

function printHelp() {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 70).join('\n'));
}

function readJsonFile(filePath, label) {
  if (!filePath) { return null; }
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} file not found: "${filePath}"`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/** Converts a spec entry's "path" (POSIX-style, as written in the JSON) into a safe, OS-native relative path.
 *  Throws on anything that could escape the fixture root (absolute paths, drive letters, ".." segments) or is
 *  otherwise malformed - the same "fail loudly rather than silently do something unsafe" stance as lib/safety.js. */
function sanitizeRelativePath(rawPath, entryIndex) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    throw new Error(`--spec entry ${entryIndex}: "path" must be a non-empty string.`);
  }
  const posixPath = rawPath.replace(/\\/g, '/').replace(/\/+$/, ''); // trailing slash (empty-dir convention) trimmed
  if (posixPath === '') {
    throw new Error(`--spec entry ${entryIndex}: "path" (${JSON.stringify(rawPath)}) resolves to nothing.`);
  }
  const segments = posixPath.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`--spec entry ${entryIndex}: "path" (${JSON.stringify(rawPath)}) must be a plain relative path - no "..", no empty segments.`);
  }
  if (path.win32.isAbsolute(posixPath) || /^[a-zA-Z]:/.test(posixPath)) {
    throw new Error(`--spec entry ${entryIndex}: "path" (${JSON.stringify(rawPath)}) must be relative, not absolute.`);
  }
  return segments.join(path.sep);
}

function validateSpec(spec) {
  if (!Array.isArray(spec)) {
    throw new Error('--spec must be a JSON array (see this script\'s own top comment for the shape).');
  }
  const seen = new Set();
  let totalBytes = 0;
  const normalized = spec.map((entry, i) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`--spec entry ${i} must be an object.`);
    }
    const relPath = sanitizeRelativePath(entry.path, i);
    const key = relPath.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`--spec entry ${i}: duplicate path "${entry.path}" (paths are compared case-insensitively, matching Windows).`);
    }
    seen.add(key);

    const stats = entry.stats || {};
    const isDirectory = stats.isDirectory === true;
    let size = 0;
    if (!isDirectory) {
      size = stats.size;
      if (!Number.isFinite(size) || size < 0 || !Number.isInteger(size)) {
        throw new Error(`--spec entry ${i} ("${entry.path}"): "stats.size" must be a non-negative integer.`);
      }
      totalBytes += size;
    }
    return { relPath, isDirectory, size, originalPath: entry.path };
  });

  if (totalBytes > MAX_TOTAL_TREE_SIZE_BYTES) {
    throw new Error(
      `Refusing to generate: --spec declares ${totalBytes.toLocaleString()} total bytes, which is over the ` +
      `${MAX_TOTAL_TREE_SIZE_BYTES.toLocaleString()}-byte (5 GiB) safety cap. Reduce the sizes in your spec, or ` +
      `split the fixture across multiple smaller runs.`
    );
  }

  return { entries: normalized, totalBytes };
}

function validateSplitPlan(splitPlan, specEntriesByRelPath) {
  if (splitPlan === null) { return []; }
  if (!Array.isArray(splitPlan)) {
    throw new Error('--split-plan must be a JSON array (see this script\'s own top comment for the shape).');
  }
  return splitPlan.map((entry, i) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`--split-plan entry ${i} must be an object.`);
    }
    const relPath = sanitizeRelativePath(entry.path, i);
    const specEntry = specEntriesByRelPath.get(relPath.toLowerCase());
    if (!specEntry) {
      throw new Error(`--split-plan entry ${i} ("${entry.path}") does not match any file in --spec.`);
    }
    if (specEntry.isDirectory) {
      throw new Error(`--split-plan entry ${i} ("${entry.path}") refers to a directory in --spec, not a file.`);
    }
    if (specEntry.size <= 0) {
      throw new Error(`--split-plan entry ${i} ("${entry.path}") has size 0 in --spec - nothing to split.`);
    }
    const volumeSizeMiB = entry.volumeSizeMiB !== undefined ? Number(entry.volumeSizeMiB) : DEFAULT_SPLIT_VOLUME_SIZE_MIB;
    // Must be a whole number - 7-Zip's own "-v<N>m" flag rejects fractional MiB values outright (e.g. "0.01m"
    // fails with "Incorrect volume size", found for real while smoke-testing this script). Use a bigger source
    // file instead of a fractional volume size if you want a fast multi-part split out of a small fixture.
    if (!Number.isInteger(volumeSizeMiB) || volumeSizeMiB <= 0) {
      throw new Error(`--split-plan entry ${i} ("${entry.path}"): "volumeSizeMiB" must be a positive whole number (7-Zip rejects fractional MiB values).`);
    }
    return { relPath, volumeSizeMiB, specEntry };
  });
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }
  if (!args.spec) {
    console.error('Missing required --spec <path>. Run with --help for usage.');
    process.exitCode = 1;
    return;
  }

  const spec = readJsonFile(args.spec, '--spec');
  const { entries, totalBytes } = validateSpec(spec);
  const specEntriesByRelPath = new Map(entries.map((e) => [e.relPath.toLowerCase(), e]));

  const splitPlanRaw = args.splitPlan ? readJsonFile(args.splitPlan, '--split-plan') : null;
  const splitPlan = validateSplitPlan(splitPlanRaw, specEntriesByRelPath);

  const defaultRoot = path.join(FIXTURES_ROOT, `run-${Date.now()}`);
  const root = resolveSafeRoot(args.root || defaultRoot);

  if (args.reset) {
    clearMarkedRootContents(root);
  }
  writeOwnershipMarker(root);

  console.log(`Generating tree from spec under:\n  ${root}`);
  console.log(`(${entries.length} spec entries, ${totalBytes.toLocaleString()} total bytes declared, ${splitPlan.length} file(s) to split for real)`);

  const manifestFiles = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.relPath);
    if (entry.isDirectory) {
      ensureDir(fullPath);
      continue;
    }
    ensureDir(path.dirname(fullPath));
    const sha256 = writeRandomFile(fullPath, entry.size);
    manifestFiles.push({ relativePath: entry.relPath.split(path.sep).join('/'), sizeBytes: entry.size, sha256 });
  }

  const splitFilesForManifest = [];
  if (splitPlan.length > 0) {
    console.log(`\nSplitting ${splitPlan.length} file(s) into real 7-Zip volumes...`);
    const sevenZipPath = resolveSevenZipExecutablePath();
    for (const { relPath, volumeSizeMiB } of splitPlan) {
      const fullPath = path.join(root, relPath);
      const dir = path.dirname(fullPath);
      const baseName = path.basename(fullPath);
      console.log(`  ${relPath} -> ${volumeSizeMiB} MiB volumes...`);
      const partPaths = splitFileIntoRealParts(sevenZipPath, fullPath, dir, baseName, volumeSizeMiB);
      fs.rmSync(fullPath); // only the real parts should remain, matching what a real burned disc would contain.
      console.log(`    -> ${partPaths.length} part(s): ${partPaths.map((p) => path.basename(p)).join(', ')}`);
      splitFilesForManifest.push({ relativePath: relPath.split(path.sep).join('/'), volumeSizeMiB, partCount: partPaths.length });
    }
  }

  manifestFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const manifest = {
    tool: 'optical-backup-test-harness/generate-tree-from-json',
    generatedAt: new Date().toISOString(),
    root,
    specPath: path.resolve(args.spec),
    splitPlanPath: args.splitPlan ? path.resolve(args.splitPlan) : null,
    fileCount: manifestFiles.length,
    totalSizeBytes: totalBytes,
    files: manifestFiles,
    // Informational only - verify-manifest.js only reads "files" above. Records which manifest entries are
    // ACTUALLY sitting on disk as real .part.NNN volumes right now, not one whole file, purely so a human (or a
    // future script) reading this manifest doesn't have to guess.
    splitFiles: splitFilesForManifest,
  };

  const manifestPath = `${root}.manifest.json`;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`\nDone.`);
  console.log(`  Files generated : ${manifest.fileCount}`);
  console.log(`  Total size      : ${totalBytes.toLocaleString()} bytes`);
  console.log(`  Tree root       : ${root}`);
  console.log(`  Manifest        : ${manifestPath}`);
  console.log(`\nPoint the app's "source" folder at the tree root above. After a backup/recover/merge round trip,`);
  console.log(`verify the result with:\n  node test-harness/verify-manifest.js --manifest "${manifestPath}" --dir "<recovered folder>"`);
}

main();
