import { CollabClient } from './collab/collabClient.js';
import { registerCollabHandlers } from './ipc/collabHandlers.js';
import { app, BrowserWindow, dialog } from 'electron';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { registerHandlers } from './ipc/registerHandlers.js';
import type { DesktopService } from './services/desktopService.js';
const directory = path.dirname(fileURLToPath(import.meta.url));
export async function createDesktopWindow(service: DesktopService): Promise<BrowserWindow> {
  const settings = service.config.get();
  const page = path.join(directory, '../renderer/index.html');
  const iconPath = path.resolve(directory, '../../build/icon.png');
  const window = new BrowserWindow({
    title: 'HLR Writing Tool', ...(existsSync(iconPath) ? { icon: iconPath } : {}), width: settings.window.width, height: settings.window.height,
    minWidth: 800, minHeight: 600, show: false, backgroundColor: '#11171f', autoHideMenuBar: true,
    webPreferences: { preload: path.join(directory, '../preload/index.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
  });
  window.webContents.on('will-prevent-unload', event => {
    const response = dialog.showMessageBoxSync(window, { type: 'question', buttons: ['Keep editing', 'Discard and leave'], defaultId: 0, cancelId: 0, message: 'There are unsaved edits or an operation in progress.' });
    if (response === 1) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('devtools:') }));
  const collab = new CollabClient(app.getPath('userData'));
  const unregisterCollab = registerCollabHandlers(window, collab, pathToFileURL(page).href);
  const unregister = registerHandlers(window, service, pathToFileURL(page).href);
  window.on('close', () => {
    const bounds = window.getNormalBounds();
    service.config.save({ ...service.config.get(), window: { width: Math.max(800, Math.min(7680, bounds.width)), height: Math.max(600, Math.min(4320, bounds.height)), maximized: window.isMaximized() } });
  });
  window.on('closed', () => { unregister(); unregisterCollab(); service.close(); });
  await window.loadFile(page);
  if (settings.window.maximized) window.maximize();
  window.show();
  return window;
}
