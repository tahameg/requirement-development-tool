import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { addFunction, addModule, createWorkspace } from '../../src/main/services/workspaceFactory.js';
import { loadWorkspace } from '../../src/main/services/workspaceService.js';
import {
  CollabServer,
  RoomRuntime,
  WS_CLOSE_FORBIDDEN,
  WS_CLOSE_NOT_FOUND,
  WS_CLOSE_UNAUTHORIZED,
  formatServerHelpText,
  parseServerCliArgs,
  startServerFromCli,
} from '../../src/server/index.js';
import type {
  WsClientMessage,
  WsServerMessage,
} from '../../src/shared/collab/types.js';
import {
  addYDocPendingItem,
  deleteYDocFunction,
  deleteYDocItem,
  deleteYDocModule,
  resetYDocToServerState,
  updateYDocConfig,
  updateYDocFunctionDescription,
  updateYDocItemField,
  upsertYDocModule,
  yDocToWorkspace,
} from '../../src/shared/collab/yjsDoc.js';

interface TestWsClient {
  ws: WebSocket;
  doc: Y.Doc;
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

  const doc = new Y.Doc();
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

    if (msg.type === 'room-welcome') {
      resetYDocToServerState(doc, msg.stateUpdate);
    } else if (msg.type === 'sync-step2') {
      Y.applyUpdate(doc, new Uint8Array(Buffer.from(msg.update, 'base64')));
    } else if (msg.type === 'sync-update') {
      Y.applyUpdate(doc, new Uint8Array(Buffer.from(msg.update, 'base64')));
    } else if ((msg.type === 'error' || msg.type === 'conflict') && msg.correctiveUpdate) {
      resetYDocToServerState(doc, msg.correctiveUpdate);
    }

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
    doc,
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

function captureLocalUpdate(doc: Y.Doc, mutate: () => void): string {
  const chunks: Uint8Array[] = [];
  const onUpdate = (u: Uint8Array) => chunks.push(u);
  doc.on('update', onUpdate);
  try {
    mutate();
  } finally {
    doc.off('update', onUpdate);
  }
  const merged = chunks.length === 1 ? chunks[0]! : Y.mergeUpdates(chunks);
  return Buffer.from(merged).toString('base64');
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

describe('T05: RoomRuntime, WebSocket Sync, Server-Authoritative ID Allocation, and CollabServer', () => {
  const tempDirs: string[] = [];
  const activeServers: CollabServer[] = [];

  function createTempDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hlr-t05-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    while (activeServers.length > 0) {
      const srv = activeServers.pop()!;
      await srv.stop();
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
    const server = new CollabServer({
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
    const server = new CollabServer({
      dataDir,
      host: '127.0.0.1',
      port: 0,
      insecureHttp: true,
      serverName: 'REST API Server',
    });
    activeServers.push(server);

    const info = await server.start();
    const baseUrl = info.url;

    // 1. Public server info
    const serverInfoRes = await apiJson(baseUrl, 'GET', '/api/server/info');
    expect(serverInfoRes.status).toBe(200);
    expect(serverInfoRes.body.ok).toBe(true);
    expect(serverInfoRes.body.value.setupRequired).toBe(true);

    // 2. Claim setup token -> SERVER_OWNER
    const setupRes = await apiJson(baseUrl, 'POST', '/api/auth/setup', {
      body: {
        setupToken: info.setupToken,
        username: 'owner',
        displayName: 'Server Owner',
        password: 'password123',
      },
    });
    expect(setupRes.status).toBe(201);
    expect(setupRes.body.ok).toBe(true);
    const ownerToken = setupRes.body.value.token as string;
    const ownerId = setupRes.body.value.user.id as string;

    // 3. Register editor and viewer users
    const editorReg = await apiJson(baseUrl, 'POST', '/api/auth/register', {
      body: {
        username: 'alice',
        displayName: 'Alice Editor',
        password: 'password123',
      },
    });
    expect(editorReg.status).toBe(201);
    const aliceToken = editorReg.body.value.token as string;
    const aliceId = editorReg.body.value.user.id as string;

    const viewerReg = await apiJson(baseUrl, 'POST', '/api/auth/register', {
      body: {
        username: 'bob',
        displayName: 'Bob Viewer',
        password: 'password123',
      },
    });
    expect(viewerReg.status).toBe(201);
    const bobToken = viewerReg.body.value.token as string;
    const bobId = viewerReg.body.value.user.id as string;

    // 4. Verify /api/auth/me and /api/users/directory
    const meRes = await apiJson(baseUrl, 'GET', '/api/auth/me', { token: aliceToken });
    expect(meRes.status).toBe(200);
    expect(meRes.body.value.user.username).toBe('alice');

    const dirRes = await apiJson(baseUrl, 'GET', '/api/users/directory?q=bob', {
      token: ownerToken,
    });
    expect(dirRes.status).toBe(200);
    expect(dirRes.body.value.users).toHaveLength(1);
    expect(dirRes.body.value.users[0].username).toBe('bob');

    // 5. Server Admin endpoints
    const settingsRes = await apiJson(baseUrl, 'PATCH', '/api/admin/settings', {
      token: ownerToken,
      body: { name: 'Updated Server Name', registrationMode: 'approval' },
    });
    expect(settingsRes.status).toBe(200);
    expect(settingsRes.body.value.settings.name).toBe('Updated Server Name');

    // Register charlie under 'approval' mode -> PENDING_APPROVAL, then approve
    const charlieReg = await apiJson(baseUrl, 'POST', '/api/auth/register', {
      body: {
        username: 'charlie',
        displayName: 'Charlie Pending',
        password: 'password123',
      },
    });
    expect(charlieReg.status).toBe(201);
    expect(charlieReg.body.value.status).toBe('PENDING_APPROVAL');
    const charlieId = charlieReg.body.value.user.id as string;

    const approveRes = await apiJson(
      baseUrl,
      'POST',
      `/api/admin/users/${charlieId}/approve`,
      { token: ownerToken },
    );
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.value.user.status).toBe('ACTIVE');

    const charlieLogin = await apiJson(baseUrl, 'POST', '/api/auth/login', {
      body: { username: 'charlie', password: 'password123' },
    });
    expect(charlieLogin.status).toBe(200);
    const charlieToken = charlieLogin.body.value.token as string;

    // 6. Create room with seeded workspace
    const seededWorkspace = createSeededTestWorkspace();
    const createRoomRes = await apiJson(baseUrl, 'POST', '/api/rooms', {
      token: ownerToken,
      body: {
        name: 'Avionics Room',
        visibility: 'listed',
        workspace: seededWorkspace,
      },
    });
    expect(createRoomRes.status).toBe(201);
    const roomId = createRoomRes.body.value.room.id as string;

    // 7. Direct invite Alice as EDITOR, Bob requests to join listed room, Charlie redeems invite code
    const directInvRes = await apiJson(baseUrl, 'POST', `/api/rooms/${roomId}/invites`, {
      token: ownerToken,
      body: { targetUserId: aliceId, role: 'EDITOR' },
    });
    expect(directInvRes.status).toBe(201);
    const inviteId = directInvRes.body.value.invite.id as string;

    const acceptRes = await apiJson(baseUrl, 'POST', `/api/invites/${inviteId}/respond`, {
      token: aliceToken,
      body: { accept: true },
    });
    expect(acceptRes.status).toBe(200);
    expect(acceptRes.body.value.accepted).toBe(true);

    const joinReqRes = await apiJson(baseUrl, 'POST', `/api/rooms/${roomId}/join-requests`, {
      token: bobToken,
      body: { message: 'Please let me view' },
    });
    expect(joinReqRes.status).toBe(201);
    const reqId = joinReqRes.body.value.joinRequest.id as string;

    const reviewRes = await apiJson(
      baseUrl,
      'POST',
      `/api/rooms/${roomId}/join-requests/${reqId}/review`,
      {
        token: ownerToken,
        body: { approve: true, role: 'VIEWER' },
      },
    );
    expect(reviewRes.status).toBe(200);
    expect(reviewRes.body.value.joinRequest.status).toBe('APPROVED');

    const codeRes = await apiJson(baseUrl, 'POST', `/api/rooms/${roomId}/invite-codes`, {
      token: ownerToken,
      body: { role: 'VIEWER', maxUses: 2 },
    });
    expect(codeRes.status).toBe(201);
    const code = codeRes.body.value.inviteCode.code as string;

    const redeemRes = await apiJson(baseUrl, 'POST', '/api/invites/redeem', {
      token: charlieToken,
      body: { code },
    });
    expect(redeemRes.status).toBe(200);
    expect(redeemRes.body.value.role).toBe('VIEWER');

    // 8. Export room workspace as JSON and Markdown (allowed for VIEWER)
    const exportJsonRes = await apiJson(
      baseUrl,
      'GET',
      `/api/rooms/${roomId}/export?format=json`,
      { token: bobToken },
    );
    expect(exportJsonRes.status).toBe(200);
    expect(exportJsonRes.body.value.format).toBe('json');
    expect(exportJsonRes.body.value.content.config.projectName).toBe('Flight Control System');

    const exportMdRes = await apiJson(
      baseUrl,
      'GET',
      `/api/rooms/${roomId}/export?format=markdown`,
      { token: bobToken },
    );
    expect(exportMdRes.status).toBe(200);
    expect(typeof exportMdRes.body.value.content).toBe('string');

    // 9. Room audit log and server admin rooms list
    const roomAuditRes = await apiJson(baseUrl, 'GET', `/api/rooms/${roomId}/audit`, {
      token: ownerToken,
    });
    expect(roomAuditRes.status).toBe(200);
    expect(roomAuditRes.body.value.entries.length).toBeGreaterThan(0);

    const adminRoomsRes = await apiJson(baseUrl, 'GET', '/api/admin/rooms', {
      token: ownerToken,
    });
    expect(adminRoomsRes.status).toBe(200);
    expect(adminRoomsRes.body.value.rooms).toHaveLength(1);

    // 10. Kick and ban/unban Charlie, Charlie leaves/gets removed, logout
    const banRes = await apiJson(
      baseUrl,
      'POST',
      `/api/rooms/${roomId}/members/${charlieId}/ban`,
      { token: ownerToken, body: { reason: 'Test ban' } },
    );
    expect(banRes.status).toBe(200);

    const unbanRes = await apiJson(
      baseUrl,
      'DELETE',
      `/api/rooms/${roomId}/bans/${charlieId}`,
      { token: ownerToken },
    );
    expect(unbanRes.status).toBe(200);

    const resolveStuckRes = await apiJson(
      baseUrl,
      'POST',
      `/api/admin/rooms/${roomId}/resolve`,
      { token: ownerToken, body: { userId: aliceId, role: 'ROOM_ADMIN' } },
    );
    expect(resolveStuckRes.status).toBe(200);

    const transferRes = await apiJson(
      baseUrl,
      'POST',
      `/api/rooms/${roomId}/transfer-ownership`,
      { token: ownerToken, body: { newOwnerUserId: aliceId } },
    );
    expect(transferRes.status).toBe(200);
    expect(transferRes.body.value.room.ownerId).toBe(aliceId);

    // Former owner (now ROOM_ADMIN) can leave room
    const leaveRes = await apiJson(baseUrl, 'POST', `/api/rooms/${roomId}/leave`, {
      token: ownerToken,
    });
    expect(leaveRes.status).toBe(200);
    expect(leaveRes.body.value.left).toBe(true);

    // OwnerId cannot be deleted by non-owner non-admin, but Alice (now ROOM_OWNER) can delete room
    const delRoomRes = await apiJson(baseUrl, 'DELETE', `/api/rooms/${roomId}`, {
      token: aliceToken,
    });
    expect(delRoomRes.status).toBe(200);
    expect(delRoomRes.body.value.deleted).toBe(true);

    const logoutRes = await apiJson(baseUrl, 'POST', '/api/auth/logout', {
      token: charlieToken,
    });
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body.value.loggedOut).toBe(true);

    // Unknown route returns 404
    const notFoundRes = await apiJson(baseUrl, 'GET', '/api/nonexistent');
    expect(notFoundRes.status).toBe(404);
    expect(notFoundRes.body.code).toBe('NOT_FOUND');

    expect(ownerId).toBeTruthy();
    expect(bobId).toBeTruthy();
  });

  it('synchronizes live Yjs edits and Awareness (stripping field focus from VIEWERs) across WebSocket clients', async () => {
    const dataDir = createTempDir();
    const server = new CollabServer({
      dataDir,
      host: '127.0.0.1',
      port: 0,
      insecureHttp: true,
      autosaveDebounceMs: 50,
    });
    activeServers.push(server);
    const info = await server.start();

    const ownerSession = server.authService.claimSetupToken({
      setupToken: info.setupToken!,
      username: 'owner',
      displayName: 'Owner User',
      password: 'password123',
    });
    const editorReg = server.authService.registerUser({
      username: 'editor',
      displayName: 'Editor User',
      password: 'password123',
    });
    const viewerReg = server.authService.registerUser({
      username: 'viewer',
      displayName: 'Viewer User',
      password: 'password123',
    });
    const outsiderReg = server.authService.registerUser({
      username: 'outsider',
      displayName: 'Outsider User',
      password: 'password123',
    });

    if (
      editorReg.status !== 'ACTIVE' ||
      viewerReg.status !== 'ACTIVE' ||
      outsiderReg.status !== 'ACTIVE'
    ) {
      throw new Error('Expected active registrations');
    }

    const seeded = createSeededTestWorkspace();
    const fnId = seeded.domains.REQUIREMENT.functions[0]!.functionId;
    const room = await server.roomService.createRoom(ownerSession.user, {
      name: 'Sync Room',
      visibility: 'private',
      workspace: seeded,
    });

    // Add editor and viewer to room
    const inv1 = server.roomService.createDirectInvite(ownerSession.user, room.id, {
      targetUserId: editorReg.user.id,
      role: 'EDITOR',
    });
    server.roomService.respondToInvite(editorReg.user, inv1.id, { accept: true });

    const inv2 = server.roomService.createDirectInvite(ownerSession.user, room.id, {
      targetUserId: viewerReg.user.id,
      role: 'VIEWER',
    });
    server.roomService.respondToInvite(viewerReg.user, inv2.id, { accept: true });

    // Verify unauthorized/forbidden/not-found WebSocket close codes
    const badTokenWs = new WebSocket(`${info.wsUrl}/ws/rooms/${room.id}?token=invalid_token`);
    const badTokenClose = await new Promise<number>(resolve => {
      badTokenWs.once('close', code => resolve(code));
    });
    expect(badTokenClose).toBe(WS_CLOSE_UNAUTHORIZED);

    const outsiderWs = new WebSocket(
      `${info.wsUrl}/ws/rooms/${room.id}?token=${outsiderReg.token}`,
    );
    const outsiderClose = await new Promise<number>(resolve => {
      outsiderWs.once('close', code => resolve(code));
    });
    expect(outsiderClose).toBe(WS_CLOSE_FORBIDDEN);

    const missingRoomWs = new WebSocket(
      `${info.wsUrl}/ws/rooms/room_does_not_exist?token=${ownerSession.token}`,
    );
    const missingRoomClose = await new Promise<number>(resolve => {
      missingRoomWs.once('close', code => resolve(code));
    });
    expect(missingRoomClose).toBe(WS_CLOSE_NOT_FOUND);

    // Connect Owner, Editor, and Viewer
    const ownerClient = await connectTestWsClient(info.wsUrl, room.id, ownerSession.token);
    const welcomeOwner = await ownerClient.waitForMessage('room-welcome');
    expect(welcomeOwner.role).toBe('ROOM_OWNER');

    const editorClient = await connectTestWsClient(info.wsUrl, room.id, editorReg.token, {
      useAuthHeader: true,
    });
    const welcomeEditor = await editorClient.waitForMessage('room-welcome');
    expect(welcomeEditor.role).toBe('EDITOR');

    const viewerClient = await connectTestWsClient(info.wsUrl, room.id, viewerReg.token);
    const welcomeViewer = await viewerClient.waitForMessage('room-welcome');
    expect(welcomeViewer.role).toBe('VIEWER');

    // Test ping/pong and sync-step1/sync-step2
    ownerClient.send({ type: 'ping', timestamp: 12345 });
    const pong = await ownerClient.waitForMessage('pong');
    expect(pong.timestamp).toBe(12345);

    const svBase64 = Buffer.from(Y.encodeStateVector(editorClient.doc)).toString('base64');
    editorClient.send({ type: 'sync-step1', stateVector: svBase64 });
    const step2 = await editorClient.waitForMessage('sync-step2');
    expect(step2.update).toBeTruthy();

    // Editor updates function description via Y.Text diff and sends sync-update
    const descUpdateBase64 = captureLocalUpdate(editorClient.doc, () => {
      updateYDocFunctionDescription(
        editorClient.doc,
        'REQUIREMENT',
        fnId,
        'Updated collaborative guidance scope',
      );
    });

    editorClient.send({
      type: 'sync-update',
      update: descUpdateBase64,
      clientOpId: 'op_desc_1',
    });

    await ownerClient.waitForMessage(
      'sync-update',
      m => m.actorUserId === editorReg.user.id && m.clientOpId === 'op_desc_1',
    );
    await viewerClient.waitForMessage(
      'sync-update',
      m => m.actorUserId === editorReg.user.id && m.clientOpId === 'op_desc_1',
    );

    expect(
      yDocToWorkspace(ownerClient.doc).domains.REQUIREMENT.functions[0]!.description,
    ).toBe('Updated collaborative guidance scope');
    expect(
      yDocToWorkspace(viewerClient.doc).domains.REQUIREMENT.functions[0]!.description,
    ).toBe('Updated collaborative guidance scope');

    // Editor broadcasts Awareness with both view and field focus
    editorClient.send({
      type: 'awareness-update',
      state: {
        userId: editorReg.user.id,
        username: editorReg.user.username,
        displayName: editorReg.user.displayName,
        role: 'EDITOR',
        color: '#000000',
        view: { objectType: 'REQUIREMENT', kind: 'function', id: fnId },
        focus: {
          objectType: 'REQUIREMENT',
          functionId: fnId,
          itemId: '__scope__',
          columnId: 'description',
          cursor: { anchor: 0, head: 7 },
        },
        updatedAt: Date.now(),
      },
    });

    const awarenessFromEditor = await ownerClient.waitForMessage(
      'awareness-broadcast',
      m => m.states.some(s => s.userId === editorReg.user.id && s.focus !== null),
    );
    const editorState = awarenessFromEditor.states.find(s => s.userId === editorReg.user.id)!;
    expect(editorState.focus?.columnId).toBe('description');

    // Viewer broadcasts Awareness attempting to include field focus -> Server MUST strip focus for VIEWER
    viewerClient.send({
      type: 'awareness-update',
      state: {
        userId: viewerReg.user.id,
        username: viewerReg.user.username,
        displayName: viewerReg.user.displayName,
        role: 'VIEWER',
        color: '#ffffff',
        view: { objectType: 'REQUIREMENT', kind: 'function', id: fnId },
        focus: {
          objectType: 'REQUIREMENT',
          functionId: fnId,
          itemId: '__scope__',
          columnId: 'description',
        },
        updatedAt: Date.now(),
      },
    });

    const awarenessFromViewer = await ownerClient.waitForMessage(
      'awareness-broadcast',
      m => m.states.some(s => s.userId === viewerReg.user.id),
    );
    const viewerState = awarenessFromViewer.states.find(s => s.userId === viewerReg.user.id)!;
    expect(viewerState.view?.id).toBe(fnId);
    expect(viewerState.focus).toBeNull();

    await ownerClient.close();
    await editorClient.close();
    await viewerClient.close();
  });

  it('allocates strictly unique sequential IDs under concurrency with zero collisions and keeps retired IDs retired', async () => {
    const dataDir = createTempDir();
    const server = new CollabServer({
      dataDir,
      host: '127.0.0.1',
      port: 0,
      insecureHttp: true,
    });
    activeServers.push(server);
    const info = await server.start();

    const ownerSession = server.authService.claimSetupToken({
      setupToken: info.setupToken!,
      username: 'owner',
      displayName: 'Owner',
      password: 'password123',
    });
    const editorReg = server.authService.registerUser({
      username: 'editor',
      displayName: 'Editor',
      password: 'password123',
    });
    if (editorReg.status !== 'ACTIVE') throw new Error('Expected active editor');

    const seeded = createSeededTestWorkspace();
    const fnId = seeded.domains.REQUIREMENT.functions[0]!.functionId;
    const room = await server.roomService.createRoom(ownerSession.user, {
      name: 'ID Allocation Room',
      visibility: 'private',
      workspace: seeded,
    });

    const inv = server.roomService.createDirectInvite(ownerSession.user, room.id, {
      targetUserId: editorReg.user.id,
      role: 'EDITOR',
    });
    server.roomService.respondToInvite(editorReg.user, inv.id, { accept: true });

    const clientA = await connectTestWsClient(info.wsUrl, room.id, ownerSession.token);
    const clientB = await connectTestWsClient(info.wsUrl, room.id, editorReg.token);
    await clientA.waitForMessage('room-welcome');
    await clientB.waitForMessage('room-welcome');

    // Fire 10 concurrent alloc-item requests from Client A and 10 from Client B simultaneously
    const countPerClient = 10;
    const promisesA: Promise<Extract<WsServerMessage, { type: 'alloc-item-ack' }>>[] = [];
    const promisesB: Promise<Extract<WsServerMessage, { type: 'alloc-item-ack' }>>[] = [];

    for (let i = 0; i < countPerClient; i += 1) {
      const reqIdA = `req_A_${i}`;
      const tempIdA = `__pending__:temp_A_${i}`;
      promisesA.push(clientA.waitForMessage('alloc-item-ack', m => m.requestId === reqIdA));
      clientA.send({
        type: 'alloc-item',
        requestId: reqIdA,
        tempId: tempIdA,
        objectType: 'REQUIREMENT',
        functionId: fnId,
        values: { col_desc: `Requirement from A #${i}` },
      });

      const reqIdB = `req_B_${i}`;
      const tempIdB = `__pending__:temp_B_${i}`;
      promisesB.push(clientB.waitForMessage('alloc-item-ack', m => m.requestId === reqIdB));
      clientB.send({
        type: 'alloc-item',
        requestId: reqIdB,
        tempId: tempIdB,
        objectType: 'REQUIREMENT',
        functionId: fnId,
        values: { col_desc: `Requirement from B #${i}` },
      });
    }

    const acks = await Promise.all([...promisesA, ...promisesB]);
    expect(acks).toHaveLength(20);

    const assignedIds = acks.map(a => a.item.id);
    const assignedSeqs = acks.map(a => a.item.seq).sort((a, b) => a - b);

    // Every ID and sequence number must be strictly unique (1..20)
    expect(new Set(assignedIds).size).toBe(20);
    expect(assignedSeqs).toEqual(Array.from({ length: 20 }, (_, idx) => idx + 1));

    // Delete item #20 via Y.Doc update and verify its ID is retired and never reallocated
    const item20 = acks.find(a => a.item.seq === 20)!.item;
    const deleteUpdate = captureLocalUpdate(clientA.doc, () => {
      deleteYDocItem(clientA.doc, 'REQUIREMENT', fnId, item20.id);
    });
    clientA.send({ type: 'sync-update', update: deleteUpdate, clientOpId: 'del_20' });
    await clientB.waitForMessage('sync-update', m => m.clientOpId === 'del_20');

    // Now allocate one more item -> must get seq 21 (never reusing 20!)
    clientB.send({
      type: 'alloc-item',
      requestId: 'req_after_del',
      tempId: '__pending__:after_del',
      objectType: 'REQUIREMENT',
      functionId: fnId,
      values: { col_desc: 'Post-deletion requirement' },
    });
    const ackAfterDel = await clientB.waitForMessage(
      'alloc-item-ack',
      m => m.requestId === 'req_after_del',
    );
    expect(ackAfterDel.item.seq).toBe(21);
    expect(ackAfterDel.item.id).not.toBe(item20.id);

    // Also test resolving a `__pending__:` item synced directly via `sync-update`
    const pendingSyncUpdate = captureLocalUpdate(clientA.doc, () => {
      addYDocPendingItem(clientA.doc, 'REQUIREMENT', fnId, '__pending__:via_ydoc', {
        col_desc: 'Created via pending Y.Doc entry',
      });
    });
    clientA.send({ type: 'sync-update', update: pendingSyncUpdate });
    const pendingAck = await clientA.waitForMessage(
      'alloc-item-ack',
      m => m.tempId === '__pending__:via_ydoc',
    );
    expect(pendingAck.item.seq).toBe(22);

    const runtime = await server.runtimeManager.getOrCreateRoomRuntime(room.id);
    const serverWorkspace = runtime.getWorkspace();
    expect(serverWorkspace.retiredIds).toContain(item20.id);
    expect(serverWorkspace.domains.REQUIREMENT.functions[0]!.watermarkCounter).toBe(22);

    await clientA.close();
    await clientB.close();
  });

  it('rejects VIEWER writes and EDITOR config/delete-module/delete-function updates with corrective sync-step2', async () => {
    const dataDir = createTempDir();
    const server = new CollabServer({
      dataDir,
      host: '127.0.0.1',
      port: 0,
      insecureHttp: true,
    });
    activeServers.push(server);
    const info = await server.start();

    const ownerSession = server.authService.claimSetupToken({
      setupToken: info.setupToken!,
      username: 'owner',
      displayName: 'Owner',
      password: 'password123',
    });
    const editorReg = server.authService.registerUser({
      username: 'editor',
      displayName: 'Editor',
      password: 'password123',
    });
    const viewerReg = server.authService.registerUser({
      username: 'viewer',
      displayName: 'Viewer',
      password: 'password123',
    });
    if (editorReg.status !== 'ACTIVE' || viewerReg.status !== 'ACTIVE') {
      throw new Error('Expected active users');
    }

    const seeded = createSeededTestWorkspace();
    const modId = seeded.domains.REQUIREMENT.modules[0]!.id;
    const fnId = seeded.domains.REQUIREMENT.functions[0]!.functionId;
    const room = await server.roomService.createRoom(ownerSession.user, {
      name: 'Permission Guard Room',
      visibility: 'private',
      workspace: seeded,
    });

    const invEditor = server.roomService.createDirectInvite(ownerSession.user, room.id, {
      targetUserId: editorReg.user.id,
      role: 'EDITOR',
    });
    server.roomService.respondToInvite(editorReg.user, invEditor.id, { accept: true });

    const invViewer = server.roomService.createDirectInvite(ownerSession.user, room.id, {
      targetUserId: viewerReg.user.id,
      role: 'VIEWER',
    });
    server.roomService.respondToInvite(viewerReg.user, invViewer.id, { accept: true });

    const ownerClient = await connectTestWsClient(info.wsUrl, room.id, ownerSession.token);
    const editorClient = await connectTestWsClient(info.wsUrl, room.id, editorReg.token);
    const viewerClient = await connectTestWsClient(info.wsUrl, room.id, viewerReg.token);
    await ownerClient.waitForMessage('room-welcome');
    await editorClient.waitForMessage('room-welcome');
    await viewerClient.waitForMessage('room-welcome');

    // 1. VIEWER attempts to edit function description via Yjs update
    const viewerIllegalUpdate = captureLocalUpdate(viewerClient.doc, () => {
      updateYDocFunctionDescription(
        viewerClient.doc,
        'REQUIREMENT',
        fnId,
        'Hacked by viewer',
      );
    });
    viewerClient.send({ type: 'sync-update', update: viewerIllegalUpdate });

    const viewerError = await viewerClient.waitForMessage('error');
    expect(viewerError.code).toBe('FORBIDDEN');
    const viewerCorrective = await viewerClient.waitForMessage('sync-step2');
    expect(viewerCorrective.update).toBeTruthy();

    // Viewer's local Y.Doc is reverted by the corrective sync-step2, and server workspace is untouched
    expect(
      yDocToWorkspace(viewerClient.doc).domains.REQUIREMENT.functions[0]!.description,
    ).toBe('Initial guidance description');
    const runtime = await server.runtimeManager.getOrCreateRoomRuntime(room.id);
    expect(runtime.getWorkspace().domains.REQUIREMENT.functions[0]!.description).toBe(
      'Initial guidance description',
    );

    // 2. VIEWER attempts alloc-item -> rejected with FORBIDDEN
    viewerClient.send({
      type: 'alloc-item',
      requestId: 'viewer_alloc_1',
      tempId: '__pending__:v1',
      objectType: 'REQUIREMENT',
      functionId: fnId,
      values: { col_desc: 'Unauthorized item' },
    });
    const viewerAllocErr = await viewerClient.waitForMessage(
      'error',
      m => m.requestId === 'viewer_alloc_1',
    );
    expect(viewerAllocErr.code).toBe('FORBIDDEN');

    // 3. EDITOR attempts to modify ProjectConfig via Yjs update -> rejected with FORBIDDEN + corrective sync-step2
    const editorConfigUpdate = captureLocalUpdate(editorClient.doc, () => {
      const currentWs = yDocToWorkspace(editorClient.doc);
      updateYDocConfig(editorClient.doc, {
        ...currentWs.config,
        projectName: 'Unauthorized Rename',
      });
    });
    editorClient.send({ type: 'sync-update', update: editorConfigUpdate });

    const editorConfigErr = await editorClient.waitForMessage('error');
    expect(editorConfigErr.code).toBe('FORBIDDEN');
    await editorClient.waitForMessage('sync-step2');
    expect(yDocToWorkspace(editorClient.doc).config.projectName).toBe('Flight Control System');
    expect(runtime.getWorkspace().config.projectName).toBe('Flight Control System');

    // 4. EDITOR attempts to delete a function via Yjs update -> rejected with FORBIDDEN + corrective sync-step2
    const editorDeleteFnUpdate = captureLocalUpdate(editorClient.doc, () => {
      deleteYDocFunction(editorClient.doc, 'REQUIREMENT', fnId);
    });
    editorClient.send({ type: 'sync-update', update: editorDeleteFnUpdate });

    const editorDelFnErr = await editorClient.waitForMessage('error');
    expect(editorDelFnErr.code).toBe('FORBIDDEN');
    await editorClient.waitForMessage('sync-step2');
    expect(yDocToWorkspace(editorClient.doc).domains.REQUIREMENT.functions).toHaveLength(1);
    expect(runtime.getWorkspace().domains.REQUIREMENT.functions).toHaveLength(1);

    // 5. EDITOR attempts to delete a module via Yjs update -> rejected with FORBIDDEN + corrective sync-step2
    const editorDeleteModUpdate = captureLocalUpdate(editorClient.doc, () => {
      deleteYDocModule(editorClient.doc, 'REQUIREMENT', modId);
    });
    editorClient.send({ type: 'sync-update', update: editorDeleteModUpdate });

    const editorDelModErr = await editorClient.waitForMessage('error');
    expect(editorDelModErr.code).toBe('FORBIDDEN');
    await editorClient.waitForMessage('sync-step2');
    expect(yDocToWorkspace(editorClient.doc).domains.REQUIREMENT.modules).toHaveLength(1);
    expect(runtime.getWorkspace().domains.REQUIREMENT.modules).toHaveLength(1);

    // 6. Structural conflict: Owner deletes module while Editor concurrently adds a submodule inside it
    const offlineEditorDoc = new Y.Doc();
    Y.applyUpdate(offlineEditorDoc, runtime.getStateUpdateBytes());

    const ownerDelModUpdate = captureLocalUpdate(ownerClient.doc, () => {
      deleteYDocModule(ownerClient.doc, 'REQUIREMENT', modId);
    });
    ownerClient.send({ type: 'sync-update', update: ownerDelModUpdate, clientOpId: 'owner_del_mod' });
    await editorClient.waitForMessage('sync-update', m => m.clientOpId === 'owner_del_mod');

    const conflictingSubmoduleUpdate = captureLocalUpdate(offlineEditorDoc, () => {
      upsertYDocModule(offlineEditorDoc, 'REQUIREMENT', {
        id: 'mod_sub_conflict',
        name: 'Orphaned Submodule',
        prefix: 'SUB',
        description: '',
        parentId: modId,
      });
    });
    editorClient.send({ type: 'sync-update', update: conflictingSubmoduleUpdate });

    const conflictMsg = await editorClient.waitForMessage('conflict');
    expect(conflictMsg.code).toBe('TARGET_DELETED');
    expect(conflictMsg.targetId).toBe(modId);

    // 7. Live demotion of Editor to VIEWER immediately revokes write access on open socket
    server.roomService.changeMemberRole(ownerSession.user, room.id, editorReg.user.id, {
      role: 'VIEWER',
    });
    await editorClient.waitForMessage('room-notification', m => m.kind === 'role-changed');

    const postDemotionUpdate = captureLocalUpdate(editorClient.doc, () => {
      upsertYDocModule(editorClient.doc, 'REQUIREMENT', {
        id: 'mod_after_demote',
        name: 'New Mod',
        prefix: 'NEW',
        description: '',
        parentId: null,
      });
    });
    editorClient.send({ type: 'sync-update', update: postDemotionUpdate });
    const demoteErr = await editorClient.waitForMessage('error');
    expect(demoteErr.code).toBe('PERMISSION_REVOKED');

    // 8. Kicking viewer sends 'kicked' message and closes their WebSocket
    server.roomService.kickMember(ownerSession.user, room.id, viewerReg.user.id, {
      reason: 'Session ended',
    });
    const kickedMsg = await viewerClient.waitForMessage('kicked');
    expect(kickedMsg.reason).toBe('Session ended');

    await ownerClient.close();
    await editorClient.close();
    await viewerClient.close();
  });

  it('recovers unsaved in-flight Yjs updates from yjs_updates WAL on RoomRuntime reload after a simulated crash', async () => {
    const dataDir = createTempDir();
    const server = new CollabServer({
      dataDir,
      host: '127.0.0.1',
      port: 0,
      insecureHttp: true,
      // Long debounce so saveWorkspace does NOT run before our simulated crash
      autosaveDebounceMs: 60_000,
      autosaveMaxWaitMs: 60_000,
    });
    activeServers.push(server);
    const info = await server.start();

    const ownerSession = server.authService.claimSetupToken({
      setupToken: info.setupToken!,
      username: 'owner',
      displayName: 'Owner',
      password: 'password123',
    });

    const seeded = createSeededTestWorkspace();
    const fnId = seeded.domains.REQUIREMENT.functions[0]!.functionId;
    const room = await server.roomService.createRoom(ownerSession.user, {
      name: 'Crash Recovery Room',
      visibility: 'private',
      workspace: seeded,
    });

    const client = await connectTestWsClient(info.wsUrl, room.id, ownerSession.token);
    await client.waitForMessage('room-welcome');

    // Allocate an item and edit its description
    client.send({
      type: 'alloc-item',
      requestId: 'crash_alloc_1',
      tempId: '__pending__:crash_1',
      objectType: 'REQUIREMENT',
      functionId: fnId,
      values: { col_desc: 'Initial requirement text' },
    });
    const allocAck = await client.waitForMessage(
      'alloc-item-ack',
      m => m.requestId === 'crash_alloc_1',
    );
    await client.waitForMessage('sync-update');

    const textEditUpdate = captureLocalUpdate(client.doc, () => {
      updateYDocItemField(
        client.doc,
        'REQUIREMENT',
        fnId,
        allocAck.item.id,
        'col_desc',
        'Edited requirement text in WAL before crash',
      );
    });
    client.send({
      type: 'sync-update',
      update: textEditUpdate,
      clientOpId: 'wal_edit_1',
    });
    await client.waitForMessage('sync-update', m => m.clientOpId === 'wal_edit_1');
    await client.close();

    // Verify that on-disk JSON workspace has NOT yet been updated (still 0 items because debounce is 60s),
    // while SQLite yjs_updates table has the WAL rows!
    const workspaceDir = server.roomService.getRoomWorkspaceDir(room.id);
    const diskBeforeRecovery = await loadWorkspace(workspaceDir);
    expect(diskBeforeRecovery.domains.REQUIREMENT.functions[0]!.items).toHaveLength(0);

    const walCountBefore = (
      server.serverDb.db
        .prepare('SELECT COUNT(*) AS count FROM yjs_updates WHERE room_id = ?')
        .get(room.id) as { count: number }
    ).count;
    expect(walCountBefore).toBeGreaterThan(1);

    // Simulate a server crash & restart by creating a brand new RoomRuntime from the existing serverDb and disk directory
    const recoveredRuntime = await RoomRuntime.create(
      room.id,
      server.serverDb,
      server.roomService,
    );
    const recoveredWorkspace = recoveredRuntime.getWorkspace();
    const recoveredItems = recoveredWorkspace.domains.REQUIREMENT.functions[0]!.items;

    expect(recoveredItems).toHaveLength(1);
    expect(recoveredItems[0]!.id).toBe(allocAck.item.id);
    expect(recoveredItems[0]!.values.col_desc).toBe(
      'Edited requirement text in WAL before crash',
    );

    // Recovery also materialized the workspace to disk and compacted yjs_updates to 1 row
    const diskAfterRecovery = await loadWorkspace(workspaceDir);
    expect(diskAfterRecovery.domains.REQUIREMENT.functions[0]!.items).toHaveLength(1);
    expect(diskAfterRecovery.domains.REQUIREMENT.functions[0]!.items[0]!.values.col_desc).toBe(
      'Edited requirement text in WAL before crash',
    );

    const walCountAfter = (
      server.serverDb.db
        .prepare('SELECT COUNT(*) AS count FROM yjs_updates WHERE room_id = ?')
        .get(room.id) as { count: number }
    ).count;
    expect(walCountAfter).toBe(1);

    await recoveredRuntime.close();
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

    const serverLogs: string[] = [];
    const cliServer = await startServerFromCli(
      [
        `--data-dir=${dataDir}`,
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
