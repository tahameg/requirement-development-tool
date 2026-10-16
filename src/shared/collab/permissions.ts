import { objectTypes } from '../types/schema.js';
import type { Workspace } from '../types/workspace.js';
import {
  ROOM_ACTIONS,
  ROOM_ROLES,
  SERVER_ACTIONS,
  SERVER_ROLES,
  type RegistrationMode,
  type RoomAction,
  type RoomCreationMode,
  type RoomRole,
  type RoomVisibility,
  type ServerAction,
  type ServerRole,
} from './types.js';

export { SERVER_ROLES, ROOM_ROLES, SERVER_ACTIONS, ROOM_ACTIONS };

const SERVER_ROLE_RANK: Record<ServerRole, number> = {
  USER: 1,
  SERVER_ADMIN: 2,
  SERVER_OWNER: 3,
};

const ROOM_ROLE_RANK: Record<RoomRole, number> = {
  VIEWER: 1,
  EDITOR: 2,
  ROOM_ADMIN: 3,
  ROOM_OWNER: 4,
};

export function hasMinimumServerRole(actual: ServerRole | null, minimum: ServerRole): boolean {
  if (!actual) return false;
  return SERVER_ROLE_RANK[actual] >= SERVER_ROLE_RANK[minimum];
}

export function hasMinimumRoomRole(actual: RoomRole | null, minimum: RoomRole): boolean {
  if (!actual) return false;
  return ROOM_ROLE_RANK[actual] >= ROOM_ROLE_RANK[minimum];
}

export interface ServerPermissionContext {
  targetRole?: ServerRole;
  assignedRole?: ServerRole;
  roomCreationMode?: RoomCreationMode;
  registrationMode?: RegistrationMode;
  setupRequired?: boolean;
  hasValidSetupToken?: boolean;
}

export interface RoomPermissionContext {
  targetRoomRole?: RoomRole;
  assignedRole?: RoomRole;
  actorServerRole?: ServerRole;
  visibility?: RoomVisibility;
  isBanned?: boolean;
  isInvitee?: boolean;
}

export function canServerAction(
  actorRole: ServerRole | null,
  action: ServerAction,
  context?: ServerPermissionContext,
): boolean {
  switch (action) {
    case 'auth:setup':
      return (
        actorRole === null &&
        context?.setupRequired !== false &&
        context?.hasValidSetupToken !== false
      );

    case 'auth:register':
      return actorRole === null && (context?.registrationMode ?? 'open') !== 'closed';

    case 'auth:login':
    case 'server:view-settings':
      return true;

    case 'auth:logout':
    case 'users:directory':
      return actorRole !== null;

    case 'server:update-settings':
      return actorRole === 'SERVER_OWNER';

    case 'users:list':
    case 'users:approve':
    case 'rooms:list-all-admin':
    case 'rooms:resolve-stuck':
    case 'rooms:force-delete':
    case 'audit:view-server':
      return actorRole === 'SERVER_ADMIN' || actorRole === 'SERVER_OWNER';

    case 'users:create': {
      const requestedRole = context?.assignedRole ?? context?.targetRole ?? 'USER';
      if (actorRole === 'SERVER_ADMIN') {
        return requestedRole === 'USER';
      }
      if (actorRole === 'SERVER_OWNER') {
        return requestedRole === 'USER' || requestedRole === 'SERVER_ADMIN';
      }
      return false;
    }

    case 'users:disable':
    case 'users:reset-password': {
      const targetRole = context?.targetRole ?? 'USER';
      if (actorRole === 'SERVER_ADMIN') {
        return targetRole === 'USER';
      }
      if (actorRole === 'SERVER_OWNER') {
        return targetRole === 'USER' || targetRole === 'SERVER_ADMIN';
      }
      return false;
    }

    case 'users:change-server-role': {
      if (actorRole !== 'SERVER_OWNER') return false;
      const targetRole = context?.targetRole ?? 'USER';
      const assignedRole = context?.assignedRole ?? 'SERVER_ADMIN';
      return targetRole !== 'SERVER_OWNER' && assignedRole !== 'SERVER_OWNER';
    }

    case 'rooms:create': {
      if (actorRole === null) return false;
      if (actorRole === 'SERVER_ADMIN' || actorRole === 'SERVER_OWNER') return true;
      return (context?.roomCreationMode ?? 'all_users') === 'all_users';
    }
  }
}

export function canRoomAction(
  actorRoomRole: RoomRole | null,
  action: RoomAction,
  context?: RoomPermissionContext,
): boolean {
  if (context?.isBanned) {
    return false;
  }

  switch (action) {
    case 'room:view-listed': {
      if (context?.visibility === 'private') {
        return (
          actorRoomRole !== null ||
          context?.actorServerRole === 'SERVER_ADMIN' ||
          context?.actorServerRole === 'SERVER_OWNER'
        );
      }
      return true;
    }

    case 'room:request-join':
      return actorRoomRole === null && (context?.visibility ?? 'listed') === 'listed';

    case 'room:accept-direct-invite':
      return actorRoomRole === null && context?.isInvitee !== false;

    case 'room:redeem-invite-code':
      return actorRoomRole === null;

    case 'room:connect-ws':
    case 'room:broadcast-view-presence':
    case 'room:export':
      return actorRoomRole !== null;

    case 'room:leave':
      return (
        actorRoomRole === 'VIEWER' ||
        actorRoomRole === 'EDITOR' ||
        actorRoomRole === 'ROOM_ADMIN'
      );

    case 'room:broadcast-field-focus':
    case 'item:create':
    case 'item:edit':
    case 'item:delete':
    case 'hierarchy:create-module':
    case 'hierarchy:edit-module':
    case 'hierarchy:create-function':
    case 'hierarchy:edit-function':
      return hasMinimumRoomRole(actorRoomRole, 'EDITOR');

    case 'hierarchy:delete-module':
    case 'hierarchy:delete-function':
    case 'project:edit-settings':
    case 'revision:save':
    case 'revision:history-diff':
    case 'revision:restore':
    case 'member:revoke-invite':
    case 'room:edit-metadata':
    case 'room:view-audit':
      return hasMinimumRoomRole(actorRoomRole, 'ROOM_ADMIN');

    case 'member:invite-user': {
      const assignedRole = context?.assignedRole ?? 'EDITOR';
      if (actorRoomRole === 'ROOM_ADMIN') {
        return assignedRole === 'VIEWER' || assignedRole === 'EDITOR';
      }
      if (actorRoomRole === 'ROOM_OWNER') {
        return (
          assignedRole === 'VIEWER' ||
          assignedRole === 'EDITOR' ||
          assignedRole === 'ROOM_ADMIN'
        );
      }
      return false;
    }

    case 'member:create-invite-code':
    case 'member:review-join-request': {
      if (!hasMinimumRoomRole(actorRoomRole, 'ROOM_ADMIN')) return false;
      const assignedRole = context?.assignedRole ?? 'EDITOR';
      return assignedRole === 'VIEWER' || assignedRole === 'EDITOR';
    }

    case 'member:change-role-below-admin': {
      if (!hasMinimumRoomRole(actorRoomRole, 'ROOM_ADMIN')) return false;
      const targetRole = context?.targetRoomRole ?? 'VIEWER';
      const assignedRole = context?.assignedRole ?? 'EDITOR';
      return (
        (targetRole === 'VIEWER' || targetRole === 'EDITOR') &&
        (assignedRole === 'VIEWER' || assignedRole === 'EDITOR')
      );
    }

    case 'member:promote-demote-admin': {
      if (actorRoomRole !== 'ROOM_OWNER') return false;
      const targetRole = context?.targetRoomRole ?? 'EDITOR';
      const assignedRole = context?.assignedRole ?? 'ROOM_ADMIN';
      return targetRole !== 'ROOM_OWNER' && assignedRole !== 'ROOM_OWNER';
    }

    case 'member:kick-ban': {
      const targetRole = context?.targetRoomRole ?? 'VIEWER';
      if (actorRoomRole === 'ROOM_ADMIN') {
        return targetRole === 'VIEWER' || targetRole === 'EDITOR';
      }
      if (actorRoomRole === 'ROOM_OWNER') {
        return targetRole !== 'ROOM_OWNER';
      }
      return false;
    }

    case 'room:transfer-ownership':
      return actorRoomRole === 'ROOM_OWNER';

    case 'room:delete':
      return (
        actorRoomRole === 'ROOM_OWNER' ||
        context?.actorServerRole === 'SERVER_ADMIN' ||
        context?.actorServerRole === 'SERVER_OWNER'
      );
  }
}

export type YDocDiffValidationResult =
  | { ok: true }
  | {
      ok: false;
      code: 'FORBIDDEN' | 'CONFLICT';
      targetId?: string;
      message: string;
    };

export function validateYDocDiffPermissions(
  actorRoomRole: RoomRole,
  prevWorkspace: Workspace,
  nextWorkspace: Workspace,
): YDocDiffValidationResult {
  if (actorRoomRole === 'VIEWER') {
    return {
      ok: false,
      code: 'FORBIDDEN',
      message: 'Viewers have read-only access and cannot modify the workspace.',
    };
  }

  if (prevWorkspace.config.projectId !== nextWorkspace.config.projectId) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      message: 'Project ID is immutable.',
    };
  }

  const nextRetiredSet = new Set(nextWorkspace.retiredIds);
  for (const retiredId of prevWorkspace.retiredIds) {
    if (!nextRetiredSet.has(retiredId)) {
      return {
        ok: false,
        code: 'FORBIDDEN',
        message: `Retired ID '${retiredId}' cannot be removed.`,
      };
    }
  }

  if (JSON.stringify(prevWorkspace.config) !== JSON.stringify(nextWorkspace.config)) {
    if (!canRoomAction(actorRoomRole, 'project:edit-settings')) {
      return {
        ok: false,
        code: 'FORBIDDEN',
        message: 'Only room admins and owners can modify project settings.',
      };
    }
  }

  for (const type of objectTypes) {
    const prevDomain = prevWorkspace.domains[type];
    const nextDomain = nextWorkspace.domains[type];

    const nextModuleMap = new Map(nextDomain.modules.map(m => [m.id, m]));
    const nextFunctionMap = new Map(nextDomain.functions.map(f => [f.functionId, f]));

    for (const prevMod of prevDomain.modules) {
      if (!nextModuleMap.has(prevMod.id)) {
        if (!canRoomAction(actorRoomRole, 'hierarchy:delete-module')) {
          return {
            ok: false,
            code: 'FORBIDDEN',
            targetId: prevMod.id,
            message: `Only room admins and owners can delete module '${prevMod.id}'.`,
          };
        }
      }
    }

    for (const prevFn of prevDomain.functions) {
      const nextFn = nextFunctionMap.get(prevFn.functionId);
      if (!nextFn) {
        if (!canRoomAction(actorRoomRole, 'hierarchy:delete-function')) {
          return {
            ok: false,
            code: 'FORBIDDEN',
            targetId: prevFn.functionId,
            message: `Only room admins and owners can delete function '${prevFn.functionId}'.`,
          };
        }
      } else if (nextFn.watermarkCounter < prevFn.watermarkCounter) {
        return {
          ok: false,
          code: 'FORBIDDEN',
          targetId: prevFn.functionId,
          message: `Watermark counter for function '${prevFn.functionId}' cannot decrease (${prevFn.watermarkCounter} -> ${nextFn.watermarkCounter}).`,
        };
      }
    }

    for (const nextMod of nextDomain.modules) {
      if (nextMod.parentId !== null && !nextModuleMap.has(nextMod.parentId)) {
        return {
          ok: false,
          code: 'CONFLICT',
          targetId: nextMod.parentId,
          message: 'The module or function you were editing was deleted by an administrator.',
        };
      }
    }

    for (const nextFn of nextDomain.functions) {
      if (!nextModuleMap.has(nextFn.parentModuleId)) {
        return {
          ok: false,
          code: 'CONFLICT',
          targetId: nextFn.parentModuleId,
          message: 'The module or function you were editing was deleted by an administrator.',
        };
      }
    }
  }

  return { ok: true };
}
