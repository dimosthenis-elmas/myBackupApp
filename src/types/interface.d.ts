
export interface IElectronAPI {
  openDialog: (method: any, config: any) => Promise<any>,
  ipcRenderer_on: (channel: string, listener: (event: Electron.IpcRendererEvent, ...args: any) => void) => void,
  ipcRenderer_send: (channel: string, ...arg: any) => void,
  ipcRenderer_removeListener: (channel: string, listener: (event: any, ...arg: any) => void) => void;
  ipcRenderer_removeAllListeners: (channel?: string) => void;
  quitApp: () => void;

}

export interface filesMetadata {
  "path": string;
  "stats": {
    "size": number;
    "mtime": Date;
    "isDirectory": boolean;
    // Optional SHA-256 hex digest of this exact physical entry's bytes (a split large file's .partNNN piece is
    // hashed as itself, never the whole reassembled original). Present only when the "File integrity data"
    // option was set to SHA-256 at backup time - absent for older cold storage JSONs and for anything backed
    // up with that option set to None.
    "sha256"?: string;
  };
}

declare global {
  interface Window {
    electronAPI: IElectronAPI
  }
}

declare global {
  interface Set<T> {
      isSubsetOf<T>(other: ReadonlySet<unknown>): boolean,
      add(value: T): this;
      delete(value: T): boolean;
  }
}