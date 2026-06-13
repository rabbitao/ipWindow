const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ipApi', {
  onI18n: (cb) => ipcRenderer.on('i18n', (_e, strings) => cb(strings)),
  onLoading: (cb) => ipcRenderer.on('ip:loading', () => cb()),
  onUpdate: (cb) => ipcRenderer.on('ip:update', (_e, data) => cb(data)),
  onError: (cb) => ipcRenderer.on('ip:error', (_e, data) => cb(data)),
  refresh: () => ipcRenderer.send('ip:refresh'),
  quit: () => ipcRenderer.send('app:quit'),
});
