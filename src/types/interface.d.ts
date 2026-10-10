
export interface IElectronAPI {
  openDialog: (method: any, config: any) => Promise<any>,
  /** Registers `listener` on `channel` and returns the handle that removes it again via ipcRenderer_off. Removal
   *  deliberately does not go through the listener function itself: contextBridge hands the preload a fresh proxy
   *  for every crossing, so a function can never be matched back to what was registered (see contextBridge_api.js). */
  ipcRenderer_on: (channel: string, listener: (event: Electron.IpcRendererEvent, ...args: any) => void) => number,
  ipcRenderer_send: (channel: string, ...arg: any) => void,
  /** Removes the listener whose ipcRenderer_on call returned this handle. True if it removed one. */
  ipcRenderer_off: (handle: number) => boolean;
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
  };
  // Only in a cold storage metadata JSON entry - see ColdStorageMetadata (app/workers/ipc.interfaces.ts).
  "originalPath"?: string;
  "originalNamesList"?: boolean;
  // True only for a piece of a large file the app itself split across discs (see split-pieces.ts and
  // createOpticalMediaDiscPartials in worker.ts), or that scripts/repair-metadata-json.js has flagged in a legacy
  // JSON. This flag is the SOLE authority for "this entry is a split piece": nothing ever infers it from the
  // entry's name, so a plain file that merely looks like a piece ("report.part.001") is never mistaken for one.
  // Absent (never written false) on every other entry - an ordinary file, a directory, the list of original names.
  "isPartial"?: boolean;
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