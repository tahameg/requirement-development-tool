import type { RoomRole, LockHolder, PresenceBroadcastEntry } from './types.js';
import type { Item } from '../types/workspace.js';
export function capabilities(role: RoomRole | null, connected: boolean) { return { edit: connected && !!role && role !== 'VIEWER', admin: connected && (role === 'ROOM_ADMIN' || role === 'ROOM_OWNER'), owner: connected && role === 'ROOM_OWNER' }; }
export function lockStatus(holder: LockHolder | undefined, sessionKey: string | null | undefined) { return !holder ? 'free' : holder.sessionKey === sessionKey ? 'mine' : 'others'; }
export function changedValues(base: Item['values'], values: Item['values']) { return Object.fromEntries(Object.entries(values).filter(([key, value]) => base[key] !== value)); }
export function presenceByNode(presence: PresenceBroadcastEntry[]) { const nodes: Record<string, PresenceBroadcastEntry[]> = {}; for (const entry of presence) if (entry.state.view) (nodes[entry.state.view.nodeId] ??= []).push(entry); return nodes; }
