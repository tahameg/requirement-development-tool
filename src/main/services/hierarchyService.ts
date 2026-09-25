import type { Workspace } from '../../shared/types/workspace.js';
import { hierarchyCommandSchema } from '../../shared/hierarchy.js';
import { addModule, addFunction } from './workspaceFactory.js';
import { validateWorkspace } from './validation.js';

/** An immutable domain transaction. Persistence must succeed before publishing it. */
export function changeHierarchy(input: Workspace, command: unknown): Workspace {
  const change = hierarchyCommandSchema.parse(command);
  let workspace = validateWorkspace(input);
  if (!workspace.config.objectTypes[change.objectType].enabled) throw new Error('This object type is disabled in project settings');
  let domain = workspace.domains[change.objectType];
  if (change.action === 'addModule') {
    workspace = addModule(workspace, change.objectType, change.name, change.prefix, change.parentId);
    workspace.domains[change.objectType].modules.at(-1)!.description = change.description;
  } else if (change.action === 'addFunction') {
    workspace = addFunction(workspace, change.objectType, change.parentId, change.name, change.prefix);
    workspace.domains[change.objectType].functions.at(-1)!.description = change.description;
  } else {
    const isModule = change.action === 'editModule' || change.action === 'deleteModule';
    const target = isModule ? domain.modules.find(m => m.id === change.id) : domain.functions.find(f => f.functionId === change.id);
    if (!target) throw new Error('The selected object no longer exists');
    if (change.action === 'editModule' || change.action === 'editFunction') {
      target.name = change.name; target.prefix = change.prefix; target.description = change.description;
    } else {
      const moduleIds = new Set<string>();
      if (change.action === 'deleteModule') {
        moduleIds.add(change.id);
        let grew = true;
        while (grew) {
          grew = false;
          for (const module of domain.modules) {
            if (module.parentId && moduleIds.has(module.parentId) && !moduleIds.has(module.id)) { moduleIds.add(module.id); grew = true; }
          }
        }
      }
      const removed = domain.functions.filter(fn => moduleIds.has(fn.parentModuleId) || change.action === 'deleteFunction' && fn.functionId === change.id);
      const functionIds = new Set(removed.map(fn => fn.functionId));
      workspace.retiredIds.push(...removed.flatMap(fn => fn.items.map(item => item.id)));
      domain.functions = domain.functions.filter(fn => !functionIds.has(fn.functionId));
      domain.modules = domain.modules.filter(module => !moduleIds.has(module.id));
    }
  }
  return validateWorkspace(workspace);
}
