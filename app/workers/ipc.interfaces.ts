export type WorkerChannel =
"diff" | "incremental-preview" | "incremental-copy-files" | "unknown-channel" |
"stop" | "partition-backup-to-optical-media" |
"create-IBB-file" | "wait-for-optical-disk-to-be-mounted" | "get-file-paths" |
"delete-files-and-dirs-for-dir-sync" | 'get-temp-data-directory-path' | 'get-file-paths-with-stats' |
"read-json-from-disk" | "write-json-to-disk" | "merge-file-parts" | "clear-temp-data-directory" |
"validate-config-paths" | "update-config" | "ensure-temp-directory-ownership" |
"create-optical-media-disc-partials" | "delete-partials-for-disc" |
"get-effective-optical-medium-capacity" | "check-temp-data-directory-for-leftovers" |
"open-existing-ibb-file" |
"compute-sha256-for-backed-up-files" | "verify-file-hashes" | "delete-recovered-failed-files" |
"compare-folders" | "match-letter-case" | "recovery-folder-state";

/** How the worker's `diff` decides that a file which exists on both sides has to be reported (entries missing from
 *  the target altogether are always reported):
 *   - 'source-newer-or-different-size' (the default - what Cumulative backup uses): the source copy has a newer
 *     mtime or a different size, i.e. it was modified since it was backed up. A target copy that is newer is left
 *     alone. Not symmetric: diff(a, b) and diff(b, a) do not agree on which existing files are "modified".
 *   - 'any-difference' (Synchronize directories' delete-list call): the mtimes differ by more than a small
 *     tolerance in EITHER direction, or the sizes differ - the target has to end up matching the source, so a
 *     newer target copy counts as a difference too. Symmetric: a file that exists on both sides is reported by
 *     diff(a, b) exactly when it is reported by diff(b, a).
 *   - 'any-difference-or-content' (Synchronize directories' copy-list call): everything 'any-difference' reports,
 *     plus a file whose size and mtime match but whose BYTES differ. It reads both copies of every file that
 *     otherwise looks unchanged, so it is far slower - only worth it when the target has to match exactly. It is
 *     only needed on the copy side: the delete list may contain anything the copy list also contains (sync removes
 *     that overlap), and 'any-difference' never reports more than this mode does. */
export type DiffComparison = 'source-newer-or-different-size' | 'any-difference' | 'any-difference-or-content';

/** What incremental-copy-files (and its preview) does when a name is a file in the source but a folder in the target,
 *  or the other way round:
 *   - 'replace' (Synchronize directories - the target has to match the source): the target's folder (with
 *     everything in it) or file is deleted, and the source's entry copied in its place.
 *   - 'keep-both' (Cumulative backup - never deletes anything): the target's entry is renamed to
 *     "<name> (old folder)" / "<name> (old file)" (with a number added if that name is taken too), and the source's
 *     entry copied under the original name.
 *  Left out (recovery), the copy stops with an error naming the clash. */
export type NameClash = 'replace' | 'keep-both';

export interface WorkerRequest {
  key: WorkerChannel;
  params: any;  
}

export interface WorkerResponse {
  key: WorkerChannel;
  res: any;
  status: "stopped" | "completed" | "running" | "error"
  /** How many links (symbolic links and junctions) the request's scan left out - only on a completed diff,
   *  partition-backup-to-optical-media or get-file-paths-with-stats; see leaveOutLink in worker.ts. */
  linksLeftOut?: number;
}

export interface WorkerListener {
  removeListener: ()=>void;
}

export type ColdStorageMetadata =
  // "sha256" is optional on this type - every file backed up by a current version of the app always gets one
  // (SHA-256 integrity data is mandatory, not a toggle), but the field stays optional here for backward
  // compatibility with cold storage JSONs written before this feature existed, where it's absent entirely.
  // Never present on a directory entry.
  // "path" is where the entry is on its disc; "originalPath" (same "D:\" form) only when that differs from where it
  // was in the folder backed up - its name, or a folder's on its way, was too long for a disc (see disc-names.ts).
  // "originalNamesList" marks the disc's own list of those original names (ORIGINAL_NAMES_FILE_NAME), not a file
  // of the user's.
  Array<Array<{"path": string, "stats": {"size": number, "mtime": Date, "isDirectory": boolean, "sha256"?: string},
    "originalPath"?: string, "originalNamesList"?: boolean}>>

/** What the worker's create-IBB-file made (createIBB_file in worker.ts): the .ibb project's F|/D| lines; for each
 *  of the requested paths whose name (or a folder's on its way) was too long for a disc, its path on the disc; and,
 *  when there is any such path, the stats of the list of original names burned at the disc's root
 *  (ORIGINAL_NAMES_FILE_NAME in disc-names.ts) - for its entry in the metadata JSON. */
export interface CreatedIbbProject {
  lines: string[];
  discPaths: { [relativePath: string]: string };
  originalNamesFile?: { size: number, mtime: Date, sha256: string };
}

export type OpticalMediaPartitioning<WorkerResponse> = {
  [K in keyof WorkerResponse]:
            K extends 'res' ? 
              ColdStorageMetadata :
              WorkerResponse[K]
}