import { PART_FILE_PATTERN } from './part-file-pattern';

/** The large file `path` is a split piece of, written the same way whatever form the piece's path has: a planned
 *  piece carries the path of this job's temp session folder ("...\session-123\Videos\big.mkv.part.001"), a sent one
 *  does not ("Videos\big.mkv.part.001") - both give "Videos\big.mkv". Null if `path` is not a split piece. */
export function splitFileOf(path: string, sessionId: string): string | null {
  if (!PART_FILE_PATTERN.test(path)) { return null; }
  const sessionFolder = '\\' + sessionId + '\\';
  const inSessionFolder = path.lastIndexOf(sessionFolder);
  const relativePath = inSessionFolder >= 0 ? path.slice(inSessionFolder + sessionFolder.length) : path;
  return relativePath.replace(/^\\+/, '').replace(PART_FILE_PATTERN, '');
}

/** The discs that are recorded in the cold storage metadata JSON together with `disc`: `disc` itself and every disc
 *  that holds a piece of the same split large file, directly or through another such disc. A split file can only be
 *  put back together from all of its pieces, so its discs are recorded all at once, never some of them.
 *  `discPaths[d]` is every path disc d holds, planned or sent (a sent disc can hold a piece it took on later - a
 *  "sliver"); `waitingPaths` are pieces that are on no disc yet. Returns the discs (sorted, `disc` included), the
 *  split files that link them, and which of those files still have a piece waiting for a disc. */
export function linkedDiscGroup(disc: number, discPaths: string[][], waitingPaths: string[], sessionId: string):
  { discs: number[], splitFiles: string[], waitingFiles: string[] } {
  const splitFilesOf = (paths: string[]) =>
    new Set(paths.map((p) => splitFileOf(p, sessionId)).filter((f): f is string => f !== null));
  const splitFilesOnDisc = discPaths.map((paths) => splitFilesOf(paths || []));
  const discs = new Set<number>([disc]);
  const splitFiles = new Set<string>();
  const discsToVisit = [disc];
  while (discsToVisit.length > 0) {
    const d = discsToVisit.shift()!;
    for (const file of splitFilesOnDisc[d] || []) {
      if (splitFiles.has(file)) { continue; }
      splitFiles.add(file);
      splitFilesOnDisc.forEach((files, other) => {
        if (files.has(file) && !discs.has(other)) {
          discs.add(other);
          discsToVisit.push(other);
        }
      });
    }
  }
  const waiting = splitFilesOf(waitingPaths);
  return {
    discs: [...discs].sort((a, b) => a - b),
    splitFiles: [...splitFiles].sort(),
    waitingFiles: [...splitFiles].filter((f) => waiting.has(f)).sort(),
  };
}

/** "disc 3", "discs 1 and 3", "discs 1, 2 and 3". */
export function discsLabel(numbers: number[]): string {
  return numbers.length <= 1 ? `disc ${numbers.join('')}` : `discs ${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`;
}

/** The message shown when a disc is confirmed burned but cannot be recorded in the metadata JSON yet, because a disc
 *  it shares a split file with is not confirmed, or a piece of one of those files is still waiting for a disc.
 *  `burnedNotRecorded` are the confirmed discs of the group (the one just confirmed included), `stillToBurn` the
 *  unconfirmed ones, `allDiscs` the whole group - all as the disc numbers the user labels them with. */
export function linkedDiscsNoticeMessage(burnedNotRecorded: number[], stillToBurn: number[], allDiscs: number[], waitingFileCount: number): string {
  const waitingPiece = waitingFileCount > 0
    ? `one piece of ${waitingFileCount === 1 ? 'a large file' : 'these large files'} is still waiting for a disc - it goes on the next disc you send, or on an extra disc once every disc has been sent`
    : '';
  const burnFirst = stillToBurn.length > 0
    ? `Don't close the app until you have also burned ${discsLabel(stillToBurn)} and confirmed ${stillToBurn.length === 1 ? 'it' : 'them'}` +
      (waitingPiece ? `; also, ${waitingPiece} - burn and confirm that disc too.` : '.')
    : `Don't close the app yet: ${waitingPiece} - burn and confirm that disc too.`;
  return `${burnFirst} If you close it before that, the app will re-plan ${discsLabel(burnedNotRecorded)}, which you have already ` +
    `burned: ${burnedNotRecorded.length === 1 ? 'it is' : 'they are'} not in the cold storage metadata JSON yet, so "Add missing ` +
    `files" would put ${burnedNotRecorded.length === 1 ? 'its' : 'their'} files on new discs. So note this down, in order not to ` +
    `burn the same disc twice.\n\nThis is because the large file(s) listed below are split into pieces across ` +
    `${discsLabel(allDiscs)}, and a split file can only be put back together from all of its pieces - so these discs are ` +
    `recorded in the JSON together, once all of them are confirmed burned.`;
}
