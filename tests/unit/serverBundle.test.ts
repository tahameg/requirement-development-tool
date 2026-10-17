import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
import { createTestStore } from './testDbHelper.js';
it('runs the isolated pure-JavaScript server bundle and its migrations without node_modules', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hlr-bundle-'));
  const fixture = await createTestStore();
  try {
    const build = spawnSync(process.execPath, ['scripts/bundle-server.mjs', dir], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    expect(build.status, build.stderr).toBe(0); expect(existsSync(path.join(dir, 'node_modules'))).toBe(false);
    expect(readFileSync(path.join(dir, 'server.mjs'), 'utf8')).not.toContain('better-sqlite3');
    const url = new URL(fixture.databaseUrl); url.searchParams.set('options', `-c search_path=${fixture.schema},public`);
    const result = spawnSync(process.execPath, ['server.mjs', '--migrate-only', '--database-url', url.toString()], { cwd: dir, encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    expect(result.status, result.stderr).toBe(0);
    const help = spawnSync(process.execPath, ['server.mjs', '--help'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    expect(help.status).toBe(0); expect(help.stdout).toContain('HLR Collaboration Server');
  } finally { await fixture.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});
