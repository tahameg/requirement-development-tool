import { it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkspace } from '../../src/main/services/workspaceFactory.js';
import { saveWorkspace, loadWorkspace } from '../../src/main/services/workspaceService.js';
import { collabOpSchema } from '../../src/shared/collab/protocol.js';
import { migrateDraft } from '../../src/shared/types/legacy.js';

const directories = { REQUIREMENT: 'requirements', DATA_DICTIONARY: 'data-dictionary', ENTITY: 'entities', ACTION: 'actions' };
const json = (value: unknown) => JSON.stringify(value, null, 2);

it('opens a modules/functions workspace and rewrites it as components and requirement sets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hlr-legacy-'));
  try {
    const { config } = createWorkspace('Legacy', 'GS');
    await writeFile(path.join(root, 'project.config.json'), json(config));
    await writeFile(path.join(root, 'retired-ids.json'), json(['REQ-GS-COMPL-PRS-002']));
    for (const dir of Object.values(directories)) { await mkdir(path.join(root, dir, 'functions'), { recursive: true }); await writeFile(path.join(root, dir, 'modules.json'), '[]'); }
    await writeFile(path.join(root, 'requirements', 'modules.json'), json([{ id: 'mod_1', name: 'Compiler', prefix: 'COMPL', description: '', parentId: null }]));
    await writeFile(path.join(root, 'requirements', 'functions', 'fn-fn_1.json'), json({
      functionId: 'fn_1', name: 'Parse', prefix: 'PRS', modulePath: ['Compiler'], parentModuleId: 'mod_1', description: 'Scope', watermarkCounter: 2,
      items: [{ id: 'REQ-GS-COMPL-PRS-001', seq: 1, created_at: '2026-01-01T00:00:00.000Z', values: { col_desc: 'Parse input', col_status: 'Draft' } }],
    }));
    const workspace = await loadWorkspace(root);
    const set = workspace.domains.REQUIREMENT.requirementSets[0]!;
    expect(workspace.domains.REQUIREMENT.components[0]!.name).toBe('Compiler');
    expect(set).toMatchObject({ requirementSetId: 'fn_1', parentComponentId: 'mod_1', componentPath: ['Compiler'], watermarkCounter: 2 });
    await saveWorkspace(root, workspace);
    expect(existsSync(path.join(root, 'requirements', 'modules.json'))).toBe(false);
    expect(existsSync(path.join(root, 'requirements', 'functions'))).toBe(false);
    expect(await readdir(path.join(root, 'requirements', 'requirement-sets'))).toEqual(['rs-fn_1.json']);
    expect(await loadWorkspace(root)).toEqual(workspace);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('replays stored legacy operations and drafts under the new names', () => {
  expect(collabOpSchema.parse({ opId: 'a', kind: 'function.description', payload: { objectType: 'REQUIREMENT', functionId: 'fn_1', description: 'x' } }))
    .toEqual({ opId: 'a', kind: 'requirementSet.description', payload: { objectType: 'REQUIREMENT', requirementSetId: 'fn_1', description: 'x' } });
  expect(collabOpSchema.parse({ opId: 'b', kind: 'hierarchy', payload: { action: 'addFunction', objectType: 'REQUIREMENT', parentId: 'mod_1', name: 'N', prefix: 'P', description: '' } }).payload)
    .toMatchObject({ action: 'addRequirementSet' });
  expect(collabOpSchema.parse({ opId: 'c', kind: 'item.add', payload: { objectType: 'REQUIREMENT', functionId: 'fn_1', values: {} } }).payload)
    .toEqual({ objectType: 'REQUIREMENT', requirementSetId: 'fn_1', values: {} });
  expect(migrateDraft({ objectType: 'REQUIREMENT', functionId: 'fn_1', itemId: null, values: {}, baseValues: {} }))
    .toEqual({ objectType: 'REQUIREMENT', requirementSetId: 'fn_1', itemId: null, values: {}, baseValues: {} });
});

it('diffs against a revision stored before the rename', async () => {
  const { createTestStore } = await import('./testDbHelper.js');
  const { CollabServer } = await import('../../src/server/httpServer.js');
  const { CollabClient } = await import('../../src/main/collab/collabClient.js');
  const { addComponent, addRequirementSet } = await import('../../src/main/services/workspaceFactory.js');
  const db = await createTestStore(); const dir = await mkdtemp(path.join(os.tmpdir(), 'hlr-legacy-rev-'));
  const server = new CollabServer({ store: db.store, dataDir: path.join(dir, 'server'), host: '127.0.0.1', port: 0, discovery: false });
  const client = new CollabClient(path.join(dir, 'client'));
  try {
    const info = await server.start(); const probe = await client.probe(server.getBaseUrl()); await client.connect(probe.address, probe.fingerprint);
    await client.auth('setup', { setupToken: info.setupToken!, username: 'owner', displayName: 'Owner', password: 'password123' });
    let workspace = addComponent(createWorkspace('Team', 'T'), 'REQUIREMENT', 'Navigation', 'NAV');
    workspace = addRequirementSet(workspace, 'REQUIREMENT', workspace.domains.REQUIREMENT.components[0]!.id, 'Guidance', 'GUID');
    const { room } = await client.request('POST', '/api/rooms', { name: 'Team', visibility: 'listed', workspace });
    const { revision } = await client.request('POST', `/api/rooms/${room.id}/revisions`, { message: 'Before the rename' });
    const legacy = structuredClone(workspace) as any;
    for (const domain of Object.values(legacy.domains) as any[]) {
      domain.modules = domain.components; domain.functions = domain.requirementSets.map(({ requirementSetId, parentComponentId, componentPath, ...rest }: any) => ({ functionId: requirementSetId, parentModuleId: parentComponentId, modulePath: componentPath, ...rest }));
      delete domain.components; delete domain.requirementSets;
    }
    await db.pool.query('UPDATE revisions SET workspace = $1 WHERE id = $2', [JSON.stringify(legacy), revision.id]);
    const diff = await client.request('GET', `/api/rooms/${room.id}/revisions/${revision.id}/diff`);
    expect(diff).toMatchObject({ configChanged: false, added: [], removed: [], changed: [] });
  } finally { client.close(); await server.stop(); await db.cleanup(); await rm(dir, { recursive: true, force: true }); }
});
