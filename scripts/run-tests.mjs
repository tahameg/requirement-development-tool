import { spawnSync } from 'node:child_process';
import electron from 'electron';
const result = spawnSync(electron, ['node_modules/vitest/vitest.mjs', 'run', '--coverage'], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
