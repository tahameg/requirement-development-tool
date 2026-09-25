import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPackagedSmoke } from './smoke.js';
import { app, dialog } from 'electron';
import { AppConfig } from './config/appConfig.js';
import { DesktopService } from './services/desktopService.js';
import { createDesktopWindow } from './window.js';

if (process.argv.includes('--smoke-test')) {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'hlr-smoke-profile-'));
  app.setPath('userData', profile);
  const timeout = setTimeout(() => { console.error('Packaged smoke timed out'); app.exit(1); }, 30000);
  app.whenReady().then(runPackagedSmoke).then(() => { clearTimeout(timeout); rmSync(profile, { recursive: true, force: true }); app.exit(0); }).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
} else if (!app.requestSingleInstanceLock()) app.quit();
else {
  let mainWindow: Awaited<ReturnType<typeof createDesktopWindow>> | null = null;
  app.on('second-instance', () => { if (mainWindow?.isMinimized()) mainWindow.restore(); mainWindow?.focus(); });
  app.whenReady().then(async () => {
    app.setAppUserModelId('hlr-writing-tool');
    mainWindow = await createDesktopWindow(new DesktopService(new AppConfig()));
  }).catch(error => { dialog.showErrorBox('Unable to start HLR Writing Tool', String(error)); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
}
