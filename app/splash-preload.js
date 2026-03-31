const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  splashDone: () => ipcRenderer.send('splash-done'),
  onAppReady: (callback) => ipcRenderer.on('app-ready', callback)
});
