import { describe, expect, it } from 'vitest';
import { addItem, deleteItem } from '../../src/main/services/idGenerator.js';
import { addFunction, addModule, createWorkspace } from '../../src/main/services/workspaceFactory.js';
import {
  canRoomAction,
  canServerAction,
  hasMinimumRoomRole,
  hasMinimumServerRole,
  ROOM_ACTIONS,
  SERVER_ACTIONS,
  validateYDocDiffPermissions,
} from '../../src/shared/collab/permissions.js';
import type { RoomAction, RoomRole, ServerAction, ServerRole } from '../../src/shared/collab/types.js';

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
      'hierarchy:create-module': {
        nonMember: false,
        VIEWER: false,
        EDITOR: true,
        ROOM_ADMIN: true,
        ROOM_OWNER: true,
      },
      'hierarchy:edit-module': {
        nonMember: false,
        VIEWER: false,
        EDITOR: true,
        ROOM_ADMIN: true,
        ROOM_OWNER: true,
      },
      'hierarchy:create-function': {
        nonMember: false,
        VIEWER: false,
        EDITOR: true,
        ROOM_ADMIN: true,
        ROOM_OWNER: true,
      },
      'hierarchy:edit-function': {
        nonMember: false,
        VIEWER: false,
        EDITOR: true,
        ROOM_ADMIN: true,
        ROOM_OWNER: true,
      },
      'hierarchy:delete-module': {
        nonMember: false,
        VIEWER: false,
        EDITOR: false,
        ROOM_ADMIN: true,
        ROOM_OWNER: true,
      },
      'hierarchy:delete-function': {
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

describe('validateYDocDiffPermissions', () => {
  function buildSampleWorkspace() {
    let ws = createWorkspace('Avionics', 'AV');
    ws = addModule(ws, 'REQUIREMENT', 'Navigation', 'NAV', null);
    const modId = ws.domains.REQUIREMENT.modules[0]!.id;
    ws = addFunction(ws, 'REQUIREMENT', modId, 'Autopilot', 'AP');
    const fnId = ws.domains.REQUIREMENT.functions[0]!.functionId;
    ws = addItem(ws, 'REQUIREMENT', fnId, { col_desc: 'The system shall maintain altitude.' });
    ws = addItem(ws, 'REQUIREMENT', fnId, { col_desc: 'The system shall maintain heading.' });
    return { ws, modId, fnId };
  }

  it('rejects any workspace modification by a VIEWER', () => {
    const { ws } = buildSampleWorkspace();
    const res = validateYDocDiffPermissions('VIEWER', ws, ws);
    expect(res).toEqual({
      ok: false,
      code: 'FORBIDDEN',
      message: expect.stringContaining('Viewers'),
    });
  });

  it('allows EDITOR to create/edit/delete items and create/edit modules and functions', () => {
    const { ws, modId, fnId } = buildSampleWorkspace();
    let next = addModule(ws, 'REQUIREMENT', 'FlightControl', 'FC', modId);
    next = addFunction(next, 'REQUIREMENT', modId, 'Landing', 'LND');
    next = addItem(next, 'REQUIREMENT', fnId, { col_desc: 'The system shall track glideslope.' });
    const firstItemId = next.domains.REQUIREMENT.functions[0]!.items[0]!.id;
    next = deleteItem(next, 'REQUIREMENT', fnId, firstItemId);

    expect(validateYDocDiffPermissions('EDITOR', ws, next)).toEqual({ ok: true });
  });

  it('rejects EDITOR modifying project config, while allowing ROOM_ADMIN and ROOM_OWNER', () => {
    const { ws } = buildSampleWorkspace();
    const next = structuredClone(ws);
    next.config.projectName = 'Renamed Project';

    expect(validateYDocDiffPermissions('EDITOR', ws, next)).toEqual({
      ok: false,
      code: 'FORBIDDEN',
      message: expect.stringContaining('project settings'),
    });
    expect(validateYDocDiffPermissions('ROOM_ADMIN', ws, next)).toEqual({ ok: true });
    expect(validateYDocDiffPermissions('ROOM_OWNER', ws, next)).toEqual({ ok: true });
  });

  it('rejects changing immutable projectId even for ROOM_OWNER', () => {
    const { ws } = buildSampleWorkspace();
    const next = structuredClone(ws);
    next.config.projectId = 'PRJ-different';

    expect(validateYDocDiffPermissions('ROOM_OWNER', ws, next)).toEqual({
      ok: false,
      code: 'FORBIDDEN',
      message: expect.stringContaining('Project ID is immutable'),
    });
  });

  it('rejects EDITOR deleting modules or functions, while allowing ROOM_ADMIN and ROOM_OWNER', () => {
    const { ws, modId, fnId } = buildSampleWorkspace();

    const withoutFn = structuredClone(ws);
    withoutFn.domains.REQUIREMENT.functions = [];
    expect(validateYDocDiffPermissions('EDITOR', ws, withoutFn)).toEqual({
      ok: false,
      code: 'FORBIDDEN',
      targetId: fnId,
      message: expect.stringContaining('delete function'),
    });
    expect(validateYDocDiffPermissions('ROOM_ADMIN', ws, withoutFn)).toEqual({ ok: true });

    const withoutModAndFn = structuredClone(withoutFn);
    withoutModAndFn.domains.REQUIREMENT.modules = [];
    expect(validateYDocDiffPermissions('EDITOR', ws, withoutModAndFn)).toEqual({
      ok: false,
      code: 'FORBIDDEN',
      targetId: modId,
      message: expect.stringContaining('delete module'),
    });
    expect(validateYDocDiffPermissions('ROOM_OWNER', ws, withoutModAndFn)).toEqual({ ok: true });
  });

  it('rejects decreased watermarkCounter or removed retiredIds for any role', () => {
    const { ws, fnId } = buildSampleWorkspace();
    const itemId = ws.domains.REQUIREMENT.functions[0]!.items[0]!.id;
    const withRetired = deleteItem(ws, 'REQUIREMENT', fnId, itemId);

    const removedRetired = structuredClone(withRetired);
    removedRetired.retiredIds = [];
    expect(validateYDocDiffPermissions('ROOM_OWNER', withRetired, removedRetired)).toEqual({
      ok: false,
      code: 'FORBIDDEN',
      message: expect.stringContaining('Retired ID'),
    });

    const decreasedWatermark = structuredClone(withRetired);
    decreasedWatermark.domains.REQUIREMENT.functions[0]!.watermarkCounter = 1;
    expect(validateYDocDiffPermissions('ROOM_OWNER', withRetired, decreasedWatermark)).toEqual({
      ok: false,
      code: 'FORBIDDEN',
      targetId: fnId,
      message: expect.stringContaining('Watermark counter'),
    });
  });

  it('detects structural conflicts when a function or submodule references a deleted parent module', () => {
    const { ws } = buildSampleWorkspace();

    const orphanedFn = structuredClone(ws);
    orphanedFn.domains.REQUIREMENT.modules = [];
    expect(validateYDocDiffPermissions('ROOM_OWNER', ws, orphanedFn)).toEqual({
      ok: false,
      code: 'CONFLICT',
      targetId: ws.domains.REQUIREMENT.modules[0]!.id,
      message: expect.stringContaining('deleted by an administrator'),
    });

    const orphanedSubmodule = structuredClone(ws);
    orphanedSubmodule.domains.REQUIREMENT.modules.push({
      id: 'mod_sub',
      name: 'Sub',
      prefix: 'SUB',
      description: '',
      parentId: 'mod_deleted_parent',
    });
    expect(validateYDocDiffPermissions('EDITOR', ws, orphanedSubmodule)).toEqual({
      ok: false,
      code: 'CONFLICT',
      targetId: 'mod_deleted_parent',
      message: expect.stringContaining('deleted by an administrator'),
    });
  });
});
