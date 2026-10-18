import type { HierarchySelection } from './hierarchy.js';

/** A component without a parent is a Component; nested ones are Subcomponents. */
export function nodeTerm(kind: HierarchySelection['kind'], parentId?: string | null): string {
  if (kind === 'requirementSet') return 'Requirement set';
  if (kind === 'component') return parentId ? 'Subcomponent' : 'Component';
  return 'Object type';
}
export function childTerm(parentKind: HierarchySelection['kind']): string {
  return parentKind === 'root' ? 'Component' : 'Subcomponent';
}
export function plural(count: number, singular: string, many = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : many}`;
}
