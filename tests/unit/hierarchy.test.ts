import { it, expect } from 'vitest';
import { changeHierarchy } from '../../src/main/services/hierarchyService.js';
import { createWorkspace } from '../../src/main/services/workspaceFactory.js';
import { addItem, deleteItem } from '../../src/main/services/idGenerator.js';
import { objectTypes } from '../../src/shared/types/schema.js';

it('creates nested components and leaf requirementSets in every domain with cascading prefixes', () => {
  let workspace = createWorkspace('Guidance', 'GS');
  const original = structuredClone(workspace);
  for (const objectType of objectTypes) {
    workspace = changeHierarchy(workspace, { action: 'addComponent', objectType, parentId: null, name: ' Compiler ', prefix: 'COMPL', description: 'Component scope' });
    const parent = workspace.domains[objectType].components[0]!;
    workspace = changeHierarchy(workspace, { action: 'addComponent', objectType, parentId: parent.id, name: 'Parser', prefix: '', description: '' });
    const child = workspace.domains[objectType].components[1]!;
    workspace = changeHierarchy(workspace, { action: 'addRequirementSet', objectType, parentId: child.id, name: 'Create parser', prefix: 'CREATE', description: 'Function scope' });
    const fn = workspace.domains[objectType].requirementSets[0]!;
    expect(fn.componentPath).toEqual(['Compiler', 'Parser']); expect(fn.description).toBe('Function scope');
    const values = objectType === 'REQUIREMENT' ? { col_desc: 'The system shall initialize.' } : { col_name: 'Item' };
    workspace = addItem(workspace, objectType, fn.requirementSetId, values);
    expect(workspace.domains[objectType].requirementSets[0]!.items[0]!.id).toBe(`${workspace.config.objectTypes[objectType].prefix}-GS-COMPL-CREATE-001`);
    expect(() => changeHierarchy(workspace, { action: 'addComponent', objectType, parentId: fn.requirementSetId, name: 'Invalid', prefix: '', description: '' })).toThrow('Missing parent');
    expect(() => changeHierarchy(workspace, { action: 'addRequirementSet', objectType, parentId: fn.requirementSetId, name: 'Invalid', prefix: 'X', description: '' })).toThrow('Missing parent');
    expect(() => changeHierarchy(workspace, { action: 'addRequirementSet', objectType, parentId: child.id, name: 'Create parser', prefix: 'OTHER', description: '' })).toThrow('unique');
    workspace = changeHierarchy(workspace, { action: 'addRequirementSet', objectType, parentId: parent.id, name: 'Create parser', prefix: 'OTHER', description: '' });
  }
  expect(original.domains.REQUIREMENT.components).toHaveLength(0);
});
it('edits names, descriptions and prefixes without altering IDs or watermarks; checks sibling uniqueness', () => {
  let workspace = createWorkspace('Test');
  workspace = changeHierarchy(workspace, { action: 'addComponent', objectType: 'REQUIREMENT', parentId: null, name: 'A', prefix: 'A', description: '' });
  const parentId = workspace.domains.REQUIREMENT.components[0]!.id;
  for (const name of ['First', 'Second']) workspace = changeHierarchy(workspace, { action: 'addRequirementSet', objectType: 'REQUIREMENT', parentId, name, prefix: name, description: '' });
  const requirementSetId = workspace.domains.REQUIREMENT.requirementSets[0]!.requirementSetId;
  workspace = addItem(workspace, 'REQUIREMENT', requirementSetId, { col_desc: 'Item' });
  const before = structuredClone(workspace.domains.REQUIREMENT.requirementSets[0]!);
  workspace = changeHierarchy(workspace, { action: 'editComponent', objectType: 'REQUIREMENT', id: parentId, name: 'B', prefix: 'B', description: 'New module scope' });
  workspace = changeHierarchy(workspace, { action: 'editRequirementSet', objectType: 'REQUIREMENT', id: requirementSetId, name: 'Renamed', prefix: 'NEW', description: 'New scope' });
  const fn = workspace.domains.REQUIREMENT.requirementSets[0]!;
  expect(fn.items).toEqual(before.items); expect(fn.watermarkCounter).toBe(before.watermarkCounter);
  expect(fn.componentPath).toEqual(['B']); expect(fn.description).toBe('New scope');
  expect(() => changeHierarchy(workspace, { action: 'editRequirementSet', objectType: 'REQUIREMENT', id: requirementSetId, name: 'Second', prefix: 'Z', description: '' })).toThrow('unique');
  expect(() => changeHierarchy(workspace, { action: 'deleteComponent', objectType: 'ACTION', id: parentId })).toThrow('no longer exists');
  expect(() => changeHierarchy(workspace, { action: 'editComponent', objectType: 'REQUIREMENT', id: 'missing', name: 'X', prefix: '', description: '' })).toThrow('no longer exists');
});
it('deletes a subtree, preserves its siblings, and retires IDs so recreated groups cannot reuse them', () => {
  let workspace = createWorkspace('Test', 'GS');
  const type = 'REQUIREMENT' as const;
  workspace = changeHierarchy(workspace, { action: 'addComponent', objectType: type, parentId: null, name: 'Parent', prefix: 'P', description: '' });
  const parent = workspace.domains[type].components[0]!.id;
  workspace = changeHierarchy(workspace, { action: 'addComponent', objectType: type, parentId: parent, name: 'Child', prefix: 'C', description: '' });
  const child = workspace.domains[type].components[1]!.id;
  workspace = changeHierarchy(workspace, { action: 'addRequirementSet', objectType: type, parentId: child, name: 'Function', prefix: 'FN', description: '' });
  const fn = workspace.domains[type].requirementSets[0]!.requirementSetId;
  workspace = addItem(addItem(workspace, type, fn, { col_desc: 'First' }), type, fn, { col_desc: 'Second' });
  const ids = workspace.domains[type].requirementSets[0]!.items.map(item => item.id);
  workspace = deleteItem(workspace, type, fn, ids[0]!);
  workspace = changeHierarchy(workspace, { action: 'addComponent', objectType: type, parentId: null, name: 'Keep', prefix: 'K', description: '' });
  workspace = changeHierarchy(workspace, { action: 'deleteComponent', objectType: type, id: child });
  expect(workspace.domains[type].components.map(m => m.name)).toEqual(['Parent', 'Keep']);
  expect(workspace.domains[type].requirementSets).toEqual([]); expect(workspace.retiredIds).toEqual(ids);
  workspace = changeHierarchy(workspace, { action: 'addRequirementSet', objectType: type, parentId: parent, name: 'Replacement', prefix: 'C_FN', description: '' });
  const replacement = workspace.domains[type].requirementSets[0]!.requirementSetId;
  workspace = changeHierarchy(workspace, { action: 'deleteRequirementSet', objectType: type, id: replacement });
  expect(workspace.domains[type].components).toHaveLength(2);
  workspace = changeHierarchy(workspace, { action: 'addComponent', objectType: type, parentId: parent, name: 'Recreated', prefix: 'C', description: '' });
  workspace = changeHierarchy(workspace, { action: 'addRequirementSet', objectType: type, parentId: workspace.domains[type].components.at(-1)!.id, name: 'Recreated', prefix: 'FN', description: '' });
  workspace = addItem(workspace, type, workspace.domains[type].requirementSets[0]!.requirementSetId, { col_desc: 'Next' });
  expect(workspace.domains[type].requirementSets[0]!.items[0]!.seq).toBe(3);
  workspace = changeHierarchy(workspace, { action: 'deleteRequirementSet', objectType: type, id: workspace.domains[type].requirementSets[0]!.requirementSetId });
  expect(workspace.retiredIds).toHaveLength(3);
});
it('rejects invalid mutations, disabled domains and roots as edit/delete targets', () => {
  const workspace = createWorkspace('Test');
  expect(() => changeHierarchy(workspace, { action: 'deleteRoot', objectType: 'REQUIREMENT' })).toThrow();
  expect(() => changeHierarchy(workspace, { action: 'addComponent', objectType: 'REQUIREMENT', parentId: null, name: 'X', prefix: '../bad', description: '' })).toThrow();
  expect(() => changeHierarchy(workspace, { action: 'addRequirementSet', objectType: 'REQUIREMENT', parentId: null, name: 'X', prefix: 'X', description: '' })).toThrow();
  workspace.config.objectTypes.ACTION.enabled = false;
  expect(() => changeHierarchy(workspace, { action: 'addComponent', objectType: 'ACTION', parentId: null, name: 'X', prefix: '', description: '' })).toThrow('disabled');
});
