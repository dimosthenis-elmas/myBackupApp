
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