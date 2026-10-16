import type { ObjectType } from '../types/config.js';
import type { Item, Workspace } from '../types/workspace.js';

export const SERVER_ROLES = ['USER', 'SERVER_ADMIN', 'SERVER_OWNER'] as const;
export type ServerRole = (typeof SERVER_ROLES)[number];

export const ROOM_ROLES = ['VIEWER', 'EDITOR', 'ROOM_ADMIN', 'ROOM_OWNER'] as const;
export type RoomRole = (typeof ROOM_ROLES)[number];

export type AssignableRoomRole = 'VIEWER' | 'EDITOR' | 'ROOM_ADMIN';
export type BelowAdminRoomRole = 'VIEWER' | 'EDITOR';

export const REGISTRATION_MODES = ['open', 'approval', 'closed'] as const;
export type RegistrationMode = (typeof REGISTRATION_MODES)[number];

export const ROOM_CREATION_MODES = ['all_users', 'admins_only'] as const;
export type RoomCreationMode = (typeof ROOM_CREATION_MODES)[number];

export const USER_STATUSES = ['ACTIVE', 'PENDING_APPROVAL', 'DISABLED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const ROOM_VISIBILITIES = ['private', 'listed'] as const;
export type RoomVisibility = (typeof ROOM_VISIBILITIES)[number];

export const INVITE_KINDS = ['direct', 'code'] as const;
export type InviteKind = (typeof INVITE_KINDS)[number];

export const INVITE_STATUSES = ['PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED'] as const;
export type InviteStatus = (typeof INVITE_STATUSES)[number];

export const JOIN_REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type JoinRequestStatus = (typeof JOIN_REQUEST_STATUSES)[number];

export const API_ERROR_CODES = [
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'INTERNAL_ERROR',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const SERVER_ACTIONS = [
  'auth:setup',
  'auth:register',
  'auth:login',
  'auth:logout',
  'server:view-settings',
  'server:update-settings',
  'users:list',
  'users:directory',
  'users:create',
  'users:approve',
  'users:disable',
  'users:reset-password',
  'users:change-server-role',
  'rooms:create',
  'rooms:list-all-admin',
  'rooms:resolve-stuck',
  'rooms:force-delete',
  'audit:view-server',
] as const;
export type ServerAction = (typeof SERVER_ACTIONS)[number];

export const ROOM_ACTIONS = [
  'room:view-listed',
  'room:request-join',
  'room:accept-direct-invite',
  'room:redeem-invite-code',
  'room:connect-ws',
  'room:broadcast-view-presence',
  'room:broadcast-field-focus',
  'room:export',
  'room:leave',
  'item:create',
  'item:edit',
  'item:delete',
  'hierarchy:create-module',
  'hierarchy:edit-module',
  'hierarchy:create-function',
  'hierarchy:edit-function',
  'hierarchy:delete-module',
  'hierarchy:delete-function',
  'project:edit-settings',
  'revision:save',
  'revision:history-diff',
  'revision:restore',
  'member:invite-user',
  'member:create-invite-code',
  'member:revoke-invite',
  'member:review-join-request',
  'member:change-role-below-admin',
  'member:promote-demote-admin',
  'member:kick-ban',
  'room:edit-metadata',
  'room:view-audit',
  'room:transfer-ownership',
  'room:delete',
] as const;
export type RoomAction = (typeof ROOM_ACTIONS)[number];

export const COLLAB_USER_COLORS = [
  '#3b82f6', // Blue
  '#10b981', // Emerald
  '#f59e0b', // Amber
  '#ec4899', // Pink
  '#8b5cf6', // Violet
  '#06b6d4', // Cyan
  '#f97316', // Orange
  '#84cc16', // Lime
] as const;

export function assignUserColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return COLLAB_USER_COLORS[hash % COLLAB_USER_COLORS.length]!;
}

export interface ServerSettings {
  serverId: string;
  name: string;
  registrationMode: RegistrationMode;
  roomCreationMode: RoomCreationMode;
  createdAt: string;
  updatedAt: string;
}

export interface ServerPublicInfo {
  serverId: string;
  name: string;
  version: string;
  tls: boolean;
  fingerprint: string | null;
  setupRequired: boolean;
  registrationMode: RegistrationMode;
  roomCreationMode: RoomCreationMode;
}

export interface UserProfile {
  id: string;
  username: string;
  displayName: string;
  serverRole: ServerRole;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
}

export type UserAdminRecord = UserProfile;

export interface UserDirectoryEntry {
  id: string;
  username: string;
  displayName: string;
}

export interface RoomSummary {
  id: string;
  name: string;
  visibility: RoomVisibility;
  ownerId: string;
  ownerDisplayName?: string;
  projectId: string;
  projectName: string;
  myRole: RoomRole | null;
  memberCount: number;
  onlineCount?: number;
  lastAutosavedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListedRoomSummary {
  id: string;
  name: string;
  visibility: 'listed';
  ownerId: string;
  ownerDisplayName: string;
  projectId: string;
  projectName: string;
  memberCount: number;
  hasPendingJoinRequest: boolean;
  createdAt: string;
  updatedAt: string;
}

export type RoomDetail = RoomSummary;

export interface RoomMemberInfo {
  roomId: string;
  userId: string;
  username: string;
  displayName: string;
  role: RoomRole;
  joinedAt: string;
  online?: boolean;
  color?: string;
}

export interface RoomBanInfo {
  roomId: string;
  userId: string;
  username: string;
  displayName: string;
  bannedBy: string;
  reason: string;
  bannedAt: string;
}

export interface DirectInviteSummary {
  id: string;
  roomId: string;
  roomName: string;
  kind: 'direct';
  targetUserId: string;
  targetUsername: string;
  targetDisplayName: string;
  role: AssignableRoomRole;
  createdBy: string;
  createdByDisplayName: string;
  status: InviteStatus;
  createdAt: string;
}

export interface InviteCodeInfo {
  id: string;
  roomId: string;
  kind: 'code';
  code: string;
  role: BelowAdminRoomRole;
  createdBy: string;
  status: InviteStatus;
  uses: number;
  maxUses: number | null;
  expiresAt: string | null;
  createdAt: string;
}

export type InviteInfo = DirectInviteSummary | InviteCodeInfo;

export interface JoinRequestSummary {
  id: string;
  roomId: string;
  roomName: string;
  userId: string;
  username: string;
  displayName: string;
  message: string;
  status: JoinRequestStatus;
  assignedRole: RoomRole | null;
  reviewedBy: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

export interface RevisionMetadata {
  id: string;
  roomId: string;
  seq: number;
  message: string;
  authorId: string;
  authorName: string;
  snapshotFilename: string;
  restoredFromId: string | null;
  createdAt: string;
}

export interface RevisionDiffEntityChange {
  id: string;
  objectType: ObjectType;
  name: string;
}

export interface RevisionDiffItemChange {
  id: string;
  objectType: ObjectType;
  functionId: string;
  changedColumns?: string[];
}

export interface RevisionDiff {
  fromRevisionId: string;
  toTarget: string;
  configChanged: boolean;
  modules: {
    added: RevisionDiffEntityChange[];
    modified: RevisionDiffEntityChange[];
    deleted: RevisionDiffEntityChange[];
  };
  functions: {
    added: RevisionDiffEntityChange[];
    modified: RevisionDiffEntityChange[];
    deleted: RevisionDiffEntityChange[];
  };
  items: {
    added: RevisionDiffItemChange[];
    modified: RevisionDiffItemChange[];
    deleted: RevisionDiffItemChange[];
  };
}

export interface AuditEntry {
  id: string;
  roomId: string | null;
  actorId: string | null;
  actorName: string;
  action: string;
  targetId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface AwarenessViewState {
  objectType: ObjectType;
  kind: 'root' | 'module' | 'function';
  id: string | null;
}

export interface AwarenessCursorState {
  anchor: number;
  head: number;
}

export interface AwarenessFocusState {
  objectType: ObjectType;
  functionId: string;
  itemId: string;
  columnId: string;
  cursor?: AwarenessCursorState | null;
}

export interface AwarenessUserState {
  userId: string;
  username: string;
  displayName: string;
  role: RoomRole;
  color: string;
  view: AwarenessViewState | null;
  focus: AwarenessFocusState | null;
  updatedAt: number;
}

export interface OnlineMemberInfo {
  userId: string;
  username: string;
  displayName: string;
  role: RoomRole;
  color: string;
}

export type RoomNotificationKind =
  | 'user-joined'
  | 'user-left'
  | 'role-changed'
  | 'join-request-created'
  | 'join-request-reviewed'
  | 'member-kicked'
  | 'member-banned'
  | 'ownership-transferred';

export type WsClientMessage =
  | {
      type: 'sync-step1';
      stateVector: string;
    }
  | {
      type: 'sync-update';
      update: string;
      clientOpId?: string;
    }
  | {
      type: 'awareness-update';
      state: AwarenessUserState | null;
    }
  | {
      type: 'alloc-item';
      requestId: string;
      tempId: string;
      objectType: ObjectType;
      functionId: string;
      values: Record<string, string | number | boolean | null>;
    }
  | {
      type: 'ping';
      timestamp: number;
    };

export type WsServerMessage =
  | {
      type: 'room-welcome';
      roomId: string;
      role: RoomRole;
      stateUpdate: string;
      awarenessStates: AwarenessUserState[];
      onlineMembers: OnlineMemberInfo[];
      autosaveStatus: { status: 'autosaved' | 'saving'; lastAutosavedAt: string | null };
      lastRevision: RevisionMetadata | null;
    }
  | {
      type: 'sync-step2';
      update: string;
    }
  | {
      type: 'sync-update';
      update: string;
      actorUserId: string;
      clientOpId?: string;
    }
  | {
      type: 'alloc-item-ack';
      requestId: string;
      tempId: string;
      objectType: ObjectType;
      functionId: string;
      item: Item;
    }
  | {
      type: 'awareness-broadcast';
      states: AwarenessUserState[];
      onlineMembers: OnlineMemberInfo[];
    }
  | {
      type: 'autosave-status';
      status: 'saving' | 'autosaved';
      lastAutosavedAt: string;
    }
  | {
      type: 'revision-saved';
      revision: RevisionMetadata;
      restoredFromId?: string;
    }
  | {
      type: 'room-notification';
      kind: RoomNotificationKind;
      message: string;
      targetUserId?: string;
      newRole?: RoomRole;
      joinRequest?: JoinRequestSummary;
      timestamp: string;
    }
  | {
      type: 'conflict';
      code: 'TARGET_DELETED' | 'CONCURRENT_STRUCTURE_CHANGE';
      targetId: string;
      message: string;
      correctiveUpdate: string;
    }
  | {
      type: 'error';
      code: 'FORBIDDEN' | 'PERMISSION_REVOKED' | 'VALIDATION_ERROR' | 'BAD_REQUEST';
      message: string;
      requestId?: string;
      correctiveUpdate?: string;
    }
  | {
      type: 'kicked' | 'banned' | 'room-deleted';
      reason: string;
    }
  | {
      type: 'pong';
      timestamp: number;
    };

export const DISCOVERY_BEACON_MAGIC = 'HLR_SERVER_BEACON_V1' as const;
export const DEFAULT_DISCOVERY_PORT = 41234;
export const DEFAULT_SERVER_PORT = 8443;
export const DISCOVERY_INTERVAL_MS = 3000;
export const DISCOVERY_STALE_MS = 10000;

export interface DiscoveryBeacon {
  magic: typeof DISCOVERY_BEACON_MAGIC;
  serverId: string;
  name: string;
  version: string;
  host: string;
  port: number;
  tls: boolean;
  fingerprint: string | null;
  timestamp: number;
}

export interface DiscoveredServer {
  serverId: string;
  name: string;
  version: string;
  host: string;
  port: number;
  tls: boolean;
  fingerprint: string | null;
  lastSeenAt: number;
  online: boolean;
}

export type CollabConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'offline';

export interface RememberedServer {
  url: string;
  serverId?: string;
  name: string;
  pinnedFingerprint: string | null;
  lastConnectedAt: string;
}

export type RoomExportResult = {
  format: 'json' | 'csv' | 'markdown';
  content: string | Workspace;
};
