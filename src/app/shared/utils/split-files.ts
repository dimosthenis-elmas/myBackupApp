import { PIECE_ENDING } from '../../../../app/workers/split-pieces';

/** The large file `path` is a split piece of, written the same way whatever form the piece's path has: a planned
 *  piece carries the path of this job's temp session folder ("...\session-123\Videos\big.mkv.outOf.3.part.001"), a
 *  sent one does not ("Videos\big.mkv.outOf.3.part.001") - both give "Videos\big.mkv". Null if `path` is not a split
 *  piece. */
export function splitFileOf(path: string, sessionId: string): string | null {
  if (!PIECE_ENDING.test(path)) { return null; }
  const sessionFolder = '\\' + sessionId + '\\';
  const inSessionFolder = path.lastIndexOf(sessionFolder);
  const relativePath = inSessionFolder >= 0 ? path.slice(inSessionFolder + sessionFolder.length) : path;
  return relativePath.replace(/^\\+/, '').replace(PIECE_ENDING, '');
}

/** "disc 3", "discs 1 and 3", "discs 1, 2 and 3". */
export function discsLabel(numbers: number[]): string {
  return numbers.length <= 1 ? `disc ${numbers.join('')}` : `discs ${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`;
}
