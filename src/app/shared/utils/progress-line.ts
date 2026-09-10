/** Extracts the progress marker createTree, deleteFilesAndDirsForDirSync, and diff's own comparison phase (all
 *  in worker.ts) push once per item processed - "Processed item (N of M)" and "Comparing items (N of M)" - so a
 *  caller can turn those lines into a current/total pair without a separate structured progress channel.
 *  Returns null for anything else, including every other descriptive line those same operations already push
 *  (e.g. "will copy file: <path>") - those lines embed real file/directory paths, which could otherwise
 *  contain something that merely LOOKS like "(1 of 2)" (a common photo/scan folder naming convention) and be
 *  misread as a progress marker; anchoring to the exact literal prefix and the full line (^...$) rules that
 *  out, since neither prefix is something worker.ts's own descriptive lines ever start with. */
export function parseProgressFromLine(line: string): { current: number, total: number } | null {
  const m = line.match(/^(?:Processed item|Comparing items) \((\d+) of (\d+)\)$/);
  return m ? { current: Number(m[1]), total: Number(m[2]) } : null;
}
