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
import { COLLAB_PROTOCOL_VERSION } from '../shared/collab/types.js';
import { CollabServiceError } from './errors.js';
import {
  mapAuditLogRow,
  mapServerSettingsRow,
  type ServerStore,
  type SessionRow,
  type UserRow,
} from './store/index.js';

export { CollabServiceError } from './errors.js';

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
  serverName?: string;
  registrationMode?: RegistrationMode;
  roomCreationMode?: RoomCreationMode;
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
  private initialized = false;
  private explicitSetupToken?: string;
  private readonly options: AuthServiceOptions;

  constructor(
    private readonly store: ServerStore,
    options: AuthServiceOptions = {},
  ) {
    this.options = options;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.now = options.now ?? (() => new Date());
    this.explicitSetupToken = options.initialSetupToken;
  }

  async initialize(explicitSetupToken?: string): Promise<void> {
    const tokenCandidate = explicitSetupToken ?? this.explicitSetupToken;
    const nowIso = this.now().toISOString();
    await this.store.serverSettings.ensure({
      serverName: this.options.serverName,
      registrationMode: this.options.registrationMode,
      roomCreationMode: this.options.roomCreationMode,
      nowIso,
    });

    const settingsUpdate: {
      serverName?: string;
      registrationMode?: RegistrationMode;
      roomCreationMode?: RoomCreationMode;
      setupTokenHash?: string | null;
      updatedAt: string;
    } = { updatedAt: nowIso };

    if (this.options.serverName !== undefined) {
      settingsUpdate.serverName = this.options.serverName;
    }
    if (this.options.registrationMode !== undefined) {
      settingsUpdate.registrationMode = this.options.registrationMode;
    }
    if (this.options.roomCreationMode !== undefined) {
      settingsUpdate.roomCreationMode = this.options.roomCreationMode;
    }

    const userCount = await this.store.users.count();
    if (userCount === 0) {
      const token = tokenCandidate?.trim() || generateRandomToken(24);
      const tokenHash = hashToken(token);
      settingsUpdate.setupTokenHash = tokenHash;
      this.initialSetupToken = token;
    } else {
      this.initialSetupToken = null;
      const settingsRow = await this.store.serverSettings.get();
      if (settingsRow && settingsRow.setup_token_hash !== null) {
        settingsUpdate.setupTokenHash = null;
      }
    }
    await this.store.serverSettings.update(settingsUpdate);
    this.initialized = true;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  async getInitialSetupToken(): Promise<string | null> {
    await this.ensureInitialized();
    const setupRequired = await this.isSetupRequired();
    return setupRequired ? this.initialSetupToken : null;
  }

  async isSetupRequired(): Promise<boolean> {
    await this.ensureInitialized();
    const count = await this.store.users.count();
    if (count > 0) {
      return false;
    }
    const settings = await this.store.serverSettings.get();
    return settings?.setup_token_hash !== null;
  }

  async getServerSettings(): Promise<ServerSettings> {
    await this.ensureInitialized();
    const row = await this.store.serverSettings.get();
    if (!row) {
      throw new CollabServiceError('INTERNAL_ERROR', 'Server settings not found.');
    }
    return mapServerSettingsRow(row);
  }

  async getPublicInfo(
    meta: {
      version?: string;
      tls?: boolean;
      fingerprint?: string | null;
    } = {},
  ): Promise<ServerPublicInfo> {
    const settings = await this.getServerSettings();
    const setupRequired = await this.isSetupRequired();
    return {
      serverId: settings.serverId,
      protocolVersion: COLLAB_PROTOCOL_VERSION,
      name: settings.name,
      version: meta.version ?? '0.6.0',
      tls: meta.tls ?? true,
      fingerprint: meta.fingerprint ?? null,
      setupRequired,
      registrationMode: settings.registrationMode,
      roomCreationMode: settings.roomCreationMode,
    };
  }

  async updateServerSettings(
    actor: UserProfile,
    input: {
      name?: string;
      registrationMode?: RegistrationMode;
      roomCreationMode?: RoomCreationMode;
    },
  ): Promise<ServerSettings> {
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

    await this.ensureInitialized();
    const current = await this.store.serverSettings.get();
    if (!current) {
      throw new CollabServiceError('NOT_FOUND', 'Server settings not found.');
    }

    const nextName = parsed.data.name ?? current.server_name;
    const nextRegMode = parsed.data.registrationMode ?? current.registration_mode;
    const nextRoomMode = parsed.data.roomCreationMode ?? current.room_creation_mode;
    const nowIso = this.now().toISOString();

    return this.store.transaction(async tx => {
      const updated = await tx.serverSettings.update({
        serverName: nextName,
        registrationMode: nextRegMode,
        roomCreationMode: nextRoomMode,
        updatedAt: nowIso,
      });

      await tx.audit.append({
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

      return mapServerSettingsRow(updated);
    });
  }

  async claimSetupToken(input: {
    setupToken: string;
    username: string;
    displayName: string;
    password: string;
  }): Promise<AuthSessionResult> {
    const parsed = setupRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid setup request payload.',
      );
    }

    await this.ensureInitialized();
    const setupRequired = await this.isSetupRequired();
    const settingsRow = await this.store.serverSettings.get();
    const hasValidSetupToken =
      setupRequired &&
      settingsRow?.setup_token_hash !== null &&
      settingsRow?.setup_token_hash !== undefined &&
      verifyTokenHash(parsed.data.setupToken, settingsRow.setup_token_hash);

    if (
      !canServerAction(null, 'auth:setup', {
        setupRequired,
        hasValidSetupToken,
      })
    ) {
      throw new CollabServiceError('FORBIDDEN', 'Setup token is invalid or has already been used.');
    }

    return this.store.transaction(async tx => {
      const nowIso = this.now().toISOString();
      const userId = `usr_${randomUUID()}`;
      const passwordHash = hashPassword(parsed.data.password);

      const createdUser = await tx.users.create({
        id: userId,
        username: parsed.data.username,
        displayName: parsed.data.displayName,
        passwordHash,
        serverRole: 'SERVER_OWNER',
        status: 'ACTIVE',
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      await tx.serverSettings.update({
        setupTokenHash: null,
        updatedAt: nowIso,
      });

      this.initialSetupToken = null;

      const user = mapUserRow(createdUser);
      await tx.audit.append({
        actorId: user.id,
        actorName: user.displayName,
        action: 'auth:setup',
        targetId: user.id,
        details: { username: user.username, serverRole: 'SERVER_OWNER' },
        createdAt: nowIso,
      });

      const session = await this.createSession(tx, user.id);
      return {
        user,
        token: session.token,
        expiresAt: session.expiresAt,
      };
    });
  }

  async registerUser(input: {
    username: string;
    displayName: string;
    password: string;
  }): Promise<RegisterResult> {
    const parsed = registerRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid registration payload.',
      );
    }

    const settings = await this.getServerSettings();
    if (!canServerAction(null, 'auth:register', { registrationMode: settings.registrationMode })) {
      throw new CollabServiceError('FORBIDDEN', 'Self-registration is closed on this server.');
    }

    return this.store.transaction(async tx => {
      const existing = await tx.users.getByUsername(parsed.data.username);
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

      const userRow = await tx.users.create({
        id: userId,
        username: parsed.data.username,
        displayName: parsed.data.displayName,
        passwordHash,
        serverRole: 'USER',
        status,
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      const user = mapUserRow(userRow);
      await tx.audit.append({
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

      const session = await this.createSession(tx, user.id);
      return {
        status: 'ACTIVE',
        user,
        token: session.token,
        expiresAt: session.expiresAt,
      };
    });
  }

  async loginUser(input: { username: string; password: string }): Promise<AuthSessionResult> {
    const parsed = loginRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid login payload.',
      );
    }

    await this.ensureInitialized();
    const userRow = await this.store.users.getByUsername(parsed.data.username);
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
    const session = await this.createSession(this.store, user.id);
    return {
      user,
      token: session.token,
      expiresAt: session.expiresAt,
    };
  }

  async logoutSession(token: string): Promise<{ loggedOut: true }> {
    const user = await this.authenticateToken(token);
    if (!canServerAction(user.serverRole, 'auth:logout')) {
      throw new CollabServiceError('FORBIDDEN', 'Not permitted to log out.');
    }
    const tokenHash = hashToken(token);
    await this.store.sessions.deleteByTokenHash(tokenHash);
    return { loggedOut: true };
  }

  async authenticateToken(token: string | null | undefined): Promise<UserProfile> {
    if (!token || typeof token !== 'string' || !token.trim()) {
      throw new CollabServiceError('UNAUTHORIZED', 'Authentication token is required.');
    }

    await this.ensureInitialized();
    const tokenHash = hashToken(token.trim());
    const sessionRow = await this.store.sessions.getByTokenHash(tokenHash);

    if (!sessionRow) {
      throw new CollabServiceError('UNAUTHORIZED', 'Invalid or revoked session token.');
    }

    const nowMs = this.now().getTime();
    const expiresMs = new Date(sessionRow.expires_at).getTime();
    if (Number.isNaN(expiresMs) || expiresMs <= nowMs) {
      await this.store.sessions.deleteByTokenHash(tokenHash);
      throw new CollabServiceError('UNAUTHORIZED', 'Session token has expired.');
    }

    const userRow = await this.store.users.getById(sessionRow.user_id);
    if (!userRow || userRow.status !== 'ACTIVE') {
      await this.revokeUserSessions(sessionRow.user_id);
      throw new CollabServiceError('UNAUTHORIZED', 'User account is not active.');
    }

    return mapUserRow(userRow);
  }

  async authenticateAuthorizationHeader(authHeader: string | undefined): Promise<UserProfile> {
    if (!authHeader) {
      throw new CollabServiceError('UNAUTHORIZED', 'Missing Authorization header.');
    }
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (!match?.[1]) {
      throw new CollabServiceError('UNAUTHORIZED', 'Expected Authorization: Bearer <token>.');
    }
    return this.authenticateToken(match[1]);
  }

  async getUserById(userId: string): Promise<UserProfile | null> {
    await this.ensureInitialized();
    const row = await this.store.users.getById(userId);
    return row ? mapUserRow(row) : null;
  }

  async getUserByUsername(username: string): Promise<UserProfile | null> {
    await this.ensureInitialized();
    const row = await this.store.users.getByUsername(username);
    return row ? mapUserRow(row) : null;
  }

  async searchUserDirectory(actor: UserProfile, query?: string): Promise<UserDirectoryEntry[]> {
    if (!canServerAction(actor.serverRole, 'users:directory')) {
      throw new CollabServiceError('FORBIDDEN', 'Not permitted to search user directory.');
    }
    await this.ensureInitialized();
    const rows = await this.store.users.search(query?.trim() ?? '', 100);
    return rows
      .filter(r => r.status === 'ACTIVE')
      .map(row => ({
        id: row.id,
        username: row.username,
        displayName: row.display_name,
      }));
  }

  async listUsers(actor: UserProfile): Promise<UserAdminRecord[]> {
    if (!canServerAction(actor.serverRole, 'users:list')) {
      throw new CollabServiceError('FORBIDDEN', 'Only server admins can list all users.');
    }
    await this.ensureInitialized();
    const rows = await this.store.users.list({ limit: 1000 });
    return rows.map(mapUserRow);
  }

  async createUser(
    actor: UserProfile,
    input: {
      username: string;
      displayName: string;
      password: string;
      serverRole?: 'USER' | 'SERVER_ADMIN';
    },
  ): Promise<UserAdminRecord> {
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

    await this.ensureInitialized();
    return this.store.transaction(async tx => {
      const existing = await tx.users.getByUsername(parsed.data.username);
      if (existing) {
        throw new CollabServiceError(
          'CONFLICT',
          `Username '${parsed.data.username}' is already taken.`,
        );
      }

      const nowIso = this.now().toISOString();
      const userId = `usr_${randomUUID()}`;
      const passwordHash = hashPassword(parsed.data.password);

      const created = await tx.users.create({
        id: userId,
        username: parsed.data.username,
        displayName: parsed.data.displayName,
        passwordHash,
        serverRole: assignedRole,
        status: 'ACTIVE',
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      const userRecord = mapUserRow(created);
      await tx.audit.append({
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'users:create',
        targetId: userRecord.id,
        details: { username: userRecord.username, serverRole: userRecord.serverRole },
        createdAt: nowIso,
      });

      return userRecord;
    });
  }

  async approveUser(actor: UserProfile, targetUserId: string): Promise<UserAdminRecord> {
    if (!canServerAction(actor.serverRole, 'users:approve')) {
      throw new CollabServiceError('FORBIDDEN', 'Only server admins can approve users.');
    }

    await this.ensureInitialized();
    return this.store.transaction(async tx => {
      const targetRow = await tx.users.getById(targetUserId);
      if (!targetRow) {
        throw new CollabServiceError('NOT_FOUND', `User '${targetUserId}' not found.`);
      }

      const nowIso = this.now().toISOString();
      const updated = await tx.users.update(targetRow.id, {
        status: 'ACTIVE',
        updatedAt: nowIso,
      });

      await tx.audit.append({
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'users:approve',
        targetId: targetRow.id,
        details: { username: targetRow.username, previousStatus: targetRow.status },
        createdAt: nowIso,
      });

      return mapUserRow(updated);
    });
  }

  async disableUser(actor: UserProfile, targetUserId: string, disabled = true): Promise<UserAdminRecord> {
    return this.updateUser(actor, targetUserId, {
      status: disabled ? 'DISABLED' : 'ACTIVE',
    });
  }

  async enableUser(actor: UserProfile, targetUserId: string): Promise<UserAdminRecord> {
    return this.disableUser(actor, targetUserId, false);
  }

  async changeServerRole(
    actor: UserProfile,
    targetUserId: string,
    newRole: 'USER' | 'SERVER_ADMIN',
  ): Promise<UserAdminRecord> {
    return this.updateUser(actor, targetUserId, { serverRole: newRole });
  }

  async updateUser(
    actor: UserProfile,
    targetUserId: string,
    input: {
      status?: 'ACTIVE' | 'DISABLED';
      serverRole?: 'USER' | 'SERVER_ADMIN';
      displayName?: string;
    },
  ): Promise<UserAdminRecord> {
    const parsed = adminUpdateUserRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid user update payload.',
      );
    }

    await this.ensureInitialized();
    return this.store.transaction(async tx => {
      const targetRow = await tx.users.getById(targetUserId);
      if (!targetRow) {
        throw new CollabServiceError('NOT_FOUND', `User '${targetUserId}' not found.`);
      }
      const target = mapUserRow(targetRow);

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

      const updated = await tx.users.update(target.id, {
        status: nextStatus,
        serverRole: nextRole,
        displayName: nextDisplayName,
        updatedAt: nowIso,
      });

      if (nextStatus === 'DISABLED') {
        await tx.sessions.deleteByUserId(target.id);
      }

      if (parsed.data.serverRole !== undefined && parsed.data.serverRole !== target.serverRole) {
        await tx.audit.append({
          actorId: actor.id,
          actorName: actor.displayName,
          action: 'users:change-server-role',
          targetId: target.id,
          details: { previousRole: target.serverRole, newRole: nextRole },
          createdAt: nowIso,
        });
      }

      if (parsed.data.status !== undefined && parsed.data.status !== target.status) {
        await tx.audit.append({
          actorId: actor.id,
          actorName: actor.displayName,
          action: 'users:disable',
          targetId: target.id,
          details: { previousStatus: target.status, status: nextStatus },
          createdAt: nowIso,
        });
      }

      return mapUserRow(updated);
    });
  }

  async resetPassword(
    actor: UserProfile,
    targetUserId: string,
    input: { newPassword: string } | string,
  ): Promise<{ reset: true }> {
    const payload = typeof input === 'string' ? { newPassword: input } : input;
    const parsed = adminResetPasswordRequestSchema.safeParse(payload);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid password reset payload.',
      );
    }

    await this.ensureInitialized();
    return this.store.transaction(async tx => {
      const targetRow = await tx.users.getById(targetUserId);
      if (!targetRow) {
        throw new CollabServiceError('NOT_FOUND', `User '${targetUserId}' not found.`);
      }

      if (
        !canServerAction(actor.serverRole, 'users:reset-password', {
          targetRole: targetRow.server_role,
        })
      ) {
        throw new CollabServiceError(
          'FORBIDDEN',
          `Role '${actor.serverRole}' cannot reset password for a '${targetRow.server_role}' account.`,
        );
      }

      const nowIso = this.now().toISOString();
      const passwordHash = hashPassword(parsed.data.newPassword);

      await tx.users.update(targetRow.id, {
        passwordHash,
        updatedAt: nowIso,
      });

      await tx.sessions.deleteByUserId(targetRow.id);

      await tx.audit.append({
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'users:reset-password',
        targetId: targetRow.id,
        details: { username: targetRow.username },
        createdAt: nowIso,
      });

      return { reset: true };
    });
  }

  async revokeUserSessions(userId: string): Promise<void> {
    await this.store.sessions.deleteByUserId(userId);
  }

  async listServerAuditLog(actor: UserProfile, limit = 100): Promise<AuditEntry[]> {
    if (!canServerAction(actor.serverRole, 'audit:view-server')) {
      throw new CollabServiceError('FORBIDDEN', 'Only server admins can view the server audit log.');
    }
    const rows = await this.store.audit.list({ limit });
    return rows.map(mapAuditLogRow);
  }

  private async createSession(
    storeOrTx: ServerStore,
    userId: string,
  ): Promise<{ token: string; expiresAt: string }> {
    const token = generateRandomToken(32);
    const tokenHash = hashToken(token);
    const now = this.now();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.sessionTtlMs).toISOString();

    await storeOrTx.sessions.create({
      tokenHash,
      userId,
      createdAt,
      expiresAt,
    });

    return { token, expiresAt };
  }
}
