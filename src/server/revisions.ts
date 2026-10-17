import { validateWorkspace } from '../main/services/validation.js';
import type { Workspace } from '../shared/types/workspace.js';
import type { RevisionMetadata } from '../shared/collab/types.js';
import type { RevisionRow } from './store/types.js';
export function revisionMetadata(row: RevisionRow): RevisionMetadata {
  return { id: row.id, roomId: row.room_id, seq: row.seq, message: row.message, authorId: row.author_id, authorName: row.author_name,
    snapshotFilename: `revision-${row.id}.json`, restoredFromId: row.restored_from_id, createdAt: row.created_at };
}
export function restoreWorkspace(current: Workspace, target: Workspace): Workspace {
  const restored = validateWorkspace(target);
  if (restored.config.projectId !== current.config.projectId) throw new Error('Import must use the same project identity. Create a new room for a different project.');
  const retained = new Set(Object.values(restored.domains).flatMap(d => d.functions.flatMap(f => f.items.map(i => i.id))));
  const issued = Object.values(current.domains).flatMap(d => d.functions.flatMap(f => f.items.map(i => i.id)));
  restored.retiredIds = [...new Set([...current.retiredIds, ...restored.retiredIds, ...issued])].filter(id => !retained.has(id));
  for (const [type, domain] of Object.entries(restored.domains)) for (const fn of domain.functions) {
    const previous = current.domains[type as keyof Workspace['domains']].functions.find(f => f.functionId === fn.functionId);
    fn.watermarkCounter = Math.max(fn.watermarkCounter, previous?.watermarkCounter ?? 0);
  }
  return validateWorkspace(restored);
}
export function diffWorkspaces(before: Workspace, after: Workspace) {
  const flatten = (workspace: Workspace) => new Map<string, { kind: string; type: string; value: unknown }>(Object.entries(workspace.domains).flatMap(([type, domain]) => [
    ...domain.modules.map(m => [m.id, { kind: 'module', type, value: m }] as const),
    ...domain.functions.flatMap(f => [[f.functionId, { kind: 'function', type, value: { ...f, items: undefined } }] as const,
      ...f.items.map(i => [i.id, { kind: 'item', type, value: i }] as const)])]));
  const a = flatten(before), b = flatten(after);
  return { configChanged: JSON.stringify(before.config) !== JSON.stringify(after.config),
    added: [...b.keys()].filter(id => !a.has(id)), removed: [...a.keys()].filter(id => !b.has(id)),
    changed: [...b.keys()].filter(id => a.has(id) && JSON.stringify(a.get(id)) !== JSON.stringify(b.get(id))).map(id => ({ id, before: a.get(id), after: b.get(id) })) };
}
