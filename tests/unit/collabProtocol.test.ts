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
  banMemberResponseSchema,
  collabOpKindSchema,
  collabOpSchema,
  configUpdateOpPayloadSchema,
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
  functionDescriptionOpPayloadSchema,
  getRevisionDiffResponseSchema,
  getRevisionResponseSchema,
  getRoomResponseSchema,
  hierarchyOpPayloadSchema,
  itemAddOpPayloadSchema,
  itemDeleteOpPayloadSchema,
  itemEditOpPayloadSchema,
  joinRequestResponseSchema,
  kickMemberResponseSchema,
  kickOrBanMemberRequestSchema,
  leaveRoomResponseSchema,
  listRevisionsResponseSchema,
  listRoomsResponseSchema,
  lockAcquireSchema,
  lockDeniedSchema,
  lockForceReleaseSchema,
  lockGrantedSchema,
  lockHeartbeatSchema,
  lockHolderSchema,
  lockInfoSchema,
  lockReleaseSchema,
  locksChangedSchema,
  loginRequestSchema,
  logoutRequestSchema,
  logoutResponseSchema,
  meResponseSchema,
  opAckSchema,
  opAppliedSchema,
  opRejectCodeSchema,
  opRejectedSchema,
  opsSinceReplySchema,
  opsSinceSchema,
  presenceBroadcastEntrySchema,
  presenceBroadcastMessageSchema,
  presenceFocusSchema,
  presenceStateSchema,
  presenceUpdateMessageSchema,
  presenceViewSchema,
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
  roomRestoreOpPayloadSchema,
  roomSummaryResponseSchema,
  roomWelcomeSchema,
  serverPublicInfoSchema,
  setupRequestSchema,
  snapshotSchema,
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
  COLLAB_OP_KINDS,
  COLLAB_USER_COLORS,
  DISCOVERY_BEACON_MAGIC,
  OP_REJECT_CODES,
  type CollabOp,
  type LockHolder,
  type LockInfo,
  type PresenceBroadcastEntry,
  type PresenceState,
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
  message: 'Initial revision baseline',
  authorId: sampleUser.id,
  authorName: sampleUser.displayName,
  snapshotFilename: 'rev_1.json',
  restoredFromId: null,
  createdAt: nowIso,
};

describe('Protocol Schemas (Zod Wire Validation)', () => {
  it('assigns user colors deterministically from palette', () => {
    const c1 = assignUserColor('usr_abc');
    const c2 = assignUserColor('usr_abc');
    const c3 = assignUserColor('usr_xyz');
    expect(c1).toBe(c2);
    expect(COLLAB_USER_COLORS).toContain(c1);
    expect(COLLAB_USER_COLORS).toContain(c3);
  });

  it('validates API standard success and error envelope schemas', () => {
    const success = apiSuccessEnvelopeSchema(serverPublicInfoSchema).parse({
      ok: true,
      value: {
        serverId: 'srv_1',
        name: 'Avionics HLR Server',
        version: '0.6.0',
        tls: true,
        fingerprint: 'SHA256:4F:8A:12:BC:99:00',
        setupRequired: false,
        registrationMode: 'open',
        roomCreationMode: 'all_users',
      },
    });
    expect(success.ok).toBe(true);

    const error = apiErrorEnvelopeSchema.parse({
      ok: false,
      code: 'FORBIDDEN',
      error: 'Action disallowed for role',
    });
    expect(error.ok).toBe(false);
    expect(error.code).toBe('FORBIDDEN');
  });

  it('validates auth REST request and response schemas', () => {
    expect(
      setupRequestSchema.parse({
        setupToken: 'tok_setup_12345',
        username: 'alice_owner',
        displayName: 'Alice Owner',
        password: 'secure_password_123',
      }).username,
    ).toBe('alice_owner');

    expect(
      registerRequestSchema.parse({
        username: 'bob_dev',
        displayName: 'Bob Dev',
        password: 'secure_password_123',
      }).username,
    ).toBe('bob_dev');

    expect(
      loginRequestSchema.parse({
        username: 'bob_dev',
        password: 'secure_password_123',
      }).username,
    ).toBe('bob_dev');

    expect(logoutRequestSchema.parse({})).toEqual({});
    expect(logoutResponseSchema.parse({ loggedOut: true })).toEqual({ loggedOut: true });

    expect(
      authSessionResponseSchema.parse({
        user: sampleUser,
        token: 'sess_tok_abc',
        expiresAt: nowIso,
      }).token,
    ).toBe('sess_tok_abc');

    expect(
      registerResponseSchema.parse({
        status: 'PENDING_APPROVAL',
        user: { ...sampleUser, status: 'PENDING_APPROVAL' },
      }).status,
    ).toBe('PENDING_APPROVAL');

    expect(meResponseSchema.parse({ user: sampleUser }).user.id).toBe(sampleUser.id);

    expect(
      userDirectoryResponseSchema.parse({
        users: [{ id: sampleUser.id, username: sampleUser.username, displayName: sampleUser.displayName }],
      }).users,
    ).toHaveLength(1);
  });

  it('validates server admin REST endpoints', () => {
    expect(
      updateServerSettingsRequestSchema.parse({
        name: 'Updated Server Name',
        registrationMode: 'approval',
      }).registrationMode,
    ).toBe('approval');

    expect(
      updateServerSettingsResponseSchema.parse({
        settings: {
          serverId: 'srv_1',
          name: 'Avionics HLR',
          registrationMode: 'approval',
          roomCreationMode: 'admins_only',
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      }).settings.roomCreationMode,
    ).toBe('admins_only');

    expect(adminListUsersResponseSchema.parse({ users: [sampleUser] }).users).toHaveLength(1);

    expect(
      adminCreateUserRequestSchema.parse({
        username: 'charlie',
        displayName: 'Charlie Tech',
        password: 'password123',
        serverRole: 'USER',
      }).serverRole,
    ).toBe('USER');

    expect(adminUserResponseSchema.parse({ user: sampleUser }).user.username).toBe('alice_eng');

    expect(
      adminUpdateUserRequestSchema.parse({
        status: 'DISABLED',
        serverRole: 'SERVER_ADMIN',
      }).status,
    ).toBe('DISABLED');

    expect(adminResetPasswordRequestSchema.parse({ newPassword: 'new_password_123' }).newPassword).toBe(
      'new_password_123',
    );
    expect(adminResetPasswordResponseSchema.parse({ reset: true }).reset).toBe(true);

    expect(adminListRoomsResponseSchema.parse({ rooms: [sampleRoomSummary] }).rooms).toHaveLength(1);

    expect(
      adminResolveRoomRequestSchema.parse({
        userId: sampleUser.id,
        role: 'ROOM_OWNER',
      }).role,
    ).toBe('ROOM_OWNER');

    expect(
      auditListResponseSchema.parse({
        entries: [
          {
            id: 'aud_1',
            roomId: sampleRoomSummary.id,
            actorId: sampleUser.id,
            actorName: sampleUser.displayName,
            action: 'room:create',
            targetId: sampleRoomSummary.id,
            details: { name: sampleRoomSummary.name },
            createdAt: nowIso,
          },
        ],
      }).entries,
    ).toHaveLength(1);
  });

  it('validates Room Lobby, Invites, Join Requests, and Revisions schemas', () => {
    const ws = createWorkspace('Avionics', 'AV');

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
            memberCount: 1,
            hasPendingJoinRequest: false,
            createdAt: nowIso,
            updatedAt: nowIso,
          },
        ],
        myInvites: [],
        myJoinRequests: [],
      }).listedRooms,
    ).toHaveLength(1);

    expect(
      createRoomRequestSchema.parse({
        name: 'Avionics Room',
        visibility: 'listed',
        workspace: ws,
      }).visibility,
    ).toBe('listed');

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
          },
        ],
        invites: [],
        joinRequests: [],
        bans: [],
        workspace: ws,
      }).members,
    ).toHaveLength(1);

    expect(updateRoomRequestSchema.parse({ name: 'Renamed Room' }).name).toBe('Renamed Room');
    expect(deleteRoomResponseSchema.parse({ deleted: true }).deleted).toBe(true);
    expect(leaveRoomResponseSchema.parse({ left: true }).left).toBe(true);
    expect(
      transferOwnershipRequestSchema.parse({ newOwnerUserId: 'usr_2' }).newOwnerUserId,
    ).toBe('usr_2');

    expect(
      createDirectInviteRequestSchema.parse({ targetUserId: 'usr_2', role: 'EDITOR' }).role,
    ).toBe('EDITOR');

    expect(
      createDirectInviteResponseSchema.parse({
        invite: {
          id: 'inv_1',
          roomId: sampleRoomSummary.id,
          roomName: sampleRoomSummary.name,
          kind: 'direct',
          targetUserId: 'usr_2',
          targetUsername: 'bob',
          targetDisplayName: 'Bob',
          role: 'EDITOR',
          createdBy: sampleUser.id,
          createdByDisplayName: sampleUser.displayName,
          status: 'PENDING',
          createdAt: nowIso,
        },
      }).invite.role,
    ).toBe('EDITOR');

    expect(respondInviteRequestSchema.parse({ accept: true }).accept).toBe(true);
    expect(
      respondInviteResponseSchema.parse({
        accepted: true,
        roomId: sampleRoomSummary.id,
        role: 'EDITOR',
      }).role,
    ).toBe('EDITOR');

    expect(
      createInviteCodeRequestSchema.parse({ role: 'VIEWER', expiresInSeconds: 3600, maxUses: 5 }).maxUses,
    ).toBe(5);

    expect(
      createInviteCodeResponseSchema.parse({
        inviteCode: {
          id: 'inv_2',
          roomId: sampleRoomSummary.id,
          kind: 'code',
          code: 'INV-1234',
          role: 'VIEWER',
          createdBy: sampleUser.id,
          status: 'PENDING',
          uses: 0,
          maxUses: 10,
          expiresAt: nowIso,
          createdAt: nowIso,
        },
      }).inviteCode.code,
    ).toBe('INV-1234');

    expect(redeemInviteCodeRequestSchema.parse({ code: 'INV-1234' }).code).toBe('INV-1234');
    expect(
      redeemInviteCodeResponseSchema.parse({ room: sampleRoomSummary, role: 'VIEWER' }).role,
    ).toBe('VIEWER');

    expect(revokeInviteResponseSchema.parse({ revoked: true }).revoked).toBe(true);

    expect(
      createJoinRequestSchema.parse({ message: 'I would like to contribute.' }).message,
    ).toBe('I would like to contribute.');

    expect(
      joinRequestResponseSchema.parse({
        joinRequest: {
          id: 'jreq_1',
          roomId: sampleRoomSummary.id,
          roomName: sampleRoomSummary.name,
          userId: 'usr_3',
          username: 'charlie',
          displayName: 'Charlie',
          message: 'Hello',
          status: 'PENDING',
          assignedRole: null,
          reviewedBy: null,
          createdAt: nowIso,
          reviewedAt: null,
        },
      }).joinRequest.status,
    ).toBe('PENDING');

    expect(
      reviewJoinRequestSchema.parse({ approve: true, role: 'EDITOR' }).role,
    ).toBe('EDITOR');

    expect(
      updateRoomMemberRoleRequestSchema.parse({ role: 'ROOM_ADMIN' }).role,
    ).toBe('ROOM_ADMIN');

    expect(
      updateRoomMemberRoleResponseSchema.parse({
        member: {
          roomId: sampleRoomSummary.id,
          userId: sampleUser.id,
          username: sampleUser.username,
          displayName: sampleUser.displayName,
          role: 'ROOM_ADMIN',
          joinedAt: nowIso,
        },
      }).member.role,
    ).toBe('ROOM_ADMIN');

    expect(
      kickOrBanMemberRequestSchema.parse({ reason: 'Inappropriate conduct' }).reason,
    ).toBe('Inappropriate conduct');

    expect(kickMemberResponseSchema.parse({ kicked: true }).kicked).toBe(true);
    expect(banMemberResponseSchema.parse({ banned: true }).banned).toBe(true);
    expect(unbanMemberResponseSchema.parse({ unbanned: true }).unbanned).toBe(true);

    expect(roomExportQuerySchema.parse({ format: 'json' }).format).toBe('json');
    expect(
      roomExportResponseSchema.parse({ format: 'csv', content: 'id,description\n1,test' }).format,
    ).toBe('csv');

    expect(listRevisionsResponseSchema.parse({ revisions: [sampleRevision] }).revisions).toHaveLength(1);
    expect(createRevisionRequestSchema.parse({ message: 'Baseline 1' }).message).toBe('Baseline 1');
    expect(createRevisionResponseSchema.parse({ revision: sampleRevision }).revision.seq).toBe(1);
    expect(getRevisionResponseSchema.parse({ revision: sampleRevision, workspace: ws }).workspace.config.projectName).toBe(
      'Avionics',
    );
    expect(
      getRevisionDiffResponseSchema.parse({
        diff: {
          fromRevisionId: 'rev_1',
          toTarget: 'rev_2',
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

  it('validates Architecture v2 Operations, Op envelopes, and Op reject codes', () => {
    // Op kinds
    for (const kind of COLLAB_OP_KINDS) {
      expect(collabOpKindSchema.parse(kind)).toBe(kind);
    }
    expect(() => collabOpKindSchema.parse('invalid.op')).toThrow();

    // Reject codes
    for (const code of OP_REJECT_CODES) {
      expect(opRejectCodeSchema.parse(code)).toBe(code);
    }
    expect(() => opRejectCodeSchema.parse('UNKNOWN_CODE')).toThrow();

    const ws = createWorkspace('Test Project', 'TP');

    // Individual op payloads
    const hierPayload = hierarchyOpPayloadSchema.parse({
      objectType: 'REQUIREMENT',
      action: 'addModule',
      parentId: null,
      name: 'Mod',
      prefix: 'M',
      description: 'Desc',
    });
    expect(hierPayload.action).toBe('addModule');

    const itemAddPayload = itemAddOpPayloadSchema.parse({
      objectType: 'REQUIREMENT',
      functionId: 'fn_1',
      values: { col_desc: 'New requirement', col_priority: 1 },
    });
    expect(itemAddPayload.functionId).toBe('fn_1');

    const itemEditPayload = itemEditOpPayloadSchema.parse({
      objectType: 'REQUIREMENT',
      functionId: 'fn_1',
      itemId: 'REQ-001',
      values: { col_desc: 'Updated text' },
    });
    expect(itemEditPayload.itemId).toBe('REQ-001');

    const itemDeletePayload = itemDeleteOpPayloadSchema.parse({
      objectType: 'REQUIREMENT',
      functionId: 'fn_1',
      itemId: 'REQ-001',
    });
    expect(itemDeletePayload.itemId).toBe('REQ-001');

    const fnDescPayload = functionDescriptionOpPayloadSchema.parse({
      objectType: 'REQUIREMENT',
      functionId: 'fn_1',
      description: '# Markdown Scope',
    });
    expect(fnDescPayload.description).toBe('# Markdown Scope');

    const configPayload = configUpdateOpPayloadSchema.parse(ws.config);
    expect(configPayload.projectName).toBe('Test Project');

    const restorePayload = roomRestoreOpPayloadSchema.parse({ revisionId: 'rev_123' });
    expect(restorePayload.revisionId).toBe('rev_123');

    // CollabOp discriminated union envelopes
    const ops: CollabOp[] = [
      { opId: 'op_1', kind: 'hierarchy', payload: hierPayload },
      { opId: 'op_2', kind: 'item.add', payload: itemAddPayload },
      { opId: 'op_3', kind: 'item.edit', payload: itemEditPayload },
      { opId: 'op_4', kind: 'item.delete', payload: itemDeletePayload },
      { opId: 'op_5', kind: 'function.description', payload: fnDescPayload },
      { opId: 'op_6', kind: 'config.update', payload: configPayload },
      { opId: 'op_7', kind: 'room.restore', payload: restorePayload },
    ];

    for (const op of ops) {
      expect(collabOpSchema.parse(op).kind).toBe(op.kind);
    }
  });

  it('validates Architecture v2 Locks schemas (acquire, granted, denied, release, heartbeat, force-release, changed)', () => {
    const holder: LockHolder = {
      userId: sampleUser.id,
      name: sampleUser.displayName,
      color: '#3b82f6',
    };
    expect(lockHolderSchema.parse(holder)).toEqual(holder);

    const info: LockInfo = {
      holder,
      expiresAt: 1760573748000,
    };
    expect(lockInfoSchema.parse(info)).toEqual(info);

    expect(lockAcquireSchema.parse({ type: 'lock-acquire', key: 'item:REQ-001' }).key).toBe('item:REQ-001');
    expect(lockReleaseSchema.parse({ type: 'lock-release', key: 'item:REQ-001' }).key).toBe('item:REQ-001');
    expect(lockHeartbeatSchema.parse({ type: 'lock-heartbeat', key: 'item:REQ-001' }).key).toBe('item:REQ-001');
    expect(lockForceReleaseSchema.parse({ type: 'lock-force-release', key: 'item:REQ-001' }).key).toBe(
      'item:REQ-001',
    );

    expect(
      lockGrantedSchema.parse({ type: 'lock-granted', key: 'item:REQ-001', expiresAt: 1760573748000 }).expiresAt,
    ).toBe(1760573748000);

    expect(
      lockDeniedSchema.parse({ type: 'lock-denied', key: 'item:REQ-001', holder }).holder.userId,
    ).toBe(sampleUser.id);

    expect(
      locksChangedSchema.parse({ type: 'locks-changed', key: 'item:REQ-001', holder }).holder?.userId,
    ).toBe(sampleUser.id);

    expect(
      locksChangedSchema.parse({ type: 'locks-changed', key: 'item:REQ-001', holder: null }).holder,
    ).toBeNull();
  });

  it('validates Architecture v2 Presence schemas (view, focus, state, broadcast)', () => {
    const view = presenceViewSchema.parse({
      objectType: 'REQUIREMENT',
      nodeId: 'fn_123',
    });
    expect(view.nodeId).toBe('fn_123');

    const focus = presenceFocusSchema.parse({
      itemId: 'REQ-001',
      columnId: 'col_desc',
    });
    expect(focus.columnId).toBe('col_desc');

    const state: PresenceState = presenceStateSchema.parse({
      view,
      focus,
      drafting: 'fn_123',
    });
    expect(state.drafting).toBe('fn_123');

    const entry: PresenceBroadcastEntry = presenceBroadcastEntrySchema.parse({
      connectionId: 'conn_1',
      user: {
        userId: sampleUser.id,
        name: sampleUser.displayName,
        color: '#3b82f6',
      },
      state,
    });
    expect(entry.connectionId).toBe('conn_1');

    expect(
      presenceUpdateMessageSchema.parse({
        type: 'presence-update',
        view,
        focus,
        drafting: null,
      }).drafting,
    ).toBeNull();

    expect(
      presenceBroadcastMessageSchema.parse({
        type: 'presence',
        connectionId: 'conn_1',
        user: { userId: sampleUser.id, name: sampleUser.displayName, color: '#3b82f6' },
        state,
      }).connectionId,
    ).toBe('conn_1');
  });

  it('validates all WebSocket Client & Server message types in v2', () => {
    const ws = createWorkspace('Test Project', 'TP');
    const holder: LockHolder = {
      userId: sampleUser.id,
      name: sampleUser.displayName,
      color: '#3b82f6',
    };
    const presenceEntry: PresenceBroadcastEntry = {
      connectionId: 'conn_1',
      user: { userId: sampleUser.id, name: sampleUser.displayName, color: '#3b82f6' },
      state: { view: null, focus: null, drafting: null },
    };

    const sampleOp: CollabOp = {
      opId: 'op_100',
      kind: 'item.add',
      payload: {
        objectType: 'REQUIREMENT',
        functionId: 'fn_1',
        values: { col_desc: 'New requirement' },
      },
    };

    // Client messages
    const clientMessages = [
      { type: 'op', op: sampleOp },
      { type: 'ops-since', seq: 42 },
      { type: 'lock-acquire', key: 'item:REQ-001' },
      { type: 'lock-release', key: 'item:REQ-001' },
      { type: 'lock-heartbeat', key: 'item:REQ-001' },
      { type: 'lock-force-release', key: 'item:REQ-001' },
      {
        type: 'presence-update',
        view: { objectType: 'REQUIREMENT', nodeId: 'fn_1' },
        focus: { itemId: 'REQ-001', columnId: 'col_desc' },
        drafting: 'fn_1',
      },
      { type: 'ping', timestamp: 1760573748000 },
    ];

    for (const msg of clientMessages) {
      expect(wsClientMessageSchema.parse(msg).type).toBe(msg.type);
    }

    // Server messages
    const serverMessages = [
      {
        type: 'room-welcome',
        roomId: sampleRoomSummary.id,
        role: 'ROOM_OWNER',
        seq: 10,
        workspace: ws,
        locks: { 'item:REQ-001': holder },
        presence: [presenceEntry],
        members: [
          {
            roomId: sampleRoomSummary.id,
            userId: sampleUser.id,
            username: sampleUser.username,
            displayName: sampleUser.displayName,
            role: 'ROOM_OWNER',
            joinedAt: nowIso,
          },
        ],
        autosaveStatus: { status: 'autosaved', lastAutosavedAt: nowIso },
        lastRevision: sampleRevision,
      },
      { type: 'op-ack', opId: 'op_100', seq: 11 },
      { type: 'op-rejected', opId: 'op_100', code: 'LOCKED', message: 'Row is locked' },
      { type: 'op-applied', seq: 11, op: sampleOp, result: { id: 'REQ-001' } },
      {
        type: 'ops-since-reply',
        sinceSeq: 5,
        ops: [{ seq: 6, op: sampleOp }],
      },
      { type: 'snapshot', seq: 10, workspace: ws },
      { type: 'lock-granted', key: 'item:REQ-001', expiresAt: 1760573748000 },
      { type: 'lock-denied', key: 'item:REQ-001', holder },
      { type: 'locks-changed', key: 'item:REQ-001', holder },
      {
        type: 'presence',
        connectionId: 'conn_1',
        user: { userId: sampleUser.id, name: sampleUser.displayName, color: '#3b82f6' },
        state: { view: null, focus: null, drafting: null },
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
        type: 'autosave-status',
        status: 'autosaved',
        lastAutosavedAt: nowIso,
      },
      {
        type: 'revision-saved',
        revision: sampleRevision,
      },
      { type: 'kicked', reason: 'Removed by admin' },
      { type: 'banned', reason: 'Banned by admin' },
      { type: 'room-deleted', reason: 'Room deleted by owner' },
      { type: 'pong', timestamp: 1760573748000 },
      { type: 'error', code: 'FORBIDDEN', message: 'Action not allowed' },
    ];

    for (const msg of serverMessages) {
      expect(wsServerMessageSchema.parse(msg).type).toBe(msg.type);
    }

    // Specific schemas
    expect(opAckSchema.parse({ type: 'op-ack', opId: 'op_1', seq: 5 }).seq).toBe(5);
    expect(
      opRejectedSchema.parse({ type: 'op-rejected', opId: 'op_1', code: 'READ_ONLY', message: 'Viewer' }).code,
    ).toBe('READ_ONLY');
    expect(opAppliedSchema.parse({ type: 'op-applied', seq: 1, op: sampleOp }).seq).toBe(1);
    expect(opsSinceSchema.parse({ type: 'ops-since', seq: 3 }).seq).toBe(3);
    expect(opsSinceReplySchema.parse({ type: 'ops-since-reply', sinceSeq: 3, ops: [] }).sinceSeq).toBe(3);
    expect(snapshotSchema.parse({ type: 'snapshot', seq: 10, workspace: ws }).seq).toBe(10);
    expect(
      roomWelcomeSchema.parse({
        type: 'room-welcome',
        roomId: 'r_1',
        role: 'EDITOR',
        seq: 0,
        workspace: ws,
        locks: {},
        presence: [],
        members: [],
      }).role,
    ).toBe('EDITOR');
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
