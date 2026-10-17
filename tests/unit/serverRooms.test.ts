import { afterEach, describe, expect, it } from 'vitest';
import { addItem } from '../../src/main/services/idGenerator.js';
import { addFunction, addModule, createWorkspace } from '../../src/main/services/workspaceFactory.js';
import { AuthService } from '../../src/server/auth.js';
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
import { createTestStore, type TestStoreFixture } from './testDbHelper.js';

describe('T04 / R02: RoomService (rooms, memberships, invites, join requests, kick/ban, transfer, audit on PostgreSQL)', () => {
  const fixtures: TestStoreFixture[] = [];

  afterEach(async () => {
    while (fixtures.length > 0) {
      const f = fixtures.pop()!;
      await f.cleanup();
    }
  });

  async function createFixture() {
    let currentTime = new Date('2026-10-16T04:00:00.000Z');
    const fixture = await createTestStore({ schemaPrefix: 'rooms_test' });
    fixtures.push(fixture);

    const auth = new AuthService(fixture.store, {
      initialSetupToken: 'setup-token-rooms',
      now: () => currentTime,
    });
    const events: RoomLifecycleEvent[] = [];
    const rooms = new RoomService(fixture.store, {
      now: () => currentTime,
      onRoomEvent: ev => events.push(ev),
    });

    const { user: serverOwner } = await auth.claimSetupToken({
      setupToken: 'setup-token-rooms',
      username: 'server_owner',
      displayName: 'Server Owner',
      password: 'password123',
    });

    const serverAdmin = await auth.createUser(serverOwner, {
      username: 'server_admin',
      displayName: 'Server Admin',
      password: 'password123',
      serverRole: 'SERVER_ADMIN',
    });

    const alice = await auth.createUser(serverOwner, {
      username: 'alice',
      displayName: 'Alice Owner',
      password: 'password123',
    });

    const bob = await auth.createUser(serverOwner, {
      username: 'bob',
      displayName: 'Bob Admin',
      password: 'password123',
    });

    const charlie = await auth.createUser(serverOwner, {
      username: 'charlie',
      displayName: 'Charlie Editor',
      password: 'password123',
    });

    const dana = await auth.createUser(serverOwner, {
      username: 'dana',
      displayName: 'Dana Viewer',
      password: 'password123',
    });

    const mallory = await auth.createUser(serverOwner, {
      username: 'mallory',
      displayName: 'Mallory Outsider',
      password: 'password123',
    });

    return {
      fixture,
      store: fixture.store,
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
    it('creates a room with a fresh workspace and persists snapshot in PostgreSQL', async () => {
      const { rooms, alice } = await createFixture();

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

      const loaded = await rooms.loadRoomWorkspace(room.id);
      expect(loaded.config.projectName).toBe('FCS Project');
      expect(loaded.config.projectPrefix).toBe('FCS');

      const detail = await rooms.getRoom(alice, room.id);
      expect(getRoomResponseSchema.safeParse(detail).success).toBe(true);
      expect(detail.workspace.config.projectId).toBe(room.projectId);
      expect(detail.members).toHaveLength(1);
      expect(detail.members[0]?.role).toBe('ROOM_OWNER');
    });

    it('creates a room from an imported Workspace and rejects invalid workspaces', async () => {
      const { rooms, alice } = await createFixture();

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

      // Invalid workspace (broken parent module reference) -> 400 BAD_REQUEST
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
    });

    it('enforces roomCreationMode (all_users vs admins_only)', async () => {
      const { auth, rooms, serverOwner, serverAdmin, alice } = await createFixture();

      // Switch server roomCreationMode to 'admins_only'
      await auth.updateServerSettings(serverOwner, { roomCreationMode: 'admins_only' });

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
    });
  });

  describe('Room Visibility (private vs listed) & Metadata Editing', () => {
    it('shows listed rooms to all non-banned users while hiding private rooms from non-members', async () => {
      const { rooms, serverAdmin, alice, bob } = await createFixture();

      const privateRoom = await rooms.createRoom(alice, {
        name: 'Secret Project',
        visibility: 'private',
      });

      const listedRoom = await rooms.createRoom(alice, {
        name: 'Open Architecture Room',
        visibility: 'listed',
      });

      // Bob is not a member of either room: sees only listedRoom in listedRooms, and 0 in myRooms
      const bobLobby = await rooms.listRoomsForUser(bob);
      expect(listRoomsResponseSchema.safeParse(bobLobby).success).toBe(true);
      expect(bobLobby.myRooms).toHaveLength(0);
      expect(bobLobby.listedRooms.map(r => r.id)).toEqual([listedRoom.id]);

      // Bob cannot fetch privateRoom details -> 403 FORBIDDEN
      await expect(rooms.getRoom(bob, privateRoom.id)).rejects.toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );

      // Server Admin can list all rooms (including private) and inspect privateRoom
      const allAdminRooms = await rooms.listAllRoomsAdmin(serverAdmin);
      expect(allAdminRooms.map(r => r.id).sort()).toEqual([listedRoom.id, privateRoom.id].sort());
      const adminView = await rooms.getRoom(serverAdmin, privateRoom.id);
      expect(adminView.room.id).toBe(privateRoom.id);

      // Alice updates privateRoom to 'listed' and renames it
      const updated = await rooms.updateRoom(alice, privateRoom.id, {
        name: 'Now Public Project',
        visibility: 'listed',
      });
      expect(updated.name).toBe('Now Public Project');
      expect(updated.visibility).toBe('listed');
      const updatedBobLobby = await rooms.listRoomsForUser(bob);
      expect(updatedBobLobby.listedRooms).toHaveLength(2);
    });
  });

  describe('Direct Invites & Invite Codes (Expiry, Max Uses, Revocation)', () => {
    it('handles direct user invites, role limits (ROOM_ADMIN vs ROOM_OWNER), accept/decline, and revocation', async () => {
      const { rooms, alice, bob, charlie, dana, mallory } = await createFixture();

      const room = await rooms.createRoom(alice, {
        name: 'Invite Test Room',
        visibility: 'private',
      });

      // Alice (ROOM_OWNER) invites Bob as ROOM_ADMIN
      const bobInvite = await rooms.createDirectInvite(alice, room.id, {
        targetUserId: bob.id,
        role: 'ROOM_ADMIN',
      });
      expect(directInviteSummarySchema.safeParse(bobInvite).success).toBe(true);
      expect(bobInvite.role).toBe('ROOM_ADMIN');

      // Duplicate pending invite for Bob -> 409 CONFLICT
      await expect(
        rooms.createDirectInvite(alice, room.id, {
          targetUserId: bob.id,
          role: 'EDITOR',
        }),
      ).rejects.toThrowError(expect.objectContaining({ code: 'CONFLICT', status: 409 }));

      // Mallory cannot accept Bob's invite -> 403 FORBIDDEN
      await expect(rooms.respondToInvite(mallory, bobInvite.id, { accept: true })).rejects.toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );

      // Bob sees the invite in listRoomsForUser and accepts it
      const bobLobby = await rooms.listRoomsForUser(bob);
      expect(bobLobby.myInvites).toHaveLength(1);
      const bobAccept = await rooms.respondToInvite(bob, bobInvite.id, { accept: true });
      expect(bobAccept).toEqual({
        accepted: true,
        roomId: room.id,
        role: 'ROOM_ADMIN',
      });
      expect(await rooms.getMemberRole(room.id, bob.id)).toBe('ROOM_ADMIN');

      // Bob (ROOM_ADMIN) CANNOT invite Charlie as ROOM_ADMIN -> 403 FORBIDDEN
      await expect(
        rooms.createDirectInvite(bob, room.id, {
          targetUserId: charlie.id,
          role: 'ROOM_ADMIN',
        }),
      ).rejects.toThrowError(expect.objectContaining({ code: 'FORBIDDEN', status: 403 }));

      // Bob (ROOM_ADMIN) CAN invite Charlie as EDITOR and Dana as VIEWER
      const charlieInvite = await rooms.createDirectInvite(bob, room.id, {
        targetUserId: charlie.id,
        role: 'EDITOR',
      });
      const danaInvite = await rooms.createDirectInvite(bob, room.id, {
        targetUserId: dana.id,
        role: 'VIEWER',
      });

      // Charlie declines the invite
      const charlieDecline = await rooms.respondToInvite(charlie, charlieInvite.id, { accept: false });
      expect(charlieDecline).toEqual({ accepted: false });
      expect(await rooms.getMemberRole(room.id, charlie.id)).toBeNull();

      // Bob revokes Dana's invite before she responds
      expect(await rooms.revokeInvite(bob, room.id, danaInvite.id)).toEqual({ revoked: true });
      await expect(rooms.respondToInvite(dana, danaInvite.id, { accept: true })).rejects.toThrowError(
        expect.objectContaining({ code: 'BAD_REQUEST', status: 400 }),
      );
    });

    it('enforces maxUses and expiresAt on shareable invite codes', async () => {
      const { rooms, alice, bob, charlie, dana, advanceTimeMs } = await createFixture();

      const room = await rooms.createRoom(alice, {
        name: 'Code Test Room',
        visibility: 'private',
      });

      // Create an invite code with maxUses = 2 and expiresInSeconds = 60
      const codeInfo = await rooms.createInviteCode(alice, room.id, {
        role: 'EDITOR',
        maxUses: 2,
        expiresInSeconds: 60,
      });
      expect(inviteCodeInfoSchema.safeParse(codeInfo).success).toBe(true);
      expect(codeInfo.maxUses).toBe(2);
      expect(codeInfo.uses).toBe(0);

      // Use #1: Bob redeems
      const bobRedeem = await rooms.redeemInviteCode(bob, { code: codeInfo.code });
      expect(bobRedeem.role).toBe('EDITOR');
      expect(bobRedeem.room.id).toBe(room.id);

      // Bob cannot redeem again (already a member) -> 409 CONFLICT
      await expect(rooms.redeemInviteCode(bob, { code: codeInfo.code })).rejects.toThrowError(
        expect.objectContaining({ code: 'CONFLICT', status: 409 }),
      );

      // Use #2: Charlie redeems
      const charlieRedeem = await rooms.redeemInviteCode(charlie, { code: codeInfo.code });
      expect(charlieRedeem.role).toBe('EDITOR');

      // Use #3: Dana tries to redeem after maxUses (2) reached -> 400 BAD_REQUEST
      await expect(rooms.redeemInviteCode(dana, { code: codeInfo.code })).rejects.toThrowError(
        expect.objectContaining({ code: 'BAD_REQUEST', status: 400 }),
      );

      // Create a second code that expires in 30 seconds
      const expiringCode = await rooms.createInviteCode(alice, room.id, {
        role: 'VIEWER',
        expiresInSeconds: 30,
      });
      advanceTimeMs(31_000);

      // Dana tries to redeem expired code -> 400 BAD_REQUEST
      await expect(rooms.redeemInviteCode(dana, { code: expiringCode.code })).rejects.toThrowError(
        expect.objectContaining({ code: 'BAD_REQUEST', status: 400 }),
      );
    });
  });

  describe('Join Requests on Listed Rooms (Approve with Role vs Reject)', () => {
    it('supports submitting join requests to listed rooms and admin approval/rejection', async () => {
      const { rooms, alice, bob, charlie, dana } = await createFixture();

      const privateRoom = await rooms.createRoom(alice, {
        name: 'Private Room',
        visibility: 'private',
      });
      const listedRoom = await rooms.createRoom(alice, {
        name: 'Listed Room',
        visibility: 'listed',
      });

      // Cannot request to join a private room -> 403 FORBIDDEN
      await expect(
        rooms.createJoinRequest(bob, privateRoom.id, { message: 'Let me in' }),
      ).rejects.toThrowError(expect.objectContaining({ code: 'FORBIDDEN', status: 403 }));

      // Bob requests to join listedRoom
      const bobReq = await rooms.createJoinRequest(bob, listedRoom.id, {
        message: 'I work on the propulsion subsystem.',
      });
      expect(joinRequestSummarySchema.safeParse(bobReq).success).toBe(true);
      expect(bobReq.status).toBe('PENDING');

      // Bob's lobby shows hasPendingJoinRequest = true and myJoinRequests
      const bobLobby = await rooms.listRoomsForUser(bob);
      expect(bobLobby.listedRooms[0]?.hasPendingJoinRequest).toBe(true);
      expect(bobLobby.myJoinRequests).toHaveLength(1);

      // Duplicate pending request -> 409 CONFLICT
      await expect(rooms.createJoinRequest(bob, listedRoom.id)).rejects.toThrowError(
        expect.objectContaining({ code: 'CONFLICT', status: 409 }),
      );

      // Charlie also requests to join
      const charlieReq = await rooms.createJoinRequest(charlie, listedRoom.id, {
        message: 'Requesting editor access',
      });

      // Dana (non-member) cannot review join requests -> 403 FORBIDDEN
      await expect(
        rooms.reviewJoinRequest(dana, listedRoom.id, bobReq.id, {
          approve: true,
          role: 'EDITOR',
        }),
      ).rejects.toThrowError(expect.objectContaining({ code: 'FORBIDDEN', status: 403 }));

      // Alice approves Bob as EDITOR
      const reviewedBob = await rooms.reviewJoinRequest(alice, listedRoom.id, bobReq.id, {
        approve: true,
        role: 'EDITOR',
      });
      expect(reviewedBob.status).toBe('APPROVED');
      expect(reviewedBob.assignedRole).toBe('EDITOR');
      expect(await rooms.getMemberRole(listedRoom.id, bob.id)).toBe('EDITOR');

      // Bob (EDITOR) cannot review Charlie's join request -> 403 FORBIDDEN
      await expect(
        rooms.reviewJoinRequest(bob, listedRoom.id, charlieReq.id, {
          approve: true,
          role: 'VIEWER',
        }),
      ).rejects.toThrowError(expect.objectContaining({ code: 'FORBIDDEN', status: 403 }));

      // Alice rejects Charlie's join request
      const reviewedCharlie = await rooms.reviewJoinRequest(alice, listedRoom.id, charlieReq.id, {
        approve: false,
      });
      expect(reviewedCharlie.status).toBe('REJECTED');
      expect(reviewedCharlie.assignedRole).toBeNull();
      expect(await rooms.getMemberRole(listedRoom.id, charlie.id)).toBeNull();
    });
  });

  describe('Role Changes, Kick, Ban/Unban, Leave, Ownership Transfer, and Stuck Room Resolution', () => {
    it('enforces ROOM_ADMIN vs ROOM_OWNER role change rules and kick/ban restrictions', async () => {
      const { rooms, alice, bob, charlie, dana, mallory } = await createFixture();

      const room = await rooms.createRoom(alice, {
        name: 'Permissions Room',
        visibility: 'listed',
      });

      // Invite and add Bob (ROOM_ADMIN), Charlie (EDITOR), Dana (VIEWER)
      const invBob = await rooms.createDirectInvite(alice, room.id, {
        targetUserId: bob.id,
        role: 'ROOM_ADMIN',
      });
      await rooms.respondToInvite(bob, invBob.id, { accept: true });

      const invCharlie = await rooms.createDirectInvite(bob, room.id, {
        targetUserId: charlie.id,
        role: 'EDITOR',
      });
      await rooms.respondToInvite(charlie, invCharlie.id, { accept: true });

      const invDana = await rooms.createDirectInvite(bob, room.id, {
        targetUserId: dana.id,
        role: 'VIEWER',
      });
      await rooms.respondToInvite(dana, invDana.id, { accept: true });

      // Bob (ROOM_ADMIN) can change Dana (VIEWER) -> EDITOR and Charlie (EDITOR) -> VIEWER
      const updatedDana = await rooms.changeMemberRole(bob, room.id, dana.id, { role: 'EDITOR' });
      expect(roomMemberInfoSchema.safeParse(updatedDana).success).toBe(true);
      expect(updatedDana.role).toBe('EDITOR');

      const updatedCharlie = await rooms.changeMemberRole(bob, room.id, charlie.id, { role: 'VIEWER' });
      expect(updatedCharlie.role).toBe('VIEWER');

      // Bob (ROOM_ADMIN) CANNOT promote Dana to ROOM_ADMIN -> 403 FORBIDDEN
      await expect(
        rooms.changeMemberRole(bob, room.id, dana.id, { role: 'ROOM_ADMIN' }),
      ).rejects.toThrowError(expect.objectContaining({ code: 'FORBIDDEN', status: 403 }));

      // Alice (ROOM_OWNER) CAN promote Dana to ROOM_ADMIN and demote her back to VIEWER
      const promotedDana = await rooms.changeMemberRole(alice, room.id, dana.id, { role: 'ROOM_ADMIN' });
      expect(promotedDana.role).toBe('ROOM_ADMIN');

      // While Dana is ROOM_ADMIN, Bob (ROOM_ADMIN) cannot demote or kick/ban her -> 403 FORBIDDEN
      await expect(
        rooms.changeMemberRole(bob, room.id, dana.id, { role: 'VIEWER' }),
      ).rejects.toThrowError(expect.objectContaining({ code: 'FORBIDDEN', status: 403 }));
      await expect(rooms.kickMember(bob, room.id, dana.id)).rejects.toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );
      await expect(rooms.banMember(bob, room.id, dana.id)).rejects.toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );

      // Alice demotes Dana back to VIEWER
      const demotedDana = await rooms.changeMemberRole(alice, room.id, dana.id, { role: 'VIEWER' });
      expect(demotedDana.role).toBe('VIEWER');

      // Bob (ROOM_ADMIN) kicks Charlie (VIEWER)
      expect(await rooms.kickMember(bob, room.id, charlie.id, { reason: 'Inactive' })).toEqual({
        kicked: true,
      });
      expect(await rooms.getMemberRole(room.id, charlie.id)).toBeNull();

      // Kicked user (not banned) can still request to join again
      const charlieRejoinReq = await rooms.createJoinRequest(charlie, room.id, {
        message: 'Back online',
      });
      expect(charlieRejoinReq.status).toBe('PENDING');

      // Bob (ROOM_ADMIN) bans Charlie -> removes membership/pending requests and blocks all rejoin paths
      expect(await rooms.banMember(bob, room.id, charlie.id, { reason: 'Policy violation' })).toEqual({
        banned: true,
      });
      expect(await rooms.isUserBanned(room.id, charlie.id)).toBe(true);

      const inviteCode = await rooms.createInviteCode(bob, room.id, { role: 'VIEWER' });
      await expect(rooms.redeemInviteCode(charlie, { code: inviteCode.code })).rejects.toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );
      await expect(rooms.createJoinRequest(charlie, room.id)).rejects.toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );
      const charlieLobby = await rooms.listRoomsForUser(charlie);
      expect(charlieLobby.listedRooms).toHaveLength(0);

      // Unban Charlie -> Charlie can now redeem the invite code
      expect(await rooms.unbanMember(bob, room.id, charlie.id)).toEqual({ unbanned: true });
      expect(await rooms.isUserBanned(room.id, charlie.id)).toBe(false);
      const charlieRedeemed = await rooms.redeemInviteCode(charlie, { code: inviteCode.code });
      expect(charlieRedeemed.role).toBe('VIEWER');

      // Mallory (non-member) cannot view room audit log; Charlie (VIEWER) cannot view room audit log
      await expect(rooms.listRoomAuditLog(mallory, room.id)).rejects.toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );
      await expect(rooms.listRoomAuditLog(charlie, room.id)).rejects.toThrowError(
        expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
      );

      // Charlie (VIEWER) CAN export workspace data in json, csv, and markdown formats
      const jsonExport = await rooms.exportRoom(charlie, room.id, { format: 'json' });
      expect(roomExportResponseSchema.safeParse(jsonExport).success).toBe(true);
      const csvExport = await rooms.exportRoom(charlie, room.id, { format: 'csv' });
      expect(typeof csvExport.content).toBe('string');
      const mdExport = await rooms.exportRoom(charlie, room.id, { format: 'markdown' });
      expect(typeof mdExport.content).toBe('string');
    });

    it('handles leaving rooms, ownership transfer, stuck-room resolution, room deletion, and audit log entries', async () => {
      const { rooms, events, serverAdmin, alice, bob, charlie } = await createFixture();

      const room = await rooms.createRoom(alice, {
        name: 'Lifecycle Room',
        visibility: 'private',
      });

      const invBob = await rooms.createDirectInvite(alice, room.id, {
        targetUserId: bob.id,
        role: 'EDITOR',
      });
      await rooms.respondToInvite(bob, invBob.id, { accept: true });

      // ROOM_OWNER (alice) cannot leave without transferring ownership -> 400 BAD_REQUEST
      await expect(rooms.leaveRoom(alice, room.id)).rejects.toThrowError(
        expect.objectContaining({ code: 'BAD_REQUEST', status: 400 }),
      );

      // Alice transfers ownership to Bob -> Bob becomes ROOM_OWNER, Alice becomes ROOM_ADMIN
      const afterTransfer = await rooms.transferOwnership(alice, room.id, {
        newOwnerUserId: bob.id,
      });
      expect(afterTransfer.ownerId).toBe(bob.id);
      expect(await rooms.getMemberRole(room.id, bob.id)).toBe('ROOM_OWNER');
      expect(await rooms.getMemberRole(room.id, alice.id)).toBe('ROOM_ADMIN');

      // Alice (now ROOM_ADMIN) can leave the room
      expect(await rooms.leaveRoom(alice, room.id)).toEqual({ left: true });
      expect(await rooms.getMemberRole(room.id, alice.id)).toBeNull();

      // Server Admin resolves stuck room by assigning Charlie as ROOM_OWNER
      const resolved = await rooms.resolveStuckRoom(serverAdmin, room.id, {
        userId: charlie.id,
        role: 'ROOM_OWNER',
      });
      expect(resolved.ownerId).toBe(charlie.id);
      expect(await rooms.getMemberRole(room.id, charlie.id)).toBe('ROOM_OWNER');
      expect(await rooms.getMemberRole(room.id, bob.id)).toBe('ROOM_ADMIN');

      // Verify audit log captured all room mutations
      const auditEntries = await rooms.listRoomAuditLog(charlie, room.id);
      const actions = auditEntries.map(e => e.action);
      expect(actions).toContain('rooms:create');
      expect(actions).toContain('member:invite-user');
      expect(actions).toContain('room:accept-direct-invite');
      expect(actions).toContain('room:transfer-ownership');
      expect(actions).toContain('room:leave');
      expect(actions).toContain('rooms:resolve-stuck');
      expect(events.length).toBeGreaterThanOrEqual(5);

      // Charlie deletes the room -> removes DB row
      expect(await rooms.deleteRoom(charlie, room.id)).toEqual({ deleted: true });

      await expect(rooms.getRoom(charlie, room.id)).rejects.toThrowError(
        expect.objectContaining({ code: 'NOT_FOUND', status: 404 }),
      );
    });
  });
});
