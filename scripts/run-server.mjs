import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(rootDir, 'dist', 'server', 'index.js');

if (!existsSync(serverEntry)) {
  const tscBin = path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc');
  const buildResult = spawnSync(process.execPath, [tscBin], {
    cwd: rootDir,
    stdio: 'inherit',
  });
  if (buildResult.status !== 0) {
    process.exit(buildResult.status ?? 1);
  }
}

let runtimeExecutable = process.execPath;
if (process.env.HLR_USE_SYSTEM_NODE !== '1') {
  try {
    const electronModule = await import('electron');
    if (typeof electronModule.default === 'string' && existsSync(electronModule.default)) {
      runtimeExecutable = electronModule.default;
    }
  } catch {
    // Fall back to system Node executable
  }
}

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
