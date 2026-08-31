'use strict';

/**
 * Shared containment guard for the test-harness scripts.
 *
 * The whole point of this module: every destructive or generative operation in test-harness/ must go through
 * `resolveSafeRoot` (to make sure we're never about to write into somewhere dangerous) and, for anything that
 * clears existing content, `requireOwnershipMarker`/`writeOwnershipMarker` (to make sure we only ever delete
 * inside a folder *we* created for this purpose, never a folder that happens to already exist for some other
 * reason).
 *
 * This mirrors the ownership-marker pattern already used by the app itself for its temp data directory (see
 * buildOwnershipMarkerContent / verifyOwnershipMarker in app/workers/worker.ts) - same idea, applied here so the
 * test harness can't accidentally wipe out a real folder just because a path variable was empty or wrong.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const MARKER_FILE_NAME = '.optical-backup-test-fixture.json';
const MARKER_TOOL_ID = 'optical-backup-test-harness';

/** Folders we refuse to ever treat as a test-fixture root, even if explicitly requested. */
function blockedRoots() {
  const home = os.homedir();
  const list = [
    home,
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
    path.join(home, 'Downloads'),
    path.join(home, 'Pictures'),
    path.join(home, 'Music'),
    path.join(home, 'Videos'),
    path.join(home, 'OneDrive'),
    'C:\\Windows',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'C:\\ProgramData',
    'C:\\Users',
  ];
  return new Set(list.map((p) => path.resolve(p).toLowerCase()));
}

/**
 * Resolves and validates a candidate fixture root. Throws with a clear message instead of returning anything
 * unsafe - callers should let that throw propagate (fail loudly) rather than catching it and falling back to
 * something else.
 */
function resolveSafeRoot(candidate) {
  if (!candidate || typeof candidate !== 'string' || candidate.trim() === '') {
    throw new Error('Refusing to proceed: no root path was given.');
  }

  const resolved = path.resolve(candidate);
  const parsedRoot = path.parse(resolved).root;

  if (resolved.toLowerCase() === parsedRoot.toLowerCase()) {
    throw new Error(`Refusing to use a drive root as a fixture folder: "${resolved}"`);
  }

  if (blockedRoots().has(resolved.toLowerCase())) {
    throw new Error(`Refusing to use a protected system/user folder as a fixture folder: "${resolved}"`);
  }

  // Heuristic: require the path to be at least two levels below the drive root (e.g. C:\a\b), so a
  // near-top-level path like "C:\SomeFolder" needs an extra nudge of intent, not just a typo away from danger.
  const segmentsBelowRoot = resolved.slice(parsedRoot.length).split(path.sep).filter(Boolean);
  if (segmentsBelowRoot.length < 2) {
    throw new Error(
      `Refusing to use a top-level folder as a fixture root: "${resolved}". ` +
      `Use a path nested at least two levels deep, e.g. "${path.join(resolved, 'fixtures', 'run-1')}".`
    );
  }

  return resolved;
}

/** True if `root` exists and already carries our ownership marker. */
function hasOwnershipMarker(root) {
  const markerPath = path.join(root, MARKER_FILE_NAME);
  if (!fs.existsSync(markerPath)) { return false; }
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    return parsed && parsed.tool === MARKER_TOOL_ID;
  } catch {
    return false;
  }
}

/** Creates `root` (if needed) and writes the ownership marker into it. Safe to call on an already-marked root. */
function writeOwnershipMarker(root) {
  fs.mkdirSync(root, { recursive: true });
  const markerPath = path.join(root, MARKER_FILE_NAME);
  fs.writeFileSync(markerPath, JSON.stringify({
    tool: MARKER_TOOL_ID,
    createdAt: new Date().toISOString(),
  }, null, 2));
}

/**
 * Deletes everything inside `root` EXCEPT the ownership marker itself, then re-verifies the marker is still
 * there. Throws instead of deleting anything if `root` doesn't already carry our marker - this is what stops a
 * wrong/reused path from wiping out a real folder.
 */
function clearMarkedRootContents(root) {
  const safeRoot = resolveSafeRoot(root);

  if (!fs.existsSync(safeRoot)) {
    // Nothing to clear - just make sure it exists and is marked for next time.
    writeOwnershipMarker(safeRoot);
    return;
  }

  if (!hasOwnershipMarker(safeRoot)) {
    throw new Error(
      `Refusing to clear "${safeRoot}": it exists but does not carry this tool's ownership marker ` +
      `(${MARKER_FILE_NAME}). This guards against clearing a folder that was not created by this tool. ` +
      `If you're sure, delete the folder yourself first, then re-run.`
    );
  }

  for (const entry of fs.readdirSync(safeRoot)) {
    if (entry === MARKER_FILE_NAME) { continue; }
    fs.rmSync(path.join(safeRoot, entry), { recursive: true, force: true });
  }

  // Re-assert the marker (harmless no-op if it's already there) so the root is guaranteed usable afterwards.
  writeOwnershipMarker(safeRoot);
}

module.exports = {
  MARKER_FILE_NAME,
  resolveSafeRoot,
  hasOwnershipMarker,
  writeOwnershipMarker,
  clearMarkedRootContents,
};
