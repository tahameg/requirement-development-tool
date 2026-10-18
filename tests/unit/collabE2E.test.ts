import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { CollabServer } from '../../src/server/httpServer.js';
import { PgServerStore } from '../../src/server/store/pgStore.js';
import { CollabClient } from '../../src/main/collab/collabClient.js';
import { DiscoveryClient } from '../../src/main/collab/discoveryClient.js';
import { addRequirementSet, addComponent, createWorkspace } from '../../src/main/services/workspaceFactory.js';
import { createTestStore } from './testDbHelper.js';
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(r => setTimeout(r, 25)); } throw new Error('Condition not met'); }
it('runs three users through TLS discovery, joins, editing, locks, revisions, draft conflicts and restart recovery', async () => {
  const db = await createTestStore(); const dir = mkdtempSync(path.join(os.tmpdir(), 'hlr-e2e-'));
  let now = Date.now(); const discovery = new DiscoveryClient({ port: 0 }); discovery.on('error', () => {}); await discovery.start();
  let server = new CollabServer({ store: db.store, dataDir: path.join(dir, 'server'), host: '127.0.0.1', port: 0, discoveryPort: discovery.getPort(), discoveryTargets: ['127.0.0.1'], discoveryIntervalMs: 100, now: () => new Date(now) });
  const clients = ['owner', 'editor', 'viewer'].map(name => new CollabClient(path.join(dir, name)));
  const [owner, editor, viewer] = clients as [CollabClient, CollabClient, CollabClient];
  try {
    const info = await server.start(); const port = info.port; const url = server.getBaseUrl();
    await until(() => discovery.getServers().length === 1);
    expect(discovery.getServers()[0]!.fingerprint).toBe(info.fingerprint);
    for (let i = 0; i < clients.length; i++) {
      const client = clients[i]!; const probe = await client.probe(url); await client.connect(url, probe.fingerprint);
      await client.auth(i === 0 ? 'setup' : 'register', { username: ['owner','editor','viewer'][i], displayName: ['Owner','Editor','Viewer'][i], password: 'password123', ...(i === 0 ? { setupToken: info.setupToken } : {}) });
    }
    let workspace = addComponent(createWorkspace('Shared', 'S'), 'REQUIREMENT', 'Module', 'M'); workspace = addRequirementSet(workspace, 'REQUIREMENT', workspace.domains.REQUIREMENT.components[0]!.id, 'Function', 'F');
    const requirementSetId = workspace.domains.REQUIREMENT.requirementSets[0]!.requirementSetId;
    const { room } = await owner.request('POST', '/api/rooms', { name: 'Shared room', visibility: 'listed', workspace });
    const base = `/api/rooms/${room.id}`;
    const joined = await editor.request('POST', base + '/join-requests', { message: 'Join as editor' });
    await owner.request('POST', base + `/join-requests/${joined.joinRequest.id}/review`, { approve: true, role: 'EDITOR' });
    const invite = await owner.request('POST', base + '/invite-codes', { role: 'VIEWER', maxUses: 1, expiresInSeconds: 3600 });
    await viewer.request('POST', '/api/invites/redeem', { code: invite.inviteCode.code });
    for (const client of clients) await client.join(room.id);
    await until(() => clients.every(c => c.state().connection === 'connected'));
    await Promise.all(Array.from({ length: 10 }, (_, i) => clients[i % 2]!.sendOp({ opId: randomUUID(), kind: 'item.add', payload: { objectType: 'REQUIREMENT', requirementSetId, values: { col_desc: `Requirement ${i}` } } })));
    await until(() => clients.every(c => c.state().seq === 10));
    expect(owner.state().workspace).toEqual(editor.state().workspace); expect(viewer.state().workspace).toEqual(owner.state().workspace);
    const ids = owner.state().workspace!.domains.REQUIREMENT.requirementSets[0]!.items.map(i => i.id); expect(new Set(ids).size).toBe(10);
    const itemId = ids[0]!; await owner.lock('force-release', `item:${itemId}`); await owner.lock('acquire', `item:${itemId}`);
    await expect(editor.lock('acquire', `item:${itemId}`)).rejects.toThrow('Owner');
    await expect(viewer.lock('acquire', `item:${itemId}`)).rejects.toThrow('cannot acquire');
    await expect(viewer.sendOp({ opId: randomUUID(), kind: 'item.add', payload: { objectType: 'REQUIREMENT', requirementSetId, values: { col_desc: 'Forbidden' } } })).rejects.toThrow('read-only');
    now += 150;
    owner.presence({ type: 'presence-update', view: { objectType: 'REQUIREMENT', nodeId: requirementSetId }, focus: { itemId, columnId: 'col_desc' }, drafting: null });
    await until(() => editor.state().presence.some(p => p.state.focus?.itemId === itemId));
    await owner.sendOp({ opId: randomUUID(), kind: 'item.edit', payload: { objectType: 'REQUIREMENT', requirementSetId, itemId, values: { col_desc: 'Live patch' } } });
    await until(() => editor.state().seq === 11);
    const baseline = await owner.request('POST', base + '/revisions', { message: 'Baseline' });
    await owner.sendOp({ opId: randomUUID(), kind: 'item.add', payload: { objectType: 'REQUIREMENT', requirementSetId, values: { col_desc: 'After baseline' } } });
    const issuedLater = owner.state().workspace!.domains.REQUIREMENT.requirementSets[0]!.items.at(-1)!.id;
    await expect(editor.request('POST', base + '/revisions', { message: 'Forbidden save' })).rejects.toThrow('admins');
    await owner.request('POST', base + `/revisions/${baseline.revision.id}/restore`, {});
    await until(() => clients.every(c => c.state().seq === 13)); expect(owner.state().workspace!.retiredIds).toContain(issuedLater);
    expect(editor.state().locks).toEqual({});
    // Disconnected draft after grace expires must be surfaced, not silently merged.
    await editor.lock('acquire', `item:${itemId}`);
    const values = editor.state().workspace!.domains.REQUIREMENT.requirementSets[0]!.items.find(i => i.id === itemId)!.values;
    editor.setDraft({ objectType: 'REQUIREMENT', requirementSetId, itemId, baseValues: values, values: { ...values, col_desc: 'My unsent draft' } });
    [...server.wsHandler.wss.clients][1]!.terminate();
    await until(() => editor.state().connection === 'reconnecting'); now += 31000;
    await owner.lock('acquire', `item:${itemId}`);
    await owner.sendOp({ opId: randomUUID(), kind: 'item.edit', payload: { objectType: 'REQUIREMENT', requirementSetId, itemId, values: { col_desc: 'Other user changed it' } } });
    await until(() => !!editor.state().draft?.conflict);
    expect(editor.state().draft!.values.col_desc).toBe('My unsent draft');
    expect(editor.state().workspace!.domains.REQUIREMENT.requirementSets[0]!.items.find(i => i.id === itemId)!.values.col_desc).toBe('Other user changed it');
    // A deleted row must also retain the unsent draft for review on rejoin.
    editor.setDraft({ ...editor.state().draft!, conflict: undefined });
    editor.leave();
    await owner.sendOp({ opId: randomUUID(), kind: 'item.delete', payload: { objectType: 'REQUIREMENT', requirementSetId, itemId } });
    await editor.join(room.id);
    await until(() => !!editor.state().draft?.conflict);
    expect(editor.state().draft!.conflict).toContain('deleted');
    expect(editor.state().draft!.values.col_desc).toBe('My unsent draft');
    const expected = owner.state().workspace;
    // Restart the actual server process object using the same schema and certificate.
    await server.stop();
    const pool = new pg.Pool({ connectionString: db.databaseUrl, options: `-c search_path=${db.schema},public` });
    server = new CollabServer({ store: new PgServerStore(pool, { ownsPool: true }), dataDir: path.join(dir, 'server'), host: '127.0.0.1', port, discovery: false, now: () => new Date(now) });
    await server.start(); await until(() => clients.every(c => c.state().connection === 'connected'));
    expect(owner.state().workspace).toEqual(expected); expect(viewer.state().workspace).toEqual(expected);
  } finally { for (const client of clients) client.close(); await discovery.stop(); await server.stop(); await db.cleanup(); rmSync(dir, { recursive: true, force: true }); }
}, 20000);
