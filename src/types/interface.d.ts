
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
    // SHA-256 hex digest of this exact physical entry's bytes (a split large file's .partNNN piece is hashed as
    // itself, never the whole reassembled original). Always present for anything backed up by a current version
    // of the app (SHA-256 integrity data is mandatory, not a toggle) - optional here only for backward
    // compatibility with older cold storage JSONs written before this feature existed, where it's absent.
    "sha256"?: string;
    // Only on a link (symbolic link or junction) backed up to a disc: it is burned as a Windows shortcut
    // "<link name>.lnk" (this entry's path), and this is where the link - and so the shortcut - points.
    "linkTarget"?: string;
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