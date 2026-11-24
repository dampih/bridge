'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridgeDesktop', {
  pickFolder: () => ipcRenderer.invoke('bridge:pick-folder'),
  list: () => ipcRenderer.invoke('bridge:list'),
  start: data => ipcRenderer.invoke('bridge:start', data),
  stop: id => ipcRenderer.invoke('bridge:stop', id),
  copyUrl: id => ipcRenderer.invoke('bridge:copy-url', id),
  answerApproval: data => ipcRenderer.invoke('bridge:answer-approval', data),
  setApprovalMode: data => ipcRenderer.invoke('bridge:set-approval-mode', data),
  onChange(callback) {
    const listener = (_event, instances) => callback(instances);
    ipcRenderer.on('bridge:change', listener);
    return () => ipcRenderer.removeListener('bridge:change', listener);
  }
});
