const electron = require('electron');
const fs = require("fs")
const node_path_module = require("path")
import { WorkerCommunicator as ipc } from './worker-communicator'
import { LogsBuffer } from './logsbuffer'
import { filesMetadata } from '../../src/types/interface';
import { ColdStorageMetadata, WorkerResponse, OpticalMediaPartitioning } from './ipc.interfaces';

const contextBridgeAPI =require("./preload/contextBridge_api");

//The default worldId for the IsolatedWorld is 999.
electron.contextBridge.exposeInIsolatedWorld(999, "electronAPI", contextBridgeAPI);

//Treat asar archives as normal file.
process.noAsar = true;


const holdOn = () => {
  return new Promise<void>(resolve =>
    setImmediate(() => {
      resolve();
    })
  );
}

/*print_line(str: string): void {
  process.stdout.clearLine(-1);  // clear current text
  process.stdout.cursorTo(0, 0);  // move cursor to beginning of line
  process.stdout.write(str);  // write text
}*/

/** @return an array that contains the absolute paths of all files in "dirPath" (in a recursive fashion).
 *  It also takes into account empty directories. 
 * @param dirPath the directory for which you want to list the files. 
 * @param arrayOfFiles <empty> (used internally for recursion) */
const getAllFiles = async function (dirPath: string, arrayOfFiles: Array<string> = []): Promise<string[]> {
  let files: Array<string> = fs.readdirSync(dirPath)

  arrayOfFiles = arrayOfFiles || []

  if (files.length > 0) {
    let file: string;
    for (let i = 0; i < files.length; i++) {
      if(process.env._stop == 'stop'){break;}
      file = files[i];
      if (fs.statSync(dirPath + "/" + file).isDirectory()) {
        arrayOfFiles = await getAllFiles(dirPath + "/" + file, arrayOfFiles)
      } else {
        arrayOfFiles.push(node_path_module.join(dirPath, "/", file))
        //print_line(arrayOfFiles.length + "")
      }
      await holdOn();
    }
  } else {
    arrayOfFiles.push(node_path_module.join(dirPath, "/"))
    //print_line(arrayOfFiles.length + "")
  }

  return arrayOfFiles
}


/** Size (in MiB) of each piece 7-Zip splits a too-large-for-one-disc file into (see the `-v${...}m` call in
 *  partitionBackupToOpticalMedia). Chosen manually, once, to comfortably fit on a CD (~700MB - the
 *  lowest-capacity medium in optical_media_choices, backup-to-optical-media.component.ts) regardless of which
 *  medium the user actually selects for a given backup, since a split piece is treated as just another file
 *  when packing discs and could end up on any of them. Deliberately NOT computed from the CD capacity constant
 *  or checked against it at runtime - if you ever change this number (or add a smaller supported medium),
 *  you must manually re-confirm it still leaves comfortable headroom under the smallest medium's capacity. */
const LARGE_FILE_SPLIT_VOLUME_SIZE_MIB = 500;

const CONFIG_PATH = () => node_path_module.join(__dirname, `../../appData/config.json`);

/** The app's appData/ directory, resolved to an absolute path. Relative cacheDataDirectoryPath values are
 *  resolved against this - see resolveTempDataDirectoryPath below. */
const APP_DATA_DIRECTORY_PATH = () => node_path_module.resolve(__dirname, '../../appData');

/** True if `candidatePath` is a real descendant of `containerPath` - not equal to it, and not "escaped" via a
 *  leading ".." after resolution or by landing on a different drive. Both arguments must already be absolute,
 *  resolved paths (e.g. via path.resolve) for this to mean anything - it does no resolving itself.
 *
 *  A plain substring check for ".." in a configured path is NOT enough to guarantee containment: for example
 *  a configured name of just "." contains no ".." at all, yet path.join(containerPath, '.') resolves right
 *  back to containerPath itself - i.e. NOT a descendant, but the check below correctly rejects it (relative
 *  === '' is falsy) where a substring check would have let it through. */
const isPathStrictlyInside = function (candidatePath: string, containerPath: string): boolean {
  const relative = node_path_module.relative(containerPath, candidatePath);
  return !!relative && relative !== '..' && !relative.startsWith('..' + node_path_module.sep) && !node_path_module.isAbsolute(relative);
}

/** Matches this app's own large-file split volumes (e.g. "video.mp4.part.001") - one of the two kinds of file
 *  clearTempDataDirectory is willing to delete (see IBB_PROJECT_FILE_PATTERN for the other). Kept identical to
 *  the pattern used everywhere else in the app that recognizes these (e.g. groupSelectedPartialFiles in
 *  optical-disc-backup-data-retriever.component.ts, and checkForLeftoverPartialFilesInTempDirectory in
 *  app.component.ts). */
const PART_FILE_PATTERN = /\.part\.\d+$/i;

/** Matches this app's own .ibb project files (e.g. "Disk_1.ibb" - see createIBB_file/saveIBB_toDisk), the
 *  other kind of disposable, one-time-use scratch file clearTempDataDirectory is willing to delete. Deliberately
 *  narrow (the exact "Disk_<digits>.ibb" name this app itself writes) rather than matching any ".ibb" file, so
 *  this can never end up recognizing something unrelated that merely happens to share the extension. */
const IBB_PROJECT_FILE_PATTERN = /^Disk_\d+\.ibb$/i;

/** True if `entryPath` is safe for clearTempDataDirectory to delete, given ownership of its containing temp
 *  directory has already been established (ensureTempDataDirectoryIsAppOwned): a symlink/junction (always
 *  safe - deleting it only ever removes the link entry itself, never follows it into whatever it points to);
 *  a file whose name matches PART_FILE_PATTERN or IBB_PROJECT_FILE_PATTERN; or a directory all of whose
 *  contents, recursively, are themselves safe by this same rule.
 *
 *  This exists on top of the ownership guarantee, not instead of it: ownership proves the directory *started*
 *  out empty, but nothing about that guarantee stops something unexpected from having been written into it
 *  since (a bug elsewhere, or a user manually dropping a file into what looks like an empty scratch folder).
 *  This is the check that keeps the actual deletion narrowed to things that look like this app's own output,
 *  regardless of how they got there - anything unrecognized is left alone, even one unrecognized file deep
 *  inside an otherwise-normal-looking subdirectory is enough for that whole subdirectory to be skipped (not
 *  "everything else in it"), since silently deleting most of an unexpected directory's contents while leaving
 *  a random remainder behind is its own kind of surprising, unsafe-feeling behavior. */
const isRecognizedTempContent = function (entryPath: string, isSymlink: boolean): boolean {
  if (isSymlink) {
    return true;
  }
  let stats;
  try {
    stats = fs.statSync(entryPath);
  } catch (error) {
    return false;
  }
  if (stats.isDirectory()) {
    let children: Array<{ name: string, isSymbolicLink: () => boolean }>;
    try {
      children = fs.readdirSync(entryPath, { withFileTypes: true });
    } catch (error) {
      return false;
    }
    return children.every((child) => isRecognizedTempContent(node_path_module.join(entryPath, child.name), child.isSymbolicLink()));
  }
  const baseName = node_path_module.basename(entryPath);
  return PART_FILE_PATTERN.test(baseName) || IBB_PROJECT_FILE_PATTERN.test(baseName);
}

/** Fallback used only for the cache/temp directory name when it is missing from config.json - this is what
 *  getTempDataDirectoryPath used to hardcode inline. Without this fallback, a missing config.json would make
 *  getTempDataDirectoryPath build the path "appData/undefined" (string-concatenating with `undefined`), which
 *  is exactly the kind of failure the config validation below exists to prevent from happening silently. */
const DEFAULT_CACHE_DATA_DIRECTORY_NAME = 'tempFilesCanBeDeleted\\';

/** The single source of truth for where the configured cache/temp directory (config.json's
 *  cacheDataDirectoryPath) actually is on disk, as an absolute path. This directory is allowed to live
 *  anywhere - not just under appData/ (e.g. a user might point it at a different drive with more free space).
 *  If cacheDataDirectoryPath is an absolute path, it is used as-is; if it is relative (the common case,
 *  including the default "tempFilesCanBeDeleted\\"), it is resolved relative to appData/, same as before.
 *
 *  Every function that reads from, writes to, or deletes from this directory (getTempDataDirectoryPath,
 *  partitionBackupToOpticalMedia, the large-file source fallback in insertBranch/createTree, and
 *  clearTempDataDirectory) MUST go through this - they used to each build the path independently via
 *  `path.join(__dirname, '../../appData/' + name)`, which does NOT actually honor an absolute
 *  cacheDataDirectoryPath: path.join has no reason to treat a value fused into the middle of another string as
 *  an override, so e.g. "D:\\MyTempCache" used to resolve to the nonsensical
 *  ".../appData/D:\\MyTempCache" (nested literally under appData/) instead of D:\\MyTempCache - meaning an
 *  absolute config value would have silently pointed every one of those functions at a different, wrong
 *  location (and worse, clearTempDataDirectory would then be "clearing" a directory that isn't actually where
 *  the split files live at all). path.resolve here does not have that problem: resolving a base against an
 *  absolute second argument correctly yields that absolute path, discarding the base. */
const resolveTempDataDirectoryPath = function (config: { [key: string]: any }): string {
  let tempDataDirectoryName: string = config ? config.cacheDataDirectoryPath : undefined;
  if (!tempDataDirectoryName || typeof tempDataDirectoryName !== 'string' || tempDataDirectoryName.trim() === '') {
    tempDataDirectoryName = DEFAULT_CACHE_DATA_DIRECTORY_NAME;
  }
  return node_path_module.resolve(APP_DATA_DIRECTORY_PATH(), tempDataDirectoryName);
}

/** Marker file this app writes into the temp/cache directory immediately after creating it fresh. Its
 *  presence AND content (see buildOwnershipMarkerContent/verifyOwnershipMarker) are what let
 *  clearTempDataDirectory's content deletion (and any code that writes into this directory) trust that
 *  everything inside it originated from this app, never pre-existing user data - see
 *  ensureTempDataDirectoryIsAppOwned below for why that guarantee is otherwise impossible to make (config.json
 *  can point cacheDataDirectoryPath at literally any directory on disk, including one that already has real
 *  content). clearTempDataDirectory MUST preserve this file rather than deleting it along with everything
 *  else, so ownership survives being cleared and across app restarts. */
const CACHE_DIRECTORY_OWNERSHIP_MARKER_FILENAME = '.this-directory-was-created-by-my-backup-app-do-not-delete';

/** Builds the exact marker file content for `tempDataDirectoryPath` - a small JSON payload whose resolvedPath
 *  field is checked against the CURRENT resolution on every ownership check (verifyOwnershipMarker), not just
 *  the marker file's mere presence. This closes the gap a presence-only check would have: a file that merely
 *  happens to share the marker's name (e.g. manually copied over from a different temp directory, or left
 *  behind after this exact folder was renamed/moved outside of the app) would otherwise be trusted as proof
 *  of ownership even though it does not actually correspond to this directory. */
const buildOwnershipMarkerContent = function (tempDataDirectoryPath: string): string {
  return JSON.stringify({
    _comment: 'This directory was created by, and is owned by, the backup app as a temp/cache scratch space ' +
      'for large-file splitting during optical media backups. Its contents may be deleted by the app at any ' +
      'time. Do not remove or modify this marker file, or the app will refuse to use or clear this directory.',
    resolvedPath: tempDataDirectoryPath
  }, null, 2);
}

/** True only if the ownership marker inside `tempDataDirectoryPath` proves THIS app created THIS exact
 *  directory: the marker must exist, must be a regular file (not a symlink/junction - a symlinked "marker"
 *  could be made to point anywhere, which would defeat the point of checking it at all), must parse as the
 *  JSON this app writes, and its resolvedPath field must match tempDataDirectoryPath exactly. Any mismatch,
 *  parse failure, or missing/unreadable file returns false - fails closed. */
const verifyOwnershipMarker = function (tempDataDirectoryPath: string): boolean {
  const markerPath = node_path_module.join(tempDataDirectoryPath, CACHE_DIRECTORY_OWNERSHIP_MARKER_FILENAME);
  try {
    if (fs.lstatSync(markerPath).isSymbolicLink()) {
      return false;
    }
    const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    return !!parsed && parsed.resolvedPath === tempDataDirectoryPath;
  } catch (error) {
    return false;
  }
}

/** Ensures the configured cache/temp directory (resolveTempDataDirectoryPath) both exists AND was created by
 *  this app itself - never a pre-existing directory config.json's cacheDataDirectoryPath merely happens to
 *  point at. This is the precondition every other piece of temp-directory logic in this file relies on
 *  (writing large-file splits, and especially clearTempDataDirectory's content deletion): a directory this
 *  function created is guaranteed to have started out empty, so anything later found inside it can only be
 *  something this app itself put there - there is no other way to safely make that guarantee, since the
 *  directory can be configured to point anywhere, including a folder that already exists and already has
 *  real content (e.g. by an accidental or careless cacheDataDirectoryPath edit).
 *
 *  - Directory does not exist yet: creates it (recursively - it can point anywhere, including a location
 *    whose parent directories don't exist yet) and writes the ownership marker file into it. Succeeds.
 *  - Directory exists and contains the marker file: this app created it (in this run or an earlier one) - the
 *    marker file's presence is the only thing checked, so this remains true across restarts and after
 *    clearTempDataDirectory has emptied it (which preserves the marker). Succeeds without touching anything.
 *  - Directory exists WITHOUT the marker file: some other, pre-existing directory (could be empty, could be
 *    the user's Documents folder) - fails without creating or touching anything, so the caller can refuse to
 *    use it rather than risk writing to or ever clearing something that wasn't created empty by this app.
 *  - The resolved path exists but is not a directory (e.g. a file): fails, for the same reason. */
const ensureTempDataDirectoryIsAppOwned = async function (): Promise<{ ok: boolean, path: string, message: string }> {
  const config = await readConfig();
  const tempDataDirectoryPath = resolveTempDataDirectoryPath(config);

  const parsedPath = node_path_module.parse(tempDataDirectoryPath);
  if (parsedPath.root === tempDataDirectoryPath) {
    return { ok: false, path: tempDataDirectoryPath, message: 'The configured temp/cache directory (cacheDataDirectoryPath in appData\\config.json) resolves to an entire drive (' + tempDataDirectoryPath + '), which cannot be right for a temp/cache folder.' };
  }

  if (!fs.existsSync(tempDataDirectoryPath)) {
    try {
      fs.mkdirSync(tempDataDirectoryPath, { recursive: true });
      fs.writeFileSync(
        node_path_module.join(tempDataDirectoryPath, CACHE_DIRECTORY_OWNERSHIP_MARKER_FILENAME),
        buildOwnershipMarkerContent(tempDataDirectoryPath)
      );
    } catch (error) {
      return { ok: false, path: tempDataDirectoryPath, message: 'Failed to create the configured temp/cache directory at "' + tempDataDirectoryPath + '": ' + (error && (error as any).message ? (error as any).message : String(error)) };
    }
    return { ok: true, path: tempDataDirectoryPath, message: 'Created a fresh temp/cache directory at "' + tempDataDirectoryPath + '".' };
  }

  if (!fs.statSync(tempDataDirectoryPath).isDirectory()) {
    return { ok: false, path: tempDataDirectoryPath, message: 'The configured temp/cache directory path already exists but is a file, not a directory: "' + tempDataDirectoryPath + '".' };
  }

  if (!verifyOwnershipMarker(tempDataDirectoryPath)) {
    return {
      ok: false,
      path: tempDataDirectoryPath,
      message: 'The configured temp/cache directory ("' + tempDataDirectoryPath + '") already exists and was ' +
        'not created by this app, so its contents cannot be trusted to be safe to ever delete. Please change ' +
        'cacheDataDirectoryPath in appData\\config.json to a path that does not exist yet - the app will ' +
        'create it fresh and use it from then on.'
    };
  }

  return { ok: true, path: tempDataDirectoryPath, message: 'The temp/cache directory is already owned by this app.' };
}

/** The config.json fields that must point to an existing executable on disk for the optical-media features
 *  (splitting, reassembling large files, and burning) to work. Keyed by the config.json field name. */
const REQUIRED_CONFIG_EXECUTABLE_PATHS: { [key: string]: string } = {
  '_7zipExecutablePath': '7-Zip executable (7z.exe)',
  'imgBurnExecutablePath': 'ImgBurn executable (ImgBurn.exe)'
};

/** Baseline values for the non-executable config.json fields the rest of the app assumes are present (e.g.
 *  partitionBackupToOpticalMedia multiplies by maxOpticalMediumRepletionRatio - if that field is missing this
 *  silently computes NaN rather than throwing). These mirror the values the shipped appData/config.json
 *  template ships with. Used by updateConfig below to backfill anything not already in the file, so that
 *  writing just the two executable paths (e.g. from the setup dialog) never leaves the rest of the file
 *  incomplete - notably when config.json did not exist at all before that write.
 *  Deliberately excludes the two REQUIRED_CONFIG_EXECUTABLE_PATHS fields - defaulting those to a guessed
 *  install path would silently defeat the setup dialog's entire point of getting the user to confirm them. */
const DEFAULT_CONFIG_FIELDS: { [key: string]: any } = {
  maxOpticalMediumRepletionRatio: 0.95,
  defaultSourcePath: '',
  defaultTargetPath: '',
  cacheDataDirectoryPath: DEFAULT_CACHE_DATA_DIRECTORY_NAME
};

/** Reads config.json. Never throws - returns an empty object if the file is missing, empty, or not valid
 *  JSON, so callers can treat "missing" and "empty" the same way rather than each having to guard against a
 *  thrown exception individually. */
const readConfig = async function (): Promise<{ [key: string]: any }> {
  try {
    const file = fs.readFileSync(CONFIG_PATH());
    const parsed = JSON.parse(file);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (error) {
    return {};
  }
}

/** Checks the required executable paths in config.json (see REQUIRED_CONFIG_EXECUTABLE_PATHS) and reports
 *  which ones are missing, blank, or point to a file that no longer exists on disk (e.g. the user
 *  uninstalled or moved 7-Zip/ImgBurn since it was last configured) - as well as the full list of required
 *  fields regardless of current validity. The latter exists because a shipped default path can coincidentally
 *  already exist on a given machine (e.g. 7-Zip/ImgBurn installed at their usual default location) without the
 *  user ever having actually confirmed it - the caller uses this to still walk the user through every
 *  required field on first run, not just the ones currently failing. */
const validateConfigPaths = async function (): Promise<{
  config: { [key: string]: any },
  missingFields: Array<{ key: string, label: string }>,
  requiredFields: Array<{ key: string, label: string }>
}> {
  const config = await readConfig();
  const missingFields: Array<{ key: string, label: string }> = [];
  const requiredFields: Array<{ key: string, label: string }> = [];

  for (const key of Object.keys(REQUIRED_CONFIG_EXECUTABLE_PATHS)) {
    const field = { key: key, label: REQUIRED_CONFIG_EXECUTABLE_PATHS[key] };
    requiredFields.push(field);
    const value = config[key];
    if (!value || typeof value !== 'string' || value.trim() === '' || !fs.existsSync(value)) {
      missingFields.push(field);
    }
  }

  return { config: config, missingFields: missingFields, requiredFields: requiredFields };
}

/** Merges the given updates into the existing config.json (creating it if missing) and writes it back.
 *  Every existing field (including ones this app does not otherwise validate, like
 *  maxOpticalMediumRepletionRatio) is preserved as-is. Any of DEFAULT_CONFIG_FIELDS not already present in the
 *  file is backfilled with its baseline value - this matters most when config.json did not exist at all
 *  before this call (e.g. the user deleted it): without this, writing just the two executable paths from the
 *  setup dialog would leave the file missing maxOpticalMediumRepletionRatio/cacheDataDirectoryPath/etc.
 *  entirely, rather than recreating a complete config.json. */
const updateConfig = async function (updates: { [key: string]: any }): Promise<{ success: boolean, message: string }> {
  try {
    const existing = await readConfig();
    const merged = Object.assign({}, DEFAULT_CONFIG_FIELDS, existing, updates);
    await fs.promises.writeFile(CONFIG_PATH(), JSON.stringify(merged, null, 2));
    return { success: true, message: 'The configuration has been saved.' };
  } catch (error) {
    return { success: false, message: 'Failed to save the configuration: ' + (error && (error as any).message ? (error as any).message : String(error)) };
  }
}

const getTempDataDirectoryPath = async function (): Promise<string> {
  // Routes through ensureTempDataDirectoryIsAppOwned rather than just creating the directory on demand - see
  // its doc comment. Throws (rather than silently using an unowned directory) if the configured path already
  // exists and was not created by this app; the app-startup check (checkTempDataDirectoryOwnership in
  // app.component.ts) is expected to catch this before the app is usable at all, so reaching this rejection
  // in practice means cacheDataDirectoryPath was changed to something pre-existing mid-session.
  const result = await ensureTempDataDirectoryIsAppOwned();
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.path;
}

/** Empties the app's configured temp/cache directory (see cacheDataDirectoryPath in config.json /
 *  resolveTempDataDirectoryPath above) - the buffer used for large-file splits before they are burned to
 *  optical media. Used to let the user clear out leftover .part.NNN files from a previous run.
 *
 *  This directory is allowed to live anywhere on disk, not just under appData/ (see
 *  resolveTempDataDirectoryPath) - so unlike a fixed location, there is no single ancestor directory to check
 *  "is this still inside appData/" against. The safety model here is instead: whatever the temp directory
 *  actually is, wherever it is, only things strictly INSIDE it may ever be deleted, and the directory itself
 *  is never deleted - only its contents, one entry at a time:
 *   1) The temp directory itself is only ever emptied, never removed and recreated. The previous
 *      implementation did fs.rmSync(tempDir, {recursive:true}) followed by fs.mkdirSync(tempDir) - functionally
 *      similar, but that has a window where the directory does not exist at all, and if cacheDataDirectoryPath
 *      were ever misresolved (e.g. by a bug like the path.join one this function's sibling functions used to
 *      have - see resolveTempDataDirectoryPath), a bare recursive delete of "the whole target" is a much
 *      larger blast radius than deleting one already-verified entry at a time.
 *   2) Refuses outright if the resolved temp directory is a filesystem root (e.g. "C:\" or "D:\") - no
 *      legitimate cache/temp folder is ever a drive root, so this can only be a misconfiguration, and emptying
 *      an entire drive is exactly the kind of catastrophic mistake this function needs to never make.
 *   3) The temp directory's own real, on-disk location (fs.realpathSync, which follows symlinks/junctions) is
 *      resolved once up front - this is the actual containment boundary used below, not just the string path
 *      computed from config.json.
 *   4) Only the temp directory's own direct children are ever touched (fs.readdirSync on it - not a recursive
 *      walk that could follow something unexpected). For each child:
 *        - If it is itself a symlink/junction, only the link entry is removed - its target is never touched or
 *          recursed into (this is how fs.rmSync already behaves for a symlink regardless of `recursive`, but
 *          this function does not rely on that alone - see the next point).
 *        - Otherwise its real path is resolved and re-verified to still be strictly inside the temp
 *          directory's real path (isPathStrictlyInside) before it is deleted - belt-and-braces against
 *          anything that could otherwise make fs.readdirSync's result not mean what it looks like it means.
 *      Each child is attempted independently (one failing - e.g. a locked file - does not stop the others from
 *      being cleared), and the outcome is a combined summary rather than a single all-or-nothing result.
 *
 *  5) On top of all of the above, this only ever runs against a directory ensureTempDataDirectoryIsAppOwned
 *     has verified this app created itself (empty) in the first place - see its doc comment. The ownership
 *     marker file it writes is explicitly skipped in the deletion loop below, so it (and therefore the
 *     ownership guarantee) survives being cleared.
 *  6) Even within a directory verified as app-owned, each entry additionally has to pass
 *     isRecognizedTempContent before it is deleted - only .partNNN split files, .ibb project files (see
 *     IBB_PROJECT_FILE_PATTERN), and directories containing exclusively such files, are considered this app's
 *     own output. Ownership only proves the directory *started* empty; this is what keeps the actual deletion
 *     narrowed to things that look like what this app itself would have put there, regardless of how anything
 *     else might have ended up inside it since.
 *
 *  Returns `deletedItems`, the names of the entries actually removed (in removal order), alongside the summary
 *  `message` - the caller uses this to show the user exactly what was deleted, not just a count. */
const clearTempDataDirectory = async function (): Promise<{ cleared: boolean, message: string, deletedItems: string[] }> {
  const ownership = await ensureTempDataDirectoryIsAppOwned();
  if (!ownership.ok) {
    return { cleared: false, message: 'Refusing to clear: ' + ownership.message, deletedItems: [] };
  }
  const tempDataDirectoryPath = ownership.path;

  if (!fs.existsSync(tempDataDirectoryPath)) {
    return { cleared: true, message: 'The temp directory did not exist; nothing to clear.', deletedItems: [] };
  }

  let realTempDataDirectoryPath: string;
  try {
    realTempDataDirectoryPath = fs.realpathSync(tempDataDirectoryPath);
  } catch (error) {
    return { cleared: false, message: 'Failed to resolve the real path of the temp directory: ' + (error && (error as any).message ? (error as any).message : String(error)), deletedItems: [] };
  }

  let entries: Array<{ name: string, isSymbolicLink: () => boolean }>;
  try {
    entries = fs.readdirSync(tempDataDirectoryPath, { withFileTypes: true });
  } catch (error) {
    return { cleared: false, message: 'Failed to list the contents of the temp directory: ' + (error && (error as any).message ? (error as any).message : String(error)), deletedItems: [] };
  }

  // Excludes the ownership marker file, which is always present once the directory has been used and is
  // never a candidate for deletion - counting it would make an otherwise fully-cleared directory misleadingly
  // report e.g. "cleared 3 of 4 items" instead of "cleared".
  const clearableEntryCount = entries.filter(e => e.name !== CACHE_DIRECTORY_OWNERSHIP_MARKER_FILENAME).length;

  let deletedCount = 0;
  // Names of the entries actually removed below, in the order they were removed - reported back to the caller
  // so it can show the user exactly what was deleted (as opposed to `message`, which is just a summary).
  const deletedItems: string[] = [];
  const problems: string[] = [];

  for (const entry of entries) {
    if (entry.name === CACHE_DIRECTORY_OWNERSHIP_MARKER_FILENAME) {
      // Never delete the ownership marker - see its doc comment. Not counted as a "problem": leaving it in
      // place is the intended, successful outcome, not a failure.
      continue;
    }

    const entryPath = node_path_module.join(tempDataDirectoryPath, entry.name);

    if (!entry.isSymbolicLink()) {
      // Re-verify containment for every real (non-symlink) entry individually, using its own resolved real
      // path against the temp directory's real path established above - rather than assuming
      // fs.readdirSync's result can only ever mean "a direct child of tempDataDirectoryPath".
      try {
        const entryRealPath = fs.realpathSync(entryPath);
        if (!isPathStrictlyInside(entryRealPath, realTempDataDirectoryPath)) {
          problems.push(`"${entry.name}" was skipped: it does not resolve to a location inside the temp directory.`);
          continue;
        }
      } catch (error) {
        problems.push(`"${entry.name}" was skipped: could not resolve its real path (${error && (error as any).message ? (error as any).message : String(error)}).`);
        continue;
      }
    }
    // If entry.isSymbolicLink(), it is deleted as-is below without following it - removing a symlink/junction
    // entry never touches whatever it points to, regardless of the `recursive` option.

    if (!isRecognizedTempContent(entryPath, entry.isSymbolicLink())) {
      problems.push(`"${entry.name}" was skipped: it does not look like this app's own temp/cache content (only .partNNN split files, .ibb project files, and directories containing exclusively such files are deleted).`);
      continue;
    }

    try {
      fs.rmSync(entryPath, { recursive: true, force: true });
      deletedCount++;
      deletedItems.push(entry.name);
    } catch (error) {
      problems.push(`"${entry.name}" could not be deleted: ${error && (error as any).message ? (error as any).message : String(error)}.`);
    }
  }

  if (problems.length === 0) {
    return {
      cleared: true,
      message: clearableEntryCount === 0 ? 'The temp directory was already empty.' : `The temp directory has been cleared (${deletedCount} item(s) removed).`,
      deletedItems
    };
  }
  return {
    cleared: deletedCount > 0,
    message: `Cleared ${deletedCount} of ${clearableEntryCount} item(s) from the temp directory. ` + problems.join(' '),
    deletedItems
  };
}

const readJSONfromDisk = async function(path: string): Promise<Object> {
  const file = fs.readFileSync(path); 
  const j: Object = JSON.parse(file);
  return j;
}

const writeJSONtoDisk = async function(path: string, json:Object): Promise<void> {
  await fs.promises.writeFile(path, json);
  return;
}


/** @return an array that contains the absolute paths of all files in "dirPath" (in a recursive fashion).
 *  It also takes into account empty directories.
 * It also returns some stats. In particular: It returns a JSON obj of the form: 
 * [
    {
      "path": "C:\\Users\\user\\Desktop\\example dir for backup tests\\aa\\bb\\EXAMPLE 1.txt",
      "stats": {
        "size": 106,
        "mtime": "2024-12-20T02:14:45.027Z",
        "isDirectory": false
      }
    },
    {
      "path": "C:\\Users\\user\\Desktop\\example dir for backup tests\\empty\\",
      "stats": {
        "size": 0,
        "mtime": "2024-12-20T13:20:12.171Z",
        "isDirectory": true
      }
    }
   ]
 * @param dirPath the directory for which you want to list the files. 
 * @param arrayOfFiles <empty> (used internally for recursion) */
const getAllFilePathsWithStats = async function (
  dirPath: string,
  arrayOfFiles: Array<{"path": string, "stats": {"size": number, "mtime": Date, "isDirectory": boolean}}> = []
): Promise<Array<{"path": string, "stats": {"size": number, "mtime": Date, "isDirectory": boolean}}>> {
  
  // This resets the stop signal in case the user canceled the operation previously.
  process.env._stop = 'NoStop'
  let files: Array<string> = fs.readdirSync(dirPath)

  arrayOfFiles = arrayOfFiles || []

  if (files.length > 0) {
    let file: string;
    for (let i = 0; i < files.length; i++) {
      if(process.env._stop == 'stop'){break;}
      file = files[i];
      if (fs.statSync(dirPath + "/" + file).isDirectory()) {
        arrayOfFiles = await getAllFilePathsWithStats(dirPath + "/" + file, arrayOfFiles)
      } else {
        arrayOfFiles.push({"path": node_path_module.join(dirPath, "/", file), "stats": {
          "size": fs.statSync(dirPath + "/" + file).size,
          "mtime": fs.statSync(dirPath + "/" + file).mtime,
          "isDirectory": fs.statSync(dirPath + "/" + file).isDirectory() 
        }})
      }
      await holdOn();
    }
  } else {
    // Empty directory
    arrayOfFiles.push({"path": node_path_module.join(dirPath, "/"), "stats": {
          "size": fs.statSync(dirPath + "/").size,
          "mtime": fs.statSync(dirPath + "/").mtime,
          "isDirectory": fs.statSync(dirPath + "/").isDirectory() 
        }})
  }

  return arrayOfFiles
}

/** Reassembles a large file that was split into 7-Zip volumes (see partitionBackupToOpticalMedia / the
 *  "-v${LARGE_FILE_SPLIT_VOLUME_SIZE_MIB}m -mx0 a" call below) back into a single file, using 7-Zip itself,
 *  then - and only then - deletes the partial (.part.NNN) files.
 *
 *  We never delete anything unless we have positively verified the reassembly:
 *   1) "7z t" (test) is run first. This does not write anything to disk, so a corrupted or incomplete set of
 *      volumes is caught before we've touched the filesystem at all.
 *   2) Only if the integrity test passes do we actually extract ("7z x").
 *   3) After extraction we verify the reassembled file exists and is non-empty.
 *  Only after all three checks pass do we unlink the .part.NNN files. Any failure along the way returns
 *  {merged: false, ...} without deleting anything, so the caller can leave the partial files in place and
 *  let the user deal with them (e.g. via the original naming convention documented in the README).
 *
 * @param partFilePaths the absolute paths (on the local filesystem) of the .part.NNN files, all in one folder.
 * @param originalFileName the name 7-Zip is expected to restore the file under (the part before ".part.NNN").
 */
const mergeFileParts = async function(partFilePaths: Array<string>, originalFileName: string): Promise<{ merged: boolean, message: string }> {
  const util = require('util');
  const exec = util.promisify(require('child_process').exec);

  if (partFilePaths.length < 2) {
    return { merged: false, message: 'Not enough partial files were provided to attempt a reassembly.' };
  }

  const outputDir = node_path_module.dirname(partFilePaths[0]);
  const allPartsInSameDir = partFilePaths.every((p: string) => node_path_module.dirname(p) === outputDir);
  if (!allPartsInSameDir) {
    return { merged: false, message: 'The selected partial files do not all reside in the same folder.' };
  }

  let _7zipExecutablePath: string;
  try {
    const configJSON = fs.readFileSync(node_path_module.join(__dirname, `../../appData/config.json`));
    _7zipExecutablePath = JSON.parse(configJSON)._7zipExecutablePath;
  } catch (error) {
    return { merged: false, message: 'Could not read the 7-Zip executable path from the app configuration.' };
  }

  // 7-Zip locates the sibling volumes on its own once given the first one (.001, .002, ...).
  const sortedParts = partFilePaths.slice().sort();
  const firstPart = sortedParts[0];

  // Step 1: test archive integrity. Writes nothing - so a corrupted / incomplete set of volumes is caught
  // before we ever consider deleting anything.
  try {
    await exec(`"${_7zipExecutablePath}" t "${firstPart}"`);
  } catch (error) {
    return { merged: false, message: 'The partial files failed a 7-Zip integrity check (they may be corrupted, or some parts may be missing): ' + (error && (error as any).message ? (error as any).message : String(error)) };
  }

  // Step 2: actually extract.
  try {
    await exec(`"${_7zipExecutablePath}" x -y -o"${outputDir}" "${firstPart}"`);
  } catch (error) {
    return { merged: false, message: 'The 7-Zip extraction command failed: ' + (error && (error as any).message ? (error as any).message : String(error)) };
  }

  // Step 3: verify the result before trusting it enough to delete the partials.
  const reassembledPath = node_path_module.join(outputDir, originalFileName);
  if (!fs.existsSync(reassembledPath)) {
    return { merged: false, message: '7-Zip reported success but the reassembled file was not found at the expected location (' + reassembledPath + ').' };
  }
  if (fs.statSync(reassembledPath).size === 0) {
    return { merged: false, message: 'The reassembled file was created but is empty (0 bytes).' };
  }

  // Only now, after a verified successful merge, delete the partial files.
  for (const partPath of partFilePaths) {
    try {
      fs.unlinkSync(partPath);
    } catch (error) {
      // The merge itself succeeded; failing to delete a leftover .part file is a much smaller problem than
      // deleting something we should not have, so this does not count as a failed merge.
      console.error('Failed to delete partial file after a successful merge: ' + partPath, error);
    }
  }

  return { merged: true, message: 'Successfully reassembled "' + originalFileName + '".' };
}

// Helper function. Source: https://stackoverflow.com/questions/11731072/dividing-an-array-by-filter-function
const partitionArrayBasedOnFilter = <T,>(
  array: T[],
  callback: (element: T, index: number, array: T[]) => boolean
) => {
  return array.reduce(function(result:any[], element, i) {
    callback(element, i, array)
      ? result[0].push(element) 
      : result[1].push(element);

    return result;
  }, [[],[]]);
};

// This function returns an array of string arrays. Each sub array contains the files to be written to on one of several optical disks depending on the total size of
// the files to be backed-up and the capacity of the optical medium to be used.  
const partitionBackupToOpticalMedia = async function(dirPath: string, mediaCapacityInBytes: number, splitLargeFiles:boolean=false, filesMetadata?:filesMetadata[]): Promise<ColdStorageMetadata>{
  process.env._stop="NoStop";

  //be on the save side, fill the disk at most up to a certain percentage (e.g. 95% or something).
  const configJSON = fs.readFileSync(node_path_module.join(__dirname, `../../appData/config.json`));
  const parsedConfig = JSON.parse(configJSON);
  mediaCapacityInBytes = mediaCapacityInBytes * parsedConfig.maxOpticalMediumRepletionRatio;
  // Routes through ensureTempDataDirectoryIsAppOwned rather than just creating the directory on demand - see
  // its doc comment for why (the startup check normally catches an unowned directory before this is ever
  // reached - this is defense-in-depth for cacheDataDirectoryPath being changed to something pre-existing
  // mid-session).
  const ownership = await ensureTempDataDirectoryIsAppOwned();
  if (!ownership.ok) {
    throw new Error(ownership.message);
  }
  const tempDataDirectoryPath = ownership.path;

  if(dirPath.slice(-1) == '\\'){
    dirPath = dirPath.slice(0, -1); 
  }

  let filePathsAndStats = await getAllFilePathsWithStats(dirPath)

  if(filesMetadata!==undefined){
    filePathsAndStats = filesMetadata;
  }

  let largeFilePathsAndStats: typeof filePathsAndStats = [];
  let Gb = Math.pow(1024, 3); // Windows style Gb

  let partitioning: ColdStorageMetadata = []
  let err_too_large_file_found: boolean = false
  let too_large_files_paths: {"path": string, "stats": {"size": number, "mtime": Date, "isDirectory": boolean}}[] = []

  if(splitLargeFiles){
    //Filter files too large to fit to any single optical disc
    [filePathsAndStats, largeFilePathsAndStats] = partitionArrayBasedOnFilter(
      filePathsAndStats, 
      (item) => item.stats.size <= mediaCapacityInBytes,
    );
  }

  while (filePathsAndStats.length > 0 && !(process.env._stop=="stop")) {
    if(process.env._stop == 'stop'){break;}
    let paths: {"path": string, "stats": {"size": number, "mtime": Date, "isDirectory": boolean}}[] = []
    const initialUsedSpaceInBytes = 0;
    // The slice(0) is used for breaking from reduce if needed. See https://stackoverflow.com/questions/36144406/how-to-early-break-reduce-method
    const usedSpaceInBytes = filePathsAndStats.slice(0).reduce(
    (accumulator, currentRecord, i, arr) => {
      const r = accumulator + currentRecord.stats.size
      
      if(currentRecord.stats.size >= mediaCapacityInBytes && !splitLargeFiles){
        console.log(
          "That's a problem! Found a file which is too large to be contained to ANY single optical disk. Size of file in bytes: " +
          currentRecord.stats.size + ". path: " + currentRecord.path + ". Canceling operation.");
        err_too_large_file_found = true;
        too_large_files_paths.push(currentRecord)
        process.env._stop="stop"
        // Break from reduce
        arr.splice(1);
      }else if(process.env._stop=="stop"){
        // Break from reduce. User canceled
        arr.splice(1);
      }
      
      // <= (not strict <): a file whose size exactly equals mediaCapacityInBytes must still be placeable
      // (alone, filling the disc exactly) - with strict <, such a file could never satisfy this check on its
      // own, and since the too-large guard above is skipped whenever splitLargeFiles is true (regular-size
      // files, unlike oversized ones, are never pulled out of this loop in that mode), it would never be
      // added to `paths` nor removed from filePathsAndStats - spinning the enclosing while loop forever.
      if(r <= mediaCapacityInBytes){
    	  accumulator = r
          paths.push(currentRecord)
      }

      return accumulator
    },
    initialUsedSpaceInBytes,
    );

    // This is the amount of used space for the particular optical disk in the set.
    //console.log(usedSpaceInBytes)

    // remove the files assigned to this optical disk from the complete records. 
    filePathsAndStats = filePathsAndStats.filter(function(itm){
      return !paths.includes(itm)
    });

    // Number of files assigned to the particular optical disk in the set.
    //console.log(paths.length)
    
    partitioning.push(paths)

  }
  // number of optical disks needed for the entire backup
  // console.log(partitioning.length)


  /* Next we need to split the files to multiple parts. Note that we are not doing the actual splitting here, we just
    create the paths and sizes of the split files (currently virtual, non existing). The actual splitting will be done when the user
    clicks the button to send the data to the ImgBurn software. The resulting paths array will be used later to assist with the
    actual splitting of the large files and their partitioning to optical discs.
  */
  const zeroPad = (num: number, places: number) => String(num).padStart(places, '0')

  if(splitLargeFiles){
    let largeFilePathsAndStats_:any = [];
    for (let i = 0; i < largeFilePathsAndStats.length; i++) {
          let tmp = (await Promise.all([largeFilePathsAndStats[i]].map(
            async (itm): Promise<typeof filePathsAndStats> => {
              let fileName = itm.path.split('\\').slice(-1)[0];
              let pathToLargeFile = itm.path;
              let pathToLargeFileRelativeToOpticalMediumRoot = pathToLargeFile.replace(dirPath + "\\", "");
              let relativeDirOfLargeFile = pathToLargeFileRelativeToOpticalMediumRoot.split("\\").slice(0, -1).join("\\");
              let pathToLargeFileSplitsInTempDirectory = node_path_module.join(tempDataDirectoryPath, relativeDirOfLargeFile);
              let path = node_path_module.join(tempDataDirectoryPath, fileName);

              // Create a directory in the temp data directory for each large files splits set if it does not exist already
              if (!fs.existsSync(pathToLargeFileSplitsInTempDirectory)){
                fs.mkdirSync(pathToLargeFileSplitsInTempDirectory, { recursive: true });
              }


              // then create the large file splits in that directory if not already existing.

              // Escape all special characters in fileName.
              let re = new RegExp(`^${fileName.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}.part`);
              let partFileNames = fs.readdirSync(pathToLargeFileSplitsInTempDirectory).filter((value: string) => re.test(value));

              if (partFileNames.length == 0) {
                const util = require('util');
                const exec = util.promisify(require('child_process').exec);
                const configJSON = fs.readFileSync(node_path_module.join(__dirname, `../../appData/config.json`));
                const _7zipExecutablePath = JSON.parse(configJSON)._7zipExecutablePath;
                // We split the files without compression to speed up the process. Each split is
                // LARGE_FILE_SPLIT_VOLUME_SIZE_MIB (see that constant's own comment for why this size).
                const { stdout, stderr } = await exec(`"${_7zipExecutablePath}" -v${LARGE_FILE_SPLIT_VOLUME_SIZE_MIB}m -mx0 a "${pathToLargeFileSplitsInTempDirectory}\/${fileName}.part" "${pathToLargeFile}"`);
              }
              
              partFileNames = fs.readdirSync(pathToLargeFileSplitsInTempDirectory).filter((value: string) => re.test(value));

              let a: typeof largeFilePathsAndStats = [];
              for (let index = 0; index < partFileNames.length; index++) {
                a.push({
                  path: pathToLargeFileSplitsInTempDirectory + "\\" + partFileNames[index], stats: {
                    size: fs.statSync(pathToLargeFileSplitsInTempDirectory + "\\" + partFileNames[index]).size,
                    mtime: fs.statSync(pathToLargeFileSplitsInTempDirectory + "\\" + partFileNames[index]).mtime,
                    isDirectory: false
                  }
                });
              }
              return a;
            }
          ))).flat();
        largeFilePathsAndStats_.push(tmp);
    }

    largeFilePathsAndStats = largeFilePathsAndStats_.flat()

    while (largeFilePathsAndStats.length > 0 && !(process.env._stop=="stop")) {
      if(process.env._stop == 'stop'){break;}
      let paths: {"path": string, "stats": {"size": number, "mtime": Date, "isDirectory": boolean}}[] = []
      const initialUsedSpaceInBytes = 0;
      const usedSpaceInBytes = largeFilePathsAndStats.slice(0).reduce(
      (accumulator, currentRecord, i, arr) => {
      const r = accumulator + currentRecord.stats.size

      // Same guard the ordinary-file pass above already has (see its own "too large to be contained to ANY
      // single optical disk" check) - without it, a split piece (fixed at LARGE_FILE_SPLIT_VOLUME_SIZE_MIB)
      // that's bigger than mediaCapacityInBytes would never get pushed into `paths` below, so the filter after
      // this reduce would remove nothing from largeFilePathsAndStats, and the enclosing while loop - whose only
      // exit condition is largeFilePathsAndStats.length reaching 0 - would spin forever, pushing empty discs.
      // Not reachable through the real app UI today (the smallest selectable medium is always bigger than one
      // split piece - see that constant's own comment for why), but a real risk if this is ever called directly
      // with too small a capacity.
      if(currentRecord.stats.size >= mediaCapacityInBytes){
        console.log(
          "That's a problem! Found a large-file split piece which is too large to be contained to ANY single optical disk. Size of piece in bytes: " +
          currentRecord.stats.size + ". path: " + currentRecord.path + ". Canceling operation.");
        err_too_large_file_found = true;
        too_large_files_paths.push(currentRecord)
        process.env._stop="stop"
        // Break from reduce
        arr.splice(1);
      }else if(process.env._stop=="stop"){
        // Break from reduce. User canceled
        arr.splice(1);
      }

      // <= (not strict <): same reasoning as the ordinary-file pass above - a run of split pieces whose
      // accumulated size lands exactly on mediaCapacityInBytes must still be placeable. With strict <, such
      // a piece would never satisfy this check, so it would never be added to `paths` nor removed from
      // largeFilePathsAndStats, spinning the enclosing while loop forever. This was the same off-by-one
      // already fixed for the ordinary-file loop but not mirrored here.
      if(r <= mediaCapacityInBytes){
        accumulator = r
          paths.push(currentRecord)
      }

      return accumulator
      },
      initialUsedSpaceInBytes,
      );

      // This is the amount of used space for the particular optical disk in the set.
      //console.log(usedSpaceInBytes)

      // remove the files assigned to this optical disk from the complete records. 
      largeFilePathsAndStats = largeFilePathsAndStats.filter(function(itm){
      return !paths.includes(itm)
      });

      // Number of files assigned to the particular optical disk in the set.
      //console.log(paths.length)

      partitioning.push(paths)

    }

  }


  if(err_too_large_file_found){
    throw {msg:"Found a file which is too large to be contained to any single optical disk : " + too_large_files_paths[0].path,
       err_code: 'FILE_TOO_LARGE_FOR_SINGLE_OPTICAL_DISC'
      };
  }else{
    return partitioning;
  }
}


/** @return an array that contains the absolute paths of all files in "dirPath" (in a recursive fashion).
 *  It also takes into account empty directories. 
 * @param dirPath the directory for which you want to list the files. 
 * @param arrayOfFiles <empty> (used internally for recursion) */
const getAllFilesSet = async function (dirPath: string, arrayOfFiles: Set<string> = new Set<string>()): Promise<Set<string>> {
  let files: Array<string> = fs.readdirSync(dirPath)

  if (files.length > 0) {
    let file: string;
    for (let i = 0; i < files.length; i++) {
      if(process.env._stop == 'stop'){break;}
      file = files[i];
      if (fs.statSync(dirPath + "/" + file).isDirectory()) {
        arrayOfFiles = await getAllFilesSet(dirPath + "/" + file, arrayOfFiles)
      } else {
        arrayOfFiles.add(node_path_module.join(dirPath, "/", file))
        //print_line(arrayOfFiles.length + "")
      }
      await holdOn();
    }
  } else {
    arrayOfFiles.add(node_path_module.join(dirPath, "/"))
    //print_line(arrayOfFiles.length + "")
  }

  return arrayOfFiles
}

/** PowerShell script (passed inline via -Command, not a .ps1 file, so no execution-policy issues) that polls
 *  for an optical drive with media loaded and readable, entirely on its own - the Start-Sleep between checks
 *  runs INSIDE this one long-lived process, rather than Node spawning a brand new process on every tick. It
 *  prints exactly one line of compact JSON and exits as soon as it finds a match.
 *
 *  DriveType=5 is the CIM/WMI constant for optical drives (CD/DVD/Blu-ray - same meaning as the old
 *  disk.filesystem == "CD-ROM Disc" check, but a more direct/robust way to ask "is this an optical drive"
 *  rather than pattern-matching a filesystem label). Size > 0 is the same "does it actually have readable
 *  media in it right now" signal the old disk.used > 0 check was after - an empty drive reports Size 0. */
const OPTICAL_DISC_POLL_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
while ($true) {
    $disks = Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DriveType=5"
    foreach ($d in $disks) {
        if ($d.Size -gt 0) {
            $result = [PSCustomObject]@{
                mounted = $d.DeviceID
                filesystem = $d.FileSystem
                size = $d.Size
                freeSpace = $d.FreeSpace
                volumeName = $d.VolumeName
            }
            Write-Output ($result | ConvertTo-Json -Compress)
            exit 0
        }
    }
    Start-Sleep -Milliseconds 700
}
`;

/** Waits for an optical disc to be inserted and readable, returning its info (or null if cancelled via
 *  process.env._stop, or if detection itself fails to run at all).
 *
 *  This used to poll node-disk-info's getDiskInfo() every 1 second, which on Windows spawns TWO synchronous
 *  child processes on every single tick (a `chcp` call, then `wmic logicaldisk get ...`) - each process spawn
 *  alone typically costs anywhere from a couple hundred ms to well over a second, which is why disc detection
 *  used to feel sluggish (that cost was being paid twice a second, every second, on top of the 1-second poll
 *  delay itself). wmic.exe is also on Microsoft's deprecated-features list and is already missing by default
 *  from some newer Windows installs, so relying on it was a real (if unpredictable) future-breakage risk.
 *
 *  This now spawns exactly ONE PowerShell process for the entire wait (OPTICAL_DISC_POLL_SCRIPT above), using
 *  Get-CimInstance - the officially supported successor to wmic, built into every modern Windows install (no
 *  separate install needed, unlike e.g. PowerShell 7/pwsh). The polling loop lives inside that one process
 *  instead of being re-spawned from Node every tick, so there is only ever one process-startup cost for the
 *  whole wait, not one (let alone two) per second. */
const waitForOpticalDiskToBeMounted = async function (): Promise<any|null> {
  process.env._stop = "noStop";
  const { spawn } = require('child_process');

  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', OPTICAL_DISC_POLL_SCRIPT], { windowsHide: true });

    let settled = false;
    let stdoutBuffer = '';

    // Node's side of the process.env._stop cancellation convention used throughout this file - the polling
    // loop itself now lives inside the PowerShell process (see OPTICAL_DISC_POLL_SCRIPT), so this is what
    // actually stops it early: killing the process is the only way to interrupt it mid-wait.
    const stopCheckInterval = setInterval(() => {
      if (process.env._stop === 'stop' && !settled) {
        settled = true;
        clearInterval(stopCheckInterval);
        child.kill();
        resolve(null);
      }
    }, 300);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
    });

    child.on('error', (error: Error) => {
      if (settled) { return; }
      settled = true;
      clearInterval(stopCheckInterval);
      console.error('Failed to start PowerShell for optical disc detection', error);
      resolve(null);
    });

    child.on('close', () => {
      if (settled) { return; }
      settled = true;
      clearInterval(stopCheckInterval);

      const line = stdoutBuffer.trim().split(/\r?\n/).filter((l: string) => l.trim() !== '').pop();
      if (!line) {
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(line);
        // Field names deliberately keep the leading underscore (_mounted, etc.) for backward compatibility -
        // the renderer reads response.res._mounted (see optical-disc-backup-data-retriever.component.ts).
        // This mirrors how the old node-disk-info Drive class used to serialize over IPC: its PRIVATE fields
        // (_mounted, _filesystem, ...), not its public getters, are what survive structured-clone
        // serialization across the IPC boundary - getters are not own-enumerable properties.
        resolve({
          _mounted: parsed.mounted,
          _filesystem: parsed.filesystem,
          _blocks: parsed.size,
          _available: parsed.freeSpace,
          _used: (typeof parsed.size === 'number' && typeof parsed.freeSpace === 'number') ? (parsed.size - parsed.freeSpace) : undefined,
          _volumeName: parsed.volumeName
        });
      } catch (error) {
        console.error('Failed to parse optical disc detection output', error, stdoutBuffer);
        resolve(null);
      }
    });
  });
}


/**
 * Returns the elements that exist only in source.
 * The paths for the source and target must be absolute.
 * For example: let source = 'F:\\User\\backup_system\\source' + "\\"
 * let target = 'F:\\User\\backup_system\\target' + "\\"
 * diff(source, target)
 */
const diff = async function (source: string, target: string): Promise<string[]> {
  process.env._stop = "noStop";
  
  if (source[source.length - 1] != '\\') { source += "\\"; }
  if (target[target.length - 1] != '\\') { target += "\\"; }
  console.log("Reading paths of: " + source)
  let time_start = performance.now();
  let source_files = await getAllFiles(source)
  console.log("\nReading paths of: " + target)
  let target_files = await getAllFilesSet(target)
  let time_end = performance.now();
  console.log("DONE READING FILES " + ((time_end - time_start) / 1000).toFixed(2))
  time_start = performance.now();
  let source_only = source_files.filter(file => {
    let sourcePath = file
    let targetPath = file.replace(source, target)

    let b = target_files.has(targetPath)
    if (!b) {
      return true // source only
    } else if ((fs.statSync(sourcePath).mtime > fs.statSync(targetPath).mtime) || (fs.statSync(sourcePath).size != fs.statSync(targetPath).size)) {
      return true // modified
    } else {
      return false // backed up
    }
  })
  time_end = performance.now();
  //source_files.forEach(function (filePath) { console.log(filePath) })
  //target_files.forEach(function (filePath) { console.log(filePath) })
  //source_only.forEach(function (filePath) { console.log(filePath) })
  console.log("DONE CALCULATING DIFF " + ((time_end - time_start) / 1000).toFixed(2))
  return source_only.map(file => file.replace(source, ''));
}

const get_common_files = async function (source: string, target: string): Promise<string[]> {
  console.log("Reading paths of: " + source)
  let source_files = await getAllFiles(source)
  console.log("\nReading paths of: " + target)
  let target_files = await getAllFiles(target)

  source_files = source_files.map(file => file.replace(source, ''))
  target_files = target_files.map(file => file.replace(target, ''))
  let common = source_files.filter(file => {
    if (file[file.length - 1] != '\\') {
      let b = target_files.includes(file)
      if (b) {
        return true // common
      }
    }
  })
  return common;
}

const check_commmon_files_for_equality = async function (source: string, target: string): Promise<void> {
  let common_files = await get_common_files(source, target);
  //console.log(common_files)
  let s = ''
  let t = ''
  let files_not_equal = 0
  let start_timestamp = new Date().getTime()
  let estimation_interval = 20
  let elapsed_time = 0
  let estimated_time_to_finish = '-'
  for (let index = 0; index < common_files.length; index++) {
    s = source + common_files[index];
    t = target + common_files[index];
    try {
      if (!fs.readFileSync(s).equals(fs.readFileSync(t))) {
        files_not_equal++
      }
    } catch (error) {
      //print_line('')
      console.log('this file is too large to check: ' + s)
      files_not_equal++
    }
    if (index % estimation_interval == 0) {
      if (index > 0) {
        elapsed_time = new Date().getTime() - start_timestamp
        estimated_time_to_finish = new Date(Math.floor((elapsed_time * common_files.length) / index) - elapsed_time).toISOString().slice(11, 19)
      }
    }

    //print_line((index - files_not_equal) + " out of " + (common_files.length - 1) + ' files are equal | estimated time to finish: ' + estimated_time_to_finish)
  }
}


const createTree = async function (sourceOnlyPaths: Array<string>, doCopy: boolean, source: string, target: string): Promise<void> {
  process.env._stop = "noStop";
  
  if (source[source.length - 1] != '\\') { source += "\\"; }
  if (target[target.length - 1] != '\\') { target += "\\"; }
  let tree = {}

  let path: string;
  for (let index = 0; index < sourceOnlyPaths.length; index++) {
    if(process.env._stop == 'stop'){
      console.log('got stop. Exiting.')
      break;
    }
    path = sourceOnlyPaths[index];
    let tokens = path.split('\\')
    insertBranch(tree, tokens, 0, doCopy, source, target);
    await holdOn();
  }
  //console.log(tree)
}

//Note: the pathsMarkedForDeletion contain a list of full paths consisting of 2 cases:
// 1: the files needed to be deleted.
// 2: any empty directories that need to be deleted.
//It is possible that after all these deletions, other directories also need to be deleted because they have become empty and
//they are not present in the master directory (even as empty directories).
//This case is accounted for inside deleteFilesAndDirsForDirSync. 
const deleteFilesAndDirsForDirSync = async function (pathsMarkedForDeletion: Array<string>, commit: boolean, source: string, target: string): Promise<void> {
  
  if(pathsMarkedForDeletion.length == 0){
    return;
  }

  process.env._stop = "noStop";

  if (source[source.length - 1] != '\\') { source += "\\"; }
  if (target[target.length - 1] != '\\') { target += "\\"; }
  let tree = {}

  let path: string;
  let tokens: string[] = [];
  //First path
  if(process.env._stop != 'stop'){
    path = pathsMarkedForDeletion[0];
    tokens = path.split('\\');
    insertBranchForDirSyncDeletions(tree, tokens, 0, commit, target, source);    
    await holdOn();
  }
  // Rest of the paths.
  for (let index = 1; index < pathsMarkedForDeletion.length; index++) {
    if(process.env._stop == 'stop'){
      console.log('got stop. Exiting.')
      return;
    }
    let tokens_prev = tokens;
    path = pathsMarkedForDeletion[index];
    tokens = path.split('\\');
    let idx = tokens.findIndex(function(c, i) {return c != tokens_prev[i]});    
    let tokens_diff_slice = tokens_prev.slice(idx, tokens_prev.length);
    let tokens_common_slice =  tokens_prev.slice(0, idx);
    /* remove the last token from tokens_diff_slice. There are 2 cases:
    1: the last token is a file, in which case we don't have to check for the deletion of a directory
    2: the last token is '' which means that the second-to-last token is the name of a directory.
    In this case we must check for the possible deletion of this directory. In either case we have to remove the last token in tokens_diff_slice*/
    tokens_diff_slice.splice(-1);
    if(tokens_diff_slice.length > 0){
      while(tokens_diff_slice.length > 0){ 
        let path_to_be_checked = tokens_common_slice.concat(tokens_diff_slice);
        let subTree = getSubTree(tree, path_to_be_checked);  
        let subTreeContents = getContentsFromTree(subTree);
        let mp = source + path_to_be_checked.join("\\") + ("\\");
        let tp = target + path_to_be_checked.join("\\") + ("\\");
        let exists_in_master:boolean;        
        try {
          fs.readdirSync(mp, {recursive:true});
          exists_in_master = true; 
        } catch (error) {
          exists_in_master = false;
        }

        // Replace any trailing '\' characters. This is because fs.readdirSync does not add '\' to the end of a directory path.
        subTreeContents = subTreeContents.map((d)=>{return d.replace(/\\+$/, "");});
        let dirContents = fs.readdirSync(tp, {recursive:true});
        if(!commit && !exists_in_master && sameMembers(subTreeContents, dirContents)){
          logsBuffer.push("will delete directory :" + tp)
        }else if(commit && !exists_in_master && dirContents.length==0){
          fs.rmdirSync(tp) 
          logsBuffer.push("deleted directory :" + tp);
        }

        tokens_diff_slice.pop();
      }
    }
    insertBranchForDirSyncDeletions(tree, tokens, 0, commit, target, source);    
    await holdOn();
  }

  /*Finished processing all paths. Now check the directories anywhere in the last path marked for deletion
  for possible empty directories that also have to be deleted.*/
  tokens = pathsMarkedForDeletion[pathsMarkedForDeletion.length - 1 ].split("\\");
  
  /* remove the last token from tokens. There are 2 cases:
    1: the last token is a file, in which case we don't have to check for the deletion of a directory
    2: the last token is '' which means that the second-to-last token is the name of a directory.
    In this case we must check for the possible deletion of this directory. In either case we have to remove the last token in tokens*/
  tokens.splice(-1);
  if(tokens.length > 0){
    while(tokens.length > 0){
      let dir_name = tokens.pop();
      let full_path_to_be_checked_target:string;
      let full_path_to_be_checked_master:string;
      if(!tokens.length){
        full_path_to_be_checked_target = target +  dir_name + "\\";
        full_path_to_be_checked_master = source + dir_name + "\\";
      }else{
        full_path_to_be_checked_target = target + tokens.join("\\") + "\\" + dir_name + "\\";
        full_path_to_be_checked_master = source + tokens.join("\\") + "\\" + dir_name + "\\";
      }
      if(dir_name){
        let subTree = getSubTree(tree, tokens.concat([dir_name]))
        let dir_exists_in_master:boolean;
        try {
          fs.readdirSync(full_path_to_be_checked_master, {recursive:true})
          dir_exists_in_master = true;
        } catch (error) {
          //path does not exist
          dir_exists_in_master = false;
        }

        let dir_emptied_in_target: boolean;
        dir_emptied_in_target = (sameMembers(
          getContentsFromTree(subTree).map((d)=>{return d.replace(/\\+$/, "");}),
          fs.readdirSync(full_path_to_be_checked_target, {recursive:true})));

        if(!commit && !dir_exists_in_master && dir_emptied_in_target){
          logsBuffer.push("will delete directory :"+ full_path_to_be_checked_target);
        }else if(commit && !dir_exists_in_master && fs.readdirSync(full_path_to_be_checked_target, {recursive:true}).length==0){
          fs.rmdirSync(full_path_to_be_checked_target) 
          logsBuffer.push("deleted directory :" + full_path_to_be_checked_target);
        }
      }
    }
  }

}


function sameMembers(arr1:Array<any>, arr2:Array<any>) {
  const set1 = new Set(arr1);
  const set2 = new Set(arr2);
  return arr1.every((item: any) => set2.has(item)) &&
      arr2.every((item: any) => set1.has(item))
}

/*A helper function. This function recursively reads a 'files tree' object as defined in the 'insertBranchForDirSyncDeletions' function and returns all the contents
of the tree in an array of strings. Ie. it returns all the paths for all the files and directories in the 'files tree'.
This function essentially performs the same operation as fs.readdirSync(path_to_be_checked, {recursive:true}) but it operates on a 'files tree'
as this is defined in 'insertBranchForDirSyncDeletions'. This was inentional so that we can compare the output of getContentsFromTree and readdirSync
for equality. This getContentsFromTree helper function is useful for previewing the delete operations before actually commiting them.
I know it's somewhat complicated and also not very efficient computationally, but for now, it seems to work. */
const getContentsFromTree = function(tree: Object):Array<string>{
  const getPaths: Function = (o: Object) => 
    Object
  .entries(o)
  .flatMap(
    ([k, v])=>{
      if(JSON.stringify(v) == JSON.stringify({})){
        return k + "\\";              
      }else if(v==null){
        return k;
      }else{
        return [...new Set(getPaths(v).flatMap((p: any) => [`${k}\\`,`${k}\\${p}`]))];
      }
    }
  ),tree_ = tree, paths = getPaths(tree);
  
  return paths;
}


/*This is a helper function that returns a sub-tree from a tree object as it is defined in 'insertBranchForDirSyncDeletions'.
This is essentially a tool for accessing the object properties. Instead of doing this: tree['property1']['property2']['property3'] etc.,
we want to be able to access the nested properties in a more convenient way.
Thus, we could just use: getSubTree(tree, ['property1', 'property2', 'property3']) */
const getSubTree = function(tree:{}, path:Array<string>){
  return Array.prototype.slice.call(path).reduce(function(acc, key) {
    return acc[key]
  }, tree)    
}

const insertBranchForDirSyncDeletions = function (
tree: any, tokens: Array<string>, index: number, commit: boolean, target: string, source: string): void {
  if ((tokens.length - index) == 1) {   
    if (tokens[index] != '') {
      tree[tokens[index]] = null;
      let path_suffix = createPath(tokens, index)
      let source_path = source + path_suffix
      let target_path = target + path_suffix
      if (commit) {
        fs.unlinkSync(target_path);
        logsBuffer.push("deleted file :" + target_path);
      } else {
        logsBuffer.push("will delete file :" + target_path);
      }
    }
  } else {
    if (!tree.hasOwnProperty(tokens[index])) {
      if(tokens[index] != ''){
        tree[tokens[index]] = {}
      }      
      let path_suffix = createPath(tokens, index)
      let source_path = source + path_suffix
      let target_path = target + path_suffix
      if(commit){
        //Remove an empty dir which  is also not present in the 'master'. (Not even as an empty directory.)
        //fs.rmdirSync(directoryScheduledForDeletion);
        //logsBuffer.push("deleted DIR: " + target_path);
        //console.log("deleted DIR: " + target_path)
      }else{
        if (!fs.existsSync(source_path) && fs.existsSync(target_path)) {    
          //logsBuffer.push("will delete DIR: " + target_path);
          //console.log("will delete DIR: " + target_path);
        }
      }
                
      
    }
    let a = tokens[index]
    index += 1
    insertBranchForDirSyncDeletions(tree[a], tokens, index, commit, target, source);
  }

}


const waste_time = function (millis: number){
    let timer_start = performance.now();
    let dummy = new Date().getTime();
    let sum = 0;
    if(millis){
      
      let start_time = performance.now();
      while((performance.now() - start_time) < millis){
        sum += dummy;
      }
      if(sum == 1){ }
    }
    console.log("waste_time: " + ((performance.now() - timer_start) / 1000) + " sec");
}

const dummy_copy = async function() : Promise<void>
{
  process.env._stop = "noStop";
  // specify the test workloads
  enum File {
    Small = 1,
    Medium = 30,
    Big = 1000
  };
  let workloads:Array<number> = [];
  for(let i=0; i<18000; ++i){ workloads.push(File.Small); } // 10 sec
  //for(let i=0; i<8000; ++i){ workloads.push(File.Medium); } // 6 sec
  for(let i=0; i<5; ++i){ workloads.push(File.Big); } // 5 sec
  
  // begin dummy copying...
  workloads.forEach((load)=>{
    switch(load){
    case File.Small:
      logsBuffer.push("copying small file...");
      break;
    case File.Medium:
      logsBuffer.push("copying medium file...");
      break;
    case File.Big:
      logsBuffer.push("copying big file...");
      break;
    }
    waste_time(load);
  });
}

const createPath = function (tokens: Array<string>, index: number): string {
  let path = ""
  for (let i = 0; i < index; i++) {
    path = path + tokens[i] + "\\";
  }
  path = path + tokens[index]
  return path
}

const insertBranch = function (tree: any, tokens: Array<string>, index: number, doCopy: boolean, source: string, target: string): void {
  if ((tokens.length - index) == 1) {
    tree[tokens[index]] = {}
    // Create file OR directory
    if (tokens[index] != '') {
      let path_suffix = createPath(tokens, index)
      let target_path = target + path_suffix
      let source_path = source + path_suffix
      if (doCopy) {
        let filePathAlreadyExistedInBackup = false;
        if(fs.existsSync(target_path)){
          filePathAlreadyExistedInBackup = true;
        }
        fs.copyFileSync(source_path, target_path);
        if(filePathAlreadyExistedInBackup){
          logsBuffer.push("updated existing file :" + target_path);
        }else{
          logsBuffer.push("copied file :" + target_path);
        }
      } else {
        if(fs.existsSync(target_path)){
          logsBuffer.push("will update existing file :" + target_path);
        }else{
          logsBuffer.push("will copy file :" + target_path);
        }
      }
    }
  } else {
    if (!tree.hasOwnProperty(tokens[index])) {
      tree[tokens[index]] = {}
      // Create directory (only)
      let path_suffix = createPath(tokens, index)
      let target_path = target + path_suffix
      if (!fs.existsSync(target_path)) {
        if (doCopy) {
          fs.mkdirSync(target_path);
          logsBuffer.push("created directory :" + target_path);
          //console.log("created DIR: ", target_path);
        } else {
          logsBuffer.push("will create directory :" + target_path);
        }
      }
    }
    let a = tokens[index]
    index += 1
    insertBranch(tree[a], tokens, index, doCopy, source, target);
  }
}


//-----------

const insertBranch_for_IBB_creation = function (tree: any, tokens: Array<string>, index: number, source: string, target: string, logs: string[]): void {
  if ((tokens.length - index) == 1) {
    tree[tokens[index]] = {}
    // Create file OR directory
    if (tokens[index] != '') {
      let path_suffix = createPath(tokens, index)
      let target_path = target + path_suffix

      const fileName = target_path.slice(1).split('\\').slice(-1)[0]
      const n_tokens = target_path.split('\\').length
      let parentInOpticalDiskFileStructure = target_path.split('\\').slice(0, n_tokens - 1).join('\\');
      if(parentInOpticalDiskFileStructure == ''){ parentInOpticalDiskFileStructure =  '\\' }
      let fileFullSourcePath = source + target_path.slice(1);
      /* There is a possibility that the file is part of a splitted large file.
         These splits are stored in the temp data directory. Thus the full path to this split (part file)
         is created using a different 'source'. Here we take care of this case. If the fileFullSourcePath = source + target_path.slice(1);
         does not exist, then try using the temp directory path as the source dir. */
      if (!fs.existsSync(fileFullSourcePath)) {
        const configJSON = fs.readFileSync(node_path_module.join(__dirname, `../../appData/config.json`));
        // resolveTempDataDirectoryPath, not a raw path.join of the config value - see its doc comment for why
        // (cacheDataDirectoryPath can be an absolute path pointing anywhere on disk). node_path_module.join is
        // used (rather than string concatenation) to combine it with target_path.slice(1) so this is correct
        // regardless of whether either piece happens to have a leading/trailing separator.
        let tempDataDirectoryPath = resolveTempDataDirectoryPath(JSON.parse(configJSON));
        fileFullSourcePath = node_path_module.join(tempDataDirectoryPath, target_path.slice(1));
      }
      logs.push(`F|${fileName}|${parentInOpticalDiskFileStructure}|${fileFullSourcePath}`)

    }
  } else {
    if (!tree.hasOwnProperty(tokens[index])) {
      tree[tokens[index]] = {}
      // Create directory (only)
      let path_suffix = createPath(tokens, index)
      let target_path = target + path_suffix
      
      const dirName = target_path.slice(1).split('\\').slice(-1)[0]
      const n_tokens = target_path.split('\\').length
      let dirParentInOpticalDiskFileStructure = target_path.split('\\').slice(0, n_tokens - 1).join('\\');
      if(dirParentInOpticalDiskFileStructure == ''){ dirParentInOpticalDiskFileStructure =  '\\' }
      let dirFullSourcePath = source + target_path.slice(1) + "\\";
      /*See comment above*/
      if (!fs.existsSync(dirFullSourcePath)) {
        const configJSON = fs.readFileSync(node_path_module.join(__dirname, `../../appData/config.json`));
        // See the matching comment in the file-path branch above.
        let tempDataDirectoryPath = resolveTempDataDirectoryPath(JSON.parse(configJSON));
        dirFullSourcePath = node_path_module.join(tempDataDirectoryPath, target_path.slice(1));
      }
      logs.push(`D|${dirName}|${dirParentInOpticalDiskFileStructure}|${dirFullSourcePath}`)
      
    }
    let a = tokens[index]
    index += 1
    insertBranch_for_IBB_creation(tree[a], tokens, index, source, target, logs);
  }
}


/*
A .ibb file is produced by ImgBurn in order to specify the files to be written to an optical disk.
This function (createIBB_file) creates such a .ibb  for the files and directories specified in paths: Array<string>.
The important thing is that this way we can burn the optical disk and preserve the local file structure
without resorting to enabling the "preserve full paths" option in ImgBurn. This is because "preserve full paths"
will create a file structure for our optical medium statring with \**\*\backup_dir.
Instead of this we want our file structure inside the optical disk to start (root dir) from backup_dir\.
*/
const createIBB_file = async function(disk_id: number, paths: Array<string>, sourcePath: string, volumeLabel?: string){
  process.env._stop = "noStop";

  let target = "\\"
  if (sourcePath[sourcePath.length - 1] != '\\') { sourcePath += "\\"; }

  let tree = {}

  let logs :Array<string> = [];

  let path: string;
  for (let index = 0; index < paths.length; index++) {
    if(process.env._stop == 'stop'){
      console.log('got stop. Exiting.')
      break;
    }
    path = paths[index];
    let tokens = path.split('\\')
    insertBranch_for_IBB_creation(tree, tokens, 0, sourcePath, target, logs);
    await holdOn();
  }

  const pathTo_IBB_Template = node_path_module.join(__dirname, '../../appData/IBB_TEMPLATE.ibb')

  // The exact text burned onto this disc's UDF volume label. Deliberately just a pass-through here - the
  // caller (backup-to-optical-media.component.ts / add-missing-files-to-optical-media-cold-storage.component.ts)
  // is the one that knows the actual disc numbering convention to use (e.g. offsetting by however many discs
  // already exist in the cold storage when adding to it via a JSON, or omitting the disc number entirely when
  // that count can't be trusted - see those components for the specifics), so it is the one responsible for
  // building the final label text. Only falls back to a bare "Disc N" here as a last-resort safety net, so a
  // disc is never burned with a completely blank volume label if a caller ever fails to pass one.
  const resolvedVolumeLabel = (volumeLabel || '').trim() || ('Disc ' + (disk_id + 1));

  // The .ibb project file is a disposable, one-time-use scratch artifact - like the .partNNN large-file
  // splits, it only needs to exist long enough for ImgBurn to read it once - so it lives in the same
  // ownership-verified temp/cache directory as those splits (see ensureTempDataDirectoryIsAppOwned,
  // IBB_PROJECT_FILE_PATTERN) rather than directly in appData/, where it used to have no cleanup mechanism at
  // all. Computed once here and passed straight into both saveIBB_toDisk (which writes it) and the ImgBurn
  // invocation below (which reads it) - previously these each independently rebuilt the same path via
  // Disk_${disk_id}.ibb, which is exactly the kind of "typed twice, could silently drift" duplication that
  // caused a real bug elsewhere in this app (see WorkerCommunicator's channel-key handling).
  const ownership = await ensureTempDataDirectoryIsAppOwned();
  if (!ownership.ok) {
    console.error('Refusing to create the .ibb file: ' + ownership.message);
    return logs;
  }
  const pathToIBBFile = node_path_module.join(ownership.path, `Disk_${disk_id + 1}.ibb`);

  await saveIBB_toDisk(pathToIBBFile, pathTo_IBB_Template, [
    { regEx: /\[START_BACKUP_LIST\]/g, dataToInsert: ["[START_BACKUP_LIST]"].concat(logs).join('\r\n') },
    { regEx: /VolumeLabel_UDF=/, dataToInsert: 'VolumeLabel_UDF=' + resolvedVolumeLabel }
  ]).then(() => {
      // Now the IBB file has been created. Open ImgBurn using this file as source list.
      const util = require('util');
      const exec = util.promisify(require('child_process').exec);

      async function command() {
        const configJSON = fs.readFileSync(node_path_module.join(__dirname, `../../appData/config.json`));
        const imgBurnExecutablePath = JSON.parse(configJSON).imgBurnExecutablePath;

        const { stdout, stderr } = await exec(`"${imgBurnExecutablePath}" /MODE BUILD /SRC ${pathToIBBFile}`);
        console.log('stdout:', stdout);
        console.log('stderr:', stderr);
      }
      command();

  }).catch(err => {
    console.log(err);
  });

  return logs
}

/** Applies each of `substitutions`, in order, to the .ibb template at `templateFilename`, and writes the
 *  result to `outputPath` (the caller resolves this - see createIBB_file - so there is a single place that
 *  decides where a disc's .ibb file actually lives, rather than this function and its caller each
 *  independently recomputing the same path). Each dataToInsert is run through escapeReplacement first:
 *  String.prototype.replace treats a string replacement specially ($$, $&, $1, ... have their own meaning), so
 *  a literal "$" in dataToInsert (e.g. a file path, or a user-provided collection name) must be doubled to
 *  "$$" or it would otherwise be misinterpreted as one of those replacement patterns instead of inserted
 *  literally. */
async function saveIBB_toDisk(outputPath: string, templateFilename: string, substitutions: Array<{ regEx: RegExp, dataToInsert: string }>){
  let data = fs.readFileSync(templateFilename, { encoding: 'utf16le', flag: 'r' });

  const escapeReplacement = (string: string)=> {
    return string.replace(/\$/g, '$$$$');
  }

  for (const { regEx, dataToInsert } of substitutions) {
    data = data.replace(regEx, escapeReplacement(dataToInsert));
  }
  // Must match the encoding the template was READ with above (utf16le - real .ibb files, including the one
  // ImgBurn itself produced for IBB_TEMPLATE.ibb, are UTF-16LE). Without an explicit encoding here,
  // fs.promises.writeFile defaults a plain string to UTF-8, silently writing every generated .ibb file in a
  // different encoding than its own template (and than ImgBurn's native format) - found for real (2026-08-27)
  // via test-harness/ui/test-backup-to-optical-media.js failing to find [START_BACKUP_LIST]/[END_BACKUP_LIST] in
  // a freshly generated file; reproducing this function's exact read/write sequence standalone confirmed the
  // output came out UTF-8 (with a stray UTF-8 BOM, from the original UTF-16 BOM character being carried through
  // and re-encoded) instead of UTF-16LE.
  return fs.promises.writeFile(outputPath, data, { encoding: 'utf16le' });
}

// Global variables
let logsBuffer : LogsBuffer;
process.env._stop = 'noStop';

const init = function() : void
{  
  logsBuffer = new LogsBuffer();

  ipc.onRequestFromMain((event, arg) => {
    if(!arg){
        console.log("In worker > ipc.onRequestFromMain got null arg.")
    }
    //console.log(JSON.stringify(arg.key));
    //console.log(JSON.stringify(arg))
    switch (arg.key) {
      case 'diff':
        console.log("(worker) in diff")
        diff(arg.params.source, arg.params.target).then((d)=>{
          if(process.env._stop != "stop"){
            ipc.sendResponseToMain({ key: 'diff', res: d, status: "completed" });
          }else{
            ipc.sendResponseToMain({ key: 'diff', res: d, status: "stopped" });
          }
        }).catch((err)=>{
          ipc.sendResponseToMain({ key: 'diff', res: err, status: "error" });
        });
        break;        
      case 'incremental-preview':
        logsBuffer.setChannel("incremental-preview");
        createTree(arg.params.sourceOnlyPaths, /*doCopy=*/false, arg.params.source, arg.params.target).then((res)=>{
          logsBuffer.flush(); // whatever remained in the buffer
          //tell user that the function has finished
          if(process.env._stop != 'stop'){
            //finished completely
            ipc.sendResponseToMain({ key: "incremental-preview", res: null, status: "completed" });
          }else{
            //stopped by the user
            ipc.sendResponseToMain({ key: "incremental-preview", res: null, status: "stopped" });
          }
        }).catch((err)=>{
          ipc.sendResponseToMain({ key: "incremental-preview", res: err, status: "error" });
        });        
        break;
      case 'incremental-copy-files':
        logsBuffer.setChannel("incremental-copy-files");
        createTree(arg.params.sourceOnlyPaths, /*doCopy=*/true, arg.params.source, arg.params.target).then((res) => {
        //dummy_copy().then((res) => {
          logsBuffer.flush(); // whatever remained in the buffer
          //tell user that the function has finished
          if (process.env._stop != 'stop') {
            //finished completely
            ipc.sendResponseToMain({ key: "incremental-copy-files", res: null, status: "completed" });
          } else {
            //stopped by the user
            ipc.sendResponseToMain({ key: "incremental-copy-files", res: null, status: "stopped" });
          }
        }).catch((err)=>{
          ipc.sendResponseToMain({ key: "incremental-copy-files", res: err, status: "error" });
        });
        break;
      case 'stop':
        process.env._stop = "stop";
        console.log("User pressed cancel. Setting process.env._stop = 'stop'.");
        break;
      case 'partition-backup-to-optical-media':
        console.log("(worker) in partition-backup-to-optical-media")
        partitionBackupToOpticalMedia(arg.params.rootPath, arg.params.mediaCapacityInBytes, arg.params.splitLargeFiles, arg.params.filesMetadata).then((d)=>{
          if(process.env._stop != "stop"){
            ipc.sendResponseToMain({ key: 'partition-backup-to-optical-media', res: d, status: "completed" });
          }else{
            ipc.sendResponseToMain({ key: 'partition-backup-to-optical-media', res: d, status: "stopped" });
          }
        }).catch((err)=>{
          ipc.sendResponseToMain({ key: 'partition-backup-to-optical-media', res: err, status: "error" });
        });
        break;
      case 'create-IBB-file':
        console.log("(worker) in create-IBB-file")
        createIBB_file(arg.params.disk_id, arg.params.paths, arg.params.sourcePath, arg.params.volumeLabel).then((d)=>{
          if(process.env._stop != "stop"){
            ipc.sendResponseToMain({ key: 'create-IBB-file', res: d, status: "completed" });
          }else{
            ipc.sendResponseToMain({ key: 'create-IBB-file', res: d, status: "stopped" });
          }
        }).catch((err)=>{
          ipc.sendResponseToMain({ key: 'create-IBB-file', res: err, status: "error" });
        });
        break;
      case 'get-temp-data-directory-path':
        console.log("(worker) in get-temp-data-directory-path")
        getTempDataDirectoryPath().then((d)=>{
          if(process.env._stop != "stop"){
            ipc.sendResponseToMain({ key: 'get-temp-data-directory-path', res: d, status: "completed" });
          }else{
            ipc.sendResponseToMain({ key: 'get-temp-data-directory-path', res: d, status: "stopped" });
          }
        }).catch((err)=>{
          ipc.sendResponseToMain({ key: 'get-temp-data-directory-path', res: err, status: "error" });
        });
        break;
      case 'read-json-from-disk':
        console.log("(worker) in read-json-from-disk")
        readJSONfromDisk(arg.params.path).then((d)=>{
          if(process.env._stop != "stop"){
            ipc.sendResponseToMain({ key: 'read-json-from-disk', res: d, status: "completed" });
          }else{
            ipc.sendResponseToMain({ key: 'read-json-from-disk', res: d, status: "stopped" });
          }
        }).catch((err)=>{
          ipc.sendResponseToMain({ key: 'read-json-from-disk', res: err, status: "error" });
        });
        break;
      case 'write-json-to-disk':
        console.log("(worker) in write-json-to-disk")
        writeJSONtoDisk(arg.params.path, arg.params.json).then((d)=>{
          if(process.env._stop != "stop"){
            ipc.sendResponseToMain({ key: 'write-json-to-disk', res: d, status: "completed" });
          }else{
            ipc.sendResponseToMain({ key: 'write-json-to-disk', res: d, status: "stopped" });
          }
        }).catch((err)=>{
          ipc.sendResponseToMain({ key: 'write-json-to-disk', res: err, status: "error" });
        });
        break;
      case 'get-file-paths-with-stats':
        console.log("(worker) in get-file-paths-with-stats")
        getAllFilePathsWithStats(arg.params.dirPath).then((d)=>{
          if(process.env._stop != "stop"){
            ipc.sendResponseToMain({ key: 'get-file-paths-with-stats', res: d, status: "completed" });
          }else{
            ipc.sendResponseToMain({ key: 'get-file-paths-with-stats', res: d, status: "stopped" });
          }
        }).catch((err)=>{
          ipc.sendResponseToMain({ key: 'get-file-paths-with-stats', res: err, status: "error" });
        });
        break;
      case 'wait-for-optical-disk-to-be-mounted':
        console.log("(worker) in wait-for-optical-disk-to-be-mounted")
        waitForOpticalDiskToBeMounted().then((d)=>{
          if(process.env._stop != "stop"){
            ipc.sendResponseToMain({ key: 'wait-for-optical-disk-to-be-mounted', res: d, status: "completed" });
          }else{
            ipc.sendResponseToMain({ key: 'wait-for-optical-disk-to-be-mounted', res: d, status: "stopped" });
          }
        }).catch((err)=>{
          ipc.sendResponseToMain({ key: 'wait-for-optical-disk-to-be-mounted', res: err, status: "error" });
        });
        break;
        case 'delete-files-and-dirs-for-dir-sync':
          logsBuffer.setChannel('delete-files-and-dirs-for-dir-sync');
          console.log("(worker) in delete-files-and-dirs-for-dir-sync");
          deleteFilesAndDirsForDirSync(arg.params.pathsMarkedForDeletion, arg.params.commit, arg.params.source, arg.params.target).then((d)=>{
            logsBuffer.flush(); // whatever remained in the buffer
            if(process.env._stop != "stop"){
              ipc.sendResponseToMain({ key: 'delete-files-and-dirs-for-dir-sync', res: d, status: "completed" });
            }else{
              ipc.sendResponseToMain({ key: 'delete-files-and-dirs-for-dir-sync', res: d, status: "stopped" });
            }
          }).catch((err)=>{
            console.log("error in delete-files-and-dirs-for-dir-sync")
            ipc.sendResponseToMain({ key: 'delete-files-and-dirs-for-dir-sync', res: err, status: "error" });
          });
          break;
        case 'get-file-paths':
        console.log("(worker) in get-file-paths")
        getAllFiles(arg.params.sourceDir).then((d)=>{
          if(process.env._stop != "stop"){
            ipc.sendResponseToMain({ key: 'get-file-paths', res: d, status: "completed" });
          }else{
            ipc.sendResponseToMain({ key: 'get-file-paths', res: d, status: "stopped" });
          }
        }).catch((err)=>{
          ipc.sendResponseToMain({ key: 'get-file-paths', res: err, status: "error" });
        });
        break;
      case 'merge-file-parts':
        console.log("(worker) in merge-file-parts")
        mergeFileParts(arg.params.partFilePaths, arg.params.originalFileName).then((d)=>{
          // Note: d.merged == false is an expected, "clean" outcome (e.g. corrupted/incomplete partial files) -
          // it is still reported with status "completed", not "error". "error" is reserved for the IPC/worker
          // call itself failing unexpectedly.
          ipc.sendResponseToMain({ key: 'merge-file-parts', res: d, status: "completed" });
        }).catch((err)=>{
          ipc.sendResponseToMain({ key: 'merge-file-parts', res: err, status: "error" });
        });
        break;
      case 'clear-temp-data-directory':
        console.log("(worker) in clear-temp-data-directory")
        clearTempDataDirectory().then((d)=>{
          ipc.sendResponseToMain({ key: 'clear-temp-data-directory', res: d, status: "completed" });
        }).catch((err)=>{
          ipc.sendResponseToMain({ key: 'clear-temp-data-directory', res: err, status: "error" });
        });
        break;
      case 'validate-config-paths':
        console.log("(worker) in validate-config-paths")
        validateConfigPaths().then((d)=>{
          ipc.sendResponseToMain({ key: 'validate-config-paths', res: d, status: "completed" });
        }).catch((err)=>{
          ipc.sendResponseToMain({ key: 'validate-config-paths', res: err, status: "error" });
        });
        break;
      case 'update-config':
        console.log("(worker) in update-config")
        updateConfig(arg.params.updates).then((d)=>{
          ipc.sendResponseToMain({ key: 'update-config', res: d, status: "completed" });
        }).catch((err)=>{
          ipc.sendResponseToMain({ key: 'update-config', res: err, status: "error" });
        });
        break;
      case 'ensure-temp-directory-ownership':
        console.log("(worker) in ensure-temp-directory-ownership")
        ensureTempDataDirectoryIsAppOwned().then((d)=>{
          ipc.sendResponseToMain({ key: 'ensure-temp-directory-ownership', res: d, status: "completed" });
        }).catch((err)=>{
          ipc.sendResponseToMain({ key: 'ensure-temp-directory-ownership', res: err, status: "error" });
        });
        break;
      default:
        ipc.sendResponseToMain({ key: "unknown-channel", res: null, status: "running" });
        break;
    }
  
  });

  /*ipc.onRequestFromMain((event, arg)=>{
    switch (arg.key) {
      case 'stop':
        console.log("RECEIVED STOP !!!!!");
        ipc.sendResponseToMain({ key: 'diff', res: null, status: "running" });
        break;
    }
  })*/
}
init();
