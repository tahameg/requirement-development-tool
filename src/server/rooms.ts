import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportWorkspace } from '../main/services/exportService.js';
import { validateWorkspace } from '../main/services/validation.js';
import { createWorkspace } from '../main/services/workspaceFactory.js';
import { loadWorkspace, saveWorkspace } from '../main/services/workspaceService.js';
import { canRoomAction, canServerAction, hasMinimumRoomRole } from '../shared/collab/permissions.js';
import {
  adminResolveRoomRequestSchema,
  createDirectInviteRequestSchema,
  createInviteCodeRequestSchema,
  createJoinRequestSchema,
  createRoomRequestSchema,
  kickOrBanMemberRequestSchema,
  redeemInviteCodeRequestSchema,
  respondInviteRequestSchema,
  reviewJoinRequestSchema,
  roomExportQuerySchema,
  transferOwnershipRequestSchema,
  updateRoomMemberRoleRequestSchema,
  updateRoomRequestSchema,
} from '../shared/collab/protocol.js';
import {
  assignUserColor,
  type AssignableRoomRole,
  type AuditEntry,
  type BelowAdminRoomRole,
  type DirectInviteSummary,
  type InviteCodeInfo,
  type InviteInfo,
  type JoinRequestSummary,
  type ListedRoomSummary,
  type RoomAction,
  type RoomBanInfo,
  type RoomDetail,
  type RoomExportResult,
  type RoomMemberInfo,
  type RoomRole,
  type RoomSummary,
  type UserProfile,
} from '../shared/collab/types.js';
import type { Workspace } from '../shared/types/workspace.js';
import {
  CollabServiceError,
  type InviteRow,
  type JoinRequestRow,
  type RoomBanRow,
  type RoomMemberRow,
  type RoomRow,
  type ServerDatabase,
  type UserRow,
} from './db.js';

export type RoomLifecycleEvent =
  | { type: 'room-created'; roomId: string; actorId: string }
  | { type: 'room-updated'; roomId: string; actorId: string }
  | { type: 'room-deleted'; roomId: string; actorId: string; reason: string }
  | { type: 'member-joined'; roomId: string; userId: string; role: RoomRole }
  | { type: 'member-left'; roomId: string; userId: string }
  | { type: 'role-changed'; roomId: string; userId: string; previousRole: RoomRole; newRole: RoomRole }
  | { type: 'member-kicked'; roomId: string; userId: string; reason: string }
  | { type: 'member-banned'; roomId: string; userId: string; reason: string }
  | { type: 'join-request-created'; roomId: string; joinRequest: JoinRequestSummary }
  | { type: 'join-request-reviewed'; roomId: string; joinRequest: JoinRequestSummary }
  | {
      type: 'ownership-transferred';
      roomId: string;
      previousOwnerId: string;
      newOwnerId: string;
    };

export interface RoomServiceOptions {
  roomsDir?: string;
  now?: () => Date;
  getOnlineUserIds?: (roomId: string) => ReadonlySet<string> | string[];
  getWorkspaceProvider?: (roomId: string) => Workspace | null | undefined;
  onRoomEvent?: (event: RoomLifecycleEvent) => void;
}

export interface ListRoomsForUserResult {
  myRooms: RoomSummary[];
  listedRooms: ListedRoomSummary[];
  myInvites: DirectInviteSummary[];
  myJoinRequests: JoinRequestSummary[];
}

export interface GetRoomDetailResult {
  room: RoomDetail;
  members: RoomMemberInfo[];
  invites: InviteInfo[];
  joinRequests: JoinRequestSummary[];
  bans: RoomBanInfo[];
  workspace: Workspace;
}

function generateInviteCodeString(): string {
  return randomBytes(6).toString('hex').toUpperCase();
}

export class RoomService {
  readonly roomsDir: string;
  private readonly ownsTempRoomsDir: boolean;
  private readonly now: () => Date;
  private getOnlineUserIds?: (roomId: string) => ReadonlySet<string> | string[];
  private getWorkspaceProvider?: (roomId: string) => Workspace | null | undefined;
  private onRoomEvent?: (event: RoomLifecycleEvent) => void;

  constructor(
    private readonly serverDb: ServerDatabase,
    options: RoomServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.getOnlineUserIds = options.getOnlineUserIds;
    this.getWorkspaceProvider = options.getWorkspaceProvider;
    this.onRoomEvent = options.onRoomEvent;

    if (options.roomsDir) {
      this.roomsDir = path.resolve(options.roomsDir);
      this.ownsTempRoomsDir = false;
    } else if (serverDb.dataDir === ':memory:') {
      this.roomsDir = mkdtempSync(path.join(os.tmpdir(), 'hlr-rooms-mem-'));
      this.ownsTempRoomsDir = true;
    } else {
      this.roomsDir = path.join(serverDb.dataDir, 'rooms');
      this.ownsTempRoomsDir = false;
    }
  }

  setRuntimeHooks(hooks: {
    getOnlineUserIds?: (roomId: string) => ReadonlySet<string> | string[];
    getWorkspaceProvider?: (roomId: string) => Workspace | null | undefined;
    onRoomEvent?: (event: RoomLifecycleEvent) => void;
  }): void {
    if (hooks.getOnlineUserIds !== undefined) {
      this.getOnlineUserIds = hooks.getOnlineUserIds;
    }
    if (hooks.getWorkspaceProvider !== undefined) {
      this.getWorkspaceProvider = hooks.getWorkspaceProvider;
    }
    if (hooks.onRoomEvent !== undefined) {
      this.onRoomEvent = hooks.onRoomEvent;
    }
  }

  cleanupTempDir(): void {
    if (this.ownsTempRoomsDir) {
      rmSync(this.roomsDir, { recursive: true, force: true });
    }
  }

  getRoomDir(roomId: string): string {
    return path.join(this.roomsDir, roomId);
  }

  getRoomWorkspaceDir(roomId: string): string {
    return path.join(this.getRoomDir(roomId), 'workspace');
  }

  getRoomRevisionsDir(roomId: string): string {
    return path.join(this.getRoomDir(roomId), 'revisions');
  }

  async loadRoomWorkspace(roomId: string): Promise<Workspace> {
    this.requireRoomRow(roomId);
    const live = this.getWorkspaceProvider?.(roomId);
    if (live) {
      return live;
    }
    return loadWorkspace(this.getRoomWorkspaceDir(roomId));
  }

  async saveRoomWorkspace(roomId: string, workspace: Workspace): Promise<void> {
    this.requireRoomRow(roomId);
    await saveWorkspace(this.getRoomWorkspaceDir(roomId), workspace);
  }

  recordAutosave(roomId: string, autosavedAt?: string): string {
    const timestamp = autosavedAt ?? this.now().toISOString();
    this.serverDb.db
      .prepare('UPDATE rooms SET last_autosaved_at = ?, updated_at = ? WHERE id = ?')
      .run(timestamp, timestamp, roomId);
    return timestamp;
  }

  async createRoom(actor: UserProfile, input: unknown): Promise<RoomSummary> {
    const settings = this.serverDb.getSettings();
    if (
      !canServerAction(actor.serverRole, 'rooms:create', {
        roomCreationMode: settings.roomCreationMode,
      })
    ) {
      throw new CollabServiceError(
        'FORBIDDEN',
        'Only server administrators can create rooms on this server.',
      );
    }

    const parsed = createRoomRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid room creation payload.',
      );
    }

    let workspace: Workspace;
    try {
      if (parsed.data.workspace !== undefined) {
        workspace = validateWorkspace(parsed.data.workspace);
      } else {
        const projectName = parsed.data.projectName ?? parsed.data.name;
        const projectPrefix = parsed.data.projectPrefix ?? '';
        workspace = createWorkspace(projectName, projectPrefix);
      }
    } catch (error) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        error instanceof Error ? error.message : 'Invalid workspace configuration.',
      );
    }

    const roomId = `room_${randomUUID()}`;
    const workspaceDir = this.getRoomWorkspaceDir(roomId);
    await saveWorkspace(workspaceDir, workspace);

    try {
      const nowIso = this.now().toISOString();
      this.serverDb.transaction(() => {
        this.serverDb.db
          .prepare(
            `INSERT INTO rooms (
              id, name, visibility, owner_id, project_id, project_name, last_autosaved_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            roomId,
            parsed.data.name,
            parsed.data.visibility,
            actor.id,
            workspace.config.projectId,
            workspace.config.projectName,
            nowIso,
            nowIso,
            nowIso,
          );

        this.serverDb.db
          .prepare(
            `INSERT INTO room_members (room_id, user_id, role, joined_at)
             VALUES (?, ?, 'ROOM_OWNER', ?)`,
          )
          .run(roomId, actor.id, nowIso);

        this.serverDb.appendAuditLog({
          roomId,
          actorId: actor.id,
          actorName: actor.displayName,
          action: 'rooms:create',
          targetId: roomId,
          details: {
            name: parsed.data.name,
            visibility: parsed.data.visibility,
            projectId: workspace.config.projectId,
            projectName: workspace.config.projectName,
            imported: Boolean(parsed.data.workspace),
          },
          createdAt: nowIso,
        });
      });
    } catch (error) {
      rmSync(this.getRoomDir(roomId), { recursive: true, force: true });
      throw error;
    }

    this.emitEvent({ type: 'room-created', roomId, actorId: actor.id });
    return this.getRoomSummary(roomId, actor.id);
  }

  listRoomsForUser(actor: UserProfile): ListRoomsForUserResult {
    const memberRows = this.serverDb.db
      .prepare(
        `SELECT r.*
         FROM rooms r
         INNER JOIN room_members rm ON rm.room_id = r.id
         WHERE rm.user_id = ?
         ORDER BY r.updated_at DESC, r.created_at DESC`,
      )
      .all(actor.id) as RoomRow[];

    const myRooms = memberRows.map(row => this.mapRoomRowToSummary(row, actor.id));

    const listedRows = this.serverDb.db
      .prepare(
        `SELECT *
         FROM rooms
         WHERE visibility = 'listed'
         ORDER BY updated_at DESC, created_at DESC`,
      )
      .all() as RoomRow[];

    const listedRooms: ListedRoomSummary[] = [];
    for (const row of listedRows) {
      const myRole = this.getMemberRole(row.id, actor.id);
      const isBanned = this.isUserBanned(row.id, actor.id);
      if (
        !canRoomAction(myRole, 'room:view-listed', {
          visibility: row.visibility,
          isBanned,
          actorServerRole: actor.serverRole,
        })
      ) {
        continue;
      }

      const ownerRow = this.findUserRow(row.owner_id);
      const memberCount = this.getRoomMemberCount(row.id);
      const pendingReq = this.serverDb.db
        .prepare(
          `SELECT 1 FROM join_requests
           WHERE room_id = ? AND user_id = ? AND status = 'PENDING'`,
        )
        .get(row.id, actor.id);

      listedRooms.push({
        id: row.id,
        name: row.name,
        visibility: 'listed',
        ownerId: row.owner_id,
        ownerDisplayName: ownerRow?.display_name ?? row.owner_id,
        projectId: row.project_id,
        projectName: row.project_name,
        memberCount,
        hasPendingJoinRequest: Boolean(pendingReq),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    }

    const inviteRows = this.serverDb.db
      .prepare(
        `SELECT *
         FROM invites
         WHERE target_user_id = ? AND kind = 'direct' AND status = 'PENDING'
         ORDER BY created_at DESC`,
      )
      .all(actor.id) as InviteRow[];

    const myInvites = inviteRows
      .filter(inv => !this.isUserBanned(inv.room_id, actor.id))
      .map(inv => this.mapDirectInviteRow(inv));

    const joinReqRows = this.serverDb.db
      .prepare(
        `SELECT *
         FROM join_requests
         WHERE user_id = ?
         ORDER BY created_at DESC`,
      )
      .all(actor.id) as JoinRequestRow[];

    const myJoinRequests = joinReqRows.map(req => this.mapJoinRequestRow(req));

    return {
      myRooms,
      listedRooms,
      myInvites,
      myJoinRequests,
    };
  }

  async getRoom(actor: UserProfile, roomId: string): Promise<GetRoomDetailResult> {
    const roomRow = this.requireRoomRow(roomId);
    const myRole = this.getMemberRole(roomId, actor.id);
    const isBanned = this.isUserBanned(roomId, actor.id);
    const isServerAdmin =
      actor.serverRole === 'SERVER_ADMIN' || actor.serverRole === 'SERVER_OWNER';

    if (isBanned && !isServerAdmin) {
      throw new CollabServiceError('FORBIDDEN', 'You are banned from this room.');
    }

    if (myRole === null && !isServerAdmin) {
      throw new CollabServiceError('FORBIDDEN', 'You are not a member of this room.');
    }

    const room = this.mapRoomRowToSummary(roomRow, actor.id);
    const members = this.listRoomMembers(roomId);
    const canViewAdminLists = hasMinimumRoomRole(myRole, 'ROOM_ADMIN') || isServerAdmin;
    const invites = canViewAdminLists ? this.listRoomInvites(roomId) : [];
    const joinRequests = canViewAdminLists ? this.listRoomJoinRequests(roomId) : [];
    const bans = canViewAdminLists ? this.listRoomBans(roomId) : [];
    const workspace = await this.loadRoomWorkspace(roomId);

    return {
      room,
      members,
      invites,
      joinRequests,
      bans,
      workspace,
    };
  }

  updateRoom(actor: UserProfile, roomId: string, input: unknown): RoomSummary {
    const roomRow = this.requireRoomRow(roomId);
    const actorRole = this.getMemberRole(roomId, actor.id);
    if (
      !canRoomAction(actorRole, 'room:edit-metadata', {
        isBanned: this.isUserBanned(roomId, actor.id),
      })
    ) {
      throw new CollabServiceError('FORBIDDEN', 'Only room admins can update room metadata.');
    }

    const parsed = updateRoomRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid room update payload.',
      );
    }

    const nextName = parsed.data.name ?? roomRow.name;
    const nextVisibility = parsed.data.visibility ?? roomRow.visibility;
    const nowIso = this.now().toISOString();

    this.serverDb.transaction(() => {
      this.serverDb.db
        .prepare('UPDATE rooms SET name = ?, visibility = ?, updated_at = ? WHERE id = ?')
        .run(nextName, nextVisibility, nowIso, roomId);

      this.serverDb.appendAuditLog({
        roomId,
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'room:edit-metadata',
        targetId: roomId,
        details: {
          previousName: roomRow.name,
          name: nextName,
          previousVisibility: roomRow.visibility,
          visibility: nextVisibility,
        },
        createdAt: nowIso,
      });
    });

    this.emitEvent({ type: 'room-updated', roomId, actorId: actor.id });
    return this.getRoomSummary(roomId, actor.id);
  }

  deleteRoom(actor: UserProfile, roomId: string): { deleted: true } {
    const roomRow = this.requireRoomRow(roomId);
    const actorRole = this.getMemberRole(roomId, actor.id);
    if (
      !canRoomAction(actorRole, 'room:delete', {
        actorServerRole: actor.serverRole,
        isBanned: this.isUserBanned(roomId, actor.id),
      })
    ) {
      throw new CollabServiceError(
        'FORBIDDEN',
        'Only the room owner or a server administrator can delete a room.',
      );
    }

    const nowIso = this.now().toISOString();
    const auditAction = actorRole === 'ROOM_OWNER' ? 'room:delete' : 'rooms:force-delete';

    this.serverDb.transaction(() => {
      this.serverDb.db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
      this.serverDb.appendAuditLog({
        roomId,
        actorId: actor.id,
        actorName: actor.displayName,
        action: auditAction,
        targetId: roomId,
        details: {
          name: roomRow.name,
          ownerId: roomRow.owner_id,
          projectId: roomRow.project_id,
        },
        createdAt: nowIso,
      });
    });

    rmSync(this.getRoomDir(roomId), { recursive: true, force: true });
    this.emitEvent({
      type: 'room-deleted',
      roomId,
      actorId: actor.id,
      reason: `Room '${roomRow.name}' was deleted by ${actor.displayName}.`,
    });

    return { deleted: true };
  }

  leaveRoom(actor: UserProfile, roomId: string): { left: true } {
    this.requireRoomRow(roomId);
    const actorRole = this.getMemberRole(roomId, actor.id);
    if (actorRole === null) {
      throw new CollabServiceError('FORBIDDEN', 'You are not a member of this room.');
    }

    if (actorRole === 'ROOM_OWNER') {
      throw new CollabServiceError(
        'BAD_REQUEST',
        'Room owner cannot leave the room without transferring ownership or deleting the room first.',
      );
    }

    if (
      !canRoomAction(actorRole, 'room:leave', {
        isBanned: this.isUserBanned(roomId, actor.id),
      })
    ) {
      throw new CollabServiceError('FORBIDDEN', 'Not permitted to leave this room.');
    }

    const nowIso = this.now().toISOString();
    this.serverDb.transaction(() => {
      this.serverDb.db
        .prepare('DELETE FROM room_members WHERE room_id = ? AND user_id = ?')
        .run(roomId, actor.id);

      this.serverDb.db
        .prepare('UPDATE rooms SET updated_at = ? WHERE id = ?')
        .run(nowIso, roomId);

      this.serverDb.appendAuditLog({
        roomId,
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'room:leave',
        targetId: actor.id,
        details: { previousRole: actorRole },
        createdAt: nowIso,
      });
    });

    this.emitEvent({ type: 'member-left', roomId, userId: actor.id });
    return { left: true };
  }

  transferOwnership(actor: UserProfile, roomId: string, input: unknown): RoomSummary {
    this.requireRoomRow(roomId);
    const actorRole = this.getMemberRole(roomId, actor.id);
    if (
      !canRoomAction(actorRole, 'room:transfer-ownership', {
        isBanned: this.isUserBanned(roomId, actor.id),
      })
    ) {
      throw new CollabServiceError('FORBIDDEN', 'Only the room owner can transfer ownership.');
    }

    const payload = typeof input === 'string' ? { newOwnerUserId: input } : input;
    const parsed = transferOwnershipRequestSchema.safeParse(payload);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid ownership transfer payload.',
      );
    }

    const newOwnerId = parsed.data.newOwnerUserId;
    if (newOwnerId === actor.id) {
      throw new CollabServiceError('BAD_REQUEST', 'You are already the owner of this room.');
    }

    const targetUser = this.findUserRow(newOwnerId);
    if (!targetUser) {
      throw new CollabServiceError('NOT_FOUND', `User '${newOwnerId}' not found.`);
    }

    const targetMemberRole = this.getMemberRole(roomId, newOwnerId);
    if (targetMemberRole === null) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        'New owner must already be a member of the room.',
      );
    }

    const nowIso = this.now().toISOString();
    this.serverDb.transaction(() => {
      this.serverDb.db
        .prepare("UPDATE room_members SET role = 'ROOM_ADMIN' WHERE room_id = ? AND user_id = ?")
        .run(roomId, actor.id);

      this.serverDb.db
        .prepare("UPDATE room_members SET role = 'ROOM_OWNER' WHERE room_id = ? AND user_id = ?")
        .run(roomId, newOwnerId);

      this.serverDb.db
        .prepare('UPDATE rooms SET owner_id = ?, updated_at = ? WHERE id = ?')
        .run(newOwnerId, nowIso, roomId);

      this.serverDb.appendAuditLog({
        roomId,
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'room:transfer-ownership',
        targetId: newOwnerId,
        details: {
          previousOwnerId: actor.id,
          newOwnerId,
          previousTargetRole: targetMemberRole,
        },
        createdAt: nowIso,
      });
    });

    this.emitEvent({
      type: 'ownership-transferred',
      roomId,
      previousOwnerId: actor.id,
      newOwnerId,
    });

    return this.getRoomSummary(roomId, actor.id);
  }

  createDirectInvite(actor: UserProfile, roomId: string, input: unknown): DirectInviteSummary {
    this.requireRoomRow(roomId);
    const parsed = createDirectInviteRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid direct invite payload.',
      );
    }

    const actorRole = this.getMemberRole(roomId, actor.id);
    if (
      !canRoomAction(actorRole, 'member:invite-user', {
        assignedRole: parsed.data.role,
        isBanned: this.isUserBanned(roomId, actor.id),
      })
    ) {
      throw new CollabServiceError(
        'FORBIDDEN',
        `Role '${actorRole ?? 'NONE'}' cannot invite a user with role '${parsed.data.role}'.`,
      );
    }

    const targetUser = this.findUserRow(parsed.data.targetUserId);
    if (!targetUser) {
      throw new CollabServiceError('NOT_FOUND', `User '${parsed.data.targetUserId}' not found.`);
    }
    if (targetUser.status !== 'ACTIVE') {
      throw new CollabServiceError('BAD_REQUEST', 'Target user account is not active.');
    }

    if (this.isUserBanned(roomId, targetUser.id)) {
      throw new CollabServiceError(
        'CONFLICT',
        'Target user is banned from this room. Unban them before sending an invite.',
      );
    }

    if (this.getMemberRole(roomId, targetUser.id) !== null) {
      throw new CollabServiceError('CONFLICT', 'User is already a member of this room.');
    }

    const existingPending = this.serverDb.db
      .prepare(
        `SELECT id FROM invites
         WHERE room_id = ? AND target_user_id = ? AND kind = 'direct' AND status = 'PENDING'`,
      )
      .get(roomId, targetUser.id) as { id: string } | undefined;

    if (existingPending) {
      throw new CollabServiceError(
        'CONFLICT',
        'A pending direct invite already exists for this user.',
      );
    }

    const inviteId = `inv_${randomUUID()}`;
    const nowIso = this.now().toISOString();

    this.serverDb.transaction(() => {
      this.serverDb.db
        .prepare(
          `INSERT INTO invites (
            id, room_id, kind, target_user_id, code, role, created_by, status, uses, max_uses, expires_at, created_at
          ) VALUES (?, ?, 'direct', ?, NULL, ?, ?, 'PENDING', 0, 1, NULL, ?)`,
        )
        .run(inviteId, roomId, targetUser.id, parsed.data.role, actor.id, nowIso);

      this.serverDb.appendAuditLog({
        roomId,
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'member:invite-user',
        targetId: targetUser.id,
        details: {
          inviteId,
          targetUsername: targetUser.username,
          role: parsed.data.role,
        },
        createdAt: nowIso,
      });
    });

    return this.requireDirectInviteSummary(inviteId);
  }

  respondToInvite(
    actor: UserProfile,
    inviteId: string,
    input: unknown,
  ): { accepted: boolean; roomId?: string; role?: RoomRole } {
    const payload = typeof input === 'boolean' ? { accept: input } : input;
    const parsed = respondInviteRequestSchema.safeParse(payload);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid invite response payload.',
      );
    }

    const inviteRow = this.serverDb.db
      .prepare("SELECT * FROM invites WHERE id = ? AND kind = 'direct'")
      .get(inviteId) as InviteRow | undefined;

    if (!inviteRow) {
      throw new CollabServiceError('NOT_FOUND', `Direct invite '${inviteId}' not found.`);
    }

    const isBanned = this.isUserBanned(inviteRow.room_id, actor.id);
    const currentRole = this.getMemberRole(inviteRow.room_id, actor.id);

    if (inviteRow.target_user_id !== actor.id) {
      throw new CollabServiceError('FORBIDDEN', 'This invite belongs to another user.');
    }

    if (isBanned) {
      throw new CollabServiceError('FORBIDDEN', 'You are banned from this room.');
    }

    if (inviteRow.status !== 'PENDING') {
      throw new CollabServiceError(
        'BAD_REQUEST',
        `Invite is no longer pending (status: ${inviteRow.status}).`,
      );
    }

    if (currentRole !== null) {
      throw new CollabServiceError('CONFLICT', 'You are already a member of this room.');
    }

    if (
      !canRoomAction(currentRole, 'room:accept-direct-invite', {
        isInvitee: true,
        isBanned: false,
      })
    ) {
      throw new CollabServiceError('FORBIDDEN', 'Not permitted to respond to this invite.');
    }

    const nowIso = this.now().toISOString();
    if (!parsed.data.accept) {
      this.serverDb.transaction(() => {
        this.serverDb.db
          .prepare("UPDATE invites SET status = 'DECLINED' WHERE id = ?")
          .run(inviteId);

        this.serverDb.appendAuditLog({
          roomId: inviteRow.room_id,
          actorId: actor.id,
          actorName: actor.displayName,
          action: 'room:decline-direct-invite',
          targetId: inviteId,
          details: { inviteId },
          createdAt: nowIso,
        });
      });
      return { accepted: false };
    }

    this.serverDb.transaction(() => {
      this.serverDb.db
        .prepare("UPDATE invites SET status = 'ACCEPTED', uses = uses + 1 WHERE id = ?")
        .run(inviteId);

      this.serverDb.db
        .prepare(
          `UPDATE join_requests
           SET status = 'APPROVED', assigned_role = ?, reviewed_by = ?, reviewed_at = ?
           WHERE room_id = ? AND user_id = ? AND status = 'PENDING'`,
        )
        .run(inviteRow.role, inviteRow.created_by, nowIso, inviteRow.room_id, actor.id);

      this.serverDb.db
        .prepare(
          `INSERT INTO room_members (room_id, user_id, role, joined_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(inviteRow.room_id, actor.id, inviteRow.role, nowIso);

      this.serverDb.db
        .prepare('UPDATE rooms SET updated_at = ? WHERE id = ?')
        .run(nowIso, inviteRow.room_id);

      this.serverDb.appendAuditLog({
        roomId: inviteRow.room_id,
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'room:accept-direct-invite',
        targetId: actor.id,
        details: { inviteId, role: inviteRow.role },
        createdAt: nowIso,
      });
    });

    this.emitEvent({
      type: 'member-joined',
      roomId: inviteRow.room_id,
      userId: actor.id,
      role: inviteRow.role,
    });

    return {
      accepted: true,
      roomId: inviteRow.room_id,
      role: inviteRow.role,
    };
  }

  createInviteCode(actor: UserProfile, roomId: string, input: unknown): InviteCodeInfo {
    this.requireRoomRow(roomId);
    const parsed = createInviteCodeRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid invite code payload.',
      );
    }

    const actorRole = this.getMemberRole(roomId, actor.id);
    if (
      !canRoomAction(actorRole, 'member:create-invite-code', {
        assignedRole: parsed.data.role,
        isBanned: this.isUserBanned(roomId, actor.id),
      })
    ) {
      throw new CollabServiceError('FORBIDDEN', 'Only room admins can create invite codes.');
    }

    const inviteId = `inv_${randomUUID()}`;
    const code = generateInviteCodeString();
    const now = this.now();
    const nowIso = now.toISOString();
    const expiresAt =
      parsed.data.expiresInSeconds !== undefined
        ? new Date(now.getTime() + parsed.data.expiresInSeconds * 1000).toISOString()
        : null;
    const maxUses = parsed.data.maxUses ?? null;

    this.serverDb.transaction(() => {
      this.serverDb.db
        .prepare(
          `INSERT INTO invites (
            id, room_id, kind, target_user_id, code, role, created_by, status, uses, max_uses, expires_at, created_at
          ) VALUES (?, ?, 'code', NULL, ?, ?, ?, 'PENDING', 0, ?, ?, ?)`,
        )
        .run(inviteId, roomId, code, parsed.data.role, actor.id, maxUses, expiresAt, nowIso);

      this.serverDb.appendAuditLog({
        roomId,
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'member:create-invite-code',
        targetId: inviteId,
        details: {
          code,
          role: parsed.data.role,
          maxUses,
          expiresAt,
        },
        createdAt: nowIso,
      });
    });

    const created = this.serverDb.db
      .prepare('SELECT * FROM invites WHERE id = ?')
      .get(inviteId) as InviteRow;
    return this.mapInviteCodeRow(created);
  }

  redeemInviteCode(
    actor: UserProfile,
    input: unknown,
  ): { room: RoomSummary; role: RoomRole } {
    const payload = typeof input === 'string' ? { code: input } : input;
    const parsed = redeemInviteCodeRequestSchema.safeParse(payload);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid invite code redemption payload.',
      );
    }

    const code = parsed.data.code.trim();
    const inviteRow = this.serverDb.db
      .prepare("SELECT * FROM invites WHERE code = ? AND kind = 'code'")
      .get(code) as InviteRow | undefined;

    if (!inviteRow) {
      throw new CollabServiceError('NOT_FOUND', 'Invite code not found.');
    }

    this.requireRoomRow(inviteRow.room_id);

    const isBanned = this.isUserBanned(inviteRow.room_id, actor.id);
    if (isBanned) {
      throw new CollabServiceError('FORBIDDEN', 'You are banned from this room.');
    }

    if (inviteRow.status !== 'PENDING') {
      throw new CollabServiceError('BAD_REQUEST', 'Invite code has been revoked or is inactive.');
    }

    if (inviteRow.expires_at !== null) {
      const expiresMs = new Date(inviteRow.expires_at).getTime();
      if (Number.isNaN(expiresMs) || expiresMs <= this.now().getTime()) {
        throw new CollabServiceError('BAD_REQUEST', 'Invite code has expired.');
      }
    }

    if (inviteRow.max_uses !== null && inviteRow.uses >= inviteRow.max_uses) {
      throw new CollabServiceError('BAD_REQUEST', 'Invite code has reached its maximum uses.');
    }

    const currentRole = this.getMemberRole(inviteRow.room_id, actor.id);
    if (currentRole !== null) {
      throw new CollabServiceError('CONFLICT', 'You are already a member of this room.');
    }

    if (!canRoomAction(currentRole, 'room:redeem-invite-code', { isBanned: false })) {
      throw new CollabServiceError('FORBIDDEN', 'Not permitted to redeem this invite code.');
    }

    const nowIso = this.now().toISOString();
    this.serverDb.transaction(() => {
      this.serverDb.db
        .prepare('UPDATE invites SET uses = uses + 1 WHERE id = ?')
        .run(inviteRow.id);

      this.serverDb.db
        .prepare(
          `UPDATE invites
           SET status = 'ACCEPTED', uses = uses + 1
           WHERE room_id = ? AND target_user_id = ? AND kind = 'direct' AND status = 'PENDING'`,
        )
        .run(inviteRow.room_id, actor.id);

      this.serverDb.db
        .prepare(
          `UPDATE join_requests
           SET status = 'APPROVED', assigned_role = ?, reviewed_by = ?, reviewed_at = ?
           WHERE room_id = ? AND user_id = ? AND status = 'PENDING'`,
        )
        .run(inviteRow.role, inviteRow.created_by, nowIso, inviteRow.room_id, actor.id);

      this.serverDb.db
        .prepare(
          `INSERT INTO room_members (room_id, user_id, role, joined_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(inviteRow.room_id, actor.id, inviteRow.role, nowIso);

      this.serverDb.db
        .prepare('UPDATE rooms SET updated_at = ? WHERE id = ?')
        .run(nowIso, inviteRow.room_id);

      this.serverDb.appendAuditLog({
        roomId: inviteRow.room_id,
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'room:redeem-invite-code',
        targetId: actor.id,
        details: {
          inviteId: inviteRow.id,
          code: inviteRow.code,
          role: inviteRow.role,
        },
        createdAt: nowIso,
      });
    });

    this.emitEvent({
      type: 'member-joined',
      roomId: inviteRow.room_id,
      userId: actor.id,
      role: inviteRow.role,
    });

    return {
      room: this.getRoomSummary(inviteRow.room_id, actor.id),
      role: inviteRow.role,
    };
  }

  revokeInvite(actor: UserProfile, roomId: string, inviteId: string): { revoked: true } {
    this.requireRoomRow(roomId);
    const actorRole = this.getMemberRole(roomId, actor.id);
    if (
      !canRoomAction(actorRole, 'member:revoke-invite', {
        isBanned: this.isUserBanned(roomId, actor.id),
      })
    ) {
      throw new CollabServiceError('FORBIDDEN', 'Only room admins can revoke invites.');
    }

    const inviteRow = this.serverDb.db
      .prepare('SELECT * FROM invites WHERE id = ? AND room_id = ?')
      .get(inviteId, roomId) as InviteRow | undefined;

    if (!inviteRow) {
      throw new CollabServiceError('NOT_FOUND', `Invite '${inviteId}' not found in this room.`);
    }

    const nowIso = this.now().toISOString();
    this.serverDb.transaction(() => {
      this.serverDb.db
        .prepare("UPDATE invites SET status = 'REVOKED' WHERE id = ?")
        .run(inviteId);

      this.serverDb.appendAuditLog({
        roomId,
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'member:revoke-invite',
        targetId: inviteId,
        details: { kind: inviteRow.kind, role: inviteRow.role },
        createdAt: nowIso,
      });
    });

    return { revoked: true };
  }

  createJoinRequest(
    actor: UserProfile,
    roomId: string,
    input: unknown = {},
  ): JoinRequestSummary {
    const roomRow = this.requireRoomRow(roomId);
    const parsed = createJoinRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid join request payload.',
      );
    }

    if (this.isUserBanned(roomId, actor.id)) {
      throw new CollabServiceError('FORBIDDEN', 'You are banned from this room.');
    }

    const currentRole = this.getMemberRole(roomId, actor.id);
    if (currentRole !== null) {
      throw new CollabServiceError('CONFLICT', 'You are already a member of this room.');
    }

    if (
      !canRoomAction(currentRole, 'room:request-join', {
        visibility: roomRow.visibility,
        isBanned: false,
      })
    ) {
      throw new CollabServiceError(
        'FORBIDDEN',
        'Join requests can only be submitted to listed rooms.',
      );
    }

    const existingPending = this.serverDb.db
      .prepare(
        `SELECT id FROM join_requests
         WHERE room_id = ? AND user_id = ? AND status = 'PENDING'`,
      )
      .get(roomId, actor.id) as { id: string } | undefined;

    if (existingPending) {
      throw new CollabServiceError(
        'CONFLICT',
        'You already have a pending join request for this room.',
      );
    }

    const requestId = `jreq_${randomUUID()}`;
    const message = parsed.data.message?.trim() ?? '';
    const nowIso = this.now().toISOString();

    this.serverDb.transaction(() => {
      this.serverDb.db
        .prepare(
          `INSERT INTO join_requests (
            id, room_id, user_id, message, status, assigned_role, reviewed_by, created_at, reviewed_at
          ) VALUES (?, ?, ?, ?, 'PENDING', NULL, NULL, ?, NULL)`,
        )
        .run(requestId, roomId, actor.id, message, nowIso);

      this.serverDb.appendAuditLog({
        roomId,
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'room:request-join',
        targetId: requestId,
        details: { message },
        createdAt: nowIso,
      });
    });

    const summary = this.requireJoinRequestSummary(requestId);
    this.emitEvent({
      type: 'join-request-created',
      roomId,
      joinRequest: summary,
    });
    return summary;
  }

  reviewJoinRequest(
    actor: UserProfile,
    roomId: string,
    requestId: string,
    input: unknown,
  ): JoinRequestSummary {
    this.requireRoomRow(roomId);
    const parsed = reviewJoinRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid join request review payload.',
      );
    }

    const actorRole = this.getMemberRole(roomId, actor.id);
    const assignedRole: BelowAdminRoomRole = parsed.data.role ?? 'VIEWER';
    if (
      !canRoomAction(actorRole, 'member:review-join-request', {
        assignedRole,
        isBanned: this.isUserBanned(roomId, actor.id),
      })
    ) {
      throw new CollabServiceError('FORBIDDEN', 'Only room admins can review join requests.');
    }

    const reqRow = this.serverDb.db
      .prepare('SELECT * FROM join_requests WHERE id = ? AND room_id = ?')
      .get(requestId, roomId) as JoinRequestRow | undefined;

    if (!reqRow) {
      throw new CollabServiceError(
        'NOT_FOUND',
        `Join request '${requestId}' not found in this room.`,
      );
    }

    if (reqRow.status !== 'PENDING') {
      throw new CollabServiceError(
        'BAD_REQUEST',
        `Join request has already been ${reqRow.status.toLowerCase()}.`,
      );
    }

    if (parsed.data.approve && this.isUserBanned(roomId, reqRow.user_id)) {
      throw new CollabServiceError('BAD_REQUEST', 'Cannot approve a banned user.');
    }

    const nowIso = this.now().toISOString();
    this.serverDb.transaction(() => {
      if (parsed.data.approve) {
        this.serverDb.db
          .prepare(
            `UPDATE join_requests
             SET status = 'APPROVED', assigned_role = ?, reviewed_by = ?, reviewed_at = ?
             WHERE id = ?`,
          )
          .run(assignedRole, actor.id, nowIso, requestId);

        this.serverDb.db
          .prepare(
            `UPDATE invites
             SET status = 'ACCEPTED', uses = uses + 1
             WHERE room_id = ? AND target_user_id = ? AND kind = 'direct' AND status = 'PENDING'`,
          )
          .run(roomId, reqRow.user_id);

        if (this.getMemberRole(roomId, reqRow.user_id) === null) {
          this.serverDb.db
            .prepare(
              `INSERT INTO room_members (room_id, user_id, role, joined_at)
               VALUES (?, ?, ?, ?)`,
            )
            .run(roomId, reqRow.user_id, assignedRole, nowIso);
        }

        this.serverDb.db
          .prepare('UPDATE rooms SET updated_at = ? WHERE id = ?')
          .run(nowIso, roomId);

        this.serverDb.appendAuditLog({
          roomId,
          actorId: actor.id,
          actorName: actor.displayName,
          action: 'member:review-join-request',
          targetId: reqRow.user_id,
          details: {
            requestId,
            approved: true,
            assignedRole,
          },
          createdAt: nowIso,
        });
      } else {
        this.serverDb.db
          .prepare(
            `UPDATE join_requests
             SET status = 'REJECTED', assigned_role = NULL, reviewed_by = ?, reviewed_at = ?
             WHERE id = ?`,
          )
          .run(actor.id, nowIso, requestId);

        this.serverDb.appendAuditLog({
          roomId,
          actorId: actor.id,
          actorName: actor.displayName,
          action: 'member:review-join-request',
          targetId: reqRow.user_id,
          details: {
            requestId,
            approved: false,
          },
          createdAt: nowIso,
        });
      }
    });

    const summary = this.requireJoinRequestSummary(requestId);
    this.emitEvent({
      type: 'join-request-reviewed',
      roomId,
      joinRequest: summary,
    });
    if (parsed.data.approve) {
      this.emitEvent({
        type: 'member-joined',
        roomId,
        userId: reqRow.user_id,
        role: assignedRole,
      });
    }
    return summary;
  }

  changeMemberRole(
    actor: UserProfile,
    roomId: string,
    targetUserId: string,
    input: unknown,
  ): RoomMemberInfo {
    this.requireRoomRow(roomId);
    const payload = typeof input === 'string' ? { role: input } : input;
    const parsed = updateRoomMemberRoleRequestSchema.safeParse(payload);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid member role update payload.',
      );
    }

    const actorRole = this.getMemberRole(roomId, actor.id);
    if (actorRole === null) {
      throw new CollabServiceError('FORBIDDEN', 'You are not a member of this room.');
    }

    const targetMember = this.serverDb.db
      .prepare('SELECT * FROM room_members WHERE room_id = ? AND user_id = ?')
      .get(roomId, targetUserId) as RoomMemberRow | undefined;

    if (!targetMember) {
      throw new CollabServiceError('NOT_FOUND', 'Member not found in this room.');
    }

    const assignedRole: AssignableRoomRole = parsed.data.role;
    const action: RoomAction =
      targetMember.role === 'ROOM_ADMIN' || assignedRole === 'ROOM_ADMIN'
        ? 'member:promote-demote-admin'
        : 'member:change-role-below-admin';

    if (
      !canRoomAction(actorRole, action, {
        targetRoomRole: targetMember.role,
        assignedRole,
        isBanned: this.isUserBanned(roomId, actor.id),
      })
    ) {
      throw new CollabServiceError(
        'FORBIDDEN',
        `Role '${actorRole}' cannot change member from '${targetMember.role}' to '${assignedRole}'.`,
      );
    }

    const nowIso = this.now().toISOString();
    this.serverDb.transaction(() => {
      this.serverDb.db
        .prepare('UPDATE room_members SET role = ? WHERE room_id = ? AND user_id = ?')
        .run(assignedRole, roomId, targetUserId);

      this.serverDb.db
        .prepare('UPDATE rooms SET updated_at = ? WHERE id = ?')
        .run(nowIso, roomId);

      this.serverDb.appendAuditLog({
        roomId,
        actorId: actor.id,
        actorName: actor.displayName,
        action,
        targetId: targetUserId,
        details: {
          previousRole: targetMember.role,
          newRole: assignedRole,
        },
        createdAt: nowIso,
      });
    });

    this.emitEvent({
      type: 'role-changed',
      roomId,
      userId: targetUserId,
      previousRole: targetMember.role,
      newRole: assignedRole,
    });

    return this.requireRoomMemberInfo(roomId, targetUserId);
  }

  kickMember(
    actor: UserProfile,
    roomId: string,
    targetUserId: string,
    input: unknown = {},
  ): { kicked: true } {
    this.requireRoomRow(roomId);
    const parsed = kickOrBanMemberRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid kick payload.',
      );
    }

    if (targetUserId === actor.id) {
      throw new CollabServiceError('FORBIDDEN', 'You cannot kick yourself from the room.');
    }

    const actorRole = this.getMemberRole(roomId, actor.id);
    const targetMember = this.serverDb.db
      .prepare('SELECT * FROM room_members WHERE room_id = ? AND user_id = ?')
      .get(roomId, targetUserId) as RoomMemberRow | undefined;

    if (!targetMember) {
      throw new CollabServiceError('NOT_FOUND', 'Member not found in this room.');
    }

    if (
      !canRoomAction(actorRole, 'member:kick-ban', {
        targetRoomRole: targetMember.role,
        isBanned: this.isUserBanned(roomId, actor.id),
      })
    ) {
      throw new CollabServiceError(
        'FORBIDDEN',
        `Role '${actorRole ?? 'NONE'}' cannot kick a '${targetMember.role}' member.`,
      );
    }

    const reason = parsed.data.reason?.trim() ?? '';
    const nowIso = this.now().toISOString();

    this.serverDb.transaction(() => {
      this.serverDb.db
        .prepare('DELETE FROM room_members WHERE room_id = ? AND user_id = ?')
        .run(roomId, targetUserId);

      this.serverDb.db
        .prepare('UPDATE rooms SET updated_at = ? WHERE id = ?')
        .run(nowIso, roomId);

      this.serverDb.appendAuditLog({
        roomId,
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'member:kick-ban',
        targetId: targetUserId,
        details: {
          subAction: 'kick',
          previousRole: targetMember.role,
          reason,
        },
        createdAt: nowIso,
      });
    });

    this.emitEvent({
      type: 'member-kicked',
      roomId,
      userId: targetUserId,
      reason: reason || 'You were removed from the room.',
    });

    return { kicked: true };
  }

  banMember(
    actor: UserProfile,
    roomId: string,
    targetUserId: string,
    input: unknown = {},
  ): { banned: true } {
    const roomRow = this.requireRoomRow(roomId);
    const parsed = kickOrBanMemberRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid ban payload.',
      );
    }

    if (targetUserId === actor.id) {
      throw new CollabServiceError('FORBIDDEN', 'You cannot ban yourself from the room.');
    }

    const targetUser = this.findUserRow(targetUserId);
    if (!targetUser) {
      throw new CollabServiceError('NOT_FOUND', `User '${targetUserId}' not found.`);
    }

    const actorRole = this.getMemberRole(roomId, actor.id);
    const existingMemberRole = this.getMemberRole(roomId, targetUserId);
    const effectiveTargetRole: RoomRole =
      existingMemberRole ?? (roomRow.owner_id === targetUserId ? 'ROOM_OWNER' : 'VIEWER');

    if (
      !canRoomAction(actorRole, 'member:kick-ban', {
        targetRoomRole: effectiveTargetRole,
        isBanned: this.isUserBanned(roomId, actor.id),
      })
    ) {
      throw new CollabServiceError(
        'FORBIDDEN',
        `Role '${actorRole ?? 'NONE'}' cannot ban a '${effectiveTargetRole}' user.`,
      );
    }

    const reason = parsed.data.reason?.trim() ?? '';
    const nowIso = this.now().toISOString();

    this.serverDb.transaction(() => {
      this.serverDb.db
        .prepare('DELETE FROM room_members WHERE room_id = ? AND user_id = ?')
        .run(roomId, targetUserId);

      this.serverDb.db
        .prepare(
          `UPDATE invites
           SET status = 'REVOKED'
           WHERE room_id = ? AND target_user_id = ? AND kind = 'direct' AND status = 'PENDING'`,
        )
        .run(roomId, targetUserId);

      this.serverDb.db
        .prepare(
          `UPDATE join_requests
           SET status = 'REJECTED', reviewed_by = ?, reviewed_at = ?
           WHERE room_id = ? AND user_id = ? AND status = 'PENDING'`,
        )
        .run(actor.id, nowIso, roomId, targetUserId);

      this.serverDb.db
        .prepare(
          `INSERT OR REPLACE INTO room_bans (room_id, user_id, banned_by, reason, banned_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(roomId, targetUserId, actor.id, reason, nowIso);

      this.serverDb.db
        .prepare('UPDATE rooms SET updated_at = ? WHERE id = ?')
        .run(nowIso, roomId);

      this.serverDb.appendAuditLog({
        roomId,
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'member:kick-ban',
        targetId: targetUserId,
        details: {
          subAction: 'ban',
          previousRole: existingMemberRole,
          reason,
        },
        createdAt: nowIso,
      });
    });

    this.emitEvent({
      type: 'member-banned',
      roomId,
      userId: targetUserId,
      reason: reason || 'You were banned from the room.',
    });

    return { banned: true };
  }

  unbanMember(actor: UserProfile, roomId: string, targetUserId: string): { unbanned: true } {
    this.requireRoomRow(roomId);
    const actorRole = this.getMemberRole(roomId, actor.id);
    if (
      !canRoomAction(actorRole, 'member:kick-ban', {
        targetRoomRole: 'VIEWER',
        isBanned: this.isUserBanned(roomId, actor.id),
      })
    ) {
      throw new CollabServiceError('FORBIDDEN', 'Only room admins can unban users.');
    }

    const banRow = this.serverDb.db
      .prepare('SELECT * FROM room_bans WHERE room_id = ? AND user_id = ?')
      .get(roomId, targetUserId) as RoomBanRow | undefined;

    if (!banRow) {
      throw new CollabServiceError('NOT_FOUND', 'User is not banned from this room.');
    }

    const nowIso = this.now().toISOString();
    this.serverDb.transaction(() => {
      this.serverDb.db
        .prepare('DELETE FROM room_bans WHERE room_id = ? AND user_id = ?')
        .run(roomId, targetUserId);

      this.serverDb.appendAuditLog({
        roomId,
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'member:kick-ban',
        targetId: targetUserId,
        details: { subAction: 'unban' },
        createdAt: nowIso,
      });
    });

    return { unbanned: true };
  }

  listRoomAuditLog(actor: UserProfile, roomId: string, limit = 100): AuditEntry[] {
    this.requireRoomRow(roomId);
    const actorRole = this.getMemberRole(roomId, actor.id);
    const canViewRoom = canRoomAction(actorRole, 'room:view-audit', {
      isBanned: this.isUserBanned(roomId, actor.id),
    });
    const canViewServer = canServerAction(actor.serverRole, 'audit:view-server');

    if (!canViewRoom && !canViewServer) {
      throw new CollabServiceError('FORBIDDEN', 'Only room admins can view the room audit log.');
    }

    return this.serverDb.listAuditLog({ roomId, limit });
  }

  async exportRoom(
    actor: UserProfile,
    roomId: string,
    query: unknown,
  ): Promise<RoomExportResult> {
    this.requireRoomRow(roomId);
    const actorRole = this.getMemberRole(roomId, actor.id);
    const isServerAdmin =
      actor.serverRole === 'SERVER_ADMIN' || actor.serverRole === 'SERVER_OWNER';

    if (
      !canRoomAction(actorRole, 'room:export', {
        isBanned: this.isUserBanned(roomId, actor.id),
      }) &&
      !isServerAdmin
    ) {
      throw new CollabServiceError('FORBIDDEN', 'Only room members can export room data.');
    }

    const parsed = roomExportQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid export query parameters.',
      );
    }

    const workspace = await this.loadRoomWorkspace(roomId);
    if (parsed.data.format === 'json') {
      return {
        format: 'json',
        content: workspace,
      };
    }

    try {
      const content = exportWorkspace(workspace, {
        format: parsed.data.format,
        objectType: parsed.data.objectType,
        functionId: parsed.data.functionId,
      });
      return {
        format: parsed.data.format,
        content,
      };
    } catch (error) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        error instanceof Error ? error.message : 'Export failed.',
      );
    }
  }

  listAllRoomsAdmin(actor: UserProfile): RoomSummary[] {
    if (!canServerAction(actor.serverRole, 'rooms:list-all-admin')) {
      throw new CollabServiceError('FORBIDDEN', 'Only server admins can list all rooms.');
    }

    const rows = this.serverDb.db
      .prepare('SELECT * FROM rooms ORDER BY updated_at DESC, created_at DESC')
      .all() as RoomRow[];

    return rows.map(row => this.mapRoomRowToSummary(row, actor.id));
  }

  resolveStuckRoom(actor: UserProfile, roomId: string, input: unknown): RoomSummary {
    if (!canServerAction(actor.serverRole, 'rooms:resolve-stuck')) {
      throw new CollabServiceError('FORBIDDEN', 'Only server admins can resolve stuck rooms.');
    }

    const roomRow = this.requireRoomRow(roomId);
    const parsed = adminResolveRoomRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid room resolution payload.',
      );
    }

    const targetUser = this.findUserRow(parsed.data.userId);
    if (!targetUser) {
      throw new CollabServiceError('NOT_FOUND', `User '${parsed.data.userId}' not found.`);
    }
    if (targetUser.status !== 'ACTIVE') {
      throw new CollabServiceError('BAD_REQUEST', 'Target user account is not active.');
    }

    const assignedRole = parsed.data.role;
    if (assignedRole === 'ROOM_ADMIN' && roomRow.owner_id === targetUser.id) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        'Cannot demote the current room owner without assigning a new ROOM_OWNER.',
      );
    }

    const previousRole = this.getMemberRole(roomId, targetUser.id);
    const nowIso = this.now().toISOString();

    this.serverDb.transaction(() => {
      this.serverDb.db
        .prepare('DELETE FROM room_bans WHERE room_id = ? AND user_id = ?')
        .run(roomId, targetUser.id);

      if (assignedRole === 'ROOM_OWNER') {
        if (roomRow.owner_id !== targetUser.id) {
          this.serverDb.db
            .prepare(
              "UPDATE room_members SET role = 'ROOM_ADMIN' WHERE room_id = ? AND user_id = ?",
            )
            .run(roomId, roomRow.owner_id);
        }

        this.serverDb.db
          .prepare('UPDATE rooms SET owner_id = ?, updated_at = ? WHERE id = ?')
          .run(targetUser.id, nowIso, roomId);
      } else {
        this.serverDb.db
          .prepare('UPDATE rooms SET updated_at = ? WHERE id = ?')
          .run(nowIso, roomId);
      }

      if (previousRole === null) {
        this.serverDb.db
          .prepare(
            `INSERT INTO room_members (room_id, user_id, role, joined_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(roomId, targetUser.id, assignedRole, nowIso);
      } else {
        this.serverDb.db
          .prepare('UPDATE room_members SET role = ? WHERE room_id = ? AND user_id = ?')
          .run(assignedRole, roomId, targetUser.id);
      }

      this.serverDb.appendAuditLog({
        roomId,
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'rooms:resolve-stuck',
        targetId: targetUser.id,
        details: {
          previousOwnerId: roomRow.owner_id,
          previousRole,
          assignedRole,
        },
        createdAt: nowIso,
      });
    });

    if (assignedRole === 'ROOM_OWNER' && roomRow.owner_id !== targetUser.id) {
      this.emitEvent({
        type: 'ownership-transferred',
        roomId,
        previousOwnerId: roomRow.owner_id,
        newOwnerId: targetUser.id,
      });
    } else if (previousRole !== null && previousRole !== assignedRole) {
      this.emitEvent({
        type: 'role-changed',
        roomId,
        userId: targetUser.id,
        previousRole,
        newRole: assignedRole,
      });
    } else if (previousRole === null) {
      this.emitEvent({
        type: 'member-joined',
        roomId,
        userId: targetUser.id,
        role: assignedRole,
      });
    }

    return this.getRoomSummary(roomId, actor.id);
  }

  getRoomSummary(roomId: string, viewerUserId?: string | null): RoomSummary {
    const row = this.requireRoomRow(roomId);
    return this.mapRoomRowToSummary(row, viewerUserId ?? null);
  }

  getMemberRole(roomId: string, userId: string): RoomRole | null {
    const row = this.serverDb.db
      .prepare('SELECT role FROM room_members WHERE room_id = ? AND user_id = ?')
      .get(roomId, userId) as { role: RoomRole } | undefined;
    return row?.role ?? null;
  }

  isUserBanned(roomId: string, userId: string): boolean {
    const row = this.serverDb.db
      .prepare('SELECT 1 FROM room_bans WHERE room_id = ? AND user_id = ?')
      .get(roomId, userId);
    return Boolean(row);
  }

  listRoomMembers(roomId: string): RoomMemberInfo[] {
    this.requireRoomRow(roomId);
    const rows = this.serverDb.db
      .prepare(
        `SELECT rm.room_id, rm.user_id, rm.role, rm.joined_at, u.username, u.display_name
         FROM room_members rm
         INNER JOIN users u ON u.id = rm.user_id
         WHERE rm.room_id = ?
         ORDER BY rm.joined_at ASC, u.username ASC`,
      )
      .all(roomId) as Array<{
      room_id: string;
      user_id: string;
      role: RoomRole;
      joined_at: string;
      username: string;
      display_name: string;
    }>;

    const onlineSet = this.getOnlineSet(roomId);
    return rows.map(row => ({
      roomId: row.room_id,
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      joinedAt: row.joined_at,
      online: onlineSet ? onlineSet.has(row.user_id) : false,
      color: assignUserColor(row.user_id),
    }));
  }

  listRoomInvites(roomId: string): InviteInfo[] {
    this.requireRoomRow(roomId);
    const rows = this.serverDb.db
      .prepare('SELECT * FROM invites WHERE room_id = ? ORDER BY created_at DESC')
      .all(roomId) as InviteRow[];

    return rows.map(row =>
      row.kind === 'direct' ? this.mapDirectInviteRow(row) : this.mapInviteCodeRow(row),
    );
  }

  listRoomJoinRequests(roomId: string): JoinRequestSummary[] {
    this.requireRoomRow(roomId);
    const rows = this.serverDb.db
      .prepare('SELECT * FROM join_requests WHERE room_id = ? ORDER BY created_at DESC')
      .all(roomId) as JoinRequestRow[];

    return rows.map(row => this.mapJoinRequestRow(row));
  }

  listRoomBans(roomId: string): RoomBanInfo[] {
    this.requireRoomRow(roomId);
    const rows = this.serverDb.db
      .prepare(
        `SELECT b.room_id, b.user_id, b.banned_by, b.reason, b.banned_at, u.username, u.display_name
         FROM room_bans b
         INNER JOIN users u ON u.id = b.user_id
         WHERE b.room_id = ?
         ORDER BY b.banned_at DESC`,
      )
      .all(roomId) as Array<{
      room_id: string;
      user_id: string;
      banned_by: string;
      reason: string;
      banned_at: string;
      username: string;
      display_name: string;
    }>;

    return rows.map(row => ({
      roomId: row.room_id,
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name,
      bannedBy: row.banned_by,
      reason: row.reason,
      bannedAt: row.banned_at,
    }));
  }

  private getOnlineSet(roomId: string): Set<string> | null {
    if (!this.getOnlineUserIds) return null;
    const raw = this.getOnlineUserIds(roomId);
    return raw instanceof Set ? raw : new Set(raw);
  }

  private getRoomMemberCount(roomId: string): number {
    const row = this.serverDb.db
      .prepare('SELECT COUNT(*) AS count FROM room_members WHERE room_id = ?')
      .get(roomId) as { count: number };
    return row.count;
  }

  private mapRoomRowToSummary(row: RoomRow, viewerUserId: string | null): RoomSummary {
    const ownerRow = this.findUserRow(row.owner_id);
    const myRole = viewerUserId ? this.getMemberRole(row.id, viewerUserId) : null;
    const memberCount = this.getRoomMemberCount(row.id);
    const onlineSet = this.getOnlineSet(row.id);

    return {
      id: row.id,
      name: row.name,
      visibility: row.visibility,
      ownerId: row.owner_id,
      ownerDisplayName: ownerRow?.display_name ?? row.owner_id,
      projectId: row.project_id,
      projectName: row.project_name,
      myRole,
      memberCount,
      onlineCount: onlineSet ? onlineSet.size : 0,
      lastAutosavedAt: row.last_autosaved_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapDirectInviteRow(row: InviteRow): DirectInviteSummary {
    const roomRow = this.requireRoomRow(row.room_id);
    const targetId = row.target_user_id ?? '';
    const targetUser = this.findUserRow(targetId);
    const creatorUser = this.findUserRow(row.created_by);

    return {
      id: row.id,
      roomId: row.room_id,
      roomName: roomRow.name,
      kind: 'direct',
      targetUserId: targetId,
      targetUsername: targetUser?.username ?? targetId,
      targetDisplayName: targetUser?.display_name ?? targetId,
      role: row.role as AssignableRoomRole,
      createdBy: row.created_by,
      createdByDisplayName: creatorUser?.display_name ?? row.created_by,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  private mapInviteCodeRow(row: InviteRow): InviteCodeInfo {
    return {
      id: row.id,
      roomId: row.room_id,
      kind: 'code',
      code: row.code ?? '',
      role: row.role as BelowAdminRoomRole,
      createdBy: row.created_by,
      status: row.status,
      uses: row.uses,
      maxUses: row.max_uses,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }

  private mapJoinRequestRow(row: JoinRequestRow): JoinRequestSummary {
    const roomRow = this.requireRoomRow(row.room_id);
    const userRow = this.findUserRow(row.user_id);

    return {
      id: row.id,
      roomId: row.room_id,
      roomName: roomRow.name,
      userId: row.user_id,
      username: userRow?.username ?? row.user_id,
      displayName: userRow?.display_name ?? row.user_id,
      message: row.message,
      status: row.status,
      assignedRole: row.assigned_role,
      reviewedBy: row.reviewed_by,
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at,
    };
  }

  private requireDirectInviteSummary(inviteId: string): DirectInviteSummary {
    const row = this.serverDb.db
      .prepare("SELECT * FROM invites WHERE id = ? AND kind = 'direct'")
      .get(inviteId) as InviteRow | undefined;
    if (!row) {
      throw new CollabServiceError('NOT_FOUND', `Direct invite '${inviteId}' not found.`);
    }
    return this.mapDirectInviteRow(row);
  }

  private requireJoinRequestSummary(requestId: string): JoinRequestSummary {
    const row = this.serverDb.db
      .prepare('SELECT * FROM join_requests WHERE id = ?')
      .get(requestId) as JoinRequestRow | undefined;
    if (!row) {
      throw new CollabServiceError('NOT_FOUND', `Join request '${requestId}' not found.`);
    }
    return this.mapJoinRequestRow(row);
  }

  private requireRoomMemberInfo(roomId: string, userId: string): RoomMemberInfo {
    const member = this.listRoomMembers(roomId).find(m => m.userId === userId);
    if (!member) {
      throw new CollabServiceError('NOT_FOUND', 'Member not found in this room.');
    }
    return member;
  }

  private requireRoomRow(roomId: string): RoomRow {
    const row = this.serverDb.db
      .prepare('SELECT * FROM rooms WHERE id = ?')
      .get(roomId) as RoomRow | undefined;
    if (!row) {
      throw new CollabServiceError('NOT_FOUND', `Room '${roomId}' not found.`);
    }
    return row;
  }

  private findUserRow(userId: string): UserRow | undefined {
    return this.serverDb.db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(userId) as UserRow | undefined;
  }

  private emitEvent(event: RoomLifecycleEvent): void {
    this.onRoomEvent?.(event);
  }
}
