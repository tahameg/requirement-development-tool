import type { Workspace } from './types/workspace.js';
import type { ObjectType } from './types/config.js';
export interface ReferenceTarget { id: string; label: string; requirementSetId: string; objectType: ObjectType; }
export function referenceTargets(workspace: Workspace): ReferenceTarget[] {
  return (['DATA_DICTIONARY', 'ENTITY', 'ACTION'] as const).flatMap(objectType => workspace.domains[objectType].requirementSets.flatMap(fn => fn.items.map(item => ({
    id: item.id, label: String(item.values.col_name ?? item.values.col_desc ?? fn.name), requirementSetId: fn.requirementSetId, objectType,
  }))));
}
export function validateReferences(workspace: Workspace): void {
  const targets = new Map(referenceTargets(workspace).map(item => [item.id, item]));
  for (const [type, domain] of Object.entries(workspace.domains)) {
    const columns = workspace.config.objectTypes[type as ObjectType].columns.filter(c => c.type === 'reference');
    for (const fn of domain.requirementSets) for (const item of fn.items) for (const column of columns) {
      const value = item.values[column.id];
      if (value === undefined || value === '' || value === null) continue;
      const target = targets.get(String(value));
      if (!target || column.referenceTypes && !column.referenceTypes.includes(target.objectType)) throw new Error(`Unresolved reference in ${item.id}, ${column.name}: ${value}. Clear incoming references before deleting their target.`);
    }
  }
}
