import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import { discoveryBeaconSchema } from '../shared/collab/protocol.js';
import {
  DEFAULT_DISCOVERY_PORT,
  DISCOVERY_BEACON_MAGIC,
  DISCOVERY_INTERVAL_MS,
  type DiscoveryBeacon,
} from '../shared/collab/types.js';

export const MAX_BEACON_BYTES = 512;
export const DEFAULT_BROADCAST_TARGETS = ['255.255.255.255', '127.0.0.1'] as const;

export interface DiscoveryBeaconInfo {
  serverId: string;
  name: string;
  version: string;
  host: string;
  port: number;
  tls: boolean;
  fingerprint: string | null;
}

export interface DiscoveryBroadcasterOptions {
  getBeaconInfo?: () => DiscoveryBeaconInfo;
  beaconInfo?: DiscoveryBeaconInfo;
  serverId?: string;
  name?: string;
  version?: string;
  host?: string;
  port?: number;
  tls?: boolean;
  fingerprint?: string | null;
  discoveryPort?: number;
  intervalMs?: number;
  targets?: readonly string[];
  bindAddress?: string;
  now?: () => number;
}

export function resolveAdvertiseHost(bindHost?: string): string {
  const trimmed = bindHost?.trim() ?? '';
  if (trimmed && trimmed !== '0.0.0.0' && trimmed !== '::' && trimmed !== '::0') {
    return trimmed;
  }

  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family === 'IPv4' && !entry.internal && entry.address) {
        return entry.address;
      }
    }
  }

  return '127.0.0.1';
}

export function buildDiscoveryBeacon(
  info: DiscoveryBeaconInfo,
  timestamp: number = Date.now(),
): DiscoveryBeacon {
  const host = resolveAdvertiseHost(info.host);
  const rawName = info.name.trim() || 'HLR Collaboration Server';

  const makeBeacon = (name: string): DiscoveryBeacon => ({
    magic: DISCOVERY_BEACON_MAGIC,
    serverId: info.serverId,
    name,
    version: info.version,
    host,
    port: info.port,
    tls: info.tls,
    fingerprint: info.tls ? (info.fingerprint ?? null) : null,
    timestamp: Math.max(0, Math.floor(timestamp)),
  });

  let candidate = makeBeacon(rawName);
  let encoded = Buffer.from(JSON.stringify(candidate), 'utf8');
  if (encoded.byteLength <= MAX_BEACON_BYTES) {
    return discoveryBeaconSchema.parse(candidate);
  }

  // Truncate server name if needed so the serialized UTF-8 JSON never exceeds 512 bytes
  let truncatedName = rawName;
  while (truncatedName.length > 1 && encoded.byteLength > MAX_BEACON_BYTES) {
    truncatedName = truncatedName.slice(0, Math.max(1, truncatedName.length - 8)).trimEnd() || 'S';
    candidate = makeBeacon(truncatedName);
    encoded = Buffer.from(JSON.stringify(candidate), 'utf8');
  }

  return discoveryBeaconSchema.parse(candidate);
}

export function serializeDiscoveryBeacon(beacon: DiscoveryBeacon): Buffer {
  const validated = discoveryBeaconSchema.parse(beacon);
  const buffer = Buffer.from(JSON.stringify(validated), 'utf8');
  if (buffer.byteLength > MAX_BEACON_BYTES) {
    throw new Error(
      `Discovery beacon exceeds maximum size of ${MAX_BEACON_BYTES} bytes (${buffer.byteLength} bytes).`,
    );
  }
  return buffer;
}

export class DiscoveryBroadcaster {
  private readonly getBeaconInfoFn: () => DiscoveryBeaconInfo;
  private readonly discoveryPort: number;
  private readonly intervalMs: number;
  private readonly targets: string[];
  private readonly bindAddress: string;
  private readonly now: () => number;

  private socket: dgram.Socket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private socketPort: number | null = null;

  constructor(options: DiscoveryBroadcasterOptions) {
    if (options.getBeaconInfo) {
      this.getBeaconInfoFn = options.getBeaconInfo;
    } else if (options.beaconInfo) {
      const staticInfo = options.beaconInfo;
      this.getBeaconInfoFn = () => staticInfo;
    } else if (
      options.serverId &&
      options.name &&
      options.version &&
      options.host &&
      typeof options.port === 'number' &&
      typeof options.tls === 'boolean'
    ) {
      const staticInfo: DiscoveryBeaconInfo = {
        serverId: options.serverId,
        name: options.name,
        version: options.version,
        host: options.host,
        port: options.port,
        tls: options.tls,
        fingerprint: options.fingerprint ?? null,
      };
      this.getBeaconInfoFn = () => staticInfo;
    } else {
      throw new Error(
        'DiscoveryBroadcaster requires either getBeaconInfo, beaconInfo, or complete server beacon fields.',
      );
    }

    this.discoveryPort = options.discoveryPort ?? DEFAULT_DISCOVERY_PORT;
    if (
      !Number.isInteger(this.discoveryPort) ||
      this.discoveryPort < 1 ||
      this.discoveryPort > 65535
    ) {
      throw new Error(`Invalid discovery port: ${String(this.discoveryPort)}`);
    }

    this.intervalMs = options.intervalMs ?? DISCOVERY_INTERVAL_MS;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error(`Invalid discovery interval: ${String(this.intervalMs)}`);
    }

    const rawTargets = options.targets ?? DEFAULT_BROADCAST_TARGETS;
    this.targets = Array.from(new Set(rawTargets.map(t => t.trim()).filter(Boolean)));
    if (this.targets.length === 0) {
      throw new Error('DiscoveryBroadcaster requires at least one broadcast target.');
    }

    this.bindAddress = options.bindAddress ?? '0.0.0.0';
    this.now = options.now ?? (() => Date.now());
  }

  isRunning(): boolean {
    return this.socket !== null;
  }

  getDiscoveryPort(): number {
    return this.discoveryPort;
  }

  getSocketPort(): number | null {
    return this.socketPort;
  }

  getTargets(): readonly string[] {
    return this.targets;
  }

  async start(): Promise<void> {
    if (this.socket) {
      return;
    }

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', () => {
      // Ignore background UDP socket errors on restricted interfaces
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
      socket.bind(0, this.bindAddress);
    });

    try {
      socket.setBroadcast(true);
    } catch {
      // Some restricted virtual/loopback interfaces may not support SO_BROADCAST
    }
    socket.unref();

    const addr = socket.address() as AddressInfo;
    this.socket = socket;
    this.socketPort = addr.port;

    await this.broadcastOnce();

    this.timer = setInterval(() => {
      void this.broadcastOnce();
    }, this.intervalMs);
    this.timer.unref();
  }

  createCurrentBeacon(): DiscoveryBeacon {
    const info = this.getBeaconInfoFn();
    return buildDiscoveryBeacon(info, this.now());
  }

  async broadcastOnce(): Promise<DiscoveryBeacon | null> {
    const socket = this.socket;
    if (!socket) {
      return null;
    }

    let beacon: DiscoveryBeacon;
    let payload: Buffer;
    try {
      beacon = this.createCurrentBeacon();
      payload = serializeDiscoveryBeacon(beacon);
    } catch {
      return null;
    }

    await Promise.all(
      this.targets.map(
        target =>
          new Promise<void>(resolve => {
            if (!this.socket) {
              resolve();
              return;
            }
            try {
              socket.send(payload, 0, payload.byteLength, this.discoveryPort, target, () => {
                // Ignore per-target send errors (e.g. ENETUNREACH on 255.255.255.255 when offline)
                resolve();
              });
            } catch {
              resolve();
            }
          }),
      ),
    );

    return beacon;
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    const socket = this.socket;
    this.socket = null;
    this.socketPort = null;

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
