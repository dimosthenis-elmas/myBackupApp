'use strict';

/**
 * Shared "write a file full of pseudo-random bytes, in bounded-size chunks, returning its sha256" helper - used
 * by both generate-random-tree.js and generate-tree-from-json.js so a large (hundreds of MB / GB) write is never
 * held whole in memory, and so both scripts print the exact same periodic "still writing" progress instead of
 * going silent long enough to look hung. Factored out here once generate-tree-from-json.js needed the exact same
 * logic generate-random-tree.js already had - see that script's own git history for why the progress printing
 * exists at all (a real large write once looked hung and got killed).
 */

const fs = require('fs');
const crypto = require('crypto');

/** Writes `sizeBytes` of pseudo-random content to `filePath`, returning the sha256 (hex) of what was written. */
function writeRandomFile(filePath, sizeBytes) {
  const CHUNK = 1024 * 1024; // 1 MB
  const PROGRESS_THRESHOLD_BYTES = 50 * 1024 * 1024;
  const PROGRESS_INTERVAL_MS = 2000;
  const showProgress = sizeBytes >= PROGRESS_THRESHOLD_BYTES;
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'w');
  let lastProgressPrintAt = Date.now();
  try {
    let remaining = sizeBytes;
    let written = 0;
    if (showProgress) { console.log(`  writing ${(sizeBytes / 1e6).toFixed(1)} MB to ${filePath} ...`); }
    while (remaining > 0) {
      const n = Math.min(CHUNK, remaining);
      const buf = crypto.randomBytes(n);
      fs.writeSync(fd, buf, 0, n);
      hash.update(buf);
      remaining -= n;
      written += n;
      if (showProgress && (Date.now() - lastProgressPrintAt) >= PROGRESS_INTERVAL_MS) {
        console.log(`    ${(written / 1e6).toFixed(1)} / ${(sizeBytes / 1e6).toFixed(1)} MB written...`);
        lastProgressPrintAt = Date.now();
      }
    }
    if (showProgress) { console.log(`  done writing ${filePath}`); }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

module.exports = { writeRandomFile };
