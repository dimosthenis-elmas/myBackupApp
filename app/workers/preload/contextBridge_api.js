const electron = require('electron');
const ipcRenderer = electron.ipcRenderer

contextBridgeAPI = {
    openDialog: (method, config) => {
        return ipcRenderer.invoke('dialog', method, config)
    },
    ipcRenderer_on: (channel, func) => {
        ipcRenderer.on(channel, func);
    },
    ipcRenderer_send: (channel, arg) => {
        ipcRenderer.send(channel, arg);
    },
    ipcRenderer_removeListener: (channel, listener) => {
        ipcRenderer.removeListener(channel, listener);
    },
    ipcRenderer_removeAllListeners: (channel) => {
        ipcRenderer.removeAllListeners(channel);
    },
    quitApp: () => {
        ipcRenderer.send('quit-app');
    }
}

module.exports =  contextBridgeAPI;