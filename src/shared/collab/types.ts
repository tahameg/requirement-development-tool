import type { HierarchyCommand } from '../hierarchy.js';
import type { ObjectType, ProjectConfig } from '../types/config.js';
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
  'hierarchy:create-component',
  'hierarchy:edit-component',
  'hierarchy:create-requirement-set',
  'hierarchy:edit-requirement-set',
  'hierarchy:delete-component',
  'hierarchy:delete-requirement-set',
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

/** Bumped on breaking wire changes. 2: component / requirement-set terminology. */
export const COLLAB_PROTOCOL_VERSION = 2;

export interface ServerPublicInfo {
  serverId: string;
  protocolVersion?: number;
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
  requirementSetId: string;
  changedColumns?: string[];
}

export interface RevisionDiff {
  fromRevisionId: string;
  toTarget: string;
  configChanged: boolean;
  components: {
    added: RevisionDiffEntityChange[];
    modified: RevisionDiffEntityChange[];
    deleted: RevisionDiffEntityChange[];
  };
  requirementSets: {
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

// --- Architecture v2: Server-Ordered Operations & Locks ---

export const COLLAB_OP_KINDS = [
  'hierarchy',
  'item.add',
  'item.edit',
  'item.delete',
  'requirementSet.description',
  'config.update',
  'room.restore',
] as const;
export type CollabOpKind = (typeof COLLAB_OP_KINDS)[number];

export type HierarchyOpPayload = HierarchyCommand;

export interface ItemAddOpPayload {
  objectType: ObjectType;
  requirementSetId: string;
  values: Record<string, string | number | boolean | null>;
}

export interface ItemEditOpPayload {
  objectType: ObjectType;
  requirementSetId: string;
  itemId: string;
  values: Record<string, string | number | boolean | null>;
}

export interface ItemDeleteOpPayload {
  objectType: ObjectType;
  requirementSetId: string;
  itemId: string;
}

export interface RequirementSetDescriptionOpPayload {
  objectType: ObjectType;
  requirementSetId: string;
  description: string;
}

export type ConfigUpdateOpPayload = ProjectConfig;

export interface RoomRestoreOpPayload {
  revisionId: string;
}

export type CollabOp =
  | { opId: string; kind: 'hierarchy'; payload: HierarchyOpPayload }
  | { opId: string; kind: 'item.add'; payload: ItemAddOpPayload }
  | { opId: string; kind: 'item.edit'; payload: ItemEditOpPayload }
  | { opId: string; kind: 'item.delete'; payload: ItemDeleteOpPayload }
  | { opId: string; kind: 'requirementSet.description'; payload: RequirementSetDescriptionOpPayload }
  | { opId: string; kind: 'config.update'; payload: ConfigUpdateOpPayload }
  | { opId: string; kind: 'room.restore'; payload: RoomRestoreOpPayload };

export const OP_REJECT_CODES = [
  'FORBIDDEN',
  'LOCKED',
  'NOT_FOUND',
  'VALIDATION',
  'CONFLICT',
  'READ_ONLY',
] as const;
export type OpRejectCode = (typeof OP_REJECT_CODES)[number];

export interface LockHolder {
  userId: string;
  /** Opaque per-session id; the same account in two windows holds locks separately. */
  sessionKey: string;
  name: string;
  color: string;
}

export interface LockInfo {
  holder: LockHolder;
  expiresAt: number; // epoch ms
}

export type LockState = Record<string, LockHolder>;

export interface PresenceViewState {
  objectType: ObjectType;
  nodeId: string;
}

export interface PresenceFocusState {
  itemId: string;
  columnId: string;
}

/** A node someone is naming in the create dialog; peers render it as a ghost in the tree. */
export interface PresenceCreatingState {
  objectType: ObjectType;
  kind: 'component' | 'requirementSet';
  parentId: string | null;
  name: string;
}

export interface PresenceState {
  view: PresenceViewState | null;
  focus: PresenceFocusState | null;
  drafting: string | null; // requirementSetId | null
  creating?: PresenceCreatingState | null;
}

export interface PresenceBroadcastEntry {
  connectionId: string;
  user: {
    userId: string;
    name: string;
    color: string;
  };
  state: PresenceState;
}

// Deprecated alias for backwards compatibility during migration
export type AwarenessUserState = {
  userId: string;
  username: string;
  displayName: string;
  role: RoomRole;
  color: string;
  view: { objectType: ObjectType; kind: 'root' | 'component' | 'requirementSet'; id: string | null } | null;
  focus: { objectType: ObjectType; requirementSetId: string; itemId: string; columnId: string; cursor?: { anchor: number; head: number } | null } | null;
  updatedAt: number;
};

// --- WebSocket Protocol Messages (v2) ---

export type WsClientMessage =
  | {
      type: 'op';
      op: CollabOp;
    }
  | {
      type: 'ops-since';
      seq: number;
    }
  | {
      type: 'lock-acquire';
      key: string;
    }
  | {
      type: 'lock-release';
      key: string;
    }
  | {
      type: 'lock-heartbeat';
      key: string;
    }
  | {
      type: 'lock-force-release';
      key: string;
    }
  | {
      type: 'presence-update';
      view: PresenceViewState | null;
      focus: PresenceFocusState | null;
      drafting: string | null;
      creating?: PresenceCreatingState | null;
    }
  | {
      type: 'ping';
      timestamp: number;
    };

export type WsServerMessage =
  | { type: 'presence-left'; connectionId: string }
  | { type: 'lock-revoked'; key: string; reason: string }
  | {
      type: 'room-welcome';
      roomId: string;
      role: RoomRole;
      connectionId: string;
      sessionKey: string;
      seq: number;
      workspace: Workspace;
      locks: Record<string, LockHolder>;
      presence: PresenceBroadcastEntry[];
      members: RoomMemberInfo[];
      autosaveStatus?: { status: 'autosaved' | 'saving'; lastAutosavedAt: string | null };
      lastRevision?: RevisionMetadata | null;
    }
  | {
      type: 'op-ack';
      opId: string;
      seq: number;
      result?: unknown;
    }
  | {
      type: 'op-rejected';
      opId: string;
      code: OpRejectCode;
      message: string;
    }
  | {
      type: 'op-applied';
      seq: number;
      op: CollabOp;
      result?: unknown;
    }
  | {
      type: 'ops-since-reply';
      sinceSeq: number;
      ops: Array<{ seq: number; op: CollabOp; result?: unknown }>;
    }
  | {
      type: 'snapshot';
      seq: number;
      workspace: Workspace;
    }
  | {
      type: 'lock-granted';
      key: string;
      expiresAt: number;
    }
  | {
      type: 'lock-denied';
      key: string;
      holder: LockHolder;
    }
  | {
      type: 'locks-changed';
      key: string;
      holder: LockHolder | null;
    }
  | {
      type: 'presence';
      connectionId: string;
      user: {
        userId: string;
        name: string;
        color: string;
      };
      state: PresenceState;
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
      type: 'kicked';
      reason: string;
    }
  | {
      type: 'banned';
      reason: string;
    }
  | {
      type: 'room-deleted';
      reason: string;
    }
  | {
      type: 'pong';
      timestamp: number;
    }
  | {
      type: 'error';
      code: string;
      message: string;
      requestId?: string;
    };

// --- UDP Discovery Types ---

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
