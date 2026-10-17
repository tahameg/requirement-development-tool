import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { CollabServer } from '../../src/server/httpServer.js';
import { CollabClient } from '../../src/main/collab/collabClient.js';
import { TlsPinning, serverAddress } from '../../src/main/collab/tlsPinning.js';
import { addFunction, addModule, createWorkspace } from '../../src/main/services/workspaceFactory.js';
import { createTestStore } from './testDbHelper.js';
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function until(check: () => boolean) { for (let i = 0; i < 150; i++) { if (check()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('Condition not met'); }
async function fixture() {
  const db = await createTestStore(); cleanup.push(db.cleanup);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hlr-client-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const server = new CollabServer({ store: db.store, dataDir: path.join(dir, 'server'), host: '127.0.0.1', port: 0, discovery: false });
  const info = await server.start(); cleanup.push(() => server.stop());
  const client = new CollabClient(path.join(dir, 'client')); cleanup.push(() => client.close());
  const probe = await client.probe(server.getBaseUrl()); await client.connect(probe.address, probe.fingerprint);
  expect(client.state().server?.setupRequired).toBe(true);
  await client.auth('setup', { setupToken: info.setupToken!, username: 'owner', displayName: 'Owner', password: 'password123' });
  let workspace = addModule(createWorkspace('Team', 'T'), 'REQUIREMENT', 'Module', 'M'); workspace = addFunction(workspace, 'REQUIREMENT', workspace.domains.REQUIREMENT.modules[0]!.id, 'Function', 'F');
  const { room } = await client.request('POST', '/api/rooms', { name: 'Team', visibility: 'listed', workspace });
  await client.join(room.id); await until(() => client.state().connection === 'connected');
  return { client, server, dir, room, functionId: workspace.domains.REQUIREMENT.functions[0]!.functionId };
}
describe('desktop collaboration transport', () => {
  it('pins certificates before credentials, mirrors operations, and round-trips revisions over HTTPS', async () => {
    const { client, server, room, functionId } = await fixture();
    const payload = { objectType: 'REQUIREMENT' as const, functionId, values: { col_desc: 'Shared' } };
    await client.sendOp({ opId: randomUUID(), kind: 'item.add', payload });
    expect(client.state().seq).toBe(1);
    const id = client.state().workspace!.domains.REQUIREMENT.functions[0]!.items[0]!.id;
    await client.lock('acquire', `item:${id}`);
    const saved = await client.request('POST', `/api/rooms/${room.id}/revisions`, { message: 'Baseline' });
    await client.sendOp({ opId: randomUUID(), kind: 'item.edit', payload: { ...payload, itemId: id, values: { col_desc: 'Changed' } } });
    const changed = await client.request('POST', `/api/rooms/${room.id}/revisions`, { message: 'Changed version' });
    const diff = await client.request('GET', `/api/rooms/${room.id}/revisions/${saved.revision.id}/diff?to=${changed.revision.id}`);
    expect(diff.changed.some((entry: { id: string }) => entry.id === id)).toBe(true);
    await expect(client.request('GET', `/api/rooms/${room.id}/revisions/${saved.revision.id}/diff?to=missing`)).rejects.toThrow('Comparison revision not found');
    await client.request('POST', `/api/rooms/${room.id}/revisions/${saved.revision.id}/restore`, {});
    await until(() => client.state().seq === 3);
    expect(client.state().workspace!.domains.REQUIREMENT.functions[0]!.items[0]!.values.col_desc).toBe('Shared');
    expect(client.state().locks).toEqual({});
    expect((await client.request('GET', `/api/rooms/${room.id}/revisions`)).revisions).toHaveLength(3);
    // A pin mismatch must reject before a password-bearing HTTP request is written.
    client.pins.trust(server.getBaseUrl(), 'SHA256:' + Array(32).fill('00').join(':'));
    await expect(client.auth('login', { username: 'owner', password: 'password123' })).rejects.toThrow('certificate changed');
    const probe = await client.probe(server.getBaseUrl()); await client.connect(probe.address, probe.fingerprint);
  expect(client.state().server?.setupRequired).toBe(false);
    await client.auth('login', { username: 'owner', password: 'password123' });
    expect(client.state().user?.username).toBe('owner');
  });
  it('keeps session locks through a blip and safely resends an unchanged draft', async () => {
    const { client, server, functionId } = await fixture();
    await client.sendOp({ opId: randomUUID(), kind: 'item.add', payload: { objectType: 'REQUIREMENT', functionId, values: { col_desc: 'Initial' } } });
    const item = client.state().workspace!.domains.REQUIREMENT.functions[0]!.items[0]!;
    await client.lock('acquire', `item:${item.id}`);
    client.setDraft({ objectType: 'REQUIREMENT', functionId, itemId: item.id, baseValues: item.values, values: { ...item.values, col_desc: 'Preserved draft' } });
    for (const ws of server.wsHandler.wss.clients) ws.terminate();
    await until(() => client.state().connection === 'reconnecting');
    await until(() => client.state().seq === 2 && client.state().draft === null);
    expect(client.state().workspace!.domains.REQUIREMENT.functions[0]!.items[0]!.values.col_desc).toBe('Preserved draft');
  });
  it('validates origins and persists pins without session credentials', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hlr-pins-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'pins.json'); const pins = new TlsPinning(file);
    const pin = 'SHA256:' + Array(32).fill('AA').join(':'); pins.trust('https://localhost:8443', pin);
    expect(new TlsPinning(file).get('https://localhost:8443')).toBe(pin);
    expect(serverAddress('192.168.1.2:8443')).toBe('https://192.168.1.2:8443');
    for (const url of ['file:///tmp/file', 'https://user:password@localhost', 'https://localhost/path', 'https://localhost/?q=1']) expect(() => serverAddress(url)).toThrow();
  });
});
