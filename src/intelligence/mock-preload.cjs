const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('intelligenceMock', {
  models: () => ipcRenderer.invoke('cevra:intelligence-mock:models'),
  start: request => ipcRenderer.invoke('cevra:intelligence-mock:start', request),
  next: id => ipcRenderer.invoke('cevra:intelligence-mock:next', id),
  stop: id => ipcRenderer.invoke('cevra:intelligence-mock:stop', id),
});
