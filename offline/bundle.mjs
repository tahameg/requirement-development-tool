/** Connected preparation: assemble a target-specific, self-contained development tree. */
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, readdirSync, lstatSync, readlinkSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { downloadArtifact } from '@electron/get';
import extract from 'extract-zip';
const platform = process.argv[2] ?? process.platform;
if (!['linux', 'win32'].includes(platform)) throw new Error('Choose linux or win32');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const stage = path.resolve(`offline/staging/hlr-dev-${platform}-x64`);
if (existsSync(stage)) throw new Error(`Bundle staging already exists: ${stage}. Move it aside before creating a fresh bundle.`);
mkdirSync(stage, { recursive: true });
const entries = ['src', 'tests', 'scripts', 'build', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'vitest.config.ts', 'electron-builder.yml', 'README.md', 'Agents.md', '.gitignore'];
for (const entry of entries) cpSync(entry, path.join(stage, entry), { recursive: true });
mkdirSync(path.join(stage, 'offline'), { recursive: true });
for (const entry of readdirSync('offline')) if (/\.(mjs|md|sh|ps1)$/.test(entry)) cpSync(path.join('offline', entry), path.join(stage, 'offline', entry));
cpSync('offline/native', path.join(stage, 'offline/native'), { recursive: true });
const cache = path.resolve('offline/cache');
// Use the host npm command only while connected; the finished bundle includes its own npm.
const install = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', `--os=${platform}`, '--cpu=x64', '--cache', path.join(cache, 'npm')], { cwd: stage, stdio: 'inherit', shell: process.platform === 'win32' });
if (install.status !== 0) throw new Error('Unable to prepare target dependency tree');
if (platform === 'win32') {
  // npm running on Linux creates POSIX symlinks. Add Windows command shims too.
  const bins = path.join(stage, 'node_modules/.bin');
  for (const name of readdirSync(bins)) {
    const entry = path.join(bins, name);
    if (!lstatSync(entry).isSymbolicLink()) continue;
    const relative = readlinkSync(entry).replaceAll('/', '\\');
    writeFileSync(`${entry}.cmd`, `@echo off\r\nnode "%~dp0${relative}" %*\r\n`);
    unlinkSync(entry);
  }
}

const electronZip = await downloadArtifact({ version: pkg.devDependencies.electron, artifactName: 'electron', platform, arch: 'x64', cacheRoot: path.join(cache, 'electron') });
const electronDir = path.join(stage, 'node_modules/electron/dist'); mkdirSync(electronDir, { recursive: true });
await extract(electronZip, { dir: electronDir });
writeFileSync(path.join(stage, 'node_modules/electron/path.txt'), platform === 'win32' ? 'electron.exe' : 'electron');
const sqliteDir = path.join(stage, 'node_modules/better-sqlite3/build/Release'); mkdirSync(sqliteDir, { recursive: true });
cpSync(`offline/native/${platform}-x64/better_sqlite3.node`, path.join(sqliteDir, 'better_sqlite3.node'));
const nodeVersion = '20.20.2';
const nodeName = `node-v${nodeVersion}-${platform === 'win32' ? 'win' : 'linux'}-x64`;
const nodeFile = `${nodeName}.${platform === 'win32' ? 'zip' : 'tar.xz'}`;
mkdirSync(path.join(cache, 'toolchains'), { recursive: true });
const archive = path.join(cache, 'toolchains', nodeFile);
if (!existsSync(archive)) { const response = await fetch(`https://nodejs.org/dist/v${nodeVersion}/${nodeFile}`); if (!response.ok) throw new Error(`Node toolchain download failed: ${response.status}`); writeFileSync(archive, Buffer.from(await response.arrayBuffer())); }
const sums = await fetch(`https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`); if (!sums.ok) throw new Error('Cannot verify Node download');
const expected = (await sums.text()).split('\n').find(line => line.endsWith(` ${nodeFile}`))?.split(/\s+/)[0];
const actual = createHash('sha256').update(readFileSync(archive)).digest('hex'); if (!expected || actual !== expected) throw new Error('Node toolchain checksum mismatch');
const toolchain = path.join(stage, 'toolchain'); mkdirSync(toolchain, { recursive: true });
if (platform === 'win32') await extract(archive, { dir: toolchain });
else { const result = spawnSync('tar', ['-xf', archive, '-C', toolchain], { stdio: 'inherit' }); if (result.status !== 0) throw new Error('Node extraction failed'); }
if (platform === 'linux') {
  writeFileSync(path.join(stage, 'dev.sh'), `#!/usr/bin/env bash\nset -euo pipefail\ncd "$(dirname "$0")"\nexport PATH="$PWD/toolchain/${nodeName}/bin:$PATH"\nexport ELECTRON_CACHE="$PWD/offline/cache/electron"\nexport ELECTRON_BUILDER_CACHE="$PWD/offline/cache/builder"\nexec npm "$@"\n`, { mode: 0o755 });
} else writeFileSync(path.join(stage, 'dev.cmd'), `@echo off\r\ncd /d "%~dp0"\r\nset "PATH=%CD%\\toolchain\\${nodeName};%PATH%"\r\nset "ELECTRON_CACHE=%CD%\\offline\\cache\\electron"\r\nset "ELECTRON_BUILDER_CACHE=%CD%\\offline\\cache\\builder"\r\ncall npm.cmd %*\r\n`);
// Packing resources are downloaded by connected package builds first.
for (const entry of ['electron', 'builder']) if (existsSync(path.join(cache, entry))) cpSync(path.join(cache, entry), path.join(stage, 'offline/cache', entry), { recursive: true });
writeFileSync(path.join(stage, 'OFFLINE-BUNDLE.json'), JSON.stringify({ version: pkg.version, platform, arch: 'x64', node: nodeVersion, electron: pkg.devDependencies.electron, sqlite: pkg.dependencies['better-sqlite3'], nodeSha256: actual, createdAt: new Date().toISOString(), instructions: platform === 'linux' ? './dev.sh run build; ./dev.sh test; ./dev.sh start' : 'dev.cmd run build & dev.cmd test & dev.cmd start', note: 'Do not run npm ci or setup:desktop offline. Dependencies and native binaries are already installed. Operating-system desktop libraries are prerequisites.' }, null, 2) + '\n');
const manifest = {};
function checksumTree(directory, relative = '') {
  for (const file of readdirSync(directory, { withFileTypes: true })) {
    const name = path.join(relative, file.name);
    if (file.isDirectory()) checksumTree(path.join(directory, file.name), name);
    else if (file.isFile()) manifest[name.split(path.sep).join('/')] = createHash('sha256').update(readFileSync(path.join(directory, file.name))).digest('hex');
  }
}
checksumTree(stage); writeFileSync(path.join(stage, 'checksums.json'), JSON.stringify(manifest, null, 2) + '\n');
mkdirSync('offline/bundles', { recursive: true });
const output = path.resolve(`offline/bundles/hlr-dev-${pkg.version}-${platform}-x64.tar.gz`);
const pack = spawnSync('tar', ['-czf', output, '-C', path.dirname(stage), path.basename(stage)], { stdio: 'inherit' }); if (pack.status !== 0) throw new Error('Bundle archive creation failed');
writeFileSync(`${output}.sha256`, `${createHash('sha256').update(readFileSync(output)).digest('hex')}  ${path.basename(output)}\n`);
console.log(`Offline bundle: ${output}`);
