'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, clipboard, dialog, ipcMain, Notification } = require('electron');
const { InstanceManager } = require('./instances');
const { ProfileStore } = require('./profiles');
const { createApprovalNotifier } = require('./notifications');

const page = path.join(__dirname, 'index.html');
const pageUrl = pathToFileURL(page).href;
let window;
let quitting = false;
const selectedFolders = new Set();
const manager = new InstanceManager({
  onChange(instances) {
    if (window && !window.isDestroyed()) window.webContents.send('bridge:change', instances);
    notifier.update();
  },
  onApproval(target) {
    // A desktop notification is optional; the pending request stays in the dashboard.
    try { notifier.notify(target); } catch {}
  }
});
const notifier = createApprovalNotifier({
  Notification,
  getWindow: () => window,
  isSupported: () => process.platform === 'win32' && Notification.isSupported(),
  isPending: ({ instanceId, requestId }) => manager.instances.get(instanceId)?.approvals.has(requestId)
});

function handle(action, callback) {
  ipcMain.handle(`bridge:${action}`, (event, data) => {
    if (!window || window.isDestroyed() || event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== pageUrl) {
      throw new Error('Untrusted Bridge Desktop request.');
    }
    return callback(data);
  });
}

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId(process.execPath);
  const profiles = new ProfileStore(path.join(app.getPath('userData'), 'project-profiles.json'));
  handle('pick-folder', async () => {
    const result = await dialog.showOpenDialog(window, { title: 'Choose a Bridge project', properties: ['openDirectory'] });
    if (result.canceled) return null;
    const folder = result.filePaths[0];
    selectedFolders.add(folder);
    return folder;
  });
  handle('list', () => manager.list());
  handle('start', data => {
    if (!selectedFolders.has(data?.folder)) throw new Error('Choose a project folder first.');
    return manager.start({ folder: data.folder, port: data.port });
  });
  handle('list-profiles', () => profiles.list());
  handle('save-profile', data => profiles.save(data, folder => selectedFolders.has(folder)));
  handle('delete-profile', id => profiles.delete(id));
  handle('start-profile', id => {
    const { folder, port, name } = profiles.get(id);
    return manager.start({ folder, port, profileName: name });
  });
  handle('stop', id => manager.stop(id));
  handle('copy-url', id => { clipboard.writeText(manager.urlForCopy(id)); });
  handle('answer-approval', data => manager.answerApproval(data));
  handle('set-approval-mode', async data => {
    const instance = manager.list().find(item => item.id === data?.instanceId && item.status === 'online');
    if (data?.mode === 'turbo' && instance && instance.approvalMode !== 'turbo') {
      const result = await dialog.showMessageBox(window, {
        type: 'warning', title: 'Enable Turbo mode?',
        message: `Enable Turbo mode for the instance on port ${instance.port}?`,
        detail: 'New actions will no longer ask for approval. Existing requests still need a decision.',
        buttons: ['Cancel', 'Enable Turbo'], cancelId: 0, defaultId: 0
      });
      if (result.response !== 1) return;
    }
    await manager.setApprovalMode(data);
  });

  window = new BrowserWindow({
    title: 'Bridge Desktop', width: 1080, height: 790, minWidth: 640, minHeight: 520,
    backgroundColor: '#10141d', autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  });
  window.removeMenu();
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.loadFile(page).catch(error => {
    dialog.showErrorBox('Bridge Desktop', `Could not open the dashboard: ${error.message}`);
    app.quit();
  });
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault();
  manager.shutdown().finally(() => {
    quitting = true;
    app.quit();
  });
});
