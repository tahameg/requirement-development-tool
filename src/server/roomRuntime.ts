import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { WorkspaceIndex } from '../main/db/sqliteClient.js';
import { addItem } from '../main/services/idGenerator.js';
import { validateWorkspace } from '../main/services/validation.js';
import { loadWorkspace, saveWorkspace } from '../main/services/workspaceService.js';
import {
  canRoomAction,
  hasMinimumRoomRole,
  validateYDocDiffPermissions,
} from '../shared/collab/permissions.js';
import {
  assignUserColor,
  type AwarenessUserState,
  type OnlineMemberInfo,
  type RevisionMetadata,
  type RoomRole,
  type UserProfile,
  type WsServerMessage,
} from '../shared/collab/types.js';
import {
  addYDocRetiredIds,
  cloneYDoc,
  getPendingItemsInYDoc,
  resolveYDocPendingItem,
  syncWorkspaceToYDoc,
  workspaceToYDoc,
  yDocToWorkspace,
} from '../shared/collab/yjsDoc.js';
import type { ObjectType } from '../shared/types/config.js';
import { objectTypes } from '../shared/types/schema.js';
import type { Item, Workspace } from '../shared/types/workspace.js';
import {
  CollabServiceError,
  type RevisionRow,
  type ServerDatabase,
  type YjsUpdateRow,
} from './db.js';
import type { RoomLifecycleEvent, RoomService } from './rooms.js';

export const DEFAULT_AUTOSAVE_DEBOUNCE_MS = 500;
export const DEFAULT_AUTOSAVE_MAX_WAIT_MS = 2000;

export interface RoomClientConnection {
  connectionId: string;
  user: UserProfile;
  role: RoomRole;
  color: string;
  awareness: AwarenessUserState | null;
  send: (message: WsServerMessage) => void;
  close: (code?: number, reason?: string) => void;
}

export interface RoomRuntimeOptions {
  autosaveDebounceMs?: number;
  autosaveMaxWaitMs?: number;
  now?: () => Date;
}

interface InternalYItem {
  deleted?: boolean;
  parent?: unknown;
  parentSub?: string | null;
}

interface InternalYType {
  _item?: InternalYItem | null;
}

function collectWorkspaceStructureIds(workspace: Workspace): {
  moduleIds: Set<string>;
  functionIds: Set<string>;
  itemIds: Set<string>;
} {
  const moduleIds = new Set<string>();
  const functionIds = new Set<string>();
  const itemIds = new Set<string>();

  for (const type of objectTypes) {
    const domain = workspace.domains[type];
    for (const mod of domain.modules) {
      moduleIds.add(mod.id);
    }
    for (const fn of domain.functions) {
      functionIds.add(fn.functionId);
      for (const item of fn.items) {
        itemIds.add(item.id);
      }
    }
  }

  return { moduleIds, functionIds, itemIds };
}

function findDeletedAncestorTargetId(
  changedType: unknown,
  prevModuleIds: ReadonlySet<string>,
  prevFunctionIds: ReadonlySet<string>,
  deletedModuleIds: ReadonlySet<string>,
  deletedFunctionIds: ReadonlySet<string>,
): string | null {
  let current: unknown = changedType;
  let sawDeletedAncestor = false;
  let candidateSub: string | null = null;

  while (current && typeof current === 'object') {
    const yType = current as InternalYType;
    const item = yType._item;
    if (!item) {
      break;
    }

    if (typeof item.parentSub === 'string') {
      const sub = item.parentSub;
      if (deletedModuleIds.has(sub) || deletedFunctionIds.has(sub)) {
        return sub;
      }
      if (item.deleted) {
        sawDeletedAncestor = true;
        if (
          !prevModuleIds.has(sub) &&
          !prevFunctionIds.has(sub) &&
          (sub.startsWith('mod_') || sub.startsWith('fn_'))
        ) {
          return sub;
        }
        candidateSub = sub;
      }
    } else if (item.deleted) {
      sawDeletedAncestor = true;
    }

    current = item.parent;
  }

  if (sawDeletedAncestor && candidateSub) {
    return candidateSub;
  }

  return null;
}

export class RoomRuntime {
  readonly roomId: string;
  readonly ydoc: Y.Doc;
  private workspace!: Workspace;
  private readonly connections = new Map<string, RoomClientConnection>();
  private readonly deletedModuleIds = new Set<string>();
  private readonly deletedFunctionIds = new Set<string>();
  private readonly demotedToViewerUserIds = new Set<string>();
  private readonly autosaveDebounceMs: number;
  private readonly autosaveMaxWaitMs: number;
  private readonly now: () => Date;
  private autosaveStatus: 'autosaved' | 'saving' = 'autosaved';
  private lastAutosavedAt: string | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();
  private initialized = false;
  private disposed = false;

  constructor(
    roomId: string,
    private readonly serverDb: ServerDatabase,
    private readonly roomService: RoomService,
    options: RoomRuntimeOptions = {},
  ) {
    this.roomId = roomId;
    this.ydoc = new Y.Doc();
    this.autosaveDebounceMs = options.autosaveDebounceMs ?? DEFAULT_AUTOSAVE_DEBOUNCE_MS;
    this.autosaveMaxWaitMs = options.autosaveMaxWaitMs ?? DEFAULT_AUTOSAVE_MAX_WAIT_MS;
    this.now = options.now ?? (() => new Date());
  }

  static async create(
    roomId: string,
    serverDb: ServerDatabase,
    roomService: RoomService,
    options?: RoomRuntimeOptions,
  ): Promise<RoomRuntime> {
    const runtime = new RoomRuntime(roomId, serverDb, roomService, options);
    await runtime.initialize();
    return runtime;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const summary = this.roomService.getRoomSummary(this.roomId);
    this.lastAutosavedAt = summary.lastAutosavedAt;

    const workspaceDir = this.roomService.getRoomWorkspaceDir(this.roomId);
    const baseWorkspace = await loadWorkspace(workspaceDir);

    const updateRows = this.serverDb.db
      .prepare('SELECT id, room_id, update_blob, created_at FROM yjs_updates WHERE room_id = ? ORDER BY id ASC')
      .all(this.roomId) as YjsUpdateRow[];

    if (updateRows.length > 0) {
      for (const row of updateRows) {
        Y.applyUpdate(this.ydoc, new Uint8Array(row.update_blob));
      }

      // Resolve any pending items left in the WAL before a crash
      this.resolveAllPendingItemsInDoc();

      const recoveredWorkspace = validateWorkspace(yDocToWorkspace(this.ydoc));
      this.workspace = recoveredWorkspace;

      if (
        updateRows.length > 1 ||
        JSON.stringify(recoveredWorkspace) !== JSON.stringify(baseWorkspace)
      ) {
        await this.materializeAndCompact();
      }
    } else {
      workspaceToYDoc(baseWorkspace, this.ydoc);
      this.workspace = baseWorkspace;
      this.compactYjsUpdatesLog(this.now().toISOString());
    }

    this.initialized = true;
  }

  getWorkspace(): Workspace {
    return structuredClone(this.workspace);
  }

  getStateUpdateBytes(stateVector?: Uint8Array): Uint8Array {
    return stateVector
      ? Y.encodeStateAsUpdate(this.ydoc, stateVector)
      : Y.encodeStateAsUpdate(this.ydoc);
  }

  getStateUpdateBase64(stateVector?: Uint8Array): string {
    return Buffer.from(this.getStateUpdateBytes(stateVector)).toString('base64');
  }

  getAutosaveState(): { status: 'autosaved' | 'saving'; lastAutosavedAt: string | null } {
    return {
      status: this.autosaveStatus,
      lastAutosavedAt: this.lastAutosavedAt,
    };
  }

  getLastRevision(): RevisionMetadata | null {
    const row = this.serverDb.db
      .prepare('SELECT * FROM revisions WHERE room_id = ? ORDER BY seq DESC LIMIT 1')
      .get(this.roomId) as RevisionRow | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      roomId: row.room_id,
      seq: row.seq,
      message: row.message,
      authorId: row.author_id,
      authorName: row.author_name,
      snapshotFilename: row.snapshot_filename,
      restoredFromId: row.restored_from_id,
      createdAt: row.created_at,
    };
  }

  getOnlineUserIds(): Set<string> {
    const ids = new Set<string>();
    for (const conn of this.connections.values()) {
      ids.add(conn.user.id);
    }
    return ids;
  }

  getOnlineMembers(): OnlineMemberInfo[] {
    const byUserId = new Map<string, OnlineMemberInfo>();
    for (const conn of this.connections.values()) {
      if (!byUserId.has(conn.user.id)) {
        byUserId.set(conn.user.id, {
          userId: conn.user.id,
          username: conn.user.username,
          displayName: conn.user.displayName,
          role: conn.role,
          color: conn.color,
        });
      }
    }
    return Array.from(byUserId.values());
  }

  getAwarenessStates(): AwarenessUserState[] {
    const byUserId = new Map<string, AwarenessUserState>();
    for (const conn of this.connections.values()) {
      if (!conn.awareness) continue;
      const existing = byUserId.get(conn.user.id);
      if (!existing || conn.awareness.updatedAt >= existing.updatedAt) {
        byUserId.set(conn.user.id, conn.awareness);
      }
    }
    return Array.from(byUserId.values());
  }

  addClient(input: {
    connectionId?: string;
    user: UserProfile;
    send: (message: WsServerMessage) => void;
    close: (code?: number, reason?: string) => void;
  }): string {
    if (this.disposed) {
      throw new CollabServiceError('NOT_FOUND', `Room '${this.roomId}' is closed.`);
    }

    if (this.roomService.isUserBanned(this.roomId, input.user.id)) {
      throw new CollabServiceError('FORBIDDEN', 'You are banned from this room.');
    }

    const role = this.roomService.getMemberRole(this.roomId, input.user.id);
    if (!canRoomAction(role, 'room:connect-ws', { isBanned: false }) || role === null) {
      throw new CollabServiceError('FORBIDDEN', 'You are not a member of this room.');
    }

    const wasAlreadyOnline = this.getOnlineUserIds().has(input.user.id);
    const connectionId = input.connectionId ?? `conn_${randomUUID()}`;
    const color = assignUserColor(input.user.id);

    const conn: RoomClientConnection = {
      connectionId,
      user: input.user,
      role,
      color,
      awareness: null,
      send: input.send,
      close: input.close,
    };

    this.connections.set(connectionId, conn);

    this.safeSend(conn, {
      type: 'room-welcome',
      roomId: this.roomId,
      role,
      stateUpdate: this.getStateUpdateBase64(),
      awarenessStates: this.getAwarenessStates(),
      onlineMembers: this.getOnlineMembers(),
      autosaveStatus: this.getAutosaveState(),
      lastRevision: this.getLastRevision(),
    });

    this.broadcastAwareness(connectionId);

    if (!wasAlreadyOnline) {
      this.broadcast(
        {
          type: 'room-notification',
          kind: 'user-joined',
          message: `${input.user.displayName} connected to the room.`,
          targetUserId: input.user.id,
          newRole: role,
          timestamp: this.now().toISOString(),
        },
        connectionId,
      );
    }

    return connectionId;
  }

  removeClient(connectionId: string): void {
    const conn = this.connections.get(connectionId);
    if (!conn) {
      return;
    }

    this.connections.delete(connectionId);
    const stillOnline = this.getOnlineUserIds().has(conn.user.id);

    this.broadcastAwareness();

    if (!stillOnline && !this.disposed) {
      this.broadcast({
        type: 'room-notification',
        kind: 'user-left',
        message: `${conn.user.displayName} left the room.`,
        targetUserId: conn.user.id,
        timestamp: this.now().toISOString(),
      });
    }
  }

  handleSyncStep1(connectionId: string, stateVectorBase64: string): void {
    const conn = this.connections.get(connectionId);
    if (!conn || this.disposed) {
      return;
    }

    try {
      const stateVector = new Uint8Array(Buffer.from(stateVectorBase64, 'base64'));
      const diffUpdate = this.getStateUpdateBase64(stateVector);
      this.safeSend(conn, {
        type: 'sync-step2',
        update: diffUpdate,
      });
    } catch {
      this.safeSend(conn, {
        type: 'error',
        code: 'BAD_REQUEST',
        message: 'Invalid Yjs state vector in sync-step1.',
      });
    }
  }

  handleAwarenessUpdate(connectionId: string, state: AwarenessUserState | null): void {
    const conn = this.connections.get(connectionId);
    if (!conn || this.disposed) {
      return;
    }

    const currentRole = this.roomService.getMemberRole(this.roomId, conn.user.id);
    if (!currentRole || this.roomService.isUserBanned(this.roomId, conn.user.id)) {
      return;
    }
    conn.role = currentRole;

    if (state === null) {
      conn.awareness = null;
    } else {
      const canFocus = canRoomAction(currentRole, 'room:broadcast-field-focus');
      conn.awareness = {
        userId: conn.user.id,
        username: conn.user.username,
        displayName: conn.user.displayName,
        role: currentRole,
        color: conn.color,
        view: state.view,
        focus: canFocus ? state.focus : null,
        updatedAt: state.updatedAt || this.now().getTime(),
      };
    }

    this.broadcastAwareness();
  }

  async applyClientUpdate(
    connectionId: string,
    updateBase64: string,
    clientOpId?: string,
  ): Promise<void> {
    return this.enqueueMutation(async () => {
      const conn = this.connections.get(connectionId);
      if (!conn || this.disposed) {
        return;
      }

      const isBanned = this.roomService.isUserBanned(this.roomId, conn.user.id);
      const currentRole = this.roomService.getMemberRole(this.roomId, conn.user.id);

      if (isBanned || currentRole === null) {
        const correctiveUpdate = this.computeCorrectiveUpdateBase64(updateBase64);
        this.safeSend(conn, {
          type: 'error',
          code: 'PERMISSION_REVOKED',
          message: 'Your room membership or write permissions were revoked.',
          correctiveUpdate,
        });
        this.safeSend(conn, {
          type: 'sync-step2',
          update: correctiveUpdate,
        });
        conn.close(4403, 'Membership revoked');
        this.connections.delete(connectionId);
        return;
      }

      const previousConnRole = conn.role;
      conn.role = currentRole;

      if (currentRole === 'VIEWER') {
        const wasDemoted =
          previousConnRole !== 'VIEWER' || this.demotedToViewerUserIds.has(conn.user.id);
        this.demotedToViewerUserIds.delete(conn.user.id);
        const code = wasDemoted ? 'PERMISSION_REVOKED' : 'FORBIDDEN';
        const correctiveUpdate = this.computeCorrectiveUpdateBase64(updateBase64);
        this.safeSend(conn, {
          type: 'error',
          code,
          message: wasDemoted
            ? 'Your write permissions were revoked while editing.'
            : 'Viewers have read-only access and cannot modify the workspace.',
          correctiveUpdate,
        });
        this.safeSend(conn, {
          type: 'sync-step2',
          update: correctiveUpdate,
        });
        return;
      }

      let updateBytes: Uint8Array;
      try {
        updateBytes = new Uint8Array(Buffer.from(updateBase64, 'base64'));
        if (updateBytes.byteLength === 0) {
          throw new Error('Empty update');
        }
      } catch {
        this.safeSend(conn, {
          type: 'error',
          code: 'BAD_REQUEST',
          message: 'Invalid base64 Yjs update payload.',
        });
        return;
      }

      const prevStructure = collectWorkspaceStructureIds(this.workspace);
      const stagedDoc = cloneYDoc(this.ydoc);
      let deletedTargetId: string | null = null;

      const onAfterTransaction = (tr: Y.Transaction) => {
        for (const [changedType] of tr.changed.entries()) {
          const target = findDeletedAncestorTargetId(
            changedType,
            prevStructure.moduleIds,
            prevStructure.functionIds,
            this.deletedModuleIds,
            this.deletedFunctionIds,
          );
          if (target) {
            deletedTargetId = target;
            break;
          }
        }
      };

      stagedDoc.on('afterTransaction', onAfterTransaction);
      try {
        Y.applyUpdate(stagedDoc, updateBytes);
      } catch {
        stagedDoc.off('afterTransaction', onAfterTransaction);
        const correctiveUpdate = this.getStateUpdateBase64();
        this.safeSend(conn, {
          type: 'error',
          code: 'BAD_REQUEST',
          message: 'Failed to decode binary Yjs update.',
          correctiveUpdate,
        });
        return;
      }
      stagedDoc.off('afterTransaction', onAfterTransaction);

      if (deletedTargetId) {
        const correctiveUpdate = this.computeCorrectiveUpdateFromStaged(stagedDoc);
        this.safeSend(conn, {
          type: 'conflict',
          code: 'TARGET_DELETED',
          targetId: deletedTargetId,
          message: 'The module or function you were editing was deleted by an administrator.',
          correctiveUpdate,
        });
        this.safeSend(conn, {
          type: 'sync-step2',
          update: correctiveUpdate,
        });
        return;
      }

      const stagedRawWorkspace = yDocToWorkspace(stagedDoc);

      // Ensure any permanent items removed in this update are accounted for in retiredIds before permission/schema validation
      const nextStructure = collectWorkspaceStructureIds(stagedRawWorkspace);
      const missingRetiredIds: string[] = [];
      const stagedRetiredSet = new Set(stagedRawWorkspace.retiredIds);
      for (const prevItemId of prevStructure.itemIds) {
        if (!nextStructure.itemIds.has(prevItemId) && !stagedRetiredSet.has(prevItemId)) {
          missingRetiredIds.push(prevItemId);
          stagedRawWorkspace.retiredIds.push(prevItemId);
        }
      }

      const diffResult = validateYDocDiffPermissions(
        currentRole,
        this.workspace,
        stagedRawWorkspace,
      );
      if (!diffResult.ok) {
        const correctiveUpdate = this.computeCorrectiveUpdateFromStaged(stagedDoc);
        if (diffResult.code === 'CONFLICT') {
          this.safeSend(conn, {
            type: 'conflict',
            code: 'TARGET_DELETED',
            targetId: diffResult.targetId ?? 'unknown',
            message: diffResult.message,
            correctiveUpdate,
          });
        } else {
          this.safeSend(conn, {
            type: 'error',
            code: 'FORBIDDEN',
            message: diffResult.message,
            correctiveUpdate,
          });
        }
        this.safeSend(conn, {
          type: 'sync-step2',
          update: correctiveUpdate,
        });
        return;
      }

      let validatedStagedWorkspace: Workspace;
      try {
        validatedStagedWorkspace = validateWorkspace(stagedRawWorkspace);
      } catch (error) {
        const correctiveUpdate = this.computeCorrectiveUpdateFromStaged(stagedDoc);
        this.safeSend(conn, {
          type: 'error',
          code: 'VALIDATION_ERROR',
          message: error instanceof Error ? error.message : 'Workspace validation failed.',
          correctiveUpdate,
        });
        this.safeSend(conn, {
          type: 'sync-step2',
          update: correctiveUpdate,
        });
        return;
      }

      // Track any newly deleted module or function IDs
      for (const prevModId of prevStructure.moduleIds) {
        if (!nextStructure.moduleIds.has(prevModId)) {
          this.deletedModuleIds.add(prevModId);
        }
      }
      for (const prevFnId of prevStructure.functionIds) {
        if (!nextStructure.functionIds.has(prevFnId)) {
          this.deletedFunctionIds.add(prevFnId);
        }
      }

      // Commit the update to the authoritative Y.Doc
      Y.applyUpdate(this.ydoc, updateBytes);

      let extraRetiredBytes: Uint8Array | null = null;
      if (missingRetiredIds.length > 0) {
        extraRetiredBytes = this.captureDocUpdate(() => {
          addYDocRetiredIds(this.ydoc, missingRetiredIds);
        });
      }

      const combinedUpdate =
        extraRetiredBytes && extraRetiredBytes.byteLength > 0
          ? Y.mergeUpdates([updateBytes, extraRetiredBytes])
          : updateBytes;

      this.appendYjsUpdateLog(combinedUpdate);
      this.workspace = validatedStagedWorkspace;

      const broadcastPayload: WsServerMessage = {
        type: 'sync-update',
        update: Buffer.from(combinedUpdate).toString('base64'),
        actorUserId: conn.user.id,
        ...(clientOpId !== undefined ? { clientOpId } : {}),
      };
      this.broadcast(broadcastPayload);

      // If the client synced any `__pending__:<uuid>` items inside Y.Doc, resolve them atomically
      const pendingItems = getPendingItemsInYDoc(this.ydoc);
      if (pendingItems.length > 0) {
        for (const pending of pendingItems) {
          this.allocatePendingItemInternal(conn, {
            requestId: pending.tempId,
            tempId: pending.tempId,
            objectType: pending.objectType,
            functionId: pending.functionId,
            values: pending.values,
          });
        }
      }

      this.scheduleAutosave();
    });
  }

  async allocateItem(
    connectionId: string,
    input: {
      requestId: string;
      tempId: string;
      objectType: ObjectType;
      functionId: string;
      values: Record<string, string | number | boolean | null>;
    },
  ): Promise<Item | null> {
    return this.enqueueMutation(async () => {
      const conn = this.connections.get(connectionId);
      if (!conn || this.disposed) {
        return null;
      }

      const isBanned = this.roomService.isUserBanned(this.roomId, conn.user.id);
      const currentRole = this.roomService.getMemberRole(this.roomId, conn.user.id);

      if (isBanned || currentRole === null) {
        const correctiveUpdate = this.getStateUpdateBase64();
        this.safeSend(conn, {
          type: 'error',
          code: 'PERMISSION_REVOKED',
          message: 'Your room membership was revoked.',
          requestId: input.requestId,
          correctiveUpdate,
        });
        conn.close(4403, 'Membership revoked');
        this.connections.delete(connectionId);
        return null;
      }

      const previousRole = conn.role;
      conn.role = currentRole;

      if (!canRoomAction(currentRole, 'item:create')) {
        const wasDemoted =
          previousRole !== 'VIEWER' || this.demotedToViewerUserIds.has(conn.user.id);
        this.demotedToViewerUserIds.delete(conn.user.id);
        const correctiveUpdate = this.getStateUpdateBase64();
        this.safeSend(conn, {
          type: 'error',
          code: wasDemoted ? 'PERMISSION_REVOKED' : 'FORBIDDEN',
          message: 'Viewers cannot create items.',
          requestId: input.requestId,
          correctiveUpdate,
        });
        this.safeSend(conn, {
          type: 'sync-step2',
          update: correctiveUpdate,
        });
        return null;
      }

      const allocated = this.allocatePendingItemInternal(conn, input);
      if (allocated) {
        this.scheduleAutosave();
      }
      return allocated;
    });
  }

  private allocatePendingItemInternal(
    conn: RoomClientConnection,
    input: {
      requestId: string;
      tempId: string;
      objectType: ObjectType;
      functionId: string;
      values: Record<string, string | number | boolean | null>;
    },
  ): Item | null {
    const domain = this.workspace.domains[input.objectType];
    const targetFn = domain.functions.find(f => f.functionId === input.functionId);
    if (!targetFn) {
      const correctiveUpdate = this.getStateUpdateBase64();
      if (this.deletedFunctionIds.has(input.functionId)) {
        this.safeSend(conn, {
          type: 'conflict',
          code: 'TARGET_DELETED',
          targetId: input.functionId,
          message: 'The module or function you were editing was deleted by an administrator.',
          correctiveUpdate,
        });
      } else {
        this.safeSend(conn, {
          type: 'error',
          code: 'VALIDATION_ERROR',
          message: `Function '${input.functionId}' not found in ${input.objectType}.`,
          requestId: input.requestId,
          correctiveUpdate,
        });
      }
      this.safeSend(conn, {
        type: 'sync-step2',
        update: correctiveUpdate,
      });
      return null;
    }

    let nextWorkspace: Workspace;
    try {
      nextWorkspace = addItem(this.workspace, input.objectType, input.functionId, input.values);
    } catch (error) {
      const correctiveUpdate = this.getStateUpdateBase64();
      this.safeSend(conn, {
        type: 'error',
        code: 'VALIDATION_ERROR',
        message: error instanceof Error ? error.message : 'Item allocation failed.',
        requestId: input.requestId,
        correctiveUpdate,
      });
      this.safeSend(conn, {
        type: 'sync-step2',
        update: correctiveUpdate,
      });
      return null;
    }

    const updatedFn = nextWorkspace.domains[input.objectType].functions.find(
      f => f.functionId === input.functionId,
    )!;
    const allocatedItem = updatedFn.items[updatedFn.items.length - 1]!;

    const updateBytes = this.captureDocUpdate(() => {
      resolveYDocPendingItem(
        this.ydoc,
        input.objectType,
        input.functionId,
        input.tempId,
        allocatedItem,
      );
    });

    this.workspace = validateWorkspace(yDocToWorkspace(this.ydoc));

    if (updateBytes.byteLength > 0) {
      this.appendYjsUpdateLog(updateBytes);
    }

    this.safeSend(conn, {
      type: 'alloc-item-ack',
      requestId: input.requestId,
      tempId: input.tempId,
      objectType: input.objectType,
      functionId: input.functionId,
      item: allocatedItem,
    });

    if (updateBytes.byteLength > 0) {
      this.broadcast({
        type: 'sync-update',
        update: Buffer.from(updateBytes).toString('base64'),
        actorUserId: conn.user.id,
      });
    }

    return allocatedItem;
  }

  private resolveAllPendingItemsInDoc(): void {
    const pendingItems = getPendingItemsInYDoc(this.ydoc);
    for (const pending of pendingItems) {
      try {
        const currentWorkspace = yDocToWorkspace(this.ydoc);
        const nextWorkspace = addItem(
          currentWorkspace,
          pending.objectType,
          pending.functionId,
          pending.values,
        );
        const updatedFn = nextWorkspace.domains[pending.objectType].functions.find(
          f => f.functionId === pending.functionId,
        );
        const allocatedItem = updatedFn?.items[updatedFn.items.length - 1];
        if (allocatedItem) {
          resolveYDocPendingItem(
            this.ydoc,
            pending.objectType,
            pending.functionId,
            pending.tempId,
            allocatedItem,
          );
        }
      } catch {
        // Ignore unresolvable pending item on recovery
      }
    }
  }

  async replaceWorkspace(nextWorkspace: Workspace, actorUserId = 'system'): Promise<void> {
    return this.enqueueMutation(async () => {
      const validated = validateWorkspace(nextWorkspace);
      const updateBytes = this.captureDocUpdate(() => {
        syncWorkspaceToYDoc(this.ydoc, validated);
      });
      this.workspace = validateWorkspace(yDocToWorkspace(this.ydoc));

      if (updateBytes.byteLength > 0) {
        this.appendYjsUpdateLog(updateBytes);
      }

      await this.materializeAndCompact();

      const fullStateBase64 = this.getStateUpdateBase64();
      this.broadcast({
        type: 'sync-step2',
        update: fullStateBase64,
      });

      if (updateBytes.byteLength > 0) {
        this.broadcast({
          type: 'sync-update',
          update: Buffer.from(updateBytes).toString('base64'),
          actorUserId,
        });
      }
    });
  }

  broadcastRevisionSaved(revision: RevisionMetadata, restoredFromId?: string): void {
    this.broadcast({
      type: 'revision-saved',
      revision,
      ...(restoredFromId !== undefined ? { restoredFromId } : {}),
    });
  }

  handleRoomLifecycleEvent(event: RoomLifecycleEvent): void {
    if (event.roomId !== this.roomId || this.disposed) {
      return;
    }

    const nowIso = this.now().toISOString();

    switch (event.type) {
      case 'room-deleted': {
        this.clearAutosaveTimers();
        this.disposed = true;
        for (const conn of Array.from(this.connections.values())) {
          this.safeSend(conn, {
            type: 'room-deleted',
            reason: event.reason,
          });
          conn.close(4404, event.reason);
        }
        this.connections.clear();
        break;
      }

      case 'member-kicked': {
        for (const [connId, conn] of Array.from(this.connections.entries())) {
          if (conn.user.id === event.userId) {
            this.safeSend(conn, {
              type: 'kicked',
              reason: event.reason,
            });
            conn.close(4403, event.reason);
            this.connections.delete(connId);
          }
        }
        this.broadcastAwareness();
        this.broadcast({
          type: 'room-notification',
          kind: 'member-kicked',
          message: event.reason,
          targetUserId: event.userId,
          timestamp: nowIso,
        });
        break;
      }

      case 'member-banned': {
        for (const [connId, conn] of Array.from(this.connections.entries())) {
          if (conn.user.id === event.userId) {
            this.safeSend(conn, {
              type: 'banned',
              reason: event.reason,
            });
            conn.close(4403, event.reason);
            this.connections.delete(connId);
          }
        }
        this.broadcastAwareness();
        this.broadcast({
          type: 'room-notification',
          kind: 'member-banned',
          message: event.reason,
          targetUserId: event.userId,
          timestamp: nowIso,
        });
        break;
      }

      case 'role-changed': {
        if (event.newRole === 'VIEWER' && event.previousRole !== 'VIEWER') {
          this.demotedToViewerUserIds.add(event.userId);
        } else if (event.newRole !== 'VIEWER') {
          this.demotedToViewerUserIds.delete(event.userId);
        }
        for (const conn of this.connections.values()) {
          if (conn.user.id === event.userId) {
            conn.role = event.newRole;
            if (conn.awareness) {
              conn.awareness = {
                ...conn.awareness,
                role: event.newRole,
                focus: canRoomAction(event.newRole, 'room:broadcast-field-focus')
                  ? conn.awareness.focus
                  : null,
              };
            }
          }
        }
        this.broadcastAwareness();
        this.broadcast({
          type: 'room-notification',
          kind: 'role-changed',
          message: `Member role updated from ${event.previousRole} to ${event.newRole}.`,
          targetUserId: event.userId,
          newRole: event.newRole,
          timestamp: nowIso,
        });
        break;
      }

      case 'ownership-transferred': {
        for (const conn of this.connections.values()) {
          if (conn.user.id === event.previousOwnerId) {
            conn.role = 'ROOM_ADMIN';
            if (conn.awareness) {
              conn.awareness = { ...conn.awareness, role: 'ROOM_ADMIN' };
            }
          } else if (conn.user.id === event.newOwnerId) {
            conn.role = 'ROOM_OWNER';
            if (conn.awareness) {
              conn.awareness = { ...conn.awareness, role: 'ROOM_OWNER' };
            }
          }
        }
        this.broadcastAwareness();
        this.broadcast({
          type: 'room-notification',
          kind: 'ownership-transferred',
          message: 'Room ownership was transferred.',
          targetUserId: event.newOwnerId,
          newRole: 'ROOM_OWNER',
          timestamp: nowIso,
        });
        break;
      }

      case 'join-request-created': {
        for (const conn of this.connections.values()) {
          if (hasMinimumRoomRole(conn.role, 'ROOM_ADMIN')) {
            this.safeSend(conn, {
              type: 'room-notification',
              kind: 'join-request-created',
              message: `${event.joinRequest.displayName} requested to join the room.`,
              targetUserId: event.joinRequest.userId,
              joinRequest: event.joinRequest,
              timestamp: nowIso,
            });
          }
        }
        break;
      }

      case 'join-request-reviewed': {
        this.broadcast({
          type: 'room-notification',
          kind: 'join-request-reviewed',
          message: `Join request for ${event.joinRequest.displayName} was ${event.joinRequest.status.toLowerCase()}.`,
          targetUserId: event.joinRequest.userId,
          ...(event.joinRequest.assignedRole ? { newRole: event.joinRequest.assignedRole } : {}),
          joinRequest: event.joinRequest,
          timestamp: nowIso,
        });
        break;
      }

      case 'member-left': {
        for (const [connId, conn] of Array.from(this.connections.entries())) {
          if (conn.user.id === event.userId) {
            conn.close(1000, 'Left room');
            this.connections.delete(connId);
          }
        }
        this.broadcastAwareness();
        this.broadcast({
          type: 'room-notification',
          kind: 'user-left',
          message: 'A member left the room.',
          targetUserId: event.userId,
          timestamp: nowIso,
        });
        break;
      }

      case 'member-joined': {
        this.broadcast({
          type: 'room-notification',
          kind: 'user-joined',
          message: 'A new member joined the room.',
          targetUserId: event.userId,
          newRole: event.role,
          timestamp: nowIso,
        });
        break;
      }

      case 'room-created':
      case 'room-updated':
        break;
    }
  }

  disconnectUser(userId: string, reason = 'Account session terminated.'): void {
    let removed = false;
    for (const [connId, conn] of Array.from(this.connections.entries())) {
      if (conn.user.id === userId) {
        this.safeSend(conn, {
          type: 'error',
          code: 'PERMISSION_REVOKED',
          message: reason,
        });
        conn.close(4401, reason);
        this.connections.delete(connId);
        removed = true;
      }
    }
    if (removed) {
      this.broadcastAwareness();
    }
  }

  async flushAutosave(): Promise<string | null> {
    this.clearAutosaveTimers();
    if (this.disposed) {
      return this.lastAutosavedAt;
    }
    return this.enqueueMutation(async () => {
      if (this.disposed) {
        return this.lastAutosavedAt;
      }
      return this.materializeAndCompact();
    });
  }

  async close(): Promise<void> {
    await this.flushAutosave();
    this.disposed = true;
    for (const conn of Array.from(this.connections.values())) {
      conn.close(1001, 'Server shutting down');
    }
    this.connections.clear();
  }

  private scheduleAutosave(): void {
    if (this.disposed) {
      return;
    }

    this.autosaveStatus = 'saving';
    const nowIso = this.now().toISOString();
    this.broadcast({
      type: 'autosave-status',
      status: 'saving',
      lastAutosavedAt: this.lastAutosavedAt ?? nowIso,
    });

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.flushAutosave();
    }, this.autosaveDebounceMs);

    if (!this.maxWaitTimer && this.autosaveMaxWaitMs > 0) {
      this.maxWaitTimer = setTimeout(() => {
        this.maxWaitTimer = null;
        void this.flushAutosave();
      }, this.autosaveMaxWaitMs);
    }
  }

  private clearAutosaveTimers(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.maxWaitTimer) {
      clearTimeout(this.maxWaitTimer);
      this.maxWaitTimer = null;
    }
  }

  private async materializeAndCompact(): Promise<string> {
    this.clearAutosaveTimers();
    const workspaceDir = this.roomService.getRoomWorkspaceDir(this.roomId);
    const snapshot = structuredClone(this.workspace);
    await saveWorkspace(workspaceDir, snapshot);
    try {
      const idx = WorkspaceIndex.rebuild(workspaceDir, snapshot);
      idx.close();
    } catch {
      // Non-fatal if cache rebuild fails during shutdown
    }

    const autosavedAt = this.now().toISOString();
    this.compactYjsUpdatesLog(autosavedAt);
    this.roomService.recordAutosave(this.roomId, autosavedAt);
    this.autosaveStatus = 'autosaved';
    this.lastAutosavedAt = autosavedAt;

    this.broadcast({
      type: 'autosave-status',
      status: 'autosaved',
      lastAutosavedAt: autosavedAt,
    });

    return autosavedAt;
  }

  private appendYjsUpdateLog(updateBytes: Uint8Array): void {
    if (!this.serverDb.isOpen()) {
      return;
    }
    const createdAt = this.now().toISOString();
    this.serverDb.db
      .prepare('INSERT INTO yjs_updates (room_id, update_blob, created_at) VALUES (?, ?, ?)')
      .run(this.roomId, Buffer.from(updateBytes), createdAt);
  }

  private compactYjsUpdatesLog(createdAt: string): void {
    if (!this.serverDb.isOpen()) {
      return;
    }
    const compactedBlob = Buffer.from(Y.encodeStateAsUpdate(this.ydoc));
    this.serverDb.transaction(() => {
      this.serverDb.db.prepare('DELETE FROM yjs_updates WHERE room_id = ?').run(this.roomId);
      this.serverDb.db
        .prepare('INSERT INTO yjs_updates (room_id, update_blob, created_at) VALUES (?, ?, ?)')
        .run(this.roomId, compactedBlob, createdAt);
    });
  }

  private captureDocUpdate(fn: () => void): Uint8Array {
    const chunks: Uint8Array[] = [];
    const onUpdate = (update: Uint8Array) => {
      chunks.push(update);
    };
    this.ydoc.on('update', onUpdate);
    try {
      fn();
    } finally {
      this.ydoc.off('update', onUpdate);
    }
    if (chunks.length === 0) {
      return new Uint8Array(0);
    }
    return chunks.length === 1 ? chunks[0]! : Y.mergeUpdates(chunks);
  }

  private computeCorrectiveUpdateBase64(_rejectedUpdateBase64?: string): string {
    return this.getStateUpdateBase64();
  }

  private computeCorrectiveUpdateFromStaged(_stagedDoc?: Y.Doc): string {
    return this.getStateUpdateBase64();
  }

  private broadcastAwareness(excludeConnectionId?: string): void {
    const message: WsServerMessage = {
      type: 'awareness-broadcast',
      states: this.getAwarenessStates(),
      onlineMembers: this.getOnlineMembers(),
    };
    this.broadcast(message, excludeConnectionId);
  }

  broadcast(message: WsServerMessage, excludeConnectionId?: string): void {
    for (const [connId, conn] of this.connections.entries()) {
      if (excludeConnectionId && connId === excludeConnectionId) {
        continue;
      }
      this.safeSend(conn, message);
    }
  }

  private safeSend(conn: RoomClientConnection, message: WsServerMessage): void {
    try {
      conn.send(message);
    } catch {
      // Ignore send errors on closing sockets
    }
  }

  private enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(task, task);
    this.mutationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

export class RoomRuntimeManager {
  private readonly runtimes = new Map<string, RoomRuntime>();
  private readonly loadingPromises = new Map<string, Promise<RoomRuntime>>();

  constructor(
    private readonly serverDb: ServerDatabase,
    private readonly roomService: RoomService,
    private readonly options: RoomRuntimeOptions = {},
  ) {
    this.roomService.setRuntimeHooks({
      getOnlineUserIds: roomId => this.getOnlineUserIds(roomId),
      getWorkspaceProvider: roomId => this.getLoadedWorkspace(roomId),
      onRoomEvent: event => this.handleRoomLifecycleEvent(event),
    });
  }

  getLoadedRuntime(roomId: string): RoomRuntime | undefined {
    return this.runtimes.get(roomId);
  }

  getLoadedWorkspace(roomId: string): Workspace | null {
    const runtime = this.runtimes.get(roomId);
    return runtime ? runtime.getWorkspace() : null;
  }

  getOnlineUserIds(roomId: string): ReadonlySet<string> {
    const runtime = this.runtimes.get(roomId);
    return runtime ? runtime.getOnlineUserIds() : new Set<string>();
  }

  async getOrCreateRoomRuntime(roomId: string): Promise<RoomRuntime> {
    const existing = this.runtimes.get(roomId);
    if (existing) {
      return existing;
    }

    const inflight = this.loadingPromises.get(roomId);
    if (inflight) {
      return inflight;
    }

    const promise = RoomRuntime.create(roomId, this.serverDb, this.roomService, this.options)
      .then(runtime => {
        this.loadingPromises.delete(roomId);
        this.runtimes.set(roomId, runtime);
        return runtime;
      })
      .catch(error => {
        this.loadingPromises.delete(roomId);
        throw error;
      });

    this.loadingPromises.set(roomId, promise);
    return promise;
  }

  handleRoomLifecycleEvent(event: RoomLifecycleEvent): void {
    const runtime = this.runtimes.get(event.roomId);
    if (!runtime) {
      return;
    }
    runtime.handleRoomLifecycleEvent(event);
    if (event.type === 'room-deleted') {
      this.runtimes.delete(event.roomId);
    }
  }

  disconnectUserFromAllRooms(userId: string, reason?: string): void {
    for (const runtime of this.runtimes.values()) {
      runtime.disconnectUser(userId, reason);
    }
  }

  async flushAll(): Promise<void> {
    await Promise.all(Array.from(this.runtimes.values()).map(rt => rt.flushAutosave()));
  }

  async closeAll(): Promise<void> {
    await Promise.all(Array.from(this.runtimes.values()).map(rt => rt.close()));
    this.runtimes.clear();
    this.loadingPromises.clear();
  }
}
