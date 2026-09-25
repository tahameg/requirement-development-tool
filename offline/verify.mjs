import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const manifest = JSON.parse(readFileSync('checksums.json', 'utf8'));
for (const [filename, expected] of Object.entries(manifest)) {
  const actual = createHash('sha256').update(readFileSync(filename)).digest('hex');
  if (actual !== expected) throw new Error(`Checksum mismatch: ${filename}`);
}
console.log(`Verified ${Object.keys(manifest).length} bundled files.`);
