/** Names on a disc, and what they are allowed to be - shared by the worker (the ImgBurn project, the list of original
 *  names) and the wizards (what to warn about, what to record in the metadata JSON), so both always agree.
 *
 *  ImgBurn builds each disc as ISO9660 + UDF 1.02 (FileSystem=3 in appData/IBB_TEMPLATE.ibb), and Windows reads the
 *  UDF side. There a file or folder name is at most 127 UTF-16 code units - a JavaScript string's length - since a
 *  name takes at most 254 bytes and Unicode names take 2 bytes a unit. ImgBurn cuts a longer name to 127 on its own,
 *  only noting it in its log: the disc then no longer matches the metadata JSON, and a cut through a character made of
 *  two units (an emoji) leaves a name Windows cannot open. So the app never hands ImgBurn a longer name - an item
 *  whose name is too long gets a shorter one on the disc (discName), only once the user has agreed, and the original
 *  is recorded. A whole path has no such limit on a disc: ImgBurn burns, and Windows reads back, paths of over 1,000
 *  characters. */

export const MAX_DISC_NAME_LENGTH = 127;

/** The longest full path - drive letter included ("E:\...") - that Windows Explorer and most other programs can
 *  open. The app itself reads and writes longer ones. */
export const MAX_OPENABLE_PATH_LENGTH = 259;

/** A split piece's own ending (the app's PART_FILE_PATTERN): kept whole when a piece's name is shortened, so the
 *  pieces of one file still read as that file's pieces. */
const PIECE_SUFFIX = /\.part\.\d+$/i;

/** The room a shortened piece's name keeps for its ending - one of up to 9999 pieces - so that every piece of a file
 *  gets the same shortened start, whatever its number. */
const PIECE_SUFFIX_ROOM = '.part.0000'.length;

/** The longest ending counted as an extension - which a shortened name keeps. */
const MAX_KEPT_EXTENSION_LENGTH = 16;

/** The file at the root of every disc that holds a shortened name: the original path of each item shortened on that
 *  disc (OriginalNamesFile), so recovering from the discs alone - without the metadata JSON - still puts the original
 *  names back. The metadata JSON records it like any other file of the disc, marked `originalNamesList`. */
export const ORIGINAL_NAMES_FILE_NAME = 'my-backup original names.json';

/** OriginalNamesFile's `format` - what tells this file apart from a file of the user's that happens to have its name. */
export const ORIGINAL_NAMES_FILE_FORMAT = 'my-backup original names, version 1';

export interface OriginalNamesFile {
  format: string;
  about: string;
  /** Each shortened item's path on the disc -> its path in the folder that was backed up. Both relative to the disc's
   *  root, "\"-separated; a folder's ends in "\". */
  originalPaths: { [discPath: string]: string };
}

/** The OriginalNamesFile for a disc whose items at `relativePaths` are burned under discPath(relativePath). */
export function originalNamesFileFor(relativePaths: string[]): OriginalNamesFile {
  const originalPaths: { [discPath: string]: string } = {};
  for (const p of relativePaths) {
    if (discPath(p) !== p) { originalPaths[discPath(p)] = p; }
  }
  return {
    format: ORIGINAL_NAMES_FILE_FORMAT,
    about: `Written by the my-backup app. A disc holds names of at most ${MAX_DISC_NAME_LENGTH} characters, so these ` +
      `items have a shorter name on this disc: each one's path on the disc, then its original path. Recovering with ` +
      `the app puts the original names back.`,
    originalPaths,
  };
}

/** `value` if it is an OriginalNamesFile (read back from a disc), otherwise undefined. */
export function asOriginalNamesFile(value: any): OriginalNamesFile | undefined {
  if (!value || value.format !== ORIGINAL_NAMES_FILE_FORMAT || !value.originalPaths || typeof value.originalPaths !== 'object') {
    return undefined;
  }
  const paths = Object.entries(value.originalPaths);
  return paths.every(([, original]) => typeof original === 'string') ? value as OriginalNamesFile : undefined;
}

/** 8 hex digits identifying `text` (32-bit FNV-1a over its UTF-16 code units) - the same for the same text, always. */
const shortCode = function (text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

/** `name` in at most `maxLength` units: its start, then "~" and shortCode(name), then its extension. Never ends its
 *  start in the middle of a character made of two units. */
const shortened = function (name: string, maxLength: number): string {
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && name.length - dot <= MAX_KEPT_EXTENSION_LENGTH ? name.slice(dot) : '';
  const tag = '~' + shortCode(name);
  let start = name.slice(0, maxLength - tag.length - extension.length);
  if (/[\uD800-\uDBFF]$/.test(start)) { start = start.slice(0, -1); }
  return start + tag + extension;
};

/** The name a file or folder named `name` gets on a disc: `name` itself when it is short enough, otherwise a
 *  shortened one - e.g. "End-to-End_Modeling_of_…~1f0c9a2e.pdf". A split piece keeps its ".part.NNN" ending, and all
 *  pieces of one file get the same shortened start. */
export function discName(name: string): string {
  if (name.length <= MAX_DISC_NAME_LENGTH) { return name; }
  const piece = PIECE_SUFFIX.exec(name);
  if (piece && piece.index > 0) {
    return shortened(name.slice(0, piece.index), MAX_DISC_NAME_LENGTH - Math.max(piece[0].length, PIECE_SUFFIX_ROOM)) + piece[0];
  }
  return shortened(name, MAX_DISC_NAME_LENGTH);
}

/** `relativePath` ("\"-separated, relative to the disc's root) with each folder and file name as it is on the disc. */
export function discPath(relativePath: string): string {
  return relativePath.split('\\').map(discName).join('\\');
}

/** The items among `relativePaths` whose own name is too long for a disc (discName shortens it): each once - a
 *  folder, not every file in it; a split file (its path without ".part.NNN"), not each of its pieces. */
export function itemsWithNamesTooLong(relativePaths: string[]): string[] {
  const items = new Set<string>();
  for (const p of relativePaths) {
    const names = p.split('\\');
    names.forEach((name, i) => {
      if (discName(name) === name) { return; }
      const item = names.slice(0, i + 1).join('\\');
      items.add(i === names.length - 1 ? item.replace(PIECE_SUFFIX, '') : item);
    });
  }
  return [...items];
}

/** The files among `relativePaths` whose full path on a disc - a drive such as "E:\", then discPath - is longer than
 *  MAX_OPENABLE_PATH_LENGTH; a split file once (its path without ".part.NNN"). */
export function filesWithPathsTooLongOnDisc(relativePaths: string[]): string[] {
  const driveLength = 'E:\\'.length;
  const files = new Set<string>();
  for (const p of relativePaths) {
    if (driveLength + discPath(p).length > MAX_OPENABLE_PATH_LENGTH) { files.add(p.replace(PIECE_SUFFIX, '')); }
  }
  return [...files];
}
