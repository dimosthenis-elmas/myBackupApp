/** Matches this app's own large-file split volumes (e.g. "video.mp4.part.001") - the renderer-side mirror of
 *  worker.ts's own PART_FILE_PATTERN. Can't import the worker-side constant directly: worker.ts is Node-side
 *  code with its own require()s and is not meant to be pulled into the renderer bundle, so this is a separate,
 *  deliberately identical reimplementation (escaped dots, case-insensitive) of the same ".part.NNN" convention -
 *  kept in this one shared place so every renderer-side call site that needs it imports the same regex instead
 *  of each re-typing its own copy, which would only need to silently drift once for confirm/cleanup matching to
 *  quietly break. */
export const PART_FILE_PATTERN = /\.part\.\d+$/i;
