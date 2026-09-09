export type WorkerChannel =
"diff" | "incremental-preview" | "incremental-copy-files" | "unknown-channel" |
"stop" | "test" | "get-paths-and-stats" | "partition-backup-to-optical-media" |
"create-IBB-file" | "wait-for-optical-disk-to-be-mounted" | "get-file-paths" |
"delete-files-and-dirs-for-dir-sync" | 'get-temp-data-directory-path' | 'get-file-paths-with-stats' |
"read-json-from-disk" | "write-json-to-disk" | "merge-file-parts" | "clear-temp-data-directory" |
"validate-config-paths" | "update-config" | "ensure-temp-directory-ownership" |
"create-optical-media-disc-partials" | "delete-partials-for-disc" |
"get-effective-optical-medium-capacity" | "check-temp-data-directory-for-leftovers" |
"open-existing-ibb-file" | "imgburn-launch-failed" |
"compute-sha256-for-backed-up-files" | "verify-file-hashes";

export interface WorkerRequest {
  key: WorkerChannel;
  params: any;  
}

export interface WorkerResponse {
  key: WorkerChannel;
  res: any;
  status: "stopped" | "completed" | "running" | "error"
}

export interface WorkerListener {
  removeListener: ()=>void;
}

export type ColdStorageMetadata =
  // "sha256" is optional - present per file when the "File integrity data" option was set to SHA-256 at backup
  // time, absent entirely for older cold storage JSONs and for anything backed up with that option set to
  // None. Never present on a directory entry.
  Array<Array<{"path": string, "stats": {"size": number, "mtime": Date, "isDirectory": boolean, "sha256"?: string}}>>

export type OpticalMediaPartitioning<WorkerResponse> = {
  [K in keyof WorkerResponse]:
            K extends 'res' ? 
              ColdStorageMetadata :
              WorkerResponse[K]
}