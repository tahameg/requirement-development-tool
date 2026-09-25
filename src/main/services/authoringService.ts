import type { Workspace } from '../../shared/types/workspace.js';
import { editFunctionSchema } from '../../shared/authoring.js';
import { addItem, deleteItem } from './idGenerator.js';
import { validateWorkspace } from './validation.js';
export function editFunction(input: Workspace, raw: unknown): Workspace {
  const command = editFunctionSchema.parse(raw);
  let workspace = validateWorkspace(input);
  if (!workspace.config.objectTypes[command.objectType].enabled) throw new Error('This object type is disabled');
  let fn = workspace.domains[command.objectType].functions.find(f => f.functionId === command.functionId);
  if (!fn) throw new Error('Function not found');
  if (command.description !== undefined) fn.description = command.description;
  for (const change of command.changes) {
    if (change.action === 'add') workspace = addItem(workspace, command.objectType, command.functionId, change.values);
    else if (change.action === 'delete') workspace = deleteItem(workspace, command.objectType, command.functionId, change.id);
    else {
      fn = workspace.domains[command.objectType].functions.find(f => f.functionId === command.functionId)!;
      const item = fn.items.find(i => i.id === change.id);
      if (!item) throw new Error('Item not found');
      item.values = change.values;
      item.updated_at = new Date().toISOString();
    }
  }
  return validateWorkspace(workspace);
}
