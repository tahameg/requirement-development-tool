import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { applyWorkspaceOp } from '../../src/server/opEngine.js';
import { addFunction, addModule, createWorkspace } from '../../src/main/services/workspaceFactory.js';
import { validateWorkspace } from '../../src/main/services/validation.js';
import type { CollabOp } from '../../src/shared/collab/types.js';

function seed() {
  let workspace = addModule(createWorkspace('Test', 'T'), 'REQUIREMENT', 'Module', 'M');
  workspace = addFunction(workspace, 'REQUIREMENT', workspace.domains.REQUIREMENT.modules[0]!.id, 'Function', 'F');
  return workspace;
}

describe('ordered operation domain engine', () => {
  it('replays server-chosen identities and timestamps exactly across dependent operations', () => {
    const initial = createWorkspace('Test', 'T');
    let live = initial;
    const log: Array<{ op: CollabOp; result: ReturnType<typeof applyWorkspaceOp>['result'] }> = [];
    const apply = (op: CollabOp) => {
      const next = applyWorkspaceOp(live, op);
      live = next.workspace; log.push({ op, result: next.result });
    };
    apply({ opId: randomUUID(), kind: 'hierarchy', payload: { action: 'addModule', objectType: 'REQUIREMENT', parentId: null, name: 'Module', prefix: 'M', description: '' } });
    apply({ opId: randomUUID(), kind: 'hierarchy', payload: { action: 'addFunction', objectType: 'REQUIREMENT', parentId: live.domains.REQUIREMENT.modules[0]!.id, name: 'Function', prefix: 'F', description: '' } });
    const functionId = live.domains.REQUIREMENT.functions[0]!.functionId;
    apply({ opId: randomUUID(), kind: 'item.add', payload: { objectType: 'REQUIREMENT', functionId, values: { col_desc: 'Initial' } } });
    const itemId = live.domains.REQUIREMENT.functions[0]!.items[0]!.id;
    apply({ opId: randomUUID(), kind: 'item.edit', payload: { objectType: 'REQUIREMENT', functionId, itemId, values: { col_desc: 'Changed' } } });
    apply({ opId: randomUUID(), kind: 'function.description', payload: { objectType: 'REQUIREMENT', functionId, description: 'Scope' } });
    const replayed = log.reduce((workspace, entry) => applyWorkspaceOp(workspace, entry.op, entry.result).workspace, initial);
    expect(replayed).toEqual(live);
    expect(validateWorkspace(replayed)).toEqual(live);
    expect(initial.domains.REQUIREMENT.modules).toEqual([]);
  });

  it('merges patches, preserves unrelated columns, rejects invalid values and missing rows without mutation', () => {
    let workspace = seed();
    const functionId = workspace.domains.REQUIREMENT.functions[0]!.functionId;
    workspace = applyWorkspaceOp(workspace, { opId: randomUUID(), kind: 'item.add', payload: { objectType: 'REQUIREMENT', functionId, values: { col_desc: 'Initial' } } }).workspace;
    const itemId = workspace.domains.REQUIREMENT.functions[0]!.items[0]!.id;
    const edit = (values: Record<string, string>) => applyWorkspaceOp(workspace, { opId: randomUUID(), kind: 'item.edit', payload: { objectType: 'REQUIREMENT', functionId, itemId, values } });
    expect(edit({ col_desc: 'Updated' }).workspace.domains.REQUIREMENT.functions[0]!.items[0]!.values).toEqual({ col_desc: 'Updated', col_status: 'Draft' });
    expect(() => edit({ col_desc: '' })).toThrow('Required');
    expect(() => edit({ col_status: 'invalid' })).toThrow('Invalid');
    expect(() => edit({ unknown: 'value' })).toThrow('Unknown');
    expect(workspace.domains.REQUIREMENT.functions[0]!.items[0]!.values.col_desc).toBe('Initial');
    expect(() => applyWorkspaceOp(workspace, { opId: randomUUID(), kind: 'item.edit', payload: { objectType: 'REQUIREMENT', functionId, itemId: 'missing', values: {} } })).toThrow('no longer exists');
  });

  it('retires deleted IDs and rejects deleting referenced targets', () => {
    let workspace = seed();
    const functionId = workspace.domains.REQUIREMENT.functions[0]!.functionId;
    const add: CollabOp = { opId: randomUUID(), kind: 'item.add', payload: { objectType: 'REQUIREMENT', functionId, values: { col_desc: 'Initial' } } };
    workspace = applyWorkspaceOp(workspace, add).workspace;
    const itemId = workspace.domains.REQUIREMENT.functions[0]!.items[0]!.id;
    workspace = applyWorkspaceOp(workspace, { opId: randomUUID(), kind: 'item.delete', payload: { objectType: 'REQUIREMENT', functionId, itemId } }).workspace;
    expect(workspace.retiredIds).toContain(itemId);
    expect(applyWorkspaceOp(workspace, add).workspace.domains.REQUIREMENT.functions[0]!.items[0]!.id).not.toBe(itemId);
    workspace = addModule(workspace, 'ENTITY', 'Entities', 'E');
    workspace = addFunction(workspace, 'ENTITY', workspace.domains.ENTITY.modules[0]!.id, 'Entities', 'F');
    const targetFunction = workspace.domains.ENTITY.functions[0]!.functionId;
    workspace = applyWorkspaceOp(workspace, { opId: randomUUID(), kind: 'item.add', payload: { objectType: 'ENTITY', functionId: targetFunction, values: { col_name: 'Target' } } }).workspace;
    const target = workspace.domains.ENTITY.functions[0]!.items[0]!.id;
    workspace.config.objectTypes.REQUIREMENT.columns.push({ id: 'ref', name: 'Ref', type: 'reference', referenceTypes: ['ENTITY'] });
    workspace = applyWorkspaceOp(workspace, { ...add, payload: { ...add.payload, values: { col_desc: 'Reference', ref: target } } }).workspace;
    expect(() => applyWorkspaceOp(workspace, { opId: randomUUID(), kind: 'item.delete', payload: { objectType: 'ENTITY', functionId: targetFunction, itemId: target } })).toThrow('Unresolved reference');
  });

  it('edits a 10,000-item workspace in under 5ms without revalidating unrelated rows', () => {
    let workspace = seed();
    const fn = workspace.domains.REQUIREMENT.functions[0]!;
    fn.items = Array.from({ length: 10000 }, (_, i) => ({ id: `REQ-T-M-F-${String(i + 1).padStart(3, '0')}`, seq: i + 1, created_at: '2026-01-01T00:00:00.000Z', values: { col_desc: 'Requirement', col_status: 'Draft' } }));
    fn.watermarkCounter = 10000;
    workspace = validateWorkspace(workspace);
    const op: CollabOp = { opId: randomUUID(), kind: 'item.edit', payload: { objectType: 'REQUIREMENT', functionId: fn.functionId, itemId: fn.items.at(-1)!.id, values: { col_desc: 'Changed' } } };
    applyWorkspaceOp(workspace, op); // warm up
    const start = performance.now();
    const next = applyWorkspaceOp(workspace, op);
    expect(performance.now() - start).toBeLessThan(5);
    expect(next.workspace.domains.REQUIREMENT.functions[0]!.items.at(-1)!.values.col_desc).toBe('Changed');
    expect(next.workspace.domains.REQUIREMENT.functions[0]!.items[0]).toBe(workspace.domains.REQUIREMENT.functions[0]!.items[0]);
  });
});
