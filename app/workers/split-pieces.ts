/** Names of the pieces a large file is split into for discs - shared by the worker (planning, splitting, reassembling)
 *  and the wizards (ticking pieces together, finding what is missing, recovery), so both always agree.
 *
 *  A piece is named "<file>.outOf.<total>.part.<number>" - e.g. "video.mp4.outOf.23.part.001", piece 1 of 23. Every
 *  piece says how many pieces its file has, so the metadata JSON (or the discs themselves) shows whether all pieces of
 *  a file were burned, and "Add missing files" can burn the ones still missing in a later session. The pieces are
 *  7-Zip volumes, and the name ends as 7-Zip's own volume names do (".001", ".002", ...), so 7-Zip opens them directly.
 *  7-Zip's own names - "<file>.part.<number>", which splitting produces before the pieces get their total - are also
 *  what discs burned before the total was added hold. */

/** The ending of a piece's name, with or without its total. */
export const PIECE_ENDING = /(?:\.outOf\.\d+)?\.part\.\d+$/i;

const PIECE = /^([\s\S]*?)(?:\.outOf\.(\d+))?\.part\.(\d+)$/i;

export interface Piece {
  /** The name or path given, without the piece's ending - the file's name or path. */
  file: string;
  /** How many pieces the file has - undefined for a name without it (7-Zip's own, or a disc burned before). */
  total: number | undefined;
  number: number;
  /** The number as written in the name ("001"). */
  numberText: string;
}

/** `nameOrPath` read as a piece, or null if it is not one. */
export function parsePiece(nameOrPath: string): Piece | null {
  const match = PIECE.exec(nameOrPath);
  if (!match || match[1] === '' || match[1].endsWith('\\')) { return null; }
  return { file: match[1], total: match[2] === undefined ? undefined : Number(match[2]), number: Number(match[3]), numberText: match[3] };
}

/** The name of piece `numberText` of `total` of `file` (a name or a path). */
export function pieceName(file: string, total: number, numberText: string): string {
  return `${file}.outOf.${total}.part.${numberText}`;
}

/** `nameOrPath` without a piece's total: the same for piece N of a file, whatever total its name says - a planned
 *  piece's total is an estimate, and the real one can be one more (see createOpticalMediaDiscPartials). Anything
 *  else is returned as it is. */
export function withoutPieceTotal(nameOrPath: string): string {
  const piece = parsePiece(nameOrPath);
  return piece ? `${piece.file}.part.${piece.numberText}` : nameOrPath;
}

/** The numbers from 1 to `total` that are not among `numbers`. */
export function missingPieceNumbers(total: number, numbers: Iterable<number>): number[] {
  const present = new Set(numbers);
  const missing: number[] = [];
  for (let n = 1; n <= total; n++) {
    if (!present.has(n)) { missing.push(n); }
  }
  return missing;
}
