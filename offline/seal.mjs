// Refresh source/docs in an already prepared bundle, then write final checksums.
import { cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const platform = process.argv[2];
if (!['linux', 'win32'].includes(platform)) throw new Error('Choose linux or win32');
const stage = path.resolve(`offline/staging/hlr-dev-${platform}-x64`);
for (const entry of ['src', 'tests', 'scripts', 'build', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'vitest.config.ts', 'electron-builder.yml', 'README.md', 'Agents.md', '.gitignore']) cpSync(entry, path.join(stage, entry), { recursive: true });
for (const entry of readdirSync('offline')) if (/\.(mjs|md|sh|ps1)$/.test(entry)) cpSync(path.join('offline', entry), path.join(stage, 'offline', entry));
const manifest = {};
function walk(directory, relative = '') {
  for (const file of readdirSync(directory, { withFileTypes: true })) {
    if (!relative && ['checksums.json', 'release', 'coverage'].includes(file.name)) continue;
    const filename = path.join(relative, file.name);
    if (file.isDirectory()) walk(path.join(directory, file.name), filename);
    else if (file.isFile()) manifest[filename.split(path.sep).join('/')] = createHash('sha256').update(readFileSync(path.join(directory, file.name))).digest('hex');
  }
}
walk(stage); writeFileSync(path.join(stage, 'checksums.json'), JSON.stringify(manifest, null, 2) + '\n');
if (process.argv.includes('--no-archive')) process.exit(0);
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const output = path.resolve(`offline/bundles/hlr-dev-${version}-${platform}-x64.tar.gz`);
const result = spawnSync('tar', ['-czf', output, `--exclude=${path.basename(stage)}/release`, `--exclude=${path.basename(stage)}/coverage`, '-C', path.dirname(stage), path.basename(stage)], { stdio: 'inherit' });
if (result.status !== 0) throw new Error('Archiving failed');
writeFileSync(`${output}.sha256`, `${createHash('sha256').update(readFileSync(output)).digest('hex')}  ${path.basename(output)}\n`);
console.log(output);
