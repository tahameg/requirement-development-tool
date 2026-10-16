import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addItem } from '../../src/main/services/idGenerator.js';
import { addFunction, addModule, createWorkspace } from '../../src/main/services/workspaceFactory.js';
import { loadWorkspace } from '../../src/main/services/workspaceService.js';
import { AuthService, CollabServiceError } from '../../src/server/auth.js';
import { ServerDatabase } from '../../src/server/db.js';
import { RoomService, type RoomLifecycleEvent } from '../../src/server/rooms.js';
import {
  directInviteSummarySchema,
  getRoomResponseSchema,
  inviteCodeInfoSchema,
  joinRequestSummarySchema,
  listRoomsResponseSchema,
  roomExportResponseSchema,
  roomMemberInfoSchema,
  roomSummarySchema,
} from '../../src/shared/collab/protocol.js';

describe('T04: RoomService (rooms, memberships, invites, join requests, kick/ban, transfer, audit)', () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hlr-server-rooms-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createFixture() {
    let currentTime = new Date('2026-10-16T04:00:00.000Z');
    const dataDir = makeTempDir();
    const db = ServerDatabase.open(dataDir, { now: () => currentTime });
    const auth = new AuthService(db, {
      initialSetupToken: 'setup-token-rooms',
      now: () => currentTime,
    });
    const events: RoomLifecycleEvent[] = [];
    const rooms = new RoomService(db, {
      now: () => currentTime,
      onRoomEvent: ev => events.push(ev),
    });

    const { user: serverOwner } = auth.claimSetupToken({
      setupToken: 'setup-token-rooms',
      username: 'server_owner',
      displayName: 'Server Owner',
      password: 'password123',
    });

    const serverAdmin = auth.createUser(serverOwner, {
      username: 'server_admin',
      displayName: 'Server Admin',
      password: 'password123',
      serverRole: 'SERVER_ADMIN',
    });

    const alice = auth.createUser(serverOwner, {
      username: 'alice',
      displayName: 'Alice Owner',
      password: 'password123',
    });

    const bob = auth.createUser(serverOwner, {
      username: 'bob',
      displayName: 'Bob Admin',
      password: 'password123',
    });

    const charlie = auth.createUser(serverOwner, {
      username: 'charlie',
      displayName: 'Charlie Editor',
      password: 'password123',
    });

    const dana = auth.createUser(serverOwner, {
      username: 'dana',
      displayName: 'Dana Viewer',
      password: 'password123',
    });

    const mallory = auth.createUser(serverOwner, {
      username: 'mallory',
      displayName: 'Mallory Outsider',
      password: 'password123',
    });

    return {
      dataDir,
      db,
      auth,
      rooms,
      events,
      serverOwner,
      serverAdmin,
      alice,
      bob,
      charlie,
      dana,
      mallory,
      advanceTimeMs: (ms: number) => {
        currentTime = new Date(currentTime.getTime() + ms);
      },
    };
  }

  describe('Room Creation, Workspace Persistence, and roomCreationMode Enforcement', () => {
    it('creates a room with a fresh workspace and persists human-readable JSON on disk via saveWorkspace', async () => {
      const { db, rooms, alice } = createFixture();

      const room = await rooms.createRoom(alice, {
        name: 'Avionics Flight Control',
        visibility: 'private',
        projectName: 'FCS Project',
        projectPrefix: 'FCS',
      });

      expect(roomSummarySchema.safeParse(room).success).toBe(true);
      expect(room.name).toBe('Avionics Flight Control');
      expect(room.visibility).toBe('private');
      expect(room.ownerId).toBe(alice.id);
      expect(room.projectName).toBe('FCS Project');
      expect(room.myRole).toBe('ROOM_OWNER');
      expect(room.memberCount).toBe(1);

      const workspaceDir = rooms.getRoomWorkspaceDir(room.id);
      expect(existsSync(path.join(workspaceDir, 'project.config.json'))).toBe(true);

      const diskWorkspace = await loadWorkspace(workspaceDir);
      expect(diskWorkspace.config.projectName).toBe('FCS Project');
      expect(diskWorkspace.config.projectPrefix).toBe('FCS');

      const detail = await rooms.getRoom(alice, room.id);
      expect(getRoomResponseSchema.safeParse(detail).success).toBe(true);
      expect(detail.workspace.config.projectId).toBe(room.projectId);
      expect(detail.members).toHaveLength(1);
      expect(detail.members[0]?.role).toBe('ROOM_OWNER');

      db.close();
    });

    it('creates a room from an imported Workspace and rejects invalid workspaces', async () => {
      const { db, rooms, alice } = createFixture();

      let imported = createWorkspace('Imported Radar System', 'RDR');
      imported = addModule(imported, 'REQUIREMENT', 'Signal Processing', 'SIG');
      const modId = imported.domains.REQUIREMENT.modules[0]!.id;
      imported = addFunction(imported, 'REQUIREMENT', modId, 'Target Tracking', 'TRK');
      const fnId = imported.domains.REQUIREMENT.functions[0]!.functionId;
      imported = addItem(imported, 'REQUIREMENT', fnId, {
        col_desc: 'The radar shall track up to 64 targets simultaneously.',
        col_status: 'Approved',
      });

      const room = await rooms.createRoom(alice, {
        name: 'Radar Room',
        visibility: 'listed',
        workspace: imported,
      });

      expect(room.projectId).toBe(imported.config.projectId);
      expect(room.projectName).toBe('Imported Radar System');

      const loaded = await rooms.loadRoomWorkspace(room.id);
      expect(loaded.domains.REQUIREMENT.functions[0]?.items).toHaveLength(1);
      expect(loaded.domains.REQUIREMENT.functions[0]?.items[0]?.id).toBe('REQ-RDR-SIG-TRK-001');

      // Invalid workspace (e.g. broken parent module reference) -> 400 BAD_REQUEST
      const brokenWorkspace = structuredClone(imported);
      brokenWorkspace.domains.REQUIREMENT.functions[0]!.parentModuleId = 'mod_nonexistent';
      await expect(
        rooms.createRoom(alice, {
          name: 'Broken Room',
          visibility: 'private',
          workspace: brokenWorkspace,
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: 'BAD_REQUEST',
          status: 400,
        }),
      );

      db.close();
    });

    it('enforces roomCreationMode (all_users vs admins_only)', async () => {
      const { db, auth, rooms, serverOwner, serverAdmin, alice } = createFixture();

      // Switch server roomCreationMode to 'admins_only'
      auth.updateServerSettings(serverOwner, { roomCreationMode: 'admins_only' });

      // Regular USER (alice) is rejected with 403 FORBIDDEN
      await expect(
        rooms.createRoom(alice, {
          name: 'Alice Room',
          visibility: 'private',
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: 'FORBIDDEN',
          status: 403,
        }),
      );

      // SERVER_ADMIN and SERVER_OWNER can still create rooms
      const adminRoom = await rooms.createRoom(serverAdmin, {
        name: 'Admin Created Room',
        visibility: 'listed',
      });
      expect(adminRoom.ownerId).toBe(serverAdmin.id);

      const ownerRoom = await rooms.createRoom(serverOwner, {
        name: 'Owner Created Room',
        visibility: 'private',
      });
      expect(ownerRoom.ownerId).toBe(serverOwner.id);

      db.close();
    });
  });

  describe('Room Visibility (private vs listed) & Metadata Editing', () => {
    it('shows listed rooms to all non-banned users while hiding private rooms from non-members', async () => {
      const { db, rooms, serverAdmin, alice, bob } = createFixture();

      const privateRoom = await rooms.createRoom(alice, {
        name: 'Secret Project',
        visibility: 'private',
      });

      const listedRoom = await rooms.createRoom(alice, {
        name: 'Open Architecture Room',
        visibility: 'listed',
      });

      // Bob is not a member of either room: sees only listedRoom in listedRooms, and 0 in myRooms
      const bobLobby = rooms.listRoomsForUser(bob);
      expect(listRoomsResponseSchema.safeParse(bobLobby).success).toBe(true);
      expect(bobLobby.myRooms).toHaveLength(0);
      expect(bobLobby.listedRooms.map(r => r.id)).toEqual([listedRoom.id]);

      // Bob cannot fetch privateRoom details -> 403 FORBIDDEN
      await expect(rooms.getRoom(bob, privateRoom.id)).rejects.toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );

      // Server Admin can list all rooms (including private) and inspect privateRoom
      const allAdminRooms = rooms.listAllRoomsAdmin(serverAdmin);
      expect(allAdminRooms.map(r => r.id).sort()).toEqual([listedRoom.id, privateRoom.id].sort());
      const adminView = await rooms.getRoom(serverAdmin, privateRoom.id);
      expect(adminView.room.id).toBe(privateRoom.id);

      // Alice updates privateRoom to 'listed' and renames it
      const updated = rooms.updateRoom(alice, privateRoom.id, {
        name: 'Now Public Project',
        visibility: 'listed',
      });
      expect(updated.name).toBe('Now Public Project');
      expect(updated.visibility).toBe('listed');
      expect(rooms.listRoomsForUser(bob).listedRooms).toHaveLength(2);

      db.close();
    });
  });

  describe('Direct Invites & Invite Codes (Expiry, Max Uses, Revocation)', () => {
    it('handles direct user invites, role limits (ROOM_ADMIN vs ROOM_OWNER), accept/decline, and revocation', async () => {
      const { db, rooms, alice, bob, charlie, dana, mallory } = createFixture();

      const room = await rooms.createRoom(alice, {
        name: 'Invite Test Room',
        visibility: 'private',
      });

      // Alice (ROOM_OWNER) invites Bob as ROOM_ADMIN
      const bobInvite = rooms.createDirectInvite(alice, room.id, {
        targetUserId: bob.id,
        role: 'ROOM_ADMIN',
      });
      expect(directInviteSummarySchema.safeParse(bobInvite).success).toBe(true);
      expect(bobInvite.role).toBe('ROOM_ADMIN');

      // Duplicate pending invite for Bob -> 409 CONFLICT
      expect(() =>
        rooms.createDirectInvite(alice, room.id, {
          targetUserId: bob.id,
          role: 'EDITOR',
        }),
      ).toThrowError(expect.objectContaining({ code: 'CONFLICT', status: 409 }));

      // Mallory cannot accept Bob's invite -> 403 FORBIDDEN
      expect(() => rooms.respondToInvite(mallory, bobInvite.id, { accept: true })).toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );

      // Bob sees the invite in listRoomsForUser and accepts it
      expect(rooms.listRoomsForUser(bob).myInvites).toHaveLength(1);
      const bobAccept = rooms.respondToInvite(bob, bobInvite.id, { accept: true });
      expect(bobAccept).toEqual({
        accepted: true,
        roomId: room.id,
        role: 'ROOM_ADMIN',
      });
      expect(rooms.getMemberRole(room.id, bob.id)).toBe('ROOM_ADMIN');

      // Bob (ROOM_ADMIN) CANNOT invite Charlie as ROOM_ADMIN -> 403 FORBIDDEN
      expect(() =>
        rooms.createDirectInvite(bob, room.id, {
          targetUserId: charlie.id,
          role: 'ROOM_ADMIN',
        }),
      ).toThrowError(expect.objectContaining({ code: 'FORBIDDEN', status: 403 }));

      // Bob (ROOM_ADMIN) CAN invite Charlie as EDITOR and Dana as VIEWER
      const charlieInvite = rooms.createDirectInvite(bob, room.id, {
        targetUserId: charlie.id,
        role: 'EDITOR',
      });
      const danaInvite = rooms.createDirectInvite(bob, room.id, {
        targetUserId: dana.id,
        role: 'VIEWER',
      });

      // Charlie declines the invite
      const charlieDecline = rooms.respondToInvite(charlie, charlieInvite.id, { accept: false });
      expect(charlieDecline).toEqual({ accepted: false });
      expect(rooms.getMemberRole(room.id, charlie.id)).toBeNull();

      // Bob revokes Dana's invite before she responds
      expect(rooms.revokeInvite(bob, room.id, danaInvite.id)).toEqual({ revoked: true });
      expect(() => rooms.respondToInvite(dana, danaInvite.id, { accept: true })).toThrowError(
        expect.objectContaining({ code: 'BAD_REQUEST', status: 400 }),
      );

      db.close();
    });

    it('enforces maxUses and expiresAt on shareable invite codes', async () => {
      const { db, rooms, alice, bob, charlie, dana, advanceTimeMs } = createFixture();

      const room = await rooms.createRoom(alice, {
        name: 'Code Test Room',
        visibility: 'private',
      });

      // Create an invite code with maxUses = 2 and expiresInSeconds = 60
      const codeInfo = rooms.createInviteCode(alice, room.id, {
        role: 'EDITOR',
        maxUses: 2,
        expiresInSeconds: 60,
      });
      expect(inviteCodeInfoSchema.safeParse(codeInfo).success).toBe(true);
      expect(codeInfo.maxUses).toBe(2);
      expect(codeInfo.uses).toBe(0);

      // Use #1: Bob redeems
      const bobRedeem = rooms.redeemInviteCode(bob, { code: codeInfo.code });
      expect(bobRedeem.role).toBe('EDITOR');
      expect(bobRedeem.room.id).toBe(room.id);

      // Bob cannot redeem again (already a member) -> 409 CONFLICT
      expect(() => rooms.redeemInviteCode(bob, { code: codeInfo.code })).toThrowError(
        expect.objectContaining({ code: 'CONFLICT', status: 409 }),
      );

      // Use #2: Charlie redeems
      const charlieRedeem = rooms.redeemInviteCode(charlie, { code: codeInfo.code });
      expect(charlieRedeem.role).toBe('EDITOR');

      // Use #3: Dana tries to redeem after maxUses (2) reached -> 400 BAD_REQUEST
      expect(() => rooms.redeemInviteCode(dana, { code: codeInfo.code })).toThrowError(
        expect.objectContaining({ code: 'BAD_REQUEST', status: 400 }),
      );

      // Create a second code that expires in 30 seconds
      const expiringCode = rooms.createInviteCode(alice, room.id, {
        role: 'VIEWER',
        expiresInSeconds: 30,
      });
      advanceTimeMs(31_000);

      // Dana tries to redeem expired code -> 400 BAD_REQUEST
      expect(() => rooms.redeemInviteCode(dana, { code: expiringCode.code })).toThrowError(
        expect.objectContaining({ code: 'BAD_REQUEST', status: 400 }),
      );

      db.close();
    });
  });

  describe('Join Requests on Listed Rooms (Approve with Role vs Reject)', () => {
    it('supports submitting join requests to listed rooms and admin approval/rejection', async () => {
      const { db, rooms, alice, bob, charlie, dana } = createFixture();

      const privateRoom = await rooms.createRoom(alice, {
        name: 'Private Room',
        visibility: 'private',
      });
      const listedRoom = await rooms.createRoom(alice, {
        name: 'Listed Room',
        visibility: 'listed',
      });

      // Cannot request to join a private room -> 403 FORBIDDEN
      expect(() =>
        rooms.createJoinRequest(bob, privateRoom.id, { message: 'Let me in' }),
      ).toThrowError(expect.objectContaining({ code: 'FORBIDDEN', status: 403 }));

      // Bob requests to join listedRoom
      const bobReq = rooms.createJoinRequest(bob, listedRoom.id, {
        message: 'I work on the propulsion subsystem.',
      });
      expect(joinRequestSummarySchema.safeParse(bobReq).success).toBe(true);
      expect(bobReq.status).toBe('PENDING');

      // Bob's lobby shows hasPendingJoinRequest = true and myJoinRequests
      const bobLobby = rooms.listRoomsForUser(bob);
      expect(bobLobby.listedRooms[0]?.hasPendingJoinRequest).toBe(true);
      expect(bobLobby.myJoinRequests).toHaveLength(1);

      // Duplicate pending request -> 409 CONFLICT
      expect(() => rooms.createJoinRequest(bob, listedRoom.id)).toThrowError(
        expect.objectContaining({ code: 'CONFLICT', status: 409 }),
      );

      // Charlie also requests to join
      const charlieReq = rooms.createJoinRequest(charlie, listedRoom.id, {
        message: 'Requesting editor access',
      });

      // Dana (non-member) cannot review join requests -> 403 FORBIDDEN
      expect(() =>
        rooms.reviewJoinRequest(dana, listedRoom.id, bobReq.id, {
          approve: true,
          role: 'EDITOR',
        }),
      ).toThrowError(expect.objectContaining({ code: 'FORBIDDEN', status: 403 }));

      // Alice approves Bob as EDITOR
      const reviewedBob = rooms.reviewJoinRequest(alice, listedRoom.id, bobReq.id, {
        approve: true,
        role: 'EDITOR',
      });
      expect(reviewedBob.status).toBe('APPROVED');
      expect(reviewedBob.assignedRole).toBe('EDITOR');
      expect(rooms.getMemberRole(listedRoom.id, bob.id)).toBe('EDITOR');

      // Bob (EDITOR) cannot review Charlie's join request -> 403 FORBIDDEN
      expect(() =>
        rooms.reviewJoinRequest(bob, listedRoom.id, charlieReq.id, {
          approve: true,
          role: 'VIEWER',
        }),
      ).toThrowError(expect.objectContaining({ code: 'FORBIDDEN', status: 403 }));

      // Alice rejects Charlie's join request
      const reviewedCharlie = rooms.reviewJoinRequest(alice, listedRoom.id, charlieReq.id, {
        approve: false,
      });
      expect(reviewedCharlie.status).toBe('REJECTED');
      expect(reviewedCharlie.assignedRole).toBeNull();
      expect(rooms.getMemberRole(listedRoom.id, charlie.id)).toBeNull();

      db.close();
    });
  });

  describe('Role Changes, Kick, Ban/Unban, Leave, Ownership Transfer, and Stuck Room Resolution', () => {
    it('enforces ROOM_ADMIN vs ROOM_OWNER role change rules and kick/ban restrictions', async () => {
      const { db, rooms, alice, bob, charlie, dana, mallory } = createFixture();

      const room = await rooms.createRoom(alice, {
        name: 'Permissions Room',
        visibility: 'listed',
      });

      // Invite and add Bob (ROOM_ADMIN), Charlie (EDITOR), Dana (VIEWER)
      const invBob = rooms.createDirectInvite(alice, room.id, {
        targetUserId: bob.id,
        role: 'ROOM_ADMIN',
      });
      rooms.respondToInvite(bob, invBob.id, { accept: true });

      const invCharlie = rooms.createDirectInvite(bob, room.id, {
        targetUserId: charlie.id,
        role: 'EDITOR',
      });
      rooms.respondToInvite(charlie, invCharlie.id, { accept: true });

      const invDana = rooms.createDirectInvite(bob, room.id, {
        targetUserId: dana.id,
        role: 'VIEWER',
      });
      rooms.respondToInvite(dana, invDana.id, { accept: true });

      // Bob (ROOM_ADMIN) can change Dana (VIEWER) -> EDITOR and Charlie (EDITOR) -> VIEWER
      const updatedDana = rooms.changeMemberRole(bob, room.id, dana.id, { role: 'EDITOR' });
      expect(roomMemberInfoSchema.safeParse(updatedDana).success).toBe(true);
      expect(updatedDana.role).toBe('EDITOR');

      const updatedCharlie = rooms.changeMemberRole(bob, room.id, charlie.id, { role: 'VIEWER' });
      expect(updatedCharlie.role).toBe('VIEWER');

      // Bob (ROOM_ADMIN) CANNOT promote Dana to ROOM_ADMIN -> 403 FORBIDDEN
      expect(() =>
        rooms.changeMemberRole(bob, room.id, dana.id, { role: 'ROOM_ADMIN' }),
      ).toThrowError(expect.objectContaining({ code: 'FORBIDDEN', status: 403 }));

      // Alice (ROOM_OWNER) CAN promote Dana to ROOM_ADMIN and demote her back to VIEWER
      expect(rooms.changeMemberRole(alice, room.id, dana.id, { role: 'ROOM_ADMIN' }).role).toBe(
        'ROOM_ADMIN',
      );
      // While Dana is ROOM_ADMIN, Bob (ROOM_ADMIN) cannot demote or kick/ban her -> 403 FORBIDDEN
      expect(() =>
        rooms.changeMemberRole(bob, room.id, dana.id, { role: 'VIEWER' }),
      ).toThrowError(expect.objectContaining({ code: 'FORBIDDEN', status: 403 }));
      expect(() => rooms.kickMember(bob, room.id, dana.id)).toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );
      expect(() => rooms.banMember(bob, room.id, dana.id)).toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );

      // Alice demotes Dana back to VIEWER
      expect(rooms.changeMemberRole(alice, room.id, dana.id, { role: 'VIEWER' }).role).toBe(
        'VIEWER',
      );

      // Bob (ROOM_ADMIN) kicks Charlie (VIEWER)
      expect(rooms.kickMember(bob, room.id, charlie.id, { reason: 'Inactive' })).toEqual({
        kicked: true,
      });
      expect(rooms.getMemberRole(room.id, charlie.id)).toBeNull();

      // Kicked user (not banned) can still request to join again
      const charlieRejoinReq = rooms.createJoinRequest(charlie, room.id, {
        message: 'Back online',
      });
      expect(charlieRejoinReq.status).toBe('PENDING');

      // Bob (ROOM_ADMIN) bans Charlie -> removes membership/pending requests and blocks all rejoin paths
      expect(rooms.banMember(bob, room.id, charlie.id, { reason: 'Policy violation' })).toEqual({
        banned: true,
      });
      expect(rooms.isUserBanned(room.id, charlie.id)).toBe(true);

      const inviteCode = rooms.createInviteCode(bob, room.id, { role: 'VIEWER' });
      expect(() => rooms.redeemInviteCode(charlie, { code: inviteCode.code })).toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );
      expect(() => rooms.createJoinRequest(charlie, room.id)).toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );
      expect(rooms.listRoomsForUser(charlie).listedRooms).toHaveLength(0);

      // Unban Charlie -> Charlie can now redeem the invite code
      expect(rooms.unbanMember(bob, room.id, charlie.id)).toEqual({ unbanned: true });
      expect(rooms.isUserBanned(room.id, charlie.id)).toBe(false);
      expect(rooms.redeemInviteCode(charlie, { code: inviteCode.code }).role).toBe('VIEWER');

      // Mallory (non-member) cannot view room audit log; Charlie (VIEWER) cannot view room audit log
      expect(() => rooms.listRoomAuditLog(mallory, room.id)).toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );
      expect(() => rooms.listRoomAuditLog(charlie, room.id)).toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );

      // Charlie (VIEWER) CAN export workspace data in json, csv, and markdown formats
      const jsonExport = await rooms.exportRoom(charlie, room.id, { format: 'json' });
      expect(roomExportResponseSchema.safeParse(jsonExport).success).toBe(true);
      const csvExport = await rooms.exportRoom(charlie, room.id, { format: 'csv' });
      expect(typeof csvExport.content).toBe('string');
      const mdExport = await rooms.exportRoom(charlie, room.id, { format: 'markdown' });
      expect(typeof mdExport.content).toBe('string');

      db.close();
    });

    it('handles leaving rooms, ownership transfer, stuck-room resolution, room deletion, and audit log entries', async () => {
      const { db, rooms, events, serverAdmin, alice, bob, charlie } = createFixture();

      const room = await rooms.createRoom(alice, {
        name: 'Lifecycle Room',
        visibility: 'private',
      });

      const invBob = rooms.createDirectInvite(alice, room.id, {
        targetUserId: bob.id,
        role: 'EDITOR',
      });
      rooms.respondToInvite(bob, invBob.id, { accept: true });

      // ROOM_OWNER (alice) cannot leave without transferring ownership -> 400 BAD_REQUEST
      expect(() => rooms.leaveRoom(alice, room.id)).toThrowError(
        expect.objectContaining({ code: 'BAD_REQUEST', status: 400 }),
      );

      // Alice transfers ownership to Bob -> Bob becomes ROOM_OWNER, Alice becomes ROOM_ADMIN
      const afterTransfer = rooms.transferOwnership(alice, room.id, {
        newOwnerUserId: bob.id,
      });
      expect(afterTransfer.ownerId).toBe(bob.id);
      expect(rooms.getMemberRole(room.id, bob.id)).toBe('ROOM_OWNER');
      expect(rooms.getMemberRole(room.id, alice.id)).toBe('ROOM_ADMIN');

      // Alice (now ROOM_ADMIN) can leave the room
      expect(rooms.leaveRoom(alice, room.id)).toEqual({ left: true });
      expect(rooms.getMemberRole(room.id, alice.id)).toBeNull();

      // Server Admin resolves stuck room by assigning Charlie as ROOM_OWNER
      const resolved = rooms.resolveStuckRoom(serverAdmin, room.id, {
        userId: charlie.id,
        role: 'ROOM_OWNER',
      });
      expect(resolved.ownerId).toBe(charlie.id);
      expect(rooms.getMemberRole(room.id, charlie.id)).toBe('ROOM_OWNER');
      expect(rooms.getMemberRole(room.id, bob.id)).toBe('ROOM_ADMIN');

      // Verify audit log captured all room mutations
      const auditEntries = rooms.listRoomAuditLog(charlie, room.id);
      const actions = auditEntries.map(e => e.action);
      expect(actions).toContain('rooms:create');
      expect(actions).toContain('member:invite-user');
      expect(actions).toContain('room:accept-direct-invite');
      expect(actions).toContain('room:transfer-ownership');
      expect(actions).toContain('room:leave');
      expect(actions).toContain('rooms:resolve-stuck');
      expect(events.length).toBeGreaterThanOrEqual(5);

      // Charlie deletes the room -> removes DB row and disk workspace directory
      const roomDir = rooms.getRoomDir(room.id);
      expect(existsSync(roomDir)).toBe(true);
      expect(rooms.deleteRoom(charlie, room.id)).toEqual({ deleted: true });
      expect(existsSync(roomDir)).toBe(false);

      await expect(rooms.getRoom(charlie, room.id)).rejects.toThrowError(
        expect.objectContaining({ code: 'NOT_FOUND', status: 404 }),
      );

      db.close();
    });
  });
});
