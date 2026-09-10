'use strict';

/**
 * Drives the app's real worker process over its real IPC contract - the exact same channel names and message
 * shapes app/workers/worker-communicator.ts uses (window.electronAPI.ipcRenderer_send('message-to-worker', ...)
 * / ipcRenderer_on('message-from-worker', ...)) - via Playwright's Electron support. No app source is touched:
 * this launches the real built app/main.js and talks to it exactly the way the Angular UI itself does, just
 * from a script instead of clicking buttons.
 *
 * IMPORTANT: this needs an actual Windows desktop/window session to launch Electron's GUI process into. It will
 * NOT run inside a headless/remote sandbox with no desktop access (confirmed while building this: even a bare
 * `electron.exe app/main.js` with no Playwright involved fails silently in that kind of environment, while
 * `electron.exe --version` - which never opens a window - works fine there). Run these scripts from a normal
 * interactive terminal on your machine, the same way you already run `npm run e2e`.
 */

const { _electron } = require('playwright');
const path = require('path');

/** @param extraLaunchOptions merged into the underlying `_electron.launch({...})` call - e.g. `{ recordVideo: {
 *  dir, size } }` (see ui/capture-recover-data-video.js). Every existing caller passes nothing, unaffected. */
async function launchApp(extraLaunchOptions = {}) {
  const app = await _electron.launch({
    args: [
      path.join(__dirname, '../../app/main.js'),
      path.join(__dirname, '../../app/package.json'),
    ],
    ...extraLaunchOptions,
  });

  // main.ts's createWindow() creates TWO windows: the main UI window (preload.js exposes window.electronAPI
  // into the normal/main world via contextBridge.exposeInMainWorld - reachable from a plain page.evaluate) and
  // a separate worker window (its own preload, worker.ts, exposes ITS OWN electronAPI too, but into an
  // ISOLATED world - contextBridge.exposeInIsolatedWorld(999, ...) - deliberately not reachable from normal
  // page-context code). The worker window's loadFile() call also happens to run before the main window's
  // loadURL() call inside createWindow(), so Playwright's app.firstWindow() ("whichever window's content
  // settles first") is not reliably the main window - it can just as easily resolve to the worker window,
  // which genuinely has no usable window.electronAPI in its main world.
  //
  // So: explicitly search every open window for the one that actually has a working window.electronAPI,
  // instead of trusting "first".
  const deadlineAt = Date.now() + 20_000;
  let win = null;
  while (!win && Date.now() < deadlineAt) {
    for (const candidate of app.windows()) {
      try {
        await candidate.waitForLoadState('domcontentloaded', { timeout: 1000 });
        const hasApi = await candidate.evaluate(() => typeof window.electronAPI?.ipcRenderer_send === 'function');
        if (hasApi) { win = candidate; break; }
      } catch {
        // This window isn't navigable/ready yet, or evaluate raced a navigation - just try again next pass.
      }
    }
    if (!win) { await new Promise((resolve) => setTimeout(resolve, 200)); }
  }

  if (!win) {
    await app.close();
    throw new Error('No window with a working window.electronAPI appeared within 20s - is the app built (npm run build:prod)?');
  }

  return { app, win };
}

/**
 * Sends one request to the real worker and resolves/rejects with its response, mirroring
 * WorkerCommunicator.sendAndAwaitResponse's behavior (status: 'completed'/'stopped' -> resolve, 'error' -> reject).
 */
async function callWorker(win, key, params, timeoutMs = 5 * 60 * 1000) {
  return win.evaluate(({ key, params, timeoutMs }) => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        window.electronAPI.ipcRenderer_removeAllListeners('message-from-worker');
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for a response to "${key}"`));
      }, timeoutMs);

      window.electronAPI.ipcRenderer_on('message-from-worker', (event, response) => {
        if (response.key !== key) { return; } // not our response (e.g. a stray 'stop' ack) - keep waiting
        // 'running' means this key's operation is still going (a progress update - see logsBuffer in worker.ts,
        // e.g. diff()/createTree() report progress this way) - keep waiting for its real 'completed'/'stopped'/
        // 'error' response instead of treating this one as final. Matches this function's own doc comment above
        // and WorkerCommunicator.sendAndAwaitResponse's real behavior - without this check, a call whose
        // operation reports ANY progress before finishing would resolve early with that progress update's own
        // (irrelevant, possibly empty) `res` instead of the operation's real result.
        if (response.status === 'running') { return; }
        clearTimeout(timer);
        window.electronAPI.ipcRenderer_removeAllListeners('message-from-worker');
        if (response.status === 'error') {
          // Reject with a real Error carrying the full response JSON in its message - Playwright's own
          // page.evaluate error reporting can't usefully stringify a plain rejected object (that's the
          // unhelpful "page.evaluate: Object" you'd otherwise see back in the calling script), so this is
          // what actually surfaces the worker's real error details on the Node side.
          //
          // response.res is very often an Error (or Error-like) object at this point (worker.ts's catch
          // blocks do `res: err` directly), and Error instances have non-enumerable message/stack/name -
          // JSON.stringify silently drops those, producing a useless "{}" (this bit me the first time
          // through). Pulling the common fields out by explicit property access (which doesn't care about
          // enumerability) and re-assigning them onto a plain object fixes that.
          const r = response.res || {};
          const detail = { message: r.message, name: r.name, msg: r.msg, err_code: r.err_code, stack: r.stack, ...r };
          reject(new Error(`Worker returned status "error" for "${key}": ${JSON.stringify(detail)}`));
        } else {
          resolve(response);
        }
      });

      window.electronAPI.ipcRenderer_send('message-to-worker', { key, params });
    });
  }, { key, params, timeoutMs });
}

module.exports = { launchApp, callWorker };
