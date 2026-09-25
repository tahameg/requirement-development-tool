import { it, expect } from 'vitest';
import { changeHierarchy } from '../../src/main/services/hierarchyService.js';
import { createWorkspace } from '../../src/main/services/workspaceFactory.js';
import { addItem, deleteItem } from '../../src/main/services/idGenerator.js';
import { objectTypes } from '../../src/shared/types/schema.js';

it('creates nested modules and leaf functions in every domain with cascading prefixes', () => {
  let workspace = createWorkspace('Guidance', 'GS');
  const original = structuredClone(workspace);
  for (const objectType of objectTypes) {
    workspace = changeHierarchy(workspace, { action: 'addModule', objectType, parentId: null, name: ' Compiler ', prefix: 'COMPL', description: 'Module scope' });
    const parent = workspace.domains[objectType].modules[0]!;
    workspace = changeHierarchy(workspace, { action: 'addModule', objectType, parentId: parent.id, name: 'Parser', prefix: '', description: '' });
    const child = workspace.domains[objectType].modules[1]!;
    workspace = changeHierarchy(workspace, { action: 'addFunction', objectType, parentId: child.id, name: 'Create parser', prefix: 'CREATE', description: 'Function scope' });
    const fn = workspace.domains[objectType].functions[0]!;
    expect(fn.modulePath).toEqual(['Compiler', 'Parser']); expect(fn.description).toBe('Function scope');
    const values = objectType === 'REQUIREMENT' ? { col_desc: 'The system shall initialize.' } : { col_name: 'Item' };
    workspace = addItem(workspace, objectType, fn.functionId, values);
    expect(workspace.domains[objectType].functions[0]!.items[0]!.id).toBe(`${workspace.config.objectTypes[objectType].prefix}-GS-COMPL-CREATE-001`);
    expect(() => changeHierarchy(workspace, { action: 'addModule', objectType, parentId: fn.functionId, name: 'Invalid', prefix: '', description: '' })).toThrow('Missing parent');
    expect(() => changeHierarchy(workspace, { action: 'addFunction', objectType, parentId: fn.functionId, name: 'Invalid', prefix: 'X', description: '' })).toThrow('Missing parent');
    expect(() => changeHierarchy(workspace, { action: 'addFunction', objectType, parentId: child.id, name: 'Create parser', prefix: 'OTHER', description: '' })).toThrow('unique');
    workspace = changeHierarchy(workspace, { action: 'addFunction', objectType, parentId: parent.id, name: 'Create parser', prefix: 'OTHER', description: '' });
  }
  expect(original.domains.REQUIREMENT.modules).toHaveLength(0);
});
it('edits names, descriptions and prefixes without altering IDs or watermarks; checks sibling uniqueness', () => {
  let workspace = createWorkspace('Test');
  workspace = changeHierarchy(workspace, { action: 'addModule', objectType: 'REQUIREMENT', parentId: null, name: 'A', prefix: 'A', description: '' });
  const parentId = workspace.domains.REQUIREMENT.modules[0]!.id;
  for (const name of ['First', 'Second']) workspace = changeHierarchy(workspace, { action: 'addFunction', objectType: 'REQUIREMENT', parentId, name, prefix: name, description: '' });
  const functionId = workspace.domains.REQUIREMENT.functions[0]!.functionId;
  workspace = addItem(workspace, 'REQUIREMENT', functionId, { col_desc: 'Item' });
  const before = structuredClone(workspace.domains.REQUIREMENT.functions[0]!);
  workspace = changeHierarchy(workspace, { action: 'editModule', objectType: 'REQUIREMENT', id: parentId, name: 'B', prefix: 'B', description: 'New module scope' });
  workspace = changeHierarchy(workspace, { action: 'editFunction', objectType: 'REQUIREMENT', id: functionId, name: 'Renamed', prefix: 'NEW', description: 'New scope' });
  const fn = workspace.domains.REQUIREMENT.functions[0]!;
  expect(fn.items).toEqual(before.items); expect(fn.watermarkCounter).toBe(before.watermarkCounter);
  expect(fn.modulePath).toEqual(['B']); expect(fn.description).toBe('New scope');
  expect(() => changeHierarchy(workspace, { action: 'editFunction', objectType: 'REQUIREMENT', id: functionId, name: 'Second', prefix: 'Z', description: '' })).toThrow('unique');
  expect(() => changeHierarchy(workspace, { action: 'deleteModule', objectType: 'ACTION', id: parentId })).toThrow('no longer exists');
  expect(() => changeHierarchy(workspace, { action: 'editModule', objectType: 'REQUIREMENT', id: 'missing', name: 'X', prefix: '', description: '' })).toThrow('no longer exists');
});
it('deletes a subtree, preserves its siblings, and retires IDs so recreated groups cannot reuse them', () => {
  let workspace = createWorkspace('Test', 'GS');
  const type = 'REQUIREMENT' as const;
  workspace = changeHierarchy(workspace, { action: 'addModule', objectType: type, parentId: null, name: 'Parent', prefix: 'P', description: '' });
  const parent = workspace.domains[type].modules[0]!.id;
  workspace = changeHierarchy(workspace, { action: 'addModule', objectType: type, parentId: parent, name: 'Child', prefix: 'C', description: '' });
  const child = workspace.domains[type].modules[1]!.id;
  workspace = changeHierarchy(workspace, { action: 'addFunction', objectType: type, parentId: child, name: 'Function', prefix: 'FN', description: '' });
  const fn = workspace.domains[type].functions[0]!.functionId;
  workspace = addItem(addItem(workspace, type, fn, { col_desc: 'First' }), type, fn, { col_desc: 'Second' });
  const ids = workspace.domains[type].functions[0]!.items.map(item => item.id);
  workspace = deleteItem(workspace, type, fn, ids[0]!);
  workspace = changeHierarchy(workspace, { action: 'addModule', objectType: type, parentId: null, name: 'Keep', prefix: 'K', description: '' });
  workspace = changeHierarchy(workspace, { action: 'deleteModule', objectType: type, id: child });
  expect(workspace.domains[type].modules.map(m => m.name)).toEqual(['Parent', 'Keep']);
  expect(workspace.domains[type].functions).toEqual([]); expect(workspace.retiredIds).toEqual(ids);
  workspace = changeHierarchy(workspace, { action: 'addFunction', objectType: type, parentId: parent, name: 'Replacement', prefix: 'C_FN', description: '' });
  const replacement = workspace.domains[type].functions[0]!.functionId;
  workspace = changeHierarchy(workspace, { action: 'deleteFunction', objectType: type, id: replacement });
  expect(workspace.domains[type].modules).toHaveLength(2);
  workspace = changeHierarchy(workspace, { action: 'addModule', objectType: type, parentId: parent, name: 'Recreated', prefix: 'C', description: '' });
  workspace = changeHierarchy(workspace, { action: 'addFunction', objectType: type, parentId: workspace.domains[type].modules.at(-1)!.id, name: 'Recreated', prefix: 'FN', description: '' });
  workspace = addItem(workspace, type, workspace.domains[type].functions[0]!.functionId, { col_desc: 'Next' });
  expect(workspace.domains[type].functions[0]!.items[0]!.seq).toBe(3);
  workspace = changeHierarchy(workspace, { action: 'deleteFunction', objectType: type, id: workspace.domains[type].functions[0]!.functionId });
  expect(workspace.retiredIds).toHaveLength(3);
});
it('rejects invalid mutations, disabled domains and roots as edit/delete targets', () => {
  const workspace = createWorkspace('Test');
  expect(() => changeHierarchy(workspace, { action: 'deleteRoot', objectType: 'REQUIREMENT' })).toThrow();
  expect(() => changeHierarchy(workspace, { action: 'addModule', objectType: 'REQUIREMENT', parentId: null, name: 'X', prefix: '../bad', description: '' })).toThrow();
  expect(() => changeHierarchy(workspace, { action: 'addFunction', objectType: 'REQUIREMENT', parentId: null, name: 'X', prefix: 'X', description: '' })).toThrow();
  workspace.config.objectTypes.ACTION.enabled = false;
  expect(() => changeHierarchy(workspace, { action: 'addModule', objectType: 'ACTION', parentId: null, name: 'X', prefix: '', description: '' })).toThrow('disabled');
});
