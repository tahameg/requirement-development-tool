# Collaboration Architecture v2: Server-Ordered Operations + Locks

**Status: authoritative.** Written by the human-supervised lead architect after review of v1.
This document **replaces the Yjs/CRDT design** in `ARCHITECTURE.md` sections 1 (sync parts), 2, 5, 6, 7.1, 8
and the Yjs parts of `PROTOCOL.md` and `PERMISSIONS.md`. Everything else in v1 (auth, rooms, invites, join
requests, audit log, TLS + TOFU pinning, discovery, renderer security, revisions, packaging) stays valid.
Implementers must not deviate from this document. If something here is impossible, stop and write a
`PROPOSAL:` entry in `PROGRESS.md` instead of improvising.

## 1. Why v1 is replaced

Requirements are structured records (rows with typed columns), not free-form shared text. A CRDT that merges
concurrent writes is the wrong tool: it makes ID allocation, permissions and validation hard (the server has to
clone and fully re-validate the whole document on every keystroke update), and it lets two people silently edit
the same requirement. The product owner wants:

1. Every change goes to the server first, is **ordered in a queue**, applied, and the result is distributed.
2. Changes to the same unit are **sequential**.
3. While one person edits a requirement (or any object), **others cannot edit it**: it is locked for them and shows
   who holds it.

## 2. Core model

```
client ──op──▶ server room queue (serial) ──▶ authorize ─▶ apply domain fn ─▶ persist op ─▶ seq++ ─▶ broadcast
   ▲                                                                                              │
   └──────────────── op-applied {seq, op, result}  (all clients, in seq order) ◀────────────────────┘
```

- The server holds the **authoritative `Workspace`** (plain existing type, no Yjs) per open room in memory.
- Each room has a **single serial queue** (a promise chain). Exactly one op is processed at a time per room.
  This gives total ordering and makes ID allocation trivially collision-free.
- Every accepted op gets a room-monotonic **`seq`** and is broadcast to all room clients. Clients apply ops strictly
  in `seq` order to their mirror of the workspace. Clients never invent state; structural changes appear only after
  the server confirms them (LAN round-trip is milliseconds).
- Ops are **commands that reuse existing pure domain functions**:

| Op kind | Payload | Server applies with | Lock rule |
|---|---|---|---|
| `hierarchy` | existing `HierarchyCommand` | `changeHierarchy` | edit/delete of a node requires the node lock (`node:<id>`) held by caller or free; deleting requires **no lock held by others anywhere in the subtree** |
| `item.add` | `{objectType, functionId, values}` | `addItem` (server assigns ID) | none (queue serializes adds) |
| `item.edit` | `{objectType, functionId, itemId, values}` (partial patch of columns) | `editFunction` with one `edit` change | caller **must hold** `item:<itemId>` |
| `item.delete` | `{objectType, functionId, itemId}` | `deleteItem` | lock must be free or held by caller |
| `function.description` | `{objectType, functionId, description}` | `editFunction` | caller must hold `fn-desc:<functionId>` |
| `config.update` | existing project config payload | `updateProjectConfig` | caller must hold `config`; admin only |
| `room.restore` | `{revisionId}` | revision restore logic (v1 §7.2 ID-safety rule) | admin only; force-releases all locks with a notice |

- Validation is **targeted**: the domain functions validate what they touch (column values, references, names).
  Full `validateWorkspace` runs only for `config.update`, `room.restore`, and in tests. Never per keystroke.
- Op envelope: `{ opId: uuid, kind, payload }`. `opId` makes retries **idempotent**: the server remembers recent
  `opId -> result` per room (and in the op log), and a duplicate returns the original result instead of re-applying.

## 3. Live typing without per-keystroke ops

- A user who holds `item:<id>` edits a **local draft** of that row. The draft is sent as an `item.edit` patch
  (only changed columns) **debounced at 300 ms of idle and on blur/Enter/Save**. Others see the row update a few
  hundred ms later, with the holder's color and name on the row and on the focused cell. That is "live" for
  structured data without flooding the queue.
- Same for `fn-desc:<functionId>` (scope Markdown) and node properties.
- There is no separate "Save row" for others: once the lock holder's patch is applied, it is shared and durable.
  Leaving the row (or Save/Esc) releases the lock. Esc first reverts the draft to the server value.
- A brand-new requirement is a **local draft** (no ID consumed, matching existing spec) until the user commits it;
  commit sends `item.add`, the server assigns the ID, and the creator automatically receives `item:<newId>`.
  While drafting, presence shows "<name> is adding a requirement" on that function for others.

## 4. Locks

- Lock keys: `item:<itemId>`, `fn-desc:<functionId>`, `node:<moduleOrFunctionId>`, `config`.
- **Lease-based**: TTL 30 s, refreshed by `lock-heartbeat` every 10 s while editing. The server reaps expired locks.
- Acquire: `lock-acquire {key}` → `lock-granted {key, expiresAt}` or `lock-denied {key, holder: {userId, name, color}}`.
  Viewers can never acquire. A lock on an item whose function/module is being deleted is denied.
- Release: explicit `lock-release`, on navigation away, on Save/Esc, or on lease expiry. On websocket close the
  server keeps the user's locks for a **grace period of 30 s** so a network blip does not lose the lock; a reconnect
  with the same session reclaims them.
- Every lock change broadcasts `locks-changed {key, holder | null}` to the room. Clients render locked rows/fields
  read-only with the holder's color outline and name tag.
- Room Admin/Owner can **force-release** any lock (audited, the holder is notified and their unsent draft is kept
  locally and shown to them).
- The **server enforces** lock rules inside the op authorizer; the UI only mirrors them.

## 5. Presence

- Ephemeral, not persisted: `presence-update {view: {objectType, nodeId} | null, focus: {itemId, columnId} | null, drafting: functionId | null}`,
  throttled to 10/s per client. Server keeps the latest per connection and broadcasts `presence {connectionId, user, state}`.
- Clients show: online members list, avatars on tree nodes and editor header for who is viewing what, the focused
  cell of a lock holder, and "is adding" indicators.

## 6. Persistence, autosave, crash safety (PostgreSQL on the server)

**Server storage is PostgreSQL. SQLite is used only on the client** (local workspace index `.hlr/cache.sqlite`,
offline mode, client caches). The server keeps no project JSON files on disk; PostgreSQL is its single source of
truth. See section 11 for the storage layer.

- `room_ops`: `(room_id, seq, op_id uuid, user_id, kind, payload jsonb, result jsonb, created_at timestamptz)`,
  primary key `(room_id, seq)`, unique `(room_id, op_id)`.
- An op is acknowledged **only after** its transaction commits:
  `BEGIN; SELECT head_seq FROM rooms WHERE id=$1 FOR UPDATE; INSERT INTO room_ops ...; UPDATE rooms SET head_seq=...; COMMIT;`
  The in-memory serial queue gives ordering; the row lock protects `head_seq` even if a second server process
  is ever started by mistake. Every acknowledged change survives a crash.
- Snapshots: `room_snapshots(room_id, seq, workspace jsonb, created_at)`. Written debounced (2 s idle, max 10 s)
  and on shutdown/room unload; `rooms.snapshot_seq` records the latest. Startup: load latest snapshot + replay
  ops with `seq > snapshot_seq` by re-running the same domain functions (deterministic: ops store server-chosen IDs
  and timestamps in `result`, and replay uses them). Keep the last 3 snapshots per room.
- Op log pruning: rows with `seq <= snapshot_seq` older than 7 days may be pruned; revisions are separate.
- Revisions: `revisions(id, room_id, seq, message, author_id, workspace jsonb, created_at)`, immutable. Restore and
  ID-safety as in v1 section 7.2.
- Interchange stays the existing human-readable JSON workspace format: export a room to a local workspace and
  import a local workspace into a room via the API. That is how data moves between server and offline mode.

## 7. Client sync and catch-up

- On join: server sends `room-welcome {roomId, role, seq, workspace, locks, presence, members}` (full snapshot).
- Then `op-applied` messages in seq order. If a client sees a gap (`seq` jumps), it sends `ops-since {seq}`; the
  server replies with the missing ops, or a fresh `snapshot {seq, workspace}` if they were pruned.
- Sender gets `op-ack {opId, seq, result}` or `op-rejected {opId, code, message}`. Codes: `FORBIDDEN`, `LOCKED`,
  `NOT_FOUND`, `VALIDATION`, `CONFLICT`, `READ_ONLY`.
- No client-side op queue survives a disconnect. The client keeps at most the current unsent draft.

## 8. Disconnects and offline

- **Pure offline mode** (no server): unchanged, local workspace as today.
- **Disconnected while in a room**: the room view becomes **read-only** with a "Reconnecting…" banner. The unsent
  draft (if any) stays in memory and on disk (`<userData>/collab-cache/<serverId>/<roomId>/draft.json`).
  On reconnect: welcome snapshot, reclaim locks within the grace period, then resend the draft as `item.edit`. If
  the lock was lost or the row changed or was deleted, show the user their draft next to the current value and let
  them copy/reapply. Nothing is merged silently, nothing is dropped silently.
- **Take a room offline on purpose**: any member can export the room's project to a local workspace (existing
  format). Room admins can import a local workspace back as a new revision (`room.restore`-like op that keeps ID
  safety). This replaces v1's "offline editing inside a room".

## 9. Dependency changes

- Remove `yjs`, `y-protocols`, `lib0` from `package.json`, `package-lock.json`, and the offline cache manifest.
- Keep `ws`.
- Add `pg` (node-postgres, pure JS; do **not** install `pg-native`). It and its pure-JS dependencies go into the
  offline npm cache like every other dependency.
- `better-sqlite3` stays as a **client/desktop** dependency only; the server bundle must not need it.

## 10. Code impact on what exists

| Area | Action |
|---|---|
| `src/shared/collab/yjsDoc.ts`, `tests/unit/yjsDoc.test.ts` | delete |
| `src/shared/collab/protocol.ts` | replace Yjs/awareness/alloc messages with ops, locks, presence, catch-up messages above |
| `src/shared/collab/permissions.ts` | replace `validateYDocDiffPermissions` with `authorizeOp(role, op, lockState, workspace)` |
| `src/server/roomRuntime.ts` | replace Yjs core with serial queue + op engine + lock manager; keep membership, lifecycle, broadcast, autosave scheduling |
| `src/server/db.ts` | replaced by the PostgreSQL storage layer (section 11); `yjs_updates` is gone |
| `src/server/auth.ts`, `rooms.ts`, `tls.ts`, `discovery.ts`, `src/main/collab/discoveryClient.ts` | keep |
| `docs/collab/PROTOCOL.md`, `PERMISSIONS.md`, `ARCHITECTURE.md` | update to match this file; mark v1 sync sections as superseded |

## 11. Server storage layer (PostgreSQL)

- **Interface first**: `src/server/store/types.ts` defines an async `ServerStore` with repositories:
  `users`, `sessions`, `serverSettings`, `rooms`, `memberships`, `invites`, `inviteCodes`, `joinRequests`, `bans`,
  `audit`, `ops`, `snapshots`, `revisions`, plus `transaction(fn)`. Services (`auth.ts`, `rooms.ts`,
  `roomRuntime.ts`, revisions) depend only on this interface and are fully `async`.
- **Implementation**: `src/server/store/pgStore.ts` with a `pg.Pool`. Parameterized queries only, never string
  interpolation of values.
- **Schema migrations**: numbered SQL files `src/server/store/migrations/0001_init.sql`, `0002_...sql`. A runner
  applies pending files in order inside a transaction, guarded by `pg_advisory_lock`, tracked in
  `schema_migrations(version, applied_at)`. The server runs migrations on startup; `npm run server -- --migrate-only`
  runs them and exits. Migrations are forward-only; never edit an applied file.
- **Types**: ids `uuid` (or existing text ids where the domain already has them), times `timestamptz`, roles and
  states as `text` with `CHECK` constraints, JSON payloads `jsonb`. Foreign keys with `ON DELETE CASCADE` where a
  room deletion must remove its data. Indexes for every lookup used by the services (session token hash, room
  membership by user, pending join requests by room, ops by `(room_id, seq)`).
- **Configuration**: `--database-url` / `HLR_DATABASE_URL` (e.g. `postgres://hlr:...@127.0.0.1:5432/hlr`), pool
  size `--db-pool` (default 10). The server refuses to start without a reachable database and prints a clear error.
- **Tests**: run against a real PostgreSQL. `scripts/test-db.mjs` starts a disposable `postgres:16-alpine` container
  via Docker (or uses `HLR_TEST_DATABASE_URL` if set), and each test file gets its own schema or database so tests
  stay isolated and parallel-safe. Do not use an in-memory Postgres emulator. Document this in README.
- **Air-gapped deployment** (finished in T13): the offline bundle ships either a saved `postgres:16-alpine` image
  plus a `docker-compose.yml` (server + database) or instructions for a system PostgreSQL from offline packages.
  Database backup/restore via `pg_dump`/`pg_restore` is documented.
- There is no production data in the old `server.sqlite` format (it only existed in development), so no SQLite to
  PostgreSQL data migration tool is needed. Delete the old SQLite server code.
