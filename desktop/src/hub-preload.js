'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('diakoHub', {
  info: () => ipcRenderer.invoke('hub:info'),
  connect: (dados) => ipcRenderer.invoke('hub:connect', dados),
  disconnect: () => ipcRenderer.invoke('hub:disconnect'),
  refresh: () => ipcRenderer.invoke('hub:refresh'),
});
