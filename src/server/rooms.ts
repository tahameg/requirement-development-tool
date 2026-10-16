import { randomBytes, randomUUID } from 'node:crypto';
import { exportWorkspace } from '../main/services/exportService.js';
import { validateWorkspace } from '../main/services/validation.js';
import { createWorkspace } from '../main/services/workspaceFactory.js';
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
import { CollabServiceError } from './errors.js';
import {
  mapAuditLogRow,
  mapServerSettingsRow,
  type InviteRow,
  type JoinRequestRow,
  type RoomBanRow,
  type RoomMemberRow,
  type RoomRow,
  type ServerStore,
  type UserRow,
} from './store/index.js';

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
  private readonly now: () => Date;
  private getOnlineUserIds?: (roomId: string) => ReadonlySet<string> | string[];
  private getWorkspaceProvider?: (roomId: string) => Workspace | null | undefined;
  private onRoomEvent?: (event: RoomLifecycleEvent) => void;

  constructor(
    private readonly store: ServerStore,
    options: RoomServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.getOnlineUserIds = options.getOnlineUserIds;
    this.getWorkspaceProvider = options.getWorkspaceProvider;
    this.onRoomEvent = options.onRoomEvent;
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

  async loadRoomWorkspace(roomId: string): Promise<Workspace> {
    await this.requireRoomRow(roomId);
    const live = this.getWorkspaceProvider?.(roomId);
    if (live) {
      return structuredClone(live);
    }
    const snapshot = await this.store.snapshots.getLatest(roomId);
    if (!snapshot) {
      throw new CollabServiceError('NOT_FOUND', `No workspace snapshot found for room '${roomId}'.`);
    }
    return structuredClone(snapshot.workspace);
  }

  async saveRoomWorkspace(roomId: string, workspace: Workspace, seq = 0): Promise<void> {
    await this.requireRoomRow(roomId);
    await this.store.snapshots.create({
      roomId,
      seq,
      workspace,
      createdAt: this.now().toISOString(),
    });
  }

  async recordAutosave(roomId: string, autosavedAt?: string): Promise<string> {
    const timestamp = autosavedAt ?? this.now().toISOString();
    await this.store.rooms.update(roomId, {
      lastAutosavedAt: timestamp,
      updatedAt: timestamp,
    });
    return timestamp;
  }

  async createRoom(actor: UserProfile, input: unknown): Promise<RoomSummary> {
    const settingsRow = await this.store.serverSettings.get();
    const settings = settingsRow ? mapServerSettingsRow(settingsRow) : { roomCreationMode: 'all_users' as const };
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
    const nowIso = this.now().toISOString();

    await this.store.transaction(async tx => {
      await tx.rooms.create({
        id: roomId,
        name: parsed.data.name,
        visibility: parsed.data.visibility,
        ownerId: actor.id,
        projectId: workspace.config.projectId,
        projectName: workspace.config.projectName,
        headSeq: 0,
        snapshotSeq: 0,
        lastAutosavedAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      await tx.snapshots.create({
        roomId,
        seq: 0,
        workspace,
        createdAt: nowIso,
      });

      await tx.memberships.add({
        roomId,
        userId: actor.id,
        role: 'ROOM_OWNER',
        joinedAt: nowIso,
      });

      await tx.audit.append({
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

    this.emitEvent({ type: 'room-created', roomId, actorId: actor.id });
    return this.getRoomSummary(roomId, actor.id);
  }

  async listRoomsForUser(actor: UserProfile): Promise<ListRoomsForUserResult> {
    const memberRows = await this.store.rooms.listForUser(actor.id);
    const myRooms = await Promise.all(
      memberRows.map(row => this.mapRoomRowToSummary(row, actor.id)),
    );

    const listedRows = await this.store.rooms.list({ visibility: 'listed' });
    const listedRooms: ListedRoomSummary[] = [];

    for (const row of listedRows) {
      const myRole = await this.getMemberRole(row.id, actor.id);
      const isBanned = await this.isUserBanned(row.id, actor.id);
      if (
        !canRoomAction(myRole, 'room:view-listed', {
          visibility: row.visibility,
          isBanned,
          actorServerRole: actor.serverRole,
        })
      ) {
        continue;
      }

      const ownerRow = await this.findUserRow(row.owner_id);
      const memberCount = await this.getRoomMemberCount(row.id);
      const pendingReq = await this.store.joinRequests.getPendingByRoomAndUser(row.id, actor.id);

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

    const inviteRows = await this.store.invites.listPendingForUser(actor.id);
    const nonBannedInvites: InviteRow[] = [];
    for (const inv of inviteRows) {
      if (!(await this.isUserBanned(inv.room_id, actor.id))) {
        nonBannedInvites.push(inv);
      }
    }
    const myInvites = await Promise.all(
      nonBannedInvites.map(inv => this.mapDirectInviteRow(inv)),
    );

    const joinReqRows = await this.store.joinRequests.listByUser(actor.id);
    const myJoinRequests = await Promise.all(
      joinReqRows.map(req => this.mapJoinRequestRow(req)),
    );

    return {
      myRooms,
      listedRooms,
      myInvites,
      myJoinRequests,
    };
  }

  async getRoom(actor: UserProfile, roomId: string): Promise<GetRoomDetailResult> {
    const roomRow = await this.requireRoomRow(roomId);
    const myRole = await this.getMemberRole(roomId, actor.id);
    const isBanned = await this.isUserBanned(roomId, actor.id);
    const isServerAdmin =
      actor.serverRole === 'SERVER_ADMIN' || actor.serverRole === 'SERVER_OWNER';

    if (isBanned && !isServerAdmin) {
      throw new CollabServiceError('FORBIDDEN', 'You are banned from this room.');
    }

    if (myRole === null && !isServerAdmin) {
      throw new CollabServiceError('FORBIDDEN', 'You are not a member of this room.');
    }

    const room = await this.mapRoomRowToSummary(roomRow, actor.id);
    const members = await this.listRoomMembers(roomId);
    const canViewAdminLists = hasMinimumRoomRole(myRole, 'ROOM_ADMIN') || isServerAdmin;
    const invites = canViewAdminLists ? await this.listRoomInvites(roomId) : [];
    const joinRequests = canViewAdminLists ? await this.listRoomJoinRequests(roomId) : [];
    const bans = canViewAdminLists ? await this.listRoomBans(roomId) : [];
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

  async updateRoom(actor: UserProfile, roomId: string, input: unknown): Promise<RoomSummary> {
    const roomRow = await this.requireRoomRow(roomId);
    const actorRole = await this.getMemberRole(roomId, actor.id);
    const isBanned = await this.isUserBanned(roomId, actor.id);
    if (
      !canRoomAction(actorRole, 'room:edit-metadata', {
        isBanned,
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

    await this.store.transaction(async tx => {
      await tx.rooms.update(roomId, {
        name: nextName,
        visibility: nextVisibility,
        updatedAt: nowIso,
      });

      await tx.audit.append({
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

  async deleteRoom(actor: UserProfile, roomId: string): Promise<{ deleted: true }> {
    const roomRow = await this.requireRoomRow(roomId);
    const actorRole = await this.getMemberRole(roomId, actor.id);
    const isBanned = await this.isUserBanned(roomId, actor.id);
    if (
      !canRoomAction(actorRole, 'room:delete', {
        actorServerRole: actor.serverRole,
        isBanned,
      })
    ) {
      throw new CollabServiceError(
        'FORBIDDEN',
        'Only the room owner or a server administrator can delete a room.',
      );
    }

    const nowIso = this.now().toISOString();
    const auditAction = actorRole === 'ROOM_OWNER' ? 'room:delete' : 'rooms:force-delete';

    await this.store.transaction(async tx => {
      await tx.audit.append({
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
      await tx.rooms.delete(roomId);
    });

    this.emitEvent({
      type: 'room-deleted',
      roomId,
      actorId: actor.id,
      reason: `Room '${roomRow.name}' was deleted by ${actor.displayName}.`,
    });

    return { deleted: true };
  }

  async leaveRoom(actor: UserProfile, roomId: string): Promise<{ left: true }> {
    await this.requireRoomRow(roomId);
    const actorRole = await this.getMemberRole(roomId, actor.id);
    if (actorRole === null) {
      throw new CollabServiceError('FORBIDDEN', 'You are not a member of this room.');
    }

    if (actorRole === 'ROOM_OWNER') {
      throw new CollabServiceError(
        'BAD_REQUEST',
        'Room owner cannot leave the room without transferring ownership or deleting the room first.',
      );
    }

    const isBanned = await this.isUserBanned(roomId, actor.id);
    if (
      !canRoomAction(actorRole, 'room:leave', {
        isBanned,
      })
    ) {
      throw new CollabServiceError('FORBIDDEN', 'Not permitted to leave this room.');
    }

    const nowIso = this.now().toISOString();
    await this.store.transaction(async tx => {
      await tx.memberships.remove(roomId, actor.id);
      await tx.rooms.update(roomId, { updatedAt: nowIso });
      await tx.audit.append({
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

  async transferOwnership(actor: UserProfile, roomId: string, input: unknown): Promise<RoomSummary> {
    await this.requireRoomRow(roomId);
    const actorRole = await this.getMemberRole(roomId, actor.id);
    const isBanned = await this.isUserBanned(roomId, actor.id);
    if (
      !canRoomAction(actorRole, 'room:transfer-ownership', {
        isBanned,
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

    const targetUser = await this.findUserRow(newOwnerId);
    if (!targetUser) {
      throw new CollabServiceError('NOT_FOUND', `User '${newOwnerId}' not found.`);
    }

    const targetMemberRole = await this.getMemberRole(roomId, newOwnerId);
    if (targetMemberRole === null) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        'New owner must already be a member of the room.',
      );
    }

    const nowIso = this.now().toISOString();
    await this.store.transaction(async tx => {
      await tx.memberships.updateRole(roomId, actor.id, 'ROOM_ADMIN');
      await tx.memberships.updateRole(roomId, newOwnerId, 'ROOM_OWNER');
      await tx.rooms.update(roomId, { ownerId: newOwnerId, updatedAt: nowIso });
      await tx.audit.append({
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

  async createDirectInvite(actor: UserProfile, roomId: string, input: unknown): Promise<DirectInviteSummary> {
    await this.requireRoomRow(roomId);
    const parsed = createDirectInviteRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid direct invite payload.',
      );
    }

    const actorRole = await this.getMemberRole(roomId, actor.id);
    const isBanned = await this.isUserBanned(roomId, actor.id);
    if (
      !canRoomAction(actorRole, 'member:invite-user', {
        assignedRole: parsed.data.role,
        isBanned,
      })
    ) {
      throw new CollabServiceError(
        'FORBIDDEN',
        `Role '${actorRole ?? 'NONE'}' cannot invite a user with role '${parsed.data.role}'.`,
      );
    }

    const targetUser = await this.findUserRow(parsed.data.targetUserId);
    if (!targetUser) {
      throw new CollabServiceError('NOT_FOUND', `User '${parsed.data.targetUserId}' not found.`);
    }
    if (targetUser.status !== 'ACTIVE') {
      throw new CollabServiceError('BAD_REQUEST', 'Target user account is not active.');
    }

    if (await this.isUserBanned(roomId, targetUser.id)) {
      throw new CollabServiceError(
        'CONFLICT',
        'Target user is banned from this room. Unban them before sending an invite.',
      );
    }

    if ((await this.getMemberRole(roomId, targetUser.id)) !== null) {
      throw new CollabServiceError('CONFLICT', 'User is already a member of this room.');
    }

    const pendingInvites = await this.store.invites.listPendingForUser(targetUser.id);
    if (pendingInvites.some(i => i.room_id === roomId)) {
      throw new CollabServiceError(
        'CONFLICT',
        'A pending direct invite already exists for this user.',
      );
    }

    const inviteId = `inv_${randomUUID()}`;
    const nowIso = this.now().toISOString();

    await this.store.transaction(async tx => {
      await tx.invites.create({
        id: inviteId,
        roomId,
        kind: 'direct',
        targetUserId: targetUser.id,
        role: parsed.data.role,
        createdBy: actor.id,
        status: 'PENDING',
        uses: 0,
        maxUses: 1,
        createdAt: nowIso,
      });

      await tx.audit.append({
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

  async respondToInvite(
    actor: UserProfile,
    inviteId: string,
    input: unknown,
  ): Promise<{ accepted: boolean; roomId?: string; role?: RoomRole }> {
    const payload = typeof input === 'boolean' ? { accept: input } : input;
    const parsed = respondInviteRequestSchema.safeParse(payload);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid invite response payload.',
      );
    }

    const inviteRow = await this.store.invites.getById(inviteId);
    if (!inviteRow || inviteRow.kind !== 'direct') {
      throw new CollabServiceError('NOT_FOUND', `Direct invite '${inviteId}' not found.`);
    }

    const isBanned = await this.isUserBanned(inviteRow.room_id, actor.id);
    const currentRole = await this.getMemberRole(inviteRow.room_id, actor.id);

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
      await this.store.transaction(async tx => {
        await tx.invites.updateStatus(inviteId, 'DECLINED');
        await tx.audit.append({
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

    await this.store.transaction(async tx => {
      await tx.invites.updateStatus(inviteId, 'ACCEPTED');
      await tx.invites.incrementUses(inviteId);

      const pendingReq = await tx.joinRequests.getPendingByRoomAndUser(inviteRow.room_id, actor.id);
      if (pendingReq) {
        await tx.joinRequests.update(pendingReq.id, {
          status: 'APPROVED',
          assignedRole: inviteRow.role,
          reviewedBy: inviteRow.created_by,
          reviewedAt: nowIso,
        });
      }

      await tx.memberships.add({
        roomId: inviteRow.room_id,
        userId: actor.id,
        role: inviteRow.role,
        joinedAt: nowIso,
      });

      await tx.rooms.update(inviteRow.room_id, { updatedAt: nowIso });

      await tx.audit.append({
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

  async createInviteCode(actor: UserProfile, roomId: string, input: unknown): Promise<InviteCodeInfo> {
    await this.requireRoomRow(roomId);
    const parsed = createInviteCodeRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid invite code payload.',
      );
    }

    const actorRole = await this.getMemberRole(roomId, actor.id);
    const isBanned = await this.isUserBanned(roomId, actor.id);
    if (
      !canRoomAction(actorRole, 'member:create-invite-code', {
        assignedRole: parsed.data.role,
        isBanned,
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

    const created = await this.store.transaction(async tx => {
      const invite = await tx.invites.create({
        id: inviteId,
        roomId,
        kind: 'code',
        code,
        role: parsed.data.role,
        createdBy: actor.id,
        status: 'PENDING',
        uses: 0,
        maxUses,
        expiresAt,
        createdAt: nowIso,
      });

      await tx.audit.append({
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

      return invite;
    });

    return this.mapInviteCodeRow(created);
  }

  async redeemInviteCode(
    actor: UserProfile,
    input: unknown,
  ): Promise<{ room: RoomSummary; role: RoomRole }> {
    const payload = typeof input === 'string' ? { code: input } : input;
    const parsed = redeemInviteCodeRequestSchema.safeParse(payload);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid invite code redemption payload.',
      );
    }

    const code = parsed.data.code.trim();
    const inviteRow = await this.store.invites.getByCode(code);

    if (!inviteRow || inviteRow.kind !== 'code') {
      throw new CollabServiceError('NOT_FOUND', 'Invite code not found.');
    }

    await this.requireRoomRow(inviteRow.room_id);

    const isBanned = await this.isUserBanned(inviteRow.room_id, actor.id);
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

    const currentRole = await this.getMemberRole(inviteRow.room_id, actor.id);
    if (currentRole !== null) {
      throw new CollabServiceError('CONFLICT', 'You are already a member of this room.');
    }

    if (!canRoomAction(currentRole, 'room:redeem-invite-code', { isBanned: false })) {
      throw new CollabServiceError('FORBIDDEN', 'Not permitted to redeem this invite code.');
    }

    const nowIso = this.now().toISOString();
    await this.store.transaction(async tx => {
      await tx.invites.incrementUses(inviteRow.id);

      // Auto-accept any pending direct invite
      const pendingDirect = (await tx.invites.listPendingForUser(actor.id)).find(
        i => i.room_id === inviteRow.room_id,
      );
      if (pendingDirect) {
        await tx.invites.updateStatus(pendingDirect.id, 'ACCEPTED');
        await tx.invites.incrementUses(pendingDirect.id);
      }

      // Auto-approve pending join request
      const pendingReq = await tx.joinRequests.getPendingByRoomAndUser(inviteRow.room_id, actor.id);
      if (pendingReq) {
        await tx.joinRequests.update(pendingReq.id, {
          status: 'APPROVED',
          assignedRole: inviteRow.role,
          reviewedBy: inviteRow.created_by,
          reviewedAt: nowIso,
        });
      }

      await tx.memberships.add({
        roomId: inviteRow.room_id,
        userId: actor.id,
        role: inviteRow.role,
        joinedAt: nowIso,
      });

      await tx.rooms.update(inviteRow.room_id, { updatedAt: nowIso });

      await tx.audit.append({
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

    const room = await this.getRoomSummary(inviteRow.room_id, actor.id);
    return {
      room,
      role: inviteRow.role,
    };
  }

  async revokeInvite(actor: UserProfile, roomId: string, inviteId: string): Promise<{ revoked: true }> {
    await this.requireRoomRow(roomId);
    const actorRole = await this.getMemberRole(roomId, actor.id);
    const isBanned = await this.isUserBanned(roomId, actor.id);
    if (
      !canRoomAction(actorRole, 'member:revoke-invite', {
        isBanned,
      })
    ) {
      throw new CollabServiceError('FORBIDDEN', 'Only room admins can revoke invites.');
    }

    const inviteRow = await this.store.invites.getById(inviteId);
    if (!inviteRow || inviteRow.room_id !== roomId) {
      throw new CollabServiceError('NOT_FOUND', `Invite '${inviteId}' not found in this room.`);
    }

    const nowIso = this.now().toISOString();
    await this.store.transaction(async tx => {
      await tx.invites.updateStatus(inviteId, 'REVOKED');
      await tx.audit.append({
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

  async createJoinRequest(
    actor: UserProfile,
    roomId: string,
    input: unknown = {},
  ): Promise<JoinRequestSummary> {
    const roomRow = await this.requireRoomRow(roomId);
    const parsed = createJoinRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid join request payload.',
      );
    }

    if (await this.isUserBanned(roomId, actor.id)) {
      throw new CollabServiceError('FORBIDDEN', 'You are banned from this room.');
    }

    const currentRole = await this.getMemberRole(roomId, actor.id);
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

    const existingPending = await this.store.joinRequests.getPendingByRoomAndUser(roomId, actor.id);
    if (existingPending) {
      throw new CollabServiceError(
        'CONFLICT',
        'You already have a pending join request for this room.',
      );
    }

    const requestId = `jreq_${randomUUID()}`;
    const message = parsed.data.message?.trim() ?? '';
    const nowIso = this.now().toISOString();

    await this.store.transaction(async tx => {
      await tx.joinRequests.create({
        id: requestId,
        roomId,
        userId: actor.id,
        message,
        status: 'PENDING',
        createdAt: nowIso,
      });

      await tx.audit.append({
        roomId,
        actorId: actor.id,
        actorName: actor.displayName,
        action: 'room:request-join',
        targetId: requestId,
        details: { message },
        createdAt: nowIso,
      });
    });

    const summary = await this.requireJoinRequestSummary(requestId);
    this.emitEvent({
      type: 'join-request-created',
      roomId,
      joinRequest: summary,
    });
    return summary;
  }

  async reviewJoinRequest(
    actor: UserProfile,
    roomId: string,
    requestId: string,
    input: unknown,
  ): Promise<JoinRequestSummary> {
    await this.requireRoomRow(roomId);
    const parsed = reviewJoinRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid join request review payload.',
      );
    }

    const actorRole = await this.getMemberRole(roomId, actor.id);
    const assignedRole: BelowAdminRoomRole = parsed.data.role ?? 'VIEWER';
    const isBanned = await this.isUserBanned(roomId, actor.id);
    if (
      !canRoomAction(actorRole, 'member:review-join-request', {
        assignedRole,
        isBanned,
      })
    ) {
      throw new CollabServiceError('FORBIDDEN', 'Only room admins can review join requests.');
    }

    const reqRow = await this.store.joinRequests.getById(requestId);
    if (!reqRow || reqRow.room_id !== roomId) {
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

    if (parsed.data.approve && (await this.isUserBanned(roomId, reqRow.user_id))) {
      throw new CollabServiceError('BAD_REQUEST', 'Cannot approve a banned user.');
    }

    const nowIso = this.now().toISOString();
    await this.store.transaction(async tx => {
      if (parsed.data.approve) {
        await tx.joinRequests.update(requestId, {
          status: 'APPROVED',
          assignedRole,
          reviewedBy: actor.id,
          reviewedAt: nowIso,
        });

        const pendingDirect = (await tx.invites.listPendingForUser(reqRow.user_id)).find(
          i => i.room_id === roomId,
        );
        if (pendingDirect) {
          await tx.invites.updateStatus(pendingDirect.id, 'ACCEPTED');
          await tx.invites.incrementUses(pendingDirect.id);
        }

        if ((await tx.memberships.get(roomId, reqRow.user_id)) === null) {
          await tx.memberships.add({
            roomId,
            userId: reqRow.user_id,
            role: assignedRole,
            joinedAt: nowIso,
          });
        }

        await tx.rooms.update(roomId, { updatedAt: nowIso });

        await tx.audit.append({
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
        await tx.joinRequests.update(requestId, {
          status: 'REJECTED',
          assignedRole: null,
          reviewedBy: actor.id,
          reviewedAt: nowIso,
        });

        await tx.audit.append({
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

    const summary = await this.requireJoinRequestSummary(requestId);
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

  async changeMemberRole(
    actor: UserProfile,
    roomId: string,
    targetUserId: string,
    input: unknown,
  ): Promise<RoomMemberInfo> {
    await this.requireRoomRow(roomId);
    const payload = typeof input === 'string' ? { role: input } : input;
    const parsed = updateRoomMemberRoleRequestSchema.safeParse(payload);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid member role update payload.',
      );
    }

    const actorRole = await this.getMemberRole(roomId, actor.id);
    if (actorRole === null) {
      throw new CollabServiceError('FORBIDDEN', 'You are not a member of this room.');
    }

    const targetMember = await this.store.memberships.get(roomId, targetUserId);
    if (!targetMember) {
      throw new CollabServiceError('NOT_FOUND', 'Member not found in this room.');
    }

    const assignedRole: AssignableRoomRole = parsed.data.role;
    const action: RoomAction =
      targetMember.role === 'ROOM_ADMIN' || assignedRole === 'ROOM_ADMIN'
        ? 'member:promote-demote-admin'
        : 'member:change-role-below-admin';

    const isBanned = await this.isUserBanned(roomId, actor.id);
    if (
      !canRoomAction(actorRole, action, {
        targetRoomRole: targetMember.role,
        assignedRole,
        isBanned,
      })
    ) {
      throw new CollabServiceError(
        'FORBIDDEN',
        `Role '${actorRole}' cannot change member from '${targetMember.role}' to '${assignedRole}'.`,
      );
    }

    const nowIso = this.now().toISOString();
    await this.store.transaction(async tx => {
      await tx.memberships.updateRole(roomId, targetUserId, assignedRole);
      await tx.rooms.update(roomId, { updatedAt: nowIso });
      await tx.audit.append({
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

  async kickMember(
    actor: UserProfile,
    roomId: string,
    targetUserId: string,
    input: unknown = {},
  ): Promise<{ kicked: true }> {
    await this.requireRoomRow(roomId);
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

    const actorRole = await this.getMemberRole(roomId, actor.id);
    const targetMember = await this.store.memberships.get(roomId, targetUserId);
    if (!targetMember) {
      throw new CollabServiceError('NOT_FOUND', 'Member not found in this room.');
    }

    const isBanned = await this.isUserBanned(roomId, actor.id);
    if (
      !canRoomAction(actorRole, 'member:kick-ban', {
        targetRoomRole: targetMember.role,
        isBanned,
      })
    ) {
      throw new CollabServiceError(
        'FORBIDDEN',
        `Role '${actorRole ?? 'NONE'}' cannot kick a '${targetMember.role}' member.`,
      );
    }

    const reason = parsed.data.reason?.trim() ?? '';
    const nowIso = this.now().toISOString();

    await this.store.transaction(async tx => {
      await tx.memberships.remove(roomId, targetUserId);
      await tx.rooms.update(roomId, { updatedAt: nowIso });
      await tx.audit.append({
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

  async banMember(
    actor: UserProfile,
    roomId: string,
    targetUserId: string,
    input: unknown = {},
  ): Promise<{ banned: true }> {
    const roomRow = await this.requireRoomRow(roomId);
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

    const targetUser = await this.findUserRow(targetUserId);
    if (!targetUser) {
      throw new CollabServiceError('NOT_FOUND', `User '${targetUserId}' not found.`);
    }

    const actorRole = await this.getMemberRole(roomId, actor.id);
    const existingMemberRole = await this.getMemberRole(roomId, targetUserId);
    const effectiveTargetRole: RoomRole =
      existingMemberRole ?? (roomRow.owner_id === targetUserId ? 'ROOM_OWNER' : 'VIEWER');

    const isBanned = await this.isUserBanned(roomId, actor.id);
    if (
      !canRoomAction(actorRole, 'member:kick-ban', {
        targetRoomRole: effectiveTargetRole,
        isBanned,
      })
    ) {
      throw new CollabServiceError(
        'FORBIDDEN',
        `Role '${actorRole ?? 'NONE'}' cannot ban a '${effectiveTargetRole}' user.`,
      );
    }

    const reason = parsed.data.reason?.trim() ?? '';
    const nowIso = this.now().toISOString();

    await this.store.transaction(async tx => {
      await tx.memberships.remove(roomId, targetUserId);

      // Revoke any pending invites
      const pendingInvites = await tx.invites.listByRoom(roomId);
      for (const inv of pendingInvites) {
        if (inv.target_user_id === targetUserId && inv.status === 'PENDING') {
          await tx.invites.updateStatus(inv.id, 'REVOKED');
        }
      }

      // Reject pending join requests
      const pendingReq = await tx.joinRequests.getPendingByRoomAndUser(roomId, targetUserId);
      if (pendingReq) {
        await tx.joinRequests.update(pendingReq.id, {
          status: 'REJECTED',
          assignedRole: null,
          reviewedBy: actor.id,
          reviewedAt: nowIso,
        });
      }

      await tx.bans.add({
        roomId,
        userId: targetUserId,
        bannedBy: actor.id,
        reason,
        bannedAt: nowIso,
      });

      await tx.rooms.update(roomId, { updatedAt: nowIso });

      await tx.audit.append({
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

  async unbanMember(actor: UserProfile, roomId: string, targetUserId: string): Promise<{ unbanned: true }> {
    await this.requireRoomRow(roomId);
    const actorRole = await this.getMemberRole(roomId, actor.id);
    const isBanned = await this.isUserBanned(roomId, actor.id);
    if (
      !canRoomAction(actorRole, 'member:kick-ban', {
        targetRoomRole: 'VIEWER',
        isBanned,
      })
    ) {
      throw new CollabServiceError('FORBIDDEN', 'Only room admins can unban users.');
    }

    const banRow = await this.store.bans.get(roomId, targetUserId);
    if (!banRow) {
      throw new CollabServiceError('NOT_FOUND', 'User is not banned from this room.');
    }

    const nowIso = this.now().toISOString();
    await this.store.transaction(async tx => {
      await tx.bans.remove(roomId, targetUserId);
      await tx.audit.append({
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

  async listRoomAuditLog(actor: UserProfile, roomId: string, limit = 100): Promise<AuditEntry[]> {
    await this.requireRoomRow(roomId);
    const actorRole = await this.getMemberRole(roomId, actor.id);
    const isBanned = await this.isUserBanned(roomId, actor.id);
    const canViewRoom = canRoomAction(actorRole, 'room:view-audit', {
      isBanned,
    });
    const canViewServer = canServerAction(actor.serverRole, 'audit:view-server');

    if (!canViewRoom && !canViewServer) {
      throw new CollabServiceError('FORBIDDEN', 'Only room admins can view the room audit log.');
    }

    const rows = await this.store.audit.list({ roomId, limit });
    return rows.map(mapAuditLogRow);
  }

  async exportRoom(
    actor: UserProfile,
    roomId: string,
    query: unknown,
  ): Promise<RoomExportResult> {
    await this.requireRoomRow(roomId);
    const actorRole = await this.getMemberRole(roomId, actor.id);
    const isServerAdmin =
      actor.serverRole === 'SERVER_ADMIN' || actor.serverRole === 'SERVER_OWNER';
    const isBanned = await this.isUserBanned(roomId, actor.id);

    if (
      !canRoomAction(actorRole, 'room:export', {
        isBanned,
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

  async listAllRoomsAdmin(actor: UserProfile): Promise<RoomSummary[]> {
    if (!canServerAction(actor.serverRole, 'rooms:list-all-admin')) {
      throw new CollabServiceError('FORBIDDEN', 'Only server admins can list all rooms.');
    }

    const rows = await this.store.rooms.listAllAdmin();
    return Promise.all(rows.map(row => this.mapRoomRowToSummary(row, actor.id)));
  }

  async resolveStuckRoom(actor: UserProfile, roomId: string, input: unknown): Promise<RoomSummary> {
    if (!canServerAction(actor.serverRole, 'rooms:resolve-stuck')) {
      throw new CollabServiceError('FORBIDDEN', 'Only server admins can resolve stuck rooms.');
    }

    const roomRow = await this.requireRoomRow(roomId);
    const parsed = adminResolveRoomRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new CollabServiceError(
        'BAD_REQUEST',
        parsed.error.issues[0]?.message ?? 'Invalid room resolution payload.',
      );
    }

    const targetUser = await this.findUserRow(parsed.data.userId);
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

    const previousRole = await this.getMemberRole(roomId, targetUser.id);
    const nowIso = this.now().toISOString();

    await this.store.transaction(async tx => {
      await tx.bans.remove(roomId, targetUser.id);

      if (assignedRole === 'ROOM_OWNER') {
        if (roomRow.owner_id !== targetUser.id) {
          await tx.memberships.updateRole(roomId, roomRow.owner_id, 'ROOM_ADMIN');
        }
        await tx.rooms.update(roomId, { ownerId: targetUser.id, updatedAt: nowIso });
      } else {
        await tx.rooms.update(roomId, { updatedAt: nowIso });
      }

      if (previousRole === null) {
        await tx.memberships.add({
          roomId,
          userId: targetUser.id,
          role: assignedRole,
          joinedAt: nowIso,
        });
      } else {
        await tx.memberships.updateRole(roomId, targetUser.id, assignedRole);
      }

      await tx.audit.append({
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

  async getRoomSummary(roomId: string, viewerUserId?: string | null): Promise<RoomSummary> {
    const row = await this.requireRoomRow(roomId);
    return this.mapRoomRowToSummary(row, viewerUserId ?? null);
  }

  async getMemberRole(roomId: string, userId: string): Promise<RoomRole | null> {
    const member = await this.store.memberships.get(roomId, userId);
    return member?.role ?? null;
  }

  async isUserBanned(roomId: string, userId: string): Promise<boolean> {
    const ban = await this.store.bans.get(roomId, userId);
    return Boolean(ban);
  }

  async listRoomMembers(roomId: string): Promise<RoomMemberInfo[]> {
    await this.requireRoomRow(roomId);
    const members = await this.store.memberships.listByRoom(roomId);
    const onlineSet = this.getOnlineSet(roomId);

    const result: RoomMemberInfo[] = [];
    for (const m of members) {
      const user = await this.findUserRow(m.user_id);
      result.push({
        roomId: m.room_id,
        userId: m.user_id,
        username: user?.username ?? m.user_id,
        displayName: user?.display_name ?? m.user_id,
        role: m.role,
        joinedAt: m.joined_at,
        online: onlineSet ? onlineSet.has(m.user_id) : false,
        color: assignUserColor(m.user_id),
      });
    }
    return result;
  }

  async listRoomInvites(roomId: string): Promise<InviteInfo[]> {
    await this.requireRoomRow(roomId);
    const rows = await this.store.invites.listByRoom(roomId);
    return Promise.all(
      rows.map(row => (row.kind === 'direct' ? this.mapDirectInviteRow(row) : this.mapInviteCodeRow(row))),
    );
  }

  async listRoomJoinRequests(roomId: string): Promise<JoinRequestSummary[]> {
    await this.requireRoomRow(roomId);
    const rows = await this.store.joinRequests.listByRoom(roomId);
    return Promise.all(rows.map(row => this.mapJoinRequestRow(row)));
  }

  async listRoomBans(roomId: string): Promise<RoomBanInfo[]> {
    await this.requireRoomRow(roomId);
    const rows = await this.store.bans.listByRoom(roomId);
    const result: RoomBanInfo[] = [];
    for (const b of rows) {
      const u = await this.findUserRow(b.user_id);
      result.push({
        roomId: b.room_id,
        userId: b.user_id,
        username: u?.username ?? b.user_id,
        displayName: u?.display_name ?? b.user_id,
        bannedBy: b.banned_by,
        reason: b.reason,
        bannedAt: b.banned_at,
      });
    }
    return result;
  }

  private getOnlineSet(roomId: string): Set<string> | null {
    if (!this.getOnlineUserIds) return null;
    const raw = this.getOnlineUserIds(roomId);
    return raw instanceof Set ? raw : new Set(raw);
  }

  private async getRoomMemberCount(roomId: string): Promise<number> {
    const members = await this.store.memberships.listByRoom(roomId);
    return members.length;
  }

  private async mapRoomRowToSummary(row: RoomRow, viewerUserId: string | null): Promise<RoomSummary> {
    const ownerRow = await this.findUserRow(row.owner_id);
    const myRole = viewerUserId ? await this.getMemberRole(row.id, viewerUserId) : null;
    const memberCount = await this.getRoomMemberCount(row.id);
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

  private async mapDirectInviteRow(row: InviteRow): Promise<DirectInviteSummary> {
    const roomRow = await this.requireRoomRow(row.room_id);
    const targetId = row.target_user_id ?? '';
    const targetUser = await this.findUserRow(targetId);
    const creatorUser = await this.findUserRow(row.created_by);

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

  private async mapJoinRequestRow(row: JoinRequestRow): Promise<JoinRequestSummary> {
    const roomRow = await this.requireRoomRow(row.room_id);
    const userRow = await this.findUserRow(row.user_id);

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

  private async requireDirectInviteSummary(inviteId: string): Promise<DirectInviteSummary> {
    const row = await this.store.invites.getById(inviteId);
    if (!row || row.kind !== 'direct') {
      throw new CollabServiceError('NOT_FOUND', `Direct invite '${inviteId}' not found.`);
    }
    return this.mapDirectInviteRow(row);
  }

  private async requireJoinRequestSummary(requestId: string): Promise<JoinRequestSummary> {
    const row = await this.store.joinRequests.getById(requestId);
    if (!row) {
      throw new CollabServiceError('NOT_FOUND', `Join request '${requestId}' not found.`);
    }
    return this.mapJoinRequestRow(row);
  }

  private async requireRoomMemberInfo(roomId: string, userId: string): Promise<RoomMemberInfo> {
    const members = await this.listRoomMembers(roomId);
    const member = members.find(m => m.userId === userId);
    if (!member) {
      throw new CollabServiceError('NOT_FOUND', 'Member not found in this room.');
    }
    return member;
  }

  private async requireRoomRow(roomId: string): Promise<RoomRow> {
    const row = await this.store.rooms.getById(roomId);
    if (!row) {
      throw new CollabServiceError('NOT_FOUND', `Room '${roomId}' not found.`);
    }
    return row;
  }

  private async findUserRow(userId: string): Promise<UserRow | null> {
    return this.store.users.getById(userId);
  }

  private emitEvent(event: RoomLifecycleEvent): void {
    this.onRoomEvent?.(event);
  }
}
