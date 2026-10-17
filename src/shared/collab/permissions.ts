import type { Workspace } from '../types/workspace.js';
import {
  ROOM_ACTIONS,
  ROOM_ROLES,
  SERVER_ACTIONS,
  SERVER_ROLES,
  type CollabOp,
  type LockHolder,
  type LockInfo,
  type OpRejectCode,
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

export type OpAuthorizationResult =
  | { ok: true }
  | {
      ok: false;
      code: OpRejectCode;
      targetId?: string;
      message: string;
    };

export function authorizeOp(
  role: RoomRole,
  op: CollabOp,
  lockState: Record<string, LockHolder | LockInfo | undefined>,
  workspace: Workspace,
  actor?: string | { userId?: string },
): OpAuthorizationResult {
  // 1. Viewers are always read-only
  if (role === 'VIEWER') {
    return {
      ok: false,
      code: 'READ_ONLY',
      message: 'Viewers have read-only access and cannot submit operations.',
    };
  }

  const userId = typeof actor === 'string' ? actor : actor?.userId;

  function getHolder(key: string): LockHolder | null {
    const entry = lockState[key];
    if (!entry) return null;
    if ('expiresAt' in entry && typeof entry.expiresAt === 'number' && entry.expiresAt <= Date.now()) {
      return null;
    }
    if ('holder' in entry) return entry.holder;
    return entry as LockHolder;
  }

  function isHeldByOther(key: string): boolean {
    const holder = getHolder(key);
    if (!holder) return false;
    return holder.userId !== userId;
  }

  function isHeldByCaller(key: string): boolean {
    if (!userId) return false;
    const holder = getHolder(key);
    if (!holder) return false;
    return holder.userId === userId;
  }

  switch (op.kind) {
    case 'hierarchy': {
      const cmd = op.payload;
      switch (cmd.action) {
        case 'addModule':
        case 'addFunction':
          return { ok: true };

        case 'editModule':
        case 'editFunction': {
          const key = `node:${cmd.id}`;
          if (isHeldByOther(key)) {
            const holder = getHolder(key)!;
            return {
              ok: false,
              code: 'LOCKED',
              targetId: cmd.id,
              message: `Node '${cmd.id}' is locked by ${holder.name}.`,
            };
          }
          return { ok: true };
        }

        case 'deleteModule': {
          if (!hasMinimumRoomRole(role, 'ROOM_ADMIN')) {
            return {
              ok: false,
              code: 'FORBIDDEN',
              targetId: cmd.id,
              message: `Only room admins and owners can delete module '${cmd.id}'.`,
            };
          }
          const key = `node:${cmd.id}`;
          if (isHeldByOther(key)) {
            const holder = getHolder(key)!;
            return {
              ok: false,
              code: 'LOCKED',
              targetId: cmd.id,
              message: `Node '${cmd.id}' is locked by ${holder.name}.`,
            };
          }

          // Subtree lock check: deleting requires no lock held by others anywhere in the subtree
          const domain = workspace.domains[cmd.objectType];
          if (domain) {
            const allModuleIds = new Set<string>([cmd.id]);
            let expanded = true;
            while (expanded) {
              expanded = false;
              for (const m of domain.modules) {
                if (m.parentId && allModuleIds.has(m.parentId) && !allModuleIds.has(m.id)) {
                  allModuleIds.add(m.id);
                  expanded = true;
                }
              }
            }

            for (const modId of allModuleIds) {
              if (modId !== cmd.id && isHeldByOther(`node:${modId}`)) {
                return {
                  ok: false,
                  code: 'LOCKED',
                  targetId: modId,
                  message: `Cannot delete module '${cmd.id}' while locks are held in its subtree.`,
                };
              }
            }

            for (const fn of domain.functions) {
              if (allModuleIds.has(fn.parentModuleId)) {
                if (isHeldByOther(`node:${fn.functionId}`)) {
                  return {
                    ok: false,
                    code: 'LOCKED',
                    targetId: fn.functionId,
                    message: `Cannot delete module '${cmd.id}' while locks are held in its subtree.`,
                  };
                }
                if (isHeldByOther(`fn-desc:${fn.functionId}`)) {
                  return {
                    ok: false,
                    code: 'LOCKED',
                    targetId: fn.functionId,
                    message: `Cannot delete module '${cmd.id}' while locks are held in its subtree.`,
                  };
                }
                for (const itm of fn.items) {
                  if (isHeldByOther(`item:${itm.id}`)) {
                    return {
                      ok: false,
                      code: 'LOCKED',
                      targetId: itm.id,
                      message: `Cannot delete module '${cmd.id}' while locks are held in its subtree.`,
                    };
                  }
                }
              }
            }
          }
          return { ok: true };
        }

        case 'deleteFunction': {
          if (!hasMinimumRoomRole(role, 'ROOM_ADMIN')) {
            return {
              ok: false,
              code: 'FORBIDDEN',
              targetId: cmd.id,
              message: `Only room admins and owners can delete function '${cmd.id}'.`,
            };
          }
          const key = `node:${cmd.id}`;
          if (isHeldByOther(key)) {
            const holder = getHolder(key)!;
            return {
              ok: false,
              code: 'LOCKED',
              targetId: cmd.id,
              message: `Node '${cmd.id}' is locked by ${holder.name}.`,
            };
          }

          if (isHeldByOther(`fn-desc:${cmd.id}`)) {
            return {
              ok: false,
              code: 'LOCKED',
              targetId: cmd.id,
              message: `Cannot delete function '${cmd.id}' while locks are held in its subtree.`,
            };
          }

          const domain = workspace.domains[cmd.objectType];
          const fn = domain?.functions.find(f => f.functionId === cmd.id);
          if (fn) {
            for (const itm of fn.items) {
              if (isHeldByOther(`item:${itm.id}`)) {
                return {
                  ok: false,
                  code: 'LOCKED',
                  targetId: itm.id,
                  message: `Cannot delete function '${cmd.id}' while locks are held in its subtree.`,
                };
              }
            }
          }
          return { ok: true };
        }
      }
      return { ok: true };
    }

    case 'item.add': {
      // Queue serializes adds; no lock required. Allowed for Editor, Admin, Owner.
      return { ok: true };
    }

    case 'item.edit': {
      // Caller must hold item:<itemId>
      const key = `item:${op.payload.itemId}`;
      if (!isHeldByCaller(key)) {
        return {
          ok: false,
          code: 'LOCKED',
          targetId: op.payload.itemId,
          message: `Operation requires lock '${key}'.`,
        };
      }
      return { ok: true };
    }

    case 'item.delete': {
      // Lock must be free or held by caller
      const key = `item:${op.payload.itemId}`;
      if (isHeldByOther(key)) {
        const holder = getHolder(key)!;
        return {
          ok: false,
          code: 'LOCKED',
          targetId: op.payload.itemId,
          message: `Item '${op.payload.itemId}' is locked by ${holder.name}.`,
        };
      }
      return { ok: true };
    }

    case 'function.description': {
      // Caller must hold fn-desc:<functionId>
      const key = `fn-desc:${op.payload.functionId}`;
      if (!isHeldByCaller(key)) {
        return {
          ok: false,
          code: 'LOCKED',
          targetId: op.payload.functionId,
          message: `Operation requires lock '${key}'.`,
        };
      }
      return { ok: true };
    }

    case 'config.update': {
      // Caller must hold config; admin only
      if (!hasMinimumRoomRole(role, 'ROOM_ADMIN')) {
        return {
          ok: false,
          code: 'FORBIDDEN',
          message: 'Only room admins and owners can modify project settings.',
        };
      }
      if (op.payload.projectId !== workspace.config.projectId) {
        return {
          ok: false,
          code: 'FORBIDDEN',
          message: 'Project ID is immutable.',
        };
      }
      const key = 'config';
      if (!isHeldByCaller(key)) {
        return {
          ok: false,
          code: 'LOCKED',
          message: `Operation requires lock '${key}'.`,
        };
      }
      return { ok: true };
    }

    case 'room.restore': {
      // Admin only; force-releases all locks with a notice
      if (!hasMinimumRoomRole(role, 'ROOM_ADMIN')) {
        return {
          ok: false,
          code: 'FORBIDDEN',
          message: 'Only room admins and owners can restore revisions.',
        };
      }
      return { ok: true };
    }
  }
}
