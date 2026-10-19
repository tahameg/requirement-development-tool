import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { CollabServer } from '../../src/server/httpServer.js';
import { CollabClient } from '../../src/main/collab/collabClient.js';
import { addRequirementSet, addComponent, createWorkspace } from '../../src/main/services/workspaceFactory.js';
import { createTestStore } from './testDbHelper.js';
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function until(check: () => boolean) { for (let i = 0; i < 150; i++) { if (check()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('Condition not met'); }
async function signedIn(dir: string, url: string, name: string, method: 'setup' | 'register' | 'login', extra: Record<string, string> = {}) {
  const client = new CollabClient(path.join(dir, `${name}-${randomUUID()}`)); cleanup.push(() => client.close());
  const probe = await client.probe(url); await client.connect(probe.address, probe.fingerprint);
  await client.auth(method, { username: name, password: 'password123', ...method === 'login' ? {} : { displayName: name }, ...extra });
  return client;
}
async function room() {
  const db = await createTestStore(); cleanup.push(db.cleanup);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hlr-session-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const server = new CollabServer({ store: db.store, dataDir: path.join(dir, 'server'), host: '127.0.0.1', port: 0, discovery: false });
  const info = await server.start(); cleanup.push(() => server.stop());
  const url = server.getBaseUrl();
  const owner = await signedIn(dir, url, 'owner', 'setup', { setupToken: info.setupToken! });
  let workspace = addComponent(createWorkspace('Team', 'T'), 'REQUIREMENT', 'Navigation', 'NAV');
  workspace = addRequirementSet(workspace, 'REQUIREMENT', workspace.domains.REQUIREMENT.components[0]!.id, 'Guidance', 'GUID');
  const { room } = await owner.request('POST', '/api/rooms', { name: 'Team', visibility: 'listed', workspace });
  const editor = await signedIn(dir, url, 'editor', 'register');
  const { inviteCode } = await owner.request('POST', `/api/rooms/${room.id}/invite-codes`, { role: 'EDITOR', maxUses: 5, expiresInSeconds: 3600 });
  await editor.request('POST', '/api/invites/redeem', { code: inviteCode.code });
  for (const client of [owner, editor]) await client.join(room.id);
  await until(() => owner.state().connection === 'connected' && editor.state().connection === 'connected');
  return { owner, editor, dir, url, roomId: room.id, requirementSetId: workspace.domains.REQUIREMENT.requirementSets[0]!.requirementSetId };
}

it('pauses the room while project settings change and reconciles open drafts afterwards', async () => {
  const { owner, editor, requirementSetId } = await room();
  const add = (client: CollabClient, text: string) => client.sendOp({ opId: randomUUID(), kind: 'item.add', payload: { objectType: 'REQUIREMENT', requirementSetId, values: { col_desc: text } } });
  editor.setDraft({ objectType: 'REQUIREMENT', requirementSetId, itemId: null, values: { col_desc: 'Draft', col_status: 'Draft' }, baseValues: {} });
  await owner.lock('acquire', 'config');
  await until(() => !!editor.state().locks.config);
  await expect(add(editor, 'During the session')).rejects.toThrow('owner is changing project settings');
  await expect(editor.lock('acquire', 'config')).rejects.toThrow('You cannot acquire this lock');
  const config = structuredClone(owner.state().workspace!.config);
  config.objectTypes.REQUIREMENT.columns = config.objectTypes.REQUIREMENT.columns.filter(c => c.id !== 'col_status');
  config.objectTypes.REQUIREMENT.columns.push({ id: 'col_rationale', name: 'Rationale', type: 'text' });
  await owner.sendOp({ opId: randomUUID(), kind: 'config.update', payload: config });
  await owner.lock('release', 'config');
  await until(() => !editor.state().locks.config && !!editor.state().settingsChange);
  expect(editor.state().settingsChange).toEqual({ columnsAdded: ['Rationale'], columnsRemoved: ['Status'], draftValuesDropped: ['Status'] });
  expect(editor.state().draft!.values).toEqual({ col_desc: 'Draft' });
  editor.ackSettingsChange(); expect(editor.state().settingsChange).toBeNull();
  await add(editor, 'After the session');
  await until(() => owner.state().workspace!.domains.REQUIREMENT.requirementSets[0]!.items.length === 1);
});

it('tells the same account apart across two windows by session key', async () => {
  const { owner, dir, url, roomId, requirementSetId } = await room();
  const second = await signedIn(dir, url, 'owner', 'login');
  await second.join(roomId); await until(() => second.state().connection === 'connected');
  expect(second.state().user!.id).toBe(owner.state().user!.id);
  expect(second.state().sessionKey).not.toBe(owner.state().sessionKey);
  await owner.sendOp({ opId: randomUUID(), kind: 'item.add', payload: { objectType: 'REQUIREMENT', requirementSetId, values: { col_desc: 'x' } } });
  const itemId = owner.state().workspace!.domains.REQUIREMENT.requirementSets[0]!.items[0]!.id;
  await until(() => !!second.state().locks[`item:${itemId}`]);
  expect(second.state().locks[`item:${itemId}`]!.sessionKey).toBe(owner.state().sessionKey);
  await expect(second.lock('acquire', `item:${itemId}`)).rejects.toThrow('Being edited by owner');
});

it('broadcasts and clears the node a peer is creating', async () => {
  const { owner, editor } = await room();
  editor.presence({ type: 'presence-update', view: null, focus: null, drafting: null, creating: { objectType: 'REQUIREMENT', kind: 'component', parentId: null, name: 'Telemetry' } });
  await until(() => owner.state().presence.some(p => p.user.name === 'editor' && p.state.creating?.name === 'Telemetry'));
  editor.presence({ type: 'presence-update', view: null, focus: null, drafting: null, creating: null });
  await until(() => owner.state().presence.some(p => p.user.name === 'editor' && !p.state.creating));
});
