import { randomUUID } from 'node:crypto';
import type { Workspace } from '../../shared/types/workspace.js';
import type { ObjectType, ProjectConfig } from '../../shared/types/config.js';
import { objectTypes } from '../../shared/types/schema.js';
import { validateWorkspace } from './validation.js';

export function createWorkspace(projectName: string, projectPrefix = ''): Workspace {
  const labels = ['Requirements', 'Data Dictionary', 'Entity', 'Action'];
  const prefixes = ['REQ', 'DI', 'ENTT', 'ACT'];
  const config: ProjectConfig = {
    version: '1.0.0', projectId: `PRJ-${randomUUID()}`, projectName, projectPrefix, idCasing: 'UPPER',
    objectTypes: Object.fromEntries(objectTypes.map((type, i) => [type, {
      name: labels[i], prefix: prefixes[i], enabled: true, usePrefix: true,
      columns: type === 'REQUIREMENT' ? [
        { id: 'col_desc', name: 'Description', type: 'markdown', required: true, system: true },
        { id: 'col_status', name: 'Status', type: 'enum', options: ['Draft', 'Reviewed', 'Approved', 'Obsolete'], default: 'Draft' },
      ] : [ { id: 'col_name', name: 'Name', type: 'string', required: true }, { id: 'col_desc', name: 'Description', type: 'text' } ],
    }])) as ProjectConfig['objectTypes'],
  };
  return validateWorkspace({ config, domains: Object.fromEntries(objectTypes.map(type => [type, { modules: [], functions: [] }])), retiredIds: [] });
}
export function addModule(input: Workspace, type: ObjectType, name: string, prefix = '', parentId: string | null = null): Workspace {
  const workspace = structuredClone(input);
  workspace.domains[type].modules.push({ id: `mod_${randomUUID()}`, name, prefix, description: '', parentId });
  return validateWorkspace(workspace);
}
export function addFunction(input: Workspace, type: ObjectType, parentModuleId: string, name: string, prefix: string): Workspace {
  const workspace = structuredClone(input);
  workspace.domains[type].functions.push({ functionId: `fn_${randomUUID()}`, name, prefix, parentModuleId, modulePath: [], description: '', watermarkCounter: 0, items: [] });
  return validateWorkspace(workspace);
}
