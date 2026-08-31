export type WorkerChannel =
"diff" | "incremental-preview" | "incremental-copy-files" | "unknown-channel" |
"stop" | "test" | "get-paths-and-stats" | "partition-backup-to-optical-media" |
"create-IBB-file" | "wait-for-optical-disk-to-be-mounted" | "get-file-paths" |
"delete-files-and-dirs-for-dir-sync" | 'get-temp-data-directory-path' | 'get-file-paths-with-stats' |
"read-json-from-disk" | "write-json-to-disk" | "merge-file-parts" | "clear-temp-data-directory" |
"validate-config-paths" | "update-config" | "ensure-temp-directory-ownership";

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
  Array<Array<{"path": string, "stats": {"size": number, "mtime": Date, "isDirectory": boolean}}>>

export type OpticalMediaPartitioning<WorkerResponse> = {
  [K in keyof WorkerResponse]:
            K extends 'res' ? 
              ColdStorageMetadata :
              WorkerResponse[K]
}