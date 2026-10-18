export const cacheSchema = `
PRAGMA foreign_keys = ON;
CREATE TABLE components (
  id TEXT PRIMARY KEY, object_type TEXT NOT NULL, parent_id TEXT REFERENCES components(id) DEFERRABLE INITIALLY DEFERRED,
  name TEXT NOT NULL, prefix TEXT NOT NULL, sort_order INTEGER NOT NULL
);
CREATE TABLE requirement_sets (
  id TEXT PRIMARY KEY, component_id TEXT NOT NULL REFERENCES components(id), name TEXT NOT NULL,
  prefix TEXT NOT NULL, description TEXT NOT NULL, watermark_counter INTEGER NOT NULL
);
CREATE TABLE items (
  id TEXT PRIMARY KEY, requirement_set_id TEXT NOT NULL REFERENCES requirement_sets(id), sequence_num INTEGER NOT NULL,
  object_type TEXT NOT NULL, values_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE items_fts USING fts5(id, requirement_set_name, description, values_text);
PRAGMA user_version = 2;
`;
