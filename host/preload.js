'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('host', {
  getConfig: () => ipcRenderer.invoke('config'),
  getScreens: () => ipcRenderer.invoke('screens'),
  setActiveScreen: (sourceId) => ipcRenderer.send('active-screen', sourceId),
  input: (msg) => ipcRenderer.send('input', msg),
  releaseAll: () => ipcRenderer.send('release-all'),
  setStreaming: (on) => ipcRenderer.send('streaming', !!on),
});
