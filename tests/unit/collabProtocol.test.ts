import { describe, expect, it } from 'vitest';
import { createWorkspace } from '../../src/main/services/workspaceFactory.js';
import {
  adminCreateUserRequestSchema,
  adminListRoomsResponseSchema,
  adminListUsersResponseSchema,
  adminResetPasswordRequestSchema,
  adminResetPasswordResponseSchema,
  adminResolveRoomRequestSchema,
  adminUpdateUserRequestSchema,
  adminUserResponseSchema,
  apiErrorEnvelopeSchema,
  apiSuccessEnvelopeSchema,
  auditListResponseSchema,
  authSessionResponseSchema,
  awarenessUserStateSchema,
  banMemberResponseSchema,
  createDirectInviteRequestSchema,
  createDirectInviteResponseSchema,
  createInviteCodeRequestSchema,
  createInviteCodeResponseSchema,
  createJoinRequestSchema,
  createRevisionRequestSchema,
  createRevisionResponseSchema,
  createRoomRequestSchema,
  deleteRoomResponseSchema,
  discoveryBeaconSchema,
  getRevisionDiffResponseSchema,
  getRevisionResponseSchema,
  getRoomResponseSchema,
  joinRequestResponseSchema,
  kickMemberResponseSchema,
  kickOrBanMemberRequestSchema,
  leaveRoomResponseSchema,
  listRevisionsResponseSchema,
  listRoomsResponseSchema,
  loginRequestSchema,
  logoutRequestSchema,
  logoutResponseSchema,
  meResponseSchema,
  redeemInviteCodeRequestSchema,
  redeemInviteCodeResponseSchema,
  registerRequestSchema,
  registerResponseSchema,
  respondInviteRequestSchema,
  respondInviteResponseSchema,
  restoreRevisionResponseSchema,
  reviewJoinRequestSchema,
  revokeInviteResponseSchema,
  roomExportQuerySchema,
  roomExportResponseSchema,
  roomSummaryResponseSchema,
  serverPublicInfoSchema,
  setupRequestSchema,
  transferOwnershipRequestSchema,
  unbanMemberResponseSchema,
  updateRoomMemberRoleRequestSchema,
  updateRoomMemberRoleResponseSchema,
  updateRoomRequestSchema,
  updateServerSettingsRequestSchema,
  updateServerSettingsResponseSchema,
  userDirectoryResponseSchema,
  wsClientMessageSchema,
  wsServerMessageSchema,
} from '../../src/shared/collab/protocol.js';
import {
  assignUserColor,
  COLLAB_USER_COLORS,
  DISCOVERY_BEACON_MAGIC,
} from '../../src/shared/collab/types.js';

const nowIso = '2026-10-16T00:00:00.000Z';

const sampleUser = {
  id: 'usr_11111111-1111-1111-1111-111111111111',
  username: 'alice_eng',
  displayName: 'Alice Engineer',
  serverRole: 'SERVER_OWNER' as const,
  status: 'ACTIVE' as const,
  createdAt: nowIso,
  updatedAt: nowIso,
};

const sampleRoomSummary = {
  id: 'room_22222222-2222-2222-2222-222222222222',
  name: 'Flight Control Room',
  visibility: 'listed' as const,
  ownerId: sampleUser.id,
  ownerDisplayName: sampleUser.displayName,
  projectId: 'PRJ-1234',
  projectName: 'Flight Control System',
  myRole: 'ROOM_OWNER' as const,
  memberCount: 3,
  onlineCount: 2,
  lastAutosavedAt: nowIso,
  createdAt: nowIso,
  updatedAt: nowIso,
};

const sampleRevision = {
  id: 'rev_33333333-3333-3333-3333-333333333333',
  roomId: sampleRoomSummary.id,
  seq: 1,
  message: 'Initial baseline',
  authorId: sampleUser.id,
  authorName: sampleUser.displayName,
  snapshotFilename: 'rev_33333333-3333-3333-3333-333333333333.json',
  restoredFromId: null,
  createdAt: nowIso,
};

describe('Collaboration Protocol Schemas', () => {
  it('assigns deterministic user colors from COLLAB_USER_COLORS', () => {
    const color1 = assignUserColor('usr_abc');
    const color2 = assignUserColor('usr_abc');
    expect(color1).toBe(color2);
    expect(COLLAB_USER_COLORS).toContain(color1);
  });

  it('validates REST response envelopes and Public / Auth schemas', () => {
    const publicInfo = {
      serverId: 'srv_1',
      name: 'Avionics HLR Server',
      version: '0.6.0',
      tls: true,
      fingerprint: 'SHA256:4F:8A:12:BC',
      setupRequired: false,
      registrationMode: 'open' as const,
      roomCreationMode: 'all_users' as const,
    };
    const envelopeSchema = apiSuccessEnvelopeSchema(serverPublicInfoSchema);
    expect(envelopeSchema.parse({ ok: true, value: publicInfo }).value.name).toBe('Avionics HLR Server');

    expect(
      apiErrorEnvelopeSchema.parse({
        ok: false,
        code: 'FORBIDDEN',
        error: 'Insufficient permissions',
      }).code,
    ).toBe('FORBIDDEN');

    expect(
      setupRequestSchema.parse({
        setupToken: 'tok_setup_123',
        username: 'alice_eng',
        displayName: 'Alice Engineer',
        password: 'correct-horse-battery',
      }).username,
    ).toBe('alice_eng');

    expect(() =>
      setupRequestSchema.parse({
        setupToken: 'tok',
        username: 'bad username with spaces',
        displayName: 'Alice',
        password: 'secret-password',
      }),
    ).toThrow();

    expect(
      authSessionResponseSchema.parse({
        user: sampleUser,
        token: 'sess_token_123',
        expiresAt: nowIso,
      }).user.id,
    ).toBe(sampleUser.id);

    expect(
      registerRequestSchema.parse({
        username: 'bob_dev',
        displayName: 'Bob Dev',
        password: 'password123',
      }).username,
    ).toBe('bob_dev');

    expect(
      registerResponseSchema.parse({
        status: 'ACTIVE',
        user: sampleUser,
        token: 'sess_token_123',
        expiresAt: nowIso,
      }).status,
    ).toBe('ACTIVE');

    expect(
      registerResponseSchema.parse({
        status: 'PENDING_APPROVAL',
        user: { ...sampleUser, status: 'PENDING_APPROVAL' },
      }).status,
    ).toBe('PENDING_APPROVAL');

    expect(loginRequestSchema.parse({ username: 'alice_eng', password: 'pw' }).username).toBe('alice_eng');
    expect(logoutRequestSchema.parse({})).toEqual({});
    expect(logoutResponseSchema.parse({ loggedOut: true }).loggedOut).toBe(true);
    expect(meResponseSchema.parse({ user: sampleUser }).user.username).toBe('alice_eng');
    expect(
      userDirectoryResponseSchema.parse({
        users: [{ id: sampleUser.id, username: sampleUser.username, displayName: sampleUser.displayName }],
      }).users,
    ).toHaveLength(1);
  });

  it('validates Server Administration REST schemas', () => {
    expect(
      updateServerSettingsRequestSchema.parse({
        name: 'Updated Server',
        registrationMode: 'approval',
        roomCreationMode: 'admins_only',
      }).registrationMode,
    ).toBe('approval');
    expect(() => updateServerSettingsRequestSchema.parse({})).toThrow();

    expect(
      updateServerSettingsResponseSchema.parse({
        settings: {
          serverId: 'srv_1',
          name: 'Updated Server',
          registrationMode: 'approval',
          roomCreationMode: 'admins_only',
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      }).settings.serverId,
    ).toBe('srv_1');

    expect(adminListUsersResponseSchema.parse({ users: [sampleUser] }).users).toHaveLength(1);
    expect(
      adminCreateUserRequestSchema.parse({
        username: 'charlie',
        displayName: 'Charlie',
        password: 'password123',
        serverRole: 'SERVER_ADMIN',
      }).serverRole,
    ).toBe('SERVER_ADMIN');
    expect(adminUserResponseSchema.parse({ user: sampleUser }).user.id).toBe(sampleUser.id);
    expect(adminUpdateUserRequestSchema.parse({ status: 'DISABLED' }).status).toBe('DISABLED');
    expect(() => adminUpdateUserRequestSchema.parse({})).toThrow();
    expect(adminResetPasswordRequestSchema.parse({ newPassword: 'newpassword123' }).newPassword).toBe(
      'newpassword123',
    );
    expect(adminResetPasswordResponseSchema.parse({ reset: true }).reset).toBe(true);
    expect(adminListRoomsResponseSchema.parse({ rooms: [sampleRoomSummary] }).rooms).toHaveLength(1);
    expect(
      adminResolveRoomRequestSchema.parse({ userId: sampleUser.id, role: 'ROOM_ADMIN' }).role,
    ).toBe('ROOM_ADMIN');
    expect(
      auditListResponseSchema.parse({
        entries: [
          {
            id: 'aud_1',
            roomId: sampleRoomSummary.id,
            actorId: sampleUser.id,
            actorName: sampleUser.displayName,
            action: 'room.created',
            targetId: sampleRoomSummary.id,
            details: { visibility: 'listed' },
            createdAt: nowIso,
          },
        ],
      }).entries,
    ).toHaveLength(1);
  });

  it('validates Room Lobby, Membership, Invites, Join Requests, and Revisions REST schemas', () => {
    const ws = createWorkspace('Flight Control System', 'FCS');

    const directInvite = {
      id: 'inv_1',
      roomId: sampleRoomSummary.id,
      roomName: sampleRoomSummary.name,
      kind: 'direct' as const,
      targetUserId: 'usr_2',
      targetUsername: 'bob',
      targetDisplayName: 'Bob',
      role: 'EDITOR' as const,
      createdBy: sampleUser.id,
      createdByDisplayName: sampleUser.displayName,
      status: 'PENDING' as const,
      createdAt: nowIso,
    };

    const inviteCode = {
      id: 'inv_2',
      roomId: sampleRoomSummary.id,
      kind: 'code' as const,
      code: 'HLR-ABCD-1234',
      role: 'VIEWER' as const,
      createdBy: sampleUser.id,
      status: 'PENDING' as const,
      uses: 1,
      maxUses: 10,
      expiresAt: nowIso,
      createdAt: nowIso,
    };

    const joinReq = {
      id: 'jreq_1',
      roomId: sampleRoomSummary.id,
      roomName: sampleRoomSummary.name,
      userId: 'usr_3',
      username: 'dana',
      displayName: 'Dana',
      message: 'Please let me join the review',
      status: 'PENDING' as const,
      assignedRole: null,
      reviewedBy: null,
      createdAt: nowIso,
      reviewedAt: null,
    };

    expect(
      listRoomsResponseSchema.parse({
        myRooms: [sampleRoomSummary],
        listedRooms: [
          {
            id: sampleRoomSummary.id,
            name: sampleRoomSummary.name,
            visibility: 'listed',
            ownerId: sampleUser.id,
            ownerDisplayName: sampleUser.displayName,
            projectId: sampleRoomSummary.projectId,
            projectName: sampleRoomSummary.projectName,
            memberCount: 3,
            hasPendingJoinRequest: false,
            createdAt: nowIso,
            updatedAt: nowIso,
          },
        ],
        myInvites: [directInvite],
        myJoinRequests: [joinReq],
      }).myRooms,
    ).toHaveLength(1);

    expect(
      createRoomRequestSchema.parse({
        name: 'Flight Control Room',
        visibility: 'private',
        projectName: 'Flight Control System',
        projectPrefix: 'FCS',
        workspace: ws,
      }).name,
    ).toBe('Flight Control Room');

    expect(roomSummaryResponseSchema.parse({ room: sampleRoomSummary }).room.id).toBe(sampleRoomSummary.id);

    expect(
      getRoomResponseSchema.parse({
        room: sampleRoomSummary,
        members: [
          {
            roomId: sampleRoomSummary.id,
            userId: sampleUser.id,
            username: sampleUser.username,
            displayName: sampleUser.displayName,
            role: 'ROOM_OWNER',
            joinedAt: nowIso,
            online: true,
            color: '#3b82f6',
          },
        ],
        invites: [directInvite, inviteCode],
        joinRequests: [joinReq],
        bans: [
          {
            roomId: sampleRoomSummary.id,
            userId: 'usr_9',
            username: 'mallory',
            displayName: 'Mallory',
            bannedBy: sampleUser.id,
            reason: 'Spam',
            bannedAt: nowIso,
          },
        ],
        workspace: ws,
      }).invites,
    ).toHaveLength(2);

    expect(updateRoomRequestSchema.parse({ visibility: 'listed' }).visibility).toBe('listed');
    expect(() => updateRoomRequestSchema.parse({})).toThrow();
    expect(deleteRoomResponseSchema.parse({ deleted: true }).deleted).toBe(true);
    expect(leaveRoomResponseSchema.parse({ left: true }).left).toBe(true);
    expect(transferOwnershipRequestSchema.parse({ newOwnerUserId: 'usr_2' }).newOwnerUserId).toBe('usr_2');
    expect(
      createDirectInviteRequestSchema.parse({ targetUserId: 'usr_2', role: 'EDITOR' }).role,
    ).toBe('EDITOR');
    expect(createDirectInviteResponseSchema.parse({ invite: directInvite }).invite.id).toBe('inv_1');
    expect(respondInviteRequestSchema.parse({ accept: true }).accept).toBe(true);
    expect(
      respondInviteResponseSchema.parse({ accepted: true, roomId: sampleRoomSummary.id, role: 'EDITOR' })
        .accepted,
    ).toBe(true);
    expect(
      createInviteCodeRequestSchema.parse({ role: 'VIEWER', expiresInSeconds: 3600, maxUses: 5 }).maxUses,
    ).toBe(5);
    expect(createInviteCodeResponseSchema.parse({ inviteCode }).inviteCode.code).toBe('HLR-ABCD-1234');
    expect(redeemInviteCodeRequestSchema.parse({ code: 'HLR-ABCD-1234' }).code).toBe('HLR-ABCD-1234');
    expect(
      redeemInviteCodeResponseSchema.parse({ room: sampleRoomSummary, role: 'VIEWER' }).role,
    ).toBe('VIEWER');
    expect(revokeInviteResponseSchema.parse({ revoked: true }).revoked).toBe(true);
    expect(createJoinRequestSchema.parse({ message: 'Hello' }).message).toBe('Hello');
    expect(joinRequestResponseSchema.parse({ joinRequest: joinReq }).joinRequest.id).toBe('jreq_1');
    expect(reviewJoinRequestSchema.parse({ approve: true, role: 'EDITOR' }).role).toBe('EDITOR');
    expect(updateRoomMemberRoleRequestSchema.parse({ role: 'EDITOR' }).role).toBe('EDITOR');
    expect(
      updateRoomMemberRoleResponseSchema.parse({
        member: {
          roomId: sampleRoomSummary.id,
          userId: 'usr_2',
          username: 'bob',
          displayName: 'Bob',
          role: 'EDITOR',
          joinedAt: nowIso,
        },
      }).member.role,
    ).toBe('EDITOR');
    expect(kickOrBanMemberRequestSchema.parse({ reason: 'Policy' }).reason).toBe('Policy');
    expect(kickMemberResponseSchema.parse({ kicked: true }).kicked).toBe(true);
    expect(banMemberResponseSchema.parse({ banned: true }).banned).toBe(true);
    expect(unbanMemberResponseSchema.parse({ unbanned: true }).unbanned).toBe(true);
    expect(roomExportQuerySchema.parse({ format: 'csv', objectType: 'REQUIREMENT' }).format).toBe('csv');
    expect(roomExportResponseSchema.parse({ format: 'json', content: ws }).format).toBe('json');

    // Revisions
    expect(listRevisionsResponseSchema.parse({ revisions: [sampleRevision] }).revisions).toHaveLength(1);
    expect(createRevisionRequestSchema.parse({ message: 'Milestone 1' }).message).toBe('Milestone 1');
    expect(createRevisionResponseSchema.parse({ revision: sampleRevision }).revision.seq).toBe(1);
    expect(getRevisionResponseSchema.parse({ revision: sampleRevision, workspace: ws }).revision.id).toBe(
      sampleRevision.id,
    );
    expect(
      getRevisionDiffResponseSchema.parse({
        diff: {
          fromRevisionId: sampleRevision.id,
          toTarget: 'current',
          configChanged: false,
          modules: { added: [], modified: [], deleted: [] },
          functions: { added: [], modified: [], deleted: [] },
          items: {
            added: [{ id: 'REQ-FCS-001', objectType: 'REQUIREMENT', functionId: 'fn_1' }],
            modified: [],
            deleted: [],
          },
        },
      }).diff.items.added,
    ).toHaveLength(1);
    expect(restoreRevisionResponseSchema.parse({ revision: sampleRevision, workspace: ws }).revision.seq).toBe(
      1,
    );
  });

  it('validates Awareness state and WebSocket Client & Server messages', () => {
    const awarenessState = {
      userId: sampleUser.id,
      username: sampleUser.username,
      displayName: sampleUser.displayName,
      role: 'ROOM_OWNER' as const,
      color: '#3b82f6',
      view: {
        objectType: 'REQUIREMENT' as const,
        kind: 'function' as const,
        id: 'fn_1234',
      },
      focus: {
        objectType: 'REQUIREMENT' as const,
        functionId: 'fn_1234',
        itemId: 'REQ-FCS-001',
        columnId: 'col_desc',
        cursor: { anchor: 0, head: 12 },
      },
      updatedAt: 1760573748000,
    };

    expect(awarenessUserStateSchema.parse(awarenessState).userId).toBe(sampleUser.id);

    const b64 = Buffer.from([1, 2, 3, 4]).toString('base64');

    const clientMessages = [
      { type: 'sync-step1', stateVector: b64 },
      { type: 'sync-update', update: b64, clientOpId: 'op_1' },
      { type: 'awareness-update', state: awarenessState },
      { type: 'awareness-update', state: null },
      {
        type: 'alloc-item',
        requestId: 'req_1',
        tempId: '__pending__:1',
        objectType: 'REQUIREMENT',
        functionId: 'fn_1234',
        values: { col_desc: 'The system shall...', col_status: 'Draft' },
      },
      { type: 'ping', timestamp: 1760573748000 },
    ];

    for (const msg of clientMessages) {
      expect(wsClientMessageSchema.parse(msg).type).toBe(msg.type);
    }

    const onlineMember = {
      userId: sampleUser.id,
      username: sampleUser.username,
      displayName: sampleUser.displayName,
      role: 'ROOM_OWNER' as const,
      color: '#3b82f6',
    };

    const serverMessages = [
      {
        type: 'room-welcome',
        roomId: sampleRoomSummary.id,
        role: 'ROOM_OWNER',
        stateUpdate: b64,
        awarenessStates: [awarenessState],
        onlineMembers: [onlineMember],
        autosaveStatus: { status: 'autosaved', lastAutosavedAt: nowIso },
        lastRevision: sampleRevision,
      },
      { type: 'sync-step2', update: b64 },
      { type: 'sync-update', update: b64, actorUserId: sampleUser.id, clientOpId: 'op_1' },
      {
        type: 'alloc-item-ack',
        requestId: 'req_1',
        tempId: '__pending__:1',
        objectType: 'REQUIREMENT',
        functionId: 'fn_1234',
        item: {
          id: 'REQ-FCS-001',
          seq: 1,
          created_at: nowIso,
          values: { col_desc: 'The system shall...', col_status: 'Draft' },
        },
      },
      {
        type: 'awareness-broadcast',
        states: [awarenessState],
        onlineMembers: [onlineMember],
      },
      {
        type: 'autosave-status',
        status: 'autosaved',
        lastAutosavedAt: nowIso,
      },
      {
        type: 'revision-saved',
        revision: sampleRevision,
      },
      {
        type: 'room-notification',
        kind: 'role-changed',
        message: 'Bob is now an Editor',
        targetUserId: 'usr_2',
        newRole: 'EDITOR',
        timestamp: nowIso,
      },
      {
        type: 'conflict',
        code: 'TARGET_DELETED',
        targetId: 'mod_1',
        message: 'The module or function you were editing was deleted by an administrator.',
        correctiveUpdate: b64,
      },
      {
        type: 'error',
        code: 'FORBIDDEN',
        message: 'Viewers cannot modify workspace',
        requestId: 'req_1',
        correctiveUpdate: b64,
      },
      { type: 'kicked', reason: 'Removed by admin' },
      { type: 'banned', reason: 'Banned by admin' },
      { type: 'room-deleted', reason: 'Room deleted by owner' },
      { type: 'pong', timestamp: 1760573748000 },
    ];

    for (const msg of serverMessages) {
      expect(wsServerMessageSchema.parse(msg).type).toBe(msg.type);
    }
  });

  it('validates UDP LAN Discovery Beacon schema and rejects wrong magic or invalid ports', () => {
    const validBeacon = {
      magic: DISCOVERY_BEACON_MAGIC,
      serverId: 'srv_91a8c0e2-3f11-4b88-9214-0192837465ab',
      name: 'Avionics HLR Server',
      version: '0.6.0',
      host: '192.168.1.50',
      port: 8443,
      tls: true,
      fingerprint: 'SHA256:4F:8A:12:BC:99:00',
      timestamp: 1760573748000,
    };

    expect(discoveryBeaconSchema.parse(validBeacon)).toEqual(validBeacon);

    expect(() =>
      discoveryBeaconSchema.parse({
        ...validBeacon,
        magic: 'WRONG_MAGIC',
      }),
    ).toThrow();

    expect(() =>
      discoveryBeaconSchema.parse({
        ...validBeacon,
        port: 70000,
      }),
    ).toThrow();
  });
});
