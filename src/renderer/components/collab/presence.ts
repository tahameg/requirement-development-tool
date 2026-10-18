import type { CollabState } from '../../../shared/collab/client.js';
import type { LockHolder, PresenceBroadcastEntry } from '../../../shared/collab/types.js';
import type { Workspace } from '../../../shared/types/workspace.js';
import type { ObjectType } from '../../../shared/types/config.js';
import { objectLabels } from '../../../shared/hierarchy.js';
import type { GhostNode, NodeLock, Person } from '../tree/WorkspaceTree.js';

export const person = (entry: PresenceBroadcastEntry): Person => ({ id: entry.user.userId, name: entry.user.name, color: entry.user.color });
/** Everyone else in the room: other people, and this user's other windows. */
export function peers(state: CollabState) { return state.presence.filter(p => p.connectionId !== state.connectionId); }
export function uniquePeople(entries: PresenceBroadcastEntry[]): Person[] {
  const seen = new Map<string, Person>();
  for (const entry of entries) if (!seen.has(entry.user.userId)) seen.set(entry.user.userId, person(entry));
  return [...seen.values()];
}
export function viewersByNode(state: CollabState): Record<string, Person[]> {
  const nodes: Record<string, PresenceBroadcastEntry[]> = {};
  for (const entry of peers(state)) if (entry.state.view) (nodes[entry.state.view.nodeId] ??= []).push(entry);
  return Object.fromEntries(Object.entries(nodes).map(([id, list]) => [id, uniquePeople(list)]));
}
export function ghostNodes(state: CollabState): GhostNode[] {
  return peers(state).flatMap(entry => entry.state.creating ? [{ id: entry.connectionId, ...entry.state.creating, person: person(entry) }] : []);
}
export function isMine(state: CollabState, holder: LockHolder | undefined) { return !!holder && holder.sessionKey === state.sessionKey; }
/** Names the holder; the same account in another window is called out so it is not mistaken for a bug. */
export function holderName(state: CollabState, holder: LockHolder) {
  if (isMine(state, holder)) return 'You';
  return holder.userId === state.user?.id ? 'You, in another window' : holder.name;
}
export function nodeLocks(state: CollabState): Record<string, NodeLock> {
  return Object.fromEntries(Object.entries(state.locks).filter(([key]) => key.startsWith('node:')).map(([key, holder]) => [key.slice(5), { name: holderName(state, holder), color: holder.color, mine: isMine(state, holder) }]));
}
export function nodeName(workspace: Workspace, objectType: ObjectType, id: string | null): string {
  if (!id) return objectLabels[objectType];
  const domain = workspace.domains[objectType];
  return domain.components.find(c => c.id === id)?.name ?? domain.requirementSets.find(s => s.requirementSetId === id)?.name ?? 'a removed node';
}
function setName(workspace: Workspace, id: string) {
  for (const domain of Object.values(workspace.domains)) { const set = domain.requirementSets.find(s => s.requirementSetId === id); if (set) return set.name; }
  return 'a requirement set';
}
/** One line per person describing what they are doing right now. */
export function activity(state: CollabState, entry: PresenceBroadcastEntry): string {
  const ws = state.workspace;
  const held = Object.entries(state.locks).filter(([, h]) => h.userId === entry.user.userId).map(([key]) => key);
  if (held.includes('config')) return 'is changing project settings';
  if (!ws) return 'is here';
  const { creating, drafting, focus, view } = entry.state;
  if (creating) return `is creating ${creating.kind === 'requirementSet' ? 'requirement set' : creating.parentId ? 'subcomponent' : 'component'} “${creating.name.trim() || '…'}” in ${nodeName(ws, creating.objectType, creating.parentId)}`;
  const scope = held.find(k => k.startsWith('rs-desc:'));
  if (scope) return `is writing the scope of ${setName(ws, scope.slice(8))}`;
  if (drafting) return `is writing a new item in ${setName(ws, drafting)}`;
  if (focus && view) {
    const column = ws.config.objectTypes[view.objectType].columns.find(c => c.id === focus.columnId)?.name ?? 'a field';
    return `is editing ${focus.itemId} · ${column}`;
  }
  const node = held.find(k => k.startsWith('node:'));
  if (node && view) return `is renaming ${nodeName(ws, view.objectType, node.slice(5))}`;
  if (view) return `is viewing ${nodeName(ws, view.objectType, view.nodeId)}`;
  return 'is looking around';
}
