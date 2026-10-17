import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { RoomDraft } from '../../shared/collab/client.js';
export class DraftStore {
  constructor(private root: string) {}
  private filename(server: string, room: string) { return path.join(this.root, createHash('sha256').update(server).digest('hex'), createHash('sha256').update(room).digest('hex'), 'draft.json'); }
  save(server: string, room: string, draft: RoomDraft | null) {
    const file = this.filename(server, room);
    if (!draft) { rmSync(file, { force: true }); return; }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file + '.tmp', JSON.stringify(draft, null, 2), { mode: 0o600 }); renameSync(file + '.tmp', file);
  }
  load(server: string, room: string): RoomDraft | null { const file = this.filename(server, room); return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; }
}
