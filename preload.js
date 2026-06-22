const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ipApi', {
  onI18n: (cb) => ipcRenderer.on('i18n', (_e, strings) => cb(strings)),
  onLoading: (cb) => ipcRenderer.on('ip:loading', () => cb()),
  onUpdate: (cb) => ipcRenderer.on('ip:update', (_e, data) => cb(data)),
  onError: (cb) => ipcRenderer.on('ip:error', (_e, data) => cb(data)),
  onTheme: (cb) => ipcRenderer.on('theme', (_e, theme) => cb(theme)),
  refresh: () => ipcRenderer.send('ip:refresh'),
  quit: () => ipcRenderer.send('app:quit'),
  popoverEnter: () => ipcRenderer.send('popover:enter'),
  popoverLeave: () => ipcRenderer.send('popover:leave'),
  dragStart: () => ipcRenderer.send('taskbar:dragStart'),
});
