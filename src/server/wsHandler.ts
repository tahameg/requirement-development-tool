import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { canRoomAction } from '../shared/collab/permissions.js';
import { wsClientMessageSchema } from '../shared/collab/protocol.js';
import { assignUserColor, type UserProfile, type WsServerMessage } from '../shared/collab/types.js';
import type { AuthService } from './auth.js';
import { CollabServiceError } from './errors.js';
import type { RoomRuntime, RoomRuntimeManager } from './roomRuntime.js';
import type { RoomService } from './rooms.js';

export const WS_CLOSE_UNAUTHORIZED = 4401;
export const WS_CLOSE_FORBIDDEN = 4403;
export const WS_CLOSE_NOT_FOUND = 4404;

export interface CollabWsHandlerDeps {
  authService: AuthService;
  roomService: RoomService;
  runtimeManager: RoomRuntimeManager;
}

function extractTokenFromUpgradeRequest(req: IncomingMessage, url: URL): string | null {
  const queryToken = url.searchParams.get('token');
  if (queryToken && queryToken.trim()) {
    return queryToken.trim();
  }

  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }

  return null;
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  return Buffer.from(data).toString('utf8');
}

export class CollabWsHandler {
  readonly wss: WebSocketServer;

  constructor(private readonly deps: CollabWsHandlerDeps) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 50 * 1024 * 1024 });
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const match = /^\/ws\/rooms\/([^/]+)$/.exec(url.pathname);
    if (!match?.[1]) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    let roomId: string;
    try { roomId = decodeURIComponent(match[1]); } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const token = extractTokenFromUpgradeRequest(req, url);

    this.wss.handleUpgrade(req, socket, head, ws => {
      void this.onSocketUpgraded(ws, roomId, token);
    });
  }

  private async onSocketUpgraded(
    ws: WebSocket,
    roomId: string,
    token: string | null,
  ): Promise<void> {
    let user: UserProfile;
    try {
      user = await this.deps.authService.authenticateToken(token);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unauthorized';
      ws.close(WS_CLOSE_UNAUTHORIZED, msg.slice(0, 120));
      return;
    }

    // Verify room existence, ban status, and room membership before attaching to runtime
    try {
      await this.deps.roomService.getRoomSummary(roomId, user.id);
    } catch (error) {
      if (error instanceof CollabServiceError && error.code === 'NOT_FOUND') {
        ws.close(WS_CLOSE_NOT_FOUND, error.message.slice(0, 120));
        return;
      }
      ws.close(WS_CLOSE_FORBIDDEN, 'Access denied');
      return;
    }

    if (await this.deps.roomService.isUserBanned(roomId, user.id)) {
      ws.close(WS_CLOSE_FORBIDDEN, 'You are banned from this room.');
      return;
    }

    const role = await this.deps.roomService.getMemberRole(roomId, user.id);
    if (!canRoomAction(role, 'room:connect-ws', { isBanned: false }) || role === null) {
      ws.close(WS_CLOSE_FORBIDDEN, 'You are not a member of this room.');
      return;
    }

    const connectionId = `conn_${randomUUID()}`;
    const bufferedMessages: RawData[] = [];
    let isReady = false;
    let isClosed = false;
    let runtime: RoomRuntime | null = null;
    let messageQueue: Promise<void> = Promise.resolve();

    const sendServerMessage = (message: WsServerMessage): void => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    };

    const closeSocket = (code = 1000, reason = ''): void => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(code, reason.slice(0, 120));
      }
    };

    const enqueueFrame = (rawData: RawData): void => {
      messageQueue = messageQueue
        .then(async () => {
          if (isClosed || !runtime) {
            return;
          }
          await this.processClientMessage(runtime, connectionId, rawData, sendServerMessage);
        })
        .catch(error => sendServerMessage({ type: 'error', code: error instanceof CollabServiceError ? error.code : 'INTERNAL_ERROR', message: error instanceof Error ? error.message : 'Request failed' }));
    };

    ws.on('message', (data: RawData) => {
      if (!isReady) {
        if (bufferedMessages.length >= 100) { ws.close(1009, 'Too many pending messages'); return; }
        bufferedMessages.push(data);
        return;
      }
      enqueueFrame(data);
    });

    ws.on('close', () => {
      isClosed = true;
      if (runtime) {
        runtime.removeClient(connectionId);
      }
    });

    ws.on('error', () => {
      isClosed = true;
      if (runtime) {
        runtime.removeClient(connectionId);
      }
    });

    try {
      runtime = await this.deps.runtimeManager.getOrCreateRoomRuntime(roomId);
      if (isClosed || ws.readyState !== WebSocket.OPEN) {
        return;
      }

      runtime.addClient({
        connectionId,
        sessionId: createHash('sha256').update(token!).digest('hex'),
        user,
        role,
        color: assignUserColor(user.id),
        presence: null,
        send: sendServerMessage,
        close: closeSocket,
      });

      isReady = true;
      for (const buffered of bufferedMessages.splice(0, bufferedMessages.length)) {
        enqueueFrame(buffered);
      }
    } catch (error) {
      const code =
        error instanceof CollabServiceError && error.code === 'NOT_FOUND'
          ? WS_CLOSE_NOT_FOUND
          : WS_CLOSE_FORBIDDEN;
      const reason = error instanceof Error ? error.message : 'Failed to join room';
      closeSocket(code, reason);
    }
  }

  private async processClientMessage(
    runtime: RoomRuntime,
    connectionId: string,
    rawData: RawData,
    sendServerMessage: (message: WsServerMessage) => void,
  ): Promise<void> {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawDataToString(rawData));
    } catch {
      sendServerMessage({
        type: 'error',
        code: 'BAD_REQUEST',
        message: 'WebSocket frame must be valid UTF-8 JSON.',
      });
      return;
    }

    const validated = wsClientMessageSchema.safeParse(parsedJson);
    if (!validated.success) {
      sendServerMessage({
        type: 'error',
        code: 'BAD_REQUEST',
        message: validated.error.issues[0]?.message ?? 'Invalid WebSocket message schema.',
      });
      return;
    }

    const msg = validated.data;
    try { switch (msg.type) {
      case 'op':
        await runtime.handleOp(connectionId, msg.op);
        break;

      case 'ops-since':
        await runtime.handleOpsSince(connectionId, msg.seq);
        break;

      case 'lock-acquire':
        await runtime.handleLockAcquire(connectionId, msg.key);
        break;

      case 'lock-release':
        await runtime.handleLockRelease(connectionId, msg.key);
        break;

      case 'lock-heartbeat':
        await runtime.handleLockHeartbeat(connectionId, msg.key);
        break;

      case 'lock-force-release':
        await runtime.handleLockForceRelease(connectionId, msg.key);
        break;

      case 'presence-update':
        runtime.handlePresenceUpdate(connectionId, {
          view: msg.view,
          focus: msg.focus,
          drafting: msg.drafting,
        });
        break;

      case 'ping':
        sendServerMessage({
          type: 'pong',
          timestamp: msg.timestamp,
        });
        break;
    }    } catch (error) {
      sendServerMessage({ type: 'error', code: error instanceof CollabServiceError ? error.code : 'INTERNAL_ERROR', message: error instanceof Error ? error.message : 'Request failed', ...('key' in msg ? { requestId: `lock:${msg.key}` } : {}) });
    }

  }

  closeAll(): void {
    for (const client of this.wss.clients) {
      try {
        client.close(1001, 'Server shutting down');
      } catch {
        // Ignore close error
      }
    }
    this.wss.close();
  }
}

export function createCollabWsHandler(deps: CollabWsHandlerDeps): CollabWsHandler {
  return new CollabWsHandler(deps);
}
