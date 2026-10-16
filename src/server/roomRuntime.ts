import { WorkspaceIndex } from '../main/db/sqliteClient.js';
import { validateWorkspace } from '../main/services/validation.js';
import { loadWorkspace, saveWorkspace } from '../main/services/workspaceService.js';
import {
  assignUserColor,
  type CollabOp,
  type LockHolder,
  type OnlineMemberInfo,
  type PresenceBroadcastEntry,
  type PresenceState,
  type RevisionMetadata,
  type RoomRole,
  type UserProfile,
  type WsServerMessage,
} from '../shared/collab/types.js';
import type { Workspace } from '../shared/types/workspace.js';
import {
  CollabServiceError,
  type RevisionRow,
  type ServerDatabase,
} from './db.js';
import type { RoomLifecycleEvent, RoomService } from './rooms.js';

export const DEFAULT_AUTOSAVE_DEBOUNCE_MS = 500;
export const DEFAULT_AUTOSAVE_MAX_WAIT_MS = 2000;

export interface RoomClientConnection {
  connectionId: string;
  user: UserProfile;
  role: RoomRole;
  color: string;
  presence: PresenceState | null;
  send: (message: WsServerMessage) => void;
  close: (code?: number, reason?: string) => void;
}

export interface RoomRuntimeOptions {
  autosaveDebounceMs?: number;
  autosaveMaxWaitMs?: number;
  now?: () => Date;
}

export class RoomRuntime {
  readonly roomId: string;
  private workspace!: Workspace;
  private readonly connections = new Map<string, RoomClientConnection>();
  private readonly locks = new Map<string, LockHolder>();
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
  private seq = 0;

  constructor(
    roomId: string,
    private readonly serverDb: ServerDatabase,
    private readonly roomService: RoomService,
    options: RoomRuntimeOptions = {},
  ) {
    this.roomId = roomId;
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
    const loaded = await loadWorkspace(workspaceDir);
    this.workspace = validateWorkspace(loaded);

    // Read head sequence from room_ops
    const maxSeqRow = this.serverDb.db
      .prepare('SELECT MAX(seq) AS max_seq FROM room_ops WHERE room_id = ?')
      .get(this.roomId) as { max_seq: number | null } | undefined;
    this.seq = maxSeqRow?.max_seq ?? 0;

    this.initialized = true;
  }

  getWorkspace(): Workspace {
    return structuredClone(this.workspace);
  }

  getHeadSeq(): number {
    return this.seq;
  }

  getOnlineUserIds(): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const conn of this.connections.values()) {
      ids.add(conn.user.id);
    }
    return ids;
  }

  getOnlineMembersList(): OnlineMemberInfo[] {
    const seen = new Map<string, OnlineMemberInfo>();
    for (const conn of this.connections.values()) {
      if (!seen.has(conn.user.id)) {
        seen.set(conn.user.id, {
          userId: conn.user.id,
          username: conn.user.username,
          displayName: conn.user.displayName,
          role: conn.role,
          color: conn.color,
        });
      }
    }
    return Array.from(seen.values());
  }

  getPresenceBroadcastList(): PresenceBroadcastEntry[] {
    const list: PresenceBroadcastEntry[] = [];
    for (const conn of this.connections.values()) {
      list.push({
        connectionId: conn.connectionId,
        user: {
          userId: conn.user.id,
          name: conn.user.displayName,
          color: conn.color,
        },
        state: conn.presence ?? { view: null, focus: null, drafting: null },
      });
    }
    return list;
  }

  getLocksMap(): Record<string, LockHolder> {
    const record: Record<string, LockHolder> = {};
    for (const [key, holder] of this.locks.entries()) {
      record[key] = holder;
    }
    return record;
  }

  getLastRevision(): RevisionMetadata | null {
    const row = this.serverDb.db
      .prepare(
        'SELECT id, room_id, seq, message, author_id, author_name, snapshot_filename, restored_from_id, created_at FROM revisions WHERE room_id = ? ORDER BY seq DESC LIMIT 1',
      )
      .get(this.roomId) as RevisionRow | undefined;

    if (!row) return null;
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

  addClient(connection: {
    connectionId: string;
    user: UserProfile;
    role?: RoomRole;
    send: (message: WsServerMessage) => void;
    close: (code?: number, reason?: string) => void;
  }): void {
    if (this.disposed) {
      connection.close(1001, 'Room runtime closed');
      return;
    }

    const currentRole = connection.role ?? this.roomService.getMemberRole(this.roomId, connection.user.id);
    if (!currentRole) {
      connection.close(4403, 'User is not a member of this room.');
      return;
    }

    const client: RoomClientConnection = {
      connectionId: connection.connectionId,
      user: connection.user,
      role: currentRole,
      color: assignUserColor(connection.user.id),
      presence: null,
      send: connection.send,
      close: connection.close,
    };

    this.connections.set(connection.connectionId, client);

    // Send initial authoritative state snapshot to joining client
    client.send({
      type: 'room-welcome',
      roomId: this.roomId,
      role: client.role,
      seq: this.seq,
      workspace: this.getWorkspace(),
      locks: this.getLocksMap(),
      presence: this.getPresenceBroadcastList(),
      members: this.roomService.listRoomMembers(this.roomId),
      autosaveStatus: {
        status: this.autosaveStatus,
        lastAutosavedAt: this.lastAutosavedAt,
      },
      lastRevision: this.getLastRevision(),
    });

    // Notify room of user presence
    this.broadcast({
      type: 'room-notification',
      kind: 'user-joined',
      message: `${client.user.displayName} joined the room.`,
      targetUserId: client.user.id,
      timestamp: this.now().toISOString(),
    }, client.connectionId);
  }

  removeClient(connectionId: string): void {
    const client = this.connections.get(connectionId);
    if (!client) {
      return;
    }

    this.connections.delete(connectionId);

    // Release any ephemeral presence
    this.broadcast({
      type: 'presence',
      connectionId,
      user: {
        userId: client.user.id,
        name: client.user.displayName,
        color: client.color,
      },
      state: { view: null, focus: null, drafting: null },
    });

    this.broadcast({
      type: 'room-notification',
      kind: 'user-left',
      message: `${client.user.displayName} left the room.`,
      targetUserId: client.user.id,
      timestamp: this.now().toISOString(),
    });
  }

  disconnectUser(userId: string, reason = 'Disconnected by server'): void {
    for (const client of Array.from(this.connections.values())) {
      if (client.user.id === userId) {
        client.close(4403, reason.slice(0, 120));
        this.removeClient(client.connectionId);
      }
    }
  }

  updateClientRole(userId: string, newRole: RoomRole): void {
    for (const client of this.connections.values()) {
      if (client.user.id === userId) {
        client.role = newRole;
      }
    }
  }

  // --- Stubs for v2 Op Engine & Lock Manager (R02 & R03) ---

  async handleOp(connectionId: string, op: CollabOp): Promise<void> {
    const client = this.connections.get(connectionId);
    if (!client) return;
    // Stubbed for R02: Full serial queue op engine
    client.send({
      type: 'op-ack',
      opId: op.opId,
      seq: this.seq,
    });
  }

  async handleOpsSince(connectionId: string, _seq: number): Promise<void> {
    const client = this.connections.get(connectionId);
    if (!client) return;
    // Stubbed for R02: Op catchup or snapshot
    client.send({
      type: 'snapshot',
      seq: this.seq,
      workspace: this.getWorkspace(),
    });
  }

  handleLockAcquire(connectionId: string, key: string): void {
    const client = this.connections.get(connectionId);
    if (!client) return;
    // Stubbed for R03: Lock manager
    const holder: LockHolder = {
      userId: client.user.id,
      name: client.user.displayName,
      color: client.color,
    };
    this.locks.set(key, holder);
    client.send({
      type: 'lock-granted',
      key,
      expiresAt: Date.now() + 30000,
    });
    this.broadcast({
      type: 'locks-changed',
      key,
      holder,
    });
  }

  handleLockRelease(connectionId: string, key: string): void {
    this.locks.delete(key);
    this.broadcast({
      type: 'locks-changed',
      key,
      holder: null,
    });
  }

  handleLockHeartbeat(connectionId: string, key: string): void {
    const client = this.connections.get(connectionId);
    if (!client) return;
    client.send({
      type: 'lock-granted',
      key,
      expiresAt: Date.now() + 30000,
    });
  }

  handleLockForceRelease(connectionId: string, key: string): void {
    this.handleLockRelease(connectionId, key);
  }

  handlePresenceUpdate(connectionId: string, state: PresenceState): void {
    const client = this.connections.get(connectionId);
    if (!client) return;
    client.presence = state;
    this.broadcast({
      type: 'presence',
      connectionId,
      user: {
        userId: client.user.id,
        name: client.user.displayName,
        color: client.color,
      },
      state,
    });
  }

  handleRoomLifecycleEvent(event: RoomLifecycleEvent): void {
    switch (event.type) {
      case 'role-changed': {
        this.updateClientRole(event.userId, event.newRole);
        this.broadcast({
          type: 'room-notification',
          kind: 'role-changed',
          message: `Member role was changed to ${event.newRole}.`,
          targetUserId: event.userId,
          newRole: event.newRole,
          timestamp: this.now().toISOString(),
        });
        break;
      }

      case 'member-kicked': {
        for (const client of Array.from(this.connections.values())) {
          if (client.user.id === event.userId) {
            client.send({ type: 'kicked', reason: event.reason || 'You were removed from the room.' });
            client.close(4403, 'Kicked from room');
            this.removeClient(client.connectionId);
          }
        }
        this.broadcast({
          type: 'room-notification',
          kind: 'member-kicked',
          message: `Member was removed from the room.`,
          targetUserId: event.userId,
          timestamp: this.now().toISOString(),
        });
        break;
      }

      case 'member-banned': {
        for (const client of Array.from(this.connections.values())) {
          if (client.user.id === event.userId) {
            client.send({ type: 'banned', reason: event.reason || 'You were banned from the room.' });
            client.close(4403, 'Banned from room');
            this.removeClient(client.connectionId);
          }
        }
        this.broadcast({
          type: 'room-notification',
          kind: 'member-banned',
          message: `Member was banned from the room.`,
          targetUserId: event.userId,
          timestamp: this.now().toISOString(),
        });
        break;
      }

      case 'room-deleted': {
        for (const client of Array.from(this.connections.values())) {
          client.send({ type: 'room-deleted', reason: event.reason || 'The room was deleted by an administrator.' });
          client.close(4404, 'Room deleted');
          this.removeClient(client.connectionId);
        }
        break;
      }

      case 'ownership-transferred': {
        this.updateClientRole(event.newOwnerId, 'ROOM_OWNER');
        this.updateClientRole(event.previousOwnerId, 'ROOM_ADMIN');
        this.broadcast({
          type: 'room-notification',
          kind: 'ownership-transferred',
          message: `Room ownership was transferred.`,
          targetUserId: event.newOwnerId,
          newRole: 'ROOM_OWNER',
          timestamp: this.now().toISOString(),
        });
        break;
      }

      case 'join-request-created': {
        for (const client of this.connections.values()) {
          if (client.role === 'ROOM_ADMIN' || client.role === 'ROOM_OWNER') {
            client.send({
              type: 'room-notification',
              kind: 'join-request-created',
              message: `${event.joinRequest.displayName} requested to join the room.`,
              joinRequest: event.joinRequest,
              timestamp: this.now().toISOString(),
            });
          }
        }
        break;
      }
    }
  }

  broadcast(message: WsServerMessage, excludeConnectionId?: string): void {
    for (const [connId, client] of this.connections.entries()) {
      if (excludeConnectionId && connId === excludeConnectionId) {
        continue;
      }
      try {
        client.send(message);
      } catch {
        // Ignore dead sockets
      }
    }
  }

  scheduleAutosave(): void {
    if (this.disposed) return;
    this.autosaveStatus = 'saving';
    this.broadcast({
      type: 'autosave-status',
      status: 'saving',
      lastAutosavedAt: this.lastAutosavedAt ?? this.now().toISOString(),
    });

    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      void this.flushAutosave();
    }, this.autosaveDebounceMs);

    if (!this.maxWaitTimer) {
      this.maxWaitTimer = setTimeout(() => {
        void this.flushAutosave();
      }, this.autosaveMaxWaitMs);
    }
  }

  async flushAutosave(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.maxWaitTimer) {
      clearTimeout(this.maxWaitTimer);
      this.maxWaitTimer = null;
    }

    return this.enqueueMutation(async () => {
      if (this.disposed || !this.initialized) return;
      const workspaceDir = this.roomService.getRoomWorkspaceDir(this.roomId);
      await saveWorkspace(workspaceDir, this.workspace);
      const index = WorkspaceIndex.rebuild(workspaceDir, this.workspace);
      index.close();

      const autosavedAt = this.now().toISOString();
      this.lastAutosavedAt = autosavedAt;
      this.autosaveStatus = 'autosaved';

      this.roomService.recordAutosave(this.roomId, autosavedAt);

      this.broadcast({
        type: 'autosave-status',
        status: 'autosaved',
        lastAutosavedAt: autosavedAt,
      });
    });
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);

    for (const client of Array.from(this.connections.values())) {
      try {
        client.close(1001, 'Room closing');
      } catch {
        // Ignore close error
      }
    }
    this.connections.clear();
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
