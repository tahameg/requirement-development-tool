import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
import { DraftStore } from '../../src/main/collab/draftStore.js';
it('persists a single scoped draft across app restarts and prevents path traversal', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hlr-drafts-'));
  try {
    const draft = { objectType: 'REQUIREMENT' as const, functionId: 'f', itemId: 'i', baseValues: { col_desc: 'old' }, values: { col_desc: 'unsent' } };
    new DraftStore(root).save('https://server:user-a', '../../room', draft);
    const next = new DraftStore(root); expect(next.load('https://server:user-a', '../../room')).toEqual(draft);
    expect(next.load('https://server:user-b', '../../room')).toBeNull();
    next.save('https://server:user-a', '../../room', { ...draft, kind: 'description', values: { description: 'Scope' }, baseValues: { description: '' } });
    expect(next.load('https://server:user-a', '../../room')!.kind).toBe('description');
    next.save('https://server:user-a', '../../room', null); expect(next.load('https://server:user-a', '../../room')).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
