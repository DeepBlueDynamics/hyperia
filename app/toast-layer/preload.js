// Toast layer preload (sandboxed, contextIsolation). Exposes exactly two
// one-way channels: renders in, actions/size out. No node, no other IPC.
'use strict';

const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('hyToastLayer', {
  onRender(cb) {
    ipcRenderer.on('toast-layer:render', (_e, payload) => cb(payload));
  },
  reportSize(width, height) {
    ipcRenderer.send('toast-layer:size', {width, height});
  },
  action(toastId, buttonId) {
    ipcRenderer.send('toast-layer:action', {toastId, buttonId});
  }
});
