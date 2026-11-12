const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('intelligenceMock', {
  models: () => ipcRenderer.invoke('cevra:intelligence-mock:models'),
  start: request => ipcRenderer.invoke('cevra:intelligence-mock:start', request),
  next: id => ipcRenderer.invoke('cevra:intelligence-mock:next', id),
  stop: id => ipcRenderer.invoke('cevra:intelligence-mock:stop', id),
  connections: () => ipcRenderer.invoke('cevra:intelligence-mock:connections'),
  storeKey: provider => ipcRenderer.invoke('cevra:intelligence-mock:store-key', provider),
  checkKey: provider => ipcRenderer.invoke('cevra:intelligence-mock:check-key', provider),
  cleanupKey: provider => ipcRenderer.invoke('cevra:intelligence-mock:cleanup-key', provider),
  disconnectKey: provider => ipcRenderer.invoke('cevra:intelligence-mock:disconnect-key', provider),
});
