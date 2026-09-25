export const cacheSchema = `
PRAGMA foreign_keys = ON;
CREATE TABLE modules (
  id TEXT PRIMARY KEY, object_type TEXT NOT NULL, parent_id TEXT REFERENCES modules(id) DEFERRABLE INITIALLY DEFERRED,
  name TEXT NOT NULL, prefix TEXT NOT NULL, sort_order INTEGER NOT NULL
);
CREATE TABLE functions (
  id TEXT PRIMARY KEY, module_id TEXT NOT NULL REFERENCES modules(id), name TEXT NOT NULL,
  prefix TEXT NOT NULL, description TEXT NOT NULL, watermark_counter INTEGER NOT NULL
);
CREATE TABLE items (
  id TEXT PRIMARY KEY, function_id TEXT NOT NULL REFERENCES functions(id), sequence_num INTEGER NOT NULL,
  object_type TEXT NOT NULL, values_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE items_fts USING fts5(id, function_name, description, values_text);
PRAGMA user_version = 1;
`;
