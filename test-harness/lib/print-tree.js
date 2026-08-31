'use strict';

/**
 * Prints an indented directory listing (files with their sizes, empty directories marked as such) - purely for a
 * human to visually see what's actually on disk at a given point (e.g. "source tree before" vs "recovered tree
 * after"), alongside whatever byte-for-byte check (verify-manifest.js, a direct hash comparison, etc.) is the
 * actual pass/fail authority for a given test - this is never a substitute for that, just a way to actually see
 * what got copied where.
 */

const fs = require('fs');
const path = require('path');

function printTree(rootDir, label) {
  console.log(`\n${label}: ${rootDir}`);
  function walk(dir, prefix) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      console.log(`${prefix}(unreadable: ${error.message})`);
      return;
    }
    if (entries.length === 0) {
      console.log(`${prefix}(empty)`);
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        console.log(`${prefix}${entry.name}/`);
        walk(full, prefix + '  ');
      } else {
        let size = '?';
        try { size = fs.statSync(full).size.toLocaleString(); } catch { /* vanished between readdir and stat - show ? */ }
        console.log(`${prefix}${entry.name} (${size} bytes)`);
      }
    }
  }
  walk(rootDir, '  ');
}

module.exports = { printTree };
