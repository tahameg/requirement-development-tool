import type { ObjectType } from '../../shared/types/config.js';
import type { Workspace, Item } from '../../shared/types/workspace.js';
import { formatId } from '../../shared/utils/idUtils.js';
import { componentChain, validateWorkspace } from './validation.js';

/** Pure transaction: caller persists the returned workspace before publishing it. */
export function addItem(input: Workspace, type: ObjectType, requirementSetId: string, values: Item['values'] = {}): Workspace {
  const workspace = validateWorkspace(input);
  const domain = workspace.domains[type];
  const fn = domain.requirementSets.find(f => f.requirementSetId === requirementSetId);
  if (!fn) throw new Error('Requirement set not found');
  if (!workspace.config.objectTypes[type].enabled) throw new Error('Object type disabled');
  const used = new Set([...workspace.retiredIds, ...Object.values(workspace.domains).flatMap(d => d.requirementSets.flatMap(f => f.items.map(i => i.id)))]);
  const prefixes = componentChain(domain.components, fn.parentComponentId).map(m => m.prefix);
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
export function deleteItem(input: Workspace, type: ObjectType, requirementSetId: string, itemId: string): Workspace {
  const workspace = validateWorkspace(input);
  const fn = workspace.domains[type].requirementSets.find(f => f.requirementSetId === requirementSetId);
  if (!fn) throw new Error('Requirement set not found');
  const index = fn.items.findIndex(i => i.id === itemId);
  if (index < 0) throw new Error('Item not found');
  fn.items.splice(index, 1);
  workspace.retiredIds.push(itemId);
  return workspace;
}
