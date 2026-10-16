import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { Workspace } from '../../shared/types/workspace.js';
import type {
  InviteKind,
  InviteStatus,
  JoinRequestStatus,
  RegistrationMode,
  RoomCreationMode,
  RoomRole,
  RoomVisibility,
  ServerRole,
  UserStatus,
} from '../../shared/collab/types.js';
import { CollabServiceError } from '../errors.js';
import type {
  AuditLogRow,
  AuditRepository,
  InviteRepository,
  InviteRow,
  JoinRequestRepository,
  JoinRequestRow,
  RevisionRepository,
  RevisionRow,
  RoomBanRepository,
  RoomBanRow,
  RoomMemberRepository,
  RoomMemberRow,
  RoomOpRow,
  RoomOpsRepository,
  RoomRepository,
  RoomRow,
  RoomSnapshotRepository,
  RoomSnapshotRow,
  ServerSettingsRepository,
  ServerSettingsRow,
  ServerStore,
  SessionRepository,
  SessionRow,
  UserRepository,
  UserRow,
} from './types.js';

export interface Queryable {
  query<R extends pg.QueryResultRow = any, I extends any[] = any[]>(
    queryTextOrConfig: string | pg.QueryConfig<I>,
    values?: I,
  ): Promise<pg.QueryResult<R>>;
}

function toIso(val: unknown): string {
  if (val instanceof Date) {
    return val.toISOString();
  }
  if (typeof val === 'string') {
    return val;
  }
  return '';
}

function toIsoOrNull(val: unknown): string | null {
  if (!val) {
    return null;
  }
  if (val instanceof Date) {
    return val.toISOString();
  }
  if (typeof val === 'string') {
    return val;
  }
  return null;
}

function parseJson<T>(val: unknown): T {
  if (val && typeof val === 'object') {
    return val as T;
  }
  if (typeof val === 'string') {
    try {
      return JSON.parse(val) as T;
    } catch {
      return {} as T;
    }
  }
  return {} as T;
}

class PgUserRepository implements UserRepository {
  constructor(private readonly q: Queryable) {}

  private map(row: any): UserRow {
    return {
      id: row.id,
      username: row.username,
      display_name: row.display_name,
      password_hash: row.password_hash,
      server_role: row.server_role,
      status: row.status,
      created_at: toIso(row.created_at),
      updated_at: toIso(row.updated_at),
    };
  }

  async getById(id: string): Promise<UserRow | null> {
    const res = await this.q.query('SELECT * FROM users WHERE id = $1', [id]);
    return res.rows[0] ? this.map(res.rows[0]) : null;
  }

  async getByUsername(username: string): Promise<UserRow | null> {
    const res = await this.q.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
    return res.rows[0] ? this.map(res.rows[0]) : null;
  }

  async create(data: {
    id: string;
    username: string;
    displayName: string;
    passwordHash: string;
    serverRole?: ServerRole;
    status?: UserStatus;
    createdAt?: string;
    updatedAt?: string;
  }): Promise<UserRow> {
    const nowIso = new Date().toISOString();
    const res = await this.q.query(
      `INSERT INTO users (id, username, display_name, password_hash, server_role, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        data.id,
        data.username,
        data.displayName,
        data.passwordHash,
        data.serverRole ?? 'USER',
        data.status ?? 'ACTIVE',
        data.createdAt ?? nowIso,
        data.updatedAt ?? nowIso,
      ],
    );
    return this.map(res.rows[0]);
  }

  async update(
    id: string,
    data: Partial<{
      displayName: string;
      passwordHash: string;
      serverRole: ServerRole;
      status: UserStatus;
      updatedAt: string;
    }>,
  ): Promise<UserRow> {
    const sets: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (data.displayName !== undefined) {
      sets.push(`display_name = $${idx++}`);
      values.push(data.displayName);
    }
    if (data.passwordHash !== undefined) {
      sets.push(`password_hash = $${idx++}`);
      values.push(data.passwordHash);
    }
    if (data.serverRole !== undefined) {
      sets.push(`server_role = $${idx++}`);
      values.push(data.serverRole);
    }
    if (data.status !== undefined) {
      sets.push(`status = $${idx++}`);
      values.push(data.status);
    }
    if (data.updatedAt !== undefined) {
      sets.push(`updated_at = $${idx++}`);
      values.push(data.updatedAt);
    } else {
      sets.push(`updated_at = $${idx++}`);
      values.push(new Date().toISOString());
    }

    if (sets.length === 0) {
      const existing = await this.getById(id);
      if (!existing) throw new CollabServiceError('NOT_FOUND', `User not found: ${id}`);
      return existing;
    }

    values.push(id);
    const res = await this.q.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      values,
    );
    if (!res.rows[0]) throw new CollabServiceError('NOT_FOUND', `User not found: ${id}`);
    return this.map(res.rows[0]);
  }

  async list(options: { status?: UserStatus; limit?: number; offset?: number } = {}): Promise<UserRow[]> {
    const values: any[] = [];
    let whereClause = '';
    let idx = 1;

    if (options.status) {
      whereClause = `WHERE status = $${idx++}`;
      values.push(options.status);
    }

    const limit = Math.max(1, Math.min(options.limit ?? 200, 1000));
    const offset = Math.max(0, options.offset ?? 0);
    values.push(limit, offset);

    const res = await this.q.query(
      `SELECT * FROM users ${whereClause} ORDER BY created_at ASC LIMIT $${idx++} OFFSET $${idx++}`,
      values,
    );
    return res.rows.map(r => this.map(r));
  }

  async search(query: string, limit = 50): Promise<UserRow[]> {
    const trimmed = query.trim();
    if (!trimmed) {
      return this.list({ limit });
    }
    const pattern = `%${trimmed.toLowerCase()}%`;
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const res = await this.q.query(
      `SELECT * FROM users
       WHERE LOWER(username) LIKE $1 OR LOWER(display_name) LIKE $1
       ORDER BY username ASC
       LIMIT $2`,
      [pattern, safeLimit],
    );
    return res.rows.map(r => this.map(r));
  }

  async count(): Promise<number> {
    const res = await this.q.query<{ count: string }>('SELECT COUNT(*)::text as count FROM users');
    return parseInt(res.rows[0]?.count ?? '0', 10);
  }
}

class PgSessionRepository implements SessionRepository {
  constructor(private readonly q: Queryable) {}

  private map(row: any): SessionRow {
    return {
      token_hash: row.token_hash,
      user_id: row.user_id,
      created_at: toIso(row.created_at),
      expires_at: toIso(row.expires_at),
    };
  }

  async create(data: {
    tokenHash: string;
    userId: string;
    createdAt?: string;
    expiresAt: string;
  }): Promise<SessionRow> {
    const nowIso = new Date().toISOString();
    const res = await this.q.query(
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [data.tokenHash, data.userId, data.createdAt ?? nowIso, data.expiresAt],
    );
    return this.map(res.rows[0]);
  }

  async getByTokenHash(tokenHash: string): Promise<SessionRow | null> {
    const res = await this.q.query('SELECT * FROM sessions WHERE token_hash = $1', [tokenHash]);
    return res.rows[0] ? this.map(res.rows[0]) : null;
  }

  async deleteByTokenHash(tokenHash: string): Promise<boolean> {
    const res = await this.q.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
    return (res.rowCount ?? 0) > 0;
  }

  async deleteByUserId(userId: string): Promise<number> {
    const res = await this.q.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    return res.rowCount ?? 0;
  }

  async deleteExpired(nowIso: string): Promise<number> {
    const res = await this.q.query('DELETE FROM sessions WHERE expires_at <= $1', [nowIso]);
    return res.rowCount ?? 0;
  }
}

class PgServerSettingsRepository implements ServerSettingsRepository {
  constructor(private readonly q: Queryable) {}

  private map(row: any): ServerSettingsRow {
    return {
      id: 1,
      server_id: row.server_id,
      server_name: row.server_name,
      registration_mode: row.registration_mode,
      room_creation_mode: row.room_creation_mode,
      setup_token_hash: row.setup_token_hash ?? null,
      created_at: toIso(row.created_at),
      updated_at: toIso(row.updated_at),
    };
  }

  async get(): Promise<ServerSettingsRow | null> {
    const res = await this.q.query('SELECT * FROM server_settings WHERE id = 1');
    return res.rows[0] ? this.map(res.rows[0]) : null;
  }

  async ensure(options: {
    serverName?: string;
    registrationMode?: RegistrationMode;
    roomCreationMode?: RoomCreationMode;
    nowIso?: string;
  } = {}): Promise<ServerSettingsRow> {
    const existing = await this.get();
    if (existing) {
      return existing;
    }

    const nowIso = options.nowIso ?? new Date().toISOString();
    const serverId = `srv_${randomUUID()}`;
    const serverName = options.serverName?.trim() || 'HLR Collaboration Server';
    const regMode = options.registrationMode ?? 'open';
    const roomMode = options.roomCreationMode ?? 'all_users';

    await this.q.query(
      `INSERT INTO server_settings (
        id, server_id, server_name, registration_mode, room_creation_mode, setup_token_hash, created_at, updated_at
      ) VALUES (1, $1, $2, $3, $4, NULL, $5, $6)
      ON CONFLICT (id) DO NOTHING`,
      [serverId, serverName, regMode, roomMode, nowIso, nowIso],
    );

    const row = await this.get();
    if (!row) throw new CollabServiceError('INTERNAL_ERROR', 'Failed to initialize server settings');
    return row;
  }

  async update(
    data: Partial<{
      serverName: string;
      registrationMode: RegistrationMode;
      roomCreationMode: RoomCreationMode;
      setupTokenHash: string | null;
      updatedAt: string;
    }>,
  ): Promise<ServerSettingsRow> {
    const sets: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (data.serverName !== undefined) {
      sets.push(`server_name = $${idx++}`);
      values.push(data.serverName);
    }
    if (data.registrationMode !== undefined) {
      sets.push(`registration_mode = $${idx++}`);
      values.push(data.registrationMode);
    }
    if (data.roomCreationMode !== undefined) {
      sets.push(`room_creation_mode = $${idx++}`);
      values.push(data.roomCreationMode);
    }
    if (data.setupTokenHash !== undefined) {
      sets.push(`setup_token_hash = $${idx++}`);
      values.push(data.setupTokenHash);
    }
    if (data.updatedAt !== undefined) {
      sets.push(`updated_at = $${idx++}`);
      values.push(data.updatedAt);
    } else {
      sets.push(`updated_at = $${idx++}`);
      values.push(new Date().toISOString());
    }

    if (sets.length === 0) {
      const existing = await this.get();
      if (!existing) throw new CollabServiceError('NOT_FOUND', 'Server settings not found');
      return existing;
    }

    const res = await this.q.query(
      `UPDATE server_settings SET ${sets.join(', ')} WHERE id = 1 RETURNING *`,
      values,
    );
    if (!res.rows[0]) throw new CollabServiceError('NOT_FOUND', 'Server settings not found');
    return this.map(res.rows[0]);
  }
}

class PgRoomRepository implements RoomRepository {
  constructor(private readonly q: Queryable) {}

  private map(row: any): RoomRow {
    return {
      id: row.id,
      name: row.name,
      visibility: row.visibility,
      owner_id: row.owner_id,
      project_id: row.project_id,
      project_name: row.project_name,
      head_seq: Number(row.head_seq ?? 0),
      snapshot_seq: Number(row.snapshot_seq ?? 0),
      last_autosaved_at: toIsoOrNull(row.last_autosaved_at),
      created_at: toIso(row.created_at),
      updated_at: toIso(row.updated_at),
    };
  }

  async getById(id: string): Promise<RoomRow | null> {
    const res = await this.q.query('SELECT * FROM rooms WHERE id = $1', [id]);
    return res.rows[0] ? this.map(res.rows[0]) : null;
  }

  async create(data: {
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
  }): Promise<RoomRow> {
    const nowIso = new Date().toISOString();
    const res = await this.q.query(
      `INSERT INTO rooms (
        id, name, visibility, owner_id, project_id, project_name, head_seq, snapshot_seq, last_autosaved_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *`,
      [
        data.id,
        data.name,
        data.visibility ?? 'private',
        data.ownerId,
        data.projectId,
        data.projectName,
        data.headSeq ?? 0,
        data.snapshotSeq ?? 0,
        data.lastAutosavedAt ?? null,
        data.createdAt ?? nowIso,
        data.updatedAt ?? nowIso,
      ],
    );
    return this.map(res.rows[0]);
  }

  async update(
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
  ): Promise<RoomRow> {
    const sets: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (data.name !== undefined) {
      sets.push(`name = $${idx++}`);
      values.push(data.name);
    }
    if (data.visibility !== undefined) {
      sets.push(`visibility = $${idx++}`);
      values.push(data.visibility);
    }
    if (data.ownerId !== undefined) {
      sets.push(`owner_id = $${idx++}`);
      values.push(data.ownerId);
    }
    if (data.projectId !== undefined) {
      sets.push(`project_id = $${idx++}`);
      values.push(data.projectId);
    }
    if (data.projectName !== undefined) {
      sets.push(`project_name = $${idx++}`);
      values.push(data.projectName);
    }
    if (data.headSeq !== undefined) {
      sets.push(`head_seq = $${idx++}`);
      values.push(data.headSeq);
    }
    if (data.snapshotSeq !== undefined) {
      sets.push(`snapshot_seq = $${idx++}`);
      values.push(data.snapshotSeq);
    }
    if (data.lastAutosavedAt !== undefined) {
      sets.push(`last_autosaved_at = $${idx++}`);
      values.push(data.lastAutosavedAt);
    }
    if (data.updatedAt !== undefined) {
      sets.push(`updated_at = $${idx++}`);
      values.push(data.updatedAt);
    } else {
      sets.push(`updated_at = $${idx++}`);
      values.push(new Date().toISOString());
    }

    if (sets.length === 0) {
      const existing = await this.getById(id);
      if (!existing) throw new CollabServiceError('NOT_FOUND', `Room not found: ${id}`);
      return existing;
    }

    values.push(id);
    const res = await this.q.query(
      `UPDATE rooms SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      values,
    );
    if (!res.rows[0]) throw new CollabServiceError('NOT_FOUND', `Room not found: ${id}`);
    return this.map(res.rows[0]);
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.q.query('DELETE FROM rooms WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async list(options: { visibility?: RoomVisibility; limit?: number; offset?: number } = {}): Promise<RoomRow[]> {
    const values: any[] = [];
    let whereClause = '';
    let idx = 1;

    if (options.visibility) {
      whereClause = `WHERE visibility = $${idx++}`;
      values.push(options.visibility);
    }

    const limit = Math.max(1, Math.min(options.limit ?? 200, 1000));
    const offset = Math.max(0, options.offset ?? 0);
    values.push(limit, offset);

    const res = await this.q.query(
      `SELECT * FROM rooms ${whereClause} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      values,
    );
    return res.rows.map(r => this.map(r));
  }

  async listForUser(userId: string): Promise<RoomRow[]> {
    const res = await this.q.query(
      `SELECT r.* FROM rooms r
       INNER JOIN room_members m ON r.id = m.room_id
       WHERE m.user_id = $1
       ORDER BY r.updated_at DESC, r.created_at DESC`,
      [userId],
    );
    return res.rows.map(r => this.map(r));
  }

  async listAllAdmin(): Promise<RoomRow[]> {
    const res = await this.q.query('SELECT * FROM rooms ORDER BY created_at DESC');
    return res.rows.map(r => this.map(r));
  }
}

class PgRoomMemberRepository implements RoomMemberRepository {
  constructor(private readonly q: Queryable) {}

  private map(row: any): RoomMemberRow {
    return {
      room_id: row.room_id,
      user_id: row.user_id,
      role: row.role,
      joined_at: toIso(row.joined_at),
    };
  }

  async get(roomId: string, userId: string): Promise<RoomMemberRow | null> {
    const res = await this.q.query(
      'SELECT * FROM room_members WHERE room_id = $1 AND user_id = $2',
      [roomId, userId],
    );
    return res.rows[0] ? this.map(res.rows[0]) : null;
  }

  async listByRoom(roomId: string): Promise<RoomMemberRow[]> {
    const res = await this.q.query(
      'SELECT * FROM room_members WHERE room_id = $1 ORDER BY joined_at ASC',
      [roomId],
    );
    return res.rows.map(r => this.map(r));
  }

  async listByUser(userId: string): Promise<RoomMemberRow[]> {
    const res = await this.q.query(
      'SELECT * FROM room_members WHERE user_id = $1 ORDER BY joined_at DESC',
      [userId],
    );
    return res.rows.map(r => this.map(r));
  }

  async add(data: {
    roomId: string;
    userId: string;
    role: RoomRole;
    joinedAt?: string;
  }): Promise<RoomMemberRow> {
    const joinedAt = data.joinedAt ?? new Date().toISOString();
    const res = await this.q.query(
      `INSERT INTO room_members (room_id, user_id, role, joined_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (room_id, user_id) DO UPDATE SET role = EXCLUDED.role, joined_at = EXCLUDED.joined_at
       RETURNING *`,
      [data.roomId, data.userId, data.role, joinedAt],
    );
    return this.map(res.rows[0]);
  }

  async updateRole(roomId: string, userId: string, role: RoomRole): Promise<RoomMemberRow> {
    const res = await this.q.query(
      `UPDATE room_members SET role = $3 WHERE room_id = $1 AND user_id = $2 RETURNING *`,
      [roomId, userId, role],
    );
    if (!res.rows[0]) throw new CollabServiceError('NOT_FOUND', `Room member not found: ${userId} in ${roomId}`);
    return this.map(res.rows[0]);
  }

  async remove(roomId: string, userId: string): Promise<boolean> {
    const res = await this.q.query(
      'DELETE FROM room_members WHERE room_id = $1 AND user_id = $2',
      [roomId, userId],
    );
    return (res.rowCount ?? 0) > 0;
  }
}

class PgInviteRepository implements InviteRepository {
  constructor(private readonly q: Queryable) {}

  private map(row: any): InviteRow {
    return {
      id: row.id,
      room_id: row.room_id,
      kind: row.kind,
      target_user_id: row.target_user_id ?? null,
      code: row.code ?? null,
      role: row.role,
      created_by: row.created_by,
      status: row.status,
      uses: Number(row.uses ?? 0),
      max_uses: row.max_uses !== null ? Number(row.max_uses) : null,
      expires_at: toIsoOrNull(row.expires_at),
      created_at: toIso(row.created_at),
    };
  }

  async getById(id: string): Promise<InviteRow | null> {
    const res = await this.q.query('SELECT * FROM invites WHERE id = $1', [id]);
    return res.rows[0] ? this.map(res.rows[0]) : null;
  }

  async getByCode(code: string): Promise<InviteRow | null> {
    const res = await this.q.query('SELECT * FROM invites WHERE code = $1', [code]);
    return res.rows[0] ? this.map(res.rows[0]) : null;
  }

  async listByRoom(roomId: string): Promise<InviteRow[]> {
    const res = await this.q.query(
      'SELECT * FROM invites WHERE room_id = $1 ORDER BY created_at DESC',
      [roomId],
    );
    return res.rows.map(r => this.map(r));
  }

  async listPendingForUser(userId: string): Promise<InviteRow[]> {
    const res = await this.q.query(
      `SELECT * FROM invites
       WHERE target_user_id = $1 AND status = 'PENDING'
       ORDER BY created_at DESC`,
      [userId],
    );
    return res.rows.map(r => this.map(r));
  }

  async create(data: {
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
  }): Promise<InviteRow> {
    const createdAt = data.createdAt ?? new Date().toISOString();
    const res = await this.q.query(
      `INSERT INTO invites (
        id, room_id, kind, target_user_id, code, role, created_by, status, uses, max_uses, expires_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *`,
      [
        data.id,
        data.roomId,
        data.kind,
        data.targetUserId ?? null,
        data.code ?? null,
        data.role,
        data.createdBy,
        data.status ?? 'PENDING',
        data.uses ?? 0,
        data.maxUses ?? null,
        data.expiresAt ?? null,
        createdAt,
      ],
    );
    return this.map(res.rows[0]);
  }

  async updateStatus(id: string, status: InviteStatus): Promise<InviteRow> {
    const res = await this.q.query(
      'UPDATE invites SET status = $2 WHERE id = $1 RETURNING *',
      [id, status],
    );
    if (!res.rows[0]) throw new CollabServiceError('NOT_FOUND', `Invite not found: ${id}`);
    return this.map(res.rows[0]);
  }

  async incrementUses(id: string): Promise<InviteRow> {
    const res = await this.q.query(
      'UPDATE invites SET uses = uses + 1 WHERE id = $1 RETURNING *',
      [id],
    );
    if (!res.rows[0]) throw new CollabServiceError('NOT_FOUND', `Invite not found: ${id}`);
    return this.map(res.rows[0]);
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.q.query('DELETE FROM invites WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
  }
}

class PgJoinRequestRepository implements JoinRequestRepository {
  constructor(private readonly q: Queryable) {}

  private map(row: any): JoinRequestRow {
    return {
      id: row.id,
      room_id: row.room_id,
      user_id: row.user_id,
      message: row.message ?? '',
      status: row.status,
      assigned_role: row.assigned_role ?? null,
      reviewed_by: row.reviewed_by ?? null,
      created_at: toIso(row.created_at),
      reviewed_at: toIsoOrNull(row.reviewed_at),
    };
  }

  async getById(id: string): Promise<JoinRequestRow | null> {
    const res = await this.q.query('SELECT * FROM join_requests WHERE id = $1', [id]);
    return res.rows[0] ? this.map(res.rows[0]) : null;
  }

  async getPendingByRoomAndUser(roomId: string, userId: string): Promise<JoinRequestRow | null> {
    const res = await this.q.query(
      `SELECT * FROM join_requests
       WHERE room_id = $1 AND user_id = $2 AND status = 'PENDING'
       LIMIT 1`,
      [roomId, userId],
    );
    return res.rows[0] ? this.map(res.rows[0]) : null;
  }

  async listByRoom(roomId: string): Promise<JoinRequestRow[]> {
    const res = await this.q.query(
      'SELECT * FROM join_requests WHERE room_id = $1 ORDER BY created_at DESC',
      [roomId],
    );
    return res.rows.map(r => this.map(r));
  }

  async listByUser(userId: string): Promise<JoinRequestRow[]> {
    const res = await this.q.query(
      'SELECT * FROM join_requests WHERE user_id = $1 ORDER BY created_at DESC',
      [userId],
    );
    return res.rows.map(r => this.map(r));
  }

  async create(data: {
    id: string;
    roomId: string;
    userId: string;
    message?: string;
    status?: JoinRequestStatus;
    createdAt?: string;
  }): Promise<JoinRequestRow> {
    const createdAt = data.createdAt ?? new Date().toISOString();
    const res = await this.q.query(
      `INSERT INTO join_requests (id, room_id, user_id, message, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [data.id, data.roomId, data.userId, data.message ?? '', data.status ?? 'PENDING', createdAt],
    );
    return this.map(res.rows[0]);
  }

  async update(
    id: string,
    data: {
      status: JoinRequestStatus;
      assignedRole?: RoomRole | null;
      reviewedBy: string;
      reviewedAt?: string;
    },
  ): Promise<JoinRequestRow> {
    const reviewedAt = data.reviewedAt ?? new Date().toISOString();
    const res = await this.q.query(
      `UPDATE join_requests
       SET status = $2, assigned_role = $3, reviewed_by = $4, reviewed_at = $5
       WHERE id = $1
       RETURNING *`,
      [id, data.status, data.assignedRole ?? null, data.reviewedBy, reviewedAt],
    );
    if (!res.rows[0]) throw new CollabServiceError('NOT_FOUND', `Join request not found: ${id}`);
    return this.map(res.rows[0]);
  }
}

class PgRoomBanRepository implements RoomBanRepository {
  constructor(private readonly q: Queryable) {}

  private map(row: any): RoomBanRow {
    return {
      room_id: row.room_id,
      user_id: row.user_id,
      banned_by: row.banned_by,
      reason: row.reason ?? '',
      banned_at: toIso(row.banned_at),
    };
  }

  async get(roomId: string, userId: string): Promise<RoomBanRow | null> {
    const res = await this.q.query(
      'SELECT * FROM room_bans WHERE room_id = $1 AND user_id = $2',
      [roomId, userId],
    );
    return res.rows[0] ? this.map(res.rows[0]) : null;
  }

  async listByRoom(roomId: string): Promise<RoomBanRow[]> {
    const res = await this.q.query(
      'SELECT * FROM room_bans WHERE room_id = $1 ORDER BY banned_at DESC',
      [roomId],
    );
    return res.rows.map(r => this.map(r));
  }

  async add(data: {
    roomId: string;
    userId: string;
    bannedBy: string;
    reason?: string;
    bannedAt?: string;
  }): Promise<RoomBanRow> {
    const bannedAt = data.bannedAt ?? new Date().toISOString();
    const res = await this.q.query(
      `INSERT INTO room_bans (room_id, user_id, banned_by, reason, banned_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (room_id, user_id) DO UPDATE SET banned_by = EXCLUDED.banned_by, reason = EXCLUDED.reason, banned_at = EXCLUDED.banned_at
       RETURNING *`,
      [data.roomId, data.userId, data.bannedBy, data.reason ?? '', bannedAt],
    );
    return this.map(res.rows[0]);
  }

  async remove(roomId: string, userId: string): Promise<boolean> {
    const res = await this.q.query(
      'DELETE FROM room_bans WHERE room_id = $1 AND user_id = $2',
      [roomId, userId],
    );
    return (res.rowCount ?? 0) > 0;
  }
}

class PgAuditRepository implements AuditRepository {
  constructor(private readonly q: Queryable) {}

  private map(row: any): AuditLogRow {
    return {
      id: row.id,
      room_id: row.room_id ?? null,
      actor_id: row.actor_id ?? null,
      actor_name: row.actor_name,
      action: row.action,
      target_id: row.target_id ?? null,
      details_json: parseJson(row.details_json),
      created_at: toIso(row.created_at),
    };
  }

  async append(entry: {
    id?: string;
    roomId?: string | null;
    actorId?: string | null;
    actorName: string;
    action: string;
    targetId?: string | null;
    details?: Record<string, unknown>;
    createdAt?: string;
  }): Promise<AuditLogRow> {
    const id = entry.id ?? `aud_${randomUUID()}`;
    const createdAt = entry.createdAt ?? new Date().toISOString();
    const details = entry.details ?? {};
    const res = await this.q.query(
      `INSERT INTO audit_log (id, room_id, actor_id, actor_name, action, target_id, details_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        id,
        entry.roomId ?? null,
        entry.actorId ?? null,
        entry.actorName,
        entry.action,
        entry.targetId ?? null,
        JSON.stringify(details),
        createdAt,
      ],
    );
    return this.map(res.rows[0]);
  }

  async list(options: { roomId?: string | null; limit?: number } = {}): Promise<AuditLogRow[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
    if (options.roomId !== undefined && options.roomId !== null) {
      const res = await this.q.query(
        'SELECT * FROM audit_log WHERE room_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
        [options.roomId, limit],
      );
      return res.rows.map(r => this.map(r));
    }
    const res = await this.q.query(
      'SELECT * FROM audit_log ORDER BY created_at DESC, id DESC LIMIT $1',
      [limit],
    );
    return res.rows.map(r => this.map(r));
  }
}

class PgRoomOpsRepository implements RoomOpsRepository {
  constructor(private readonly q: Queryable) {}

  private map(row: any): RoomOpRow {
    return {
      room_id: row.room_id,
      seq: Number(row.seq),
      op_id: row.op_id,
      user_id: row.user_id,
      kind: row.kind,
      payload: parseJson(row.payload_json),
      result: parseJson(row.result_json),
      created_at: toIso(row.created_at),
    };
  }

  async append(op: {
    roomId: string;
    seq: number;
    opId: string;
    userId: string;
    kind: string;
    payload: unknown;
    result: unknown;
    createdAt?: string;
  }): Promise<RoomOpRow> {
    const createdAt = op.createdAt ?? new Date().toISOString();
    const res = await this.q.query(
      `INSERT INTO room_ops (room_id, seq, op_id, user_id, kind, payload_json, result_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        op.roomId,
        op.seq,
        op.opId,
        op.userId,
        op.kind,
        JSON.stringify(op.payload ?? {}),
        JSON.stringify(op.result ?? {}),
        createdAt,
      ],
    );
    return this.map(res.rows[0]);
  }

  async getBySeq(roomId: string, seq: number): Promise<RoomOpRow | null> {
    const res = await this.q.query(
      'SELECT * FROM room_ops WHERE room_id = $1 AND seq = $2',
      [roomId, seq],
    );
    return res.rows[0] ? this.map(res.rows[0]) : null;
  }

  async getByOpId(roomId: string, opId: string): Promise<RoomOpRow | null> {
    const res = await this.q.query(
      'SELECT * FROM room_ops WHERE room_id = $1 AND op_id = $2',
      [roomId, opId],
    );
    return res.rows[0] ? this.map(res.rows[0]) : null;
  }

  async listSince(roomId: string, sinceSeq: number, limit = 500): Promise<RoomOpRow[]> {
    const safeLimit = Math.max(1, Math.min(limit, 2000));
    const res = await this.q.query(
      `SELECT * FROM room_ops
       WHERE room_id = $1 AND seq > $2
       ORDER BY seq ASC
       LIMIT $3`,
      [roomId, sinceSeq, safeLimit],
    );
    return res.rows.map(r => this.map(r));
  }

  async prune(roomId: string, upToSeq: number, olderThanIso: string): Promise<number> {
    const res = await this.q.query(
      `DELETE FROM room_ops
       WHERE room_id = $1 AND seq <= $2 AND created_at < $3`,
      [roomId, upToSeq, olderThanIso],
    );
    return res.rowCount ?? 0;
  }
}

class PgRoomSnapshotRepository implements RoomSnapshotRepository {
  constructor(private readonly q: Queryable) {}

  private map(row: any): RoomSnapshotRow {
    return {
      room_id: row.room_id,
      seq: Number(row.seq),
      workspace: parseJson<Workspace>(row.workspace),
      created_at: toIso(row.created_at),
    };
  }

  async create(data: {
    roomId: string;
    seq: number;
    workspace: Workspace;
    createdAt?: string;
  }): Promise<RoomSnapshotRow> {
    const createdAt = data.createdAt ?? new Date().toISOString();
    const res = await this.q.query(
      `INSERT INTO room_snapshots (room_id, seq, workspace, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (room_id, seq) DO UPDATE SET workspace = EXCLUDED.workspace, created_at = EXCLUDED.created_at
       RETURNING *`,
      [data.roomId, data.seq, JSON.stringify(data.workspace), createdAt],
    );
    return this.map(res.rows[0]);
  }

  async getLatest(roomId: string): Promise<RoomSnapshotRow | null> {
    const res = await this.q.query(
      'SELECT * FROM room_snapshots WHERE room_id = $1 ORDER BY seq DESC LIMIT 1',
      [roomId],
    );
    return res.rows[0] ? this.map(res.rows[0]) : null;
  }

  async getBySeq(roomId: string, seq: number): Promise<RoomSnapshotRow | null> {
    const res = await this.q.query(
      'SELECT * FROM room_snapshots WHERE room_id = $1 AND seq = $2',
      [roomId, seq],
    );
    return res.rows[0] ? this.map(res.rows[0]) : null;
  }

  async list(roomId: string, limit = 10): Promise<RoomSnapshotRow[]> {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const res = await this.q.query(
      'SELECT * FROM room_snapshots WHERE room_id = $1 ORDER BY seq DESC LIMIT $2',
      [roomId, safeLimit],
    );
    return res.rows.map(r => this.map(r));
  }

  async prune(roomId: string, keepCount: number): Promise<number> {
    const safeKeep = Math.max(1, keepCount);
    const res = await this.q.query(
      `DELETE FROM room_snapshots
       WHERE room_id = $1
         AND seq NOT IN (
           SELECT seq FROM room_snapshots
           WHERE room_id = $1
           ORDER BY seq DESC
           LIMIT $2
         )`,
      [roomId, safeKeep],
    );
    return res.rowCount ?? 0;
  }
}

class PgRevisionRepository implements RevisionRepository {
  constructor(private readonly q: Queryable) {}

  private map(row: any): RevisionRow {
    return {
      id: row.id,
      room_id: row.room_id,
      seq: Number(row.seq),
      message: row.message,
      author_id: row.author_id,
      author_name: row.author_name,
      workspace: parseJson<Workspace>(row.workspace),
      snapshot_filename: row.snapshot_filename ?? '',
      restored_from_id: row.restored_from_id ?? null,
      created_at: toIso(row.created_at),
    };
  }

  async create(data: {
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
  }): Promise<RevisionRow> {
    const createdAt = data.createdAt ?? new Date().toISOString();
    const res = await this.q.query(
      `INSERT INTO revisions (
        id, room_id, seq, message, author_id, author_name, workspace, snapshot_filename, restored_from_id, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        data.id,
        data.roomId,
        data.seq,
        data.message,
        data.authorId,
        data.authorName,
        JSON.stringify(data.workspace),
        data.snapshotFilename ?? '',
        data.restoredFromId ?? null,
        createdAt,
      ],
    );
    return this.map(res.rows[0]);
  }

  async getById(id: string): Promise<RevisionRow | null> {
    const res = await this.q.query('SELECT * FROM revisions WHERE id = $1', [id]);
    return res.rows[0] ? this.map(res.rows[0]) : null;
  }

  async getBySeq(roomId: string, seq: number): Promise<RevisionRow | null> {
    const res = await this.q.query(
      'SELECT * FROM revisions WHERE room_id = $1 AND seq = $2',
      [roomId, seq],
    );
    return res.rows[0] ? this.map(res.rows[0]) : null;
  }

  async listByRoom(roomId: string): Promise<RevisionRow[]> {
    const res = await this.q.query(
      'SELECT * FROM revisions WHERE room_id = $1 ORDER BY seq DESC',
      [roomId],
    );
    return res.rows.map(r => this.map(r));
  }
}

export interface PgServerStoreOptions {
  pool?: pg.Pool;
  databaseUrl?: string;
  maxConnections?: number;
  schema?: string;
}

export class PgServerStore implements ServerStore {
  readonly pool: pg.Pool;
  private readonly client: pg.PoolClient | null;
  private readonly ownsPool: boolean;

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

  constructor(target: pg.Pool | pg.PoolClient, options: { ownsPool?: boolean } = {}) {
    if ('release' in target && typeof target.release === 'function') {
      this.client = target as pg.PoolClient;
      this.pool = (target as any).pool ?? (null as any);
      this.ownsPool = false;
    } else {
      this.client = null;
      this.pool = target as pg.Pool;
      this.ownsPool = options.ownsPool ?? true;
    }

    const q: Queryable = this.client ?? this.pool;

    this.users = new PgUserRepository(q);
    this.sessions = new PgSessionRepository(q);
    this.serverSettings = new PgServerSettingsRepository(q);
    this.rooms = new PgRoomRepository(q);
    this.memberships = new PgRoomMemberRepository(q);
    this.invites = new PgInviteRepository(q);
    this.joinRequests = new PgJoinRequestRepository(q);
    this.bans = new PgRoomBanRepository(q);
    this.audit = new PgAuditRepository(q);
    this.ops = new PgRoomOpsRepository(q);
    this.snapshots = new PgRoomSnapshotRepository(q);
    this.revisions = new PgRevisionRepository(q);
  }

  static create(options: PgServerStoreOptions): PgServerStore {
    if (options.pool) {
      return new PgServerStore(options.pool, { ownsPool: false });
    }
    const connectionString = options.databaseUrl ?? process.env.HLR_DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'Database connection URL is required. Provide --database-url or set HLR_DATABASE_URL environment variable.',
      );
    }
    const pool = new pg.Pool({
      connectionString,
      max: options.maxConnections ?? 10,
    });
    return new PgServerStore(pool, { ownsPool: true });
  }

  async transaction<T>(fn: (tx: ServerStore) => Promise<T>): Promise<T> {
    if (this.client) {
      // Nested transaction via savepoint
      const sp = `sp_${randomUUID().replace(/-/g, '_')}`;
      await this.client.query(`SAVEPOINT ${sp}`);
      try {
        const result = await fn(this);
        await this.client.query(`RELEASE SAVEPOINT ${sp}`);
        return result;
      } catch (err) {
        await this.client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        throw err;
      }
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const txStore = new PgServerStore(client);
      const result = await fn(txStore);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback errors if already aborted
      }
      throw err;
    } finally {
      client.release();
    }
  }

  private closed = false;

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsPool && this.pool && !(this.pool as any).ended) {
      try {
        await this.pool.end();
      } catch {
        // ignore if already ended
      }
    }
  }
}
