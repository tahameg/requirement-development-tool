# Multi-User Collaboration Implementation Tasks

Each implementer session must complete **only the first unchecked task** below, keep `npm run typecheck`, `npm test`, and `npm run build` green, mark the task `- [x]`, document changes in `docs/collab/PROGRESS.md`, and commit.

> [!IMPORTANT]
> Do not modify `src/shared/utils/idUtils.ts`, `src/main/services/idGenerator.ts`, `src/shared/types/schema.ts`, or `src/main/services/validation.ts` unless preserving 100% statement, branch, function, and line coverage enforced by `vitest.config.ts`. Import and reuse them from the new collaboration modules.

- [x] T01: Install collaboration dependencies and define shared types, permissions, and protocol schemas
  - Goal: Install pure-JS dependencies (`yjs`, `y-protocols`, `lib0`, `ws`, `@types/ws`) into `package.json`, `package-lock.json`, and `offline/cache/npm` (using `npm install --ignore-scripts --cache offline/cache/npm ...`), and implement shared collaboration domain types, permission evaluation functions (`canServerAction`, `canRoomAction`, `validateYDocDiffPermissions`), and Zod wire schemas for REST, WebSocket messages, Awareness state, and UDP discovery beacons.
  - Files: `package.json`, `package-lock.json`, `src/shared/collab/types.ts`, `src/shared/collab/permissions.ts`, `src/shared/collab/protocol.ts`, `tests/unit/collabPermissions.test.ts`, `tests/unit/collabProtocol.test.ts`
  - Acceptance: `tests/unit/collabPermissions.test.ts` verifies every `ServerRole` × `ServerAction` and `RoomRole` × `RoomAction` combination from `docs/collab/PERMISSIONS.md` plus `validateYDocDiffPermissions` (rejecting viewer writes, rejecting editor config changes and module/function deletions, detecting decreased watermarks or removed retiredIds). `tests/unit/collabProtocol.test.ts` validates all REST, WebSocket, Awareness, and Discovery Beacon schemas from `docs/collab/PROTOCOL.md`. `npm run typecheck` and `npm test` pass.

- [x] T02: Implement Yjs document conversion and character-level text diff helpers
  - Goal: Build the deterministic bidirectional mapping between `Workspace` and `Y.Doc` (`workspaceToYDoc`, `yDocToWorkspace`), character-level `Y.Text` editing helper (`applyTextChange`), and helper mutations on `Y.Doc` for modules, functions, items, `ProjectConfig`, and `retiredIds` as specified in `docs/collab/PROTOCOL.md` §4.
  - Files: `src/shared/collab/yjsDoc.ts`, `tests/unit/yjsDoc.test.ts`
  - Acceptance: `tests/unit/yjsDoc.test.ts` verifies lossless `Workspace -> Y.Doc -> Workspace` round-trips across all 4 object types, character-level concurrent `Y.Text` merges between two synced `Y.Doc` instances on function descriptions and text/Markdown item columns without overwriting each other, last-writer-wins on scalar columns (`enum`, `number`, `boolean`, `date`, `reference`), and preservation of `watermarkCounter` and `retiredIds`. `npm run typecheck` and `npm test` pass.

- [x] T03: Implement server SQLite storage, self-signed TLS generator, and authentication service
  - Goal: Implement `ServerDatabase` (`server.sqlite` schema from `docs/collab/PROTOCOL.md` §7), pure-Node `node:crypto` X.509 self-signed certificate generation and SHA-256 fingerprint calculation (`src/server/tls.ts`), and `AuthService` (`src/server/auth.ts`) supporting the one-time first-run setup token for `SERVER_OWNER`, `scrypt` password hashing, session token creation/expiry/revocation, registration modes (`open`, `approval`, `closed`), and server admin user management (`create`, `approve`, `disable`, `resetPassword`, `changeServerRole`).
  - Files: `src/server/db.ts`, `src/server/tls.ts`, `src/server/auth.ts`, `tests/unit/serverAuth.test.ts`
  - Acceptance: `tests/unit/serverAuth.test.ts` verifies self-signed TLS certificate generation and `X509Certificate` SHA-256 fingerprint parsing, one-time setup token consumption creating `SERVER_OWNER` (and rejecting reuse), `open` vs `approval` vs `closed` registration flows, login/logout and session expiration, and `SERVER_OWNER` vs `SERVER_ADMIN` vs `USER` permission enforcement on user management actions. `npm run typecheck` and `npm test` pass.

- [x] T04: Implement rooms, memberships, invites, join requests, and audit logging service
  - Goal: Implement `RoomService` (`src/server/rooms.ts`) managing room creation (new project via `createWorkspace` or imported `Workspace` validated via `validateWorkspace`, persisted on disk via `saveWorkspace`), room visibility (`private` vs `listed`), direct user invites (accept/decline), invite codes (with `expiresAt` and `maxUses`), join requests on listed rooms (approve with chosen role or reject), role changes, kick, ban/unban, leave, ownership transfer, server-admin stuck-room resolution, and `audit_log` entries for all mutations.
  - Files: `src/server/rooms.ts`, `tests/unit/serverRooms.test.ts`
  - Acceptance: `tests/unit/serverRooms.test.ts` tests creating rooms (both fresh and from an imported `Workspace`), `roomCreationMode` restriction (`all_users` vs `admins_only`), private vs listed room visibility, direct invites and invite codes (expiry and max-uses enforcement), join request approval/rejection, role change rules (`ROOM_ADMIN` vs `ROOM_OWNER`), kick/ban blocking rejoin/redeem, ownership transfer, and audit log creation. `npm run typecheck` and `npm test` pass.

- [x] T05: Implement room runtime, Yjs WebSocket sync, server-authoritative ID allocation, and HTTP/WS server
  - Goal: Implement `RoomRuntime` (`src/server/roomRuntime.ts`), `wsHandler` (`src/server/wsHandler.ts`), `CollabServer` (`src/server/httpServer.ts`), CLI entrypoint (`src/server/index.ts`), and `scripts/run-server.mjs` (`npm run server` in `package.json`). Support live Yjs sync (`sync-step1`, `sync-step2`, `sync-update`), `Awareness` broadcasting (stripping field `focus` from `VIEWER`s), server-side permission and schema validation on every incoming Yjs update, atomic server-authoritative ID allocation (`alloc-item` and `__pending__:` resolution via `addItem` so concurrent allocations never collide and `retiredIds` stay retired), immediate `yjs_updates` WAL logging, and debounced crash-safe autosave via `saveWorkspace`.
  - Files: `src/server/roomRuntime.ts`, `src/server/wsHandler.ts`, `src/server/httpServer.ts`, `src/server/index.ts`, `scripts/run-server.mjs`, `package.json`, `tests/unit/roomRuntime.test.ts`
  - Acceptance: `tests/unit/roomRuntime.test.ts` tests starting `CollabServer` on an ephemeral port, REST auth/room endpoints, WebSocket Yjs sync between clients, concurrent `alloc-item` requests producing strictly unique sequential IDs with zero collisions, `VIEWER` Yjs update rejection, `EDITOR` config/delete-module Yjs update rejection with corrective `sync-step2`, and crash recovery from `yjs_updates` + working copy on reload. `npm run typecheck` and `npm test` pass.

- [x] T06: Implement UDP LAN discovery broadcaster and client listener
  - Goal: Implement `DiscoveryBroadcaster` (`src/server/discovery.ts`) announcing `{ magic, serverId, name, version, host, port, tls, fingerprint, timestamp }` over UDP broadcast (`255.255.255.255` and `127.0.0.1`, default port `41234`) and integrate it into `CollabServer`, plus `DiscoveryClient` (`src/main/collab/discoveryClient.ts`) listening for beacons, validating them with Zod, deduplicating servers, and marking servers stale/offline after `10s`.
  - Files: `src/server/discovery.ts`, `src/server/httpServer.ts`, `src/main/collab/discoveryClient.ts`, `tests/unit/discovery.test.ts`
  - Acceptance: `tests/unit/discovery.test.ts` tests valid beacon broadcast and reception over localhost UDP on an ephemeral port, malformed/wrong-magic packet ignoring, fingerprint and TLS metadata propagation, and stale server expiration after timeout. `npm run typecheck` and `npm test` pass.

> **Plan v2 (2026-10-16):** T07 onward follow `docs/collab/ARCHITECTURE-v2.md` (server-ordered ops + locks, no Yjs).
> T02's Yjs code and T05's Yjs core are replaced by R01 to R03. Do not use Yjs anywhere.

- [x] R01: Protocol and permissions v2, remove Yjs
  - Goal: Implement ARCHITECTURE-v2 sections 2, 4, 5, 7 as shared types and Zod schemas: op envelope and all op kinds, `op-ack`, `op-rejected`, `op-applied`, `ops-since`, `snapshot`, `room-welcome`, lock messages, `locks-changed`, presence messages. Replace `validateYDocDiffPermissions` with `authorizeOp`. Delete `src/shared/collab/yjsDoc.ts` and its test, remove `yjs`, `y-protocols`, `lib0` from package.json, lockfile and offline cache. Update `PROTOCOL.md` and `PERMISSIONS.md`, and mark superseded sections in `ARCHITECTURE.md`. Server code that still imports Yjs may be stubbed to compile only if R02 replaces it next; keep tests green.
  - Files: `src/shared/collab/protocol.ts`, `src/shared/collab/permissions.ts`, `src/shared/collab/types.ts`, `package.json`, `package-lock.json`, offline cache manifest, docs
  - Acceptance: schema tests for every message; `authorizeOp` tests for every role x op kind x lock state (viewer always rejected, editor cannot `config.update`/delete module/function, `item.edit` without lock rejected with `LOCKED`, subtree delete rejected while another user holds a lock inside). `grep -r yjs src tests` is empty.

- [x] R02: Move server storage to PostgreSQL (store interface, migrations, async services)
  - Goal: Implement ARCHITECTURE-v2 section 11. Add `pg` (pure JS, offline cache). Create `src/server/store/types.ts` (async `ServerStore` + repositories + `transaction`), `src/server/store/pgStore.ts`, migration runner with advisory lock and `schema_migrations`, and `src/server/store/migrations/0001_init.sql` covering everything `src/server/db.ts` has today (users, sessions, server settings, setup token, rooms with `head_seq` and `snapshot_seq`, memberships, invites, invite codes, join requests, bans, audit log) plus `room_ops`, `room_snapshots`, `revisions` as in section 6. Make `auth.ts`, `rooms.ts`, `httpServer.ts`, `wsHandler.ts`, `roomRuntime.ts`, `index.ts` async and store-backed, remove server-side workspace JSON files, delete `src/server/db.ts` and any `better-sqlite3` import under `src/server`. Add `--database-url`/`HLR_DATABASE_URL`, `--db-pool`, `--migrate-only`. Add `scripts/test-db.mjs` (disposable `postgres:16-alpine` via Docker or `HLR_TEST_DATABASE_URL`) and wire it into `npm test` so tests get an isolated schema/database each. Keep the existing behavior of T03, T04, T06 tests (port them to the store, do not weaken them).
  - Files: `package.json`, `package-lock.json`, offline cache manifest, `src/server/store/**`, `src/server/*.ts`, `scripts/test-db.mjs`, `scripts/run-tests.mjs`, `tests/unit/serverAuth.test.ts`, `tests/unit/serverRooms.test.ts`, `tests/unit/roomRuntime.test.ts`, `tests/unit/pgStore.test.ts`, `README.md` (test prerequisites)
  - Acceptance: migrations apply on an empty database and are no-ops on the second run; two concurrent migration runners do not double-apply (advisory lock test); every repository method has a test; all previous auth/rooms/runtime tests pass against PostgreSQL; `grep -rn "better-sqlite3\|server.sqlite" src/server` is empty; server refuses to start with a clear message when the database is unreachable; client-side SQLite (`src/main/db`) is untouched and its tests pass.

- [x] R03: Server op engine (serial queue, op log, catch-up, crash recovery)
  - Goal: Rewrite the core of `RoomRuntime` per ARCHITECTURE-v2 sections 2, 6, 7: per-room serial queue, apply ops with existing domain functions, targeted validation, `seq`, op log in PostgreSQL `room_ops` committed before ack (ARCHITECTURE-v2 section 6 transaction), idempotent `opId`, broadcast `op-applied`, `ops-since`/`snapshot` catch-up, debounced `room_snapshots` with `snapshot_seq`, deterministic replay on startup. Schema changes go in a new numbered migration file, never by editing `0001_init.sql`. Update `wsHandler.ts`.
  - Files: `src/server/roomRuntime.ts`, `src/server/wsHandler.ts`, `src/server/store/**`, `tests/unit/roomRuntime.test.ts`, `tests/unit/opEngine.test.ts`
  - Acceptance: 50 concurrent `item.add` from 5 sockets produce 50 unique sequential IDs with seqs 1..N and every client ends with an identical workspace; duplicate `opId` returns original result without re-applying; kill/restart (new runtime on same data dir) after acked ops loses nothing; gap triggers correct `ops-since` reply; a 10,000-item workspace applies an `item.edit` in under 5 ms on the server (benchmark test).

- [ ] R04: Lock manager and presence
  - Goal: Implement ARCHITECTURE-v2 sections 4 and 5 on the server: lease locks with heartbeat, reaping, 30 s grace on socket close with reclaim on reconnect, force-release by admins (audited, holder notified), auto-grant `item:<id>` to the creator after `item.add`, release on delete, `locks-changed` broadcasts, presence throttling and broadcast. Enforce locks inside op authorization.
  - Files: `src/server/locks.ts`, `src/server/roomRuntime.ts`, `tests/unit/locks.test.ts`
  - Acceptance: tests with fake timers for acquire/deny/heartbeat/expiry/grace reclaim/force-release; second user's `item.edit` on a locked row is rejected `LOCKED`; module delete rejected while a lock is held inside it; viewer cannot acquire; presence throttled to 10/s.

- [ ] T07: Client connection layer, TOFU pinning, room mirror, IPC
  - Goal: As v1 T07 (TOFU TLS pinning, remembered servers, CSP/origin policy, IPC wiring) but `CollabClient` keeps a plain `Workspace` mirror applied from `room-welcome` and `op-applied` in seq order with gap detection, exposes `sendOp`, `acquireLock`, `releaseLock`, heartbeats while a lock is held, presence updates, and emits state (workspace, locks, presence, connection state) to the renderer.
  - Files: `src/main/collab/tlsPinning.ts`, `src/main/collab/collabClient.ts`, `src/shared/appSettings.ts`, `src/shared/api.ts`, `src/main/services/desktopService.ts`, `src/main/ipc/registerHandlers.ts`, `src/main/window.ts`, `src/preload/index.ts`, `tests/unit/collabClient.test.ts`, `tests/unit/collabIpc.test.ts`
  - Acceptance: TOFU pin/mismatch/re-trust tests; client against a real in-process server mirrors ops in order, fills a gap via `ops-since`, heartbeats keep a lock alive; origin policy blocks everything except `file:`, `devtools:` and the active server.

- [ ] T08: Server connection UI
  - Goal: Unchanged from v1 T08 (work offline vs connect, discovered + remembered servers, manual address, TLS mismatch modal, setup token, login, register by mode).
  - Files: `src/renderer/components/collab/ServerConnectView.tsx`, `src/renderer/App.tsx`, `src/renderer/styles.css`, `tests/unit/serverConnectUi.test.ts`
  - Acceptance: as v1 T08.

- [ ] T09: Room lobby and server administration UI
  - Goal: Unchanged from v1 T09.
  - Files: as v1 T09
  - Acceptance: as v1 T09.

- [ ] T10: In-room live UI with locks and presence
  - Goal: Header with members online, connection and autosave status. Tree and editor show presence avatars. Clicking a row/cell acquires `item:<id>`; if denied, the row is read-only with holder color outline and name tag. While holding, edits go to a local draft sent as debounced `item.edit` patches (300 ms, blur, Enter, Save); Esc reverts and releases; leaving the row releases. Locked rows of others show the holder's focused cell highlighted. "Add requirement" is a local draft committed with `item.add`; others see "<name> is adding a requirement". Same lock flow for function description, node properties and project settings (`config`). Role-gated actions. Admin force-release in the members modal. `RoomMembersModal` as in v1 T10.
  - Files: `src/renderer/components/collab/*`, `src/renderer/components/editor/*`, `src/renderer/components/tree/WorkspaceTree.tsx`, `src/renderer/App.tsx`, `src/renderer/styles.css`, `tests/unit/inRoomCollabUi.test.ts`
  - Acceptance: tests for role capability helpers, lock-state to UI-state mapping (free / mine / others), draft debounce and patch building (only changed columns), presence grouping by node; `npm run build` passes.

- [ ] T11: Revisions
  - Goal: As v1 T11, but restore runs as a `room.restore` op through the queue, force-releases all locks with a notice, and keeps the ID-safety rule. Admins can also import a local workspace as a new revision.
  - Files: `src/server/revisions.ts`, `src/server/httpServer.ts`, client and renderer files as v1 T11, `tests/unit/serverRevisions.test.ts`
  - Acceptance: as v1 T11, plus restore through the queue is ordered relative to concurrent ops and releases locks.

- [ ] T12: Disconnect handling, lock reclaim, draft preservation
  - Goal: ARCHITECTURE-v2 section 8: read-only room on disconnect with banner, draft persisted to disk, reconnect with snapshot, lock reclaim within grace, draft resend, and a side-by-side "your draft vs current" dialog when the lock was lost or the row changed/deleted. Export room to local workspace.
  - Files: `src/main/collab/collabClient.ts`, `src/main/collab/draftStore.ts`, renderer dialog, `tests/unit/collabReconnect.test.ts`
  - Acceptance: tests: blip under 30 s keeps lock and resends draft; blip over 30 s with another user taking the lock surfaces the draft dialog; deleted row surfaces the dialog; nothing applied silently.

- [ ] T13: Offline bundle, Dockerfile, README, Agents.md
  - Goal: As v1 T13, documenting the v2 model (ordered ops, locks, autosave vs revisions). Yjs must not appear in docs except as "replaced".
  - Files: as v1 T13
  - Acceptance: as v1 T13.

- [ ] T14: End-to-end multi-user test
  - Goal: Real server over HTTPS/WSS on localhost with discovery and 3 clients: setup token, register, room create, join request + approval, invite code; two editors add requirements concurrently (unique IDs, identical final state); editor A locks a row, editor B is denied and sees holder; A's debounced patches reach B; viewer writes rejected; admin force-release; admin saves revision and restores it; disconnect/reconnect within grace keeps lock and draft; server restart loses no acked op.
  - Files: `tests/unit/collabE2E.test.ts`
  - Acceptance: passes in `npm test`; typecheck and build green.
