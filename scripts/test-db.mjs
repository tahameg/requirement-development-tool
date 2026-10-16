import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import pg from 'pg';

async function findFreePort(startPort = 54330) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => {
      findFreePort(startPort + 1).then(resolve, reject);
    });
    server.listen(startPort, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForPostgres(url, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1000 });
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch {
      await new Promise(r => setTimeout(r, 250));
    }
  }
  throw new Error(`Timed out waiting for PostgreSQL to be ready at ${url}`);
}

export async function ensureTestDatabase() {
  if (process.env.HLR_TEST_DATABASE_URL) {
    const databaseUrl = process.env.HLR_TEST_DATABASE_URL;
    await waitForPostgres(databaseUrl);
    return {
      databaseUrl,
      stop: async () => {},
    };
  }

  const containerName = `hlr-test-postgres-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const port = await findFreePort();
  const password = 'testpassword';
  const databaseUrl = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;

  console.log(`[test-db] Spawning disposable container ${containerName} on port ${port}...`);

  const runResult = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '-d',
      '--name',
      containerName,
      '-e',
      `POSTGRES_PASSWORD=${password}`,
      '-p',
      `127.0.0.1:${port}:5432`,
      'postgres:16-alpine',
    ],
    { stdio: 'inherit' },
  );

  if (runResult.status !== 0) {
    throw new Error(`Failed to start docker container ${containerName}`);
  }

  const stop = async () => {
    try {
      console.log(`[test-db] Stopping disposable container ${containerName}...`);
      spawnSync('docker', ['stop', containerName], { stdio: 'ignore' });
    } catch {
      // ignore
    }
  };

  process.on('SIGINT', () => {
    stop().finally(() => process.exit(130));
  });
  process.on('SIGTERM', () => {
    stop().finally(() => process.exit(143));
  });

  try {
    await waitForPostgres(databaseUrl);
    console.log(`[test-db] PostgreSQL ready at ${databaseUrl}`);
  } catch (err) {
    await stop();
    throw err;
  }

  return { databaseUrl, stop };
}

// If invoked as CLI: node scripts/test-db.mjs <command> [args...]
if (process.argv[1]?.endsWith('test-db.mjs')) {
  const args = process.argv.slice(2);
  const command = args[0] || 'echo';
  const cmdArgs = args.length > 0 ? args.slice(1) : ['[test-db] DB ready'];

  ensureTestDatabase()
    .then(async ({ databaseUrl, stop }) => {
      const env = { ...process.env, HLR_TEST_DATABASE_URL: databaseUrl };
      const child = spawn(command, cmdArgs, { stdio: 'inherit', env });

      child.on('close', async code => {
        await stop();
        process.exit(code ?? 0);
      });
      child.on('error', async err => {
        console.error(err);
        await stop();
        process.exit(1);
      });
    })
    .catch(err => {
      console.error('[test-db] Error:', err);
      process.exit(1);
    });
}
