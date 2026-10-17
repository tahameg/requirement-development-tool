import type { CollabOp, DiscoveredServer, LockHolder, PresenceBroadcastEntry, RoomRole, ServerPublicInfo, UserProfile } from './types.js';
import type { Workspace, Item } from '../types/workspace.js';
import type { ObjectType } from '../types/config.js';
export interface RoomDraft { kind?: 'item' | 'description'; opId?: string; objectType: ObjectType; functionId: string; itemId: string | null; values: Item['values']; baseValues: Item['values']; conflict?: string; }
export interface CollabState {
  address: string | null; server: ServerPublicInfo | null; user: UserProfile | null;
  connection: 'offline' | 'connecting' | 'connected' | 'reconnecting';
  roomId: string | null; role: RoomRole | null; workspace: Workspace | null; seq: number;
  locks: Record<string, LockHolder>; presence: PresenceBroadcastEntry[];
  draft: RoomDraft | null; notice: string; autosave: string; discovered: DiscoveredServer[]; remembered: string[];
}
export type CollabCommand =
  | { action: 'state' | 'discover' | 'disconnect' | 'leave' | 'export' | 'import' | 'clear-draft' }
  | { action: 'create-from-local'; name: string; visibility: 'private' | 'listed' }
  | { action: 'probe'; address: string }
  | { action: 'connect'; address: string; fingerprint: string | null; allowHttp?: boolean }
  | { action: 'auth'; method: 'login' | 'register' | 'setup'; username: string; password: string; displayName?: string; setupToken?: string }
  | { action: 'request'; method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; route: string; body?: unknown }
  | { action: 'join'; roomId: string }
  | { action: 'op'; op: CollabOp }
  | { action: 'lock'; kind: 'acquire' | 'release' | 'force-release'; key: string }
  | { action: 'presence'; view: { objectType: ObjectType; nodeId: string } | null; focus: { itemId: string; columnId: string } | null; drafting: string | null }
  | { action: 'draft'; draft: RoomDraft };
