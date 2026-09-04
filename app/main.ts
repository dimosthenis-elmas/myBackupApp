import { app, BrowserWindow, dialog, ipcMain, screen } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { Dialog } from '@angular/cdk/dialog';


let win: BrowserWindow | null = null;
let winWorker: BrowserWindow;

// The renderer can start sending 'message-to-worker' IPC as soon as its own Angular app bootstraps (e.g.
// AppComponent's ngOnInit, which runs the startup config check). The worker window is created around the same
// time but loads worker.html asynchronously, and its preload script only starts listening for
// 'message-from-main' once that finishes. Without this queue, any message sent to the worker before that point
// is silently dropped by webContents.postMessage (there is no error, no delivery, nothing) - the renderer's
// corresponding IPC promise then just hangs forever with no timeout, which looks like "the app did nothing".
let winWorkerReady = false;
let pendingMessagesToWorker: any[] = [];

const args = process.argv.slice(1),
  serve = args.some(val => val === '--serve');

/** Resolves the real, currently-loadable index.html - as a file:// URL - for the non-dev-server case (both
 *  createWindow and the did-fail-load handler need this identical logic, so it lives in one place instead of
 *  being duplicated).
 *
 *  app.isPackaged is checked FIRST and is the only branch a real packaged build (release/win-unpacked or wherever
 *  that folder is later copied/installed to - see the portable installer) actually needs: process.resourcesPath
 *  is Electron's own install-location-independent way to find the app's bundled resources, and extraResources
 *  in package.json's "build" config copies the compiled Angular frontend there (resources/dist/index.html) for
 *  exactly this reason - a path guessed relative to __dirname (inside app.asar) would only resolve correctly if
 *  the packaged folder never moved from wherever it was built, which breaks the moment it's copied or installed
 *  anywhere else. If extraResources is misconfigured and resources/dist/index.html doesn't exist, this warns
 *  and falls through to the dev-mode fallback below, which won't find a real index.html either in a moved
 *  packaged build and ends up loading a blank window.
 *
 *  app.isPackaged is false for every other way this app gets launched (npm run electron:local, npm run e2e,
 *  every worker-ipc/ui test script's launchApp() - all of which run app/main.js directly, unpacked, straight
 *  from the repo, never through app.asar), so this whole branch is skipped for all of them - the dev-mode
 *  fallback below handles those cases directly. */
function resolveIndexHtmlUrl(): string {
  if (app.isPackaged) {
    const packagedIndexHtml = path.join(process.resourcesPath, 'dist', 'index.html');
    if (fs.existsSync(packagedIndexHtml)) {
      return new URL(path.join('file:', packagedIndexHtml)).href;
    }
    console.warn(`Packaged build, but "${packagedIndexHtml}" does not exist - falling back to relative-path guessing. This should not happen if extraResources is configured correctly; the window will likely load blank.`);
  }

  // Dev-mode / unpacked-straight-from-the-repo path (unchanged from before app.isPackaged was added above).
  let pathIndex = '../src/index.html';
  console.log(__dirname)
  // ng build always outputs to <repo>/dist (see angular.json's outputPath) - this is the actual location of
  // the real compiled bundle when running unpacked directly from the repo (npm run electron:local, npm run
  // e2e, or any other launch of app/main.js straight from the checked-out repo, rather than a packaged
  // build). Checked first since it's the one location here that's actually been verified to exist and be
  // correct - see the other branch's own comment for the packaged-build case this doesn't touch.
  if (fs.existsSync(path.join(__dirname, '../dist/index.html'))) {
    pathIndex = '../dist/index.html';
  } else if (fs.existsSync(path.join(__dirname, '../../../index.html'))) {
     // Path when running electron in local folder
    pathIndex = '../../../index.html';
  }
  return new URL(path.join('file:', __dirname, pathIndex)).href;
}

function createWindow(): BrowserWindow {
  // Reset worker-readiness state in case a window is being (re)created after the first one (e.g. macOS
  // 'activate' with no windows open) - each worker window needs its own did-finish-load before it's safe to
  // deliver messages to it.
  winWorkerReady = false;
  pendingMessagesToWorker = [];

  const size = screen.getPrimaryDisplay().workAreaSize;

  // Create the browser window.
  win = new BrowserWindow({
    x: 0,
    y: 0,
    width: size.width,
    height: size.height,
    webPreferences: {
      nodeIntegration: true,
      allowRunningInsecureContent: (serve),
      contextIsolation: true,
      //note this is a .js file. A better approach for the future would be to use a .ts file instead.
      preload: path.join(__dirname, '../app/workers/preload/preload.js')
    },
  });


  // create worker window (visible in both dev and packaged builds - see the "Do not hide the worker window"
  // request)
  winWorker = new BrowserWindow({
    show: true,
    webPreferences: {
      nodeIntegration: true,
      allowRunningInsecureContent: (serve),
      contextIsolation: true,
      //note this is a .js file. A better approach for the future would be to use a .ts file instead.
      preload: path.join(__dirname, '../app/workers/worker.js')
    }
  });

  winWorker.loadFile(path.join(__dirname, '../app/workers/worker.html'));
  //Debug
  winWorker.webContents.openDevTools();

  // See the winWorkerReady/pendingMessagesToWorker comment above: only start delivering messages once the
  // worker window has actually finished loading and its own message listener is guaranteed to be attached.
  winWorker.webContents.once('did-finish-load', () => {
    winWorkerReady = true;
    const queued = pendingMessagesToWorker;
    pendingMessagesToWorker = [];
    queued.forEach((payload) => sendWindowMessage(winWorker, 'message-from-main', payload));
  });

  winWorker.on('closed', () => {
    // The worker window is required infrastructure, not a closable auxiliary window (see "Do not hide the
    // worker window" above) - every backup/recovery operation is delegated to it over IPC. It's still a normal,
    // visible BrowserWindow though, so the user can close it directly. Reset winWorkerReady so 'message-to-worker'
    // queues instead of calling webContents.postMessage on this now-destroyed window (which throws synchronously
    // inside the ipcMain handler and would otherwise leave the renderer's IPC promise hanging forever - the same
    // hang class as the bugs fixed above, just triggered by an early close instead of a late-arriving message).
    // Since the app can't do anything without a worker, close the main window too, same as the reverse direction
    // below.
    winWorkerReady = false;
    if (win) { win.close(); }
  })

  if (serve) {
    const debug = require('electron-debug');
    debug();

    require('electron-reloader')(module);
    win.loadURL('http://localhost:4200');
  } else {
    win.loadURL(resolveIndexHtmlUrl());
  }

  // Emitted when the window is closed.
  win.on('closed', () => {
    // Dereference the window object, usually you would store window
    // in an array if your app supports multi windows, this is the time
    // when you should delete the corresponding element.
    win = null;
    // Guard against the worker window having already been closed by the user (see its own 'closed' handler
    // above) - calling .close() on an already-destroyed BrowserWindow throws "Object has been destroyed".
    if (winWorker && !winWorker.isDestroyed()) { winWorker.close(); }
  });

  //Without this block the window.location.reload(); in reloadAppAndGoToMainMenu does not work.
  win.webContents.on('did-fail-load', () => {
    if (win) { win.loadURL(resolveIndexHtmlUrl()); }
  })

  return win;
}


function sendWindowMessage(targetWindow: BrowserWindow, message: string, payload: any) {
  if (typeof targetWindow === 'undefined' || targetWindow.isDestroyed()) {
    console.log('Target window does not exist');
    return;
  }
  targetWindow.webContents.postMessage(message, payload);
}


try {
  // This method will be called when Electron has finished
  // initialization and is ready to create browser windows.
  // Some APIs can only be used after this event occurs.
  // Added 400 ms to fix the black background issue while using transparent window. More detais at https://github.com/electron/electron/issues/15947
  app.on('ready', () => setTimeout(createWindow, 400));

  // Quit when all windows are closed.
  app.on('window-all-closed', () => {
    // On OS X it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    // On OS X it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (win === null) {
      createWindow();
    }
  });

  app.whenReady().then(() => {
    ipcMain.handle('dialog', (event, method: "showOpenDialog", params) => {
      return dialog[method](params);
    });
  });

  ipcMain.on('message-to-worker', (event, arg) => {
    if (winWorkerReady) {
      sendWindowMessage(winWorker, 'message-from-main', arg);
    } else {
      // Worker window isn't done loading yet - queue it rather than dropping it silently. Flushed by the
      // 'did-finish-load' handler above, in the order received.
      pendingMessagesToWorker.push(arg);
    }
  });
  ipcMain.on('response-to-main', (event, arg) => {
    win?.webContents.send('message-from-worker', arg);
  });

  // Used by AppComponent's startup checks (e.g. checkTempDataDirectoryOwnership) to close the app outright
  // after showing a blocking error dialog the user can only acknowledge with "Ok" - there is no in-app way to
  // recover from those particular errors (they require editing config.json outside the app), so continuing to
  // run the rest of the UI would be misleading.
  ipcMain.on('quit-app', () => {
    app.quit();
  });

} catch (e) {
  // Catch Error
  // throw e;
}
