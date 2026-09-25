import type { ObjectType } from '../../shared/types/config.js';
import type { Workspace, Item } from '../../shared/types/workspace.js';
import { formatId } from '../../shared/utils/idUtils.js';
import { moduleChain, validateWorkspace } from './validation.js';

/** Pure transaction: caller persists the returned workspace before publishing it. */
export function addItem(input: Workspace, type: ObjectType, functionId: string, values: Item['values'] = {}): Workspace {
  const workspace = validateWorkspace(input);
  const domain = workspace.domains[type];
  const fn = domain.functions.find(f => f.functionId === functionId);
  if (!fn) throw new Error('Function not found');
  if (!workspace.config.objectTypes[type].enabled) throw new Error('Object type disabled');
  const used = new Set([...workspace.retiredIds, ...Object.values(workspace.domains).flatMap(d => d.functions.flatMap(f => f.items.map(i => i.id)))]);
  const prefixes = moduleChain(domain.modules, fn.parentModuleId).map(m => m.prefix);
  let seq = fn.watermarkCounter;
  let id: string;
  do { id = formatId(workspace.config, type, prefixes, fn.prefix, ++seq); } while (used.has(id));
  const defaults: Item['values'] = {};
  for (const column of workspace.config.objectTypes[type].columns) {
    if (column.default !== undefined) defaults[column.id] = column.default;
  }
  fn.watermarkCounter = seq;
  fn.items.push({ id, seq, created_at: new Date().toISOString(), values: { ...defaults, ...values } });
  return validateWorkspace(workspace);
}
export function deleteItem(input: Workspace, type: ObjectType, functionId: string, itemId: string): Workspace {
  const workspace = validateWorkspace(input);
  const fn = workspace.domains[type].functions.find(f => f.functionId === functionId);
  if (!fn) throw new Error('Function not found');
  const index = fn.items.findIndex(i => i.id === itemId);
  if (index < 0) throw new Error('Item not found');
  fn.items.splice(index, 1);
  workspace.retiredIds.push(itemId);
  return workspace;
}
