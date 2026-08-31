import { Injectable } from '@angular/core';

// If you import a module but never use any of the imported values other than as TypeScript types,
// the resulting javascript file will look as if you never imported the module at all.
import { ipcRenderer, webFrame } from 'electron';
import * as childProcess from 'child_process';
import * as fs from 'fs';

@Injectable({
  providedIn: 'root'
})
export class ElectronService {
  ipcRenderer!: typeof ipcRenderer;
  webFrame!: typeof webFrame;
  childProcess!: typeof childProcess;
  fs!: typeof fs;

  constructor() {
    // Conditional imports
    // window.require is only present when nodeIntegration's globals leak into the page's own context, which
    // does not happen with contextIsolation: true (see the isElectron getter below) - so on the app window as
    // currently configured, this is never available. Guarded rather than removed in case contextIsolation is
    // ever turned off again: nothing else currently reads ipcRenderer/webFrame/fs/childProcess off this
    // service (they were only ever used for the debug logging in AppComponent's constructor), so silently
    // skipping this is safe.
    if (this.isElectron && typeof (window as any).require === 'function') {
      this.ipcRenderer = (window as any).require('electron').ipcRenderer;
      this.webFrame = (window as any).require('electron').webFrame;

      this.fs = (window as any).require('fs');

      this.childProcess = (window as any).require('child_process');
      this.childProcess.exec('node -v', (error, stdout, stderr) => {
        if (error) {
          console.error(`error: ${error.message}`);
          return;
        }
        if (stderr) {
          console.error(`stderr: ${stderr}`);
          return;
        }
        console.log(`stdout:\n${stdout}`);
      });

      // Notes :
      // * A NodeJS's dependency imported with 'window.require' MUST BE present in `dependencies` of both `app/package.json`
      // and `package.json (root folder)` in order to make it work here in Electron's Renderer process (src folder)
      // because it will loaded at runtime by Electron.
      // * A NodeJS's dependency imported with TS module import (ex: import { Dropbox } from 'dropbox') CAN only be present
      // in `dependencies` of `package.json (root folder)` because it is loaded during build phase and does not need to be
      // in the final bundle. Reminder : only if not used in Electron's Main process (app folder)

      // If you want to use a NodeJS 3rd party deps in Renderer process,
      // ipcRenderer.invoke can serve many common use cases.
      // https://www.electronjs.org/docs/latest/api/ipc-renderer#ipcrendererinvokechannel-args
    }
  }

  get isElectron(): boolean {
    // window.process is only populated when nodeIntegration's globals leak into the page's own context - with
    // contextIsolation: true (as main.ts sets on the app window), they deliberately do not, so this check was
    // always false in a packaged/production run. window.electronAPI, exposed via contextBridge in preload.js
    // regardless of contextIsolation, is the reliable signal that we're running inside this Electron app.
    return !!(window && (window as any).electronAPI);
  }
}
