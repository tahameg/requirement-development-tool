import { it, expect } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, readdir, mkdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkspace, addComponent, addRequirementSet } from '../../src/main/services/workspaceFactory.js';
import { saveWorkspace, loadWorkspace } from '../../src/main/services/workspaceService.js';
import { addItem, deleteItem } from '../../src/main/services/idGenerator.js';
import { objectTypes } from '../../src/shared/types/schema.js';

it('round-trips all domains, descriptions, schema, gaps and watermarks as readable JSON', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hlr-'));
  try {
    let w = createWorkspace('Test', 'GS');
    for (const type of objectTypes) {
      w = addComponent(w, type, 'Module');
      w = addRequirementSet(w, type, w.domains[type].components[0]!.id, 'Function', 'Fn');
      const fn = w.domains[type].requirementSets[0]!;
      fn.description = '# Scope\nUnicode: İ';
      const values = type === 'REQUIREMENT' ? { col_desc: 'The system shall work.' } : { col_name: 'Item' };
      w = addItem(w, type, fn.requirementSetId, values);
      w = deleteItem(w, type, fn.requirementSetId, w.domains[type].requirementSets[0]!.items[0]!.id);
    }
    await saveWorkspace(root, w);
    expect(await loadWorkspace(root)).toEqual(w);
    const text = await readFile(path.join(root, 'project.config.json'), 'utf8');
    expect(text).toContain('\n  "version"');
    const loaded = await loadWorkspace(root);
    const next = addItem(loaded, 'REQUIREMENT', loaded.domains.REQUIREMENT.requirementSets[0]!.requirementSetId, { col_desc: 'Next' });
    expect(next.domains.REQUIREMENT.requirementSets[0]!.items[0]!.seq).toBe(2);
    next.domains.ACTION.requirementSets = [];
    await Promise.all([saveWorkspace(root, w), saveWorkspace(root, next)]);
    expect(await loadWorkspace(root)).toEqual(next);
    expect(await readdir(path.join(root, 'actions', 'requirement-sets'))).toEqual([]);
    await rm(path.join(root, 'retired-ids.json'));
    expect((await loadWorkspace(root)).retiredIds).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('replays interrupted saves and refuses malformed files without overwriting them', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hlr-'));
  try {
    const w = createWorkspace('Recovered');
    await mkdir(path.join(root, '.hlr'));
    await writeFile(path.join(root, '.hlr', 'pending-save.json'), JSON.stringify(w));
    await writeFile(path.join(root, 'project.config.json'), '{truncated');
    expect(await loadWorkspace(root)).toEqual(w);
    await writeFile(path.join(root, 'project.config.json'), '{broken');
    await expect(loadWorkspace(root)).rejects.toThrow();
    expect(await readFile(path.join(root, 'project.config.json'), 'utf8')).toBe('{broken');
    await expect(saveWorkspace(root, {} as any)).rejects.toThrow();
    await saveWorkspace(root, w);
    await writeFile(path.join(root, 'retired-ids.json'), 'bad');
    await expect(loadWorkspace(root)).rejects.toThrow();
    await writeFile(path.join(root, '.hlr', 'pending-save.json'), 'bad');
    await expect(loadWorkspace(root)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('rejects symbolic link directories before writing into them', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hlr-'));
  try {
    await mkdir(path.join(root, 'target'));
    await symlink(path.join(root, 'target'), path.join(root, 'requirements'));
    await expect(saveWorkspace(root, createWorkspace('Test'))).rejects.toThrow('symbolic links');
    expect(await readdir(path.join(root, 'target'))).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
