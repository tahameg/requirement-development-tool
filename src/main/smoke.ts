import { app, session } from 'electron';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { AppConfig } from './config/appConfig.js';
import { DesktopService } from './services/desktopService.js';
import { createDesktopWindow } from './window.js';
/** Self-test uses its own profile/workspace and never opens user data. */
export async function runPackagedSmoke(): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hlr-packaged-'));
  const service = new DesktopService(new AppConfig(path.join(root, 'config.ini')));
  let window: Awaited<ReturnType<typeof createDesktopWindow>> | undefined;
  try {
    session.defaultSession.enableNetworkEmulation({ offline: true });
    const workspace = path.join(root, 'Offline.hlr');
    await service.create(workspace, 'Offline verification', 'TEST');
    await service.changeHierarchy({ action: 'addModule', objectType: 'REQUIREMENT', parentId: null, name: 'Module', prefix: 'MOD', description: '' });
    const parentId = service.state().current!.workspace.domains.REQUIREMENT.modules[0]!.id;
    await service.changeHierarchy({ action: 'addFunction', objectType: 'REQUIREMENT', parentId, name: 'Function', prefix: 'FN', description: '' });
    const functionId = service.state().current!.workspace.domains.REQUIREMENT.functions[0]!.functionId;
    await service.editFunction({ objectType: 'REQUIREMENT', functionId, changes: [{ action: 'add', values: { col_desc: 'The application shall work offline.' } }] });
    assert.equal(service.state().current!.index.status, 'ready'); assert.equal(service.search('offline').length, 1);
    assert.match(service.export({ format: 'csv' }), /work offline/);
    service.close(); writeFileSync(path.join(workspace, '.hlr/cache.sqlite'), 'broken cache'); await service.open(workspace);
    assert.equal(service.state().current!.index.count, 1);
    window = await createDesktopWindow(service);
    for (let tries = 0; tries < 100; tries++) { if (await window.webContents.executeJavaScript('!!document.querySelector(".workspace-card")')) break; await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.equal(await window.webContents.executeJavaScript('!!document.querySelector(".workspace-card")'), true);
    assert.equal(await window.webContents.executeJavaScript('typeof require'), 'undefined');
    assert.equal(await window.webContents.executeJavaScript('fetch("https://example.com").then(() => false, () => true)'), true);
    assert.equal((await window.webContents.executeJavaScript('window.hlr.state()')).value.current.index.status, 'ready');
    assert.match(readFileSync(path.join(root, 'config.ini'), 'utf8'), /\[general\]/);
    console.log(`Packaged offline smoke passed: ${process.platform}/${process.arch}; SQLite, workspace, search, export, cache recovery, renderer and preload.`);
  } finally { window?.destroy(); service.close(); rmSync(root, { recursive: true, force: true }); }
}
