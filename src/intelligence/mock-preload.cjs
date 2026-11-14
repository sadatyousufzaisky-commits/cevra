const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('intelligenceMock', {
  models: () => ipcRenderer.invoke('cevra:intelligence-mock:models'),
  start: request => ipcRenderer.invoke('cevra:intelligence-mock:start', request),
  next: id => ipcRenderer.invoke('cevra:intelligence-mock:next', id),
  stop: id => ipcRenderer.invoke('cevra:intelligence-mock:stop', id),
  clear: () => ipcRenderer.invoke('cevra:intelligence-mock:clear'),
  switchModel: () => ipcRenderer.invoke('cevra:intelligence-mock:switch-model'),
  connections: () => ipcRenderer.invoke('cevra:intelligence-mock:connections'),
  storeKey: provider => ipcRenderer.invoke('cevra:intelligence-mock:store-key', provider),
  checkKey: provider => ipcRenderer.invoke('cevra:intelligence-mock:check-key', provider),
  cleanupKey: provider => ipcRenderer.invoke('cevra:intelligence-mock:cleanup-key', provider),
  disconnectKey: provider => ipcRenderer.invoke('cevra:intelligence-mock:disconnect-key', provider),
  context: () => ipcRenderer.invoke('cevra:intelligence-mock:context'),
  attachFile: () => ipcRenderer.invoke('cevra:intelligence-mock:attach-file'),
  attachInstructions: () => ipcRenderer.invoke('cevra:intelligence-mock:attach-instructions'),
  removeContext: id => ipcRenderer.invoke('cevra:intelligence-mock:remove-context', id),
  preferences: () => ipcRenderer.invoke('cevra:intelligence-mock:preferences'),
  savePreferences: values => ipcRenderer.invoke('cevra:intelligence-mock:save-preferences', values),
  openSource: id => ipcRenderer.invoke('cevra:intelligence-mock:open-source', id),
  checkSources: () => ipcRenderer.invoke('cevra:intelligence-mock:check-sources'),
  onContextChanged: callback => ipcRenderer.on('cevra:intelligence-mock:context-changed', (_event, state) => callback(state)),
});
