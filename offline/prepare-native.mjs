// Connected preparation only. Packaging consumes these artifacts without rebuilding.
import { mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const abi = spawnSync(electron, ['-p', 'process.versions.modules'], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
if (abi.status !== 0) throw new Error(abi.stderr);
const electronAbi = abi.stdout.trim();
const hostBinding = path.resolve('node_modules/better-sqlite3/build/Release/better_sqlite3.node');
for (const platform of ['linux', 'win32']) {
  const directory = path.resolve(`offline/native/${platform}-x64`);
  mkdirSync(directory, { recursive: true });
  const target = path.join(directory, 'better_sqlite3.node');
  const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${pkg.dependencies['better-sqlite3']}/better-sqlite3-v${pkg.dependencies['better-sqlite3']}-electron-v${electronAbi}-${platform}-x64.tar.gz`;
  if (platform === process.platform) copyFileSync(hostBinding, target);
  else {
    const oldManifest = path.join(directory, 'manifest.json');
    const old = existsSync(oldManifest) ? JSON.parse(readFileSync(oldManifest, 'utf8')) : null;
    const cached = existsSync(target) && old?.electron === pkg.devDependencies.electron && old?.sqlite === pkg.dependencies['better-sqlite3'] && old?.electronAbi === electronAbi && old?.sha256 === createHash('sha256').update(readFileSync(target)).digest('hex');
    if (!cached) {
    console.log(`Downloading ${url}`);
    const response = await fetch(url); if (!response.ok) throw new Error(`${response.status} downloading SQLite prebuild`);
    const temp = mkdtempSync(path.join(os.tmpdir(), 'hlr-native-'));
    try {
      const archive = path.join(temp, 'native.tar.gz'); writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
      const unpack = spawnSync('tar', ['-xzf', archive, '-C', temp], { stdio: 'inherit' }); if (unpack.status !== 0) throw new Error('Unable to unpack native archive');
      copyFileSync(path.join(temp, 'build/Release/better_sqlite3.node'), target);
    } finally { rmSync(temp, { recursive: true, force: true }); }
    }
  }
  writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ platform, arch: 'x64', electron: pkg.devDependencies.electron, electronAbi, sqlite: pkg.dependencies['better-sqlite3'], sha256: createHash('sha256').update(readFileSync(target)).digest('hex'), source: platform === process.platform ? 'Locally rebuilt using npm run setup:desktop' : url }, null, 2) + '\n');
}
