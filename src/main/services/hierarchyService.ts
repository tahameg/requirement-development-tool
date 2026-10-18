import type { Workspace } from '../../shared/types/workspace.js';
import { hierarchyCommandSchema } from '../../shared/hierarchy.js';
import { addComponent, addRequirementSet } from './workspaceFactory.js';
import { validateWorkspace } from './validation.js';

/** An immutable domain transaction. Persistence must succeed before publishing it. */
export function changeHierarchy(input: Workspace, command: unknown): Workspace {
  const change = hierarchyCommandSchema.parse(command);
  let workspace = validateWorkspace(input);
  if (!workspace.config.objectTypes[change.objectType].enabled) throw new Error('This object type is disabled in project settings');
  let domain = workspace.domains[change.objectType];
  if (change.action === 'addComponent') {
    workspace = addComponent(workspace, change.objectType, change.name, change.prefix, change.parentId);
    workspace.domains[change.objectType].components.at(-1)!.description = change.description;
  } else if (change.action === 'addRequirementSet') {
    workspace = addRequirementSet(workspace, change.objectType, change.parentId, change.name, change.prefix);
    workspace.domains[change.objectType].requirementSets.at(-1)!.description = change.description;
  } else {
    const isComponent = change.action === 'editComponent' || change.action === 'deleteComponent';
    const target = isComponent ? domain.components.find(m => m.id === change.id) : domain.requirementSets.find(f => f.requirementSetId === change.id);
    if (!target) throw new Error('The selected object no longer exists');
    if (change.action === 'editComponent' || change.action === 'editRequirementSet') {
      target.name = change.name; target.prefix = change.prefix; target.description = change.description;
    } else {
      const componentIds = new Set<string>();
      if (change.action === 'deleteComponent') {
        componentIds.add(change.id);
        let grew = true;
        while (grew) {
          grew = false;
          for (const module of domain.components) {
            if (module.parentId && componentIds.has(module.parentId) && !componentIds.has(module.id)) { componentIds.add(module.id); grew = true; }
          }
        }
      }
      const removed = domain.requirementSets.filter(fn => componentIds.has(fn.parentComponentId) || change.action === 'deleteRequirementSet' && fn.requirementSetId === change.id);
      const requirementSetIds = new Set(removed.map(fn => fn.requirementSetId));
      workspace.retiredIds.push(...removed.flatMap(fn => fn.items.map(item => item.id)));
      domain.requirementSets = domain.requirementSets.filter(fn => !requirementSetIds.has(fn.requirementSetId));
      domain.components = domain.components.filter(module => !componentIds.has(module.id));
    }
  }
  return validateWorkspace(workspace);
}
