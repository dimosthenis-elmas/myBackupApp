/** True if `folderPath` is the root of a drive - "D:\" (what the folder picker returns for a whole drive), or "D:". */
export function isDriveRoot(folderPath: string): boolean {
  return /^[A-Za-z]:[\\/]?$/.test(folderPath);
}
