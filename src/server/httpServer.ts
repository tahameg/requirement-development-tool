import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import {
  DEFAULT_DISCOVERY_PORT,
  DEFAULT_SERVER_PORT,
  type ApiErrorCode,
  type RegistrationMode,
  type RoomCreationMode,
  type ServerPublicInfo,
  type UserProfile,
} from '../shared/collab/types.js';
import { AuthService } from './auth.js';
import { CollabServiceError, ServerDatabase } from './db.js';
import { DiscoveryBroadcaster } from './discovery.js';
import { RoomRuntimeManager } from './roomRuntime.js';
import { RoomService } from './rooms.js';
import {
  ensureServerTlsCertificate,
  generateSelfSignedCertificate,
  type GenerateTlsCertOptions,
  type TlsCertificateBundle,
} from './tls.js';
import { CollabWsHandler } from './wsHandler.js';

const MAX_JSON_BODY_BYTES = 50 * 1024 * 1024; // 50 MB for large imported workspaces

export interface CollabServerOptions {
  dataDir: string;
  host?: string;
  port?: number;
  insecureHttp?: boolean;
  serverName?: string;
  version?: string;
  registrationMode?: RegistrationMode;
  roomCreationMode?: RoomCreationMode;
  initialSetupToken?: string;
  sessionTtlMs?: number;
  autosaveDebounceMs?: number;
  autosaveMaxWaitMs?: number;
  tlsOptions?: GenerateTlsCertOptions;
  discovery?: boolean;
  discoveryPort?: number;
  discoveryTargets?: readonly string[];
  discoveryIntervalMs?: number;
  now?: () => Date;
}

export interface CollabServerListenInfo {
  host: string;
  port: number;
  protocol: 'http' | 'https';
  wsProtocol: 'ws' | 'wss';
  url: string;
  wsUrl: string;
  tls: boolean;
  fingerprint: string | null;
  setupToken: string | null;
  serverId: string;
  discoveryPort: number | null;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendSuccess(res: ServerResponse, value: unknown, status = 200): void {
  sendJson(res, status, {
    ok: true,
    value,
  });
}

function sendError(
  res: ServerResponse,
  status: number,
  code: ApiErrorCode,
  error: string,
): void {
  sendJson(res, status, {
    ok: false,
    code,
    error,
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      totalBytes += buf.length;
      if (totalBytes > MAX_JSON_BODY_BYTES) {
        reject(new CollabServiceError('BAD_REQUEST', 'Request body exceeds maximum allowed size.'));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });

    req.on('end', () => {
      if (chunks.length === 0 || totalBytes === 0) {
        resolve({});
        return;
      }
      const rawText = Buffer.concat(chunks).toString('utf8').trim();
      if (!rawText) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(rawText));
      } catch {
        reject(new CollabServiceError('BAD_REQUEST', 'Malformed JSON request body.'));
      }
    });

    req.on('error', err => {
      reject(err);
    });
  });
}

function extractBearerToken(req: IncomingMessage): string {
  const authHeader = req.headers.authorization;
  if (!authHeader || typeof authHeader !== 'string') {
    throw new CollabServiceError('UNAUTHORIZED', 'Missing Authorization header.');
  }
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!match?.[1]?.trim()) {
    throw new CollabServiceError('UNAUTHORIZED', 'Expected Authorization: Bearer <token>.');
  }
  return match[1].trim();
}

export class CollabServer {
  readonly serverDb: ServerDatabase;
  readonly authService: AuthService;
  readonly roomService: RoomService;
  readonly runtimeManager: RoomRuntimeManager;
  readonly wsHandler: CollabWsHandler;
  readonly tlsBundle: TlsCertificateBundle | null;
  readonly insecureHttp: boolean;
  readonly version: string;
  readonly discoveryBroadcaster: DiscoveryBroadcaster | null;

  private readonly host: string;
  private readonly requestedPort: number;
  private httpServer: http.Server | https.Server | null = null;
  private listeningPort: number | null = null;

  constructor(options: CollabServerOptions) {
    this.host = options.host ?? '0.0.0.0';
    this.requestedPort = options.port ?? DEFAULT_SERVER_PORT;
    this.insecureHttp = options.insecureHttp ?? false;
    this.version = options.version ?? '0.6.0';

    this.serverDb = ServerDatabase.open(options.dataDir, {
      serverName: options.serverName,
      registrationMode: options.registrationMode,
      roomCreationMode: options.roomCreationMode,
      now: options.now,
    });

    if (this.insecureHttp) {
      this.tlsBundle = null;
    } else if (this.serverDb.dataDir === ':memory:') {
      this.tlsBundle = generateSelfSignedCertificate(options.tlsOptions);
    } else {
      this.tlsBundle = ensureServerTlsCertificate(this.serverDb.dataDir, options.tlsOptions);
    }

    this.authService = new AuthService(this.serverDb, {
      sessionTtlMs: options.sessionTtlMs,
      initialSetupToken: options.initialSetupToken,
      now: options.now,
    });

    this.roomService = new RoomService(this.serverDb, {
      now: options.now,
    });

    this.runtimeManager = new RoomRuntimeManager(this.serverDb, this.roomService, {
      autosaveDebounceMs: options.autosaveDebounceMs,
      autosaveMaxWaitMs: options.autosaveMaxWaitMs,
      now: options.now,
    });

    this.wsHandler = new CollabWsHandler({
      authService: this.authService,
      roomService: this.roomService,
      runtimeManager: this.runtimeManager,
    });

    this.discoveryBroadcaster =
      options.discovery === false
        ? null
        : new DiscoveryBroadcaster({
            getBeaconInfo: () => {
              const settings = this.authService.getServerSettings();
              return {
                serverId: settings.serverId,
                name: settings.name,
                version: this.version,
                host: this.host,
                port: this.getPort(),
                tls: !this.insecureHttp,
                fingerprint: this.getFingerprint(),
              };
            },
            discoveryPort: options.discoveryPort ?? DEFAULT_DISCOVERY_PORT,
            intervalMs: options.discoveryIntervalMs,
            targets: options.discoveryTargets,
          });
  }

  getPort(): number {
    if (this.listeningPort === null) {
      throw new Error('CollabServer is not currently listening.');
    }
    return this.listeningPort;
  }

  getFingerprint(): string | null {
    return this.tlsBundle?.fingerprint ?? null;
  }

  getSetupToken(): string | null {
    return this.authService.getInitialSetupToken();
  }

  getPublicInfo(): ServerPublicInfo {
    return this.authService.getPublicInfo({
      version: this.version,
      tls: !this.insecureHttp,
      fingerprint: this.getFingerprint(),
    });
  }

  getListenInfo(): CollabServerListenInfo {
    const port = this.getPort();
    const displayHost = this.host === '0.0.0.0' || this.host === '::' ? '127.0.0.1' : this.host;
    const protocol = this.insecureHttp ? 'http' : 'https';
    const wsProtocol = this.insecureHttp ? 'ws' : 'wss';
    const settings = this.authService.getServerSettings();

    return {
      host: this.host,
      port,
      protocol,
      wsProtocol,
      url: `${protocol}://${displayHost}:${port}`,
      wsUrl: `${wsProtocol}://${displayHost}:${port}`,
      tls: !this.insecureHttp,
      fingerprint: this.getFingerprint(),
      setupToken: this.getSetupToken(),
      serverId: settings.serverId,
      discoveryPort: this.discoveryBroadcaster ? this.discoveryBroadcaster.getDiscoveryPort() : null,
    };
  }

  async start(): Promise<CollabServerListenInfo> {
    if (this.httpServer) {
      return this.getListenInfo();
    }

    const requestListener = (req: IncomingMessage, res: ServerResponse) => {
      void this.handleHttpRequest(req, res);
    };

    if (this.insecureHttp || !this.tlsBundle) {
      this.httpServer = http.createServer(requestListener);
    } else {
      this.httpServer = https.createServer(
        {
          cert: this.tlsBundle.certPem,
          key: this.tlsBundle.keyPem,
        },
        requestListener,
      );
    }

    this.httpServer.on('upgrade', (req, socket, head) => {
      this.wsHandler.handleUpgrade(req, socket, head);
    });

    await new Promise<void>((resolve, reject) => {
      const server = this.httpServer!;
      const onError = (err: Error) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        const addr = server.address() as AddressInfo | null;
        this.listeningPort = addr ? addr.port : this.requestedPort;
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.requestedPort, this.host);
    });

    if (this.discoveryBroadcaster) {
      await this.discoveryBroadcaster.start();
    }

    return this.getListenInfo();
  }

  async stop(): Promise<void> {
    if (this.discoveryBroadcaster) {
      await this.discoveryBroadcaster.stop();
    }

    await this.runtimeManager.closeAll();
    this.wsHandler.closeAll();

    if (this.httpServer) {
      const server = this.httpServer;
      this.httpServer = null;
      this.listeningPort = null;
      await new Promise<void>(resolve => {
        server.close(() => resolve());
      });
    }

    this.roomService.cleanupTempDir();
    this.serverDb.close();
  }

  private authenticate(req: IncomingMessage): UserProfile {
    return this.authService.authenticateAuthorizationHeader(req.headers.authorization);
  }

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const method = (req.method ?? 'GET').toUpperCase();
      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname;

      // --- 2.1 Public & Authentication Endpoints ---

      if (method === 'GET' && pathname === '/api/server/info') {
        sendSuccess(res, this.getPublicInfo());
        return;
      }

      if (method === 'POST' && pathname === '/api/auth/setup') {
        const body = await readJsonBody(req);
        const result = this.authService.claimSetupToken(
          body as Parameters<AuthService['claimSetupToken']>[0],
        );
        sendSuccess(res, result, 201);
        return;
      }

      if (method === 'POST' && pathname === '/api/auth/register') {
        const body = await readJsonBody(req);
        const result = this.authService.registerUser(
          body as Parameters<AuthService['registerUser']>[0],
        );
        sendSuccess(res, result, 201);
        return;
      }

      if (method === 'POST' && pathname === '/api/auth/login') {
        const body = await readJsonBody(req);
        const result = this.authService.loginUser(body as Parameters<AuthService['loginUser']>[0]);
        sendSuccess(res, result, 200);
        return;
      }

      if (method === 'POST' && pathname === '/api/auth/logout') {
        const token = extractBearerToken(req);
        const result = this.authService.logoutSession(token);
        sendSuccess(res, result, 200);
        return;
      }

      if (method === 'GET' && pathname === '/api/auth/me') {
        const user = this.authenticate(req);
        sendSuccess(res, { user }, 200);
        return;
      }

      if (method === 'GET' && pathname === '/api/users/directory') {
        const user = this.authenticate(req);
        const q = url.searchParams.get('q') ?? undefined;
        const users = this.authService.searchUserDirectory(user, q);
        sendSuccess(res, { users }, 200);
        return;
      }

      // --- 2.2 Server Administration Endpoints ---

      if (method === 'PATCH' && pathname === '/api/admin/settings') {
        const user = this.authenticate(req);
        const body = await readJsonBody(req);
        const settings = this.authService.updateServerSettings(
          user,
          body as Parameters<AuthService['updateServerSettings']>[1],
        );
        sendSuccess(res, { settings }, 200);
        return;
      }

      if (method === 'GET' && pathname === '/api/admin/users') {
        const user = this.authenticate(req);
        const users = this.authService.listUsers(user);
        sendSuccess(res, { users }, 200);
        return;
      }

      if (method === 'POST' && pathname === '/api/admin/users') {
        const user = this.authenticate(req);
        const body = await readJsonBody(req);
        const created = this.authService.createUser(
          user,
          body as Parameters<AuthService['createUser']>[1],
        );
        sendSuccess(res, { user: created }, 201);
        return;
      }

      const approveUserMatch = /^\/api\/admin\/users\/([^/]+)\/approve$/.exec(pathname);
      if (method === 'POST' && approveUserMatch?.[1]) {
        const user = this.authenticate(req);
        const targetUserId = decodeURIComponent(approveUserMatch[1]);
        const updated = this.authService.approveUser(user, targetUserId);
        sendSuccess(res, { user: updated }, 200);
        return;
      }

      const resetPassMatch = /^\/api\/admin\/users\/([^/]+)\/reset-password$/.exec(pathname);
      if (method === 'POST' && resetPassMatch?.[1]) {
        const user = this.authenticate(req);
        const targetUserId = decodeURIComponent(resetPassMatch[1]);
        const body = await readJsonBody(req);
        const result = this.authService.resetPassword(
          user,
          targetUserId,
          body as Parameters<AuthService['resetPassword']>[2],
        );
        this.runtimeManager.disconnectUserFromAllRooms(
          targetUserId,
          'Your password was reset by an administrator.',
        );
        sendSuccess(res, result, 200);
        return;
      }

      const updateUserMatch = /^\/api\/admin\/users\/([^/]+)$/.exec(pathname);
      if (method === 'PATCH' && updateUserMatch?.[1]) {
        const user = this.authenticate(req);
        const targetUserId = decodeURIComponent(updateUserMatch[1]);
        const body = await readJsonBody(req);
        const updated = this.authService.updateUser(
          user,
          targetUserId,
          body as Parameters<AuthService['updateUser']>[2],
        );
        if (updated.status === 'DISABLED') {
          this.runtimeManager.disconnectUserFromAllRooms(
            targetUserId,
            'Your account has been disabled by an administrator.',
          );
        }
        sendSuccess(res, { user: updated }, 200);
        return;
      }

      if (method === 'GET' && pathname === '/api/admin/rooms') {
        const user = this.authenticate(req);
        const rooms = this.roomService.listAllRoomsAdmin(user);
        sendSuccess(res, { rooms }, 200);
        return;
      }

      const resolveRoomMatch = /^\/api\/admin\/rooms\/([^/]+)\/resolve$/.exec(pathname);
      if (method === 'POST' && resolveRoomMatch?.[1]) {
        const user = this.authenticate(req);
        const roomId = decodeURIComponent(resolveRoomMatch[1]);
        const body = await readJsonBody(req);
        const room = this.roomService.resolveStuckRoom(user, roomId, body);
        sendSuccess(res, { room }, 200);
        return;
      }

      if (method === 'GET' && pathname === '/api/admin/audit') {
        const user = this.authenticate(req);
        const rawLimit = url.searchParams.get('limit');
        const limit = rawLimit ? Number.parseInt(rawLimit, 10) : 100;
        const entries = this.authService.listServerAuditLog(
          user,
          Number.isFinite(limit) ? limit : 100,
        );
        sendSuccess(res, { entries }, 200);
        return;
      }

      // --- 2.3 Room Lobby, Membership, Invites & Join Requests Endpoints ---

      if (method === 'GET' && pathname === '/api/rooms') {
        const user = this.authenticate(req);
        const lobby = this.roomService.listRoomsForUser(user);
        sendSuccess(res, lobby, 200);
        return;
      }

      if (method === 'POST' && pathname === '/api/rooms') {
        const user = this.authenticate(req);
        const body = await readJsonBody(req);
        const room = await this.roomService.createRoom(user, body);
        sendSuccess(res, { room }, 201);
        return;
      }

      if (method === 'POST' && pathname === '/api/invites/redeem') {
        const user = this.authenticate(req);
        const body = await readJsonBody(req);
        const result = this.roomService.redeemInviteCode(user, body);
        sendSuccess(res, result, 200);
        return;
      }

      const respondInviteMatch = /^\/api\/invites\/([^/]+)\/respond$/.exec(pathname);
      if (method === 'POST' && respondInviteMatch?.[1]) {
        const user = this.authenticate(req);
        const inviteId = decodeURIComponent(respondInviteMatch[1]);
        const body = await readJsonBody(req);
        const result = this.roomService.respondToInvite(user, inviteId, body);
        sendSuccess(res, result, 200);
        return;
      }

      const roomLeaveMatch = /^\/api\/rooms\/([^/]+)\/leave$/.exec(pathname);
      if (method === 'POST' && roomLeaveMatch?.[1]) {
        const user = this.authenticate(req);
        const roomId = decodeURIComponent(roomLeaveMatch[1]);
        const result = this.roomService.leaveRoom(user, roomId);
        sendSuccess(res, result, 200);
        return;
      }

      const transferOwnerMatch = /^\/api\/rooms\/([^/]+)\/transfer-ownership$/.exec(pathname);
      if (method === 'POST' && transferOwnerMatch?.[1]) {
        const user = this.authenticate(req);
        const roomId = decodeURIComponent(transferOwnerMatch[1]);
        const body = await readJsonBody(req);
        const room = this.roomService.transferOwnership(user, roomId, body);
        sendSuccess(res, { room }, 200);
        return;
      }

      const directInviteMatch = /^\/api\/rooms\/([^/]+)\/invites$/.exec(pathname);
      if (method === 'POST' && directInviteMatch?.[1]) {
        const user = this.authenticate(req);
        const roomId = decodeURIComponent(directInviteMatch[1]);
        const body = await readJsonBody(req);
        const invite = this.roomService.createDirectInvite(user, roomId, body);
        sendSuccess(res, { invite }, 201);
        return;
      }

      const inviteCodeMatch = /^\/api\/rooms\/([^/]+)\/invite-codes$/.exec(pathname);
      if (method === 'POST' && inviteCodeMatch?.[1]) {
        const user = this.authenticate(req);
        const roomId = decodeURIComponent(inviteCodeMatch[1]);
        const body = await readJsonBody(req);
        const inviteCode = this.roomService.createInviteCode(user, roomId, body);
        sendSuccess(res, { inviteCode }, 201);
        return;
      }

      const revokeInviteMatch = /^\/api\/rooms\/([^/]+)\/invites\/([^/]+)$/.exec(pathname);
      if (method === 'DELETE' && revokeInviteMatch?.[1] && revokeInviteMatch?.[2]) {
        const user = this.authenticate(req);
        const roomId = decodeURIComponent(revokeInviteMatch[1]);
        const inviteId = decodeURIComponent(revokeInviteMatch[2]);
        const result = this.roomService.revokeInvite(user, roomId, inviteId);
        sendSuccess(res, result, 200);
        return;
      }

      const createJoinReqMatch = /^\/api\/rooms\/([^/]+)\/join-requests$/.exec(pathname);
      if (method === 'POST' && createJoinReqMatch?.[1]) {
        const user = this.authenticate(req);
        const roomId = decodeURIComponent(createJoinReqMatch[1]);
        const body = await readJsonBody(req);
        const joinRequest = this.roomService.createJoinRequest(user, roomId, body);
        sendSuccess(res, { joinRequest }, 201);
        return;
      }

      const reviewJoinReqMatch = /^\/api\/rooms\/([^/]+)\/join-requests\/([^/]+)\/review$/.exec(
        pathname,
      );
      if (method === 'POST' && reviewJoinReqMatch?.[1] && reviewJoinReqMatch?.[2]) {
        const user = this.authenticate(req);
        const roomId = decodeURIComponent(reviewJoinReqMatch[1]);
        const reqId = decodeURIComponent(reviewJoinReqMatch[2]);
        const body = await readJsonBody(req);
        const joinRequest = this.roomService.reviewJoinRequest(user, roomId, reqId, body);
        sendSuccess(res, { joinRequest }, 200);
        return;
      }

      const kickMemberMatch = /^\/api\/rooms\/([^/]+)\/members\/([^/]+)\/kick$/.exec(pathname);
      if (method === 'POST' && kickMemberMatch?.[1] && kickMemberMatch?.[2]) {
        const user = this.authenticate(req);
        const roomId = decodeURIComponent(kickMemberMatch[1]);
        const targetUserId = decodeURIComponent(kickMemberMatch[2]);
        const body = await readJsonBody(req);
        const result = this.roomService.kickMember(user, roomId, targetUserId, body);
        sendSuccess(res, result, 200);
        return;
      }

      const banMemberMatch = /^\/api\/rooms\/([^/]+)\/members\/([^/]+)\/ban$/.exec(pathname);
      if (method === 'POST' && banMemberMatch?.[1] && banMemberMatch?.[2]) {
        const user = this.authenticate(req);
        const roomId = decodeURIComponent(banMemberMatch[1]);
        const targetUserId = decodeURIComponent(banMemberMatch[2]);
        const body = await readJsonBody(req);
        const result = this.roomService.banMember(user, roomId, targetUserId, body);
        sendSuccess(res, result, 200);
        return;
      }

      const unbanMemberMatch = /^\/api\/rooms\/([^/]+)\/bans\/([^/]+)$/.exec(pathname);
      if (method === 'DELETE' && unbanMemberMatch?.[1] && unbanMemberMatch?.[2]) {
        const user = this.authenticate(req);
        const roomId = decodeURIComponent(unbanMemberMatch[1]);
        const targetUserId = decodeURIComponent(unbanMemberMatch[2]);
        const result = this.roomService.unbanMember(user, roomId, targetUserId);
        sendSuccess(res, result, 200);
        return;
      }

      const changeMemberRoleMatch = /^\/api\/rooms\/([^/]+)\/members\/([^/]+)$/.exec(pathname);
      if (method === 'PATCH' && changeMemberRoleMatch?.[1] && changeMemberRoleMatch?.[2]) {
        const user = this.authenticate(req);
        const roomId = decodeURIComponent(changeMemberRoleMatch[1]);
        const targetUserId = decodeURIComponent(changeMemberRoleMatch[2]);
        const body = await readJsonBody(req);
        const member = this.roomService.changeMemberRole(user, roomId, targetUserId, body);
        sendSuccess(res, { member }, 200);
        return;
      }

      const roomAuditMatch = /^\/api\/rooms\/([^/]+)\/audit$/.exec(pathname);
      if (method === 'GET' && roomAuditMatch?.[1]) {
        const user = this.authenticate(req);
        const roomId = decodeURIComponent(roomAuditMatch[1]);
        const rawLimit = url.searchParams.get('limit');
        const limit = rawLimit ? Number.parseInt(rawLimit, 10) : 100;
        const entries = this.roomService.listRoomAuditLog(
          user,
          roomId,
          Number.isFinite(limit) ? limit : 100,
        );
        sendSuccess(res, { entries }, 200);
        return;
      }

      const roomExportMatch = /^\/api\/rooms\/([^/]+)\/export$/.exec(pathname);
      if (method === 'GET' && roomExportMatch?.[1]) {
        const user = this.authenticate(req);
        const roomId = decodeURIComponent(roomExportMatch[1]);
        const query: Record<string, string> = {};
        const format = url.searchParams.get('format');
        const objectType = url.searchParams.get('objectType');
        const functionId = url.searchParams.get('functionId');
        if (format !== null) query.format = format;
        if (objectType !== null) query.objectType = objectType;
        if (functionId !== null) query.functionId = functionId;
        const result = await this.roomService.exportRoom(user, roomId, query);
        sendSuccess(res, result, 200);
        return;
      }

      const roomRootMatch = /^\/api\/rooms\/([^/]+)$/.exec(pathname);
      if (roomRootMatch?.[1]) {
        const user = this.authenticate(req);
        const roomId = decodeURIComponent(roomRootMatch[1]);
        if (method === 'GET') {
          const detail = await this.roomService.getRoom(user, roomId);
          sendSuccess(res, detail, 200);
          return;
        }
        if (method === 'PATCH') {
          const body = await readJsonBody(req);
          const room = this.roomService.updateRoom(user, roomId, body);
          sendSuccess(res, { room }, 200);
          return;
        }
        if (method === 'DELETE') {
          const result = this.roomService.deleteRoom(user, roomId);
          sendSuccess(res, result, 200);
          return;
        }
      }

      sendError(res, 404, 'NOT_FOUND', `Endpoint '${method} ${pathname}' not found.`);
    } catch (error) {
      if (error instanceof CollabServiceError) {
        sendError(res, error.status, error.code, error.message);
        return;
      }
      sendError(
        res,
        500,
        'INTERNAL_ERROR',
        error instanceof Error ? error.message : 'Internal server error.',
      );
    }
  }
}
