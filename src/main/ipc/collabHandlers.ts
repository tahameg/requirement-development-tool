import { ipcMain, dialog, type BrowserWindow } from 'electron';
import { mkdir } from 'node:fs/promises';
import { CollabClient } from '../collab/collabClient.js';
import { collabCommandSchema } from '../../shared/collab/commands.js';
import { loadWorkspace, saveWorkspace } from '../services/workspaceService.js';
export const COLLAB_CHANNEL = 'hlr:collab';
export const COLLAB_STATE_CHANNEL = 'hlr:collab-state';
export function trustedCollabSender(event: { sender: unknown; senderFrame: unknown }, contents: { mainFrame: { url: string } }, rendererUrl: string) {
  return event.sender === contents && event.senderFrame === contents.mainFrame && contents.mainFrame.url === rendererUrl;
}
export function registerCollabHandlers(window: BrowserWindow, client: CollabClient, rendererUrl: string) {
  const publish = () => { if (!window.isDestroyed()) window.webContents.send(COLLAB_STATE_CHANNEL, client.state()); };
  client.on('state', publish);
  ipcMain.handle(COLLAB_CHANNEL, async (event, raw) => {
    if (!trustedCollabSender(event, window.webContents, rendererUrl)) return { ok: false, error: 'Untrusted request' };
    try {
      const command = collabCommandSchema.parse(raw);
      let value: unknown;
      switch (command.action) {
        case 'state': value = client.state(); break;
        case 'discover': value = await client.discover(); break;
        case 'probe': value = await client.probe(command.address); break;
        case 'connect': value = await client.connect(command.address, command.fingerprint, command.allowHttp); break;
        case 'auth': { const { action, method, ...body } = command; value = await client.auth(method, body); break; }
        case 'request': value = await client.request(command.method, command.route, command.body); break;
        case 'join': value = await client.join(command.roomId); break;
        case 'op': value = await client.sendOp(command.op); break;
        case 'lock': value = await client.lock(command.kind, command.key); break;
        case 'presence': { const { action, ...state } = command; client.presence({ type: 'presence-update', ...state }); break; }
        case 'draft': client.setDraft(command.draft); break;
        case 'clear-draft': client.setDraft(null); break;
        case 'leave': client.leave(); break;
        case 'disconnect': await client.logout(); break;
        case 'export': {
          const workspace = client.state().workspace; if (!workspace) throw new Error('Join a room first');
          const result = await dialog.showSaveDialog(window, { title: 'Export room to a new local workspace', defaultPath: 'Room.hlr' });
          if (!result.canceled && result.filePath) { await mkdir(result.filePath); await saveWorkspace(result.filePath, workspace); value = result.filePath; } break;
        }
        case 'create-from-local': {
          const result = await dialog.showOpenDialog(window, { title: 'Create a room from a local workspace', properties: ['openDirectory'] });
          if (!result.canceled && result.filePaths[0]) value = await client.request('POST', '/api/rooms', { name: command.name, visibility: command.visibility, workspace: await loadWorkspace(result.filePaths[0]) });
          break;
        }
        case 'import': {
          const roomId = client.state().roomId; if (!roomId) throw new Error('Join a room first');
          const result = await dialog.showOpenDialog(window, { title: 'Import a local workspace as a revision', properties: ['openDirectory'] });
          if (!result.canceled && result.filePaths[0]) value = await client.request('POST', `/api/rooms/${encodeURIComponent(roomId)}/import`, { workspace: await loadWorkspace(result.filePaths[0]), message: 'Imported local workspace' }); break;
        }
      }
      return { ok: true, value };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Collaboration request failed' }; }
  });
  return () => { client.off('state', publish); ipcMain.removeHandler(COLLAB_CHANNEL); client.close(); };
}
