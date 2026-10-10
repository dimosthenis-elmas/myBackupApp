const electron = require('electron');
const ipcRenderer = electron.ipcRenderer

/**
 * Listeners registered through ipcRenderer_on, keyed by the numeric handle that call hands back (see
 * ipcRenderer_off). Removal has to go through such a handle rather than through the listener function itself:
 * contextBridge PROXIES every function crossing from the page's own world into this preload's world, and each
 * crossing produces a brand new proxy object - even for one and the same function (verified: handing the same
 * function to ipcRenderer_on and then to removeListener yields two different proxies, so
 * ipcRenderer.removeListener(channel, func) silently removed NOTHING). Every listener any caller ever registered
 * therefore stayed alive for the lifetime of the window. For sendAndAwaitResponse's per-request listeners that
 * was "only" log noise (each still filters on response.key and merely logs "Ignored a ... message" for the rest),
 * but a component's own catch-all listener kept reacting to operations that were not its own at all - the
 * optical-disc data retriever's, for example, reported the NEXT disc's disc-wait/scan responses as unexpected
 * internal messages (popping an "Application error" dialog over the wizard) and pushed the PREVIOUS disc's id a
 * second time, so its "all discs recovered" check never matched and the wizard stopped one step short of its
 * final summary. A number crosses the bridge as a plain value, so a handle always identifies the exact listener
 * it came from.
 */
const listenerHandles = new Map();
let nextListenerHandle = 1;

contextBridgeAPI = {
    openDialog: (method, config) => {
        return ipcRenderer.invoke('dialog', method, config)
    },
    /** Registers func on channel. @returns the handle to remove it with ipcRenderer_off - deliberately NOT func
     *  itself, see the note above listenerHandles for why that could never work. */
    ipcRenderer_on: (channel, func) => {
        const handle = nextListenerHandle++;
        listenerHandles.set(handle, { channel, listener: func });
        ipcRenderer.on(channel, func);
        return handle;
    },
    /** Removes the listener whose ipcRenderer_on call returned this handle. @returns whether one was removed -
     *  false for a handle already used, or one whose channel ipcRenderer_removeAllListeners already wiped. */
    ipcRenderer_off: (handle) => {
        const entry = listenerHandles.get(handle);
        if (!entry) { return false; }
        ipcRenderer.removeListener(entry.channel, entry.listener);
        listenerHandles.delete(handle);
        return true;
    },
    ipcRenderer_send: (channel, arg) => {
        ipcRenderer.send(channel, arg);
    },
    /** Removes every listener on channel, so every handle pointing at it is dropped too (a later
     *  ipcRenderer_off with one of them must report that it removed nothing, not try to remove a listener that
     *  is already gone). */
    ipcRenderer_removeAllListeners: (channel) => {
        for (const [handle, entry] of listenerHandles) {
            if (entry.channel === channel) { listenerHandles.delete(handle); }
        }
        ipcRenderer.removeAllListeners(channel);
    },
    quitApp: () => {
        ipcRenderer.send('quit-app');
    }
}

module.exports =  contextBridgeAPI;