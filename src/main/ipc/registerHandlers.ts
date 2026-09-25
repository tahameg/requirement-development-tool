import { writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { exportSchema } from '../../shared/authoring.js';
import { ipcMain, dialog, type BrowserWindow } from 'electron';
import { z } from 'zod';
import { channels, type Result, type AppState } from '../../shared/api.js';
import { DesktopService } from '../services/desktopService.js';
export function registerHandlers(window: BrowserWindow, service: DesktopService, rendererUrl: string): () => void {
  let pending = false;
  const handlers: Record<string, (...args: unknown[]) => Promise<void> | void> = {
    [channels.editFunction]: command => service.editFunction(command),
    [channels.changeHierarchy]: command => service.changeHierarchy(command),
    [channels.state]: () => undefined,
    [channels.createProject]: async (...args) => {
      const [name, prefix] = z.tuple([z.string().trim().min(1).max(200), z.string().regex(/^[\p{L}\p{N}_]*$/u)]).parse(args);
      const result = await dialog.showSaveDialog(window, { title: 'Create project workspace', defaultPath: 'New project.hlr', buttonLabel: 'Create workspace' });
      if (!result.canceled && result.filePath) await service.create(result.filePath, name, prefix);
    },
    [channels.openProject]: async () => {
      const result = await dialog.showOpenDialog(window, { title: 'Open project workspace', properties: ['openDirectory'] });
      if (!result.canceled && result.filePaths[0]) await service.open(result.filePaths[0]);
    },
    [channels.openRecent]: async (...args) => {
      const [index] = z.tuple([z.number().int().min(0).max(9)]).parse(args);
      const root = service.config.get().recentProjects[index];
      if (!root) throw new Error('Recent project not found');
      await service.open(root);
    },
    [channels.saveProject]: () => service.save(),
    [channels.updateProject]: config => service.updateProject(config),
    [channels.saveSettings]: settings => service.saveSettings(settings),
  };
  const queries: Record<string, (...args: unknown[]) => unknown> = {
    [channels.search]: query => service.search(query),
    [channels.exportWorkspace]: async raw => {
      const request = exportSchema.parse(raw);
      const text = service.export(request);
      const extension = request.format === 'csv' ? 'csv' : 'md';
      const result = await dialog.showSaveDialog(window, { title: 'Export workspace', defaultPath: `requirements.${extension}`, filters: [{ name: request.format, extensions: [extension] }] });
      if (result.canceled || !result.filePath) return null;
      if (path.extname(result.filePath).toLowerCase() !== `.${extension}`) throw new Error(`Choose a .${extension} file`);
      const temporary = `${result.filePath}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, text, { flag: 'wx' }); await rename(temporary, result.filePath); }
      finally { await unlink(temporary).catch(() => undefined); }
      return result.filePath;
    },
  };
  for (const [channel, action] of Object.entries({ ...handlers, ...queries })) {
    ipcMain.handle(channel, async (event, ...args): Promise<Result<unknown>> => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== rendererUrl) return { ok: false, error: 'Untrusted request' };
      if (pending) return { ok: false, error: 'Another operation is in progress' };
      pending = true;
      try { const result = await action(...args); return { ok: true, value: channel in queries ? result : service.state() }; }
      catch (error) { return { ok: false, error: error instanceof z.ZodError ? error.issues.map(issue => issue.message).join('\n') : error instanceof Error ? error.message : 'Operation failed' }; }
      finally { pending = false; }
    });
  }
  return () => Object.values(channels).forEach(channel => ipcMain.removeHandler(channel));
}
