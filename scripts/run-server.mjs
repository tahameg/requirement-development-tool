import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(rootDir, 'dist', 'server', 'index.js');

// Source checkout: compile on each launch so the server never runs stale code.
const tscBin = path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc');
if (existsSync(tscBin)) {
  const result = spawnSync(process.execPath, [tscBin], { cwd: rootDir, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const distMigrations = path.join(rootDir, 'dist', 'server', 'store', 'migrations');
const srcMigrations = path.join(rootDir, 'src', 'server', 'store', 'migrations');
if (existsSync(srcMigrations)) { mkdirSync(distMigrations, { recursive: true }); cpSync(srcMigrations, distMigrations, { recursive: true }); }
const runtimeExecutable = process.execPath;

const child = spawn(runtimeExecutable, [serverEntry, ...process.argv.slice(2)], {
  cwd: rootDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
  },
});

const forwardSignal = signal => {
  if (!child.killed) {
    child.kill(signal);
  }
};

process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
