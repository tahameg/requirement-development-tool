import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync } from 'node:fs';

await build({ entryPoints: ['src/preload/index.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: 'dist/preload/index.cjs' });

if (existsSync('src/server/store/migrations')) {
  mkdirSync('dist/server/store/migrations', { recursive: true });
  cpSync('src/server/store/migrations', 'dist/server/store/migrations', { recursive: true });
}
