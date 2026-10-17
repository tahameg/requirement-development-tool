import { changeHierarchy } from '../main/services/hierarchyService.js';
import { addItem, deleteItem } from '../main/services/idGenerator.js';
import { validateValue, validateWorkspace } from '../main/services/validation.js';
import { updateProjectConfig } from '../main/config/projectConfig.js';
import type { CollabOp, OpRejectCode } from '../shared/collab/types.js';
import type { Workspace } from '../shared/types/workspace.js';

export class OpError extends Error {
  constructor(readonly code: OpRejectCode, message: string) { super(message); }
}

/** Server-chosen identity and time are logged with the operation for deterministic replay. */
export interface OpResult { createdId?: string; timestamp: string }
export function applyWorkspaceOp(input: Workspace, op: CollabOp, result: OpResult = { timestamp: new Date().toISOString() }): { workspace: Workspace; result: OpResult } {
  if (op.kind === 'room.restore') throw new OpError('VALIDATION', 'Revision restore is not implemented yet.');
  if (op.kind === 'config.update') return { workspace: updateProjectConfig(input, op.payload), result };
  if (op.kind === 'hierarchy') {
    const workspace = changeHierarchy(input, op.payload);
    const domain = workspace.domains[op.payload.objectType];
    if (op.payload.action === 'addModule') {
      const node = domain.modules.at(-1)!;
      node.id = result.createdId ?? node.id;
      result = { ...result, createdId: node.id };
    } else if (op.payload.action === 'addFunction') {
      const node = domain.functions.at(-1)!;
      node.functionId = result.createdId ?? node.functionId;
      result = { ...result, createdId: node.functionId };
    }
    return { workspace, result };
  }
  const p = op.payload;
  const domain = input.domains[p.objectType];
  const config = input.config.objectTypes[p.objectType];
  if (!config.enabled) throw new OpError('VALIDATION', 'Object type is disabled.');
  const fn = domain.functions.find(f => f.functionId === p.functionId);
  if (!fn) throw new OpError('NOT_FOUND', 'Function no longer exists.');
  if (op.kind === 'item.add') {
    const workspace = addItem(input, p.objectType, p.functionId, op.payload.values);
    const item = workspace.domains[p.objectType].functions.find(f => f.functionId === p.functionId)!.items.at(-1)!;
    if (result.createdId && result.createdId !== item.id) throw new Error('Operation replay allocated a different item ID');
    item.created_at = result.timestamp;
    return { workspace, result: { ...result, createdId: item.id } };
  }
  if (op.kind === 'item.delete') {
    return { workspace: validateWorkspace(deleteItem(input, p.objectType, p.functionId, op.payload.itemId)), result };
  }
  // Copy only the touched path. Live typing never clones or validates the entire workspace.
  let nextFn = { ...fn };
  if (op.kind === 'function.description') nextFn.description = op.payload.description;
  else {
    const index = fn.items.findIndex(i => i.id === op.payload.itemId);
    if (index < 0) throw new OpError('NOT_FOUND', 'Item no longer exists.');
    const item = fn.items[index]!;
    const values = { ...item.values, ...op.payload.values };
    for (const [key, value] of Object.entries(op.payload.values)) {
      const column = config.columns.find(c => c.id === key);
      if (!column) throw new OpError('VALIDATION', 'Unknown column.');
      validateValue(column, value);
      if (column.type === 'reference' && value !== null && value !== '') {
        const found = (['DATA_DICTIONARY', 'ENTITY', 'ACTION'] as const).some(type =>
          (!column.referenceTypes || column.referenceTypes.includes(type)) && input.domains[type].functions.some(f => f.items.some(i => i.id === value)));
        if (!found) throw new OpError('VALIDATION', `Unresolved reference: ${value}`);
      }
    }
    nextFn.items = fn.items.slice();
    nextFn.items[index] = { ...item, values, updated_at: result.timestamp };
  }
  return { workspace: { ...input, domains: { ...input.domains, [p.objectType]: { ...domain, functions: domain.functions.map(f => f === fn ? nextFn : f) } } }, result };
}
