import { it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { WorkspaceIndex } from '../../src/main/db/sqliteClient.js';
import { createWorkspace, addModule, addFunction } from '../../src/main/services/workspaceFactory.js';
import { addItem } from '../../src/main/services/idGenerator.js';
import { objectTypes } from '../../src/shared/types/schema.js';
it('indexes every object type with foreign keys and literal full-text queries; rebuilds a corrupt cache', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hlr-db-'));
  let index: WorkspaceIndex | undefined;
  try {
    let workspace = createWorkspace('Index');
    for (const type of objectTypes) {
      workspace = addModule(workspace, type, 'Parent', 'P');
      workspace = addModule(workspace, type, 'Child', 'C', workspace.domains[type].modules[0]!.id);
      workspace = addFunction(workspace, type, workspace.domains[type].modules[1]!.id, 'Control', 'CTRL');
      workspace = addItem(workspace, type, workspace.domains[type].functions[0]!.functionId, type === 'REQUIREMENT' ? { col_desc: 'The parser shall initialize.' } : { col_name: 'parser' });
      workspace.domains[type].modules.reverse();
    }
    index = WorkspaceIndex.rebuild(root, workspace);
    expect(index.count()).toBe(4);
    expect(index.search('parser')).toHaveLength(4);
    expect(index.search('initialize')).toHaveLength(1);
    expect(index.search('   ')).toEqual([]);
    expect(() => index!.search('" OR * -')).not.toThrow();
    const db = new Database(index.filename, { readonly: true });
    expect(db.pragma('foreign_key_check')).toEqual([]); expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]); db.close();
    index.close(); index = undefined;
    writeFileSync(path.join(root, '.hlr/cache.sqlite'), 'corrupt cache');
    index = WorkspaceIndex.rebuild(root, workspace);
    expect(index.count()).toBe(4);
  } finally { index?.close(); rmSync(root, { recursive: true, force: true }); }
});
