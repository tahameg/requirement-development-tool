-- Initial PostgreSQL schema for HLR Collaboration Server v2
-- Forward-only migration; never edit an applied migration file.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS server_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  server_id TEXT NOT NULL,
  server_name TEXT NOT NULL DEFAULT 'HLR Collaboration Server',
  registration_mode TEXT NOT NULL DEFAULT 'open' CHECK (registration_mode IN ('open', 'approval', 'closed')),
  room_creation_mode TEXT NOT NULL DEFAULT 'all_users' CHECK (room_creation_mode IN ('all_users', 'admins_only')),
  setup_token_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  server_role TEXT NOT NULL DEFAULT 'USER' CHECK (server_role IN ('SERVER_OWNER', 'SERVER_ADMIN', 'USER')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PENDING_APPROVAL', 'DISABLED')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username));

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'listed')),
  owner_id TEXT NOT NULL REFERENCES users(id),
  project_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  head_seq INTEGER NOT NULL DEFAULT 0,
  snapshot_seq INTEGER NOT NULL DEFAULT 0,
  last_autosaved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rooms_owner_id ON rooms(owner_id);

CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('ROOM_OWNER', 'ROOM_ADMIN', 'EDITOR', 'VIEWER')),
  joined_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_room_members_user_id ON room_members(user_id);

CREATE TABLE IF NOT EXISTS room_bans (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  banned_by TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL DEFAULT '',
  banned_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('direct', 'code')),
  target_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  code TEXT UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('ROOM_ADMIN', 'EDITOR', 'VIEWER')),
  created_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED')),
  uses INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invites_room_id ON invites(room_id);
CREATE INDEX IF NOT EXISTS idx_invites_target_user_id ON invites(target_user_id);
CREATE INDEX IF NOT EXISTS idx_invites_code ON invites(code);

CREATE TABLE IF NOT EXISTS join_requests (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  assigned_role TEXT CHECK (assigned_role IS NULL OR assigned_role IN ('ROOM_ADMIN', 'EDITOR', 'VIEWER')),
  reviewed_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL,
  reviewed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_join_requests_room_id ON join_requests(room_id);
CREATE INDEX IF NOT EXISTS idx_join_requests_user_id ON join_requests(user_id);

CREATE TABLE IF NOT EXISTS room_ops (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  op_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  result_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (room_id, seq),
  UNIQUE (room_id, op_id)
);

CREATE INDEX IF NOT EXISTS idx_room_ops_room_id ON room_ops(room_id);

CREATE TABLE IF NOT EXISTS room_snapshots (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  workspace JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (room_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_room_snapshots_room_id ON room_snapshots(room_id);

CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  message TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES users(id),
  author_name TEXT NOT NULL,
  workspace JSONB NOT NULL,
  snapshot_filename TEXT NOT NULL DEFAULT '',
  restored_from_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (room_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_revisions_room_id ON revisions(room_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  details_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_room_id ON audit_log(room_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
