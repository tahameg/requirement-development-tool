import type { Workspace } from '../../shared/types/workspace.js';
import type {
  AuditEntry,
  InviteKind,
  InviteStatus,
  JoinRequestStatus,
  RegistrationMode,
  RoomCreationMode,
  RoomRole,
  RoomVisibility,
  ServerRole,
  ServerSettings,
  UserStatus,
} from '../../shared/collab/types.js';

export interface ServerSettingsRow {
  id: 1;
  server_id: string;
  server_name: string;
  registration_mode: RegistrationMode;
  room_creation_mode: RoomCreationMode;
  setup_token_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  server_role: ServerRole;
  status: UserStatus;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  token_hash: string;
  user_id: string;
  created_at: string;
  expires_at: string;
}

export interface RoomRow {
  id: string;
  name: string;
  visibility: RoomVisibility;
  owner_id: string;
  project_id: string;
  project_name: string;
  head_seq: number;
  snapshot_seq: number;
  last_autosaved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RoomMemberRow {
  room_id: string;
  user_id: string;
  role: RoomRole;
  joined_at: string;
}

export interface RoomBanRow {
  room_id: string;
  user_id: string;
  banned_by: string;
  reason: string;
  banned_at: string;
}

export interface InviteRow {
  id: string;
  room_id: string;
  kind: InviteKind;
  target_user_id: string | null;
  code: string | null;
  role: RoomRole;
  created_by: string;
  status: InviteStatus;
  uses: number;
  max_uses: number | null;
  expires_at: string | null;
  created_at: string;
}

export interface JoinRequestRow {
  id: string;
  room_id: string;
  user_id: string;
  message: string;
  status: JoinRequestStatus;
  assigned_role: RoomRole | null;
  reviewed_by: string | null;
  created_at: string;
  reviewed_at: string | null;
}

export interface RevisionRow {
  id: string;
  room_id: string;
  seq: number;
  message: string;
  author_id: string;
  author_name: string;
  workspace: Workspace;
  snapshot_filename: string;
  restored_from_id: string | null;
  created_at: string;
}

export interface RoomOpRow {
  room_id: string;
  seq: number;
  op_id: string;
  user_id: string;
  kind: string;
  payload: unknown;
  result: unknown;
  created_at: string;
}

export interface RoomSnapshotRow {
  room_id: string;
  seq: number;
  workspace: Workspace;
  created_at: string;
}

export interface AuditLogRow {
  id: string;
  room_id: string | null;
  actor_id: string | null;
  actor_name: string;
  action: string;
  target_id: string | null;
  details_json: Record<string, unknown> | string;
  created_at: string;
}

export function mapServerSettingsRow(row: ServerSettingsRow): ServerSettings {
  return {
    serverId: row.server_id,
    name: row.server_name,
    registrationMode: row.registration_mode,
    roomCreationMode: row.room_creation_mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapAuditLogRow(row: AuditLogRow): AuditEntry {
  let details: Record<string, unknown> = {};
  if (typeof row.details_json === 'object' && row.details_json !== null && !Array.isArray(row.details_json)) {
    details = row.details_json as Record<string, unknown>;
  } else if (typeof row.details_json === 'string') {
    try {
      const parsed: unknown = JSON.parse(row.details_json);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        details = parsed as Record<string, unknown>;
      }
    } catch {
      details = {};
    }
  }
  return {
    id: row.id,
    roomId: row.room_id,
    actorId: row.actor_id,
    actorName: row.actor_name,
    action: row.action,
    targetId: row.target_id,
    details,
    createdAt: row.created_at,
  };
}

export interface UserRepository {
  getById(id: string): Promise<UserRow | null>;
  getByUsername(username: string): Promise<UserRow | null>;
  create(data: {
    id: string;
    username: string;
    displayName: string;
    passwordHash: string;
    serverRole?: ServerRole;
    status?: UserStatus;
    createdAt?: string;
    updatedAt?: string;
  }): Promise<UserRow>;
  update(
    id: string,
    data: Partial<{
      displayName: string;
      passwordHash: string;
      serverRole: ServerRole;
      status: UserStatus;
      updatedAt: string;
    }>,
  ): Promise<UserRow>;
  list(options?: { status?: UserStatus; limit?: number; offset?: number }): Promise<UserRow[]>;
  search(query: string, limit?: number): Promise<UserRow[]>;
  count(): Promise<number>;
}

export interface SessionRepository {
  create(data: {
    tokenHash: string;
    userId: string;
    createdAt?: string;
    expiresAt: string;
  }): Promise<SessionRow>;
  getByTokenHash(tokenHash: string): Promise<SessionRow | null>;
  deleteByTokenHash(tokenHash: string): Promise<boolean>;
  deleteByUserId(userId: string): Promise<number>;
  deleteExpired(nowIso: string): Promise<number>;
}

export interface ServerSettingsRepository {
  get(): Promise<ServerSettingsRow | null>;
  ensure(options?: {
    serverName?: string;
    registrationMode?: RegistrationMode;
    roomCreationMode?: RoomCreationMode;
    nowIso?: string;
  }): Promise<ServerSettingsRow>;
  update(
    data: Partial<{
      serverName: string;
      registrationMode: RegistrationMode;
      roomCreationMode: RoomCreationMode;
      setupTokenHash: string | null;
      updatedAt: string;
    }>,
  ): Promise<ServerSettingsRow>;
}

export interface RoomRepository {
  lockForUpdate(id: string): Promise<RoomRow | null>;
  getById(id: string): Promise<RoomRow | null>;
  create(data: {
    id: string;
    name: string;
    visibility?: RoomVisibility;
    ownerId: string;
    projectId: string;
    projectName: string;
    headSeq?: number;
    snapshotSeq?: number;
    lastAutosavedAt?: string | null;
    createdAt?: string;
    updatedAt?: string;
  }): Promise<RoomRow>;
  update(
    id: string,
    data: Partial<{
      name: string;
      visibility: RoomVisibility;
      ownerId: string;
      projectId: string;
      projectName: string;
      headSeq: number;
      snapshotSeq: number;
      lastAutosavedAt: string | null;
      updatedAt: string;
    }>,
  ): Promise<RoomRow>;
  delete(id: string): Promise<boolean>;
  list(options?: { visibility?: RoomVisibility; limit?: number; offset?: number }): Promise<RoomRow[]>;
  listForUser(userId: string): Promise<RoomRow[]>;
  listAllAdmin(): Promise<RoomRow[]>;
}

export interface RoomMemberRepository {
  get(roomId: string, userId: string): Promise<RoomMemberRow | null>;
  listByRoom(roomId: string): Promise<RoomMemberRow[]>;
  listByUser(userId: string): Promise<RoomMemberRow[]>;
  add(data: {
    roomId: string;
    userId: string;
    role: RoomRole;
    joinedAt?: string;
  }): Promise<RoomMemberRow>;
  updateRole(roomId: string, userId: string, role: RoomRole): Promise<RoomMemberRow>;
  remove(roomId: string, userId: string): Promise<boolean>;
}

export interface InviteRepository {
  getById(id: string): Promise<InviteRow | null>;
  getByCode(code: string): Promise<InviteRow | null>;
  listByRoom(roomId: string): Promise<InviteRow[]>;
  listPendingForUser(userId: string): Promise<InviteRow[]>;
  create(data: {
    id: string;
    roomId: string;
    kind: InviteKind;
    targetUserId?: string | null;
    code?: string | null;
    role: RoomRole;
    createdBy: string;
    status?: InviteStatus;
    uses?: number;
    maxUses?: number | null;
    expiresAt?: string | null;
    createdAt?: string;
  }): Promise<InviteRow>;
  updateStatus(id: string, status: InviteStatus): Promise<InviteRow>;
  incrementUses(id: string): Promise<InviteRow>;
  delete(id: string): Promise<boolean>;
}

export interface JoinRequestRepository {
  getById(id: string): Promise<JoinRequestRow | null>;
  getPendingByRoomAndUser(roomId: string, userId: string): Promise<JoinRequestRow | null>;
  listByRoom(roomId: string): Promise<JoinRequestRow[]>;
  listByUser(userId: string): Promise<JoinRequestRow[]>;
  create(data: {
    id: string;
    roomId: string;
    userId: string;
    message?: string;
    status?: JoinRequestStatus;
    createdAt?: string;
  }): Promise<JoinRequestRow>;
  update(
    id: string,
    data: {
      status: JoinRequestStatus;
      assignedRole?: RoomRole | null;
      reviewedBy: string;
      reviewedAt?: string;
    },
  ): Promise<JoinRequestRow>;
}

export interface RoomBanRepository {
  get(roomId: string, userId: string): Promise<RoomBanRow | null>;
  listByRoom(roomId: string): Promise<RoomBanRow[]>;
  add(data: {
    roomId: string;
    userId: string;
    bannedBy: string;
    reason?: string;
    bannedAt?: string;
  }): Promise<RoomBanRow>;
  remove(roomId: string, userId: string): Promise<boolean>;
}

export interface AuditRepository {
  append(entry: {
    id?: string;
    roomId?: string | null;
    actorId?: string | null;
    actorName: string;
    action: string;
    targetId?: string | null;
    details?: Record<string, unknown>;
    createdAt?: string;
  }): Promise<AuditLogRow>;
  list(options?: { roomId?: string | null; limit?: number }): Promise<AuditLogRow[]>;
}

export interface RoomOpsRepository {
  append(op: {
    roomId: string;
    seq: number;
    opId: string;
    userId: string;
    kind: string;
    payload: unknown;
    result: unknown;
    createdAt?: string;
  }): Promise<RoomOpRow>;
  getBySeq(roomId: string, seq: number): Promise<RoomOpRow | null>;
  getByOpId(roomId: string, opId: string): Promise<RoomOpRow | null>;
  listSince(roomId: string, sinceSeq: number, limit?: number): Promise<RoomOpRow[]>;
  prune(roomId: string, upToSeq: number, olderThanIso: string): Promise<number>;
}

export interface RoomSnapshotRepository {
  create(data: {
    roomId: string;
    seq: number;
    workspace: Workspace;
    createdAt?: string;
  }): Promise<RoomSnapshotRow>;
  getLatest(roomId: string): Promise<RoomSnapshotRow | null>;
  getBySeq(roomId: string, seq: number): Promise<RoomSnapshotRow | null>;
  list(roomId: string, limit?: number): Promise<RoomSnapshotRow[]>;
  prune(roomId: string, keepCount: number): Promise<number>;
}

export interface RevisionRepository {
  create(data: {
    id: string;
    roomId: string;
    seq: number;
    message: string;
    authorId: string;
    authorName: string;
    workspace: Workspace;
    snapshotFilename?: string;
    restoredFromId?: string | null;
    createdAt?: string;
  }): Promise<RevisionRow>;
  getById(id: string): Promise<RevisionRow | null>;
  getBySeq(roomId: string, seq: number): Promise<RevisionRow | null>;
  listByRoom(roomId: string): Promise<RevisionRow[]>;
}

export interface ServerStore {
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly serverSettings: ServerSettingsRepository;
  readonly rooms: RoomRepository;
  readonly memberships: RoomMemberRepository;
  readonly invites: InviteRepository;
  readonly joinRequests: JoinRequestRepository;
  readonly bans: RoomBanRepository;
  readonly audit: AuditRepository;
  readonly ops: RoomOpsRepository;
  readonly snapshots: RoomSnapshotRepository;
  readonly revisions: RevisionRepository;

  transaction<T>(fn: (tx: ServerStore) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
