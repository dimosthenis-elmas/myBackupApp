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

/** Strips a trailing "(i of N)" or "(i of N files)" counter - the same "(i of N)" convention as
 *  parseProgressFromLine above, just embedded at the end of a descriptive line instead of being the whole line
 *  (e.g. computeSha256ForBackedUpFiles/verifyFileHashes in worker.ts push "Calculating SHA-256 for file: <path>
 *  (3 of 42 files)") - leaving just the description (here, the file path). Callers bind the counter itself as
 *  its own live number (LoadingDialogComponent's `progressCurrent`/`progressTotal`, set directly from the
 *  caller's own already-known current/total) instead of re-displaying the whole sentence, counter included, on
 *  every single tick - otherwise the on-screen text is fully replaced dozens or hundreds of times a second for
 *  a large batch, instead of just the number changing in place. Returns the line unchanged if it has no such
 *  trailing counter. */
export function stripTrailingCounter(line: string): string {
  return line.replace(/ \(\d+ of \d+(?: files)?\)$/, '');
}

/** Same "(i of N)" convention as parseProgressFromLine above, for a scan phase (getAllFiles/getAllFilesSet/
 *  getAllFilePathsWithStats in worker.ts) that would otherwise only be able to report an open-ended running
 *  count - once countAllFilesQuick (worker.ts) has probed a real total upfront, e.g. diff()'s own "Scanning
 *  items (i of N)" pushes. Kept separate from parseProgressFromLine (rather than added as a third alternative
 *  there) since a caller generally needs to tell a scan phase apart from a comparison phase - e.g. to place
 *  each in a different half of one combined progress bar - which a shared regex alternation would lose. */
export function parseScanItemsProgress(line: string): { current: number, total: number } | null {
  const m = line.match(/^Scanning items \((\d+) of (\d+)\)$/);
  return m ? { current: Number(m[1]), total: Number(m[2]) } : null;
}

/** Same "(i of N)" convention as parseProgressFromLine/parseScanItemsProgress above, for
 *  partitionBackupToOpticalMedia's own bin-packing loop (worker.ts) - "Packing items (i of N)", reported once
 *  per disc it fills rather than once per file. Kept as its own parser (like parseScanItemsProgress) rather than
 *  folded into parseProgressFromLine, since a caller placing this in its own half of a combined progress bar
 *  (alongside that same call's own scan phase) needs to tell the two apart. */
export function parsePackingProgress(line: string): { current: number, total: number } | null {
  const m = line.match(/^Packing items \((\d+) of (\d+)\)$/);
  return m ? { current: Number(m[1]), total: Number(m[2]) } : null;
}
