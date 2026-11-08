'use strict';
// Ponte mínima entre o script injetado no YouTube Music (mundo principal) e o processo main.
const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_OUT = new Set(['state', 'rpc-result', 'log']);
const ALLOWED_IN = new Set(['rpc']);

contextBridge.exposeInMainWorld('diakoBridge', {
  send(channel, payload) {
    if (ALLOWED_OUT.has(channel)) ipcRenderer.send(`diako:${channel}`, payload);
  },
  on(channel, cb) {
    if (!ALLOWED_IN.has(channel)) return;
    ipcRenderer.on(`diako:${channel}`, (_e, payload) => cb(payload));
  },
});
