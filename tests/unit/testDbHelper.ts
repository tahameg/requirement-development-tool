import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ensureTestDatabase } from '../../scripts/test-db.mjs';
import { PgServerStore, runMigrations } from '../../src/server/store/index.js';

let sharedDbStarted = false;
let sharedDbStop: (() => Promise<void>) | null = null;

export async function ensureSharedTestDatabase(): Promise<string> {
  if (process.env.HLR_TEST_DATABASE_URL) {
    return process.env.HLR_TEST_DATABASE_URL;
  }
  if (!sharedDbStarted) {
    const { databaseUrl, stop } = await ensureTestDatabase();
    process.env.HLR_TEST_DATABASE_URL = databaseUrl;
    sharedDbStop = stop;
    sharedDbStarted = true;
  }
  return process.env.HLR_TEST_DATABASE_URL!;
}

export interface TestStoreFixture {
  store: PgServerStore;
  pool: pg.Pool;
  schema: string;
  databaseUrl: string;
  cleanup: () => Promise<void>;
}

export async function createTestStore(options: { schemaPrefix?: string } = {}): Promise<TestStoreFixture> {
  const databaseUrl = await ensureSharedTestDatabase();
  const schema = `${options.schemaPrefix ?? 'test'}_${randomUUID().replace(/-/g, '_')}`;

  const adminClient = new pg.Client({ connectionString: databaseUrl });
  await adminClient.connect();
  await adminClient.query(`CREATE SCHEMA "${schema}"`);

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    options: `-c search_path="${schema}",public`,
    max: 10,
  });

  // Run migrations inside this isolated schema
  const migClient = await pool.connect();
  try {
    await runMigrations(migClient);
  } finally {
    migClient.release();
  }

  const store = new PgServerStore(pool, { ownsPool: true });

  const cleanup = async () => {
    try {
      await store.close();
    } catch {
      // ignore
    }
    try {
      await adminClient.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } catch {
      // ignore
    }
    try {
      await adminClient.end();
    } catch {
      // ignore
    }
  };

  return { store, pool, schema, databaseUrl, cleanup };
}
