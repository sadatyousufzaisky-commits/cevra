const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cevra', {
  chooseFolder: () => ipcRenderer.invoke('cevra:choose-folder'),
  openExample: () => ipcRenderer.invoke('cevra:open-example'),
  confirmDiscard: name => ipcRenderer.invoke('cevra:discard', name),
  list: (id, folder) => ipcRenderer.invoke('cevra:list', id, folder),
  read: (id, file) => ipcRenderer.invoke('cevra:read', id, file),
  save: (id, file, text, revision) => ipcRenderer.invoke('cevra:save', id, file, text, revision),
  start: (id, file, revision, runId) => ipcRenderer.invoke('cevra:start', id, file, revision, runId),
  stop: () => ipcRenderer.invoke('cevra:stop'),
  setDirty: value => ipcRenderer.send('cevra:dirty', value),
  onRun: callback => ipcRenderer.on('cevra:run-event', (_event, detail) => callback(detail)),
});
