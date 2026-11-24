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
  listProfiles: () => ipcRenderer.invoke('bridge:list-profiles'),
  saveProfile: data => ipcRenderer.invoke('bridge:save-profile', data),
  deleteProfile: id => ipcRenderer.invoke('bridge:delete-profile', id),
  startProfile: id => ipcRenderer.invoke('bridge:start-profile', id),
  onFocusInstance(callback) {
    const listener = (_event, id) => callback(id);
    ipcRenderer.on('bridge:focus-instance', listener);
    return () => ipcRenderer.removeListener('bridge:focus-instance', listener);
  },
  onChange(callback) {
    const listener = (_event, instances) => callback(instances);
    ipcRenderer.on('bridge:change', listener);
    return () => ipcRenderer.removeListener('bridge:change', listener);
  }
});
