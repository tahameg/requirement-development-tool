import { randomUUID } from 'node:crypto';
import { restoreWorkspace, revisionMetadata } from './revisions.js';
import { LockManager, PresenceThrottle } from './locks.js';
import { recoverRoom } from './recoverRoom.js';
import { applyWorkspaceOp, OpError, type OpResult } from './opEngine.js';
import { authorizeOp } from '../shared/collab/permissions.js';
import { collabOpSchema } from '../shared/collab/protocol.js';
import {
  type CollabOp,
  type LockHolder,
  type PresenceBroadcastEntry,
  type PresenceState,
  type RoomMemberInfo,
  type RoomRole,
  type UserProfile,
  type WsServerMessage,
} from '../shared/collab/types.js';
import type { Workspace } from '../shared/types/workspace.js';
import { CollabServiceError } from './errors.js';
import type { ServerStore } from './store/index.js';
import type { RoomLifecycleEvent, RoomService } from './rooms.js';

export const DEFAULT_AUTOSAVE_DEBOUNCE_MS = 2000;
export const DEFAULT_AUTOSAVE_MAX_WAIT_MS = 10000;

export interface RoomClientConnection {
  connectionId: string;
  sessionId?: string;
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
  private readonly locks: LockManager;
  private readonly presenceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly presenceThrottle: PresenceThrottle;
  private lockTimer?: ReturnType<typeof setInterval>;
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
  private closing = false;
  private seq = 0;

  constructor(
    roomId: string,
    private readonly store: ServerStore,
    private readonly roomService: RoomService,
    options: RoomRuntimeOptions = {},
  ) {
    this.roomId = roomId;
    this.autosaveDebounceMs = options.autosaveDebounceMs ?? DEFAULT_AUTOSAVE_DEBOUNCE_MS;
    this.autosaveMaxWaitMs = options.autosaveMaxWaitMs ?? DEFAULT_AUTOSAVE_MAX_WAIT_MS;
    this.now = options.now ?? (() => new Date());
    this.locks = new LockManager((key, holder) => this.broadcast({ type: 'locks-changed', key, holder }), () => this.now().getTime());
    this.presenceThrottle = new PresenceThrottle(() => this.now().getTime());
  }

  static async create(
    roomId: string,
    store: ServerStore,
    roomService: RoomService,
    options?: RoomRuntimeOptions,
  ): Promise<RoomRuntime> {
    const runtime = new RoomRuntime(roomId, store, roomService, options);
    await runtime.initialize();
    return runtime;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const recovered = await recoverRoom(this.store, this.roomId);
    this.workspace = recovered.workspace;
    this.seq = recovered.seq;
    this.lastAutosavedAt = recovered.lastAutosavedAt;

    this.initialized = true;
    this.lockTimer = setInterval(() => this.locks.reap(), 1000);
    this.lockTimer.unref();
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

  getOnlineMembersList(): RoomMemberInfo[] {
    const seen = new Map<string, RoomMemberInfo>();
    for (const conn of this.connections.values()) {
      if (!seen.has(conn.user.id)) {
        seen.set(conn.user.id, {
          roomId: this.roomId,
          userId: conn.user.id,
          username: conn.user.username,
          displayName: conn.user.displayName,
          role: conn.role,
          online: true,
          joinedAt: this.now().toISOString(),
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

  getLockState(): Record<string, LockHolder> {
    return this.locks.state();
  }
  private session(conn: RoomClientConnection) { return conn.sessionId ?? conn.connectionId; }
  private validLockKey(key: string) {
    if (key === 'config') return true;
    return Object.values(this.workspace.domains).some(domain => domain.modules.some(m => key === `node:${m.id}`) ||
      domain.functions.some(f => key === `node:${f.functionId}` || key === `fn-desc:${f.functionId}` || f.items.some(i => key === `item:${i.id}`)));
  }

  addClient(connection: RoomClientConnection): void {
    if (this.disposed || this.closing) {
      connection.close(1001, 'Room runtime disposed');
      return;
    }

    this.connections.set(connection.connectionId, connection);

    // Send room-welcome
    connection.send({
      type: 'room-welcome',
      roomId: this.roomId,
      role: connection.role,
      seq: this.seq,
      workspace: this.getWorkspace(),
      locks: this.getLockState(),
      presence: this.getPresenceBroadcastList(),
      members: this.getOnlineMembersList(),
    });

    this.updatePresence(connection.connectionId, { view: null, focus: null, drafting: null });

    // Broadcast member joined
    this.broadcast(
      {
        type: 'room-notification',
        kind: 'user-joined',
        message: `${connection.user.displayName} connected.`,
        targetUserId: connection.user.id,
        newRole: connection.role,
        timestamp: this.now().toISOString(),
      },
      connection.connectionId,
    );
  }

  removeClient(connectionId: string): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;

    this.connections.delete(connectionId);

    this.presenceThrottle.remove(connectionId);
    clearTimeout(this.presenceTimers.get(connectionId)); this.presenceTimers.delete(connectionId);
    if (![...this.connections.values()].some(c => this.session(c) === this.session(conn))) this.locks.disconnect(this.session(conn));
    this.broadcast({ type: 'presence-left', connectionId });
  }

  disconnectUser(userId: string, reason = 'Disconnected'): void {
    this.locks.releaseUser(userId);
    for (const client of Array.from(this.connections.values())) {
      if (client.user.id === userId) {
        client.close(1000, reason);
        this.removeClient(client.connectionId);
      }
    }
  }

  updateClientRole(userId: string, newRole: RoomRole): void {
    this.locks.releaseUser(userId);
    for (const client of this.connections.values()) {
      if (client.user.id === userId) {
        client.role = newRole;
      }
    }
  }

  updatePresence(connectionId: string, state: PresenceState): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;

    if (conn.role === 'VIEWER') state = { ...state, focus: null, drafting: null };
    conn.presence = state;
    if (!this.presenceThrottle.accept(connectionId)) {
      if (!this.presenceTimers.has(connectionId)) this.presenceTimers.set(connectionId, setTimeout(() => {
        this.presenceTimers.delete(connectionId);
        if (conn.presence) this.updatePresence(connectionId, conn.presence);
      }, 100));
      return;
    }
    this.broadcast({
      type: 'presence',
      connectionId,
      user: {
        userId: conn.user.id,
        name: conn.user.displayName,
        color: conn.color,
      },
      state,
    });
  }

  async acquireLock(
    connectionId: string,
    key: string,
  ): Promise<{ ok: boolean; holder: LockHolder }> {
    const conn = this.connections.get(connectionId);
    if (!conn) throw new CollabServiceError('UNAUTHORIZED', 'Not connected to room');

    if (conn.role === 'VIEWER' || key === 'config' && conn.role === 'EDITOR') throw new CollabServiceError('FORBIDDEN', 'You cannot acquire this lock');
    if (!this.validLockKey(key)) throw new CollabServiceError('NOT_FOUND', 'Lock target no longer exists');
    return this.locks.acquire(key, this.session(conn), { userId: conn.user.id, name: conn.user.displayName, color: conn.color });
  }
  async releaseLock(connectionId: string, key: string): Promise<boolean> {
    const conn = this.connections.get(connectionId);
    return !!conn && this.locks.release(key, this.session(conn));
  }
  async heartbeatLock(connectionId: string, key: string): Promise<boolean> {
    const conn = this.connections.get(connectionId);
    return !!conn && this.locks.heartbeat(key, this.session(conn));
  }
  async forceReleaseLock(key: string): Promise<boolean> { return this.locks.forceRelease(key); }

  async handleOp(connectionId: string, op: CollabOp): Promise<void> {
    try {
      const applied = await this.applyOp(connectionId, op);
      this.connections.get(connectionId)?.send({ type: 'op-ack', opId: op.opId, ...applied });
    } catch (error) {
      this.connections.get(connectionId)?.send({ type: 'op-rejected', opId: op.opId,
        code: error instanceof OpError ? error.code : error instanceof CollabServiceError && error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'VALIDATION',
        message: error instanceof Error ? error.message : 'Operation failed.' });
    }
  }

  async handleOpsSince(connectionId: string, seq: number): Promise<void> {
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    await this.enqueueMutation(async () => {
      const rows = await this.store.ops.listSince(this.roomId, seq, 2000);
      const contiguous = seq <= this.seq && rows.length === this.seq - seq && rows.every((r, i) => r.seq === seq + i + 1);
      if (!contiguous) {
        conn.send({ type: 'snapshot', seq: this.seq, workspace: this.getWorkspace() });
        return;
      }
      conn.send({ type: 'ops-since-reply', sinceSeq: seq, ops: rows.map(r => ({ seq: r.seq,
        op: collabOpSchema.parse({ opId: r.op_id, kind: r.kind, payload: r.payload }), result: r.result })) });
    });
  }

  async handleLockAcquire(connectionId: string, key: string): Promise<void> {
    return this.enqueueMutation(async () => {
    const acquired = await this.acquireLock(connectionId, key);
    this.connections.get(connectionId)?.send(acquired.ok
      ? { type: 'lock-granted', key, expiresAt: this.locks.get(key)!.expiresAt }
      : { type: 'lock-denied', key, holder: acquired.holder });
    });
  }

  async handleLockRelease(connectionId: string, key: string): Promise<void> {
    await this.enqueueMutation(() => this.releaseLock(connectionId, key));
  }

  async handleLockHeartbeat(connectionId: string, key: string): Promise<void> {
    await this.heartbeatLock(connectionId, key);
  }

  async handleLockForceRelease(connectionId: string, key: string): Promise<void> {
    const conn = this.connections.get(connectionId);
    if (!conn || !['ROOM_OWNER', 'ROOM_ADMIN'].includes(conn.role)) throw new CollabServiceError('FORBIDDEN', 'Only room admins may release another user’s lock');
    await this.enqueueMutation(async () => {
      const holder = this.locks.get(key)?.holder;
      await this.store.audit.append({ roomId: this.roomId, actorId: conn.user.id, actorName: conn.user.displayName, action: 'lock:force-release', targetId: key });
      await this.forceReleaseLock(key);
      for (const client of this.connections.values()) if (client.user.id === holder?.userId) client.send({ type: 'lock-revoked', key, reason: `Released by ${conn.user.displayName}. Your draft has been preserved.` });
    });
  }

  handlePresenceUpdate(connectionId: string, state: PresenceState): void {
    this.updatePresence(connectionId, state);
  }

  async applyOp(
    connectionId: string,
    op: CollabOp,
  ): Promise<{ seq: number; result?: unknown }> {
    return this.enqueueMutation(async () => {
      if (this.disposed || this.closing) throw new OpError('READ_ONLY', 'Room is closing');
      const conn = this.connections.get(connectionId);
      if (!conn) throw new OpError('FORBIDDEN', 'Not connected');
      const parsed = collabOpSchema.parse(op);
      let nextWorkspace = this.workspace;
      let duplicate = false;
      const applied = await this.store.transaction(async tx => {
        const room = await tx.rooms.lockForUpdate(this.roomId);
        if (!room) throw new OpError('NOT_FOUND', 'Room no longer exists');
        const member = await tx.memberships.get(this.roomId, conn.user.id);
        if (!member || await tx.bans.get(this.roomId, conn.user.id)) throw new OpError('FORBIDDEN', 'Room access was removed');
        const previous = await tx.ops.getByOpId(this.roomId, parsed.opId);
        if (previous) {
          if (previous.user_id !== conn.user.id || canonical(previous.payload) !== canonical(parsed.payload) || previous.kind !== parsed.kind)
            throw new OpError('CONFLICT', 'Operation ID was already used for a different request');
          duplicate = true;
          return { seq: previous.seq, result: previous.result };
        }
        if (room.head_seq !== this.seq) throw new OpError('CONFLICT', 'Room changed in another server process; reconnect after restarting this server');
        const requiredKey = parsed.kind === 'item.edit' ? `item:${parsed.payload.itemId}` : parsed.kind === 'function.description' ? `fn-desc:${parsed.payload.functionId}` : parsed.kind === 'config.update' ? 'config' : null;
        if (requiredKey && !this.locks.owns(requiredKey, this.session(conn))) throw new OpError('LOCKED', 'This session does not hold the edit lock');
        const permission = authorizeOp(member.role, parsed, this.locks.authorizationState(this.session(conn)), this.workspace, conn.user.id);
        if (!permission.ok) throw new OpError(permission.code, permission.message);
        const result: OpResult = { timestamp: this.now().toISOString() };
        if (parsed.kind === 'room.restore') {
          const target = await tx.revisions.getById(parsed.payload.revisionId);
          if (!target || target.room_id !== this.roomId) throw new OpError('NOT_FOUND', 'Revision not found');
          result.workspace = restoreWorkspace(this.workspace, target.workspace);
          result.revision = revisionMetadata(await tx.revisions.create({ id: randomUUID(), roomId: this.roomId, seq: this.seq + 1, message: `Restored: ${target.message}`, authorId: conn.user.id, authorName: conn.user.displayName, workspace: result.workspace, restoredFromId: target.id }));
          await tx.audit.append({ roomId: this.roomId, actorId: conn.user.id, actorName: conn.user.displayName, action: 'revision:restore', targetId: target.id });
        }
        const next = applyWorkspaceOp(this.workspace, parsed, result);
        nextWorkspace = next.workspace;
        const seq = this.seq + 1;
        await tx.ops.append({ roomId: this.roomId, seq, opId: parsed.opId, userId: conn.user.id,
          kind: parsed.kind, payload: parsed.payload, result: next.result, createdAt: next.result.timestamp });
        await tx.rooms.update(this.roomId, { headSeq: seq, projectName: next.workspace.config.projectName });
        return { seq, result: next.result };
      });
      if (!duplicate) {
        this.workspace = nextWorkspace;
        this.seq = applied.seq;
        if (parsed.kind === 'room.restore') {
          for (const key of Object.keys(this.getLockState())) this.broadcast({ type: 'lock-revoked', key, reason: 'A revision was restored. Review your preserved draft.' });
          this.locks.clear();
          this.broadcast({ type: 'revision-saved', revision: (applied.result as OpResult).revision! });
        }
        this.locks.retain(key => this.validLockKey(key));
        if (parsed.kind === 'item.add' && this.connections.has(connectionId)) await this.acquireLock(connectionId, `item:${(applied.result as { createdId: string }).createdId}`);
        this.broadcast({ type: 'op-applied', seq: applied.seq, op: parsed, result: applied.result });
        this.scheduleAutosave();
      }
      return applied;
    });
  }

  async saveRevision(actor: UserProfile, message: string, imported?: Workspace) {
    return this.enqueueMutation(async () => {
      const metadata = await this.store.transaction(async tx => {
        const room = await tx.rooms.lockForUpdate(this.roomId);
        const member = await tx.memberships.get(this.roomId, actor.id);
        if (!room || !member || !['ROOM_OWNER', 'ROOM_ADMIN'].includes(member.role)) throw new CollabServiceError('FORBIDDEN', 'Only room admins may save revisions');
        if (room.head_seq !== this.seq) throw new CollabServiceError('CONFLICT', 'Room head changed');
        const workspace = imported ? restoreWorkspace(this.workspace, imported) : this.workspace;
        const row = await tx.revisions.create({ id: randomUUID(), roomId: this.roomId, seq: this.seq, message, authorId: actor.id, authorName: actor.displayName, workspace });
        await tx.audit.append({ roomId: this.roomId, actorId: actor.id, actorName: actor.displayName, action: imported ? 'revision:import' : 'revision:save', targetId: row.id });
        return revisionMetadata(row);
      });
      this.broadcast({ type: 'revision-saved', revision: metadata });
      return metadata;
    });
  }
  async restoreRevision(actor: UserProfile, revisionId: string) {
    const connectionId = `rest-${randomUUID()}`;
    const role = await this.roomService.getMemberRole(this.roomId, actor.id);
    if (!role) throw new CollabServiceError('FORBIDDEN', 'Room membership required');
    this.connections.set(connectionId, { connectionId, user: actor, role, color: '#000000', presence: null, send: () => {}, close: () => {} });
    try { return await this.applyOp(connectionId, { opId: randomUUID(), kind: 'room.restore', payload: { revisionId } }); }
    finally { this.connections.delete(connectionId); }
  }

  handleRoomLifecycleEvent(event: RoomLifecycleEvent): void {
    switch (event.type) {
      case 'role-changed': {
        this.updateClientRole(event.userId, event.newRole);
        this.broadcast({
          type: 'room-notification',
          kind: 'role-changed',
          message: `Your room role was updated to ${event.newRole}.`,
          targetUserId: event.userId,
          newRole: event.newRole,
          timestamp: this.now().toISOString(),
        });
        break;
      }

      case 'member-kicked': {
        this.locks.releaseUser(event.userId);
        for (const client of Array.from(this.connections.values())) {
          if (client.user.id === event.userId) {
            client.send({ type: 'kicked', reason: event.reason || 'You were kicked from the room.' });
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
        this.locks.releaseUser(event.userId);
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
      void this.flushAutosave().catch(() => {
        this.broadcast({ type: 'error', code: 'INTERNAL_ERROR', message: 'Snapshot save failed; committed edits remain in the operation log.' });
      });
    }, this.autosaveDebounceMs);

    if (!this.maxWaitTimer) {
      this.maxWaitTimer = setTimeout(() => {
        void this.flushAutosave().catch(() => {
          this.broadcast({ type: 'error', code: 'INTERNAL_ERROR', message: 'Snapshot save failed; committed edits remain in the operation log.' });
        });
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
      const autosavedAt = this.now().toISOString();

      await this.store.transaction(async tx => {
        const room = await tx.rooms.lockForUpdate(this.roomId);
        if (!room) return;
        if (room.head_seq !== this.seq) throw new OpError('CONFLICT', 'Cannot snapshot a stale room');
        await tx.snapshots.create({ roomId: this.roomId, seq: this.seq, workspace: this.workspace, createdAt: autosavedAt });
        await tx.rooms.update(this.roomId, { snapshotSeq: this.seq, lastAutosavedAt: autosavedAt });
        await tx.snapshots.prune(this.roomId, 3);
      });
      this.lastAutosavedAt = autosavedAt;
      this.autosaveStatus = 'autosaved';

      this.broadcast({
        type: 'autosave-status',
        status: 'autosaved',
        lastAutosavedAt: autosavedAt,
      });
    });
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    this.closing = true;
    // The op log is already durable even if the optional shutdown snapshot fails.
    try { await this.flushAutosave(); } catch {
      this.broadcast({ type: 'error', code: 'INTERNAL_ERROR', message: 'Shutdown snapshot failed; edits will be recovered from the operation log.' });
    }
    await this.mutationQueue;
    this.disposed = true;
    if (this.lockTimer) clearInterval(this.lockTimer);
    for (const timer of this.presenceTimers.values()) clearTimeout(timer); this.presenceTimers.clear();
    this.locks.clear();

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
    private readonly store: ServerStore,
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

    const promise = RoomRuntime.create(roomId, this.store, this.roomService, this.options)
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
      void runtime.close();
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

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
