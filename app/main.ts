import { app, BrowserWindow, dialog, ipcMain, screen } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { pathToFileURL } from 'url';
import { Dialog } from '@angular/cdk/dialog';
import { appendToLogFile, installConsoleLogging, ReportedError, rotateAndWriteSessionHeader } from './logging';


let win: BrowserWindow | null = null;
let winWorker: BrowserWindow;

// ============================================================================
// ===== Logging: every console.log/warn/error in this process is appended to a
// ===== single logs.txt (see logging.ts), and every ERROR-level one is also
// ===== forwarded to the renderer as a plain-language summary to show as a
// ===== dialog (see forwardErrorToRenderer below and error-log.ts on the
// ===== renderer side) - full technical detail (stack traces, raw dumps) stays
// ===== in logs.txt and the dialog's collapsed "technical details" section,
// ===== never thrown at the user as the primary message. worker.ts uses the
// ===== same logging.ts to write to the same file and reports its own errors
// ===== over the 'app-error' IPC channel relayed below - together these three
// ===== sources (main, worker, renderer) are meant to cover everything that
// ===== used to only be visible in the worker window's DevTools console (see
// ===== that window's show/openDevTools gating further down, now off in
// ===== packaged builds).
// ============================================================================

/** Same appData folder worker.ts's own APP_DATA_DIRECTORY_PATH resolves (see that file's identical comment) -
 *  packaged builds keep it under resourcesPath (mirrors resolveIndexHtmlUrl's own app.isPackaged branch below),
 *  unpacked/dev runs keep it one level up from this file (app/main.js -> <repo>/appData). */
function resolveAppDataDirectoryPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'appData');
  }
  return path.resolve(__dirname, '../appData');
}

const LOG_FILE_PATH = path.join(resolveAppDataDirectoryPath(), 'logs.txt');
rotateAndWriteSessionHeader(LOG_FILE_PATH);

/** Sends an already-occurred error to the main window to show as a dialog (see error-log.ts's 'app-error'
 *  listener on the renderer side). Best-effort only - no-ops if the main window does not exist yet/anymore,
 *  which is why the uncaughtException/unhandledRejection handlers below additionally use dialog.showErrorBox
 *  (synchronous and native, so it works even when this can't). */
function forwardErrorToRenderer(reported: ReportedError): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send('app-error', { source: 'main', ...reported });
  }
}

// error vs warn is a real severity call at each existing console.error/console.warn call site throughout this
// codebase, not a stylistic choice - only error interrupts the user (see logging.ts's own comment on this).
installConsoleLogging('main', LOG_FILE_PATH, 'Something unexpected went wrong in the app.', forwardErrorToRenderer);

// Belt-and-suspenders for errors nobody wrote a try/catch for at all (as opposed to the many existing
// console.error calls throughout this codebase, which installConsoleLogging above already turns into
// dialogs+log lines without needing every one of them touched individually). dialog.showErrorBox is used here
// specifically (rather than relying only on forwardErrorToRenderer above) because it's synchronous, native, and
// works regardless of the renderer's state - the point of this handler is exactly the case where something has
// gone wrong badly enough that nothing else can be trusted to still be working.
const UNCAUGHT_ERROR_SUMMARY = 'Something unexpected went wrong in the app and it may need to be restarted.';

process.on('uncaughtException', (error) => {
  console.error(UNCAUGHT_ERROR_SUMMARY, error);
  dialog.showErrorBox('Unexpected error', UNCAUGHT_ERROR_SUMMARY + '\n\n' + (error.stack || String(error)));
});

process.on('unhandledRejection', (reason) => {
  console.error(UNCAUGHT_ERROR_SUMMARY, reason);
  dialog.showErrorBox('Unexpected error', UNCAUGHT_ERROR_SUMMARY + '\n\n' + (reason instanceof Error ? (reason.stack || reason.message) : String(reason)));
});

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
      // pathToFileURL (rather than gluing "file:" onto the path and parsing that) percent-encodes characters that
      // are legal in a Windows folder name but mean something in a URL - "#" would otherwise start a fragment and
      // cut the path short, "%" would be read as the start of an escape - so the app still loads from wherever
      // its folder was copied to.
      return pathToFileURL(packagedIndexHtml).href;
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
  return pathToFileURL(path.join(__dirname, pathIndex)).href;
}

/** Resolves the app's own icon - passed explicitly to both BrowserWindows below (main window and worker) as
 *  their `icon` option. Without this, BrowserWindow falls back to Electron's own generic default icon (a plain
 *  dark window silhouette, not this app's actual branding) for the taskbar/title bar - happens in dev for sure
 *  (there is no packaged .exe resource to inherit from at all there), and isn't guaranteed not to happen in a
 *  packaged build either.
 *
 *  Deliberately a PNG, not favicon.ico (which electron-builder's own win.icon config still uses, correctly, for
 *  the .exe's packaging resource - that's a separate code path from this one and was verified fine): passing a
 *  multi-frame .ico straight to BrowserWindow's `icon` option is a known Electron-on-Windows sore spot - it
 *  does not reliably parse/resize every embedded frame, and can end up handing Windows a naive crop of one
 *  frame instead of a properly scaled icon (the "cropped shield, only the top sliver shows" bug this fixes). A
 *  single clean PNG is what Electron's own nativeImage resizes correctly for the taskbar/title bar.
 *
 *  Same dual dev/packaged resolution as resolveIndexHtmlUrl above: packaged builds keep the whole dist/ folder
 *  under resourcesPath (extraResources' {from: "dist", to: "dist"} entry), unpacked/dev runs prefer the built
 *  dist/ copy if ng build has already produced one, falling back to the source file directly (guaranteed to
 *  exist even before a build has ever run, unlike dist/index.html). */
function resolveAppIconPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'dist', 'assets', 'icons', 'favicon.256x256.png');
  }
  const builtIconPath = path.join(__dirname, '../dist/assets/icons/favicon.256x256.png');
  if (fs.existsSync(builtIconPath)) {
    return builtIconPath;
  }
  return path.join(__dirname, '../src/assets/icons/favicon.256x256.png');
}

function createWindow(): BrowserWindow {
  // Reset worker-readiness state in case a window is being (re)created after the first one (e.g. macOS
  // 'activate' with no windows open) - each worker window needs its own did-finish-load before it's safe to
  // deliver messages to it.
  winWorkerReady = false;
  pendingMessagesToWorker = [];

  const size = screen.getPrimaryDisplay().workAreaSize;
  const appIconPath = resolveAppIconPath();

  // Create the browser window.
  win = new BrowserWindow({
    x: 0,
    y: 0,
    width: size.width,
    height: size.height,
    icon: appIconPath,
    webPreferences: {
      nodeIntegration: true,
      allowRunningInsecureContent: (serve),
      contextIsolation: true,
      //note this is a .js file. A better approach for the future would be to use a .ts file instead.
      preload: path.join(__dirname, '../app/workers/preload/preload.js')
    },
  });


  // Create worker window - visible with DevTools open in dev, hidden in a packaged build. Safe to hide in
  // production because that DevTools console is no longer the only place worker.ts's console.log/warn/error
  // calls go: every one of them is also appended to logs.txt, and every error is additionally forwarded to the
  // renderer as a dialog (see this file's own logging setup above, and worker.ts's copy of it).
  winWorker = new BrowserWindow({
    show: !app.isPackaged,
    icon: appIconPath,
    webPreferences: {
      nodeIntegration: true,
      allowRunningInsecureContent: (serve),
      contextIsolation: true,
      //note this is a .js file. A better approach for the future would be to use a .ts file instead.
      preload: path.join(__dirname, '../app/workers/worker.js')
    }
  });

  winWorker.loadFile(path.join(__dirname, '../app/workers/worker.html'));
  if (!app.isPackaged) {
    winWorker.webContents.openDevTools();
  }

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

  // Raw log line from the renderer (see error-log.ts's appendLogLine) - the renderer has no direct fs access
  // (contextIsolation), so every renderer-originated line is shipped here to be appended by the one
  // appendToLogFile this process already has, same as this process's own console output above.
  ipcMain.on('append-log', (event, line: string) => {
    appendToLogFile(LOG_FILE_PATH, line);
  });

  // Relays a worker-originated error (see worker.ts's own console.error wrapper) to the renderer to show as a
  // dialog - deliberately a channel of its own, not reused from message-from-worker/response-to-main above:
  // those are keyed request/response pairs (see WorkerCommunicator.sendAndAwaitResponse), and an unsolicited
  // message on that channel with no matching pending request is treated as a protocol error and wrongly rejects
  // whatever request actually is in flight.
  ipcMain.on('app-error', (event, arg: { source: string } & ReportedError) => {
    win?.webContents.send('app-error', arg);
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
