'use strict';

const fs = require('fs');
const path = require('path');

/** True if the filesystem holding `dir` treats "name" and "NAME" as the same file (NTFS by default; not ext4, and
 *  not a Windows folder with per-directory case sensitivity turned on). Some scenarios - a file renamed in letter
 *  case only - only mean something on a case-insensitive filesystem; on a case-sensitive one the two spellings
 *  are two different files. Writes and removes one small probe file in `dir`. */
function isCaseInsensitiveFilesystem(dir) {
  const probeName = `case-probe-${process.pid}.tmp`;
  const probePath = path.join(dir, probeName);
  fs.writeFileSync(probePath, '');
  try {
    return fs.existsSync(path.join(dir, probeName.toUpperCase()));
  } finally {
    fs.rmSync(probePath, { force: true });
  }
}

module.exports = { isCaseInsensitiveFilesystem };
