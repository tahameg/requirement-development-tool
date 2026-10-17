import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

export const MIGRATION_ADVISORY_LOCK_ID = 8473927492837482n;

export interface MigrationFile {
  version: string;
  sql: string;
}

export function resolveDefaultMigrationsDir(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidateInCurrent = path.join(currentDir, 'migrations');
  if (existsSync(candidateInCurrent)) {
    return candidateInCurrent;
  }
  const root = path.resolve(currentDir, '..', '..', '..');
  const candidateInSrc = path.join(root, 'src', 'server', 'store', 'migrations');
  if (existsSync(candidateInSrc)) {
    return candidateInSrc;
  }
  return candidateInCurrent;
}

export function loadMigrationFiles(migrationsDir?: string): MigrationFile[] {
  const dir = migrationsDir ?? resolveDefaultMigrationsDir();
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  return files.map(filename => ({
    version: filename,
    sql: readFileSync(path.join(dir, filename), 'utf8'),
  }));
}

export async function runMigrations(
  clientOrPool: pg.Pool | pg.PoolClient | pg.Client,
  options: {
    migrationsDir?: string;
    migrations?: MigrationFile[];
    now?: () => Date;
  } = {},
): Promise<{ applied: string[]; all: string[] }> {
  const now = options.now ?? (() => new Date());
  const migrations = options.migrations ?? loadMigrationFiles(options.migrationsDir);

  // If passed a Pool, acquire a dedicated client for advisory lock & transactions
  let client: pg.PoolClient | pg.Client;
  let shouldRelease = false;

  if ('totalCount' in clientOrPool || 'idleCount' in clientOrPool) {
    client = await (clientOrPool as pg.Pool).connect();
    shouldRelease = true;
  } else {
    client = clientOrPool as pg.PoolClient | pg.Client;
  }

  const applied: string[] = [];
  const all: string[] = [];

  try {
    // Acquire PostgreSQL session advisory lock to ensure concurrency safety
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_ID.toString()]);

    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL
        );
      `);

      const appliedRes = await client.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version ASC',
      );
      const appliedSet = new Set(appliedRes.rows.map(r => r.version));

      for (const m of migrations) {
        all.push(m.version);
        if (!appliedSet.has(m.version)) {
          await client.query('BEGIN');
          try {
            await client.query(m.sql);
            await client.query(
              'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)',
              [m.version, now().toISOString()],
            );
            await client.query('COMMIT');
            applied.push(m.version);
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          }
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_ID.toString()]);
    }
  } finally {
    if (shouldRelease && 'release' in client && typeof client.release === 'function') {
      client.release();
    }
  }

  return { applied, all };
}
