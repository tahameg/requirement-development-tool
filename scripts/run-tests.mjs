import { spawnSync } from 'node:child_process';
import electron from 'electron';
import { ensureTestDatabase } from './test-db.mjs';

const { databaseUrl, stop } = await ensureTestDatabase();
try {
  const result = spawnSync(electron, ['node_modules/vitest/vitest.mjs', 'run', '--coverage'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HLR_TEST_DATABASE_URL: databaseUrl,
    },
  });
  await stop();
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
} catch (err) {
  await stop();
  throw err;
}
