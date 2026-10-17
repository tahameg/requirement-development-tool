import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DiscoveryClient } from '../../src/main/collab/discoveryClient.js';
import {
  CollabServer,
  DiscoveryBroadcaster,
  buildDiscoveryBeacon,
  formatServerHelpText,
  parseServerCliArgs,
  resolveAdvertiseHost,
  serializeDiscoveryBeacon,
} from '../../src/server/index.js';
import { discoveryBeaconSchema } from '../../src/shared/collab/protocol.js';
import {
  DEFAULT_DISCOVERY_PORT,
  DISCOVERY_BEACON_MAGIC,
  type DiscoveredServer,
  type DiscoveryBeacon,
} from '../../src/shared/collab/types.js';

describe('T06: DiscoveryBroadcaster and DiscoveryClient (UDP LAN Discovery)', () => {
  const activeClients: DiscoveryClient[] = [];
  const activeBroadcasters: DiscoveryBroadcaster[] = [];
  const activeServers: CollabServer[] = [];
  const tempDirs: string[] = [];

  function createTempDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hlr-discovery-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    while (activeBroadcasters.length > 0) {
      const b = activeBroadcasters.pop()!;
      await b.stop();
    }
    while (activeClients.length > 0) {
      const c = activeClients.pop()!;
      await c.stop();
    }
    while (activeServers.length > 0) {
      const s = activeServers.pop()!;
      await s.stop();
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('Beacon Building, Serialization, and Host Resolution', () => {
    it('resolves advertised host correctly for bindHost 0.0.0.0 and explicit hosts', () => {
      const explicit = resolveAdvertiseHost('192.168.1.100');
      expect(explicit).toBe('192.168.1.100');

      const loopbackExplicit = resolveAdvertiseHost('127.0.0.1');
      expect(loopbackExplicit).toBe('127.0.0.1');

      const resolvedAny = resolveAdvertiseHost('0.0.0.0');
      expect(typeof resolvedAny).toBe('string');
      expect(resolvedAny.length).toBeGreaterThan(0);
      expect(resolvedAny).not.toBe('0.0.0.0');

      const resolvedEmpty = resolveAdvertiseHost('');
      expect(resolvedEmpty).not.toBe('');
    });

    it('builds a valid beacon and serializes to JSON within size limits', () => {
      const beacon = buildDiscoveryBeacon(
        {
          serverId: 'srv_12345',
          name: 'Avionics Server',
          version: '0.6.0',
          host: '127.0.0.1',
          port: 8443,
          tls: true,
          fingerprint: 'SHA256:4F:8A:12:34:56:78:90:AB:CD:EF:12:34:56:78:90:AB:CD:EF:12:34:56:78:90:AB:CD:EF:12:34:56:78:90:AB',
        },
        1700000000000,
      );

      expect(beacon.magic).toBe(DISCOVERY_BEACON_MAGIC);
      expect(beacon.serverId).toBe('srv_12345');
      expect(beacon.name).toBe('Avionics Server');
      expect(beacon.version).toBe('0.6.0');
      expect(beacon.port).toBe(8443);
      expect(beacon.tls).toBe(true);
      expect(beacon.fingerprint).toMatch(/^SHA256:/);
      expect(beacon.timestamp).toBe(1700000000000);

      const buffer = serializeDiscoveryBeacon(beacon);
      expect(buffer.byteLength).toBeLessThanOrEqual(512);

      const parsed = JSON.parse(buffer.toString('utf8'));
      const validated = discoveryBeaconSchema.parse(parsed);
      expect(validated.serverId).toBe('srv_12345');
    });

    it('truncates very long server names to strictly enforce 512-byte size limit', () => {
      const longName = 'A'.repeat(800);
      const beacon = buildDiscoveryBeacon(
        {
          serverId: 'srv_large_name',
          name: longName,
          version: '0.6.0',
          host: '127.0.0.1',
          port: 8443,
          tls: false,
          fingerprint: null,
        },
        Date.now(),
      );

      const buffer = serializeDiscoveryBeacon(beacon);
      expect(buffer.byteLength).toBeLessThanOrEqual(512);
      expect(beacon.name.length).toBeLessThan(longName.length);
    });

    it('enforces fingerprint is null when TLS is disabled', () => {
      const beacon = buildDiscoveryBeacon({
        serverId: 'srv_plain',
        name: 'Plain Server',
        version: '0.6.0',
        host: '127.0.0.1',
        port: 8080,
        tls: false,
        fingerprint: 'SHA256:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF',
      });

      expect(beacon.tls).toBe(false);
      expect(beacon.fingerprint).toBeNull();
    });
  });

  describe('DiscoveryClient Packet Ingestion & Validation', () => {
    it('ingests valid beacon and ignores malformed, oversized, or invalid-magic packets', () => {
      const client = new DiscoveryClient({ port: 0 });

      // Valid packet
      const validBeacon: DiscoveryBeacon = {
        magic: DISCOVERY_BEACON_MAGIC,
        serverId: 'srv_alpha',
        name: 'Alpha Server',
        version: '0.6.0',
        host: '192.168.1.50',
        port: 8443,
        tls: true,
        fingerprint: 'SHA256:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
        timestamp: 1700000000000,
      };
      const result = client.handlePacket(Buffer.from(JSON.stringify(validBeacon), 'utf8'));
      expect(result).not.toBeNull();
      expect(result?.serverId).toBe('srv_alpha');
      expect(client.getServers().length).toBe(1);

      // Malformed JSON
      expect(client.handlePacket('NOT_JSON_DATA')).toBeNull();

      // Oversized packet (> 1024 bytes)
      const oversized = Buffer.alloc(1025, 'a');
      expect(client.handlePacket(oversized)).toBeNull();

      // Wrong magic string
      const wrongMagic = { ...validBeacon, magic: 'WRONG_MAGIC_V2' };
      expect(client.handlePacket(JSON.stringify(wrongMagic))).toBeNull();

      // Missing required field (port missing)
      const missingPort = { ...validBeacon, port: undefined };
      expect(client.handlePacket(JSON.stringify(missingPort))).toBeNull();

      // Invalid port range (0 or > 65535)
      const invalidPort = { ...validBeacon, port: 999999 };
      expect(client.handlePacket(JSON.stringify(invalidPort))).toBeNull();

      // Still only 1 server registered
      expect(client.getServers().length).toBe(1);
    });

    it('falls back to remote socket address when host is 0.0.0.0 or 127.0.0.1 on LAN', () => {
      const client = new DiscoveryClient({ port: 0 });

      const beacon: DiscoveryBeacon = {
        magic: DISCOVERY_BEACON_MAGIC,
        serverId: 'srv_lan',
        name: 'LAN Server',
        version: '0.6.0',
        host: '0.0.0.0',
        port: 8443,
        tls: false,
        fingerprint: null,
        timestamp: Date.now(),
      };

      const result = client.handlePacket(Buffer.from(JSON.stringify(beacon)), {
        address: '192.168.1.120',
        port: 41234,
      });

      expect(result?.host).toBe('192.168.1.120');
    });
  });

  describe('UDP Broadcast and Reception Over Ephemeral Port', () => {
    it('broadcasts and receives beacons over localhost on an ephemeral port', async () => {
      // 1. Start DiscoveryClient on ephemeral port 0
      const client = new DiscoveryClient({ port: 0, pruneIntervalMs: 0 });
      await client.start();
      activeClients.push(client);

      const clientPort = client.getPort();
      expect(clientPort).toBeGreaterThan(0);
      expect(client.isRunning()).toBe(true);

      const discoveredEvents: DiscoveredServer[] = [];
      const changeEvents: DiscoveredServer[][] = [];

      client.on('server-discovered', s => discoveredEvents.push(s));
      client.on('servers', list => changeEvents.push(list));

      // 2. Start DiscoveryBroadcaster configured to send to the client's ephemeral port on 127.0.0.1
      let serverName = 'Avionics HLR System';
      const broadcaster = new DiscoveryBroadcaster({
        serverId: 'srv_ephemeral_1',
        name: serverName,
        version: '0.6.0',
        host: '127.0.0.1',
        port: 8443,
        tls: true,
        fingerprint: 'SHA256:11:22:33:44:55:66:77:88:99:00:AA:BB:CC:DD:EE:FF:11:22:33:44:55:66:77:88:99:00:AA:BB:CC:DD:EE:FF',
        discoveryPort: clientPort,
        targets: ['127.0.0.1'],
        intervalMs: 100, // fast interval for test
      });

      await broadcaster.start();
      activeBroadcasters.push(broadcaster);
      expect(broadcaster.isRunning()).toBe(true);
      expect(broadcaster.getDiscoveryPort()).toBe(clientPort);

      // Wait for client to receive beacon
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout waiting for discovery beacon')), 2000);
        const check = () => {
          if (client.getServers().length > 0) {
            clearTimeout(timeout);
            resolve();
          } else {
            setTimeout(check, 20);
          }
        };
        check();
      });

      const servers = client.getServers();
      expect(servers.length).toBe(1);
      const s = servers[0]!;
      expect(s.serverId).toBe('srv_ephemeral_1');
      expect(s.name).toBe('Avionics HLR System');
      expect(s.version).toBe('0.6.0');
      expect(s.host).toBe('127.0.0.1');
      expect(s.port).toBe(8443);
      expect(s.tls).toBe(true);
      expect(s.fingerprint).toMatch(/^SHA256:/);
      expect(s.online).toBe(true);

      expect(discoveredEvents.length).toBe(1);
      expect(changeEvents.length).toBeGreaterThanOrEqual(1);

      // 3. Test update event
      const updatedEvents: DiscoveredServer[] = [];
      client.on('server-updated', u => updatedEvents.push(u));

      // Trigger another broadcast
      await broadcaster.broadcastOnce();

      await new Promise<void>(resolve => setTimeout(resolve, 50));
      expect(updatedEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('allows multiple DiscoveryClient instances to bind to the same UDP port with reuseAddr without EADDRINUSE', async () => {
      const client1 = new DiscoveryClient({ port: 0, pruneIntervalMs: 0 });
      await client1.start();
      activeClients.push(client1);

      const sharedPort = client1.getPort();
      expect(sharedPort).toBeGreaterThan(0);

      // Second client binds to the exact same port using reuseAddr without throwing EADDRINUSE
      const client2 = new DiscoveryClient({ port: sharedPort, pruneIntervalMs: 0 });
      await client2.start();
      activeClients.push(client2);

      expect(client2.getPort()).toBe(sharedPort);
      expect(client1.isRunning()).toBe(true);
      expect(client2.isRunning()).toBe(true);
    });
  });

  describe('Deduplication and Multi-Server Management', () => {
    it('deduplicates multiple beacons from the same server and tracks distinct servers', () => {
      let currentTime = 1000;
      const client = new DiscoveryClient({
        port: 0,
        now: () => currentTime,
      });

      // Server A beacon 1
      client.handlePacket(
        JSON.stringify({
          magic: DISCOVERY_BEACON_MAGIC,
          serverId: 'srv_A',
          name: 'Server A',
          version: '0.6.0',
          host: '192.168.1.10',
          port: 8443,
          tls: true,
          fingerprint: 'SHA256:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF',
          timestamp: currentTime,
        }),
      );

      // Server B beacon 1
      client.handlePacket(
        JSON.stringify({
          magic: DISCOVERY_BEACON_MAGIC,
          serverId: 'srv_B',
          name: 'Server B',
          version: '0.6.0',
          host: '192.168.1.20',
          port: 9443,
          tls: false,
          fingerprint: null,
          timestamp: currentTime,
        }),
      );

      expect(client.getServers().length).toBe(2);

      // Server A beacon 2 (updated name)
      currentTime = 2000;
      client.handlePacket(
        JSON.stringify({
          magic: DISCOVERY_BEACON_MAGIC,
          serverId: 'srv_A',
          name: 'Server A (Renamed)',
          version: '0.6.1',
          host: '192.168.1.10',
          port: 8443,
          tls: true,
          fingerprint: 'SHA256:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF',
          timestamp: currentTime,
        }),
      );

      // Still 2 servers (deduplicated by serverId)
      const servers = client.getServers();
      expect(servers.length).toBe(2);

      const serverA = client.getServer('srv_A');
      expect(serverA?.name).toBe('Server A (Renamed)');
      expect(serverA?.version).toBe('0.6.1');
      expect(serverA?.lastSeenAt).toBe(2000);

      const serverB = client.getServer('srv_B');
      expect(serverB?.name).toBe('Server B');
      expect(serverB?.lastSeenAt).toBe(1000);
    });

    it('supports removeServer, clear, and onServersChange unsubscribe', () => {
      const client = new DiscoveryClient({ port: 0 });

      let notificationCount = 0;
      const unsubscribe = client.onServersChange(() => {
        notificationCount += 1;
      });

      client.handlePacket(
        JSON.stringify({
          magic: DISCOVERY_BEACON_MAGIC,
          serverId: 'srv_to_remove',
          name: 'Temporary Server',
          version: '0.6.0',
          host: '127.0.0.1',
          port: 8443,
          tls: false,
          fingerprint: null,
          timestamp: Date.now(),
        }),
      );

      expect(client.getServers().length).toBe(1);
      expect(notificationCount).toBe(1);

      // Remove specific server
      const removed = client.removeServer('srv_to_remove');
      expect(removed).toBe(true);
      expect(client.getServers().length).toBe(0);
      expect(notificationCount).toBe(2);

      // Remove non-existent server
      expect(client.removeServer('does_not_exist')).toBe(false);

      // Add server and clear all
      client.handlePacket(
        JSON.stringify({
          magic: DISCOVERY_BEACON_MAGIC,
          serverId: 'srv_1',
          name: 'Server 1',
          version: '0.6.0',
          host: '127.0.0.1',
          port: 8443,
          tls: false,
          fingerprint: null,
          timestamp: Date.now(),
        }),
      );
      expect(client.getServers().length).toBe(1);

      client.clear();
      expect(client.getServers().length).toBe(0);

      // Unsubscribe
      unsubscribe();
      const prevCount = notificationCount;
      client.handlePacket(
        JSON.stringify({
          magic: DISCOVERY_BEACON_MAGIC,
          serverId: 'srv_2',
          name: 'Server 2',
          version: '0.6.0',
          host: '127.0.0.1',
          port: 8443,
          tls: false,
          fingerprint: null,
          timestamp: Date.now(),
        }),
      );
      expect(notificationCount).toBe(prevCount);
    });
  });

  describe('Stale Server Expiration and Re-activation', () => {
    it('marks servers offline after stale timeout and revives them when seen again', () => {
      let currentTime = 10000;
      const client = new DiscoveryClient({
        port: 0,
        staleThresholdMs: 10000, // 10 seconds
        pruneIntervalMs: 0, // manual check
        now: () => currentTime,
      });

      const staleEvents: DiscoveredServer[] = [];
      client.on('server-stale', s => staleEvents.push(s));

      client.handlePacket(
        JSON.stringify({
          magic: DISCOVERY_BEACON_MAGIC,
          serverId: 'srv_stale_test',
          name: 'Stale Test Server',
          version: '0.6.0',
          host: '127.0.0.1',
          port: 8443,
          tls: false,
          fingerprint: null,
          timestamp: currentTime,
        }),
      );

      expect(client.getServers()[0]?.online).toBe(true);

      // Advance time by 5 seconds (not stale yet)
      currentTime = 15000;
      expect(client.checkStale()).toBe(false);
      expect(client.getServers()[0]?.online).toBe(true);

      // Advance time past 10 seconds (stale threshold)
      currentTime = 20001;
      expect(client.checkStale()).toBe(true);
      expect(staleEvents.length).toBe(1);
      expect(staleEvents[0]?.serverId).toBe('srv_stale_test');

      const serverAfterTimeout = client.getServer('srv_stale_test');
      expect(serverAfterTimeout?.online).toBe(false);

      // getServers returns it marked offline
      const servers = client.getServers();
      expect(servers[0]?.online).toBe(false);

      // Revive server with fresh beacon
      currentTime = 25000;
      client.handlePacket(
        JSON.stringify({
          magic: DISCOVERY_BEACON_MAGIC,
          serverId: 'srv_stale_test',
          name: 'Stale Test Server',
          version: '0.6.0',
          host: '127.0.0.1',
          port: 8443,
          tls: false,
          fingerprint: null,
          timestamp: currentTime,
        }),
      );

      const revived = client.getServer('srv_stale_test');
      expect(revived?.online).toBe(true);
      expect(revived?.lastSeenAt).toBe(25000);
    });
  });

  describe('CollabServer Integration with DiscoveryBroadcaster', () => {
    it('integrates DiscoveryBroadcaster directly into CollabServer lifecycle', async () => {
      // 1. Start discovery listener on ephemeral port
      const client = new DiscoveryClient({ port: 0, pruneIntervalMs: 0 });
      await client.start();
      activeClients.push(client);

      const discoveryPort = client.getPort();

      // 2. Start CollabServer with discovery targeting the client port
      const dataDir = createTempDir();
      const server = new CollabServer({
        dataDir,
        host: '127.0.0.1',
        port: 0,
        serverName: 'CollabServer With Discovery',
        discovery: true,
        discoveryPort,
        discoveryTargets: ['127.0.0.1'],
        discoveryIntervalMs: 100,
      });

      const listenInfo = await server.start();
      activeServers.push(server);

      expect(listenInfo.discoveryPort).toBe(discoveryPort);
      expect(server.discoveryBroadcaster).not.toBeNull();
      expect(server.discoveryBroadcaster?.isRunning()).toBe(true);

      // Wait for client to receive beacon from CollabServer
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout waiting for CollabServer beacon')), 2500);
        const check = () => {
          if (client.getServers().length > 0) {
            clearTimeout(timeout);
            resolve();
          } else {
            setTimeout(check, 25);
          }
        };
        check();
      });

      const servers = client.getServers();
      expect(servers.length).toBe(1);
      const serverRecord = servers[0]!;
      expect(serverRecord.serverId).toBe(listenInfo.serverId);
      expect(serverRecord.name).toBe('CollabServer With Discovery');
      expect(serverRecord.port).toBe(listenInfo.port);
      expect(serverRecord.tls).toBe(true);
      expect(serverRecord.fingerprint).toBe(listenInfo.fingerprint);
      expect(serverRecord.online).toBe(true);

      // Stop CollabServer and verify broadcaster stops
      await server.stop();
      expect(server.discoveryBroadcaster?.isRunning()).toBe(false);
    });

    it('supports disabling discovery via discovery: false', async () => {
      const dataDir = createTempDir();
      const server = new CollabServer({
        dataDir,
        host: '127.0.0.1',
        port: 0,
        serverName: 'No Discovery Server',
        discovery: false,
      });

      const info = await server.start();
      activeServers.push(server);

      expect(info.discoveryPort).toBeNull();
      expect(server.discoveryBroadcaster).toBeNull();

      await server.stop();
    });
  });

  describe('CLI Arguments and Flags', () => {
    it('parses --discovery-port and --no-discovery flags correctly', () => {
      const parsed = parseServerCliArgs(
        ['--discovery-port', '49123', '--no-discovery'],
        {},
      );
      expect(parsed.discoveryPort).toBe(49123);
      expect(parsed.discovery).toBe(false);

      const parsedEq = parseServerCliArgs(
        ['--discovery-port=49999'],
        {},
      );
      expect(parsedEq.discoveryPort).toBe(49999);
      expect(parsedEq.discovery).toBe(true);
    });

    it('parses HLR_SERVER_DISCOVERY_PORT and HLR_SERVER_NO_DISCOVERY env vars', () => {
      const parsed = parseServerCliArgs([], {
        HLR_SERVER_DISCOVERY_PORT: '48000',
        HLR_SERVER_NO_DISCOVERY: '1',
      });
      expect(parsed.discoveryPort).toBe(48000);
      expect(parsed.discovery).toBe(false);
    });

    it('rejects invalid discovery port numbers in CLI arguments', () => {
      expect(() => parseServerCliArgs(['--discovery-port=0'], {})).toThrow('Invalid discovery port');
      expect(() => parseServerCliArgs(['--discovery-port=70000'], {})).toThrow('Invalid discovery port');
    });

    it('includes discovery options in help text', () => {
      const help = formatServerHelpText();
      expect(help).toContain('--discovery-port');
      expect(help).toContain('--no-discovery');
    });
  });

  describe('Options Validation and Lifecycle Edge Cases', () => {
    it('validates DiscoveryClient options and lifecycle', async () => {
      expect(() => new DiscoveryClient({ port: -1 })).toThrow('Invalid discovery listener port');
      expect(() => new DiscoveryClient({ port: 70000 })).toThrow('Invalid discovery listener port');
      expect(() => new DiscoveryClient({ staleThresholdMs: 0 })).toThrow('Invalid stale threshold');
      expect(() => new DiscoveryClient({ staleThresholdMs: -500 })).toThrow('Invalid stale threshold');

      const client = new DiscoveryClient({ port: 0 });
      expect(() => client.getPort()).toThrow('DiscoveryClient is not currently listening');
      expect(client.isRunning()).toBe(false);

      await client.stop(); // Safe no-op when not running

      await client.start();
      expect(client.isRunning()).toBe(true);
      const port = client.getPort();

      await client.start(); // Safe no-op when already running
      expect(client.getPort()).toBe(port);

      await client.stop();
      expect(client.isRunning()).toBe(false);
    });

    it('validates DiscoveryBroadcaster options and lifecycle', async () => {
      expect(() => new DiscoveryBroadcaster({})).toThrow('DiscoveryBroadcaster requires either');
      expect(
        () =>
          new DiscoveryBroadcaster({
            serverId: 's1',
            name: 'N',
            version: '1',
            host: '127.0.0.1',
            port: 8443,
            tls: true,
            discoveryPort: 0,
          }),
      ).toThrow('Invalid discovery port');
      expect(
        () =>
          new DiscoveryBroadcaster({
            serverId: 's1',
            name: 'N',
            version: '1',
            host: '127.0.0.1',
            port: 8443,
            tls: true,
            discoveryPort: 70000,
          }),
      ).toThrow('Invalid discovery port');
      expect(
        () =>
          new DiscoveryBroadcaster({
            serverId: 's1',
            name: 'N',
            version: '1',
            host: '127.0.0.1',
            port: 8443,
            tls: true,
            intervalMs: 0,
          }),
      ).toThrow('Invalid discovery interval');
      expect(
        () =>
          new DiscoveryBroadcaster({
            serverId: 's1',
            name: 'N',
            version: '1',
            host: '127.0.0.1',
            port: 8443,
            tls: true,
            targets: [],
          }),
      ).toThrow('DiscoveryBroadcaster requires at least one broadcast target');

      // Test with static beaconInfo
      const broadcaster = new DiscoveryBroadcaster({
        beaconInfo: {
          serverId: 'srv_static',
          name: 'Static Beacon Server',
          version: '0.6.0',
          host: '127.0.0.1',
          port: 8443,
          tls: false,
          fingerprint: null,
        },
      });

      expect(broadcaster.isRunning()).toBe(false);
      expect(await broadcaster.broadcastOnce()).toBeNull();
      expect(broadcaster.getTargets().length).toBeGreaterThan(0);

      await broadcaster.stop();

      await broadcaster.start();
      expect(broadcaster.isRunning()).toBe(true);
      expect(broadcaster.getSocketPort()).toBeGreaterThan(0);

      await broadcaster.start();

      const beacon = broadcaster.createCurrentBeacon();
      expect(beacon.serverId).toBe('srv_static');

      await broadcaster.stop();
      expect(broadcaster.isRunning()).toBe(false);
    });
  });
});
