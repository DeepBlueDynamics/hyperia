const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  splashDone: () => ipcRenderer.send('splash-done')
});
