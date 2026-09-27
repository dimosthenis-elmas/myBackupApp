/** The file name the save dialog suggests for a collection's metadata JSON: the collection's name - "My Backup" gives
 *  "My Backup.json", or with `suffix` " - updated", "My Backup - updated.json" - so two collections saved in the same
 *  folder never suggest the same file. Characters Windows does not allow in a name become "_". */
export function metadataJsonFileName(collectionName: string, suffix = ''): string {
  const name = collectionName.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
  return `${name || 'coldStorageMetadata'}${suffix}.json`;
}
