import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type {
  ApiErrorCode,
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
} from '../shared/collab/types.js';

export const API_ERROR_HTTP_STATUS: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL_ERROR: 500,
};

export class CollabServiceError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(code: ApiErrorCode, message: string) {
    super(message);
    this.name = 'CollabServiceError';
    this.code = code;
    this.status = API_ERROR_HTTP_STATUS[code];
  }
}

export const SERVER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS server_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  server_id TEXT NOT NULL,
  server_name TEXT NOT NULL DEFAULT 'HLR Collaboration Server',
  registration_mode TEXT NOT NULL DEFAULT 'open',      -- 'open' | 'approval' | 'closed'
  room_creation_mode TEXT NOT NULL DEFAULT 'all_users', -- 'all_users' | 'admins_only'
  setup_token_hash TEXT,                                -- NULL once SERVER_OWNER is created
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                                  -- usr_<uuid>
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,                          -- scrypt$<saltHex>$<hashHex>
  server_role TEXT NOT NULL DEFAULT 'USER',             -- 'SERVER_OWNER' | 'SERVER_ADMIN' | 'USER'
  status TEXT NOT NULL DEFAULT 'ACTIVE',                -- 'ACTIVE' | 'PENDING_APPROVAL' | 'DISABLED'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,                          -- sha256(token)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,                                  -- room_<uuid>
  name TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',           -- 'private' | 'listed'
  owner_id TEXT NOT NULL REFERENCES users(id),
  project_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  last_autosaved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                                   -- 'ROOM_OWNER' | 'ROOM_ADMIN' | 'EDITOR' | 'VIEWER'
  joined_at TEXT NOT NULL,
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS room_bans (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  banned_by TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL DEFAULT '',
  banned_at TEXT NOT NULL,
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,                                  -- inv_<uuid>
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                                   -- 'direct' | 'code'
  target_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  code TEXT UNIQUE,                                     -- For kind = 'code'
  role TEXT NOT NULL,                                   -- 'ROOM_ADMIN' | 'EDITOR' | 'VIEWER'
  created_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'PENDING',               -- 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'REVOKED'
  uses INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER,
  expires_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS join_requests (
  id TEXT PRIMARY KEY,                                  -- jreq_<uuid>
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PENDING',               -- 'PENDING' | 'APPROVED' | 'REJECTED'
  assigned_role TEXT,
  reviewed_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY,                                  -- rev_<uuid>
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  message TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES users(id),
  author_name TEXT NOT NULL,
  snapshot_filename TEXT NOT NULL,
  restored_from_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (room_id, seq)
);

CREATE TABLE IF NOT EXISTS yjs_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  update_blob BLOB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,                                  -- aud_<uuid>
  room_id TEXT,                                         -- NULL for server-level events
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_room_members_user_id ON room_members(user_id);
CREATE INDEX IF NOT EXISTS idx_invites_room_id ON invites(room_id);
CREATE INDEX IF NOT EXISTS idx_invites_target_user_id ON invites(target_user_id);
CREATE INDEX IF NOT EXISTS idx_join_requests_room_id ON join_requests(room_id);
CREATE INDEX IF NOT EXISTS idx_join_requests_user_id ON join_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_revisions_room_id ON revisions(room_id);
CREATE INDEX IF NOT EXISTS idx_yjs_updates_room_id ON yjs_updates(room_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_room_id ON audit_log(room_id);
`;

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
  snapshot_filename: string;
  restored_from_id: string | null;
  created_at: string;
}

export interface YjsUpdateRow {
  id: number;
  room_id: string;
  update_blob: Buffer;
  created_at: string;
}

export interface AuditLogRow {
  id: string;
  room_id: string | null;
  actor_id: string | null;
  actor_name: string;
  action: string;
  target_id: string | null;
  details_json: string;
  created_at: string;
}

export interface ServerDatabaseOptions {
  serverName?: string;
  registrationMode?: RegistrationMode;
  roomCreationMode?: RoomCreationMode;
  now?: () => Date;
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
  try {
    const parsed: unknown = JSON.parse(row.details_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      details = parsed as Record<string, unknown>;
    }
  } catch {
    details = {};
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

export class ServerDatabase {
  readonly db: Database.Database;
  readonly filename: string;
  readonly dataDir: string;
  private readonly now: () => Date;

  constructor(dataDirOrDbPath: string, options: ServerDatabaseOptions = {}) {
    this.now = options.now ?? (() => new Date());

    if (dataDirOrDbPath === ':memory:') {
      this.filename = ':memory:';
      this.dataDir = ':memory:';
    } else if (dataDirOrDbPath.endsWith('.sqlite') || dataDirOrDbPath.endsWith('.db')) {
      const parentDir = path.dirname(path.resolve(dataDirOrDbPath));
      mkdirSync(parentDir, { recursive: true });
      if (lstatSync(parentDir).isSymbolicLink()) {
        throw new Error('Server database directory cannot be a symbolic link');
      }
      this.filename = path.resolve(dataDirOrDbPath);
      this.dataDir = parentDir;
      if (existsSync(this.filename) && lstatSync(this.filename).isSymbolicLink()) {
        throw new Error('Server database file cannot be a symbolic link');
      }
    } else {
      const resolvedDir = path.resolve(dataDirOrDbPath);
      mkdirSync(resolvedDir, { recursive: true });
      if (lstatSync(resolvedDir).isSymbolicLink()) {
        throw new Error('Server data directory cannot be a symbolic link');
      }
      this.dataDir = resolvedDir;
      this.filename = path.join(resolvedDir, 'server.sqlite');
      if (existsSync(this.filename) && lstatSync(this.filename).isSymbolicLink()) {
        throw new Error('Server database file cannot be a symbolic link');
      }
    }

    this.db = new Database(this.filename);
    if (this.filename !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
    }
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SERVER_SCHEMA_SQL);

    this.ensureSettingsRow(options);
  }

  static open(dataDirOrDbPath: string, options?: ServerDatabaseOptions): ServerDatabase {
    return new ServerDatabase(dataDirOrDbPath, options);
  }

  private ensureSettingsRow(options: ServerDatabaseOptions): ServerSettingsRow {
    const existing = this.db
      .prepare('SELECT * FROM server_settings WHERE id = 1')
      .get() as ServerSettingsRow | undefined;
    if (existing) {
      return existing;
    }

    const nowIso = this.now().toISOString();
    const serverId = `srv_${randomUUID()}`;
    const serverName = options.serverName?.trim() || 'HLR Collaboration Server';
    const registrationMode = options.registrationMode ?? 'open';
    const roomCreationMode = options.roomCreationMode ?? 'all_users';

    this.db
      .prepare(
        `INSERT INTO server_settings (
          id, server_id, server_name, registration_mode, room_creation_mode, setup_token_hash, created_at, updated_at
        ) VALUES (1, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(serverId, serverName, registrationMode, roomCreationMode, nowIso, nowIso);

    return this.getSettingsRow();
  }

  getSettingsRow(): ServerSettingsRow {
    const row = this.db
      .prepare('SELECT * FROM server_settings WHERE id = 1')
      .get() as ServerSettingsRow | undefined;
    if (!row) {
      return this.ensureSettingsRow({});
    }
    return row;
  }

  getSettings(): ServerSettings {
    return mapServerSettingsRow(this.getSettingsRow());
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  appendAuditLog(input: {
    roomId?: string | null;
    actorId?: string | null;
    actorName: string;
    action: string;
    targetId?: string | null;
    details?: Record<string, unknown>;
    createdAt?: string;
  }): AuditEntry {
    const id = `aud_${randomUUID()}`;
    const roomId = input.roomId ?? null;
    const actorId = input.actorId ?? null;
    const targetId = input.targetId ?? null;
    const details = input.details ?? {};
    const detailsJson = JSON.stringify(details);
    const createdAt = input.createdAt ?? this.now().toISOString();

    this.db
      .prepare(
        `INSERT INTO audit_log (id, room_id, actor_id, actor_name, action, target_id, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, roomId, actorId, input.actorName, input.action, targetId, detailsJson, createdAt);

    return {
      id,
      roomId,
      actorId,
      actorName: input.actorName,
      action: input.action,
      targetId,
      details,
      createdAt,
    };
  }

  listAuditLog(
    options: {
      roomId?: string | null;
      limit?: number;
    } = {},
  ): AuditEntry[] {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
    let rows: AuditLogRow[];
    if (options.roomId !== undefined && options.roomId !== null) {
      rows = this.db
        .prepare(
          'SELECT * FROM audit_log WHERE room_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
        )
        .all(options.roomId, limit) as AuditLogRow[];
    } else {
      rows = this.db
        .prepare('SELECT * FROM audit_log ORDER BY created_at DESC, rowid DESC LIMIT ?')
        .all(limit) as AuditLogRow[];
    }
    return rows.map(mapAuditLogRow);
  }

  isOpen(): boolean {
    return this.db.open;
  }

  close(): void {
    if (this.db.open) {
      this.db.close();
    }
  }
}
