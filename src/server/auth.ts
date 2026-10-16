import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { canServerAction } from '../shared/collab/permissions.js';
import {
  adminCreateUserRequestSchema,
  adminResetPasswordRequestSchema,
  adminUpdateUserRequestSchema,
  loginRequestSchema,
  registerRequestSchema,
  setupRequestSchema,
  updateServerSettingsRequestSchema,
} from '../shared/collab/protocol.js';
import type {
  AuditEntry,
  RegistrationMode,
  RoomCreationMode,
  ServerPublicInfo,
  ServerRole,
  ServerSettings,
  UserAdminRecord,
  UserDirectoryEntry,
  UserProfile,
} from '../shared/collab/types.js';
import {
  CollabServiceError,
  type ServerDatabase,
  type SessionRow,
  type UserRow,
  mapServerSettingsRow,
} from './db.js';

export { CollabServiceError } from './db.js';

const SCRYPT_KEYLEN = 64;
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }
  const [, saltHex, hashHex] = parts;
  if (!saltHex || !hashHex || saltHex.length % 2 !== 0 || hashHex.length % 2 !== 0) {
    return false;
  }
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    if (salt.length === 0 || expected.length === 0) {
      return false;
    }
    const derived = scryptSync(password, salt, expected.length);
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function verifyTokenHash(token: string, expectedHashHex: string): boolean {
  try {
    const actualBuf = Buffer.from(hashToken(token), 'hex');
    const expectedBuf = Buffer.from(expectedHashHex, 'hex');
    if (actualBuf.length === 0 || actualBuf.length !== expectedBuf.length) {
      return false;
    }
    return timingSafeEqual(actualBuf, expectedBuf);
  } catch {
    return false;
  }
}

export function generateRandomToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('hex');
}

export function mapUserRow(row: UserRow): UserProfile {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    serverRole: row.server_role,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface AuthServiceOptions {
  sessionTtlMs?: number;
  initialSetupToken?: string;
  now?: () => Date;
}

export interface AuthSessionResult {
  user: UserProfile;
  token: string;
  expiresAt: string;
}

export type RegisterResult =
  | {
      status: 'ACTIVE';
      user: UserProfile;
      token: string;
      expiresAt: string;
    }
  | {
      status: 'PENDING_APPROVAL';
      user: UserProfile;
    };

export class AuthService {
  private readonly sessionTtlMs: number;
  private readonly now: () => Date;
  private initialSetupToken: string | null = null;

  constructor(
    private readonly serverDb: ServerDatabase,
    options: AuthServiceOptions = {},
  ) {
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.now = options.now ?? (() => new Date());
    this.initializeSetupState(options.initialSetupToken);
  }

  private initializeSetupState(explicitSetupToken?: string): void {
    const userCount = this.getUserCount();
    if (userCount === 0) {
      const token = explicitSetupToken?.trim() || generateRandomToken(24);
      const tokenHash = hashToken(token);
      const nowIso = this.now().toISOString();
      this.serverDb.db
        .prepare('UPDATE server_settings SET setup_token_hash = ?, updated_at = ? WHERE id = 1')
        .run(tokenHash, nowIso);
      this.initialSetupToken = token;
    } else {
      this.initialSetupToken = null;
      const settingsRow = this.serverDb.getSettingsRow();
      if (settingsRow.setup_token_hash !== null) {
        this.serverDb.db
          .prepare('UPDATE server_settings SET setup_token_hash = NULL WHERE id = 1')
          .run();
      }
    }
  }

  private getUserCount(): number {
    const row = this.serverDb.db
      .prepare('SELECT COUNT(*) AS count FROM users')
      .get() as { count: number };
    return row.count;
  }

  getInitialSetupToken(): string | null {
    return this.isSetupRequired() ? this.initialSetupToken : null;
  }

  isSetupRequired(): boolean {
    if (this.getUserCount() > 0) {
      return false;
    }
    const settings = this.serverDb.getSettingsRow();
    return settings.setup_token_hash !== null;
  }

  getServerSettings(): ServerSettings {
    return this.serverDb.getSettings();
  }

  getPublicInfo(
    meta: {
      version?: string;
      tls?: boolean;
      fingerprint?: string | null;
    } = {},
  ): ServerPublicInfo {
    const settings = this.getServerSettings();
    return {
      serverId: settings.serverId,
      name: settings.name,
      version: meta.version ?? '0.6.0',
      tls: meta.tls ?? true,
      fingerprint: meta.fingerprint ?? null,
      setupRequired: this.isSetupRequired(),
      registrationMode: settings.registrationMode,
      roomCreationMode: settings.roomCreationMode,
    };
  }

  updateServerSettings(
    actor: UserProfile,
    input: {
      name?: string;
      registrationMode?: RegistrationMode;
      roomCreationMode?: RoomCreationMode;
    },
  ): ServerSettings {
    if (!canServerAction(actor.serverRole, 'server:update-settings')) {
      throw new CollabServiceError('FORBIDDEN', 'Only the Server Owner can update server settings.');
    }

    const parsed = updateServerSettingsRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid server settings payload.',
      );
    }

    const current = this.serverDb.getSettingsRow();
    const nextName = parsed.data.name ?? current.server_name;
    const nextRegMode = parsed.data.registrationMode ?? current.registration_mode;
    const nextRoomMode = parsed.data.roomCreationMode ?? current.room_creation_mode;
    const nowIso = this.now().toISOString();

    this.serverDb.transaction(() => {
      this.serverDb.db
        .prepare(
          `UPDATE server_settings
           SET server_name = ?, registration_mode = ?, room_creation_mode = ?, updated_at = ?
           WHERE id = 1`,
        )
        .run(nextName, nextRegMode, nextRoomMode, nowIso);

      this.serverDb.appendAuditLog({
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'server:update-settings',
        targetId: current.server_id,
        details: {
          name: nextName,
          registrationMode: nextRegMode,
          roomCreationMode: nextRoomMode,
        },
        createdAt: nowIso,
      });
    });

    return mapServerSettingsRow(this.serverDb.getSettingsRow());
  }

  claimSetupToken(input: {
    setupToken: string;
    username: string;
    displayName: string;
    password: string;
  }): AuthSessionResult {
    const parsed = setupRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid setup request payload.',
      );
    }

    const setupRequired = this.isSetupRequired();
    const settingsRow = this.serverDb.getSettingsRow();
    const hasValidSetupToken =
      setupRequired &&
      settingsRow.setup_token_hash !== null &&
      verifyTokenHash(parsed.data.setupToken, settingsRow.setup_token_hash);

    if (
      !canServerAction(null, 'auth:setup', {
        setupRequired,
        hasValidSetupToken,
      })
    ) {
      throw new CollabServiceError('FORBIDDEN', 'Setup token is invalid or has already been used.');
    }

    return this.serverDb.transaction(() => {
      const nowIso = this.now().toISOString();
      const userId = `usr_${randomUUID()}`;
      const passwordHash = hashPassword(parsed.data.password);

      this.serverDb.db
        .prepare(
          `INSERT INTO users (id, username, display_name, password_hash, server_role, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'SERVER_OWNER', 'ACTIVE', ?, ?)`,
        )
        .run(userId, parsed.data.username, parsed.data.displayName, passwordHash, nowIso, nowIso);

      this.serverDb.db
        .prepare('UPDATE server_settings SET setup_token_hash = NULL, updated_at = ? WHERE id = 1')
        .run(nowIso);

      this.initialSetupToken = null;

      const user = this.requireUserById(userId);
      this.serverDb.appendAuditLog({
        actorId: user.id,
        actorName: user.displayName,
        action: 'auth:setup',
        targetId: user.id,
        details: { username: user.username, serverRole: 'SERVER_OWNER' },
        createdAt: nowIso,
      });

      const session = this.createSession(user.id);
      return {
        user,
        token: session.token,
        expiresAt: session.expiresAt,
      };
    });
  }

  registerUser(input: {
    username: string;
    displayName: string;
    password: string;
  }): RegisterResult {
    const parsed = registerRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid registration payload.',
      );
    }

    const settings = this.getServerSettings();
    if (!canServerAction(null, 'auth:register', { registrationMode: settings.registrationMode })) {
      throw new CollabServiceError('FORBIDDEN', 'Self-registration is closed on this server.');
    }

    return this.serverDb.transaction(() => {
      const existing = this.findUserRowByUsername(parsed.data.username);
      if (existing) {
        throw new CollabServiceError(
          'CONFLICT',
          `Username '${parsed.data.username}' is already taken.`,
        );
      }

      const nowIso = this.now().toISOString();
      const userId = `usr_${randomUUID()}`;
      const passwordHash = hashPassword(parsed.data.password);
      const status = settings.registrationMode === 'approval' ? 'PENDING_APPROVAL' : 'ACTIVE';

      this.serverDb.db
        .prepare(
          `INSERT INTO users (id, username, display_name, password_hash, server_role, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'USER', ?, ?, ?)`,
        )
        .run(userId, parsed.data.username, parsed.data.displayName, passwordHash, status, nowIso, nowIso);

      const user = this.requireUserById(userId);
      this.serverDb.appendAuditLog({
        actorId: user.id,
        actorName: user.displayName,
        action: 'auth:register',
        targetId: user.id,
        details: { username: user.username, status },
        createdAt: nowIso,
      });

      if (status === 'PENDING_APPROVAL') {
        return {
          status: 'PENDING_APPROVAL',
          user,
        };
      }

      const session = this.createSession(user.id);
      return {
        status: 'ACTIVE',
        user,
        token: session.token,
        expiresAt: session.expiresAt,
      };
    });
  }

  loginUser(input: { username: string; password: string }): AuthSessionResult {
    const parsed = loginRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid login payload.',
      );
    }

    const userRow = this.findUserRowByUsername(parsed.data.username);
    if (!userRow || !verifyPassword(parsed.data.password, userRow.password_hash)) {
      throw new CollabServiceError('UNAUTHORIZED', 'Invalid username or password.');
    }

    if (userRow.status === 'PENDING_APPROVAL') {
      throw new CollabServiceError(
        'FORBIDDEN',
        'Your account is pending approval by a server administrator.',
      );
    }

    if (userRow.status === 'DISABLED') {
      throw new CollabServiceError('FORBIDDEN', 'Your account has been disabled.');
    }

    const user = mapUserRow(userRow);
    const session = this.createSession(user.id);
    return {
      user,
      token: session.token,
      expiresAt: session.expiresAt,
    };
  }

  logoutSession(token: string): { loggedOut: true } {
    const user = this.authenticateToken(token);
    if (!canServerAction(user.serverRole, 'auth:logout')) {
      throw new CollabServiceError('FORBIDDEN', 'Not permitted to log out.');
    }
    const tokenHash = hashToken(token);
    this.serverDb.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return { loggedOut: true };
  }

  authenticateToken(token: string | null | undefined): UserProfile {
    if (!token || typeof token !== 'string' || !token.trim()) {
      throw new CollabServiceError('UNAUTHORIZED', 'Authentication token is required.');
    }

    const tokenHash = hashToken(token.trim());
    const sessionRow = this.serverDb.db
      .prepare('SELECT * FROM sessions WHERE token_hash = ?')
      .get(tokenHash) as SessionRow | undefined;

    if (!sessionRow) {
      throw new CollabServiceError('UNAUTHORIZED', 'Invalid or revoked session token.');
    }

    const nowMs = this.now().getTime();
    const expiresMs = new Date(sessionRow.expires_at).getTime();
    if (Number.isNaN(expiresMs) || expiresMs <= nowMs) {
      this.serverDb.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
      throw new CollabServiceError('UNAUTHORIZED', 'Session token has expired.');
    }

    const userRow = this.findUserRowById(sessionRow.user_id);
    if (!userRow || userRow.status !== 'ACTIVE') {
      this.revokeUserSessions(sessionRow.user_id);
      throw new CollabServiceError('UNAUTHORIZED', 'User account is not active.');
    }

    return mapUserRow(userRow);
  }

  authenticateAuthorizationHeader(authHeader: string | undefined): UserProfile {
    if (!authHeader) {
      throw new CollabServiceError('UNAUTHORIZED', 'Missing Authorization header.');
    }
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (!match?.[1]) {
      throw new CollabServiceError('UNAUTHORIZED', 'Expected Authorization: Bearer <token>.');
    }
    return this.authenticateToken(match[1]);
  }

  getUserById(userId: string): UserProfile | null {
    const row = this.findUserRowById(userId);
    return row ? mapUserRow(row) : null;
  }

  getUserByUsername(username: string): UserProfile | null {
    const row = this.findUserRowByUsername(username);
    return row ? mapUserRow(row) : null;
  }

  searchUserDirectory(actor: UserProfile, query?: string): UserDirectoryEntry[] {
    if (!canServerAction(actor.serverRole, 'users:directory')) {
      throw new CollabServiceError('FORBIDDEN', 'Not permitted to search user directory.');
    }
    const trimmed = query?.trim() ?? '';
    let rows: Array<{ id: string; username: string; display_name: string }>;
    if (!trimmed) {
      rows = this.serverDb.db
        .prepare(
          `SELECT id, username, display_name
           FROM users
           WHERE status = 'ACTIVE'
           ORDER BY username ASC
           LIMIT 100`,
        )
        .all() as Array<{ id: string; username: string; display_name: string }>;
    } else {
      const pattern = `%${trimmed}%`;
      rows = this.serverDb.db
        .prepare(
          `SELECT id, username, display_name
           FROM users
           WHERE status = 'ACTIVE' AND (username LIKE ? OR display_name LIKE ?)
           ORDER BY username ASC
           LIMIT 100`,
        )
        .all(pattern, pattern) as Array<{ id: string; username: string; display_name: string }>;
    }
    return rows.map(row => ({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
    }));
  }

  listUsers(actor: UserProfile): UserAdminRecord[] {
    if (!canServerAction(actor.serverRole, 'users:list')) {
      throw new CollabServiceError('FORBIDDEN', 'Only server admins can list all users.');
    }
    const rows = this.serverDb.db
      .prepare('SELECT * FROM users ORDER BY created_at ASC, username ASC')
      .all() as UserRow[];
    return rows.map(mapUserRow);
  }

  createUser(
    actor: UserProfile,
    input: {
      username: string;
      displayName: string;
      password: string;
      serverRole?: 'USER' | 'SERVER_ADMIN';
    },
  ): UserAdminRecord {
    const parsed = adminCreateUserRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid user creation payload.',
      );
    }

    const assignedRole: ServerRole = parsed.data.serverRole ?? 'USER';
    if (!canServerAction(actor.serverRole, 'users:create', { assignedRole })) {
      throw new CollabServiceError(
        'FORBIDDEN',
        `Role '${actor.serverRole}' cannot create user with role '${assignedRole}'.`,
      );
    }

    return this.serverDb.transaction(() => {
      const existing = this.findUserRowByUsername(parsed.data.username);
      if (existing) {
        throw new CollabServiceError(
          'CONFLICT',
          `Username '${parsed.data.username}' is already taken.`,
        );
      }

      const nowIso = this.now().toISOString();
      const userId = `usr_${randomUUID()}`;
      const passwordHash = hashPassword(parsed.data.password);

      this.serverDb.db
        .prepare(
          `INSERT INTO users (id, username, display_name, password_hash, server_role, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
        )
        .run(
          userId,
          parsed.data.username,
          parsed.data.displayName,
          passwordHash,
          assignedRole,
          nowIso,
          nowIso,
        );

      const created = this.requireUserById(userId);
      this.serverDb.appendAuditLog({
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'users:create',
        targetId: created.id,
        details: { username: created.username, serverRole: created.serverRole },
        createdAt: nowIso,
      });

      return created;
    });
  }

  approveUser(actor: UserProfile, targetUserId: string): UserAdminRecord {
    if (!canServerAction(actor.serverRole, 'users:approve')) {
      throw new CollabServiceError('FORBIDDEN', 'Only server admins can approve users.');
    }

    return this.serverDb.transaction(() => {
      const target = this.requireUserById(targetUserId);
      const nowIso = this.now().toISOString();

      this.serverDb.db
        .prepare("UPDATE users SET status = 'ACTIVE', updated_at = ? WHERE id = ?")
        .run(nowIso, target.id);

      this.serverDb.appendAuditLog({
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'users:approve',
        targetId: target.id,
        details: { username: target.username, previousStatus: target.status },
        createdAt: nowIso,
      });

      return this.requireUserById(target.id);
    });
  }

  disableUser(actor: UserProfile, targetUserId: string, disabled = true): UserAdminRecord {
    return this.updateUser(actor, targetUserId, {
      status: disabled ? 'DISABLED' : 'ACTIVE',
    });
  }

  enableUser(actor: UserProfile, targetUserId: string): UserAdminRecord {
    return this.disableUser(actor, targetUserId, false);
  }

  changeServerRole(
    actor: UserProfile,
    targetUserId: string,
    newRole: 'USER' | 'SERVER_ADMIN',
  ): UserAdminRecord {
    return this.updateUser(actor, targetUserId, { serverRole: newRole });
  }

  updateUser(
    actor: UserProfile,
    targetUserId: string,
    input: {
      status?: 'ACTIVE' | 'DISABLED';
      serverRole?: 'USER' | 'SERVER_ADMIN';
      displayName?: string;
    },
  ): UserAdminRecord {
    const parsed = adminUpdateUserRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid user update payload.',
      );
    }

    return this.serverDb.transaction(() => {
      const target = this.requireUserById(targetUserId);

      if (parsed.data.serverRole !== undefined) {
        if (
          !canServerAction(actor.serverRole, 'users:change-server-role', {
            targetRole: target.serverRole,
            assignedRole: parsed.data.serverRole,
          })
        ) {
          throw new CollabServiceError(
            'FORBIDDEN',
            'Only the Server Owner can promote or demote Server Admins.',
          );
        }
      }

      if (parsed.data.status !== undefined || parsed.data.displayName !== undefined) {
        if (
          !canServerAction(actor.serverRole, 'users:disable', {
            targetRole: target.serverRole,
          })
        ) {
          throw new CollabServiceError(
            'FORBIDDEN',
            `Role '${actor.serverRole}' cannot modify a '${target.serverRole}' account.`,
          );
        }
      }

      if (parsed.data.status === 'DISABLED' && actor.id === target.id) {
        throw new CollabServiceError('FORBIDDEN', 'You cannot disable your own account.');
      }

      const nextStatus = parsed.data.status ?? target.status;
      const nextRole = parsed.data.serverRole ?? target.serverRole;
      const nextDisplayName = parsed.data.displayName ?? target.displayName;
      const nowIso = this.now().toISOString();

      this.serverDb.db
        .prepare(
          `UPDATE users
           SET status = ?, server_role = ?, display_name = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(nextStatus, nextRole, nextDisplayName, nowIso, target.id);

      if (nextStatus === 'DISABLED') {
        this.revokeUserSessions(target.id);
      }

      if (parsed.data.serverRole !== undefined && parsed.data.serverRole !== target.serverRole) {
        this.serverDb.appendAuditLog({
          actorId: actor.id,
          actorName: actor.displayName,
          action: 'users:change-server-role',
          targetId: target.id,
          details: { previousRole: target.serverRole, newRole: nextRole },
          createdAt: nowIso,
        });
      }

      if (parsed.data.status !== undefined && parsed.data.status !== target.status) {
        this.serverDb.appendAuditLog({
          actorId: actor.id,
          actorName: actor.displayName,
          action: 'users:disable',
          targetId: target.id,
          details: { previousStatus: target.status, status: nextStatus },
          createdAt: nowIso,
        });
      }

      return this.requireUserById(target.id);
    });
  }

  resetPassword(
    actor: UserProfile,
    targetUserId: string,
    input: { newPassword: string } | string,
  ): { reset: true } {
    const payload = typeof input === 'string' ? { newPassword: input } : input;
    const parsed = adminResetPasswordRequestSchema.safeParse(payload);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid password reset payload.',
      );
    }

    return this.serverDb.transaction(() => {
      const target = this.requireUserById(targetUserId);

      if (
        !canServerAction(actor.serverRole, 'users:reset-password', {
          targetRole: target.serverRole,
        })
      ) {
        throw new CollabServiceError(
          'FORBIDDEN',
          `Role '${actor.serverRole}' cannot reset password for a '${target.serverRole}' account.`,
        );
      }

      const nowIso = this.now().toISOString();
      const passwordHash = hashPassword(parsed.data.newPassword);

      this.serverDb.db
        .prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
        .run(passwordHash, nowIso, target.id);

      this.revokeUserSessions(target.id);

      this.serverDb.appendAuditLog({
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'users:reset-password',
        targetId: target.id,
        details: { username: target.username },
        createdAt: nowIso,
      });

      return { reset: true };
    });
  }

  revokeUserSessions(userId: string): void {
    this.serverDb.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  listServerAuditLog(actor: UserProfile, limit = 100): AuditEntry[] {
    if (!canServerAction(actor.serverRole, 'audit:view-server')) {
      throw new CollabServiceError('FORBIDDEN', 'Only server admins can view the server audit log.');
    }
    return this.serverDb.listAuditLog({ limit });
  }

  private createSession(userId: string): { token: string; expiresAt: string } {
    const token = generateRandomToken(32);
    const tokenHash = hashToken(token);
    const now = this.now();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.sessionTtlMs).toISOString();

    this.serverDb.db
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(tokenHash, userId, createdAt, expiresAt);

    return { token, expiresAt };
  }

  private findUserRowById(userId: string): UserRow | undefined {
    return this.serverDb.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as
      | UserRow
      | undefined;
  }

  private findUserRowByUsername(username: string): UserRow | undefined {
    return this.serverDb.db
      .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
      .get(username.trim()) as UserRow | undefined;
  }

  private requireUserById(userId: string): UserProfile {
    const row = this.findUserRowById(userId);
    if (!row) {
      throw new CollabServiceError('NOT_FOUND', `User '${userId}' not found.`);
    }
    return mapUserRow(row);
  }
}
