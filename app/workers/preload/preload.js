//const electron = require('electron');

/*
You may ask why is this nesessary? It seems like we are creating a sort of a broker for indirectly calling the electron API functions.
Well, after a certain version of electron (I think it's electron 12.0.0) we can't directly call electron['something'] funcions from
inside an angular component. For example you can't just do this in an angular component :

const { dialog } = require('electron')
const obj = await dialog.showOpenDialog({ properties: ['openDirectory'] });

This is the reason we have this file here. For example the above code should now be replaced by:

const res = await window.electronAPI.openDialog('showOpenDialog', dialogConfig);

Note that this file kind of 'cooperates' with interface.d.ts which exposes the IElectronAPI to window, globally.

Also notice the usage of contextIsolation: true when creating a Browser Window in electron main.

This file will be used for the preload scripts in main.ts
*/

/*
electron.contextBridge.exposeInMainWorld('electronAPI', {
  //Calls the electron.dialog(method, config) function. This is used for example to open a file chooser.
  //Example usage from angular: res = await window.electronAPI.openDialog('showOpenDialog', dialogConfig);
  //This example is essentially calling electron.showOpenDialog(dialogConfig)  
  openDialog: (method, config) => {
    return electron.ipcRenderer.invoke('dialog', method, config)
  },

  ipcRenderer_on: (channel, func) => {
    electron.ipcRenderer.on(channel, (event, ...args) => func(...args));
  },
  ipcRenderer_send: (channel, ...arg) => {
    electron.ipcRenderer.send(channel, arg);
  },
  ipcRenderer_removeListener: (channel, listener) => {
    electron.ipcRenderer.removeListener(channel, listener);
  },
  ipcRenderer_removeAllListeners: (channel) => {
    electron.ipcRenderer.removeAllListeners(channel);
  }

});
*/



const electron = require('electron');
const contextBridgeAPI =require("./contextBridge_api");

Bridge = contextBridgeAPI;

electron.contextBridge.exposeInMainWorld("electronAPI", contextBridgeAPI);