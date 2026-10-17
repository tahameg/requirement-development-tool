-- A revision records the room's operation sequence; multiple named saves can share a head.
ALTER TABLE revisions DROP CONSTRAINT IF EXISTS revisions_room_id_seq_key;
CREATE INDEX IF NOT EXISTS idx_revisions_room_seq ON revisions(room_id, seq);
