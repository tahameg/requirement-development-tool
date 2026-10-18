import type { SearchHit } from '../../shared/authoring.js';
import Database from 'better-sqlite3';
import { mkdirSync, renameSync, unlinkSync, existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Workspace } from '../../shared/types/workspace.js';
import { objectTypes } from '../../shared/types/schema.js';
import { cacheSchema } from './migrations.js';
import { validateWorkspace } from '../services/validation.js';
export class WorkspaceIndex {
  private db: Database.Database;
  private constructor(readonly filename: string) {
    this.db = new Database(filename);
    this.db.pragma('foreign_keys = ON');
  }
  static rebuild(root: string, input: Workspace): WorkspaceIndex {
    const workspace = validateWorkspace(input);
    const directory = path.join(root, '.hlr');
    mkdirSync(directory, { recursive: true });
    if (lstatSync(directory).isSymbolicLink()) throw new Error('Cache directory cannot be a symbolic link');
    const filename = path.join(directory, 'cache.sqlite');
    if (existsSync(filename) && lstatSync(filename).isSymbolicLink()) throw new Error('Cache cannot be a symbolic link');
    const temp = `${filename}.${randomUUID()}.tmp`;
    const db = new Database(temp);
    try {
      db.exec(cacheSchema);
      const componentInsert = db.prepare('INSERT INTO components VALUES (?, ?, ?, ?, ?, ?)');
      const requirementSetInsert = db.prepare('INSERT INTO requirement_sets VALUES (?, ?, ?, ?, ?, ?)');
      const itemInsert = db.prepare('INSERT INTO items VALUES (?, ?, ?, ?, ?, ?, ?)');
      const ftsInsert = db.prepare('INSERT INTO items_fts VALUES (?, ?, ?, ?)');
      db.transaction(() => {
        for (const type of objectTypes) {
          const domain = workspace.domains[type];
          domain.components.forEach((m, i) => componentInsert.run(m.id, type, m.parentId, m.name, m.prefix, i));
          for (const fn of domain.requirementSets) {
            requirementSetInsert.run(fn.requirementSetId, fn.parentComponentId, fn.name, fn.prefix, fn.description, fn.watermarkCounter);
            for (const item of fn.items) {
              itemInsert.run(item.id, fn.requirementSetId, item.seq, type, JSON.stringify(item.values), item.created_at, item.updated_at ?? item.created_at);
              ftsInsert.run(item.id, fn.name, String(item.values.col_desc ?? ''), Object.values(item.values).join(' '));
            }
          }
        }
      })();
      db.close();
      renameSync(temp, filename);
      return new WorkspaceIndex(filename);
    } catch (error) {
      if (db.open) db.close();
      if (existsSync(temp)) unlinkSync(temp);
      throw error;
    }
  }
  count(): number { return (this.db.prepare('SELECT count(*) AS count FROM items').get() as { count: number }).count; }
  search(text: string): SearchHit[] {
    const tokens = text.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return [];
    const query = tokens.map(token => `"${token.replaceAll('"', '""')}"`).join(' AND ');
    return this.db.prepare('SELECT items.id, requirement_set_id AS requirementSetId, requirement_set_name AS requirementSetName, object_type AS objectType, substr(description, 1, 240) AS description FROM items_fts JOIN items ON items.id = items_fts.id WHERE items_fts MATCH ? ORDER BY rank LIMIT 100').all(query) as SearchHit[];
  }
  close(): void { this.db.close(); }
}
