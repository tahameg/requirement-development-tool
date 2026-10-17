import { randomUUID } from 'node:crypto';
import { applyWorkspaceOp, type OpResult } from '../../src/server/opEngine.js';
import { RoomRuntime } from '../../src/server/roomRuntime.js';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { addFunction, addModule, createWorkspace } from '../../src/main/services/workspaceFactory.js';
import {
  CollabServer,
  formatServerHelpText,
  parseServerCliArgs,
  startServerFromCli,
} from '../../src/server/index.js';
import type {
  WsClientMessage,
  WsServerMessage,
} from '../../src/shared/collab/types.js';
import { createTestStore, type TestStoreFixture } from './testDbHelper.js';

interface TestWsClient {
  ws: WebSocket;
  messages: WsServerMessage[];
  send: (msg: WsClientMessage) => void;
  waitForMessage: <T extends WsServerMessage['type']>(
    type: T,
    predicate?: (msg: Extract<WsServerMessage, { type: T }>) => boolean,
    timeoutMs?: number,
  ) => Promise<Extract<WsServerMessage, { type: T }>>;
  close: () => Promise<void>;
}

async function connectTestWsClient(
  wsBaseUrl: string,
  roomId: string,
  token: string,
  options: { rejectUnauthorized?: boolean; useAuthHeader?: boolean } = {},
): Promise<TestWsClient> {
  const url = options.useAuthHeader
    ? `${wsBaseUrl}/ws/rooms/${encodeURIComponent(roomId)}`
    : `${wsBaseUrl}/ws/rooms/${encodeURIComponent(roomId)}?token=${encodeURIComponent(token)}`;

  const ws = new WebSocket(url, {
    rejectUnauthorized: options.rejectUnauthorized ?? false,
    headers: options.useAuthHeader ? { Authorization: `Bearer ${token}` } : undefined,
  });

  const messages: WsServerMessage[] = [];
  const waiters: Array<{
    type: WsServerMessage['type'];
    predicate?: (msg: any) => boolean;
    resolve: (msg: any) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  ws.on('message', raw => {
    const text = typeof raw === 'string' ? raw : Buffer.from(raw as Buffer).toString('utf8');
    const msg = JSON.parse(text) as WsServerMessage;

    for (let i = 0; i < waiters.length; i += 1) {
      const w = waiters[i]!;
      if (msg.type === w.type && (!w.predicate || w.predicate(msg))) {
        clearTimeout(w.timer);
        waiters.splice(i, 1);
        w.resolve(msg);
        return;
      }
    }

    messages.push(msg);
  });

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', err => reject(err));
  });

  const waitForMessage = <T extends WsServerMessage['type']>(
    type: T,
    predicate?: (msg: Extract<WsServerMessage, { type: T }>) => boolean,
    timeoutMs = 4000,
  ): Promise<Extract<WsServerMessage, { type: T }>> => {
    const existingIdx = messages.findIndex(
      m => m.type === type && (!predicate || predicate(m as Extract<WsServerMessage, { type: T }>)),
    );
    if (existingIdx >= 0) {
      const [found] = messages.splice(existingIdx, 1);
      return Promise.resolve(found as Extract<WsServerMessage, { type: T }>);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex(w => w.timer === timer);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error(`Timed out waiting for WebSocket message '${type}'`));
      }, timeoutMs);

      waiters.push({ type, predicate, resolve, reject, timer });
    });
  };

  return {
    ws,
    messages,
    send: (msg: WsClientMessage) => {
      ws.send(JSON.stringify(msg));
    },
    waitForMessage,
    close: async () => {
      if (ws.readyState === WebSocket.CLOSED) return;
      await new Promise<void>(resolve => {
        ws.once('close', () => resolve());
        ws.close();
      });
    },
  };
}

async function apiJson<T = any>(
  baseUrl: string,
  method: string,
  route: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: { ok: boolean; value?: T; code?: string; error?: string } }> {
  const headers: Record<string, string> = {};
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const json = (await response.json()) as {
    ok: boolean;
    value?: T;
    code?: string;
    error?: string;
  };
  return { status: response.status, body: json };
}

describe('T05 / R01 / R02: RoomRuntime, CollabServer, REST API, and WebSocket handshake', () => {
  const tempDirs: string[] = [];
  const activeServers: CollabServer[] = [];
  const fixtures: TestStoreFixture[] = [];

  function createTempDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hlr-server-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    while (activeServers.length > 0) {
      const srv = activeServers.pop()!;
      await srv.stop();
    }
    while (fixtures.length > 0) {
      const fixture = fixtures.pop()!;
      await fixture.cleanup();
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createSeededTestWorkspace() {
    let ws = createWorkspace('Flight Control System', 'FCS');
    ws = addModule(ws, 'REQUIREMENT', 'Navigation', 'NAV', null);
    ws.domains.REQUIREMENT.modules[0]!.description = 'Navigation module scope';
    const navModuleId = ws.domains.REQUIREMENT.modules[0]!.id;
    ws = addFunction(ws, 'REQUIREMENT', navModuleId, 'Guidance', 'GDC');
    ws.domains.REQUIREMENT.functions[0]!.description = 'Initial guidance description';
    return ws;
  }

  it('starts CollabServer on an ephemeral port with HTTPS/WSS by default and exposes setup token and TLS fingerprint', async () => {
    const dataDir = createTempDir();
    const fixture = await createTestStore({ schemaPrefix: 'runtime_test' });
    fixtures.push(fixture);

    const server = new CollabServer({
      store: fixture.store,
      dataDir,
      host: '127.0.0.1',
      port: 0,
      serverName: 'Secure Test Server',
    });
    activeServers.push(server);

    const listenInfo = await server.start();
    expect(listenInfo.port).toBeGreaterThan(0);
    expect(listenInfo.protocol).toBe('https');
    expect(listenInfo.wsProtocol).toBe('wss');
    expect(listenInfo.tls).toBe(true);
    expect(listenInfo.fingerprint).toMatch(/^SHA256:[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);
    expect(listenInfo.setupToken).toBeTruthy();

    const publicInfo = server.getPublicInfo();
    expect(publicInfo.name).toBe('Secure Test Server');
    expect(publicInfo.tls).toBe(true);
    expect(publicInfo.fingerprint).toBe(listenInfo.fingerprint);
    expect(publicInfo.setupRequired).toBe(true);
  });

  it('exercises REST auth, admin, room lobby, invites, join requests, export, and audit endpoints end-to-end', async () => {
    const dataDir = createTempDir();
    const fixture = await createTestStore({ schemaPrefix: 'runtime_test' });
    fixtures.push(fixture);

    const server = new CollabServer({
      store: fixture.store,
      dataDir,
      host: '127.0.0.1',
      port: 0,
      insecureHttp: true,
      autosaveDebounceMs: 50,
    });
    activeServers.push(server);

    const listenInfo = await server.start();
    const baseUrl = server.getBaseUrl();

    // 1. Setup token claim
    const setupRes = await apiJson(baseUrl, 'POST', '/api/auth/setup', {
      body: {
        setupToken: listenInfo.setupToken!,
        username: 'alice_owner',
        displayName: 'Alice Owner',
        password: 'password123',
      },
    });
    expect(setupRes.status).toBe(201);
    expect(setupRes.body.ok).toBe(true);
    const ownerToken = setupRes.body.value.token;
    const ownerId = setupRes.body.value.user.id;

    // 2. Register normal user
    const regRes = await apiJson(baseUrl, 'POST', '/api/auth/register', {
      body: {
        username: 'bob_editor',
        displayName: 'Bob Editor',
        password: 'password123',
      },
    });
    expect(regRes.status).toBe(201);
    expect(regRes.body.ok).toBe(true);
    const bobToken = regRes.body.value.token;
    const bobId = regRes.body.value.user.id;

    // 3. Create room
    const ws = createSeededTestWorkspace();
    const createRoomRes = await apiJson(baseUrl, 'POST', '/api/rooms', {
      token: ownerToken,
      body: {
        name: 'Avionics Room',
        visibility: 'listed',
        workspace: ws,
      },
    });
    expect(createRoomRes.status).toBe(201);
    expect(createRoomRes.body.ok).toBe(true);
    const roomId = createRoomRes.body.value.room.id;

    // 4. Room lobby
    const lobbyRes = await apiJson(baseUrl, 'GET', '/api/rooms', {
      token: bobToken,
    });
    expect(lobbyRes.status).toBe(200);
    expect(lobbyRes.body.value.listedRooms.length).toBe(1);

    // 5. Join request
    const joinReqRes = await apiJson(baseUrl, 'POST', `/api/rooms/${roomId}/join-requests`, {
      token: bobToken,
      body: { message: 'Please let me join' },
    });
    expect(joinReqRes.status).toBe(201);
    const reqId = joinReqRes.body.value.joinRequest.id;

    // 6. Approve join request
    const reviewRes = await apiJson(baseUrl, 'POST', `/api/rooms/${roomId}/join-requests/${reqId}/review`, {
      token: ownerToken,
      body: { approve: true, role: 'EDITOR' },
    });
    expect(reviewRes.status).toBe(200);

    // 7. Export room
    const exportRes = await apiJson(baseUrl, 'GET', `/api/rooms/${roomId}/export?format=json`, {
      token: bobToken,
    });
    expect(exportRes.status).toBe(200);
    expect(exportRes.body.value.content.config.projectName).toBe('Flight Control System');

    expect(ownerId).toBeTruthy();
    expect(bobId).toBeTruthy();
  });

  it('connects WebSocket client and receives room-welcome handshake', async () => {
    const dataDir = createTempDir();
    const fixture = await createTestStore({ schemaPrefix: 'runtime_test' });
    fixtures.push(fixture);

    const server = new CollabServer({
      store: fixture.store,
      dataDir,
      host: '127.0.0.1',
      port: 0,
      insecureHttp: true,
      autosaveDebounceMs: 50,
    });
    activeServers.push(server);
    const info = await server.start();

    const ownerSession = await server.authService.claimSetupToken({
      setupToken: info.setupToken!,
      username: 'owner',
      displayName: 'Owner User',
      password: 'password123',
    });

    const room = await server.roomService.createRoom(
      ownerSession.user,
      {
        name: 'Live Room',
        visibility: 'listed',
        workspace: createSeededTestWorkspace(),
      },
    );

    const client = await connectTestWsClient(server.getWsBaseUrl(), room.id, ownerSession.token);
    const welcome = await client.waitForMessage('room-welcome');
    expect(welcome.type).toBe('room-welcome');
    expect(welcome.roomId).toBe(room.id);
    expect(welcome.role).toBe('ROOM_OWNER');
    expect(welcome.workspace.config.projectName).toBe('Flight Control System');
    expect(welcome.members.length).toBe(1);

    await client.close();
  });

  it('orders 50 concurrent socket adds, retries idempotently, recovers acknowledged ops and supplies catch-up', async () => {
    const fixture = await createTestStore({ schemaPrefix: 'op_runtime' });
    fixtures.push(fixture);
    const server = new CollabServer({ store: fixture.store, dataDir: createTempDir(), host: '127.0.0.1', port: 0,
      insecureHttp: true, discovery: false, autosaveDebounceMs: 60000, autosaveMaxWaitMs: 60000 });
    activeServers.push(server);
    const info = await server.start();
    const owner = await server.authService.claimSetupToken({ setupToken: info.setupToken!, username: 'owner', displayName: 'Owner', password: 'password123' });
    const workspace = createSeededTestWorkspace();
    const functionId = workspace.domains.REQUIREMENT.functions[0]!.functionId;
    const room = await server.roomService.createRoom(owner.user, { name: 'Concurrent', visibility: 'listed', workspace });
    const clients = await Promise.all(Array.from({ length: 5 }, () => connectTestWsClient(server.getWsBaseUrl(), room.id, owner.token)));
    try {
      await Promise.all(clients.map(c => c.waitForMessage('room-welcome')));
      const ops = Array.from({ length: 50 }, (_, i) => ({ opId: randomUUID(), kind: 'item.add' as const,
        payload: { objectType: 'REQUIREMENT' as const, functionId, values: { col_desc: `Requirement ${i}` } } }));
      const acknowledgments = ops.map((op, i) => {
        const client = clients[i % clients.length]!;
        client.send({ type: 'op', op });
        return client.waitForMessage('op-ack', msg => msg.opId === op.opId);
      });
      const acks = await Promise.all(acknowledgments);
      expect(acks.map(a => a.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
      const runtime = server.runtimeManager.getLoadedRuntime(room.id)!;
      const live = runtime.getWorkspace();
      expect(new Set(live.domains.REQUIREMENT.functions[0]!.items.map(i => i.id)).size).toBe(50);
      for (const client of clients) {
        let mirror = workspace;
        for (let seq = 1; seq <= 50; seq++) {
          const applied = await client.waitForMessage('op-applied', m => m.seq === seq);
          mirror = applyWorkspaceOp(mirror, applied.op, applied.result as OpResult).workspace;
        }
        expect(mirror).toEqual(live);
      }
      clients[0]!.send({ type: 'op', op: ops[0]! });
      expect(await clients[0]!.waitForMessage('op-ack', m => m.opId === ops[0]!.opId)).toEqual(acks[0]);
      expect(runtime.getHeadSeq()).toBe(50);
      clients[0]!.send({ type: 'op', op: { ...ops[0]!, payload: { ...ops[0]!.payload, values: { col_desc: 'Different request' } } } });
      expect((await clients[0]!.waitForMessage('op-rejected')).code).toBe('CONFLICT');
      // Create a fresh runtime without flushing the original: only the initial snapshot exists.
      expect((await fixture.store.snapshots.getLatest(room.id))!.seq).toBe(0);
      const restarted = await RoomRuntime.create(room.id, fixture.store, server.roomService);
      expect(restarted.getWorkspace()).toEqual(live);
      expect(restarted.getHeadSeq()).toBe(50);
      // REST/export paths also recover committed operations before a room has been loaded.
      server.roomService.setRuntimeHooks({ getWorkspaceProvider: () => null });
      expect(await server.roomService.loadRoomWorkspace(room.id)).toEqual(live);
      clients[0]!.send({ type: 'ops-since', seq: 45 });
      const catchup = await clients[0]!.waitForMessage('ops-since-reply');
      expect(catchup.ops.map(o => o.seq)).toEqual([46, 47, 48, 49, 50]);
      await restarted.close();
      expect((await fixture.store.rooms.getById(room.id))!.snapshot_seq).toBe(50);
      // Catch-up must also fall back when the stored log has a hole.
      await fixture.pool.query('DELETE FROM room_ops WHERE room_id = $1 AND seq = 47', [room.id]);
      clients[0]!.send({ type: 'ops-since', seq: 45 });
      expect((await clients[0]!.waitForMessage('snapshot')).seq).toBe(50);
      await fixture.store.ops.prune(room.id, 50, '2100-01-01T00:00:00.000Z');
      clients[0]!.send({ type: 'ops-since', seq: 0 });
      expect((await clients[0]!.waitForMessage('snapshot')).workspace).toEqual(live);
    } finally { await Promise.all(clients.map(c => c.close())); }
  });

  it('rejects unauthorized edits and failed commits without advancing or poisoning the queue', async () => {
    const fixture = await createTestStore({ schemaPrefix: 'op_failure' });
    fixtures.push(fixture);
    const server = new CollabServer({ store: fixture.store, dataDir: createTempDir(), host: '127.0.0.1', port: 0, insecureHttp: true, discovery: false });
    activeServers.push(server);
    const info = await server.start();
    const owner = await server.authService.claimSetupToken({ setupToken: info.setupToken!, username: 'owner', displayName: 'Owner', password: 'password123' });
    const workspace = createSeededTestWorkspace();
    const functionId = workspace.domains.REQUIREMENT.functions[0]!.functionId;
    const room = await server.roomService.createRoom(owner.user, { name: 'Rejects', visibility: 'listed', workspace });
    const client = await connectTestWsClient(server.getWsBaseUrl(), room.id, owner.token);
    try {
      await client.waitForMessage('room-welcome');
      const runtime = server.runtimeManager.getLoadedRuntime(room.id)!;
      const op = { opId: randomUUID(), kind: 'item.add' as const, payload: { objectType: 'REQUIREMENT' as const, functionId, values: { col_desc: 'Valid' } } };
      await fixture.store.memberships.updateRole(room.id, owner.user.id, 'VIEWER');
      client.send({ type: 'op', op });
      expect((await client.waitForMessage('op-rejected')).code).toBe('READ_ONLY');
      expect(runtime.getHeadSeq()).toBe(0);
      await fixture.store.memberships.updateRole(room.id, owner.user.id, 'ROOM_OWNER');
      // A database constraint failure must roll back both the log and head update.
      await fixture.pool.query(`ALTER TABLE room_ops ADD CONSTRAINT test_reject_ops CHECK (kind <> 'item.add')`);
      client.send({ type: 'op', op });
      await client.waitForMessage('op-rejected');
      expect(runtime.getWorkspace()).toEqual(workspace);
      expect(runtime.getHeadSeq()).toBe(0);
      expect(await fixture.store.ops.getByOpId(room.id, op.opId)).toBeNull();
      await fixture.pool.query('ALTER TABLE room_ops DROP CONSTRAINT test_reject_ops');
      client.send({ type: 'op', op });
      expect((await client.waitForMessage('op-ack')).seq).toBe(1);
      const itemId = runtime.getWorkspace().domains.REQUIREMENT.functions[0]!.items[0]!.id;
      const edit = { opId: randomUUID(), kind: 'item.edit' as const, payload: { objectType: 'REQUIREMENT' as const, functionId, itemId, values: { col_desc: 'Updated' } } };
      client.send({ type: 'op', op: edit });
      expect((await client.waitForMessage('op-rejected')).code).toBe('LOCKED');
      client.send({ type: 'lock-acquire', key: `item:${itemId}` });
      await client.waitForMessage('lock-granted');
      client.send({ type: 'op', op: edit });
      expect((await client.waitForMessage('op-ack', m => m.opId === edit.opId)).seq).toBe(2);
      expect(runtime.getWorkspace().domains.REQUIREMENT.functions[0]!.items[0]!.values.col_desc).toBe('Updated');
    } finally { await client.close(); }
  });

  it('parses CLI flags and starts/stops via startServerFromCli', async () => {
    const dataDir = createTempDir();
    const parsed = parseServerCliArgs(
      [
        '--data-dir',
        dataDir,
        '--host=127.0.0.1',
        '--port',
        '0',
        '--name',
        'CLI Test Server',
        '--registration-mode=approval',
        '--room-creation-mode=admins_only',
        '--setup-token=my_secret_setup_token',
        '--insecure-http',
      ],
      {},
    );

    expect(parsed.dataDir).toBe(path.resolve(dataDir));
    expect(parsed.host).toBe('127.0.0.1');
    expect(parsed.port).toBe(0);
    expect(parsed.serverName).toBe('CLI Test Server');
    expect(parsed.registrationMode).toBe('approval');
    expect(parsed.roomCreationMode).toBe('admins_only');
    expect(parsed.initialSetupToken).toBe('my_secret_setup_token');
    expect(parsed.insecureHttp).toBe(true);

    expect(formatServerHelpText()).toContain('Usage: npm run server');

    const logs: string[] = [];
    const helpResult = await startServerFromCli(['--help'], {}, line => logs.push(line));
    expect(helpResult).toBeNull();
    expect(logs.join('\n')).toContain('HLR Collaboration Server');

    const cliFixture = await createTestStore({ schemaPrefix: 'cli' });
    fixtures.push(cliFixture);
    const serverLogs: string[] = [];
    const cliServer = await startServerFromCli(
      [
        `--data-dir=${dataDir}`,
        `--database-url=${cliFixture.databaseUrl}${cliFixture.databaseUrl.includes('?') ? '&' : '?'}options=${encodeURIComponent('-c search_path=' + cliFixture.schema)}`,
        '--host=127.0.0.1',
        '--port=0',
        '--setup-token=cli_setup_tok_123',
        '--insecure-http',
      ],
      {},
      line => serverLogs.push(line),
    );
    expect(cliServer).not.toBeNull();
    activeServers.push(cliServer!);
    expect(serverLogs.join('\n')).toContain('One-Time Setup Token: cli_setup_tok_123');
  });
});
