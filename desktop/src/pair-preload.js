'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('diakoPair', {
  info: () => ipcRenderer.invoke('pair:info'),
  setAuth: (enabled) => ipcRenderer.invoke('pair:set-auth', enabled),
  revoke: (id) => ipcRenderer.invoke('pair:revoke', id),
  open: (url) => ipcRenderer.invoke('pair:open', url),
});
