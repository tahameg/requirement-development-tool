import { describe, expect, it } from 'vitest';
import { addItem } from '../../src/main/services/idGenerator.js';
import { addRequirementSet, addComponent, createWorkspace } from '../../src/main/services/workspaceFactory.js';
import {
  authorizeOp,
  canRoomAction,
  canServerAction,
  hasMinimumRoomRole,
  hasMinimumServerRole,
  ROOM_ACTIONS,
  SERVER_ACTIONS,
} from '../../src/shared/collab/permissions.js';
import type {
  CollabOp,
  LockHolder,
  LockInfo,
  RoomAction,
  RoomRole,
  ServerAction,
  ServerRole,
} from '../../src/shared/collab/types.js';

describe('Server-Level Permission Matrix (ServerRole x ServerAction)', () => {
  it('evaluates role hierarchy helper hasMinimumServerRole', () => {
    expect(hasMinimumServerRole(null, 'USER')).toBe(false);
    expect(hasMinimumServerRole('USER', 'USER')).toBe(true);
    expect(hasMinimumServerRole('USER', 'SERVER_ADMIN')).toBe(false);
    expect(hasMinimumServerRole('SERVER_ADMIN', 'USER')).toBe(true);
    expect(hasMinimumServerRole('SERVER_ADMIN', 'SERVER_ADMIN')).toBe(true);
    expect(hasMinimumServerRole('SERVER_ADMIN', 'SERVER_OWNER')).toBe(false);
    expect(hasMinimumServerRole('SERVER_OWNER', 'SERVER_OWNER')).toBe(true);
  });

  it('verifies every ServerAction across Unauthenticated, USER, SERVER_ADMIN, and SERVER_OWNER', () => {
    const matrix: Record<
      ServerAction,
      { unauth: boolean; USER: boolean; SERVER_ADMIN: boolean; SERVER_OWNER: boolean }
    > = {
      'auth:setup': { unauth: true, USER: false, SERVER_ADMIN: false, SERVER_OWNER: false },
      'auth:register': { unauth: true, USER: false, SERVER_ADMIN: false, SERVER_OWNER: false },
      'auth:login': { unauth: true, USER: true, SERVER_ADMIN: true, SERVER_OWNER: true },
      'auth:logout': { unauth: false, USER: true, SERVER_ADMIN: true, SERVER_OWNER: true },
      'server:view-settings': { unauth: true, USER: true, SERVER_ADMIN: true, SERVER_OWNER: true },
      'server:update-settings': { unauth: false, USER: false, SERVER_ADMIN: false, SERVER_OWNER: true },
      'users:list': { unauth: false, USER: false, SERVER_ADMIN: true, SERVER_OWNER: true },
      'users:directory': { unauth: false, USER: true, SERVER_ADMIN: true, SERVER_OWNER: true },
      'users:create': { unauth: false, USER: false, SERVER_ADMIN: true, SERVER_OWNER: true },
      'users:approve': { unauth: false, USER: false, SERVER_ADMIN: true, SERVER_OWNER: true },
      'users:disable': { unauth: false, USER: false, SERVER_ADMIN: true, SERVER_OWNER: true },
      'users:reset-password': { unauth: false, USER: false, SERVER_ADMIN: true, SERVER_OWNER: true },
      'users:change-server-role': { unauth: false, USER: false, SERVER_ADMIN: false, SERVER_OWNER: true },
      'rooms:create': { unauth: false, USER: true, SERVER_ADMIN: true, SERVER_OWNER: true },
      'rooms:list-all-admin': { unauth: false, USER: false, SERVER_ADMIN: true, SERVER_OWNER: true },
      'rooms:resolve-stuck': { unauth: false, USER: false, SERVER_ADMIN: true, SERVER_OWNER: true },
      'rooms:force-delete': { unauth: false, USER: false, SERVER_ADMIN: true, SERVER_OWNER: true },
      'audit:view-server': { unauth: false, USER: false, SERVER_ADMIN: true, SERVER_OWNER: true },
    };

    expect(Object.keys(matrix).sort()).toEqual([...SERVER_ACTIONS].sort());

    for (const action of SERVER_ACTIONS) {
      const expected = matrix[action];
      expect(canServerAction(null, action), `unauth -> ${action}`).toBe(expected.unauth);
      for (const role of ['USER', 'SERVER_ADMIN', 'SERVER_OWNER'] as ServerRole[]) {
        expect(canServerAction(role, action), `${role} -> ${action}`).toBe(expected[role]);
      }
    }
  });

  it('enforces contextual constraints on server actions', () => {
    // auth:setup with invalid token or setup already completed
    expect(canServerAction(null, 'auth:setup', { setupRequired: false })).toBe(false);
    expect(canServerAction(null, 'auth:setup', { hasValidSetupToken: false })).toBe(false);

    // auth:register modes
    expect(canServerAction(null, 'auth:register', { registrationMode: 'open' })).toBe(true);
    expect(canServerAction(null, 'auth:register', { registrationMode: 'approval' })).toBe(true);
    expect(canServerAction(null, 'auth:register', { registrationMode: 'closed' })).toBe(false);

    // rooms:create under admins_only
    expect(canServerAction('USER', 'rooms:create', { roomCreationMode: 'all_users' })).toBe(true);
    expect(canServerAction('USER', 'rooms:create', { roomCreationMode: 'admins_only' })).toBe(false);
    expect(canServerAction('SERVER_ADMIN', 'rooms:create', { roomCreationMode: 'admins_only' })).toBe(true);
    expect(canServerAction('SERVER_OWNER', 'rooms:create', { roomCreationMode: 'admins_only' })).toBe(true);

    // users:create target role restrictions
    expect(canServerAction('SERVER_ADMIN', 'users:create', { assignedRole: 'USER' })).toBe(true);
    expect(canServerAction('SERVER_ADMIN', 'users:create', { targetRole: 'SERVER_ADMIN' })).toBe(false);
    expect(canServerAction('SERVER_ADMIN', 'users:create', { assignedRole: 'SERVER_ADMIN' })).toBe(false);
    expect(canServerAction('SERVER_OWNER', 'users:create', { assignedRole: 'SERVER_ADMIN' })).toBe(true);
    expect(canServerAction('SERVER_OWNER', 'users:create', { assignedRole: 'SERVER_OWNER' })).toBe(false);

    // users:disable and users:reset-password target role restrictions
    for (const action of ['users:disable', 'users:reset-password'] as const) {
      expect(canServerAction('SERVER_ADMIN', action, { targetRole: 'USER' })).toBe(true);
      expect(canServerAction('SERVER_ADMIN', action, { targetRole: 'SERVER_ADMIN' })).toBe(false);
      expect(canServerAction('SERVER_ADMIN', action, { targetRole: 'SERVER_OWNER' })).toBe(false);
      expect(canServerAction('SERVER_OWNER', action, { targetRole: 'USER' })).toBe(true);
      expect(canServerAction('SERVER_OWNER', action, { targetRole: 'SERVER_ADMIN' })).toBe(true);
      expect(canServerAction('SERVER_OWNER', action, { targetRole: 'SERVER_OWNER' })).toBe(false);
    }

    // users:change-server-role
    expect(
      canServerAction('SERVER_OWNER', 'users:change-server-role', {
        targetRole: 'USER',
        assignedRole: 'SERVER_ADMIN',
      }),
    ).toBe(true);
    expect(
      canServerAction('SERVER_OWNER', 'users:change-server-role', {
        targetRole: 'SERVER_OWNER',
        assignedRole: 'USER',
      }),
    ).toBe(false);
    expect(
      canServerAction('SERVER_OWNER', 'users:change-server-role', {
        targetRole: 'USER',
        assignedRole: 'SERVER_OWNER',
      }),
    ).toBe(false);
  });
});

describe('Room-Level Permission Matrix (RoomRole x RoomAction)', () => {
  it('evaluates role hierarchy helper hasMinimumRoomRole', () => {
    expect(hasMinimumRoomRole(null, 'VIEWER')).toBe(false);
    expect(hasMinimumRoomRole('VIEWER', 'VIEWER')).toBe(true);
    expect(hasMinimumRoomRole('VIEWER', 'EDITOR')).toBe(false);
    expect(hasMinimumRoomRole('EDITOR', 'EDITOR')).toBe(true);
    expect(hasMinimumRoomRole('EDITOR', 'ROOM_ADMIN')).toBe(false);
    expect(hasMinimumRoomRole('ROOM_ADMIN', 'ROOM_ADMIN')).toBe(true);
    expect(hasMinimumRoomRole('ROOM_ADMIN', 'ROOM_OWNER')).toBe(false);
    expect(hasMinimumRoomRole('ROOM_OWNER', 'ROOM_OWNER')).toBe(true);
  });

  it('verifies every RoomAction across Non-Member, VIEWER, EDITOR, ROOM_ADMIN, and ROOM_OWNER', () => {
    const matrix: Record<
      RoomAction,
      { nonMember: boolean; VIEWER: boolean; EDITOR: boolean; ROOM_ADMIN: boolean; ROOM_OWNER: boolean }
    > = {
      'room:view-listed': { nonMember: true, VIEWER: true, EDITOR: true, ROOM_ADMIN: true, ROOM_OWNER: true },
      'room:request-join': { nonMember: true, VIEWER: false, EDITOR: false, ROOM_ADMIN: false, ROOM_OWNER: false },
      'room:accept-direct-invite': {
        nonMember: true,
        VIEWER: false,
        EDITOR: false,
        ROOM_ADMIN: false,
        ROOM_OWNER: false,
      },
      'room:redeem-invite-code': {
        nonMember: true,
        VIEWER: false,
        EDITOR: false,
        ROOM_ADMIN: false,
        ROOM_OWNER: false,
      },
      'room:connect-ws': { nonMember: false, VIEWER: true, EDITOR: true, ROOM_ADMIN: true, ROOM_OWNER: true },
      'room:broadcast-view-presence': {
        nonMember: false,
        VIEWER: true,
        EDITOR: true,
        ROOM_ADMIN: true,
        ROOM_OWNER: true,
      },
      'room:broadcast-field-focus': {
        nonMember: false,
        VIEWER: false,
        EDITOR: true,
        ROOM_ADMIN: true,
        ROOM_OWNER: true,
      },
      'room:export': { nonMember: false, VIEWER: true, EDITOR: true, ROOM_ADMIN: true, ROOM_OWNER: true },
      'room:leave': { nonMember: false, VIEWER: true, EDITOR: true, ROOM_ADMIN: true, ROOM_OWNER: false },
      'item:create': { nonMember: false, VIEWER: false, EDITOR: true, ROOM_ADMIN: true, ROOM_OWNER: true },
      'item:edit': { nonMember: false, VIEWER: false, EDITOR: true, ROOM_ADMIN: true, ROOM_OWNER: true },
      'item:delete': { nonMember: false, VIEWER: false, EDITOR: true, ROOM_ADMIN: true, ROOM_OWNER: true },
      'hierarchy:create-component': {
        nonMember: false,
        VIEWER: false,
        EDITOR: true,
        ROOM_ADMIN: true,
        ROOM_OWNER: true,
      },
      'hierarchy:edit-component': {
        nonMember: false,
        VIEWER: false,
        EDITOR: true,
        ROOM_ADMIN: true,
        ROOM_OWNER: true,
      },
      'hierarchy:create-requirement-set': {
        nonMember: false,
        VIEWER: false,
        EDITOR: true,
        ROOM_ADMIN: true,
        ROOM_OWNER: true,
      },
      'hierarchy:edit-requirement-set': {
        nonMember: false,
        VIEWER: false,
        EDITOR: true,
        ROOM_ADMIN: true,
        ROOM_OWNER: true,
      },
      'hierarchy:delete-component': {
        nonMember: false,
        VIEWER: false,
        EDITOR: false,
        ROOM_ADMIN: true,
        ROOM_OWNER: true,
      },
      'hierarchy:delete-requirement-set': {
        nonMember: false,
        VIEWER: false,
        EDITOR: false,
        ROOM_ADMIN: true,
        ROOM_OWNER: true,
      },
      'project:edit-settings': {
        nonMember: false,
        VIEWER: false,
        EDITOR: false,
        ROOM_ADMIN: true,
        ROOM_OWNER: true,
      },
      'revision:save': { nonMember: false, VIEWER: false, EDITOR: false, ROOM_ADMIN: true, ROOM_OWNER: true },
      'revision:history-diff': {
        nonMember: false,
        VIEWER: false,
        EDITOR: false,
        ROOM_ADMIN: true,
        ROOM_OWNER: true,
      },
      'revision:restore': { nonMember: false, VIEWER: false, EDITOR: false, ROOM_ADMIN: true, ROOM_OWNER: true },
      'member:invite-user': {
        nonMember: false,
        VIEWER: false,
        EDITOR: false,
        ROOM_ADMIN: true,
        ROOM_OWNER: true,
      },
      'member:create-invite-code': {
        nonMember: false,
        VIEWER: false,
        EDITOR: false,
        ROOM_ADMIN: true,
        ROOM_OWNER: true,
      },
      'member:revoke-invite': {
        nonMember: false,
        VIEWER: false,
        EDITOR: false,
        ROOM_ADMIN: true,
        ROOM_OWNER: true,
      },
      'member:review-join-request': {
        nonMember: false,
        VIEWER: false,
        EDITOR: false,
        ROOM_ADMIN: true,
        ROOM_OWNER: true,
      },
      'member:change-role-below-admin': {
        nonMember: false,
        VIEWER: false,
        EDITOR: false,
        ROOM_ADMIN: true,
        ROOM_OWNER: true,
      },
      'member:promote-demote-admin': {
        nonMember: false,
        VIEWER: false,
        EDITOR: false,
        ROOM_ADMIN: false,
        ROOM_OWNER: true,
      },
      'member:kick-ban': { nonMember: false, VIEWER: false, EDITOR: false, ROOM_ADMIN: true, ROOM_OWNER: true },
      'room:edit-metadata': {
        nonMember: false,
        VIEWER: false,
        EDITOR: false,
        ROOM_ADMIN: true,
        ROOM_OWNER: true,
      },
      'room:view-audit': { nonMember: false, VIEWER: false, EDITOR: false, ROOM_ADMIN: true, ROOM_OWNER: true },
      'room:transfer-ownership': {
        nonMember: false,
        VIEWER: false,
        EDITOR: false,
        ROOM_ADMIN: false,
        ROOM_OWNER: true,
      },
      'room:delete': { nonMember: false, VIEWER: false, EDITOR: false, ROOM_ADMIN: false, ROOM_OWNER: true },
    };

    expect(Object.keys(matrix).sort()).toEqual([...ROOM_ACTIONS].sort());

    for (const action of ROOM_ACTIONS) {
      const expected = matrix[action];
      expect(canRoomAction(null, action), `nonMember -> ${action}`).toBe(expected.nonMember);
      for (const role of ['VIEWER', 'EDITOR', 'ROOM_ADMIN', 'ROOM_OWNER'] as RoomRole[]) {
        expect(canRoomAction(role, action), `${role} -> ${action}`).toBe(expected[role]);
      }
    }
  });

  it('denies all room actions when user is banned and enforces contextual room rules', () => {
    for (const action of ROOM_ACTIONS) {
      expect(canRoomAction(null, action, { isBanned: true })).toBe(false);
      expect(canRoomAction('EDITOR', action, { isBanned: true })).toBe(false);
    }

    // Private room visibility
    expect(canRoomAction(null, 'room:view-listed', { visibility: 'private' })).toBe(false);
    expect(
      canRoomAction(null, 'room:view-listed', { visibility: 'private', actorServerRole: 'SERVER_ADMIN' }),
    ).toBe(true);
    expect(canRoomAction(null, 'room:request-join', { visibility: 'private' })).toBe(false);
    expect(canRoomAction(null, 'room:accept-direct-invite', { isInvitee: false })).toBe(false);

    // member:invite-user role limits
    expect(canRoomAction('ROOM_ADMIN', 'member:invite-user', { assignedRole: 'EDITOR' })).toBe(true);
    expect(canRoomAction('ROOM_ADMIN', 'member:invite-user', { assignedRole: 'ROOM_ADMIN' })).toBe(false);
    expect(canRoomAction('ROOM_OWNER', 'member:invite-user', { assignedRole: 'ROOM_ADMIN' })).toBe(true);
    expect(canRoomAction('ROOM_OWNER', 'member:invite-user', { assignedRole: 'ROOM_OWNER' })).toBe(false);

    // member:create-invite-code & review-join-request role limits
    expect(canRoomAction('ROOM_OWNER', 'member:create-invite-code', { assignedRole: 'ROOM_ADMIN' })).toBe(false);
    expect(canRoomAction('ROOM_OWNER', 'member:review-join-request', { assignedRole: 'ROOM_ADMIN' })).toBe(false);

    // member:change-role-below-admin vs promote-demote-admin
    expect(
      canRoomAction('ROOM_ADMIN', 'member:change-role-below-admin', {
        targetRoomRole: 'VIEWER',
        assignedRole: 'EDITOR',
      }),
    ).toBe(true);
    expect(
      canRoomAction('ROOM_ADMIN', 'member:change-role-below-admin', {
        targetRoomRole: 'ROOM_ADMIN',
        assignedRole: 'EDITOR',
      }),
    ).toBe(false);
    expect(
      canRoomAction('ROOM_ADMIN', 'member:change-role-below-admin', {
        targetRoomRole: 'EDITOR',
        assignedRole: 'ROOM_ADMIN',
      }),
    ).toBe(false);
    expect(
      canRoomAction('ROOM_OWNER', 'member:promote-demote-admin', {
        targetRoomRole: 'ROOM_OWNER',
        assignedRole: 'ROOM_ADMIN',
      }),
    ).toBe(false);

    // member:kick-ban target limits
    expect(canRoomAction('ROOM_ADMIN', 'member:kick-ban', { targetRoomRole: 'EDITOR' })).toBe(true);
    expect(canRoomAction('ROOM_ADMIN', 'member:kick-ban', { targetRoomRole: 'ROOM_ADMIN' })).toBe(false);
    expect(canRoomAction('ROOM_ADMIN', 'member:kick-ban', { targetRoomRole: 'ROOM_OWNER' })).toBe(false);
    expect(canRoomAction('ROOM_OWNER', 'member:kick-ban', { targetRoomRole: 'ROOM_ADMIN' })).toBe(true);
    expect(canRoomAction('ROOM_OWNER', 'member:kick-ban', { targetRoomRole: 'ROOM_OWNER' })).toBe(false);

    // room:delete server admin override
    expect(canRoomAction(null, 'room:delete', { actorServerRole: 'SERVER_ADMIN' })).toBe(true);
    expect(canRoomAction('VIEWER', 'room:delete', { actorServerRole: 'SERVER_OWNER' })).toBe(true);
  });
});

describe('authorizeOp', () => {
  const alice: LockHolder = {
    userId: 'usr_alice',
    name: 'Alice Engineer',
    color: '#3b82f6',
  };

  const bob: LockHolder = {
    userId: 'usr_bob',
    name: 'Bob Reviewer',
    color: '#10b981',
  };

  function buildSampleWorkspace() {
    let ws = createWorkspace('Avionics', 'AV');
    ws = addComponent(ws, 'REQUIREMENT', 'Navigation', 'NAV', null);
    const modId = ws.domains.REQUIREMENT.components[0]!.id;
    ws = addRequirementSet(ws, 'REQUIREMENT', modId, 'Autopilot', 'AP');
    const fnId = ws.domains.REQUIREMENT.requirementSets[0]!.requirementSetId;
    ws = addItem(ws, 'REQUIREMENT', fnId, { col_desc: 'The system shall maintain altitude.' });
    ws = addItem(ws, 'REQUIREMENT', fnId, { col_desc: 'The system shall maintain heading.' });
    const item1Id = ws.domains.REQUIREMENT.requirementSets[0]!.items[0]!.id;
    const item2Id = ws.domains.REQUIREMENT.requirementSets[0]!.items[1]!.id;

    // Submodule with child function and child item
    ws = addComponent(ws, 'REQUIREMENT', 'FlightManagement', 'FMS', modId);
    const subModId = ws.domains.REQUIREMENT.components[1]!.id;
    ws = addRequirementSet(ws, 'REQUIREMENT', subModId, 'RoutePlan', 'RP');
    const subFnId = ws.domains.REQUIREMENT.requirementSets[1]!.requirementSetId;
    ws = addItem(ws, 'REQUIREMENT', subFnId, { col_desc: 'The system shall store waypoints.' });
    const subItemId = ws.domains.REQUIREMENT.requirementSets[1]!.items[0]!.id;

    return { ws, modId, fnId, item1Id, item2Id, subModId, subFnId, subItemId };
  }

  it('rejects VIEWER for every op kind (always read-only)', () => {
    const { ws, modId, fnId, item1Id } = buildSampleWorkspace();

    const ops: CollabOp[] = [
      {
        opId: 'op_1',
        kind: 'hierarchy',
        payload: { objectType: 'REQUIREMENT', action: 'addComponent', parentId: null, name: 'NewMod', prefix: 'NM', description: '' },
      },
      {
        opId: 'op_2',
        kind: 'hierarchy',
        payload: { objectType: 'REQUIREMENT', action: 'editComponent', id: modId, name: 'Renamed', prefix: 'NAV', description: '' },
      },
      {
        opId: 'op_3',
        kind: 'hierarchy',
        payload: { objectType: 'REQUIREMENT', action: 'deleteComponent', id: modId },
      },
      {
        opId: 'op_4',
        kind: 'item.add',
        payload: { objectType: 'REQUIREMENT', requirementSetId: fnId, values: { col_desc: 'New requirement' } },
      },
      {
        opId: 'op_5',
        kind: 'item.edit',
        payload: { objectType: 'REQUIREMENT', requirementSetId: fnId, itemId: item1Id, values: { col_desc: 'Edited requirement' } },
      },
      {
        opId: 'op_6',
        kind: 'item.delete',
        payload: { objectType: 'REQUIREMENT', requirementSetId: fnId, itemId: item1Id },
      },
      {
        opId: 'op_7',
        kind: 'requirementSet.description',
        payload: { objectType: 'REQUIREMENT', requirementSetId: fnId, description: 'Updated scope' },
      },
      {
        opId: 'op_8',
        kind: 'config.update',
        payload: ws.config,
      },
      {
        opId: 'op_9',
        kind: 'room.restore',
        payload: { revisionId: 'rev_123' },
      },
    ];

    for (const op of ops) {
      const res = authorizeOp('VIEWER', op, {}, ws, alice.userId);
      expect(res, `op kind ${op.kind}`).toEqual({
        ok: false,
        code: 'READ_ONLY',
        message: expect.stringContaining('Viewers have read-only access'),
      });
    }
  });

  it('enforces EDITOR permissions: allows item.add, and item.edit only with caller lock', () => {
    const { ws, fnId, item1Id } = buildSampleWorkspace();

    // item.add requires no lock
    const addOp: CollabOp = {
      opId: 'op_add',
      kind: 'item.add',
      payload: { objectType: 'REQUIREMENT', requirementSetId: fnId, values: { col_desc: 'New req' } },
    };
    expect(authorizeOp('EDITOR', addOp, {}, ws, alice.userId)).toEqual({ ok: true });

    // item.edit: caller holds lock -> allowed
    const editOp: CollabOp = {
      opId: 'op_edit',
      kind: 'item.edit',
      payload: { objectType: 'REQUIREMENT', requirementSetId: fnId, itemId: item1Id, values: { col_desc: 'Edited' } },
    };
    expect(authorizeOp('EDITOR', editOp, { [`item:${item1Id}`]: alice }, ws, alice.userId)).toEqual({ ok: true });

    // item.edit: lock free (unheld) -> rejected with LOCKED
    expect(authorizeOp('EDITOR', editOp, {}, ws, alice.userId)).toEqual({
      ok: false,
      code: 'LOCKED',
      targetId: item1Id,
      message: `Operation requires lock 'item:${item1Id}'.`,
    });

    // item.edit: lock held by another user -> rejected with LOCKED
    expect(authorizeOp('EDITOR', editOp, { [`item:${item1Id}`]: bob }, ws, alice.userId)).toEqual({
      ok: false,
      code: 'LOCKED',
      targetId: item1Id,
      message: `Operation requires lock 'item:${item1Id}'.`,
    });
  });

  it('enforces EDITOR permissions: allows item.delete when free or held by caller, rejects when held by other', () => {
    const { ws, fnId, item1Id } = buildSampleWorkspace();

    const delOp: CollabOp = {
      opId: 'op_del',
      kind: 'item.delete',
      payload: { objectType: 'REQUIREMENT', requirementSetId: fnId, itemId: item1Id },
    };

    // Free -> allowed
    expect(authorizeOp('EDITOR', delOp, {}, ws, alice.userId)).toEqual({ ok: true });

    // Held by caller -> allowed
    expect(authorizeOp('EDITOR', delOp, { [`item:${item1Id}`]: alice }, ws, alice.userId)).toEqual({ ok: true });

    // Held by another -> rejected with LOCKED
    expect(authorizeOp('EDITOR', delOp, { [`item:${item1Id}`]: bob }, ws, alice.userId)).toEqual({
      ok: false,
      code: 'LOCKED',
      targetId: item1Id,
      message: `Item '${item1Id}' is locked by Bob Reviewer.`,
    });
  });

  it('enforces function.description lock rule: caller must hold fn-desc lock', () => {
    const { ws, fnId } = buildSampleWorkspace();

    const descOp: CollabOp = {
      opId: 'op_desc',
      kind: 'requirementSet.description',
      payload: { objectType: 'REQUIREMENT', requirementSetId: fnId, description: 'Updated markdown' },
    };

    // Caller holds fn-desc -> allowed
    expect(authorizeOp('EDITOR', descOp, { [`rs-desc:${fnId}`]: alice }, ws, alice.userId)).toEqual({ ok: true });

    // Free -> rejected with LOCKED
    expect(authorizeOp('EDITOR', descOp, {}, ws, alice.userId)).toEqual({
      ok: false,
      code: 'LOCKED',
      targetId: fnId,
      message: `Operation requires lock 'rs-desc:${fnId}'.`,
    });

    // Held by other -> rejected with LOCKED
    expect(authorizeOp('EDITOR', descOp, { [`rs-desc:${fnId}`]: bob }, ws, alice.userId)).toEqual({
      ok: false,
      code: 'LOCKED',
      targetId: fnId,
      message: `Operation requires lock 'rs-desc:${fnId}'.`,
    });
  });

  it('rejects EDITOR from config.update, room.restore, and deleting module or function', () => {
    const { ws, modId, fnId } = buildSampleWorkspace();

    // config.update
    const configOp: CollabOp = {
      opId: 'op_cfg',
      kind: 'config.update',
      payload: ws.config,
    };
    expect(authorizeOp('EDITOR', configOp, { config: alice }, ws, alice.userId)).toEqual({
      ok: false,
      code: 'FORBIDDEN',
      message: expect.stringContaining('project settings'),
    });

    // room.restore
    const restoreOp: CollabOp = {
      opId: 'op_rst',
      kind: 'room.restore',
      payload: { revisionId: 'rev_123' },
    };
    expect(authorizeOp('EDITOR', restoreOp, {}, ws, alice.userId)).toEqual({
      ok: false,
      code: 'FORBIDDEN',
      message: expect.stringContaining('restore revisions'),
    });

    // deleteComponent
    const delModOp: CollabOp = {
      opId: 'op_dm',
      kind: 'hierarchy',
      payload: { objectType: 'REQUIREMENT', action: 'deleteComponent', id: modId },
    };
    expect(authorizeOp('EDITOR', delModOp, {}, ws, alice.userId)).toEqual({
      ok: false,
      code: 'FORBIDDEN',
      targetId: modId,
      message: expect.stringContaining('delete component'),
    });

    // deleteRequirementSet
    const delFnOp: CollabOp = {
      opId: 'op_df',
      kind: 'hierarchy',
      payload: { objectType: 'REQUIREMENT', action: 'deleteRequirementSet', id: fnId },
    };
    expect(authorizeOp('EDITOR', delFnOp, {}, ws, alice.userId)).toEqual({
      ok: false,
      code: 'FORBIDDEN',
      targetId: fnId,
      message: expect.stringContaining('delete requirement set'),
    });
  });

  it('allows ROOM_ADMIN and ROOM_OWNER config.update only when holding config lock and keeping projectId intact', () => {
    const { ws } = buildSampleWorkspace();

    const configOp: CollabOp = {
      opId: 'op_cfg',
      kind: 'config.update',
      payload: ws.config,
    };

    // Caller holds config lock -> allowed
    expect(authorizeOp('ROOM_ADMIN', configOp, { config: alice }, ws, alice.userId)).toEqual({ ok: true });
    expect(authorizeOp('ROOM_OWNER', configOp, { config: alice }, ws, alice.userId)).toEqual({ ok: true });

    // Free config lock -> rejected with LOCKED
    expect(authorizeOp('ROOM_ADMIN', configOp, {}, ws, alice.userId)).toEqual({
      ok: false,
      code: 'LOCKED',
      message: "Operation requires lock 'config'.",
    });

    // Config lock held by other -> rejected with LOCKED
    expect(authorizeOp('ROOM_OWNER', configOp, { config: bob }, ws, alice.userId)).toEqual({
      ok: false,
      code: 'LOCKED',
      message: "Operation requires lock 'config'.",
    });

    // Modifying immutable projectId -> rejected with FORBIDDEN even when holding lock
    const modifiedConfig = structuredClone(ws.config);
    modifiedConfig.projectId = 'PRJ-different';
    const badIdOp: CollabOp = {
      opId: 'op_cfg_bad',
      kind: 'config.update',
      payload: modifiedConfig,
    };
    expect(authorizeOp('ROOM_ADMIN', badIdOp, { config: alice }, ws, alice.userId)).toEqual({
      ok: false,
      code: 'FORBIDDEN',
      message: expect.stringContaining('Project ID is immutable'),
    });
  });

  it('allows ROOM_ADMIN and ROOM_OWNER room.restore without lock requirement', () => {
    const { ws } = buildSampleWorkspace();
    const restoreOp: CollabOp = {
      opId: 'op_rst',
      kind: 'room.restore',
      payload: { revisionId: 'rev_123' },
    };

    expect(authorizeOp('ROOM_ADMIN', restoreOp, {}, ws, alice.userId)).toEqual({ ok: true });
    expect(authorizeOp('ROOM_OWNER', restoreOp, {}, ws, alice.userId)).toEqual({ ok: true });
  });

  it('enforces hierarchy editing locks: editComponent and authorRequirementSet require node lock held or free', () => {
    const { ws, modId, fnId } = buildSampleWorkspace();

    const editModOp: CollabOp = {
      opId: 'op_em',
      kind: 'hierarchy',
      payload: { objectType: 'REQUIREMENT', action: 'editComponent', id: modId, name: 'NAV2', prefix: 'N2', description: '' },
    };
    const editFnOp: CollabOp = {
      opId: 'op_ef',
      kind: 'hierarchy',
      payload: { objectType: 'REQUIREMENT', action: 'editRequirementSet', id: fnId, name: 'AP2', prefix: 'A2', description: '' },
    };

    // Free -> allowed
    expect(authorizeOp('EDITOR', editModOp, {}, ws, alice.userId)).toEqual({ ok: true });
    expect(authorizeOp('EDITOR', editFnOp, {}, ws, alice.userId)).toEqual({ ok: true });

    // Held by caller -> allowed
    expect(authorizeOp('EDITOR', editModOp, { [`node:${modId}`]: alice }, ws, alice.userId)).toEqual({ ok: true });
    expect(authorizeOp('EDITOR', editFnOp, { [`node:${fnId}`]: alice }, ws, alice.userId)).toEqual({ ok: true });

    // Held by other -> rejected with LOCKED
    expect(authorizeOp('EDITOR', editModOp, { [`node:${modId}`]: bob }, ws, alice.userId)).toEqual({
      ok: false,
      code: 'LOCKED',
      targetId: modId,
      message: `Node '${modId}' is locked by Bob Reviewer.`,
    });
    expect(authorizeOp('EDITOR', editFnOp, { [`node:${fnId}`]: bob }, ws, alice.userId)).toEqual({
      ok: false,
      code: 'LOCKED',
      targetId: fnId,
      message: `Node '${fnId}' is locked by Bob Reviewer.`,
    });
  });

  it('rejects deleteRequirementSet if another user holds a lock anywhere in the function subtree', () => {
    const { ws, fnId, item1Id } = buildSampleWorkspace();

    const delFnOp: CollabOp = {
      opId: 'op_df',
      kind: 'hierarchy',
      payload: { objectType: 'REQUIREMENT', action: 'deleteRequirementSet', id: fnId },
    };

    // Free subtree -> allowed for ROOM_ADMIN
    expect(authorizeOp('ROOM_ADMIN', delFnOp, {}, ws, alice.userId)).toEqual({ ok: true });

    // Caller holds locks in subtree -> allowed
    expect(
      authorizeOp(
        'ROOM_ADMIN',
        delFnOp,
        {
          [`node:${fnId}`]: alice,
          [`rs-desc:${fnId}`]: alice,
          [`item:${item1Id}`]: alice,
        },
        ws,
        alice.userId,
      ),
    ).toEqual({ ok: true });

    // Other holds node lock -> rejected with LOCKED
    expect(authorizeOp('ROOM_ADMIN', delFnOp, { [`node:${fnId}`]: bob }, ws, alice.userId)).toEqual({
      ok: false,
      code: 'LOCKED',
      targetId: fnId,
      message: `Node '${fnId}' is locked by Bob Reviewer.`,
    });

    // Other holds fn-desc lock -> rejected with LOCKED
    expect(authorizeOp('ROOM_ADMIN', delFnOp, { [`rs-desc:${fnId}`]: bob }, ws, alice.userId)).toEqual({
      ok: false,
      code: 'LOCKED',
      targetId: fnId,
      message: `Cannot delete requirement set '${fnId}' while locks are held in its subtree.`,
    });

    // Other holds item lock inside function -> rejected with LOCKED
    expect(authorizeOp('ROOM_ADMIN', delFnOp, { [`item:${item1Id}`]: bob }, ws, alice.userId)).toEqual({
      ok: false,
      code: 'LOCKED',
      targetId: item1Id,
      message: `Cannot delete requirement set '${fnId}' while locks are held in its subtree.`,
    });
  });

  it('rejects deleteComponent if another user holds a lock anywhere in the module subtree (submodules, requirementSets, items)', () => {
    const { ws, modId, subModId, fnId, subFnId, item1Id, subItemId } = buildSampleWorkspace();

    const delModOp: CollabOp = {
      opId: 'op_dm',
      kind: 'hierarchy',
      payload: { objectType: 'REQUIREMENT', action: 'deleteComponent', id: modId },
    };

    // Free subtree -> allowed for ROOM_OWNER
    expect(authorizeOp('ROOM_OWNER', delModOp, {}, ws, alice.userId)).toEqual({ ok: true });

    // Caller holds locks across entire subtree -> allowed
    expect(
      authorizeOp(
        'ROOM_OWNER',
        delModOp,
        {
          [`node:${modId}`]: alice,
          [`node:${subModId}`]: alice,
          [`node:${fnId}`]: alice,
          [`rs-desc:${fnId}`]: alice,
          [`item:${item1Id}`]: alice,
          [`node:${subFnId}`]: alice,
          [`item:${subItemId}`]: alice,
        },
        ws,
        alice.userId,
      ),
    ).toEqual({ ok: true });

    // Other holds root module lock -> rejected
    expect(authorizeOp('ROOM_OWNER', delModOp, { [`node:${modId}`]: bob }, ws, alice.userId)).toEqual({
      ok: false,
      code: 'LOCKED',
      targetId: modId,
      message: `Node '${modId}' is locked by Bob Reviewer.`,
    });

    // Other holds submodule lock -> rejected
    expect(authorizeOp('ROOM_OWNER', delModOp, { [`node:${subModId}`]: bob }, ws, alice.userId)).toEqual({
      ok: false,
      code: 'LOCKED',
      targetId: subModId,
      message: `Cannot delete component '${modId}' while locks are held in its subtree.`,
    });

    // Other holds function lock in module -> rejected
    expect(authorizeOp('ROOM_OWNER', delModOp, { [`node:${fnId}`]: bob }, ws, alice.userId)).toEqual({
      ok: false,
      code: 'LOCKED',
      targetId: fnId,
      message: `Cannot delete component '${modId}' while locks are held in its subtree.`,
    });

    // Other holds fn-desc lock in module -> rejected
    expect(authorizeOp('ROOM_OWNER', delModOp, { [`rs-desc:${fnId}`]: bob }, ws, alice.userId)).toEqual({
      ok: false,
      code: 'LOCKED',
      targetId: fnId,
      message: `Cannot delete component '${modId}' while locks are held in its subtree.`,
    });

    // Other holds item lock in module function -> rejected
    expect(authorizeOp('ROOM_OWNER', delModOp, { [`item:${item1Id}`]: bob }, ws, alice.userId)).toEqual({
      ok: false,
      code: 'LOCKED',
      targetId: item1Id,
      message: `Cannot delete component '${modId}' while locks are held in its subtree.`,
    });

    // Other holds item lock in child submodule function -> rejected
    expect(authorizeOp('ROOM_OWNER', delModOp, { [`item:${subItemId}`]: bob }, ws, alice.userId)).toEqual({
      ok: false,
      code: 'LOCKED',
      targetId: subItemId,
      message: `Cannot delete component '${modId}' while locks are held in its subtree.`,
    });
  });

  it('treats expired lease locks as free', () => {
    const { ws, fnId, item1Id } = buildSampleWorkspace();

    const expiredLock: LockInfo = {
      holder: bob,
      expiresAt: Date.now() - 5000, // expired 5 seconds ago
    };

    const delOp: CollabOp = {
      opId: 'op_del',
      kind: 'item.delete',
      payload: { objectType: 'REQUIREMENT', requirementSetId: fnId, itemId: item1Id },
    };

    // Item delete allowed because bob's lock has expired
    expect(authorizeOp('EDITOR', delOp, { [`item:${item1Id}`]: expiredLock }, ws, alice.userId)).toEqual({
      ok: true,
    });

    // Item edit rejected because caller does not hold an active lock
    const editOp: CollabOp = {
      opId: 'op_edit',
      kind: 'item.edit',
      payload: { objectType: 'REQUIREMENT', requirementSetId: fnId, itemId: item1Id, values: { col_desc: 'Test' } },
    };
    expect(authorizeOp('EDITOR', editOp, { [`item:${item1Id}`]: expiredLock }, ws, alice.userId)).toEqual({
      ok: false,
      code: 'LOCKED',
      targetId: item1Id,
      message: `Operation requires lock 'item:${item1Id}'.`,
    });
  });
});
