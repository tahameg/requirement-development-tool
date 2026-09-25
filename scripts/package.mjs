import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
const platform = process.argv[2] ?? process.platform;
const target = process.argv.find(value => value.startsWith('--target='))?.slice(9);
if (!['linux', 'win32'].includes(platform)) throw new Error('Choose linux or win32');
const binding = path.resolve('node_modules/better-sqlite3/build/Release/better_sqlite3.node');
const native = path.resolve(`offline/native/${platform}-x64/better_sqlite3.node`);
const original = path.resolve(`offline/native/${process.platform}-x64/better_sqlite3.node`);
mkdirSync(path.dirname(original), { recursive: true });
if (!existsSync(original)) copyFileSync(binding, original);
if (!existsSync(native)) throw new Error(`Missing ${native}. Run the offline preparation script while connected.`);
const manifest = JSON.parse(readFileSync(path.join(path.dirname(native), 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (manifest.electron !== pkg.devDependencies.electron || manifest.sqlite !== pkg.dependencies['better-sqlite3']) throw new Error('Native binary manifest does not match package.json');
if (createHash('sha256').update(readFileSync(native)).digest('hex') !== manifest.sha256) throw new Error('Native binary checksum mismatch');
const swap = source => { copyFileSync(source, `${binding}.swap`); renameSync(`${binding}.swap`, binding); };
try {
  if (platform !== process.platform) swap(native);
  const args = ['node_modules/electron-builder/cli.js', platform === 'win32' ? '--win' : '--linux', ...(target ? [target] : []), '--x64', '--publish', 'never', ...process.argv.slice(3).filter(value => !value.startsWith('--target='))];
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: { ...process.env, ELECTRON_CACHE: path.resolve('offline/cache/electron'), ELECTRON_BUILDER_CACHE: path.resolve('offline/cache/builder') } });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { if (platform !== process.platform) swap(original); }
