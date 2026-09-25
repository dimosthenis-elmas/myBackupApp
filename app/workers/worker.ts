const electron = require('electron');
const fs = require("fs")
const node_path_module = require("path")
const crypto = require("crypto")
import { WorkerCommunicator as ipc } from './worker-communicator'
import { LogsBuffer } from './logsbuffer'
import { filesMetadata } from '../../src/types/interface';
import { ColdStorageMetadata, WorkerResponse, OpticalMediaPartitioning, DiffComparison, NameClash } from './ipc.interfaces';
import { installConsoleLogging } from '../logging';
import type { Dirent } from 'fs';

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

/** Minimum real time (ms) to let pass between the cooperative yields the scanning loops below take between
 *  items (see holdOnIfDue). Those yields exist so the worker doesn't freeze solid while it works and so a
 *  pending `stop` (the Cancel button) actually gets a chance to be delivered and take effect - that only
 *  requires yielding roughly this often, not after literally every single item. Deliberately biased toward
 *  raw scan throughput over an instantly-reacting Cancel: 150ms means Cancel can take a moment to register
 *  (clearly not "instant", but still short in absolute terms) in exchange for roughly a third as many yields
 *  over a long scan as a tighter interval would take - each one a small but real cost when there can be
 *  hundreds of thousands of them. Note the win shrinks the higher this goes: past a couple hundred ms there
 *  simply aren't many more yields left to remove, so pushing it far higher stops paying for itself. */
const YIELD_INTERVAL_MS = 150;
let lastScanYieldAt = 0;

/** Same purpose as `await holdOn()` on its own (give the event loop a chance to run - in particular, to
 *  deliver a `stop` request from Cancel - between items) but only actually yields once roughly every
 *  YIELD_INTERVAL_MS of wall-clock time, instead of unconditionally after every single item. Cancel stays
 *  just as responsive (still bounded to about YIELD_INTERVAL_MS, same as before), but a scan of a huge tree
 *  full of small/cheap items no longer pays a `setImmediate` round-trip - real, measurable overhead at
 *  hundreds of thousands of items - for every single one of them when it was never buying anything extra. */
const holdOnIfDue = async () => {
  if (Date.now() - lastScanYieldAt >= YIELD_INTERVAL_MS) {
    await holdOn();
    lastScanYieldAt = Date.now();
  }
}

/*print_line(str: string): void {
  process.stdout.clearLine(-1);  // clear current text
  process.stdout.cursorTo(0, 0);  // move cursor to beginning of line
  process.stdout.write(str);  // write text
}*/

/** How often (every Nth item found) the disk-scanning functions below (getAllFiles, getAllFilesSet,
 *  getAllFilePathsWithStats) report their running count via `onProgress` - reported every Nth item rather than
 *  every single one so a huge directory doesn't spam its caller (and, for callers that forward it into
 *  logsBuffer, the IPC channel) with an update per file. None of them know their own real total ahead of time
 *  (discovering it IS the operation) - a caller that wants a real percentage rather than just an open-ended
 *  running count probes it upfront instead, via countAllFilesQuick below. */
const SCAN_PROGRESS_REPORT_INTERVAL = 25;

/** An entry a directory scan left out, and why: one it could not read (a folder Windows denies listing, e.g.
 *  "System Volume Information" at a drive's root), or a link a disc scan cannot back up as a shortcut (see linkAsShortcutEntry). */
type SkippedScanEntry = { path: string, reason: string };

const scanErrorMessage = function (error: any): string {
  return error && error.message ? error.message : String(error);
}

/** Tells the user which entries a scan left out, as a dialog with every left-out path and the reason in a scrollable
 *  list (sent over 'app-error' directly, with a title and the list - console.error's own dialog only has room for a
 *  summary and collapsed technical details), and logs the same list to logs.txt. Only scans that collect such
 *  entries (their `skipped` list) ever get here: unreadable entries a scan was asked to skip, and the rare link a disc
 *  scan cannot back up as a shortcut (linkAsShortcutEntry). Left-out entries are not part of that scan's result, so for a backup source this is
 *  exactly the list of things that will NOT be backed up - which is why it is reported rather than silently
 *  dropped. */
const reportSkippedScanEntries = function (skipped: SkippedScanEntry[]): void {
  if (skipped.length === 0) {
    return;
  }
  const summary = `${skipped.length} item(s) were left out - they are not part of this operation (for a backup: ` +
    `they are NOT backed up). Each one says why.`;
  const items = skipped.map((s) => `${s.path}  -  ${s.reason}`);
  console.warn(summary, items);
  electron.ipcRenderer.send('app-error', {
    source: 'worker', title: 'Some items were left out', summary, details: '',
    lists: [{ label: `Left out (${items.length}):`, items }]
  });
}

/** A disc cannot hold a link (symbolic link or junction), and burning a link's path would burn what it points to -
 *  outside the folder being backed up. So a link is backed up to a disc as a Windows shortcut instead: one small
 *  "<link name>.lnk" file pointing where the link points, and nothing else. Opened from the disc, it says it is
 *  broken unless its target is there; recovered to where its target exists, it opens it. */
const LINK_SHORTCUT_EXTENSION = '.lnk';

/** How big a link's shortcut is assumed to be while planning discs - a real one is 1-2 KB. The shortcut itself is
 *  only created when its disc is sent (createOpticalMediaDiscPartials), so planning needs a safe upper bound. */
const LINK_SHORTCUT_PLANNED_SIZE_BYTES = 64 * 1024;

/** The disc-scan entry for the link at `linkPath` (see LINK_SHORTCUT_EXTENSION): "<link path>.lnk", with the link's
 *  own modified time and `linkTarget` - where it points, as a full path (a relative link is resolved against its own
 *  folder). The link is never followed. Returns null, with the reason recorded in `skipped` when the scan collects
 *  left-out entries (otherwise in logs.txt), when the link cannot be read or a real "<link name>.lnk" already sits
 *  next to it. */
const linkAsShortcutEntry = function (linkPath: string, linkStats: any, skipped?: SkippedScanEntry[]):
  { path: string, stats: { size: number, mtime: Date, isDirectory: boolean, linkTarget: string } } | null {
  const leaveOut = (reason: string) => {
    const entry = { path: node_path_module.normalize(linkPath), reason };
    if (skipped) { skipped.push(entry); } else { console.warn(`Left out a link: ${entry.path}  -  ${entry.reason}`); }
    return null;
  };
  let pointsTo: string;
  try {
    pointsTo = fs.readlinkSync(linkPath);
  } catch (error) {
    return leaveOut(`a link whose target could not be read (${scanErrorMessage(error)})`);
  }
  const shortcutPath = node_path_module.normalize(linkPath) + LINK_SHORTCUT_EXTENSION;
  if (lstatOrNull(shortcutPath) !== null) {
    return leaveOut(`a link to "${pointsTo}" - it is backed up as the shortcut "${node_path_module.basename(shortcutPath)}", ` +
      `but a file with that name is already next to it, so it is not backed up`);
  }
  return {
    path: shortcutPath,
    stats: {
      size: LINK_SHORTCUT_PLANNED_SIZE_BYTES,
      mtime: linkStats.mtime,
      isDirectory: false,
      linkTarget: node_path_module.resolve(node_path_module.dirname(linkPath), pointsTo),
    },
  };
}

/** If `shortcutPath` is the path a disc scan gave a link (see linkAsShortcutEntry) - it ends in ".lnk", nothing is
 *  there, and a link is there without the ".lnk" - returns that link's target (full path) and modified time. */
const linkBehindShortcutPath = function (shortcutPath: string): { target: string, mtime: Date } | null {
  if (!shortcutPath.toLowerCase().endsWith(LINK_SHORTCUT_EXTENSION) || lstatOrNull(shortcutPath) !== null) { return null; }
  const linkPath = shortcutPath.slice(0, -LINK_SHORTCUT_EXTENSION.length);
  const linkStats = lstatOrNull(linkPath);
  if (!linkStats || !linkStats.isSymbolicLink()) { return null; }
  try {
    return { target: node_path_module.resolve(node_path_module.dirname(linkPath), fs.readlinkSync(linkPath)), mtime: linkStats.mtime };
  } catch (error) {
    return null;
  }
}

/** PowerShell script behind createShortcutFiles: Windows' own shortcut object through its Unicode interface
 *  (IShellLinkW) - WScript.Shell's shortcut object refuses paths with characters outside the system code page (e.g.
 *  Greek). Reads its jobs, [{shortcut, target}], from the UTF-8 JSON file named by the SHORTCUT_JOBS variable. */
const CREATE_SHORTCUTS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
[ComImport, Guid("00021401-0000-0000-C000-000000000046")] class CShellLink { }
[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
interface IShellLinkW {
  void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cch, IntPtr pfd, int fFlags);
  void GetIDList(out IntPtr ppidl);
  void SetIDList(IntPtr pidl);
  void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cch);
  void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
  void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cch);
  void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
  void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cch);
  void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
  void GetHotkey(out short pwHotkey);
  void SetHotkey(short wHotkey);
  void GetShowCmd(out int piShowCmd);
  void SetShowCmd(int iShowCmd);
  void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cch, out int piIcon);
  void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
  void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, int dwReserved);
  void Resolve(IntPtr hwnd, int fFlags);
  void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
}
public static class ShortcutMaker {
  public static void Make(string shortcutPath, string targetPath) {
    IShellLinkW link = (IShellLinkW)new CShellLink();
    link.SetPath(targetPath);
    ((IPersistFile)link).Save(shortcutPath, true);
  }
}
'@
$jobs = Get-Content -Raw -Encoding UTF8 -LiteralPath $env:SHORTCUT_JOBS | ConvertFrom-Json
foreach ($j in @($jobs)) { [ShortcutMaker]::Make($j.shortcut, $j.target) }
`;

/** Creates one Windows shortcut (.lnk) per job, pointing to `target` - which does not have to exist (the shortcut
 *  then says it is broken when opened, until something is there) - and gives it `mtime`. One PowerShell process for
 *  all of them. Windows only, like burning a disc with ImgBurn. */
const createShortcutFiles = async function (jobs: Array<{ shortcut: string, target: string, mtime: Date }>): Promise<void> {
  if (jobs.length === 0) { return; }
  if (process.platform !== 'win32') { throw new Error('Links can only be backed up to a disc (as Windows shortcuts) on Windows.'); }
  const jobsDirectory = fs.mkdtempSync(node_path_module.join(require('os').tmpdir(), 'my-backup-shortcuts-'));
  try {
    const jobsFile = node_path_module.join(jobsDirectory, 'jobs.json');
    fs.writeFileSync(jobsFile, JSON.stringify(jobs.map((j) => ({ shortcut: j.shortcut, target: j.target }))), 'utf8');
    const execFile = require('util').promisify(require('child_process').execFile);
    await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', CREATE_SHORTCUTS_SCRIPT],
      { env: { ...process.env, SHORTCUT_JOBS: jobsFile }, windowsHide: true });
  } finally {
    fs.rmSync(jobsDirectory, { recursive: true, force: true });
  }
  for (const job of jobs) {
    if (!fs.existsSync(job.shortcut)) { throw new Error(`The shortcut "${job.shortcut}" for a link could not be created.`); }
    fs.utimesSync(job.shortcut, job.mtime, job.mtime);
  }
}

/** A bare drive ("D:") means "the current directory on drive D", not its root - so a scan starting there would
 *  list whatever directory the app last used on that drive. Gives it its root's backslash; anything else is
 *  returned unchanged (so this is a no-op for every path that isn't a bare Windows drive). */
const asScanRoot = function (dirPath: string): string {
  return /^[A-Za-z]:$/.test(dirPath) ? dirPath + '\\' : dirPath;
}

/** `dirPath` without a trailing backslash - except for a drive root ("D:\"), where that backslash is what makes
 *  it a root rather than "the current directory on drive D". */
const trimTrailingBackslash = function (dirPath: string): string {
  return (dirPath.endsWith('\\') && !/^[A-Za-z]:\\$/.test(dirPath)) ? dirPath.slice(0, -1) : dirPath;
}

/** `dirPath` ending in exactly one backslash - the prefix to strip off the front of the paths found under it. */
const asPathPrefix = function (dirPath: string): string {
  return dirPath.endsWith('\\') ? dirPath : dirPath + '\\';
}

/** Quick recursive file count for `dirPath`, used as a fast upfront "probe" so a caller driving a progress bar
 *  off of getAllFiles/getAllFilesSet/getAllFilePathsWithStats's `onProgress` (see SCAN_PROGRESS_REPORT_INTERVAL
 *  above) can report a real "(i of N)" percentage - see parseScanItemsProgress, shared/utils - instead of just
 *  an open-ended running count. Uses `withFileTypes` (a Dirent already knows whether an entry is a directory,
 *  without a separate stat() syscall) rather than those functions' own stat-per-entry traversal, so this probe
 *  pass is meaningfully cheaper than the real scan that follows it - still a full tree walk, just a lighter one.
 *  A link (symbolic link or junction) counts as one item and is never looked inside, the way every scan treats it
 *  (see statEntryOrSkip) - a Dirent's isDirectory() is false for a link. Doesn't need to match those functions'
 *  exact final count otherwise (it's only ever used as a percentage denominator, and every caller forces its bar
 *  to the real 100%/next-phase boundary once its own real scan actually finishes, regardless of what this probe
 *  predicted) - so small mismatches (a file deleted between the probe and the real scan, a permission error
 *  skipped one way but not the other, getAllFilePathsWithStats leaving links out) are harmless. */
const countAllFilesQuick = async function (dirPath: string): Promise<number> {
  let entries: Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return 1; // unreadable - treated the same as the "no entries" case below.
  }
  if (entries.length === 0) { return 1; } // matches getAllFiles' own "empty directory counts as one item".
  let count = 0;
  for (const entry of entries) {
    if (process.env._stop == 'stop') { break; }
    count += entry.isDirectory() ? await countAllFilesQuick(node_path_module.join(dirPath, entry.name)) : 1;
    await holdOnIfDue();
  }
  return count;
}

/** fs.lstatSync for one entry found while scanning: a link (symbolic link or junction) is described as itself -
 *  one entry, never followed, so a scan never lists anything outside the folder it was given. When `skipped` is
 *  given, an entry that cannot be stat'ed (access denied) is recorded there and null is returned so the scan
 *  carries on without it; without `skipped` the error is thrown, as scans always did. */
const statEntryOrSkip = function (entryPath: string, skipped?: SkippedScanEntry[]): any | null {
  try {
    return fs.lstatSync(entryPath);
  } catch (error) {
    if (!skipped) { throw error; }
    skipped.push({ path: node_path_module.normalize(entryPath), reason: scanErrorMessage(error) });
    return null;
  }
}

/** Runs `scan` (the recursive call for one subdirectory) and returns its result. When `skipped` is given and that
 *  directory cannot be listed (access denied - a subdirectory's own entries are already handled by its own
 *  scan), it is recorded there and `resultIfSkipped` (the caller's unchanged accumulator) is returned instead of
 *  failing the whole scan; without `skipped` the error is thrown. */
const scanSubdirectoryOrSkip = async function <T>(subdirectoryPath: string, skipped: SkippedScanEntry[] | undefined, scan: () => Promise<T>, resultIfSkipped: T): Promise<T> {
  try {
    return await scan();
  } catch (error) {
    if (!skipped) { throw error; }
    skipped.push({ path: node_path_module.normalize(subdirectoryPath), reason: scanErrorMessage(error) });
    return resultIfSkipped;
  }
}

/** @return an array that contains the absolute paths of all files in "dirPath" (in a recursive fashion).
 *  It also takes into account empty directories.
 * @param dirPath the directory for which you want to list the files.
 * @param arrayOfFiles <empty> (used internally for recursion)
 * @param onProgress optional - called with the running total of items found so far, every
 *  SCAN_PROGRESS_REPORT_INTERVAL items (see its own doc comment). Left undefined, every existing caller behaves
 *  exactly as before.
 * @param skipped optional - when given, an entry below `dirPath` that cannot be read (see statEntryOrSkip and the
 *  recursive readdir below) is recorded here and left out instead of failing the whole scan; `dirPath` itself
 *  must still be readable. Left undefined, the first unreadable entry throws, as it always did.
 *  A link (symbolic link or junction) below `dirPath` is listed as one entry, like a file, and never looked inside
 *  - so nothing outside `dirPath` is listed. */
const getAllFiles = async function (dirPath: string, arrayOfFiles: Array<string> = [], onProgress?: (itemsFoundSoFar: number) => void, skipped?: SkippedScanEntry[]): Promise<string[]> {
  let files: Array<string> = fs.readdirSync(dirPath)

  arrayOfFiles = arrayOfFiles || []

  if (files.length > 0) {
    let file: string;
    for (let i = 0; i < files.length; i++) {
      if(process.env._stop == 'stop'){break;}
      file = files[i];
      const entryStats = statEntryOrSkip(dirPath + "/" + file, skipped);
      if (entryStats === null) {
        await holdOnIfDue();
        continue;
      }
      if (entryStats.isDirectory()) {
        arrayOfFiles = await scanSubdirectoryOrSkip(dirPath + "/" + file, skipped, () => getAllFiles(dirPath + "/" + file, arrayOfFiles, onProgress, skipped), arrayOfFiles)
      } else {
        arrayOfFiles.push(node_path_module.join(dirPath, "/", file))
        //print_line(arrayOfFiles.length + "")
        if (onProgress && arrayOfFiles.length % SCAN_PROGRESS_REPORT_INTERVAL === 0) { onProgress(arrayOfFiles.length); }
      }
      await holdOnIfDue();
    }
  } else {
    arrayOfFiles.push(node_path_module.join(dirPath, "/"))
    //print_line(arrayOfFiles.length + "")
  }

  return arrayOfFiles
}


/** Size (in MiB) of each partial 7-Zip splits a too-large-for-one-disc file into (see the `-v${...}m` call in
 *  partitionBackupToOpticalMedia). Chosen manually, once, to comfortably fit on a CD (~700MB - the
 *  lowest-capacity medium in optical_media_choices, backup-to-optical-media.component.ts) regardless of which
 *  medium the user actually selects for a given backup, since a split partial is treated as just another file
 *  when packing discs and could end up on any of them. Deliberately NOT computed from the CD capacity constant
 *  or checked against it at runtime - if you ever change this number (or add a smaller supported medium),
 *  you must manually re-confirm it still leaves comfortable headroom under the smallest medium's capacity. */
const LARGE_FILE_SPLIT_VOLUME_SIZE_MIB = 500;

/** Zero-pads to 7-Zip's own observed volume-suffix width (".part.001", ".002", ...) - shared by the planning
 *  estimate below and the real creation step (createOpticalMediaDiscPartials), so both agree on the
 *  exact predicted/real filename for a given partial. */
const zeroPad = (num: number, places: number) => String(num).padStart(places, '0');

/** Pure-arithmetic prediction of how many partials the real `-v${LARGE_FILE_SPLIT_VOLUME_SIZE_MIB}m -mx0 a` split
 *  will produce for a file of `fileSizeBytes`, and each partial's size - WITHOUT ever invoking 7-Zip. Used by
 *  partitionBackupToOpticalMedia for planning (so an entire multi-disc job's worth of large files no longer has
 *  to be physically split, all at once, before a single disc is even burned) and by
 *  createOpticalMediaDiscPartials to sanity-check a real split's result against what was planned.
 *
 *  Deliberately does NOT try to account for 7-Zip's own archive-format overhead (the header/footer/CRC bytes a
 *  single-file store-mode archive always carries) with any padding constant - that overhead is an internal
 *  implementation detail of whatever 7-Zip build happens to be installed, not something this app should assume
 *  a specific value for. Confirmed empirically against real 7z runs: every partial except the last is always
 *  exactly volumeSizeBytes; the last partial is `fileSizeBytes % volumeSizeBytes`, which can be 0 - a real split
 *  ALWAYS produces one more partial than a plain fileSizeBytes/volumeSizeBytes division would suggest, even when
 *  the remainder is exactly zero, because the archive's own overhead has to live somewhere and 7-Zip never lets
 *  a non-last volume exceed the requested size to make room for it.
 *
 *  This CAN rarely undercount by exactly one partial: when fileSizeBytes % volumeSizeBytes lands within that same
 *  small, unknown overhead of volumeSizeBytes itself, the overhead tips what "should" have been the last partial
 *  over the volume cap, forcing a real extra partial this formula does not predict. That is by design, not a bug
 *  to be papered over with a guessed safety margin - createOpticalMediaDiscPartials is responsible for
 *  reconciling this the one time it's actually observed to happen, against the real, measured result, rather
 *  than this function trying to guess around a number it cannot know in advance. */
const estimateLargeFileSplitPartials = function (fileSizeBytes: number): Array<{ size: number }> {
  const volumeSizeBytes = LARGE_FILE_SPLIT_VOLUME_SIZE_MIB * 1024 * 1024;
  const partialCount = Math.floor(fileSizeBytes / volumeSizeBytes) + 1;
  const partials: Array<{ size: number }> = [];
  for (let i = 1; i <= partialCount; i++) {
    partials.push({ size: i < partialCount ? volumeSizeBytes : (fileSizeBytes - (partialCount - 1) * volumeSizeBytes) });
  }
  return partials;
}

const CONFIG_PATH = () => node_path_module.join(__dirname, `../../appData/config.json`);

/** The app's appData/ directory, resolved to an absolute path. Relative cacheDataDirectoryPath values are
 *  resolved against this - see resolveTempDataDirectoryPath below. */
const APP_DATA_DIRECTORY_PATH = () => node_path_module.resolve(__dirname, '../../appData');

// ============================================================================
// ===== Logging: every console.log/warn/error in this file is appended to the
// ===== same logs.txt main.ts writes to (see logging.ts and that file's own
// ===== comment), via the same appData path resolution this file already uses
// ===== for config.json. This is the worker's half of the reason its window can
// ===== be hidden in a packaged build (see main.ts's winWorker creation)
// ===== without losing anything that used to only be visible in its DevTools
// ===== console. console.error additionally reports a plain-language summary
// ===== to main over 'app-error' below to show as a dialog - full technical
// ===== detail (stack traces, raw dumps) stays in logs.txt and the dialog's
// ===== collapsed "technical details" section, never the primary message.
// ============================================================================

const LOG_FILE_PATH = node_path_module.join(APP_DATA_DIRECTORY_PATH(), 'logs.txt');

// error vs warn is a real severity call at each call site, not just style - see main.ts's identical comment on
// its own copy of this: console.error also interrupts the user with a dialog, console.warn only logs.
installConsoleLogging('worker', LOG_FILE_PATH, 'Something unexpected went wrong in the background service.', (reported) => {
  // A dedicated 'app-error' channel, not ipc.sendResponseToMain/'response-to-main' - see main.ts's
  // ipcMain.on('app-error') for why reusing the request/response channel here would corrupt whatever real
  // request happens to be in flight at the time.
  electron.ipcRenderer.send('app-error', { source: 'worker', ...reported });
});

// Belt-and-suspenders for errors nobody wrote a try/catch for at all - see main.ts's identical pair of handlers
// for the equivalent main-process case.
const UNCAUGHT_WORKER_ERROR_SUMMARY = 'Something unexpected went wrong in the background service and the app may need to be restarted.';

process.on('uncaughtException', (error) => {
  console.error(UNCAUGHT_WORKER_ERROR_SUMMARY, error);
});

process.on('unhandledRejection', (reason) => {
  console.error(UNCAUGHT_WORKER_ERROR_SUMMARY, reason);
});

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
 *  optical-disc-backup-data-retriever.component.ts, and clearTempDataDirectoryOnStartup in
 *  app.component.ts). */
const PART_FILE_PATTERN = /\.part\.\d+$/i;

/** Matches this app's own .ibb project files (e.g. "Disk_1.ibb" - see createIBB_file/saveIBB_toDisk), the
 *  other kind of disposable, one-time-use scratch file clearTempDataDirectory is willing to delete. Deliberately
 *  narrow (the exact "Disk_<digits>.ibb" name this app itself writes) rather than matching any ".ibb" file, so
 *  this can never end up recognizing something unrelated that merely happens to share the extension. */
const IBB_PROJECT_FILE_PATTERN = /^Disk_\d+\.ibb$/i;

/** Matches this app's own per-job temp session folders (e.g. "session-1788672345678"). Every "Backup to optical
 *  media"/"Add missing files to cold storage" job generates exactly one of these (see backup-to-optical-
 *  media.component.ts / add-missing-files-to-optical-media-cold-storage.component.ts) the first time it plans a
 *  split, and reuses it consistently for every disc sent during that same job - so a job's real split partials
 *  and .ibb files always live under tempDataDirectory/session-<id>/, never directly under tempDataDirectory/
 *  itself. This is what makes two different jobs' temp content fully isolated from each other: since a session
 *  ID is only ever generated when a NEW job starts, and a job cannot span an app restart (no resume support -
 *  see confirmedDiscs in backup-to-optical-media.component.ts), ANY session folder still present the next time
 *  the app launches is unambiguously left over from a dead job - no content inspection needed to know it is
 *  safe to remove (see checkTempDataDirectoryForLeftovers). */
const SESSION_FOLDER_NAME_PATTERN = /^session-\d+$/;

/** Validates a session ID received over IPC (ultimately renderer-controlled) actually matches
 *  SESSION_FOLDER_NAME_PATTERN before it is ever used to build a filesystem path - defense in depth against a
 *  malformed or crafted value (e.g. containing "..") being joined into a real path and escaping the temp
 *  directory, the same reasoning isPathStrictlyInside exists for elsewhere in this file. Every function that
 *  takes a sessionId parameter calls this before using it. */
const assertValidSessionId = function (sessionId: string): void {
  if (typeof sessionId !== 'string' || !SESSION_FOLDER_NAME_PATTERN.test(sessionId)) {
    throw new Error(`Invalid temp session id: "${sessionId}" (expected something matching ${SESSION_FOLDER_NAME_PATTERN}).`);
  }
}

/** True if `entryPath` is safe for clearTempDataDirectory to delete, given ownership of its containing temp
 *  directory has already been established (ensureTempDataDirectoryIsAppOwned): a symlink/junction (always
 *  safe - deleting it only ever removes the link entry itself, never follows it into whatever it points to);
 *  a file whose name matches PART_FILE_PATTERN or IBB_PROJECT_FILE_PATTERN, or a shortcut (".lnk" - how a link is
 *  burned, see LINK_SHORTCUT_EXTENSION); or a directory all of whose contents, recursively, are themselves safe
 *  by this same rule.
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
  return PART_FILE_PATTERN.test(baseName) || IBB_PROJECT_FILE_PATTERN.test(baseName)
    || baseName.toLowerCase().endsWith(LINK_SHORTCUT_EXTENSION);
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
 *  happens to share the marker's name (e.g. manually copied over from a different temp directory) would
 *  otherwise be trusted as proof of ownership even though it does not actually correspond to this directory.
 *  A marker whose recorded path is stale because the whole app folder was copied or moved is handled
 *  separately - see adoptRelocatedTempDirectory. */
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

/** The path recorded inside `tempDataDirectoryPath`'s ownership marker, or null if there is no usable marker
 *  (missing, a symlink/junction, unparseable, or not in the shape buildOwnershipMarkerContent writes). */
const readOwnershipMarkerRecordedPath = function (tempDataDirectoryPath: string): string | null {
  const markerPath = node_path_module.join(tempDataDirectoryPath, CACHE_DIRECTORY_OWNERSHIP_MARKER_FILENAME);
  try {
    if (fs.lstatSync(markerPath).isSymbolicLink()) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    return (parsed && typeof parsed.resolvedPath === 'string') ? parsed.resolvedPath : null;
  } catch (error) {
    return null;
  }
}

/** Handles a temp directory whose ownership marker is genuine but records a different absolute path than the
 *  directory now resolves to - what happens when the whole app folder is copied or moved after it has run once,
 *  since the temp directory (by default appData\tempFilesCanBeDeleted) travels along with it. The app has to keep
 *  working wherever its folder ends up, so rather than treating that as "not created by this app" it re-registers
 *  the directory at its new location - but ONLY if everything in it is recognizably this app's own scratch output
 *  (isRecognizedTempContent, and no symlinks at the top level), so a marker that was merely copied into a
 *  directory holding real content still fails the ownership check. Returns true (after rewriting the marker with
 *  the current path) if the directory was adopted, false if it must be refused. */
const adoptRelocatedTempDirectory = function (tempDataDirectoryPath: string): boolean {
  if (readOwnershipMarkerRecordedPath(tempDataDirectoryPath) === null) {
    return false;
  }
  let entries: Dirent[];
  try {
    entries = fs.readdirSync(tempDataDirectoryPath, { withFileTypes: true });
  } catch (error) {
    return false;
  }
  const onlyContainsThisAppsOwnContent = entries
    .filter((e: Dirent) => e.name !== CACHE_DIRECTORY_OWNERSHIP_MARKER_FILENAME)
    .every((e: Dirent) => !e.isSymbolicLink() && isRecognizedTempContent(node_path_module.join(tempDataDirectoryPath, e.name), false));
  if (!onlyContainsThisAppsOwnContent) {
    return false;
  }
  try {
    fs.writeFileSync(
      node_path_module.join(tempDataDirectoryPath, CACHE_DIRECTORY_OWNERSHIP_MARKER_FILENAME),
      buildOwnershipMarkerContent(tempDataDirectoryPath)
    );
  } catch (error) {
    return false;
  }
  return true;
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
 *  - Directory exists with a marker that records a different path (the app folder was copied or moved): adopted
 *    - the marker is rewritten with the current path - if everything in it is recognizably this app's own
 *    scratch output; otherwise refused like the next case (see adoptRelocatedTempDirectory).
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

  if (!verifyOwnershipMarker(tempDataDirectoryPath) && !adoptRelocatedTempDirectory(tempDataDirectoryPath)) {
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

/** The one place in the app that defines the default burn-safety margin (see
 *  getEffectiveOpticalMediumCapacityInBytes below) - both DEFAULT_CONFIG_FIELDS' backfill-on-write value and
 *  getEffectiveOpticalMediumCapacityInBytes' own runtime fallback (used whenever config.json doesn't have, or
 *  has an invalid, maxOpticalMediumRepletionRatio) read from this single constant, so changing the app's
 *  default ratio never requires touching more than this one line - config.json itself no longer needs to carry
 *  this value at all unless someone deliberately wants to override it for their own install. */
const DEFAULT_MAX_OPTICAL_MEDIUM_REPLETION_RATIO = 0.99;

/** Baseline values for the non-executable config.json fields the rest of the app assumes are present. Used by
 *  updateConfig below to backfill anything not already in the file, so that writing just the two executable
 *  paths (e.g. from the setup dialog) never leaves the rest of the file incomplete - notably when config.json
 *  did not exist at all before that write.
 *  Deliberately excludes the two REQUIRED_CONFIG_EXECUTABLE_PATHS fields - defaulting those to a guessed
 *  install path would silently defeat the setup dialog's entire point of getting the user to confirm them. */
const DEFAULT_CONFIG_FIELDS: { [key: string]: any } = {
  maxOpticalMediumRepletionRatio: DEFAULT_MAX_OPTICAL_MEDIUM_REPLETION_RATIO,
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

/** Applies config.json's maxOpticalMediumRepletionRatio to a medium's rated capacity, so a disc is never
 *  planned to be filled all the way to its rated capacity. This is a general burn-safety margin - it exists
 *  because packing right up to a medium's rated capacity is riskier in general (filesystem/UDF overhead,
 *  media-to-media variance in actually-writable capacity, etc.), not because of any one particular feature.
 *  In particular, this margin is NOT specifically reserved for or "spent by" large-file-split-partial surplus
 *  slivers (see estimateLargeFileSplitPartials/createOpticalMediaDiscPartials) - callers reasoning about
 *  whether something fits on a disc, including a surplus sliver, must always compare against this effective
 *  capacity, never the medium's raw rated capacity, exactly like any other content being packed onto a disc.
 *  Falls back to DEFAULT_MAX_OPTICAL_MEDIUM_REPLETION_RATIO if config.json doesn't have a valid (numeric)
 *  maxOpticalMediumRepletionRatio of its own. Clamped to a hard maximum of 0.99 regardless of what's
 *  configured, so a config value close to or at 1.0 can never remove this margin entirely. */
const getEffectiveOpticalMediumCapacityInBytes = async function (rawCapacityInBytes: number): Promise<number> {
  const parsedConfig = await readConfig();
  const configuredRatio = parsedConfig.maxOpticalMediumRepletionRatio;
  const ratio = typeof configuredRatio === 'number' ? configuredRatio : DEFAULT_MAX_OPTICAL_MEDIUM_REPLETION_RATIO;
  return rawCapacityInBytes * Math.min(ratio, 0.99);
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
 *  `message` - the caller uses this to show the user exactly what was deleted, not just a count. `cleared` is
 *  true only when EVERY clearable entry was actually removed - the caller only shows `message` in a dialog when
 *  `cleared` is false, so a partial run (some entries deleted, others skipped or failed) must also report
 *  `cleared: false`, or its `message` (a summary) would never reach the user. `notClearedItems` lists every entry
 *  that was not cleared, one "<full path>  -  <reason>" line each, for the caller to show as a scrollable list. */
const clearTempDataDirectory = async function (): Promise<{ cleared: boolean, message: string, deletedItems: string[], notClearedItems: string[] }> {
  const ownership = await ensureTempDataDirectoryIsAppOwned();
  if (!ownership.ok) {
    return { cleared: false, message: 'Refusing to clear: ' + ownership.message, deletedItems: [], notClearedItems: [] };
  }
  const tempDataDirectoryPath = ownership.path;

  if (!fs.existsSync(tempDataDirectoryPath)) {
    return { cleared: true, message: 'The temp directory did not exist; nothing to clear.', deletedItems: [], notClearedItems: [] };
  }

  let realTempDataDirectoryPath: string;
  try {
    realTempDataDirectoryPath = fs.realpathSync(tempDataDirectoryPath);
  } catch (error) {
    return { cleared: false, message: 'Failed to resolve the real path of the temp directory: ' + (error && (error as any).message ? (error as any).message : String(error)), deletedItems: [], notClearedItems: [] };
  }

  let entries: Array<{ name: string, isSymbolicLink: () => boolean }>;
  try {
    entries = fs.readdirSync(tempDataDirectoryPath, { withFileTypes: true });
  } catch (error) {
    return { cleared: false, message: 'Failed to list the contents of the temp directory: ' + (error && (error as any).message ? (error as any).message : String(error)), deletedItems: [], notClearedItems: [] };
  }

  // Excludes the ownership marker file, which is always present once the directory has been used and is
  // never a candidate for deletion - counting it would make an otherwise fully-cleared directory misleadingly
  // report e.g. "cleared 3 of 4 items" instead of "cleared".
  const clearableEntryCount = entries.filter(e => e.name !== CACHE_DIRECTORY_OWNERSHIP_MARKER_FILENAME).length;

  let deletedCount = 0;
  // Names of the entries actually removed below, in the order they were removed - reported back to the caller
  // so it can show the user exactly what was deleted (as opposed to `message`, which is just a summary).
  const deletedItems: string[] = [];
  // One "<full path>  -  <reason>" line per entry that did NOT end up cleared (skipped for safety, or an actual
  // delete failure) - returned as notClearedItems so the caller's dialog can list exactly what didn't clear and
  // why, not just report a bare count.
  const notClearedItems: string[] = [];

  for (const entry of entries) {
    if (entry.name === CACHE_DIRECTORY_OWNERSHIP_MARKER_FILENAME) {
      // Never delete the ownership marker - see its doc comment. Not counted as uncleared: leaving it in
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
          notClearedItems.push(`${entryPath}  -  skipped: it does not resolve to a location inside the temp directory`);
          continue;
        }
      } catch (error) {
        notClearedItems.push(`${entryPath}  -  skipped: could not resolve its real path (${error && (error as any).message ? (error as any).message : String(error)})`);
        continue;
      }
    }
    // If entry.isSymbolicLink(), it is deleted as-is below without following it - removing a symlink/junction
    // entry never touches whatever it points to, regardless of the `recursive` option.

    if (!isRecognizedTempContent(entryPath, entry.isSymbolicLink())) {
      notClearedItems.push(`${entryPath}  -  skipped: it does not look like this app's own temp/cache content`);
      continue;
    }

    try {
      fs.rmSync(entryPath, { recursive: true, force: true });
      deletedCount++;
      deletedItems.push(entry.name);
    } catch (error) {
      notClearedItems.push(`${entryPath}  -  could not be deleted: ${error && (error as any).message ? (error as any).message : String(error)}`);
    }
  }

  if (notClearedItems.length === 0) {
    return {
      cleared: true,
      message: clearableEntryCount === 0 ? 'The temp directory was already empty.' : `The temp directory has been cleared (${deletedCount} item(s) removed).`,
      deletedItems,
      notClearedItems
    };
  }
  // Some entries were skipped or failed to delete: `cleared: false` even though deletedCount may be > 0 - this
  // is what a partial run has to report for the caller's dialog (which only shows `message` when `cleared` is
  // false) to actually surface which entries didn't clear and why, instead of that detail being silently lost.
  return {
    cleared: false,
    message: `Cleared ${deletedCount} of ${clearableEntryCount} item(s) from the temp directory. The ones listed below were ` +
      `not cleared (only .partNNN split files, .ibb project files, and folders containing only such files are ever deleted).`,
    deletedItems,
    notClearedItems
  };
}

/** Reports whether the temp directory currently has anything worth telling the user about at startup, and if
 *  so, what - used by app.component.ts to decide whether to show its startup snackbar at all (never shown when
 *  this reports nothing).
 *
 *  Only looks at DIRECT children of the temp directory, not a deep recursive walk: with per-job session
 *  subfolders (see SESSION_FOLDER_NAME_PATTERN's own comment), every real leftover is either one of those
 *  folders, or - for an install upgraded from before this feature existed - a stray loose .part.NNN/.ibb file
 *  sitting directly at the root from an older version of this app. Either way, a session folder existing at
 *  startup is unambiguously left over from a dead job (a job cannot span an app restart - no resume support),
 *  so no content inspection is needed to know it's safe to offer clearing; this still runs entries through
 *  isRecognizedTempContent before counting them, the same as clearTempDataDirectory itself, so anything
 *  unrecognized is silently left out of the count/list rather than alarming the user about it. */
const checkTempDataDirectoryForLeftovers = async function (): Promise<{ path: string, hasLeftovers: boolean, entryNames: string[] }> {
  const ownership = await ensureTempDataDirectoryIsAppOwned();
  if (!ownership.ok) {
    throw new Error(ownership.message);
  }
  const tempDataDirectoryPath = ownership.path;

  if (!fs.existsSync(tempDataDirectoryPath)) {
    return { path: tempDataDirectoryPath, hasLeftovers: false, entryNames: [] };
  }

  const entries: Dirent[] = fs.readdirSync(tempDataDirectoryPath, { withFileTypes: true });
  const entryNames = entries
    .filter((e: Dirent) => e.name !== CACHE_DIRECTORY_OWNERSHIP_MARKER_FILENAME)
    .filter((e: Dirent) => isRecognizedTempContent(node_path_module.join(tempDataDirectoryPath, e.name), e.isSymbolicLink()))
    .map((e: Dirent) => e.name);

  return { path: tempDataDirectoryPath, hasLeftovers: entryNames.length > 0, entryNames };
}

/** V8 (the JS engine behind this app's Electron/Node) caps how long a single string can be - on this app's
 *  bundled version that ceiling is around 512 MiB of decoded text. A JSON file bigger than that would fail
 *  reading it with a cryptic low-level "Invalid string length" the moment its bytes are decoded to text, deep
 *  inside fs.readFileSync/JSON.parse, regardless of how much RAM or disk space is actually available. Checked
 *  up front, against the file's raw byte size, so a JSON that is genuinely too large to open at all fails with
 *  one clear, actionable message instead. 400 MiB (comfortably under the ~512 MiB ceiling) rather than cutting
 *  it as close as possible: UTF-8 text can decode to more UTF-16 code units than input bytes when it contains
 *  non-ASCII characters (e.g. file paths with accented/non-Latin characters), and this margin absorbs that. */
const MAX_READABLE_JSON_FILE_SIZE_BYTES = 400 * 1024 * 1024;

const readJSONfromDisk = async function(path: string): Promise<Object> {
  const sizeInBytes = fs.statSync(path).size;
  if (sizeInBytes > MAX_READABLE_JSON_FILE_SIZE_BYTES) {
    const sizeInMiB = (sizeInBytes / (1024 * 1024)).toFixed(0);
    const limitInMiB = MAX_READABLE_JSON_FILE_SIZE_BYTES / (1024 * 1024);
    throw new Error(
      `This JSON file is ${sizeInMiB} MB, which is too large for this app to open (the limit is ${limitInMiB} MB - ` +
      `a fundamental Node.js/V8 limitation on how long a single piece of text can be, not a disk space or app ` +
      `setting).`
    );
  }
  // Read directly as a string (rather than a Buffer later coerced to one) - one string allocation instead of a
  // Buffer plus a separate string built from it.
  const file = fs.readFileSync(path, 'utf8');
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
 * This is the scan behind every disc: planning a backup to optical media, the source scan of "Add missing files",
 * and reading a disc back. A link (symbolic link or junction) is never followed: a disc cannot hold a link, and what
 * one points to is outside the folder being backed up - so it is listed as the Windows shortcut it will be burned
 * as, "<link path>.lnk", with `linkTarget` (see linkAsShortcutEntry).
 * @param dirPath the directory for which you want to list the files.
 * @param arrayOfFiles <empty> (used internally for recursion)
 * @param skipped optional - see the identical parameter of getAllFiles. A link that cannot be backed up as a shortcut is recorded here too. */
const getAllFilePathsWithStats = async function (
  dirPath: string,
  arrayOfFiles: Array<{"path": string, "stats": {"size": number, "mtime": Date, "isDirectory": boolean, "linkTarget"?: string}}> = [],
  onProgress?: (itemsFoundSoFar: number) => void,
  skipped?: SkippedScanEntry[]
): Promise<Array<{"path": string, "stats": {"size": number, "mtime": Date, "isDirectory": boolean, "linkTarget"?: string}}>> {

  // This resets the stop signal in case the user canceled the operation previously.
  process.env._stop = 'NoStop'
  let files: Array<string> = fs.readdirSync(dirPath)

  arrayOfFiles = arrayOfFiles || []

  if (files.length > 0) {
    let file: string;
    for (let i = 0; i < files.length; i++) {
      if(process.env._stop == 'stop'){break;}
      file = files[i];
      // One statSync call, reused for isDirectory/size/mtime below - this used to be 4 separate statSync calls
      // on the exact same path (one per property read, plus the isDirectory check above), each a real syscall
      // re-fetching data the first call already had.
      const entryStats = statEntryOrSkip(dirPath + "/" + file, skipped);
      if (entryStats === null) {
        await holdOnIfDue();
        continue;
      }
      if (entryStats.isSymbolicLink()) {
        const shortcutEntry = linkAsShortcutEntry(node_path_module.join(dirPath, "/", file), entryStats, skipped);
        if (shortcutEntry) {
          arrayOfFiles.push(shortcutEntry);
          if (onProgress && arrayOfFiles.length % SCAN_PROGRESS_REPORT_INTERVAL === 0) { onProgress(arrayOfFiles.length); }
        }
      } else if (entryStats.isDirectory()) {
        arrayOfFiles = await scanSubdirectoryOrSkip(dirPath + "/" + file, skipped, () => getAllFilePathsWithStats(dirPath + "/" + file, arrayOfFiles, onProgress, skipped), arrayOfFiles)
      } else {
        arrayOfFiles.push({"path": node_path_module.join(dirPath, "/", file), "stats": {
          "size": entryStats.size,
          "mtime": entryStats.mtime,
          "isDirectory": entryStats.isDirectory()
        }})
        if (onProgress && arrayOfFiles.length % SCAN_PROGRESS_REPORT_INTERVAL === 0) { onProgress(arrayOfFiles.length); }
      }
      await holdOnIfDue();
    }
  } else {
    // Empty directory. fs.statSync on the directory itself (not statEntryOrSkip's lstat): this is the folder being
    // listed, which is only ever a link when it is the folder the scan was started on - and then it is followed.
    let dirStats: any = null;
    try {
      dirStats = fs.statSync(dirPath);
    } catch (error) {
      if (!skipped) { throw error; }
      skipped.push({ path: node_path_module.normalize(dirPath), reason: scanErrorMessage(error) });
    }
    if (dirStats !== null) {
      arrayOfFiles.push({"path": node_path_module.join(dirPath, "/"), "stats": {
            "size": dirStats.size,
            "mtime": dirStats.mtime,
            "isDirectory": dirStats.isDirectory()
          }})
    }
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
      // deleting something we should not have, so this does not count as a failed merge - console.warn (logged,
      // not dialog'd) rather than console.error accordingly. See src/main.ts's console.error wrapper for why
      // that distinction matters here: every console.error anywhere in the app now also interrupts the user
      // with a dialog, so the log level here is a real severity decision, not just cosmetic.
      console.warn('Failed to delete partial file after a successful merge: ' + partPath, error);
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
// `sessionId` (see SESSION_FOLDER_NAME_PATTERN's own comment) is only actually used when splitLargeFiles is
// true (to predict split-partial paths under this job's own session subfolder) - still required either way, so
// the same one value the caller generated for this job is always available regardless of which of the two
// planning calls a wizard's own retry-without-then-with-splitting flow ends up needing it for.
/** @param onProgress optional - reports this call's progress as plain text lines, same "(i of N)" convention as
 *  diff's own two phases (see parseProgressFromLine/parseScanItemsProgress, shared/utils): a real percentage for
 *  the upfront directory scan (via countAllFilesQuick's probe - "Scanning items (i of N)"), then one for the
 *  bin-packing loop below (a known total by then - "Packing items (i of N)", see parsePackingProgress) once per
 *  disc it fills (not per file - packing potentially hundreds of thousands of files into a couple dozen discs
 *  is already coarse-grained at that level, so there's no need for a separate throttling interval the way the
 *  per-item scan/hash loops elsewhere need one). Left undefined, behaves exactly as before (no probing overhead). */
const partitionBackupToOpticalMedia = async function(dirPath: string, mediaCapacityInBytes: number, splitLargeFiles:boolean=false, sessionId: string, filesMetadata?:filesMetadata[], onProgress?: (line: string) => void, skipUnreadable: boolean = false): Promise<ColdStorageMetadata>{
  assertValidSessionId(sessionId);
  process.env._stop="NoStop";

  // Be on the safe side, fill the disk at most up to a certain percentage (e.g. 95% or something) - see
  // getEffectiveOpticalMediumCapacityInBytes's own comment for why this margin exists.
  mediaCapacityInBytes = await getEffectiveOpticalMediumCapacityInBytes(mediaCapacityInBytes);
  // Routes through ensureTempDataDirectoryIsAppOwned rather than just creating the directory on demand - see
  // its doc comment for why (the startup check normally catches an unowned directory before this is ever
  // reached - this is defense-in-depth for cacheDataDirectoryPath being changed to something pre-existing
  // mid-session).
  const ownership = await ensureTempDataDirectoryIsAppOwned();
  if (!ownership.ok) {
    throw new Error(ownership.message);
  }
  const tempDataDirectoryPath = ownership.path;

  // No trailing backslash - except on a drive root ("D:\"), which needs it (see trimTrailingBackslash).
  dirPath = asScanRoot(trimTrailingBackslash(dirPath));

  // Skips the scan entirely when filesMetadata is given (its result would just be thrown away below) - this
  // used to run unconditionally, silently wasting however long a full scan of dirPath took even when the
  // caller already had every path/stat it needed (e.g. add-missing-files-to-optical-media-cold-storage's own
  // partition() call, which always supplies filesMetadata).
  let filePathsAndStats: Awaited<ReturnType<typeof getAllFilePathsWithStats>>;
  // Only a scan that was asked to (the caller's backup source - see the request's skipUnreadable) leaves out
  // entries it cannot read, and it then tells the user which ones - along with the links it leaves out.
  let skipped: SkippedScanEntry[] | undefined = undefined;
  if (filesMetadata !== undefined) {
    filePathsAndStats = filesMetadata;
  } else {
    let scanProbedTotal = 0;
    if (onProgress) { scanProbedTotal = await countAllFilesQuick(dirPath); }
    skipped = skipUnreadable ? [] : undefined;
    filePathsAndStats = await getAllFilePathsWithStats(dirPath, [], onProgress
      ? (count) => onProgress(`Scanning items (${Math.min(count, scanProbedTotal)} of ${scanProbedTotal})`)
      : undefined, skipped)
  }

  // Without splitting, every file too large for a single disc is reported at once - all of them, not just the first
  // one the packing loop below would stop at - so the user sees the full list of what "split the large files"
  // would apply to (too_large_files: full paths and sizes). Same >= threshold as that loop's own check.
  if (!splitLargeFiles) {
    const tooLargeFiles = filePathsAndStats.filter((item) => item.stats.size >= mediaCapacityInBytes);
    if (tooLargeFiles.length > 0) {
      throw {
        msg: `${tooLargeFiles.length} file(s) are too large to be contained on any single optical disk, e.g. ${tooLargeFiles[0].path}`,
        err_code: 'FILE_TOO_LARGE_FOR_SINGLE_OPTICAL_DISC',
        too_large_files: tooLargeFiles.map((item) => ({ path: item.path, size: item.stats.size }))
      };
    }
  }
  // Reported only once the plan goes ahead: when it stops above, the wizard asks about splitting and plans again,
  // and this list would otherwise be shown a second time.
  if (skipped) { reportSkippedScanEntries(skipped); }

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

  // Sort largest-first (First-Fit Decreasing) before packing, rather than packing in whatever order
  // getAllFilePathsWithStats/the filesMetadata caller happened to hand us (filesystem enumeration order,
  // effectively arbitrary). Bin packing (minimizing the number of discs used) is NP-hard in general, so this
  // isn't claiming an optimal packing - but unsorted first-fit has a materially worse worst-case bound than
  // first-fit *decreasing*, and in practice placing large files first (while a disc still has its full capacity
  // free) and letting small files fill in the leftover gaps at the end avoids the classic failure mode of
  // opening a new disc prematurely because a disc's remaining space was awkwardly sized. Same packing loop
  // below, unchanged - only the order items are offered to it changes.
  filePathsAndStats = filePathsAndStats.slice().sort((a, b) => b.stats.size - a.stats.size);

  const totalFilesToPack = filePathsAndStats.length;
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

    // Reported once per disc filled (see this function's own onProgress doc comment for why that's already
    // coarse-grained enough) - the `await` also lets a pending Cancel (process.env._stop) actually take effect
    // between discs, and lets this progress message's own IPC send actually flush, neither of which this loop
    // otherwise yielded for at all.
    if (onProgress && totalFilesToPack > 0) {
      onProgress(`Packing items (${totalFilesToPack - filePathsAndStats.length} of ${totalFilesToPack})`);
      await holdOn();
    }
  }
  // number of optical disks needed for the entire backup
  // console.log(partitioning.length)


  /* Next we need to split the files to multiple parts. This does NOT invoke 7-Zip at all here - only paths and
    ESTIMATED sizes of the split partials are computed (see estimateLargeFileSplitPartials), so planning an entire
    multi-disc backup job never has to physically split every large file up front, before a single disc has even
    been burned. The real splitting only happens later, lazily, disc by disc, when the user actually sends a
    disc to ImgBurn - see createOpticalMediaDiscPartials. The paths predicted here (the same "<name>.part.NNN"
    naming convention 7-Zip itself produces) are exactly what that later, real split is found again by.
  */

  if(splitLargeFiles){
    let largeFilePathsAndStats_: typeof filePathsAndStats = [];
    for (const itm of largeFilePathsAndStats) {
      const fileName = itm.path.split('\\').slice(-1)[0];
      const pathToLargeFileRelativeToOpticalMediumRoot = itm.path.replace(asPathPrefix(dirPath), "");
      const relativeDirOfLargeFile = pathToLargeFileRelativeToOpticalMediumRoot.split("\\").slice(0, -1).join("\\");
      // Predicted under this job's own session subfolder (see SESSION_FOLDER_NAME_PATTERN's own comment) -
      // never directly under tempDataDirectoryPath itself, so a different job's real split partials (past or
      // concurrent) can never collide with this one's, by construction rather than by convention.
      const pathToLargeFileSplitsInTempDirectory = node_path_module.join(tempDataDirectoryPath, sessionId, relativeDirOfLargeFile);

      const predictedPartials = estimateLargeFileSplitPartials(itm.stats.size);
      predictedPartials.forEach((partial, index) => {
        largeFilePathsAndStats_.push({
          path: node_path_module.join(pathToLargeFileSplitsInTempDirectory, `${fileName}.part.${zeroPad(index + 1, 3)}`),
          stats: { size: partial.size, mtime: itm.stats.mtime, isDirectory: false }
        });
      });
    }

    largeFilePathsAndStats = largeFilePathsAndStats_

    // Same largest-first sort as the ordinary-file pass above, for consistency - though split partials are almost
    // all the same fixed size (LARGE_FILE_SPLIT_VOLUME_SIZE_MIB), so there's little to gain here beyond each
    // large file's own smaller final remainder partial sorting toward the end.
    largeFilePathsAndStats = largeFilePathsAndStats.slice().sort((a, b) => b.stats.size - a.stats.size);

    while (largeFilePathsAndStats.length > 0 && !(process.env._stop=="stop")) {
      if(process.env._stop == 'stop'){break;}
      let paths: {"path": string, "stats": {"size": number, "mtime": Date, "isDirectory": boolean}}[] = []
      const initialUsedSpaceInBytes = 0;
      const usedSpaceInBytes = largeFilePathsAndStats.slice(0).reduce(
      (accumulator, currentRecord, i, arr) => {
      const r = accumulator + currentRecord.stats.size

      // Same guard the ordinary-file pass above already has (see its own "too large to be contained to ANY
      // single optical disk" check) - without it, a split partial (fixed at LARGE_FILE_SPLIT_VOLUME_SIZE_MIB)
      // that's bigger than mediaCapacityInBytes would never get pushed into `paths` below, so the filter after
      // this reduce would remove nothing from largeFilePathsAndStats, and the enclosing while loop - whose only
      // exit condition is largeFilePathsAndStats.length reaching 0 - would spin forever, pushing empty discs.
      // Not reachable through the real app UI today (the smallest selectable medium is always bigger than one
      // split partial - see that constant's own comment for why), but a real risk if this is ever called directly
      // with too small a capacity.
      if(currentRecord.stats.size >= mediaCapacityInBytes){
        console.log(
          "That's a problem! Found a large-file split partial which is too large to be contained to ANY single optical disk. Size of partial in bytes: " +
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

      // <= (not strict <): same reasoning as the ordinary-file pass above - a run of split partials whose
      // accumulated size lands exactly on mediaCapacityInBytes must still be placeable. With strict <, such
      // a partial would never satisfy this check, so it would never be added to `paths` nor removed from
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

/** Given `dirPath` (the same backup source root partitionBackupToOpticalMedia was called with) and `paths`
 *  (paths bare-relative to dirPath, using "\\" separators - the SAME convention createIBB_file's own `paths`
 *  parameter and insertBranch_for_IBB_creation's existence-based source/temp-dir fallback already use, and what
 *  FilesTreeComponent.getSelectedData() already hands calling components), returns fresh, real stats for each:
 *   - An ordinary file (real, exists under dirPath): a plain fs.statSync pass-through - it never needed
 *     splitting, so its stats were already correct.
 *   - An already-created split partial (exists under the temp directory from an earlier call): also just a
 *     pass-through.
 *   - A link's shortcut ("<link path>.lnk" - see linkAsShortcutEntry): created in the temp directory, pointing
 *     where the link points, the first time it is asked for; returned with its `linkTarget`.
 *   - A predicted-but-not-yet-real split partial (matches PART_FILE_PATTERN, exists under neither): reconstructs
 *     the original file's real path by stripping the ".part.NNN" suffix, runs the real 7-Zip split for that
 *     original file if not already done (idempotent - same "does a part file already exist" check
 *     partitionBackupToOpticalMedia used to do inline before this function existed), then statSyncs the
 *     specific requested partial.
 *
 *  This is deliberately the ONLY place the real `7z -v...m -mx0 a` command still runs - planning
 *  (partitionBackupToOpticalMedia) never does any more. Splitting one file necessarily creates ALL of its
 *  partials at once (7-Zip has no "just this one volume" mode), so creating what one disc needs can
 *  incidentally also create partials belonging to OTHER, not-yet-sent discs that happen to share the same
 *  source file - that is expected, not a bug.
 *
 *  The one time a file is actually, really split by this function (never on a later call that finds its partials
 *  already present - see alreadyProcessedOriginalFiles below), the real partial count is compared against a
 *  freshly recomputed estimateLargeFileSplitPartials(realFileSize) for that same file (see that function's own
 *  comment for why this can, rarely, disagree with what planning predicted):
 *   - Equal: nothing further to do.
 *   - Real count is exactly one more than estimated: the one extra, unplanned partial ("sliver") is appended to
 *     the returned results too, even though it wasn't requested - reported exactly once, by the one call that
 *     actually performed the split. This function does NOT check whether that extra partial actually fits on
 *     the disc whose send-to-ImgBurn action triggered the split - it has no notion of disc capacity at all.
 *     That check, and what happens to a sliver that doesn't fit (deferred onto a later, appended disc rather
 *     than silently written past the disc's margin-discounted capacity), is entirely the caller's
 *     responsibility - see sendToImgBurn/maybeAppendOverflowDiscs in backup-to-optical-media.component.ts.
 *   - Any other difference: throws - genuinely unexpected, not the one known/reconciled case. */
const createOpticalMediaDiscPartials = async function (dirPath: string, paths: Array<string>, sessionId: string): Promise<filesMetadata[]> {
  assertValidSessionId(sessionId);
  const ownership = await ensureTempDataDirectoryIsAppOwned();
  if (!ownership.ok) {
    throw new Error(ownership.message);
  }
  // This job's own session subfolder (see SESSION_FOLDER_NAME_PATTERN's own comment) - never the temp
  // directory's root directly, so this job's real split partials can never collide with a different job's.
  const tempDataDirectoryPath = node_path_module.join(ownership.path, sessionId);
  dirPath = asScanRoot(trimTrailingBackslash(dirPath));

  const config = await readConfig();
  const _7zipExecutablePath = config._7zipExecutablePath;

  // Which original large files this call has already (re-)split, so requesting several partials of the same
  // file only checks/splits it once, and so the surplus-partial check below only ever runs once per file too.
  const alreadyProcessedOriginalFiles = new Set<string>();
  const surplusPartials: filesMetadata[] = [];

  // A link is burned as a Windows shortcut (see LINK_SHORTCUT_EXTENSION): create, in one go, every shortcut these
  // paths need that does not exist yet - in this job's session folder, like split partials, so nothing is ever
  // written into the source. `linkTargets` also marks those entries in the results below.
  const linkTargets = new Map<string, string>();
  const shortcutJobs: Array<{ shortcut: string, target: string, mtime: Date }> = [];
  for (const relPath of paths) {
    const link = linkBehindShortcutPath(node_path_module.join(dirPath, relPath));
    if (link === null) { continue; }
    linkTargets.set(relPath, link.target);
    const shortcut = node_path_module.join(tempDataDirectoryPath, relPath);
    if (!fs.existsSync(shortcut)) {
      fs.mkdirSync(node_path_module.dirname(shortcut), { recursive: true });
      shortcutJobs.push({ shortcut, target: link.target, mtime: link.mtime });
    }
  }
  await createShortcutFiles(shortcutJobs);

  const results: filesMetadata[] = [];
  for (const relPath of paths) {
    // Same existence-based disambiguation insertBranch_for_IBB_creation already uses when resolving a path to
    // burn: try it as a real, ordinary file under the source directory first.
    const sourceAbsolutePath = node_path_module.join(dirPath, relPath);
    if (fs.existsSync(sourceAbsolutePath)) {
      const s = fs.statSync(sourceAbsolutePath);
      results.push({ path: relPath, stats: { size: s.size, mtime: s.mtime, isDirectory: s.isDirectory() } });
      continue;
    }

    const tempAbsolutePath = node_path_module.join(tempDataDirectoryPath, relPath);
    if (fs.existsSync(tempAbsolutePath)) {
      // Already created (this call or an earlier one) - a split partial, or a link's shortcut.
      const s = fs.statSync(tempAbsolutePath);
      const linkTarget = linkTargets.get(relPath);
      results.push({ path: relPath, stats: { size: s.size, mtime: s.mtime, isDirectory: false, ...(linkTarget !== undefined ? { linkTarget } : {}) } });
      continue;
    }

    if (!PART_FILE_PATTERN.test(relPath)) {
      throw new Error(`createOpticalMediaDiscPartials: "${relPath}" was not found under the source directory or the temp directory, and does not look like a large-file split partial.`);
    }

    const relDir = relPath.split('\\').slice(0, -1).join('\\');
    const partialFileName = relPath.split('\\').slice(-1)[0];                   // e.g. "video.mp4.part.003"
    const originalFileName = partialFileName.replace(PART_FILE_PATTERN, '');    // e.g. "video.mp4"
    const originalRelPath = relDir ? `${relDir}\\${originalFileName}` : originalFileName;
    const originalAbsolutePath = node_path_module.join(dirPath, originalRelPath);
    const partialDir = node_path_module.join(tempDataDirectoryPath, relDir);

    if (!alreadyProcessedOriginalFiles.has(originalAbsolutePath)) {
      alreadyProcessedOriginalFiles.add(originalAbsolutePath);

      if (!fs.existsSync(partialDir)) { fs.mkdirSync(partialDir, { recursive: true }); }
      const re = new RegExp(`^${originalFileName.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}.part`);
      let partFileNames: string[] = fs.readdirSync(partialDir).filter((v: string) => re.test(v));

      if (partFileNames.length === 0) {
        const util = require('util');
        const exec = util.promisify(require('child_process').exec);
        // Same invocation shape partitionBackupToOpticalMedia used to run inline - see
        // LARGE_FILE_SPLIT_VOLUME_SIZE_MIB's own comment for why this size.
        await exec(`"${_7zipExecutablePath}" -v${LARGE_FILE_SPLIT_VOLUME_SIZE_MIB}m -mx0 a "${partialDir}\\${originalFileName}.part" "${originalAbsolutePath}"`);
        partFileNames = fs.readdirSync(partialDir).filter((v: string) => re.test(v));

        const expectedPartialCount = estimateLargeFileSplitPartials(fs.statSync(originalAbsolutePath).size).length;
        if (partFileNames.length === expectedPartialCount + 1) {
          // The known, rare boundary case (see estimateLargeFileSplitPartials) - one real partial the plan never
          // assigned to any disc: a "sliver". Surface it so the caller can attach it to the disc it just
          // created for.
          const surplusName = partFileNames.slice().sort()[partFileNames.length - 1];
          const surplusRelPath = relDir ? `${relDir}\\${surplusName}` : surplusName;
          const surplusAbsolutePath = node_path_module.join(partialDir, surplusName);
          const s = fs.statSync(surplusAbsolutePath);
          surplusPartials.push({ path: surplusRelPath, stats: { size: s.size, mtime: s.mtime, isDirectory: false } });
        } else if (partFileNames.length !== expectedPartialCount) {
          throw new Error(
            `Splitting "${originalAbsolutePath}" produced ${partFileNames.length} real partial(s) but the disc plan ` +
            `expected ${expectedPartialCount} - the capacity plan is out of date for this file. Please redo the ` +
            `planning step before burning.`
          );
        }
      }
    }

    if (!fs.existsSync(tempAbsolutePath)) {
      throw new Error(`createOpticalMediaDiscPartials: expected partial "${relPath}" was not produced by the real split.`);
    }
    const s = fs.statSync(tempAbsolutePath);
    results.push({ path: relPath, stats: { size: s.size, mtime: s.mtime, isDirectory: false } });
  }

  return results.concat(surplusPartials);
}

/** Streams `absolutePath` through crypto's sha256 (never fs.readFileSync - some of these are multi-GB files,
 *  and this must not hold a whole one in memory at once) and resolves with its lowercase hex digest. */
const sha256OfFile = function (absolutePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(absolutePath);
    stream.on('error', reject);
    stream.on('data', (chunk: Buffer) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Resolves `relPath`'s real, current absolute location using the exact same two checks
 *  createOpticalMediaDiscPartials itself uses for its first two branches (an ordinary file still under
 *  dirPath, or an already-created split partial under this job's temp-dir session subfolder) - copied here
 *  rather than shared, so that function's own, already-working control flow (which also has to decide whether
 *  a partial still needs to be split for the FIRST time) is not touched by this. Callers of this function only
 *  ever run AFTER creation has already happened for these exact paths, so - unlike
 *  createOpticalMediaDiscPartials - there is no third "not found anywhere yet" case to fall back to.
 *  Returns null if `relPath` genuinely isn't at either location. */
const resolveFileAbsolutePath = function (dirPath: string, tempDataDirectoryPath: string, relPath: string): string | null {
  const sourceAbsolutePath = node_path_module.join(dirPath, relPath);
  if (fs.existsSync(sourceAbsolutePath)) { return sourceAbsolutePath; }
  const tempAbsolutePath = node_path_module.join(tempDataDirectoryPath, relPath);
  if (fs.existsSync(tempAbsolutePath)) { return tempAbsolutePath; }
  return null;
}

/** Computes a SHA-256 hash for each of `paths` (bare-relative to `dirPath`, same convention as
 *  createOpticalMediaDiscPartials's own `paths` parameter) - the backup-side half of the integrity-checksum
 *  feature: this only ever RECORDS a hash, it never compares against anything (see verifyFileHashes for that,
 *  used by recovery and the standalone verify wizard instead). Always called after
 *  createOpticalMediaDiscPartials has already created every one of these paths for real, so every one
 *  is guaranteed to already exist under either dirPath or this job's temp-dir session subfolder - this throws
 *  if that invariant is ever violated, rather than silently skipping a file.
 *
 *  Progress is reported one line per file via logsBuffer (the caller sets its own channel before calling this -
 *  see worker.ts's own switch/case), in the same "(n of m files)" style createOpticalMediaDiscPartials's
 *  caller-visible operations already use elsewhere, so any caller can show it in a progress dialog without this
 *  function needing to know anything about dialogs. Cancellable (process.env._stop) between files - a file
 *  already being hashed always finishes that one file's hash before stopping. */
const computeSha256ForBackedUpFiles = async function (dirPath: string, paths: Array<string>, sessionId: string): Promise<Array<{ path: string, sha256: string }>> {
  // Reset unconditionally, like every other independently-invokable operation in this file (createIBB_file,
  // partitionBackupToOpticalMedia, createTree, ...) - a FRESH call must not silently do nothing just because
  // some earlier, unrelated operation was cancelled and never got its own chance to reset this shared flag.
  // In practice this call is always preceded (within the same job) by one of those other resets already, but
  // relying on that ordering by accident, rather than each cancellable operation owning its own reset, is
  // exactly the kind of thing that silently breaks the day a caller/order changes.
  process.env._stop = "noStop";
  assertValidSessionId(sessionId);
  const ownership = await ensureTempDataDirectoryIsAppOwned();
  if (!ownership.ok) {
    throw new Error(ownership.message);
  }
  const tempDataDirectoryPath = node_path_module.join(ownership.path, sessionId);
  dirPath = asScanRoot(trimTrailingBackslash(dirPath));

  const results: Array<{ path: string, sha256: string }> = [];
  for (let i = 0; i < paths.length; i++) {
    if (process.env._stop == 'stop') { break; }
    const relPath = paths[i];
    const absolutePath = resolveFileAbsolutePath(dirPath, tempDataDirectoryPath, relPath);
    if (absolutePath === null) {
      throw new Error(`computeSha256ForBackedUpFiles: "${relPath}" was not found under the source directory or the temp directory - it must already be created (see createOpticalMediaDiscPartials) before its hash can be computed.`);
    }
    logsBuffer.push(`Calculating SHA-256 for file: ${relPath} (${i + 1} of ${paths.length} files)`);
    results.push({ path: relPath, sha256: await sha256OfFile(absolutePath) });
  }
  logsBuffer.flush();
  return results;
}

/** Computes a SHA-256 hash for each real, absolute path in `files`, and - for every entry that also carries an
 *  `expectedSha256` - compares the computed hash against it, adding a `matched` boolean to that entry's result.
 *  This is the shared verification primitive behind BOTH the recovery flow's post-recovery integrity check and
 *  the standalone "verify integrity of cold storage disc" wizard: it only ever deals in plain absolute paths,
 *  so it doesn't care (and doesn't need to know) whether a path is a file already copied to a target directory
 *  or a file still sitting directly on a mounted optical disc - unlike computeSha256ForBackedUpFiles, there is
 *  no dirPath/temp-dir resolution involved here at all, since both real callers already know each file's exact
 *  real location up front. An entry without `expectedSha256` is only ever hashed, never marked matched/not -
 *  not a use either real caller needs today, but kept possible rather than assuming there will always be one.
 *
 *  Progress is reported the same way computeSha256ForBackedUpFiles's is - one logsBuffer line per file, "(n of
 *  m files)" - the caller sets its own channel before calling this (see worker.ts's own switch/case).
 *  Cancellable (process.env._stop) between files. */
const verifyFileHashes = async function (files: Array<{ absolutePath: string, expectedSha256?: string }>): Promise<Array<{ path: string, sha256: string, matched?: boolean, error?: string }>> {
  // See computeSha256ForBackedUpFiles's identical reset for why this is unconditional, not relied on being
  // done by whatever the caller happened to run beforehand.
  process.env._stop = "noStop";
  const results: Array<{ path: string, sha256: string, matched?: boolean, error?: string }> = [];
  for (let i = 0; i < files.length; i++) {
    if (process.env._stop == 'stop') { break; }
    const { absolutePath, expectedSha256 } = files[i];
    logsBuffer.push(`Verifying SHA-256 for file: ${absolutePath} (${i + 1} of ${files.length} files)`);
    try {
      const sha256 = await sha256OfFile(absolutePath);
      const entry: { path: string, sha256: string, matched?: boolean } = { path: absolutePath, sha256 };
      if (expectedSha256 !== undefined) {
        entry.matched = sha256 === expectedSha256;
      }
      results.push(entry);
    } catch (error) {
      // A file that can't even be read (a badly damaged disc sector, a file genuinely missing/inaccessible) is
      // at least as significant a finding as a hash mismatch - and arguably more likely on real damaged media
      // than a file that reads back with merely-wrong bytes. Reported the same way callers already handle a
      // mismatch (matched: false, when there's an expectedSha256 to compare against) rather than letting one
      // unreadable file abort every OTHER file still waiting in this same batch - the whole point of checking a
      // disc's files one by one is that a problem with file 12 must not stop file 13 from being checked at all.
      const message = error && (error as any).message ? (error as any).message : String(error);
      results.push({
        path: absolutePath,
        sha256: '',
        matched: expectedSha256 !== undefined ? false : undefined,
        error: message,
      });
    }
  }
  logsBuffer.flush();
  return results;
}

/** Deletes exactly the given real, absolute temp-dir partial paths (e.g. from one disc's own created plan
 *  entries) - never a whole file's OTHER partials if that file happens to be split across multiple discs (e.g. if
 *  a large file's partials 1-3 are on disc 1 and partial 4 is on disc 2, deleting disc 1's partials must not touch
 *  partial 4). Reuses the exact same safety pattern clearTempDataDirectory already uses (ownership check,
 *  realpath-inside-temp-dir containment check, isRecognizedTempContent) rather than introducing a separate,
 *  less-safe deletion path - this is effectively clearTempDataDirectory's own per-entry deletion loop, scoped to
 *  a caller-supplied allowlist of exact paths instead of "every recognized entry in the directory". Returns the
 *  same {cleared, message, deletedItems, notClearedItems} shape as clearTempDataDirectory for UI consistency.
 *
 *  Deliberately does not also try to remove now-empty parent subdirectories left behind - clearTempDataDirectory
 *  doesn't do that either, and correctly telling "empty of everything" apart from "empty of THIS disc's partials
 *  but still holding another, not-yet-confirmed disc's partials" adds real risk for cosmetic benefit; leftover
 *  empty subdirectories are harmless and are cleaned up whenever clearTempDataDirectory next runs. */
const deletePartialsForDisc = async function (partialAbsolutePaths: Array<string>): Promise<{ cleared: boolean, message: string, deletedItems: string[], notClearedItems: string[] }> {
  const ownership = await ensureTempDataDirectoryIsAppOwned();
  if (!ownership.ok) {
    return { cleared: false, message: 'Refusing to delete: ' + ownership.message, deletedItems: [], notClearedItems: [] };
  }
  let realTempDataDirectoryPath: string;
  try {
    realTempDataDirectoryPath = fs.realpathSync(ownership.path);
  } catch (error) {
    return { cleared: false, message: 'Failed to resolve the real path of the temp directory: ' + (error && (error as any).message ? (error as any).message : String(error)), deletedItems: [], notClearedItems: [] };
  }

  const deletedItems: string[] = [];
  // One "<full path>  -  <reason>" line per partial that was not deleted - see clearTempDataDirectory's notClearedItems.
  const notClearedItems: string[] = [];
  for (const entryPath of partialAbsolutePaths) {
    if (!fs.existsSync(entryPath)) {
      // Already gone - idempotent, not a problem (e.g. a previous, partially-failed confirm already removed it).
      continue;
    }
    let entryRealPath: string;
    try {
      entryRealPath = fs.realpathSync(entryPath);
    } catch (error) {
      notClearedItems.push(`${entryPath}  -  skipped: could not resolve its real path`);
      continue;
    }
    if (!isPathStrictlyInside(entryRealPath, realTempDataDirectoryPath)) {
      notClearedItems.push(`${entryPath}  -  skipped: it does not resolve to a location inside the temp directory`);
      continue;
    }
    if (!isRecognizedTempContent(entryPath, false)) {
      notClearedItems.push(`${entryPath}  -  skipped: it does not look like this app's own temp/cache content`);
      continue;
    }
    try {
      fs.rmSync(entryPath, { force: true });
      deletedItems.push(entryPath);
    } catch (error) {
      notClearedItems.push(`${entryPath}  -  could not be deleted: ${error && (error as any).message ? (error as any).message : String(error)}`);
    }
  }

  if (notClearedItems.length === 0) {
    return { cleared: true, message: `Removed ${deletedItems.length} item(s) for this disc.`, deletedItems, notClearedItems };
  }
  // false for any partial run, even if some items DID delete successfully - same fix as
  // clearTempDataDirectory's own identical `cleared` flag (see its doc comment): the caller only reports a problem
  // when `cleared` is false, so a partial failure here must report `cleared: false` too, or the fact that this
  // disc's temp cleanup didn't fully succeed would be silently lost.
  return { cleared: false, message: `Removed ${deletedItems.length} of ${partialAbsolutePaths.length} item(s).`, deletedItems, notClearedItems };
}

/** Deletes exactly the given real, absolute paths of recovered files that FAILED SHA-256 verification after a
 *  "recover data from optical media" job (see verifyRecoveredFileIntegrity in optical-disc-backup-data-
 *  retriever.component.ts) - and nothing else. Mirrors deletePartialsForDisc's safety pattern (containment
 *  check against a known-safe root, then delete only the exact caller-supplied paths) but scoped to
 *  `targetDirectory` - the user's chosen recovery destination - instead of the app's own temp directory, since
 *  recovered files can be written anywhere the user picked, not just under app-owned storage.
 *
 *  Each path is only ever deleted if it resolves (via realpath) to a location strictly inside
 *  targetDirectory, AND is a real, regular file (fs.lstatSync(...).isFile()) - never a directory, and never a
 *  symbolic link (its actual target cannot be vouched for, so it is left alone rather than risk deleting
 *  something it points to elsewhere). A path that no longer exists is treated as already gone, not a problem
 *  (idempotent - e.g. it belonged to a .part.NNN group that the optional reassembly step, which runs before
 *  this, already merged and cleaned up). */
const deleteRecoveredFailedFiles = async function (failedAbsolutePaths: Array<string>, targetDirectory: string): Promise<{ cleared: boolean, message: string, deletedItems: string[], notClearedItems: string[] }> {
  let realTargetDirectory: string;
  try {
    realTargetDirectory = fs.realpathSync(targetDirectory);
  } catch (error) {
    return { cleared: false, message: 'Refusing to delete: could not resolve the real path of the recovery target directory: ' + (error && (error as any).message ? (error as any).message : String(error)), deletedItems: [], notClearedItems: [] };
  }

  const deletedItems: string[] = [];
  // One "<full path>  -  <reason>" line per file that was not deleted - see clearTempDataDirectory's notClearedItems.
  const problems: string[] = [];
  for (const entryPath of failedAbsolutePaths) {
    if (!fs.existsSync(entryPath)) {
      continue;
    }
    let entryRealPath: string;
    let stats;
    try {
      entryRealPath = fs.realpathSync(entryPath);
      // lstat, not stat: a symbolic link must be recognized (and rejected below) as itself, not silently
      // resolved through to whatever it points at.
      stats = fs.lstatSync(entryPath);
    } catch (error) {
      problems.push(`${entryPath}  -  skipped: could not resolve its real path`);
      continue;
    }
    if (!isPathStrictlyInside(entryRealPath, realTargetDirectory)) {
      problems.push(`${entryPath}  -  skipped: it does not resolve to a location inside the recovery target directory`);
      continue;
    }
    if (!stats.isFile()) {
      problems.push(`${entryPath}  -  skipped: it is not a regular file (directories and symbolic links are never deleted by this feature)`);
      continue;
    }
    try {
      fs.unlinkSync(entryPath);
      deletedItems.push(entryPath);
    } catch (error) {
      problems.push(`${entryPath}  -  could not be deleted: ${error && (error as any).message ? (error as any).message : String(error)}`);
    }
  }

  if (problems.length === 0) {
    return { cleared: true, message: `Deleted ${deletedItems.length} file(s) which failed integrity verification.`, deletedItems, notClearedItems: problems };
  }
  // false for any partial run, even if some items DID delete successfully - same reasoning as
  // deletePartialsForDisc/clearTempDataDirectory's own identical `cleared` flag.
  return { cleared: false, message: `Deleted ${deletedItems.length} of ${failedAbsolutePaths.length} file(s); the ones listed below were not deleted.`, deletedItems, notClearedItems: problems };
}


/** @return an array that contains the absolute paths of all files in "dirPath" (in a recursive fashion).
 *  It also takes into account empty directories. 
 * @param dirPath the directory for which you want to list the files. 
 * @param arrayOfFiles <empty> (used internally for recursion) */
/** Same recursive scan as getAllFiles, into a Set instead of an Array (see diff's own use of both - the target
 *  side only ever needs membership checks). `onProgress` follows the same "every SCAN_PROGRESS_REPORT_INTERVAL
 *  items" convention. `skipped` is the same optional parameter as getAllFiles's. */
/** getAllFiles, collected into a Set - see getAllFiles for the parameters. */
const getAllFilesSet = async function (dirPath: string, arrayOfFiles: Set<string> = new Set<string>(), onProgress?: (itemsFoundSoFar: number) => void, skipped?: SkippedScanEntry[]): Promise<Set<string>> {
  let files: Array<string> = fs.readdirSync(dirPath)

  if (files.length > 0) {
    let file: string;
    for (let i = 0; i < files.length; i++) {
      if(process.env._stop == 'stop'){break;}
      file = files[i];
      const entryStats = statEntryOrSkip(dirPath + "/" + file, skipped);
      if (entryStats === null) {
        await holdOnIfDue();
        continue;
      }
      if (entryStats.isDirectory()) {
        arrayOfFiles = await scanSubdirectoryOrSkip(dirPath + "/" + file, skipped, () => getAllFilesSet(dirPath + "/" + file, arrayOfFiles, onProgress, skipped), arrayOfFiles)
      } else {
        arrayOfFiles.add(node_path_module.join(dirPath, "/", file))
        //print_line(arrayOfFiles.length + "")
        if (onProgress && arrayOfFiles.size % SCAN_PROGRESS_REPORT_INTERVAL === 0) { onProgress(arrayOfFiles.size); }
      }
      await holdOnIfDue();
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


/** Two modification times this close count as equal when diff runs in one of its 'any-difference' modes. Copying a file keeps
 *  its mtime, so on NTFS a copy matches its source exactly - but a FAT volume stores mtimes to 2 seconds, and
 *  without this allowance a mirror onto one would re-copy every file on every run. */
const MIRROR_MTIME_TOLERANCE_MS = 2000;

/** Size of each chunk haveSameContent reads from each of the two files at a time. */
const CONTENT_COMPARE_CHUNK_BYTES = 1024 * 1024;

/** Reads from `fileHandle` until `buffer` is full or the file ends; resolves with how many bytes it holds. (A single
 *  read may return fewer bytes than asked for even when more follow.) */
const readIntoBuffer = async function (fileHandle: any, buffer: Buffer): Promise<number> {
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await fileHandle.read(buffer, filled, buffer.length - filled, null);
    if (bytesRead === 0) { break; }
    filled += bytesRead;
  }
  return filled;
}

/** True if the two files (already known to have the same size) hold exactly the same bytes. Reads both in chunks
 *  and stops at the first chunk that differs, so a difference near the start is found without reading the rest;
 *  identical files are read to the end. This is deliberately a direct comparison, not a hash of each file: two
 *  hashes read exactly the same bytes, cost several times more CPU (SHA-256 is much slower than comparing
 *  memory), and can never stop early. The two files' reads are issued together, so when they are on different
 *  drives the drives work at the same time. Awaits between chunks, so a pending `stop` (Cancel) is noticed within
 *  one chunk - if one arrives, this reports "same" and the caller's own stop check discards the whole result. Throws
 *  if either file cannot be read. `buffers` are the two scratch buffers to read into (shared across calls, so a
 *  comparison over many files does not allocate two new chunks per file). */
const haveSameContent = async function (pathA: string, pathB: string, buffers: [Buffer, Buffer]): Promise<boolean> {
  const handleA = await fs.promises.open(pathA, 'r');
  try {
    const handleB = await fs.promises.open(pathB, 'r');
    try {
      for (;;) {
        if (process.env._stop == 'stop') { return true; }
        const [readA, readB] = await Promise.all([readIntoBuffer(handleA, buffers[0]), readIntoBuffer(handleB, buffers[1])]);
        if (readA !== readB) { return false; }
        if (readA === 0) { return true; }
        if (buffers[0].compare(buffers[1], 0, readB, 0, readA) !== 0) { return false; }
      }
    } finally {
      await handleB.close();
    }
  } finally {
    await handleA.close();
  }
}

/** Gives entries in the target the letter case they have in the source, wherever the filesystem treats the two
 *  spellings as one name (NTFS by default): "photos\img.jpg" becomes "Photos\IMG.JPG" when the source has that
 *  spelling. "Synchronize directories" needs this because its copy writes into an existing entry and keeps that
 *  entry's name, and diff treats the two spellings as the same entry - so a rename that only changed letter case
 *  would otherwise never reach the target. Only an entry of the same kind (file, folder, link) is renamed; a link is
 *  renamed as the link itself, never followed. In a folder where letter case matters the two spellings are two
 *  entries, and nothing is renamed. With `commit` false, only lists what it would rename. Returns one
 *  { targetPath, to } per rename: the entry's full path as it is in the target before the rename, and its new name. */
const matchLetterCase = async function (source: string, target: string, commit: boolean): Promise<Array<{ targetPath: string, to: string }>> {
  const renames: Array<{ targetPath: string, to: string }> = [];
  const kindOf = (stats: any) => stats.isSymbolicLink() ? 'link' : stats.isDirectory() ? 'folder' : 'file';
  // `relativeDir` is in the source's spelling; on a filesystem that ignores letter case it finds the target's folder
  // whatever that folder's own spelling is.
  const walk = async (relativeDir: string): Promise<void> => {
    const sourceDir = node_path_module.join(source, relativeDir);
    const targetDir = node_path_module.join(target, relativeDir);
    if (!isRealDirectoryAt(targetDir)) { return; }
    const targetNames: string[] = fs.readdirSync(targetDir);
    const inTarget = new Set(targetNames);
    for (const name of fs.readdirSync(sourceDir)) {
      const sourceStats = fs.lstatSync(node_path_module.join(sourceDir, name));
      if (!inTarget.has(name)) {
        const variants = targetNames.filter((n) => n !== name && n.toLowerCase() === name.toLowerCase());
        const variantStats = variants.length === 1 ? lstatOrNull(node_path_module.join(targetDir, variants[0])) : null;
        // One entry of the same kind, which the source's spelling also reaches - i.e. the filesystem sees one name.
        if (variantStats && kindOf(variantStats) === kindOf(sourceStats) && lstatOrNull(node_path_module.join(targetDir, name)) !== null) {
          const targetPath = node_path_module.join(targetDir, variants[0]);
          renames.push({ targetPath, to: name });
          if (commit) { fs.renameSync(targetPath, node_path_module.join(targetDir, name)); }
        }
      }
      if (sourceStats.isDirectory() && !sourceStats.isSymbolicLink()) { await walk(node_path_module.join(relativeDir, name)); }
      await holdOnIfDue();
    }
  };
  await walk('');
  return renames;
}

/** Compares two folders entry by entry, the check "Synchronize directories" runs after a sync: by exact name (letter
 *  case included) and, for a file, exact size in bytes. A link is one entry - compared by where it points
 *  (linkTargetText), never followed. Returns whether everything matched, the source's totals (its files, links
 *  included, and their bytes) and one line per difference, "<relative path>  -  <what differs>". A folder only one
 *  side has is one line, not one per file in it; two names that differ only in letter case are one line too.
 *  Reports "Comparing items (i of N)" through `onProgress`, N being both folders' probed item counts together. */
const compareFolders = async function (source: string, target: string, onProgress?: (line: string) => void):
  Promise<{ matched: boolean, fileCount: number, totalBytes: number, mismatches: string[] }> {
  const mismatches: string[] = [];
  let fileCount = 0;
  let totalBytes = 0;
  let visited = 0;
  const total = onProgress ? (await countAllFilesQuick(source)) + (await countAllFilesQuick(target)) : 0;
  const visit = async (count: number) => {
    visited += count;
    if (onProgress && total > 0) { onProgress(`Comparing items (${Math.min(visited, total)} of ${total})`); }
    await holdOnIfDue();
  };
  const kindOf = (stats: any) => stats.isSymbolicLink() ? 'link' : stats.isDirectory() ? 'folder' : 'file';
  const describe = (stats: any, fullPath: string) => stats.isSymbolicLink() ? `a link to "${linkTargetText(fullPath)}"`
    : stats.isDirectory() ? 'a folder' : `a file, ${stats.size} bytes`;

  const walk = async (relativeDir: string): Promise<void> => {
    const sourceDir = node_path_module.join(source, relativeDir);
    const targetDir = node_path_module.join(target, relativeDir);
    const sourceNames: string[] = fs.readdirSync(sourceDir);
    const targetNames: string[] = fs.readdirSync(targetDir);
    const inSource = new Set(sourceNames);
    const inTarget = new Set(targetNames);
    // Target-only names by lower case, so a source-only name that differs from one only in letter case is one line.
    const targetOnlyByLowerCase = new Map(targetNames.filter((n) => !inSource.has(n)).map((n) => [n.toLowerCase(), n]));
    for (const name of sourceNames) {
      const relativePath = node_path_module.join(relativeDir, name);
      const sourcePath = node_path_module.join(source, relativePath);
      const sourceStats = fs.lstatSync(sourcePath);
      if (!inTarget.has(name)) {
        const caseVariant = targetOnlyByLowerCase.get(name.toLowerCase());
        if (caseVariant !== undefined) {
          targetOnlyByLowerCase.delete(name.toLowerCase());
          mismatches.push(`${relativePath}  -  the name differs only in letter case: "${caseVariant}" in the target`);
        } else {
          mismatches.push(`${relativePath}  -  only in the source (${describe(sourceStats, sourcePath)})`);
        }
        await visit(1);
        continue;
      }
      const targetPath = node_path_module.join(target, relativePath);
      const targetStats = fs.lstatSync(targetPath);
      if (kindOf(sourceStats) !== kindOf(targetStats)) {
        mismatches.push(`${relativePath}  -  ${describe(sourceStats, sourcePath)} in the source, ${describe(targetStats, targetPath)} in the target`);
        await visit(2);
      } else if (sourceStats.isDirectory() && !sourceStats.isSymbolicLink()) {
        await walk(relativePath);
      } else {
        fileCount++;
        if (sourceStats.isSymbolicLink()) {
          if (linkTargetText(sourcePath) !== linkTargetText(targetPath)) {
            mismatches.push(`${relativePath}  -  ${describe(sourceStats, sourcePath)} in the source, ${describe(targetStats, targetPath)} in the target`);
          }
        } else {
          totalBytes += sourceStats.size;
          if (sourceStats.size !== targetStats.size) {
            mismatches.push(`${relativePath}  -  the size differs: ${sourceStats.size} bytes in the source, ${targetStats.size} bytes in the target`);
          }
        }
        await visit(2);
      }
    }
    for (const name of targetOnlyByLowerCase.values()) {
      const relativePath = node_path_module.join(relativeDir, name);
      const targetPath = node_path_module.join(target, relativePath);
      mismatches.push(`${relativePath}  -  only in the target (${describe(fs.lstatSync(targetPath), targetPath)})`);
      await visit(1);
    }
  };
  await walk('');
  if (onProgress && total > 0) { onProgress(`Comparing items (${total} of ${total})`); }
  return { matched: mismatches.length === 0, fileCount, totalBytes, mismatches };
}

/** Throws if one of the two folders is inside the other. "Synchronize directories" would otherwise delete the
 *  source when the target contains it (the source's own files are extra files in the target), and it and Cumulative
 *  backup would both copy the target into itself once more on every run when the source contains it. The same
 *  folder twice is fine - nothing differs, so there is nothing to do. Links are resolved first, so a link to a
 *  folder counts as that folder. */
const refuseFoldersInsideEachOther = function (first: string, second: string): void {
  const resolve = (folder: string) => {
    try { return fs.realpathSync.native(folder); } catch (error) { return node_path_module.resolve(folder); }
  };
  const isInside = (inner: string, outer: string) => {
    const relative = node_path_module.relative(outer, inner);
    return relative !== '' && relative !== '..' && !relative.startsWith('..' + node_path_module.sep) && !node_path_module.isAbsolute(relative);
  };
  const a = resolve(first);
  const b = resolve(second);
  if (isInside(a, b) || isInside(b, a)) {
    throw new Error(`One of the two folders is inside the other: "${first}" and "${second}". Choose two folders where neither one contains the other.`);
  }
}

/** Where the link at `linkPath` points, as text to compare - without a trailing backslash (or slash): the same
 *  junction reads back with or without one depending on what created it (Electron's Node writes one, Windows'
 *  mklink and newer Node do not), so a junction copyLink made would otherwise never match its original. A drive
 *  root ("C:\") keeps its backslash. */
const linkTargetText = function (linkPath: string): string {
  const text = fs.readlinkSync(linkPath);
  return /^[A-Za-z]:\\$/.test(text) ? text : text.replace(/[\\/]+$/, '');
}

/**
 * Returns the elements that exist only in source.
 * The paths for the source and target must be absolute.
 * For example: let source = 'F:\\User\\backup_system\\source' + "\\"
 * let target = 'F:\\User\\backup_system\\target' + "\\"
 * diff(source, target)
 */
/** A path that differs from one in the target only in letter case counts as present if the filesystem says it is
 *  the same entry: on a normal (case-insensitive) NTFS folder "Photos\IMG.JPG" in the source and
 *  "photos\img.jpg" in the target are one file, so comparing the two strings literally would report a case-only
 *  rename as "source only" (so it is re-copied) and - seen from the other direction, as used by "Synchronize
 *  directories" to find what to delete - as "target only", i.e. a file the target must lose although the source
 *  still has it. In a case-sensitive directory they are two different files and are reported as such.
 *
 *  @param onProgress optional - reports this call's progress as plain text lines, same "(i of N)" convention as
 *  every other long-running operation's logsBuffer lines (see parseProgressFromLine, shared/utils) for the
 *  comparison phase below, and - via an upfront countAllFilesQuick probe of both sides, see its own doc comment
 *  - a real "(i of N)" percentage for the two scan phases too (see parseScanItemsProgress, shared/utils),
 *  reported as ONE continuous count across both scans (target's count picks up where source's left off) against
 *  their combined probed total, rather than two separate open-ended counters, so a caller can drive one smooth
 *  progress bar across the whole scan phase. Left undefined, behaves exactly as before (no probing overhead).
 *  @param comparison how a file that exists on both sides is judged - see DiffComparison (ipc.interfaces.ts).
 *  Cumulative backup uses the default. "Synchronize directories" calls diff twice with the arguments swapped -
 *  diff(source, target) for what to copy, diff(target, source) for what to delete - and removes from the delete
 *  list everything that is also in the copy list (a file that exists on both sides but differs). That only
 *  works if the delete-list call never reports an existing file the copy-list call does not: the default
 *  comparison can (it looks only at whether the FIRST directory's copy is newer), 'any-difference' cannot (it is
 *  symmetric), and sync passes it for the delete list. The copy list is asked with 'any-difference-or-content',
 *  which additionally compares the BYTES of files that look unchanged, so the target matches the source exactly;
 *  that reads every such file on both sides, which is why it is not used for the delete list too.
 *  @param skipUnreadable when true, an entry either directory's scan cannot read is left out (and reported to the
 *  user afterwards - see reportSkippedScanEntries) instead of failing the whole comparison. Only Cumulative
 *  backup asks for this. "Synchronize directories" must not: it deletes whatever is missing from the source, so an
 *  unreadable source entry that was merely skipped would look like "not in the source" and the target's copy of
 *  it would be deleted.
 *
 *  A link (symbolic link or junction) inside either directory is one entry, like a file, and is never followed:
 *  it is reported when the other side has no link at that path pointing to the same place, and createTree /
 *  deleteFilesAndDirsForDirSync then copy or delete the link itself. That keeps both features to what is inside
 *  the two directories - nothing a link points to elsewhere is read, copied, overwritten or deleted.
 *
 *  Throws if one directory is inside the other - see refuseFoldersInsideEachOther. */
const diff = async function (source: string, target: string, onProgress?: (line: string) => void, comparison: DiffComparison = 'source-newer-or-different-size', skipUnreadable: boolean = false): Promise<string[]> {
  process.env._stop = "noStop";
  refuseFoldersInsideEachOther(source, target);

  if (source[source.length - 1] != '\\') { source += "\\"; }
  if (target[target.length - 1] != '\\') { target += "\\"; }
  console.log("Reading paths of: " + source)
  let time_start = performance.now();
  let sourceProbedTotal = 0;
  let combinedProbedTotal = 0;
  if (onProgress) {
    // Run concurrently (not sequentially) - two independent full-tree walks over unrelated directories, so
    // there's no reason to pay their combined wall-clock cost one after another just to compute this progress
    // bar's denominator, before either real scan below has even started.
    let targetProbedTotal: number;
    [sourceProbedTotal, targetProbedTotal] = await Promise.all([countAllFilesQuick(source), countAllFilesQuick(target)]);
    combinedProbedTotal = sourceProbedTotal + targetProbedTotal;
  }
  const skipped: SkippedScanEntry[] | undefined = skipUnreadable ? [] : undefined;
  let source_files = await getAllFiles(source, [], onProgress ? (count) => onProgress(`Scanning items (${Math.min(count, combinedProbedTotal)} of ${combinedProbedTotal})`) : undefined, skipped)
  console.log("\nReading paths of: " + target)
  let target_files = await getAllFilesSet(target, new Set<string>(), onProgress ? (count) => onProgress(`Scanning items (${Math.min(sourceProbedTotal + count, combinedProbedTotal)} of ${combinedProbedTotal})`) : undefined, skipped)
  if (skipped) { reportSkippedScanEntries(skipped); }
  let time_end = performance.now();
  console.log("DONE READING FILES " + ((time_end - time_start) / 1000).toFixed(2))
  time_start = performance.now();
  // Lower-cased names, only used to cheaply spot a possible case-only match - see this function's own doc comment.
  const target_keys = new Set<string>();
  target_files.forEach((p) => target_keys.add(p.toLowerCase()));
  // Converted from a plain synchronous .filter() to an explicit loop: source_files.length IS a known total by
  // this point (both scans above have already finished), so - unlike the open-ended scan phases just above -
  // this comparison phase can report a REAL "(i of N)" percentage instead of just a running count. The periodic
  // `await holdOn()` (the same yield point every other cancellable loop in this file already uses) is also what
  // actually lets process.env._stop be checked mid-comparison, which the original single synchronous .filter()
  // call never could.
  let source_only: string[] = [];
  let contentBuffers: [Buffer, Buffer] | undefined;
  for (let i = 0; i < source_files.length; i++) {
    if (process.env._stop == 'stop') { break; }
    let contentWasCompared = false;
    let file = source_files[i];
    let sourcePath = file
    // A replacer function rather than `target` itself: as a plain replacement string, "$&", "$$" etc. inside a
    // directory name would be interpreted as String.replace's own special patterns instead of literal characters.
    let targetPath = file.replace(source, () => target)

    // getAllFiles/getAllFilesSet list an empty directory as a single trailing-backslash entry. It counts as backed
    // up as soon as that directory exists in the target, whatever it contains there (a non-empty target directory
    // is listed as its own contents, never as this entry, so the entry lookup alone would miss it). It never gets
    // the mtime/size comparison below either - it has no content to compare, and a directory's own mtime only
    // records when it was created or had entries added/removed.
    const isEmptyDirectoryEntry = file[file.length - 1] == '\\';

    let b = target_files.has(targetPath)
    if (!b && target_keys.has(targetPath.toLowerCase())) {
      // Same name in a different letter case. Whether that is the same entry is the filesystem's call, not ours:
      // on a default (case-insensitive) NTFS folder it is, in a case-sensitive directory or share it is not.
      // Asking it (one stat, only for these rare case-mismatched names) is right in both.
      try {
        fs.lstatSync(targetPath);
        b = true;
      } catch (error) {
        b = false;
      }
    }
    if (!b && isEmptyDirectoryEntry) {
      try {
        // Without the trailing backslash, and lstat: a link at that path is not the directory.
        b = fs.lstatSync(trimTrailingBackslash(targetPath)).isDirectory();
      } catch (error) {
        b = false; // no such directory in the target
      }
    }
    if (!b) {
      source_only.push(file); // source only
    } else if (!isEmptyDirectoryEntry) {
      // One lstatSync call per side, reused for both the mtime and size comparisons below - this used to be 4
      // statSync calls (2 per path) every time a file exists on both sides, which is the common case for a real
      // incremental backup (most files are already backed up and unchanged).
      const sourceStats = fs.lstatSync(sourcePath);
      const targetStats = fs.lstatSync(targetPath);
      let differs: boolean;
      if (sourceStats.isSymbolicLink() || targetStats.isSymbolicLink()) {
        // A link is the same only as a link pointing to the same place. What it points to is never compared.
        differs = !(sourceStats.isSymbolicLink() && targetStats.isSymbolicLink() && linkTargetText(sourcePath) === linkTargetText(targetPath));
      } else if (sourceStats.isDirectory() !== targetStats.isDirectory()) {
        // A file on one side and a folder on the other, found through a name that differs only in letter case - see
        // NameClash for how the copy resolves it.
        differs = true;
      } else {
        differs = comparison === 'source-newer-or-different-size'
          ? (sourceStats.mtime > targetStats.mtime) || (sourceStats.size != targetStats.size)
          : (Math.abs(sourceStats.mtimeMs - targetStats.mtimeMs) > MIRROR_MTIME_TOLERANCE_MS) || (sourceStats.size != targetStats.size);
      }
      if (!differs && comparison === 'any-difference-or-content' && sourceStats.isFile() && sourceStats.size > 0) {
        // Size and mtime say "unchanged" - the bytes are the only thing left that can still differ. Sizes are
        // equal here, so haveSameContent's chunk-by-chunk comparison is well defined.
        contentBuffers = contentBuffers || [Buffer.allocUnsafe(CONTENT_COMPARE_CHUNK_BYTES), Buffer.allocUnsafe(CONTENT_COMPARE_CHUNK_BYTES)];
        differs = !(await haveSameContent(sourcePath, targetPath, contentBuffers));
        contentWasCompared = true;
      }
      if (differs) {
        source_only.push(file); // modified (or, for the 'any-difference' modes, different in any way)
      } // else: backed up - not included
    }
    // Yielding (and reporting progress) only every SCAN_PROGRESS_REPORT_INTERVAL items, not every single one -
    // process.env._stop is still checked every iteration above (cheap, no yield needed for that alone), but a
    // real setImmediate round-trip per item would turn a fast in-memory comparison over a very large tree
    // (hundreds of thousands of files) into one dominated by event-loop scheduling overhead instead.
    // Always also reported on the very last item, even if it doesn't land on the interval - otherwise, whenever
    // source_files.length isn't an exact multiple of SCAN_PROGRESS_REPORT_INTERVAL, the final "(i of N)" a
    // caller ever sees falls short of N, and a caller driving a percentage bar off of it (see LoadingDialogComponent)
    // would visibly stop short of 100% right as this phase actually finishes.
    // After every file whose contents were read as well, not just every SCAN_PROGRESS_REPORT_INTERVAL items: that
    // read can take long enough (a big file) for a bar that only moved every 25 items to look frozen. Reporting
    // is cheap - the log buffer sends at most a few batches a second regardless of how often it is pushed to.
    const isLastItem = i === source_files.length - 1;
    if ((i + 1) % SCAN_PROGRESS_REPORT_INTERVAL === 0 || isLastItem || contentWasCompared) {
      if (onProgress) { onProgress(`Comparing items (${i + 1} of ${source_files.length})`); }
      await holdOn();
    }
  }
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


/** Copies (doCopy) or previews every path diff reported, one at a time - see insertBranch.
 *  @param nameClash see NameClash (ipc.interfaces.ts). */
const createTree = async function (sourceOnlyPaths: Array<string>, doCopy: boolean, source: string, target: string, nameClash?: NameClash): Promise<void> {
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
    insertBranch(tree, tokens, 0, doCopy, source, target, nameClash);
    // A dedicated progress marker, on top of insertBranch's own descriptive lines above (which don't map 1:1 to
    // items - a copy can log a size-tier line plus a "copied/updated" line, a directory logs its own separate
    // "will create"/"created" line, etc.) - callers who already know sourceOnlyPaths.length up front (every one
    // does - it's an array they built themselves) can turn this into a real percentage without having to count
    // or make sense of the descriptive lines. Same "(i of N)" convention computeSha256ForBackedUpFiles/
    // verifyFileHashes already use, so parseProgressFromLine (shared/utils) handles all of them uniformly.
    logsBuffer.push(`Processed item (${index + 1} of ${sourceOnlyPaths.length})`);
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
    // See the identical marker in createTree's own loop - same "(i of N)" convention, so any caller that
    // already knows pathsMarkedForDeletion.length up front can derive a real percentage from it.
    logsBuffer.push(`Processed item (1 of ${pathsMarkedForDeletion.length})`);
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
        let exists_in_master = isRealDirectoryAt(mp);

        // No longer a folder in the target: the copy phase replaced it with a file of the template's (see NameClash).
        if (isRealDirectoryAt(tp)) {
          // Replace any trailing '\' characters. This is because the listing does not add '\' to the end of a directory path.
          subTreeContents = subTreeContents.map((d)=>{return d.replace(/\\+$/, "");});
          let dirContents = listEntriesWithoutFollowingLinks(tp);
          if(!commit && !exists_in_master && sameMembers(subTreeContents, dirContents)){
            logsBuffer.push("will delete directory :" + tp)
          }else if(commit && !exists_in_master && dirContents.length==0){
            fs.rmdirSync(tp)
            logsBuffer.push("deleted directory :" + tp);
          }
        }

        tokens_diff_slice.pop();
      }
    }
    insertBranchForDirSyncDeletions(tree, tokens, 0, commit, target, source);
    logsBuffer.push(`Processed item (${index + 1} of ${pathsMarkedForDeletion.length})`);
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
      // Not a folder in the target any more: see the same check in the loop above.
      if(dir_name && isRealDirectoryAt(full_path_to_be_checked_target)){
        let subTree = getSubTree(tree, tokens.concat([dir_name]))
        let dir_exists_in_master = isRealDirectoryAt(full_path_to_be_checked_master);

        let dir_emptied_in_target: boolean;
        dir_emptied_in_target = (sameMembers(
          getContentsFromTree(subTree).map((d)=>{return d.replace(/\\+$/, "");}),
          listEntriesWithoutFollowingLinks(full_path_to_be_checked_target)));

        if(!commit && !dir_exists_in_master && dir_emptied_in_target){
          logsBuffer.push("will delete directory :"+ full_path_to_be_checked_target);
        }else if(commit && !dir_exists_in_master && fs.readdirSync(full_path_to_be_checked_target).length==0){
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

/** True if `absolutePath` is an existing regular file (a directory, a missing path, or one that cannot be stat'ed
 *  are all false). */
const isFileAt = function (absolutePath: string): boolean {
  try {
    return fs.statSync(absolutePath).isFile();
  } catch (error) {
    return false;
  }
}

/** fs.lstatSync (describes a link itself, not what it points to), or null if nothing is at `absolutePath`. */
const lstatOrNull = function (absolutePath: string): any | null {
  try {
    return fs.lstatSync(absolutePath);
  } catch (error) {
    return null;
  }
}

/** True if `absolutePath` (a trailing backslash is allowed) is a real directory - not a link to one. */
const isRealDirectoryAt = function (absolutePath: string): boolean {
  return lstatOrNull(trimTrailingBackslash(absolutePath))?.isDirectory() === true;
}

/** Every entry below `dirPath`, as paths relative to it joined with '\' - like fs.readdirSync(dirPath, { recursive:
 *  true }), except that a link (symbolic link or junction) is listed as one entry and never looked inside, the
 *  same way diff's scans treat it. (Node's recursive readdir does look inside junctions.) */
const listEntriesWithoutFollowingLinks = function (dirPath: string, prefix: string = ''): string[] {
  const entries: string[] = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    entries.push(prefix + entry.name);
    if (entry.isDirectory()) {
      entries.push(...listEntriesWithoutFollowingLinks(node_path_module.join(dirPath, entry.name), prefix + entry.name + '\\'));
    }
  }
  return entries;
}

const insertBranchForDirSyncDeletions = function (
tree: any, tokens: Array<string>, index: number, commit: boolean, target: string, source: string): void {
  if ((tokens.length - index) == 1) {
    if (tokens[index] != '') {
      let path_suffix = createPath(tokens, index)
      let source_path = source + path_suffix
      let target_path = target + path_suffix
      if (lstatOrNull(source_path) !== null) {
        // Never delete a target entry that the template directory also has, as the filesystem sees it - the copy
        // phase has already made it match. "Synchronize directories" removes every file it is about to copy from its
        // deletion list, but by exact name: on a case-insensitive filesystem (NTFS) a file that was renamed in
        // letter case only AND changed is "REPORT.TXT" in the copy list and "report.txt" in the deletion list -
        // one and the same file - and deleting it here would delete what the copy phase just wrote. On a
        // case-sensitive filesystem those are two different files, the template has no "report.txt", and the
        // deletion goes ahead. Likewise a link in the target where the template has a folder: the copy phase
        // has replaced that link with the folder. Not added to `tree` either, since `tree` records what gets deleted.
        return;
      }
      const existingTarget = lstatOrNull(target_path);
      if (existingTarget === null) {
        // Already gone: the copy phase replaced the folder it was in with a file of the template's (see NameClash).
        return;
      }
      tree[tokens[index]] = null;
      // A link is deleted as the link itself (unlinkSync never follows it) - what it points to is left alone.
      const kind = existingTarget.isSymbolicLink() ? 'link' : 'file';
      if (commit) {
        fs.unlinkSync(target_path);
        logsBuffer.push(`deleted ${kind} :` + target_path);
      } else {
        logsBuffer.push(`will delete ${kind} :` + target_path);
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

/** fs.copyFileSync, except that an existing target file the copy is refused for - on Windows one marked read-only
 *  (a copy of a read-only file is itself read-only) or hidden while the source is not; on Linux one without write
 *  permission - is deleted and the copy made again. */
const copyFileReplacingProtectedTarget = function (sourcePath: string, targetPath: string): void {
  try {
    fs.copyFileSync(sourcePath, targetPath);
  } catch (error: any) {
    if ((error?.code !== 'EPERM' && error?.code !== 'EACCES') || !isFileAt(targetPath)) { throw error; }
    fs.unlinkSync(targetPath);
    fs.copyFileSync(sourcePath, targetPath);
  }
}

/** Makes `targetPath` a link pointing where the link at `sourcePath` points - the same text, so a relative link
 *  stays relative. Nothing it points to is read or copied. A link to a folder given by its full path is made a
 *  junction, which Windows lets anyone create; any other link has to be a symbolic link, which Windows lets only
 *  administrators create unless Developer Mode is on. On Linux every link is a symbolic link. A link that points to
 *  nothing (what it pointed to was deleted) does not say whether that was a folder; given by its full path, it is
 *  made a junction - that is what such a link on Windows almost always is. */
const copyLink = function (sourcePath: string, targetPath: string): void {
  const pointsTo = fs.readlinkSync(sourcePath);
  let pointsToFolder: boolean | null = null;
  try {
    pointsToFolder = fs.statSync(sourcePath).isDirectory();
  } catch (error) {
    // points to nothing that exists
  }
  const type = (pointsToFolder !== false && node_path_module.isAbsolute(pointsTo)) ? 'junction' : (pointsToFolder ? 'dir' : 'file');
  try {
    fs.symlinkSync(pointsTo, targetPath, type);
  } catch (error: any) {
    if (error?.code === 'EPERM' && process.platform === 'win32') {
      throw new Error(`Could not create the link "${targetPath}" (a copy of the link "${sourcePath}"): Windows lets only administrators create this kind of link, unless Developer Mode is turned on.`);
    }
    throw error;
  }
}

/** Copies (doCopy) or previews one path from diff: creates the folders on its way that the target lacks, then copies
 *  the file - or, if the source has a link there, the link itself (copyLink). Never writes through a link in the
 *  target: a link where a folder is needed, or where a file or link is being copied, is removed first (only the
 *  link - what it points to is left alone), so everything created stays inside the target. A real folder where a
 *  file or link is being copied, or a file where a folder is needed, is dealt with by resolveNameClash. */
const insertBranch = function (tree: any, tokens: Array<string>, index: number, doCopy: boolean, source: string, target: string, nameClash?: NameClash): void {
  if ((tokens.length - index) == 1) {
    tree[tokens[index]] = {}
    // Create file OR directory
    if (tokens[index] != '') {
      let path_suffix = createPath(tokens, index)
      let target_path = target + path_suffix
      let source_path = source + path_suffix
      let existingTarget = lstatOrNull(target_path);
      const sourceIsLink = lstatOrNull(source_path)?.isSymbolicLink() === true;
      const kind = sourceIsLink ? 'link' : 'file';
      if (existingTarget && existingTarget.isDirectory()) {
        // A real folder where the source has a file or a link (lstat: a link to a folder is not a directory here).
        resolveNameClash(target_path, 'folder', nameClash, doCopy);
        existingTarget = null;
      }
      if (doCopy) {
        if (existingTarget && (existingTarget.isSymbolicLink() || (sourceIsLink && existingTarget.isFile()))) {
          fs.unlinkSync(target_path);
        }
        if (sourceIsLink) {
          copyLink(source_path, target_path);
        } else {
          copyFileReplacingProtectedTarget(source_path, target_path);
        }
        if(existingTarget){
          logsBuffer.push(`updated existing ${kind} :` + target_path);
        }else{
          logsBuffer.push(`copied ${kind} :` + target_path);
        }
      } else {
        if(existingTarget){
          logsBuffer.push(`will update existing ${kind} :` + target_path);
        }else{
          logsBuffer.push(`will copy ${kind} :` + target_path);
        }
      }
    }
  } else {
    if (!tree.hasOwnProperty(tokens[index])) {
      tree[tokens[index]] = {}
      // Create directory (only)
      let path_suffix = createPath(tokens, index)
      let target_path = target + path_suffix
      let existingTarget = lstatOrNull(target_path);
      if (existingTarget && !existingTarget.isDirectory() && !existingTarget.isSymbolicLink()) {
        // A file where the source has a folder.
        resolveNameClash(target_path, 'file', nameClash, doCopy);
        existingTarget = null;
      }
      if (existingTarget === null || existingTarget.isSymbolicLink()) {
        if (doCopy) {
          if (existingTarget) { fs.unlinkSync(target_path); } // a link where the source has a folder
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
    insertBranch(tree[a], tokens, index, doCopy, source, target, nameClash);
  }
}

/** A name that is a folder in the target where the source has a file or a link, or a file where the source has a
 *  folder: makes room at `targetPath` for the source's entry the way `nameClash` says (see NameClash) - or, with no
 *  `nameClash` (recovery), throws an error naming the clash. With doCopy false it only says what it would do. */
const resolveNameClash = function (targetPath: string, existing: 'folder' | 'file', nameClash: NameClash | undefined, doCopy: boolean): void {
  const incoming = existing === 'folder' ? 'a file' : 'a folder';
  if (nameClash === 'replace') {
    if (doCopy) {
      // A link inside the folder is removed as the link itself - rmSync never follows one.
      fs.rmSync(targetPath, { recursive: true, force: true });
      logsBuffer.push(`replaced existing ${existing} with ${incoming} :` + targetPath);
    } else {
      logsBuffer.push(`will replace existing ${existing} with ${incoming} :` + targetPath);
    }
  } else if (nameClash === 'keep-both') {
    const asidePath = nameToSetAside(targetPath, existing);
    if (doCopy) {
      fs.renameSync(targetPath, asidePath);
      logsBuffer.push(`renamed existing ${existing} to "${node_path_module.basename(asidePath)}" :` + targetPath);
    } else {
      logsBuffer.push(`will rename existing ${existing} to "${node_path_module.basename(asidePath)}" :` + targetPath);
    }
  } else {
    throw new Error(`"${targetPath}" is a ${existing}, but ${incoming} with that name has to be copied there.`);
  }
}

/** "<path> (old folder)" / "<path> (old file)" - or, if that is taken, "<path> (old folder 2)", 3, ... */
const nameToSetAside = function (targetPath: string, existing: 'folder' | 'file'): string {
  for (let n = 1; ; n++) {
    const candidate = `${targetPath} (old ${existing}${n > 1 ? ' ' + n : ''})`;
    if (lstatOrNull(candidate) === null) { return candidate; }
  }
}

/** The request's nameClash, if it is one of NameClash's values. */
const asNameClash = function (value: any): NameClash | undefined {
  return value === 'replace' || value === 'keep-both' ? value : undefined;
}


//-----------

const insertBranch_for_IBB_creation = function (tree: any, tokens: Array<string>, index: number, source: string, target: string, logs: string[], sessionId: string): void {
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
         These splits are stored in this job's own session subfolder under the temp data directory (see
         SESSION_FOLDER_NAME_PATTERN's own comment). Thus the full path to this split (part file) is created
         using a different 'source'. Here we take care of this case. If the fileFullSourcePath = source + target_path.slice(1);
         does not exist, then try using the temp directory path as the source dir. */
      if (!fs.existsSync(fileFullSourcePath)) {
        const configJSON = fs.readFileSync(node_path_module.join(__dirname, `../../appData/config.json`));
        // resolveTempDataDirectoryPath, not a raw path.join of the config value - see its doc comment for why
        // (cacheDataDirectoryPath can be an absolute path pointing anywhere on disk). node_path_module.join is
        // used (rather than string concatenation) to combine it with target_path.slice(1) so this is correct
        // regardless of whether either piece happens to have a leading/trailing separator.
        let tempDataDirectoryPath = resolveTempDataDirectoryPath(JSON.parse(configJSON));
        fileFullSourcePath = node_path_module.join(tempDataDirectoryPath, sessionId, target_path.slice(1));
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
        dirFullSourcePath = node_path_module.join(tempDataDirectoryPath, sessionId, target_path.slice(1));
      }
      logs.push(`D|${dirName}|${dirParentInOpticalDiskFileStructure}|${dirFullSourcePath}`)

    }
    let a = tokens[index]
    index += 1
    insertBranch_for_IBB_creation(tree[a], tokens, index, source, target, logs, sessionId);
  }
}


/** Launches ImgBurn (configured via config.json's imgBurnExecutablePath) against an already-written .ibb
 *  project file - shared by createIBB_file (right after writing a brand new one) and
 *  openExistingIBBFileInImgBurn (reopening one from an earlier send, completely unchanged) so there is a
 *  single place that knows how ImgBurn is actually invoked. Deliberately not awaited by either caller - both
 *  only need ImgBurn to have been STARTED, never for the user to have finished with it, before they themselves
 *  report back as done (see the matching comment on the component side, e.g. createIBB_file in
 *  backup-to-optical-media.component.ts).
 *
 *  Because neither caller waits for this, a failure to START ImgBurn (a missing or wrong imgBurnExecutablePath in
 *  config.json, or the executable not being launchable) cannot be part of either caller's response - both have
 *  already resolved by then. It is reported with console.error instead, which shows the user a dialog through
 *  the dedicated 'app-error' channel (see the logging notes near the top of this file): a message pushed on the
 *  request/response channel after the response had already been delivered would arrive when nothing is
 *  listening any more, or be mistaken for a reply to whatever request happens to be in flight.
 *
 *  ImgBurn exiting with a non-zero code AFTER it started is not a launch failure (the user may just have closed
 *  it, or a burn failed inside ImgBurn's own window, which tells them itself) - that is only logged. */
const invokeImgBurnOnIBBFile = async function (pathToIBBFile: string): Promise<void> {
  const util = require('util');
  const exec = util.promisify(require('child_process').exec);
  let imgBurnExecutablePath: string | undefined;
  try {
    const configJSON = fs.readFileSync(node_path_module.join(__dirname, `../../appData/config.json`));
    imgBurnExecutablePath = JSON.parse(configJSON).imgBurnExecutablePath;
  } catch (error) {
    console.error('ImgBurn could not be started: the app configuration (appData\\config.json) could not be read.', error);
    return;
  }
  if (!imgBurnExecutablePath || typeof imgBurnExecutablePath !== 'string' || !fs.existsSync(imgBurnExecutablePath)) {
    console.error(`ImgBurn could not be started: "${imgBurnExecutablePath}" does not exist. Check imgBurnExecutablePath in appData\\config.json.`);
    return;
  }

  try {
    // The .ibb path is quoted like the executable's: it lives under the temp directory, which sits inside the app
    // folder (or wherever config.json's cacheDataDirectoryPath points), and either can contain spaces.
    const { stdout, stderr } = await exec(`"${imgBurnExecutablePath}" /MODE BUILD /SRC "${pathToIBBFile}"`);
    console.log('stdout:', stdout);
    console.log('stderr:', stderr);
  } catch (error) {
    // Left uncaught this would be an unhandled promise rejection (nobody awaits this function - see above).
    const message = error && (error as any).message ? (error as any).message : String(error);
    if (typeof (error as any)?.code === 'number') {
      // The process ran and exited with this code.
      console.warn(`ImgBurn exited with code ${(error as any).code}.`, message);
    } else {
      // No exit code at all: the process could not be started (or was killed before it could run).
      console.error('ImgBurn could not be started.', message);
    }
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
const createIBB_file = async function(disk_id: number, paths: Array<string>, sourcePath: string, sessionId: string, volumeLabel?: string){
  assertValidSessionId(sessionId);
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
    insertBranch_for_IBB_creation(tree, tokens, 0, sourcePath, target, logs, sessionId);
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
  // This job's own session subfolder (see SESSION_FOLDER_NAME_PATTERN's own comment) - created here explicitly
  // (recursive - it may not exist yet) rather than assuming createOpticalMediaDiscPartials already created
  // it, since a disc made up entirely of ordinary files never calls that function's own directory-creating path.
  const sessionDirectoryPath = node_path_module.join(ownership.path, sessionId);
  fs.mkdirSync(sessionDirectoryPath, { recursive: true });
  const pathToIBBFile = node_path_module.join(sessionDirectoryPath, `Disk_${disk_id + 1}.ibb`);

  await saveIBB_toDisk(pathToIBBFile, pathTo_IBB_Template, [
    { regEx: /\[START_BACKUP_LIST\]/g, dataToInsert: ["[START_BACKUP_LIST]"].concat(logs).join('\r\n') },
    { regEx: /VolumeLabel_UDF=/, dataToInsert: 'VolumeLabel_UDF=' + resolvedVolumeLabel }
  ]).then(() => {
      // Now the IBB file has been created. Open ImgBurn using this file as source list.
      invokeImgBurnOnIBBFile(pathToIBBFile);
  }).catch(err => {
    console.log(err);
  });

  return logs
}

/** Checks whether this exact disc (disk_id, within this job's own session subfolder - see
 *  SESSION_FOLDER_NAME_PATTERN's own comment) already has a Disk_<disk_id+1>.ibb file from an earlier send -
 *  i.e. "Send to ImgBurn" is being clicked again for a disc that was already sent once before, during this
 *  same job - and if so, just reopens ImgBurn on that EXACT SAME, already-built project file, rather than
 *  recomputing anything (the disc's selection, its created split partials, the cold storage metadata JSON
 *  entry, or the .ibb file itself).
 *
 *  This matters because redoing the whole pipeline on a resend used to risk disagreeing with the first send:
 *  which already-created "surplus" split-partial sliver(s) are still unclaimed (see the capacity check in
 *  sendToImgBurn/pendingOverflowPartials in both wizard components) can change between two sends of the same
 *  disc, since other discs may have been sent in between and absorbed some of them. A resend that recomputed
 *  its own selection could then end up with a DIFFERENT surplus partial than the first send did, silently
 *  orphaning the first send's own partial (never referenced again, so confirmDiscBurned would never delete it).
 *  Reopening the untouched .ibb file sidesteps this entirely - nothing is recomputed, so there is nothing that
 *  can disagree with the first send.
 *
 *  Returns `{opened: false, ...}` - not an error - when no such file exists yet; the caller is expected to fall
 *  back to the normal, full pipeline in that case, which is always true for a disc's first send. */
const openExistingIBBFileInImgBurn = async function (sessionId: string, disk_id: number): Promise<{ opened: boolean, message: string }> {
  assertValidSessionId(sessionId);
  const ownership = await ensureTempDataDirectoryIsAppOwned();
  if (!ownership.ok) {
    return { opened: false, message: 'Refusing to look for an existing .ibb file: ' + ownership.message };
  }

  const pathToIBBFile = node_path_module.join(ownership.path, sessionId, `Disk_${disk_id + 1}.ibb`);
  if (!fs.existsSync(pathToIBBFile)) {
    return { opened: false, message: 'No existing .ibb file found for this disc yet - this must be its first send.' };
  }

  invokeImgBurnOnIBBFile(pathToIBBFile);
  return { opened: true, message: 'Reopened the existing .ibb file for this disc in ImgBurn, unchanged.' };
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
      case 'match-letter-case':
        matchLetterCase(asScanRoot(trimTrailingBackslash(arg.params.source)), asScanRoot(trimTrailingBackslash(arg.params.target)),
          arg.params.commit === true).then((renames) => {
          ipc.sendResponseToMain({ key: 'match-letter-case', res: renames, status: 'completed' });
        }).catch((err) => {
          ipc.sendResponseToMain({ key: 'match-letter-case', res: err, status: 'error' });
        });
        break;
      case 'compare-folders':
        logsBuffer.setChannel('compare-folders');
        compareFolders(asScanRoot(trimTrailingBackslash(arg.params.source)), asScanRoot(trimTrailingBackslash(arg.params.target)),
          (line) => logsBuffer.push(line)).then((result) => {
          logsBuffer.flush();
          ipc.sendResponseToMain({ key: 'compare-folders', res: result, status: 'completed' });
        }).catch((err) => {
          ipc.sendResponseToMain({ key: 'compare-folders', res: err, status: 'error' });
        });
        break;
      case 'diff':
        console.log("(worker) in diff")
        logsBuffer.setChannel('diff');
        diff(arg.params.source, arg.params.target, (line) => logsBuffer.push(line),
          (arg.params.comparison === 'any-difference' || arg.params.comparison === 'any-difference-or-content') ? arg.params.comparison : undefined,
          arg.params.skipUnreadable === true).then((d)=>{
          logsBuffer.flush(); // whatever remained in the buffer
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
        createTree(arg.params.sourceOnlyPaths, /*doCopy=*/false, arg.params.source, arg.params.target, asNameClash(arg.params.nameClash)).then((res)=>{
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
        createTree(arg.params.sourceOnlyPaths, /*doCopy=*/true, arg.params.source, arg.params.target, asNameClash(arg.params.nameClash)).then((res) => {
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
        logsBuffer.setChannel('partition-backup-to-optical-media');
        partitionBackupToOpticalMedia(arg.params.rootPath, arg.params.mediaCapacityInBytes, arg.params.splitLargeFiles, arg.params.sessionId, arg.params.filesMetadata, (line) => logsBuffer.push(line), arg.params.skipUnreadable === true).then((d)=>{
          logsBuffer.flush(); // whatever remained in the buffer
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
        createIBB_file(arg.params.disk_id, arg.params.paths, arg.params.sourcePath, arg.params.sessionId, arg.params.volumeLabel).then((d)=>{
          if(process.env._stop != "stop"){
            ipc.sendResponseToMain({ key: 'create-IBB-file', res: d, status: "completed" });
          }else{
            ipc.sendResponseToMain({ key: 'create-IBB-file', res: d, status: "stopped" });
          }
        }).catch((err)=>{
          ipc.sendResponseToMain({ key: 'create-IBB-file', res: err, status: "error" });
        });
        break;
      case 'open-existing-ibb-file':
        console.log("(worker) in open-existing-ibb-file")
        openExistingIBBFileInImgBurn(arg.params.sessionId, arg.params.disk_id).then((d)=>{
          ipc.sendResponseToMain({ key: 'open-existing-ibb-file', res: d, status: "completed" });
        }).catch((err)=>{
          ipc.sendResponseToMain({ key: 'open-existing-ibb-file', res: err, status: "error" });
        });
        break;
      case 'create-optical-media-disc-partials':
        console.log("(worker) in create-optical-media-disc-partials")
        createOpticalMediaDiscPartials(arg.params.dirPath, arg.params.paths, arg.params.sessionId).then((d)=>{
          if(process.env._stop != "stop"){
            ipc.sendResponseToMain({ key: 'create-optical-media-disc-partials', res: d, status: "completed" });
          }else{
            ipc.sendResponseToMain({ key: 'create-optical-media-disc-partials', res: d, status: "stopped" });
          }
        }).catch((err)=>{
          ipc.sendResponseToMain({ key: 'create-optical-media-disc-partials', res: err, status: "error" });
        });
        break;
      case 'compute-sha256-for-backed-up-files':
        console.log("(worker) in compute-sha256-for-backed-up-files")
        logsBuffer.setChannel('compute-sha256-for-backed-up-files');
        computeSha256ForBackedUpFiles(arg.params.dirPath, arg.params.paths, arg.params.sessionId).then((d)=>{
          if(process.env._stop != "stop"){
            ipc.sendResponseToMain({ key: 'compute-sha256-for-backed-up-files', res: d, status: "completed" });
          }else{
            ipc.sendResponseToMain({ key: 'compute-sha256-for-backed-up-files', res: d, status: "stopped" });
          }
        }).catch((err)=>{
          ipc.sendResponseToMain({ key: 'compute-sha256-for-backed-up-files', res: err, status: "error" });
        });
        break;
      case 'verify-file-hashes':
        console.log("(worker) in verify-file-hashes")
        logsBuffer.setChannel('verify-file-hashes');
        verifyFileHashes(arg.params.files).then((d)=>{
          if(process.env._stop != "stop"){
            ipc.sendResponseToMain({ key: 'verify-file-hashes', res: d, status: "completed" });
          }else{
            ipc.sendResponseToMain({ key: 'verify-file-hashes', res: d, status: "stopped" });
          }
        }).catch((err)=>{
          // A plain string, not the raw Error object - see the identical fix/comment on 'read-json-from-disk'.
          const message = err && err.message ? err.message : String(err);
          ipc.sendResponseToMain({ key: 'verify-file-hashes', res: message, status: "error" });
        });
        break;
      case 'delete-partials-for-disc':
        console.log("(worker) in delete-partials-for-disc")
        deletePartialsForDisc(arg.params.partialAbsolutePaths).then((d)=>{
          ipc.sendResponseToMain({ key: 'delete-partials-for-disc', res: d, status: "completed" });
        }).catch((err)=>{
          ipc.sendResponseToMain({ key: 'delete-partials-for-disc', res: err, status: "error" });
        });
        break;
      case 'delete-recovered-failed-files':
        console.log("(worker) in delete-recovered-failed-files")
        deleteRecoveredFailedFiles(arg.params.failedAbsolutePaths, arg.params.targetDirectory).then((d)=>{
          ipc.sendResponseToMain({ key: 'delete-recovered-failed-files', res: d, status: "completed" });
        }).catch((err)=>{
          ipc.sendResponseToMain({ key: 'delete-recovered-failed-files', res: err, status: "error" });
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
      case 'get-effective-optical-medium-capacity':
        console.log("(worker) in get-effective-optical-medium-capacity")
        getEffectiveOpticalMediumCapacityInBytes(arg.params.rawCapacityInBytes).then((d)=>{
          ipc.sendResponseToMain({ key: 'get-effective-optical-medium-capacity', res: d, status: "completed" });
        }).catch((err)=>{
          ipc.sendResponseToMain({ key: 'get-effective-optical-medium-capacity', res: err, status: "error" });
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
          // A plain string, not the raw Error object - callers reject with just this (see readJSONfromDisk in
          // worker-communicator.ts's 'response.res' rejectPayload) and show it directly in a dialog, which
          // otherwise stringified the whole wrapping response object into an unhelpful "[object Object]".
          const message = err && err.message ? err.message : String(err);
          ipc.sendResponseToMain({ key: 'read-json-from-disk', res: message, status: "error" });
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
        logsBuffer.setChannel('get-file-paths-with-stats');
        // Resets any stale `stop` left over from a previously canceled operation BEFORE the probe runs, not
        // just before the real scan (getAllFilePathsWithStats's own first statement does that part) - otherwise
        // countAllFilesQuick's own stop-check (it has no reset of its own - a mid-probe cancel must still work)
        // would immediately break out and return 0, permanently freezing this scan's progress at "(0 of 0)".
        process.env._stop = 'NoStop';
        // Probes the real total upfront (see countAllFilesQuick) so this scan reports a real "(i of N)"
        // percentage (parseScanItemsProgress, shared/utils) instead of an open-ended running count.
        // asScanRoot: the disc readers pass a bare drive ("E:"), which would otherwise mean "the current directory
        // on drive E" rather than the disc's root. skipUnreadable is only sent for a backup SOURCE (see
        // scanMasterDirectoryWithProgress in add-missing-files-to-optical-media-cold-storage.component.ts) - a disc
        // that cannot be read completely must fail, since its ID is a hash of everything on it.
        const scanRoot = asScanRoot(arg.params.dirPath);
        const skippedWhileScanning: SkippedScanEntry[] | undefined = arg.params.skipUnreadable === true ? [] : undefined;
        countAllFilesQuick(scanRoot).then((total) => {
          return getAllFilePathsWithStats(scanRoot, [], (count) => logsBuffer.push(`Scanning items (${Math.min(count, total)} of ${total})`), skippedWhileScanning);
        }).then((d)=>{
          if (skippedWhileScanning) { reportSkippedScanEntries(skippedWhileScanning); }
          logsBuffer.flush(); // whatever remained in the buffer
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
        logsBuffer.setChannel('get-file-paths');
        // Resets any stale `stop` left over from a previously canceled operation - unlike
        // getAllFilePathsWithStats, getAllFiles itself never resets this, so without this line a stale flag
        // would break BOTH the new countAllFilesQuick probe (permanently freezing progress at "(0 of 0)") AND
        // the real scan right after it (immediately returning an empty result).
        process.env._stop = 'NoStop';
        // Probes the real total upfront (see countAllFilesQuick) so this scan reports a real "(i of N)"
        // percentage (parseScanItemsProgress, shared/utils) instead of an open-ended running count.
        // asScanRoot - see the same call in 'get-file-paths-with-stats' above.
        const sourceDirRoot = asScanRoot(arg.params.sourceDir);
        countAllFilesQuick(sourceDirRoot).then((total) => {
          return getAllFiles(sourceDirRoot, [], (count) => logsBuffer.push(`Scanning items (${Math.min(count, total)} of ${total})`));
        }).then((d)=>{
          logsBuffer.flush(); // whatever remained in the buffer
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
      case 'check-temp-data-directory-for-leftovers':
        console.log("(worker) in check-temp-data-directory-for-leftovers")
        checkTempDataDirectoryForLeftovers().then((d)=>{
          ipc.sendResponseToMain({ key: 'check-temp-data-directory-for-leftovers', res: d, status: "completed" });
        }).catch((err)=>{
          ipc.sendResponseToMain({ key: 'check-temp-data-directory-for-leftovers', res: err, status: "error" });
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
