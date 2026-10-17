import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { discoveryBeaconSchema } from '../../shared/collab/protocol.js';
import {
  DEFAULT_DISCOVERY_PORT,
  DISCOVERY_STALE_MS,
  type DiscoveredServer,
  type DiscoveryBeacon,
} from '../../shared/collab/types.js';

export interface DiscoveryClientOptions {
  port?: number;
  bindAddress?: string;
  staleThresholdMs?: number;
  pruneIntervalMs?: number;
  now?: () => number;
  onServersChange?: (servers: DiscoveredServer[]) => void;
}

export interface DiscoveryClientEvents {
  servers: (servers: DiscoveredServer[]) => void;
  'server-discovered': (server: DiscoveredServer) => void;
  'server-updated': (server: DiscoveredServer) => void;
  'server-stale': (server: DiscoveredServer) => void;
  error: (err: Error) => void;
}

export class DiscoveryClient extends EventEmitter {
  private readonly requestedPort: number;
  private readonly bindAddress: string;
  private readonly staleThresholdMs: number;
  private readonly pruneIntervalMs: number;
  private readonly now: () => number;

  private readonly servers = new Map<string, DiscoveredServer>();
  private socket: dgram.Socket | null = null;
  private boundPort: number | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: DiscoveryClientOptions = {}) {
    super();

    this.requestedPort = options.port ?? DEFAULT_DISCOVERY_PORT;
    if (
      !Number.isInteger(this.requestedPort) ||
      this.requestedPort < 0 ||
      this.requestedPort > 65535
    ) {
      throw new Error(`Invalid discovery listener port: ${String(this.requestedPort)}`);
    }

    this.bindAddress = options.bindAddress ?? '0.0.0.0';
    this.staleThresholdMs = options.staleThresholdMs ?? DISCOVERY_STALE_MS;
    if (!Number.isFinite(this.staleThresholdMs) || this.staleThresholdMs <= 0) {
      throw new Error(`Invalid stale threshold: ${String(this.staleThresholdMs)}`);
    }

    this.pruneIntervalMs = options.pruneIntervalMs ?? 1000;
    this.now = options.now ?? (() => Date.now());

    if (options.onServersChange) {
      this.on('servers', options.onServersChange);
    }
  }

  isRunning(): boolean {
    return this.socket !== null;
  }

  getPort(): number {
    if (this.boundPort === null) {
      throw new Error('DiscoveryClient is not currently listening.');
    }
    return this.boundPort;
  }

  getStaleThresholdMs(): number {
    return this.staleThresholdMs;
  }

  async start(): Promise<void> {
    if (this.socket) {
      return;
    }

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    socket.on('error', err => {
      this.emit('error', err);
    });

    socket.on('message', (msg, rinfo) => {
      this.handlePacket(msg, rinfo);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        socket.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        socket.off('error', onError);
        resolve();
      };
      socket.once('error', onError);
      socket.once('listening', onListening);
      socket.bind(this.requestedPort, this.bindAddress);
    });

    try {
      socket.setBroadcast(true);
    } catch {
      // Ignore broadcast option errors if not supported by the interface
    }

    const addr = socket.address() as AddressInfo;
    this.socket = socket;
    this.boundPort = addr.port;
    this.socket.unref();

    if (this.pruneIntervalMs > 0) {
      this.pruneTimer = setInterval(() => {
        this.checkStale();
      }, this.pruneIntervalMs);
      this.pruneTimer.unref();
    }
  }

  handlePacket(
    msg: Buffer | string,
    rinfo?: { address?: string; port?: number },
  ): DiscoveredServer | null {
    const rawBuffer = Buffer.isBuffer(msg) ? msg : Buffer.from(msg, 'utf8');
    if (rawBuffer.byteLength > 1024) {
      return null;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBuffer.toString('utf8'));
    } catch {
      return null;
    }

    const parseResult = discoveryBeaconSchema.safeParse(parsedJson);
    if (!parseResult.success) {
      return null;
    }

    const beacon = parseResult.data;
    return this.recordBeacon(beacon, rinfo?.address);
  }

  private recordBeacon(beacon: DiscoveryBeacon, remoteAddress?: string): DiscoveredServer {
    const now = this.now();
    let host = beacon.host.trim();
    if (
      (host === '0.0.0.0' || host === '::' || host === '127.0.0.1') &&
      remoteAddress &&
      remoteAddress !== '127.0.0.1' &&
      remoteAddress !== '::1'
    ) {
      host = remoteAddress;
    }

    const existing = this.servers.get(beacon.serverId);
    const isNew = !existing;

    const server: DiscoveredServer = {
      serverId: beacon.serverId,
      name: beacon.name,
      version: beacon.version,
      host,
      port: beacon.port,
      tls: beacon.tls,
      fingerprint: beacon.fingerprint,
      lastSeenAt: now,
      online: true,
    };

    this.servers.set(beacon.serverId, server);

    if (isNew) {
      this.emit('server-discovered', { ...server });
    } else {
      this.emit('server-updated', { ...server });
    }

    this.emitChange();
    return { ...server };
  }

  getServers(): DiscoveredServer[] {
    const now = this.now();
    const result: DiscoveredServer[] = [];

    for (const server of this.servers.values()) {
      const isOnline = now - server.lastSeenAt < this.staleThresholdMs;
      if (server.online !== isOnline) {
        server.online = isOnline;
      }
      result.push({ ...server });
    }

    return result.sort((a, b) => {
      if (a.online !== b.online) {
        return a.online ? -1 : 1;
      }
      if (b.lastSeenAt !== a.lastSeenAt) {
        return b.lastSeenAt - a.lastSeenAt;
      }
      return a.name.localeCompare(b.name);
    });
  }

  getServer(serverId: string): DiscoveredServer | undefined {
    const server = this.servers.get(serverId);
    if (!server) {
      return undefined;
    }
    const now = this.now();
    server.online = now - server.lastSeenAt < this.staleThresholdMs;
    return { ...server };
  }

  checkStale(): boolean {
    const now = this.now();
    let changed = false;

    for (const server of this.servers.values()) {
      const isOnline = now - server.lastSeenAt < this.staleThresholdMs;
      if (server.online !== isOnline) {
        server.online = isOnline;
        changed = true;
        if (!isOnline) {
          this.emit('server-stale', { ...server });
        }
      }
    }

    if (changed) {
      this.emitChange();
    }

    return changed;
  }

  onServersChange(listener: (servers: DiscoveredServer[]) => void): () => void {
    this.on('servers', listener);
    return () => {
      this.off('servers', listener);
    };
  }

  clear(): void {
    if (this.servers.size > 0) {
      this.servers.clear();
      this.emitChange();
    }
  }

  removeServer(serverId: string): boolean {
    const deleted = this.servers.delete(serverId);
    if (deleted) {
      this.emitChange();
    }
    return deleted;
  }

  private emitChange(): void {
    this.emit('servers', this.getServers());
  }

  async stop(): Promise<void> {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }

    const socket = this.socket;
    this.socket = null;
    this.boundPort = null;

    if (!socket) {
      return;
    }

    await new Promise<void>(resolve => {
      try {
        socket.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }
}
