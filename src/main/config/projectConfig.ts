import { projectConfigSchema } from '../../shared/types/schema.js';
import type { Workspace } from '../../shared/types/workspace.js';
import { validateWorkspace } from '../services/validation.js';
/** Validate settings against the existing items; never regenerate existing IDs. */
export function updateProjectConfig(workspace: Workspace, input: unknown): Workspace {
  const config = projectConfigSchema.parse(input);
  if (config.projectId !== workspace.config.projectId) throw new Error('Project identity cannot be changed');
  const next = structuredClone(workspace);
  for (const type of Object.keys(config.objectTypes) as (keyof typeof config.objectTypes)[]) {
    const previous = workspace.config.objectTypes[type].columns;
    const columns = config.objectTypes[type].columns;
    for (const system of previous.filter(c => c.system)) {
      const replacement = columns.find(c => c.id === system.id);
      if (!replacement || !replacement.system || replacement.type !== system.type || replacement.required !== system.required) throw new Error(`Cannot remove or change the type/required rule of system column ${system.name}`);
    }
    for (const fn of next.domains[type].requirementSets) for (const item of fn.items) {
      const old = item.values;
      item.values = Object.fromEntries(columns.flatMap(column => {
        const value = old[column.id] === undefined ? column.default : old[column.id];
        return value === undefined ? [] : [[column.id, value]];
      }));
    }
  }
  next.config = config;
  return validateWorkspace(next);
}
