import { ColdStorageMetadata } from '../../../../app/workers/ipc.interfaces';
import { backedUpPath, isOriginalNamesList } from './shortened-names';

/** A cold storage metadata JSON with any empty entries at the very end removed - those are discs planned but never
 *  confirmed burned (the app was closed first), which carry no information and are dropped on load, so a saved JSON
 *  never ends in empty entries. An empty entry BEFORE a burned disc is left alone: it is what keeps that disc's
 *  number. Both wizards that write this JSON apply this right before every save, so no run of the app can leave a
 *  JSON ending in empty entries behind. */
export function trimTrailingEmptyDiscs(metadata: ColdStorageMetadata): ColdStorageMetadata {
  let end = metadata.length;
  while (end > 0 && metadata[end - 1].length === 0) { end--; }
  return metadata.slice(0, end);
}

/** Every backed-up file that `metadata` records on more than one disc, in the order first found - empty for a JSON
 *  the app wrote, since every disc of a cold storage holds different files. Only a JSON that was hand-edited or
 *  built by something else can name the same file twice, and the discs are what such a JSON misdescribes. The paths
 *  compared are the same ones the disc read compares (backedUpPath, so a shortened name is judged by the name the
 *  file has in the folder that was backed up, not the one it has on the disc).
 *
 *  A disc's own list of original names is left out: two discs that needed shortened names carry one each, at the
 *  same path on both (see ORIGINAL_NAMES_FILE_NAME in disc-names.ts), so those repeat legitimately and say nothing
 *  about the files. */
export function findFilePathsOnMoreThanOneDisc(metadata: ColdStorageMetadata): string[] {
  const seen = new Set<string>();
  const onMoreThanOneDisc: string[] = [];
  for (const disc of metadata || []) {
    for (const entry of disc || []) {
      if (isOriginalNamesList(entry)) { continue; }
      const path = backedUpPath(entry);
      if (seen.has(path)) {
        if (!onMoreThanOneDisc.includes(path)) { onMoreThanOneDisc.push(path); }
      } else {
        seen.add(path);
      }
    }
  }
  return onMoreThanOneDisc;
}
