import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_DISCOVERY_PORT,
  DEFAULT_SERVER_PORT,
  REGISTRATION_MODES,
  ROOM_CREATION_MODES,
  type RegistrationMode,
  type RoomCreationMode,
} from '../shared/collab/types.js';
import { CollabServer, type CollabServerOptions } from './httpServer.js';

export { AuthService, CollabServiceError } from './auth.js';
export { CollabServiceError as ServiceError } from './errors.js';
export * from './store/index.js';
export {
  DiscoveryBroadcaster,
  buildDiscoveryBeacon,
  serializeDiscoveryBeacon,
  resolveAdvertiseHost,
  type DiscoveryBeaconInfo,
  type DiscoveryBroadcasterOptions,
} from './discovery.js';
export { CollabServer, type CollabServerListenInfo, type CollabServerOptions } from './httpServer.js';
export { RoomRuntime, RoomRuntimeManager, type RoomRuntimeOptions } from './roomRuntime.js';
export { RoomService, type RoomLifecycleEvent, type RoomServiceOptions } from './rooms.js';
export {
  computeCertFingerprint,
  ensureServerTlsCertificate,
  fingerprintsMatch,
  generateSelfSignedCertificate,
  normalizeFingerprint,
} from './tls.js';
export {
  CollabWsHandler,
  WS_CLOSE_FORBIDDEN,
  WS_CLOSE_NOT_FOUND,
  WS_CLOSE_UNAUTHORIZED,
  createCollabWsHandler,
} from './wsHandler.js';

export interface ParsedServerCliArgs extends CollabServerOptions {
  help?: boolean;
}

export function parseServerCliArgs(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): ParsedServerCliArgs {
  let dataDir = env.HLR_SERVER_DATA_DIR?.trim() || path.resolve(process.cwd(), '.hlr-server-data');
  let databaseUrl = env.HLR_DATABASE_URL?.trim() || env.DATABASE_URL?.trim() || undefined;
  let dbPool = env.HLR_DB_POOL ? Number.parseInt(env.HLR_DB_POOL, 10) : undefined;
  let migrateOnly = env.HLR_MIGRATE_ONLY === '1' || env.HLR_MIGRATE_ONLY === 'true';
  let host = env.HLR_SERVER_HOST?.trim() || '0.0.0.0';
  let port = env.HLR_SERVER_PORT ? Number.parseInt(env.HLR_SERVER_PORT, 10) : DEFAULT_SERVER_PORT;
  let insecureHttp =
    env.HLR_SERVER_INSECURE_HTTP === '1' || env.HLR_SERVER_INSECURE_HTTP === 'true';
  let serverName = env.HLR_SERVER_NAME?.trim() || undefined;
  let registrationMode = env.HLR_SERVER_REGISTRATION_MODE?.trim() as RegistrationMode | undefined;
  let roomCreationMode = env.HLR_SERVER_ROOM_CREATION_MODE?.trim() as RoomCreationMode | undefined;
  let initialSetupToken = env.HLR_SERVER_SETUP_TOKEN?.trim() || undefined;
  let discovery =
    env.HLR_SERVER_NO_DISCOVERY === '1' || env.HLR_SERVER_NO_DISCOVERY === 'true'
      ? false
      : env.HLR_SERVER_DISCOVERY === '0' || env.HLR_SERVER_DISCOVERY === 'false'
        ? false
        : true;
  let discoveryPort = env.HLR_SERVER_DISCOVERY_PORT
    ? Number.parseInt(env.HLR_SERVER_DISCOVERY_PORT, 10)
    : undefined;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--migrate-only') {
      migrateOnly = true;
    } else if (arg === '--database-url' && argv[i + 1]) {
      databaseUrl = argv[++i]!;
    } else if (arg.startsWith('--database-url=')) {
      databaseUrl = arg.slice('--database-url='.length);
    } else if (arg === '--db-pool' && argv[i + 1]) {
      dbPool = Number.parseInt(argv[++i]!, 10);
    } else if (arg.startsWith('--db-pool=')) {
      dbPool = Number.parseInt(arg.slice('--db-pool='.length), 10);
    } else if (arg === '--insecure-http') {
      insecureHttp = true;
    } else if (arg === '--no-discovery') {
      discovery = false;
    } else if (arg === '--discovery-port' && argv[i + 1]) {
      discoveryPort = Number.parseInt(argv[++i]!, 10);
    } else if (arg.startsWith('--discovery-port=')) {
      discoveryPort = Number.parseInt(arg.slice('--discovery-port='.length), 10);
    } else if (arg === '--data-dir' && argv[i + 1]) {
      dataDir = path.resolve(argv[++i]!);
    } else if (arg.startsWith('--data-dir=')) {
      dataDir = path.resolve(arg.slice('--data-dir='.length));
    } else if (arg.startsWith('--data-dir')) {
      dataDir = path.resolve(argv[++i]!);
    } else if (arg === '--host' && argv[i + 1]) {
      host = argv[++i]!;
    } else if (arg.startsWith('--host=')) {
      host = arg.slice('--host='.length);
    } else if (arg === '--port' && argv[i + 1]) {
      port = Number.parseInt(argv[++i]!, 10);
    } else if (arg.startsWith('--port=')) {
      port = Number.parseInt(arg.slice('--port='.length), 10);
    } else if (arg === '--name' && argv[i + 1]) {
      serverName = argv[++i]!;
    } else if (arg.startsWith('--name=')) {
      serverName = arg.slice('--name='.length);
    } else if (arg === '--registration-mode' && argv[i + 1]) {
      registrationMode = argv[++i]! as RegistrationMode;
    } else if (arg.startsWith('--registration-mode=')) {
      registrationMode = arg.slice('--registration-mode='.length) as RegistrationMode;
    } else if (arg === '--room-creation-mode' && argv[i + 1]) {
      roomCreationMode = argv[++i]! as RoomCreationMode;
    } else if (arg.startsWith('--room-creation-mode=')) {
      roomCreationMode = arg.slice('--room-creation-mode='.length) as RoomCreationMode;
    } else if (arg === '--setup-token' && argv[i + 1]) {
      initialSetupToken = argv[++i]!;
    } else if (arg.startsWith('--setup-token=')) {
      initialSetupToken = arg.slice('--setup-token='.length);
    }
  }

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid server port: ${String(port)}`);
  }

  if (
    discoveryPort !== undefined &&
    (!Number.isInteger(discoveryPort) || discoveryPort < 1 || discoveryPort > 65535)
  ) {
    throw new Error(`Invalid discovery port: ${String(discoveryPort)}`);
  }

  if (
    registrationMode !== undefined &&
    !(REGISTRATION_MODES as readonly string[]).includes(registrationMode)
  ) {
    throw new Error(`Invalid registration mode: ${registrationMode}`);
  }

  if (
    roomCreationMode !== undefined &&
    !(ROOM_CREATION_MODES as readonly string[]).includes(roomCreationMode)
  ) {
    throw new Error(`Invalid room creation mode: ${roomCreationMode}`);
  }

  return {
    dataDir,
    databaseUrl,
    dbPool,
    migrateOnly,
    host,
    port,
    insecureHttp,
    serverName,
    registrationMode,
    roomCreationMode,
    initialSetupToken,
    discovery,
    discoveryPort,
    help,
  };
}

export function formatServerHelpText(): string {
  return [
    'HLR Collaboration Server',
    '',
    'Usage: npm run server -- [options]',
    '',
    'Options:',
    '  --database-url <url>                      PostgreSQL connection string (default: HLR_DATABASE_URL)',
    '  --db-pool <size>                          PostgreSQL connection pool size (default: 10)',
    '  --migrate-only                            Run schema migrations and exit',
    '  --data-dir <path>                         Server data directory for TLS certs (default: ./.hlr-server-data)',
    '  --host <address>                          Bind host address (default: 0.0.0.0)',
    `  --port <port>                             Bind port (default: ${DEFAULT_SERVER_PORT})`,
    '  --name <name>                             Server display name',
    '  --registration-mode <open|approval|closed> User registration mode',
    '  --room-creation-mode <all_users|admins_only> Room creation policy',
    '  --setup-token <token>                     Explicit initial SERVER_OWNER setup token',
    '  --insecure-http                           Disable TLS (plain HTTP/WS for testing only)',
    `  --discovery-port <port>                   UDP LAN discovery broadcast port (default: ${DEFAULT_DISCOVERY_PORT})`,
    '  --no-discovery                            Disable UDP LAN discovery broadcaster',
    '  -h, --help                                Show this help message',
  ].join('\n');
}

export async function startServerFromCli(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = line => console.log(line),
): Promise<CollabServer | null> {
  const parsed = parseServerCliArgs(argv, env);
  if (parsed.help) {
    log(formatServerHelpText());
    return null;
  }

  let server: CollabServer;
  try {
    server = new CollabServer(parsed);
  } catch (err) {
    log(`Configuration error: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }

  try {
    const info = await server.start();

    if (parsed.migrateOnly) {
      log('Database migrations applied successfully (--migrate-only).');
      await server.stop();
      return null;
    }

    log('============================================================');
    log(`HLR Collaboration Server started`);
    log(`Server ID   : ${info.serverId}`);
    log(`Listen URL  : ${info.url}`);
    log(`WebSocket   : ${info.wsUrl}/ws/rooms/<roomId>`);
    if (info.tls && info.fingerprint) {
      log(`TLS SHA-256 : ${info.fingerprint}`);
    } else {
      log(`TLS         : DISABLED (--insecure-http)`);
    }
    if (info.discoveryPort) {
      log(`Discovery   : UDP port ${info.discoveryPort} (broadcast)`);
    } else {
      log(`Discovery   : DISABLED (--no-discovery)`);
    }
    if (info.setupToken) {
      log('------------------------------------------------------------');
      log('FIRST-RUN SERVER OWNER SETUP REQUIRED');
      log(`One-Time Setup Token: ${info.setupToken}`);
      log('Enter this setup token in the HLR Writing Tool client to claim');
      log('the initial SERVER_OWNER account.');
    }
    log('============================================================');

    return server;
  } catch (err) {
    log(`Failed to start HLR Collaboration Server: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

const isMainEntry =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1]!)).href;

if (isMainEntry) {
  startServerFromCli().then(
    server => {
      if (!server) {
        return;
      }
      const shutdown = () => {
        void server.stop().finally(() => {
          process.exit(0);
        });
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    },
    error => {
      console.error('Failed to start HLR Collaboration Server:', error);
      process.exit(1);
    },
  );
}
