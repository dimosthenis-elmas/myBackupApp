#!/usr/bin/env node
'use strict';

/**
 * Verifies a directory (e.g. the output of a recover-data-from-optical-media run, or a merged-files folder)
 * against a manifest.json produced by generate-random-tree.js, by recomputing sha256 for every file found and
 * diffing against the recorded hashes. This is read-only - it never writes or deletes anything - so it's safe
 * to point at any real folder, not just fixture roots.
 *
 * Usage:
 *   node test-harness/verify-manifest.js --manifest <path to *.manifest.json> --dir <folder to check>
 *
 * Exit code 0 = every manifest file was found with a matching hash and nothing extra/missing/mismatched.
 * Exit code 1 = at least one MISSING, EXTRA, or MISMATCH.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MARKER_FILE_NAME } = require('./lib/safety');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--manifest') { args.manifest = argv[++i]; }
    else if (a === '--dir') { args.dir = argv[++i]; }
    else if (a === '--help' || a === '-h') { args.help = true; }
    else { throw new Error(`Unknown argument: ${a} (run with --help)`); }
  }
  return args;
}

function sha256OfFile(filePath) {
  const hash = crypto.createHash('sha256');
  const CHUNK = 1024 * 1024;
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(CHUNK);
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buf, 0, CHUNK, null);
      if (bytesRead > 0) { hash.update(buf.subarray(0, bytesRead)); }
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** Recursively lists files under `dir`, returning relative POSIX-style paths (so they compare cleanly against
 *  manifest entries regardless of platform path separators). Skips nothing else - including dotfiles - since a
 *  real recovery result should be checked as-is; the one exception is this harness's own ownership-marker file
 *  (see lib/safety.js), which is bookkeeping metadata generate-random-tree.js leaves in the source root, not
 *  test data, so it would never legitimately appear in a recovered/merged result either. */
function listFilesRecursive(dir, baseDir = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === MARKER_FILE_NAME) { continue; }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full, baseDir));
    } else if (entry.isFile()) {
      out.push(path.relative(baseDir, full).split(path.sep).join('/'));
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.manifest || !args.dir) {
    console.log('Usage: node test-harness/verify-manifest.js --manifest <manifest.json> --dir <folder to check>');
    process.exitCode = args.help ? 0 : 1;
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(args.manifest, 'utf8'));
  const dir = path.resolve(args.dir);
  if (!fs.existsSync(dir)) {
    console.error(`Directory does not exist: ${dir}`);
    process.exitCode = 1;
    return;
  }

  const expected = new Map(manifest.files.map((f) => [f.relativePath, f]));
  const actualPaths = new Set(listFilesRecursive(dir));

  const missing = [];
  const mismatched = [];
  let ok = 0;

  for (const [relPath, entry] of expected) {
    if (!actualPaths.has(relPath)) {
      missing.push(relPath);
      continue;
    }
    const actualHash = sha256OfFile(path.join(dir, relPath));
    if (actualHash !== entry.sha256) {
      mismatched.push({ relPath, expected: entry.sha256, actual: actualHash });
    } else {
      ok++;
    }
    actualPaths.delete(relPath);
  }

  const extra = [...actualPaths]; // whatever's left in actualPaths wasn't in the manifest at all.

  console.log(`Manifest : ${args.manifest} (${manifest.fileCount} files, generated ${manifest.generatedAt})`);
  console.log(`Checked  : ${dir}`);
  console.log('');
  console.log(`  OK        : ${ok}`);
  console.log(`  MISSING   : ${missing.length}`);
  console.log(`  MISMATCH  : ${mismatched.length}`);
  console.log(`  EXTRA     : ${extra.length}`);

  if (missing.length) {
    console.log('\nMissing (in manifest, not found in dir):');
    for (const p of missing) { console.log(`  - ${p}`); }
  }
  if (mismatched.length) {
    console.log('\nHash mismatch (content differs from what was backed up):');
    for (const m of mismatched) { console.log(`  - ${m.relPath}\n      expected ${m.expected}\n      actual   ${m.actual}`); }
  }
  if (extra.length) {
    console.log('\nExtra (found in dir, not in manifest):');
    for (const p of extra) { console.log(`  - ${p}`); }
  }

  const perfect = missing.length === 0 && mismatched.length === 0 && extra.length === 0;
  console.log(`\n${perfect ? 'PASS - recovered data matches the original tree exactly.' : 'FAIL - see differences above.'}`);
  process.exitCode = perfect ? 0 : 1;
}

main();
