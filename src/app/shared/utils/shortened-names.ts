import { MatDialog } from '@angular/material/dialog';
import { ConfirmationDialogComponent } from '../components/confirmation-dialog/confirmation-dialog.component';
import { filesMetadata } from '../../../types/interface';
import { CreatedIbbProject } from '../../../../app/workers/ipc.interfaces';
import {
  itemsWithNamesTooLong, filesWithPathsTooLongOnDisc, asOriginalNamesFile, OriginalNamesFile,
  MAX_DISC_NAME_LENGTH, MAX_OPENABLE_PATH_LENGTH, ORIGINAL_NAMES_FILE_NAME,
} from '../../../../app/workers/disc-names';

/** Opens a dialog with `lists` and two buttons; resolves true for `continueLabel`, false for `cancelLabel` - the one
 *  focused, as what the dialog recommends. */
function askToContinue(dialog: MatDialog, title: string, message: string, lists: Array<{ label: string, items: string[] }>,
  continueLabel: string, cancelLabel: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const ref = dialog.open(ConfirmationDialogComponent, { maxWidth: '750px' });
    ref.disableClose = true;
    ref.componentInstance.title = title;
    ref.componentInstance.message = message;
    ref.componentInstance.lists = lists;
    ref.componentInstance.actionsNum = 2;
    ref.componentInstance.action1Label = continueLabel;
    ref.componentInstance.action1Callback = () => { ref.close(); resolve(true); };
    ref.componentInstance.action2Label = cancelLabel;
    ref.componentInstance.action2Callback = () => { ref.close(); resolve(false); };
  });
}

/** Before discs are burned: tells the user about every item among `relativePaths` (relative to the disc's root, as
 *  planned - a split piece's included) whose name is too long for a disc, then about every file whose path on the
 *  disc is too long for some programs - each in a dialog of its own, listing them all by their full path under
 *  `sourceRoot`. Both dialogs recommend cancelling and shortening the names in the user's own folder (then
 *  `howToRetry`); continuing is the other choice - shortened names on the disc only (see disc-names.ts), or long paths
 *  burned as they are. Resolves true only if the user continued past every dialog shown (none: true). */
export async function confirmDiscNameAndPathLimits(dialog: MatDialog, relativePaths: string[], sourceRoot: string, howToRetry: string): Promise<boolean> {
  const root = sourceRoot.endsWith('\\') ? sourceRoot : sourceRoot + '\\';
  const cancelLabel = `Cancel - I'll shorten them myself`;

  const namesTooLong = itemsWithNamesTooLong(relativePaths);
  const oneName = namesTooLong.length === 1;
  if (namesTooLong.length > 0 && !(await askToContinue(dialog, 'Names too long for a disc',
    `A disc allows names of up to ${MAX_DISC_NAME_LENGTH} characters. ${oneName ? 'This name is' : `These ${namesTooLong.length} names are`} ` +
    `longer.\n\n` +
    `Recommended: cancel, shorten ${oneName ? 'it' : 'them'} in your folder, then ${howToRetry}.\n\n` +
    `Or continue: ${oneName ? 'it gets' : 'they get'} a shorter name on the disc only, such as "…and_Conditio~1f0c9a2e.pdf". ` +
    `Your files are not changed, and recovering with this app restores the original names.`,
    [{ label: `Names over ${MAX_DISC_NAME_LENGTH} characters (${namesTooLong.length}):`, items: namesTooLong.map((p) => root + p) }],
    'Continue - shorten them on the disc', cancelLabel))) {
    return false;
  }

  const pathsTooLong = filesWithPathsTooLongOnDisc(relativePaths);
  const onePath = pathsTooLong.length === 1;
  if (pathsTooLong.length > 0 && !(await askToContinue(dialog, 'Paths too long for some programs',
    `On the disc, ${onePath ? 'this file' : `these ${pathsTooLong.length} files`} would have a path over ` +
    `${MAX_OPENABLE_PATH_LENGTH} characters (counting "E:\\"). The app handles that, but some programs cannot open a ` +
    `file with a path that long - on the disc, or wherever it is recovered to.\n\n` +
    `Recommended: cancel, shorten some folder or file names on the way to ${onePath ? 'it' : 'them'}, then ${howToRetry}.`,
    [{ label: `Paths over ${MAX_OPENABLE_PATH_LENGTH} characters on the disc (${pathsTooLong.length}):`, items: pathsTooLong.map((p) => root + p) }],
    'Continue - burn them as they are', cancelLabel))) {
    return false;
  }
  return true;
}

/** Before recovering: tells the user about every file among `relativePaths` whose recovered path - in `targetFolder` -
 *  would be too long for some programs to open, listing them all. Resolves 'recover' to go on,
 *  'choose-folder' when the user would rather pick a folder with a shorter path (the recommended choice), and
 *  'recover' at once when there is no such file. */
export async function confirmRecoveredPathLengths(dialog: MatDialog, relativePaths: string[], targetFolder: string): Promise<'recover' | 'choose-folder'> {
  const target = targetFolder.endsWith('\\') ? targetFolder : targetFolder + '\\';
  const tooLong = relativePaths.map((p) => target + p).filter((p) => p.length > MAX_OPENABLE_PATH_LENGTH);
  if (tooLong.length === 0) { return 'recover'; }
  const recover = await askToContinue(dialog, 'Paths too long for some programs',
    `Recovered into "${targetFolder}", ${tooLong.length === 1 ? 'this file' : `these ${tooLong.length} files`} would have ` +
    `a path over ${MAX_OPENABLE_PATH_LENGTH} characters. The app handles that, but some programs cannot open a file with ` +
    `a path that long.\n\n` +
    `Recommended: choose a folder with a shorter path, such as "D:\\Recovered".`,
    [{ label: `Paths over ${MAX_OPENABLE_PATH_LENGTH} characters (${tooLong.length}):`, items: tooLong }],
    'Continue - recover them here', 'Choose another folder');
  return recover ? 'recover' : 'choose-folder';
}

/** A disc's entries for the cold storage metadata JSON: `files` (sent to ImgBurn - relative paths, real stats and
 *  hashes) under `drive` (OPTICAL_DRIVE_LETTER_CONVENTION), each at its path on the disc, with its original path when
 *  that differs - both as `project` (what createIBB_file made) has them - plus the disc's list of original names, if
 *  it has one. */
export function metadataEntriesForDisc(files: filesMetadata[], project: CreatedIbbProject, drive: string): filesMetadata[] {
  const entries: filesMetadata[] = files.map((e) => Object.prototype.hasOwnProperty.call(project.discPaths, e.path)
    ? { path: drive + project.discPaths[e.path], stats: e.stats, originalPath: drive + e.path }
    : { path: drive + e.path, stats: e.stats });
  if (project.originalNamesFile) {
    const { size, mtime, sha256 } = project.originalNamesFile;
    entries.push({ path: drive + ORIGINAL_NAMES_FILE_NAME, stats: { size, mtime, isDirectory: false, sha256 }, originalNamesList: true });
  }
  return entries;
}

/** True if `relativePath` ("\"-separated; a folder's ending in "\") only goes down from where it starts: no drive, no
 *  "." or "..", no empty or invalid name. An original path is read from a metadata JSON or a disc, and recovery
 *  writes files there. */
function isPlainRelativePath(relativePath: string): boolean {
  const names = relativePath.split('\\');
  if (names[names.length - 1] === '' && names.length > 1) { names.pop(); }
  return names.length > 0 && names.every((name) => name !== '' && name !== '.' && name !== '..' && !/[<>:"/|?*\u0000-\u001f]/.test(name));
}

/** Where a metadata JSON `entry` was in the folder backed up: its originalPath when it has a usable one, otherwise its
 *  path - both in the "D:\" form of the JSON. */
export function backedUpPath(entry: filesMetadata): string {
  const drive = /^\w+:\\/;
  if (typeof entry.originalPath === 'string' && drive.test(entry.originalPath) && isPlainRelativePath(entry.originalPath.replace(drive, ''))) {
    return entry.originalPath;
  }
  return entry.path;
}

/** True if `entry` is a disc's list of original names (see disc-names.ts), not a file that was backed up. */
export function isOriginalNamesList(entry: filesMetadata): boolean {
  return entry.originalNamesList === true;
}

/** For a disc read directly (no metadata JSON): if `entries` (the disc's files, paths starting with a drive) hold a
 *  list of original names at the disc's root - `read` gives its content - marks it (originalNamesList) and gives
 *  each shortened entry its originalPath (same drive), as a metadata JSON has them. A file there of another kind is
 *  left an ordinary file. */
export async function applyOriginalNamesList(entries: filesMetadata[], read: (path: string) => Promise<any>): Promise<void> {
  const drive = (entries[0]?.path.match(/^\w+:\\/) || [''])[0];
  const listEntry = entries.find((e) => !e.stats.isDirectory && e.path.toLowerCase() === (drive + ORIGINAL_NAMES_FILE_NAME).toLowerCase());
  if (!drive || !listEntry) { return; }
  let list: OriginalNamesFile | undefined;
  try {
    list = asOriginalNamesFile(await read(listEntry.path));
  } catch (error) {
    return; // not readable as such a list - an ordinary file
  }
  if (!list) { return; }
  listEntry.originalNamesList = true;
  for (const entry of entries) {
    const onDisc = entry.path.slice(drive.length);
    if (Object.prototype.hasOwnProperty.call(list.originalPaths, onDisc)) {
      entry.originalPath = drive + list.originalPaths[onDisc];
    }
  }
}
