import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>());
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: any) => handlers.set(name, fn), removeHandler: (name: string) => handlers.delete(name) }, dialog: {} }));
import { registerCollabHandlers } from '../../src/main/ipc/collabHandlers.js';
import type { BrowserWindow } from 'electron';
import type { CollabClient } from '../../src/main/collab/collabClient.js';
describe('collaboration IPC boundary', () => {
  it('rejects foreign frames and malformed commands before invoking network capabilities', async () => {
    const contents = { mainFrame: { url: 'file:///renderer.html' }, send: vi.fn() };
    const window = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow;
    const client = Object.assign(new EventEmitter(), { state: () => ({ connection: 'offline' }), request: vi.fn(), close: vi.fn() });
    const remove = registerCollabHandlers(window, client as unknown as CollabClient, contents.mainFrame.url);
    const handle = handlers.get('hlr:collab')!;
    const trusted = { sender: contents, senderFrame: contents.mainFrame };
    expect((await handle({ sender: {}, senderFrame: contents.mainFrame }, { action: 'state' })).ok).toBe(false);
    expect((await handle({ sender: contents, senderFrame: { url: contents.mainFrame.url } }, { action: 'state' })).ok).toBe(false);
    expect((await handle(trusted, { action: 'request', method: 'GET', route: '/api/rooms/%2e%2e/auth/me' })).ok).toBe(false);
    expect((await handle(trusted, { action: 'state', unexpected: true })).ok).toBe(false);
    expect(await handle(trusted, { action: 'state' })).toEqual({ ok: true, value: { connection: 'offline' } });
    expect(client.request).not.toHaveBeenCalled(); remove(); expect(handlers.size).toBe(0);
  });
});
